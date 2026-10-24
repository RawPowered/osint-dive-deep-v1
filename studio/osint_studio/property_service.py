from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import tempfile
from dataclasses import asdict
from datetime import date
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

import pandas as pd
from bs4 import BeautifulSoup

from .case_store import CaseStore
from .property_browser import PropertyBrowserSession
from .property_config import PropertySecretStore
from .property_sources import (
    FLORIDA_DOR_COUNTIES,
    FLORIDA_STATEWIDE_CADASTRAL_LAYER_URL,
    PROPERTY_SOURCES,
    ArcGISFeatureCollector,
    NWSAlertsCollector,
    build_public_session,
    census_geocode,
    collect_acs5_county_profiles,
    collect_storm_events,
    source_by_key,
    validate_public_url,
)
from .property_store import PropertyHuntConfig, PropertyWarehouse
from .tax_permit import DEFAULT_VERIFIED_PERMIT_ROUTES, iter_tax_roll_chunks, parse_permit_registry
from .weather_hunt import (
    StateBoundary,
    collect_daily_precipitation,
    collect_state_boundary as fetch_state_boundary,
    geometry_bounds,
    representative_point,
    reverse_address,
    state_fips,
    state_name,
)


def _source_rows() -> list[dict[str, Any]]:
    values = []
    for source in PROPERTY_SOURCES:
        item = asdict(source)
        item["access_methods"] = list(source.access_methods)
        values.append(item)
    return values


def _suffix(url: str, media_type: str, default: str = ".bin") -> str:
    path_suffix = Path(urlparse(url).path).suffix
    if path_suffix and len(path_suffix) <= 10:
        return path_suffix
    guessed = mimetypes.guess_extension(media_type.split(";", 1)[0].strip())
    return guessed or default


def _feature_point(geometry: dict[str, Any]) -> tuple[float | str, float | str]:
    coordinates = geometry.get("coordinates")
    if geometry.get("type") == "Point" and isinstance(coordinates, list) and len(coordinates) >= 2:
        return coordinates[1], coordinates[0]

    points: list[list[float]] = []

    def visit(value: Any) -> None:
        if isinstance(value, list) and len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            points.append(value)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(coordinates)
    if not points:
        return "", ""
    return (
        (min(float(item[1]) for item in points) + max(float(item[1]) for item in points)) / 2,
        (min(float(item[0]) for item in points) + max(float(item[0]) for item in points)) / 2,
    )


def _geojson_to_esri_polygon(value: dict[str, Any]) -> dict[str, Any]:
    geometry = value.get("geometry") if value.get("type") == "Feature" else value
    geometry_type = str(geometry.get("type") or "")
    coordinates = geometry.get("coordinates") or []
    polygons = [coordinates] if geometry_type == "Polygon" else coordinates if geometry_type == "MultiPolygon" else []
    if not polygons:
        raise ValueError("The saved fence must be a GeoJSON Polygon or MultiPolygon.")

    def signed_area(ring: list[list[float]]) -> float:
        return sum(
            float(ring[index][0]) * float(ring[(index + 1) % len(ring)][1])
            - float(ring[(index + 1) % len(ring)][0]) * float(ring[index][1])
            for index in range(len(ring))
        ) / 2

    rings: list[list[list[float]]] = []
    for polygon in polygons:
        for index, source_ring in enumerate(polygon):
            ring = [[float(point[0]), float(point[1])] for point in source_ring if len(point) >= 2]
            if len(ring) < 3:
                continue
            if ring[0] != ring[-1]:
                ring.append(list(ring[0]))
            # Esri JSON uses clockwise exteriors and counter-clockwise holes.
            should_be_clockwise = index == 0
            is_clockwise = signed_area(ring) < 0
            if should_be_clockwise != is_clockwise:
                ring.reverse()
            rings.append(ring)
    if not rings:
        raise ValueError("The saved fence does not contain a valid polygon ring.")
    return {"rings": rings, "spatialReference": {"wkid": 4326}}


class PropertyIntelService:
    def __init__(self, case_store: CaseStore | None = None, warehouse: PropertyWarehouse | None = None, secrets: PropertySecretStore | None = None):
        self.case_store = case_store or CaseStore()
        self.warehouse = warehouse or PropertyWarehouse()
        self.secrets = secrets or PropertySecretStore()
        self.warehouse.sync_sources(_source_rows())
        existing_routes = {
            (str(row.get("county") or "").casefold(), str(row.get("jurisdiction") or "").casefold(), str(row.get("direct_search_url") or ""))
            for row in self.warehouse.list_permit_routes(state="FL")
        }
        missing_defaults = [
            row for row in DEFAULT_VERIFIED_PERMIT_ROUTES
            if (str(row["county"]).casefold(), str(row["jurisdiction"]).casefold(), str(row["direct_search_url"])) not in existing_routes
        ]
        if missing_defaults:
            self.warehouse.upsert_permit_routes(missing_defaults, "built-in-verified-florida-v1")

    def create_hunt(self, config: PropertyHuntConfig) -> str:
        return self.warehouse.create_hunt(config)

    def import_upload(self, hunt_id: str, filename: str, content: bytes) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(f"Unknown property hunt: {hunt_id}")
        case_id = str(hunt["case_id"])
        run_id = self.case_store.create_run(case_id, "property-upload", adapter="uploaded-address", traffic_class="local-file", config={"filename": filename})
        source_run_id = self.warehouse.start_source_run(hunt_id, "uploaded_address", "local-file", {"filename": filename}, run_id)
        try:
            artifact_id = self.case_store.record_artifact_bytes(case_id, content, "property-source-upload", run_id=run_id, media_type="text/csv", encoding="utf-8", source_uri=filename, suffix=Path(filename).suffix or ".csv", metadata={"hunt_id": hunt_id})
            raw_asset_id = self.warehouse.record_raw_asset(hunt_id, "uploaded_address", artifact_id, filename, content, run_id=source_run_id, media_type="text/csv", normalization_status="normalized")
            frame = pd.read_csv(pd.io.common.BytesIO(content), dtype=str, keep_default_na=False)
            imported = self.warehouse.import_address_frame(hunt_id, frame, raw_asset_id)
            summary = {"rows_in_file": len(frame), "rows_imported": imported, "artifact_id": artifact_id, "raw_asset_id": raw_asset_id}
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(run_id, summary=summary)
            return summary
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_source_run(source_run_id, {}, error)
            self.case_store.complete_run(run_id, error=error)
            raise

    def import_tax_roll(self, hunt_id: str, filename: str, content: bytes, *, promote_nal: bool = True) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(f"Unknown property hunt: {hunt_id}")
        case_id = str(hunt["case_id"])
        case_run_id = self.case_store.create_run(
            case_id,
            "tax-roll-ingestion",
            adapter="florida-dor-tax-roll",
            traffic_class="local-file",
            config={"filename": filename, "promote_nal": promote_nal},
        )
        source_run_id = self.warehouse.start_source_run(hunt_id, "fl_dor_tax_roll", "local-zip-csv", {"filename": filename}, case_run_id)
        import_id = self.warehouse.start_tax_import(hunt_id, filename, case_run_id)
        summary: dict[str, Any] = {"import_id": import_id, "rows_seen": 0, "rows_imported": 0, "rows_rejected": 0, "properties_promoted": 0, "roll_types": [], "members": []}
        try:
            suffix = ".zip" if filename.lower().endswith(".zip") else Path(filename).suffix or ".csv"
            media_type = "application/zip" if suffix == ".zip" else "text/csv"
            artifact_id = self.case_store.record_artifact_bytes(
                case_id,
                content,
                "florida-dor-tax-roll-upload",
                run_id=case_run_id,
                media_type=media_type,
                encoding="" if suffix == ".zip" else "utf-8",
                source_uri=filename,
                suffix=suffix,
                metadata={"hunt_id": hunt_id, "import_id": import_id},
            )
            raw_asset_id = self.warehouse.record_raw_asset(
                hunt_id,
                "fl_dor_tax_roll",
                artifact_id,
                filename,
                content,
                run_id=source_run_id,
                media_type=media_type,
                response_metadata={"filename": filename, "import_id": import_id},
                normalization_status="normalized",
            )
            summary.update({"artifact_id": artifact_id, "raw_asset_id": raw_asset_id})
            roll_types: set[str] = set()
            members: set[str] = set()
            for chunk in iter_tax_roll_chunks(filename, content):
                summary["rows_seen"] += chunk.rows_seen
                imported = self.warehouse.import_tax_frame(hunt_id, import_id, raw_asset_id, chunk.frame)
                summary["rows_imported"] += imported
                summary["rows_rejected"] += chunk.rows_seen - imported
                roll_types.add(chunk.roll_type)
                members.add(chunk.member_name)
            summary["roll_types"] = sorted(roll_types)
            summary["members"] = sorted(members)
            if promote_nal and "NAL" in roll_types:
                summary.update(self.warehouse.promote_tax_import(hunt_id, import_id))
            self.warehouse.finish_tax_import(import_id, summary)
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(case_run_id, summary=summary)
            return summary
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_tax_import(import_id, summary, error)
            self.warehouse.finish_source_run(source_run_id, summary, error)
            self.case_store.complete_run(case_run_id, summary=summary, error=error)
            raise

    def collect_area_demographics(self, hunt_id: str, *, year: int = 2024) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(f"Unknown property hunt: {hunt_id}")
        state = str(hunt["config"].get("state") or hunt.get("state") or "").upper()
        case_id = str(hunt["case_id"])
        api_key = self.secrets.effective().get("census_api_key", "")
        case_run_id = self.case_store.create_run(
            case_id,
            "area-demographic-profile",
            adapter="census-acs5-county",
            traffic_class="public-api",
            config={"hunt_id": hunt_id, "state": state, "year": int(year), "geography": "county"},
        )
        source_run_id = self.warehouse.start_source_run(hunt_id, "census_acs5", "json-api", {"state": state, "year": int(year), "geography": "county"}, case_run_id)
        try:
            session = build_public_session(self.secrets.effective().get("nws_contact", ""))
            profiles, raw, headers, source_url = collect_acs5_county_profiles(session, state, api_key, year=year)
            artifact_id = self.case_store.record_artifact_bytes(
                case_id,
                raw,
                "census-acs5-county-response",
                run_id=case_run_id,
                media_type="application/json",
                source_uri=source_url,
                suffix=".json",
                metadata={"hunt_id": hunt_id, "state": state, "year": int(year), "geography": "county"},
            )
            raw_asset_id = self.warehouse.record_raw_asset(
                hunt_id,
                "census_acs5",
                artifact_id,
                source_url,
                raw,
                run_id=source_run_id,
                media_type="application/json",
                response_metadata={"headers": headers, "state": state, "year": int(year)},
                normalization_status="normalized",
            )
            imported = self.warehouse.upsert_area_demographic_profiles(hunt_id, profiles, raw_asset_id)
            summary = {"profiles": imported, "state": state, "year": int(year), "artifact_id": artifact_id, "raw_asset_id": raw_asset_id, "source_url": source_url}
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(case_run_id, summary=summary)
            return summary
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_source_run(source_run_id, {}, error)
            self.case_store.complete_run(case_run_id, error=error)
            raise

    def import_permit_registry(self, hunt_id: str, filename: str, content: bytes) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        case_id = str(hunt["case_id"])
        case_run_id = self.case_store.create_run(case_id, "permit-registry-ingestion", adapter="permit-registry", traffic_class="local-file", config={"filename": filename})
        source_run_id = self.warehouse.start_source_run(hunt_id, "permit_portal", "registry-import", {"filename": filename}, case_run_id)
        try:
            routes = parse_permit_registry(filename, content)
            for route in routes:
                if route.get("direct_search_url"):
                    route["direct_search_url"] = validate_public_url(str(route["direct_search_url"]))
                if route.get("source_url"):
                    route["source_url"] = validate_public_url(str(route["source_url"]))
            artifact_id = self.case_store.record_artifact_bytes(
                case_id,
                content,
                "permit-routing-registry",
                run_id=case_run_id,
                media_type="application/json" if filename.lower().endswith(".json") else "text/csv",
                encoding="utf-8",
                source_uri=filename,
                suffix=Path(filename).suffix,
                metadata={"hunt_id": hunt_id, "routes": len(routes)},
            )
            media_type = "application/json" if filename.lower().endswith(".json") else "text/csv"
            raw_asset_id = self.warehouse.record_raw_asset(hunt_id, "permit_portal", artifact_id, filename, content, run_id=source_run_id, media_type=media_type, normalization_status="normalized")
            imported = self.warehouse.upsert_permit_routes(routes, filename)
            summary = {"routes_parsed": len(routes), "routes_imported": imported, "artifact_id": artifact_id, "raw_asset_id": raw_asset_id}
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(case_run_id, summary=summary)
            return summary
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_source_run(source_run_id, {}, error)
            self.case_store.complete_run(case_run_id, error=error)
            raise

    def route_addresses(self, hunt_id: str, *, reroute: bool = False) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(f"Unknown property hunt: {hunt_id}")
        case_id = str(hunt["case_id"])
        credentials = self.secrets.effective()
        session = build_public_session(credentials.get("nws_contact", ""))
        properties = self.warehouse.list_properties(hunt_id, int(hunt["config"].get("maximum_results", 10_000)))
        targets = [item for item in properties if reroute or item.get("latitude") is None or item.get("longitude") is None]
        case_run_id = self.case_store.create_run(case_id, "property-address-routing", adapter="census-geocoder", traffic_class="public-api", config={"hunt_id": hunt_id, "records": len(targets)})
        source_run_id = self.warehouse.start_source_run(hunt_id, "census_geocoder", "rest", {"records": len(targets)}, case_run_id)
        matched = errors = 0
        for record in targets:
            address = str(record["property_address"])
            try:
                route, raw, headers, request_url = census_geocode(session, address)
                artifact_id = self.case_store.record_artifact_bytes(case_id, raw, "census-geocoder-response", run_id=case_run_id, media_type="application/json", encoding="utf-8", source_uri=request_url, suffix=".json", metadata={"hunt_id": hunt_id, "record_id": record["record_id"], "response_headers": headers})
                raw_asset_id = self.warehouse.record_raw_asset(hunt_id, "census_geocoder", artifact_id, request_url, raw, run_id=source_run_id, media_type="application/json", response_metadata={"headers": headers, "address": address}, normalization_status="normalized")
                values = route.values()
                self.warehouse.apply_address_route(hunt_id, str(record["record_id"]), values, raw_asset_id)
                observation_id = self.case_store.record_observation(case_id, "property-address-route", values, run_id=case_run_id, normalized_value=str(route.matched_address or address), source_name="U.S. Census Geocoder", source_uri=request_url, confidence=1.0 if route.geocode_status == "MATCHED" else 0.0, artifact_id=artifact_id, metadata={"hunt_id": hunt_id, "property_record_id": record["record_id"]})
                self.case_store.add_evidence(case_id, "property-address-route", json.dumps(values, ensure_ascii=False, sort_keys=True), observation_id=observation_id, artifact_id=artifact_id, source_uri=request_url)
                if route.geocode_status == "MATCHED":
                    matched += 1
            except Exception as exc:
                errors += 1
                self.case_store.record_observation(case_id, "property-address-route-error", {"address": address, "error": f"{type(exc).__name__}: {exc}"}, run_id=case_run_id, normalized_value=address, source_name="U.S. Census Geocoder", confidence=0.0, metadata={"hunt_id": hunt_id, "property_record_id": record["record_id"]})
        summary = {"attempted": len(targets), "matched": matched, "errors": errors}
        self.warehouse.finish_source_run(source_run_id, summary, "" if not errors else f"{errors} address requests failed")
        self.case_store.complete_run(case_run_id, summary=summary, error="" if not errors else f"{errors} address requests failed")
        return summary

    def collect_nws_alerts(self, hunt_id: str) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        case_id = str(hunt["case_id"])
        state = str(hunt["config"].get("state") or hunt.get("state") or "FL").upper()
        session = build_public_session(self.secrets.effective().get("nws_contact", ""))
        case_run_id = self.case_store.create_run(case_id, "property-event-collection", adapter="nws-api", traffic_class="public-api", config={"hunt_id": hunt_id, "area": state})
        source_run_id = self.warehouse.start_source_run(hunt_id, "nws_api", "geojson", {"area": state}, case_run_id)
        try:
            features, raw, url, headers = NWSAlertsCollector(session).collect(area=state)
            artifact_id = self.case_store.record_artifact_bytes(case_id, raw, "nws-alerts-geojson", run_id=case_run_id, media_type="application/geo+json", encoding="utf-8", source_uri=url, suffix=".geojson", metadata={"hunt_id": hunt_id, "response_headers": headers})
            raw_asset_id = self.warehouse.record_raw_asset(hunt_id, "nws_api", artifact_id, url, raw, run_id=source_run_id, media_type="application/geo+json", response_metadata={"headers": headers}, normalization_status="normalized")
            rows = []
            for feature in features:
                props = feature.get("properties") or {}
                geometry = feature.get("geometry") or {}
                latitude, longitude = representative_point(geometry)
                rows.append({"EVENT_ID": feature.get("id", ""), "EVENT_TYPE": props.get("event", ""), "BEGIN_DATE_TIME": props.get("onset", ""), "BEGIN_LAT": latitude or "", "BEGIN_LON": longitude or "", "CZ_NAME": ", ".join(props.get("areaDesc", "").split("; ")[:3]), "STATE": state_name(state).upper(), "MAGNITUDE": props.get("severity", ""), "NWS_PROPERTIES": json.dumps(props, ensure_ascii=False), "NWS_GEOMETRY": json.dumps(geometry, ensure_ascii=False)})
            inserted = self.warehouse.upsert_events(hunt_id, pd.DataFrame(rows), raw_asset_id)
            summary = {"alerts": len(features), "events_inserted": inserted}
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(case_run_id, summary=summary)
            return summary
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_source_run(source_run_id, {}, error)
            self.case_store.complete_run(case_run_id, error=error)
            raise

    def collect_storm_history(self, hunt_id: str, *, start: date | None = None, end: date | None = None) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        config = hunt["config"]
        start = start or (date.fromisoformat(config["storm_start"]) if config.get("storm_start") else date.today().replace(month=1, day=1))
        end = end or (date.fromisoformat(config["storm_end"]) if config.get("storm_end") else date.today())
        years = range(start.year, end.year + 1)
        case_id = str(hunt["case_id"])
        session = build_public_session(self.secrets.effective().get("nws_contact", ""))
        case_run_id = self.case_store.create_run(case_id, "property-event-collection", adapter="noaa-storm-events", traffic_class="bulk-public-file", config={"hunt_id": hunt_id, "start": start.isoformat(), "end": end.isoformat()})
        source_run_id = self.warehouse.start_source_run(hunt_id, "noaa_storm_events", "bulk-csv", {"years": list(years)}, case_run_id)
        total = assets = 0
        try:
            for year in years:
                frame, raw_files = collect_storm_events(session, [year], state=state_name(str(config.get("state") or "FL")), event_types=config.get("event_types", []), begin=start, end=end, maximum=int(config.get("maximum_results", 10_000)))
                for url, raw, headers in raw_files:
                    artifact_id = self.case_store.record_artifact_bytes(case_id, raw, "noaa-storm-events-csv-gzip", run_id=case_run_id, media_type="application/gzip", source_uri=url, suffix=".csv.gz", metadata={"hunt_id": hunt_id, "year": year, "response_headers": headers})
                    raw_asset_id = self.warehouse.record_raw_asset(hunt_id, "noaa_storm_events", artifact_id, url, raw, run_id=source_run_id, media_type="application/gzip", response_metadata={"headers": headers, "year": year}, normalization_status="normalized")
                    total += self.warehouse.upsert_events(hunt_id, frame, raw_asset_id)
                    assets += 1
            summary = {"events_inserted": total, "raw_assets": assets, "years": len(list(years))}
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(case_run_id, summary=summary)
            return summary
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_source_run(source_run_id, {"events_inserted": total, "raw_assets": assets}, error)
            self.case_store.complete_run(case_run_id, error=error)
            raise

    def collect_state_boundary(self, hunt_id: str) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        state = str(hunt["config"].get("state") or hunt.get("state") or "FL").upper()
        case_id = str(hunt["case_id"])
        session = build_public_session(self.secrets.effective().get("nws_contact", ""))
        case_run_id = self.case_store.create_run(case_id, "property-map-boundary", adapter="census-tigerweb", traffic_class="public-api", config={"hunt_id": hunt_id, "state": state})
        source_run_id = self.warehouse.start_source_run(hunt_id, "census_tigerweb", "arcgis-geojson", {"state": state}, case_run_id)
        try:
            boundary = fetch_state_boundary(session, state)
            artifact_id = self.case_store.record_artifact_bytes(case_id, boundary.raw, "census-state-boundary-geojson", run_id=case_run_id, media_type="application/geo+json", encoding="utf-8", source_uri=boundary.url, suffix=".geojson", metadata={"hunt_id": hunt_id, "state": state, "response_headers": boundary.headers})
            raw_asset_id = self.warehouse.record_raw_asset(hunt_id, "census_tigerweb", artifact_id, boundary.url, boundary.raw, run_id=source_run_id, media_type="application/geo+json", response_metadata={"headers": boundary.headers, "state": state}, normalization_status="normalized")
            self.warehouse.upsert_state_boundary(hunt_id, state, state_fips(state), boundary.geojson, raw_asset_id)
            summary = {"state": state, "state_name": state_name(state), "boundary_features": len(boundary.geojson.get("features", [])), "artifact_id": artifact_id, "raw_asset_id": raw_asset_id, "bounds": [boundary.south, boundary.west, boundary.north, boundary.east]}
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(case_run_id, summary=summary)
            return summary
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_source_run(source_run_id, {}, error)
            self.case_store.complete_run(case_run_id, error=error)
            raise

    def collect_rainfall(self, hunt_id: str, start: date, end: date, *, maximum_observations: int = 250_000) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        boundary_record = self.warehouse.get_state_boundary(hunt_id)
        if not boundary_record:
            self.collect_state_boundary(hunt_id)
            boundary_record = self.warehouse.get_state_boundary(hunt_id)
        if not boundary_record:
            raise RuntimeError("State boundary could not be established.")
        south, west, north, east = geometry_bounds(boundary_record["geojson"])
        boundary = StateBoundary(boundary_record["geojson"], b"", "", {}, south, west, north, east)
        case_id = str(hunt["case_id"])
        state = str(hunt["config"].get("state") or hunt.get("state") or "FL").upper()
        session = build_public_session(self.secrets.effective().get("nws_contact", ""))
        request_config = {"hunt_id": hunt_id, "state": state, "start": start.isoformat(), "end": end.isoformat(), "maximum_observations": int(maximum_observations)}
        case_run_id = self.case_store.create_run(case_id, "property-rainfall-collection", adapter="ncei-daily-summaries", traffic_class="public-api", config=request_config)
        source_run_id = self.warehouse.start_source_run(hunt_id, "ncei_daily_precip", "bbox-json", request_config, case_run_id)
        rows_inserted = 0
        try:
            frame, raw_pages = collect_daily_precipitation(session, boundary, start, end, maximum_observations=maximum_observations)
            raw_asset_ids: dict[int, str] = {}
            for page_index, (url, raw, headers) in enumerate(raw_pages):
                artifact_id = self.case_store.record_artifact_bytes(case_id, raw, "ncei-daily-precipitation-json", run_id=case_run_id, media_type="application/json", encoding="utf-8", source_uri=url, suffix=".json", metadata={"hunt_id": hunt_id, "state": state, "page_index": page_index, "response_headers": headers})
                raw_asset_ids[page_index] = self.warehouse.record_raw_asset(hunt_id, "ncei_daily_precip", artifact_id, url, raw, run_id=source_run_id, media_type="application/json", response_metadata={"headers": headers, "page_index": page_index}, normalization_status="normalized")
            if not frame.empty:
                for page_index, page in frame.groupby("_RAW_PAGE_INDEX"):
                    rows_inserted += self.warehouse.upsert_rainfall(hunt_id, page.drop(columns=["_RAW_PAGE_INDEX"]), raw_asset_ids.get(int(page_index), ""), boundary.geojson)
            summary = {"state": state, "start": start.isoformat(), "end": end.isoformat(), "observations_received": len(frame), "observations_inserted": rows_inserted, "observation_limit_reached": len(frame) >= int(maximum_observations), "raw_assets": len(raw_pages), "stations": len(self.warehouse.rainfall_summary(hunt_id, start, end))}
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(case_run_id, summary=summary)
            return summary
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_source_run(source_run_id, {"observations_inserted": rows_inserted}, error)
            self.case_store.complete_run(case_run_id, error=error)
            raise

    def resolve_map_point(self, hunt_id: str, latitude: float, longitude: float) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        cached = self.warehouse.cached_map_selection(hunt_id, latitude, longitude)
        if cached:
            return cached
        case_id = str(hunt["case_id"])
        session = build_public_session(self.secrets.effective().get("nws_contact", ""))
        case_run_id = self.case_store.create_run(case_id, "property-map-reverse-address", adapter="osm-nominatim", traffic_class="user-triggered-public-api", config={"hunt_id": hunt_id, "latitude": latitude, "longitude": longitude})
        source_run_id = self.warehouse.start_source_run(hunt_id, "osm_nominatim", "reverse-json", {"latitude": latitude, "longitude": longitude}, case_run_id)
        try:
            payload, raw, url, headers = reverse_address(session, latitude, longitude)
            artifact_id = self.case_store.record_artifact_bytes(case_id, raw, "osm-reverse-address-json", run_id=case_run_id, media_type="application/json", encoding="utf-8", source_uri=url, suffix=".json", metadata={"hunt_id": hunt_id, "latitude": latitude, "longitude": longitude, "response_headers": headers})
            raw_asset_id = self.warehouse.record_raw_asset(hunt_id, "osm_nominatim", artifact_id, url, raw, run_id=source_run_id, media_type="application/json", response_metadata={"headers": headers}, normalization_status="normalized")
            selection = self.warehouse.record_map_selection(hunt_id, latitude, longitude, payload, raw_asset_id)
            observation_id = self.case_store.record_observation(case_id, "property-map-address", selection, run_id=case_run_id, normalized_value=str(selection["display_name"]), source_name="OpenStreetMap Nominatim", source_uri=url, confidence=0.7, artifact_id=artifact_id, metadata={"hunt_id": hunt_id, "raw_asset_id": raw_asset_id})
            self.case_store.add_evidence(case_id, "property-map-address", json.dumps(payload, ensure_ascii=False, sort_keys=True), observation_id=observation_id, artifact_id=artifact_id, source_uri=url)
            summary = {"selection_id": selection["selection_id"], "display_name": selection["display_name"], "artifact_id": artifact_id}
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(case_run_id, summary=summary)
            return selection
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_source_run(source_run_id, {}, error)
            self.case_store.complete_run(case_run_id, error=error)
            raise

    def save_map_fence(self, hunt_id: str, name: str, geojson: dict[str, Any]) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        geometry = geojson.get("geometry") if geojson.get("type") == "Feature" else geojson
        if str(geometry.get("type") or "") not in {"Polygon", "MultiPolygon"}:
            raise ValueError("Draw a polygon or rectangle before saving the fence.")
        case_id = str(hunt["case_id"])
        content = json.dumps(geojson, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        artifact_id = self.case_store.record_artifact_bytes(
            case_id,
            content,
            "property-map-fence",
            media_type="application/geo+json",
            encoding="utf-8",
            source_uri="analyst-drawn-map-fence",
            suffix=".geojson",
            metadata={"hunt_id": hunt_id, "name": name},
        )
        fence_id = self.warehouse.save_map_fence(hunt_id, name, geojson, artifact_id)
        observation_id = self.case_store.record_observation(
            case_id,
            "property-map-fence",
            geojson,
            normalized_value=fence_id,
            source_name="Geo Explorer",
            source_uri="analyst-drawn-map-fence",
            confidence=1.0,
            artifact_id=artifact_id,
            metadata={"hunt_id": hunt_id, "name": name},
        )
        self.case_store.add_evidence(
            case_id,
            "property-map-fence",
            content.decode("utf-8"),
            observation_id=observation_id,
            artifact_id=artifact_id,
            source_uri="analyst-drawn-map-fence",
        )
        return {"fence_id": fence_id, "artifact_id": artifact_id, "observation_id": observation_id}

    def collect_arcgis(
        self,
        hunt_id: str,
        feature_layer_url: str,
        *,
        where: str = "1=1",
        polygon_geojson: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        case_id = str(hunt["case_id"])
        source_key = "fl_geospatial" if str(hunt["config"].get("state") or "").upper() == "FL" else "county_appraiser"
        secrets = self.secrets.effective()
        session = build_public_session(secrets.get("nws_contact", ""))
        esri_geometry = _geojson_to_esri_polygon(polygon_geojson) if polygon_geojson else ""
        request_config = {"hunt_id": hunt_id, "url": feature_layer_url, "where": where, "spatial_fence": bool(polygon_geojson)}
        case_run_id = self.case_store.create_run(case_id, "property-parcel-collection", adapter="arcgis-feature-service", traffic_class="public-api", config=request_config)
        source_run_id = self.warehouse.start_source_run(hunt_id, source_key, "arcgis-rest", request_config, case_run_id)
        try:
            features, pages = ArcGISFeatureCollector(session).collect(
                feature_layer_url,
                where=where,
                token=secrets.get("arcgis_token", ""),
                geometry=esri_geometry,
                geometry_type="esriGeometryPolygon" if esri_geometry else "esriGeometryEnvelope",
                maximum=int(hunt["config"].get("maximum_results", 10_000)),
            )
            raw_asset_id = ""
            for url, raw, headers in pages:
                artifact_id = self.case_store.record_artifact_bytes(case_id, raw, "arcgis-feature-page", run_id=case_run_id, media_type="application/geo+json", encoding="utf-8", source_uri=url, suffix=".geojson", metadata={"hunt_id": hunt_id, "response_headers": headers})
                raw_asset_id = self.warehouse.record_raw_asset(hunt_id, source_key, artifact_id, url, raw, run_id=source_run_id, media_type="application/geo+json", response_metadata={"headers": headers}, normalization_status="normalized")
            rows = []
            for feature in features:
                props = {str(key).lower(): value for key, value in (feature.get("properties") or {}).items()}
                geometry = feature.get("geometry") or {}
                latitude, longitude = _feature_point(geometry)
                def first(*names: str) -> str:
                    for name in names:
                        value = props.get(name.lower())
                        if value not in (None, ""):
                            return str(value)
                    return ""
                def integer_text(*names: str) -> str:
                    value = first(*names).strip()
                    if not value:
                        return ""
                    try:
                        numeric = float(value)
                        return str(int(numeric)) if numeric.is_integer() else value
                    except ValueError:
                        return value
                county = first("county", "county_name")
                if not county and first("co_no"):
                    try:
                        county = FLORIDA_DOR_COUNTIES.get(int(float(first("co_no"))), "")
                    except ValueError:
                        county = ""
                parcel_id = first("parcel_id", "parcelno", "parcel_no", "parcel_id_", "folio", "strap", "pin", "account")
                physical_address = " ".join(item for item in (first("phy_addr1"), first("phy_addr2")) if item).strip()
                address = first("situs_addr", "site_addr", "full_address", "address", "physical_address", "site_address", "location") or physical_address or (f"Parcel {parcel_id}" if parcel_id else "")
                rows.append({
                    **{str(k): v for k, v in props.items()},
                    "address": address,
                    "parcel_id": parcel_id,
                    "city": first("city", "situs_city", "site_city", "phy_city"),
                    "state": first("state", "situs_state", "site_state") or str(hunt["config"].get("state") or "FL"),
                    "zip": integer_text("zip", "zipcode", "situs_zip", "site_zip", "phy_zipcd"),
                    "county": county or hunt["config"].get("county", ""),
                    "year_built": integer_text("act_yr_blt", "actual_year_built", "year_built", "yr_built", "yearbuilt", "eff_yr_blt"),
                    "owner_name": first("own_name", "owner_name", "owner", "taxpayer_name"),
                    "property_type": first("property_type", "dor_uc", "land_use", "use_code", "use_desc"),
                    "latitude": latitude,
                    "longitude": longitude,
                })
            imported = self.warehouse.import_address_frame(hunt_id, pd.DataFrame(rows), raw_asset_id, source_key=source_key) if rows and raw_asset_id else 0
            summary = {"features": len(features), "pages": len(pages), "properties_imported": imported, "spatial_fence": bool(polygon_geojson)}
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(case_run_id, summary=summary)
            return summary
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_source_run(source_run_id, {}, error)
            self.case_store.complete_run(case_run_id, error=error)
            raise

    def collect_florida_fence_queue(self, hunt_id: str, fence: dict[str, Any], *, where: str = "1=1") -> dict[str, Any]:
        summary = self.collect_arcgis(
            hunt_id,
            FLORIDA_STATEWIDE_CADASTRAL_LAYER_URL,
            where=where,
            polygon_geojson=fence["geojson"],
        )
        queue = self.warehouse.queue_fence_properties(hunt_id, str(fence["fence_id"]), fence["geojson"])
        return {**summary, **queue, "feature_layer_url": FLORIDA_STATEWIDE_CADASTRAL_LAYER_URL}

    def download_source(self, hunt_id: str, source_key: str, url: str) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        source = source_by_key(source_key)
        url = validate_public_url(url)
        case_id = str(hunt["case_id"])
        credentials = self.secrets.effective()
        session = build_public_session(credentials.get("nws_contact", ""))
        headers: dict[str, str] = {}
        credential = credentials.get(source.credential_field, "") if source.credential_field else ""
        if credential and source_key not in {"nws_api", "fl_geospatial"}:
            headers["Authorization"] = f"Bearer {credential}"
        case_run_id = self.case_store.create_run(case_id, "property-source-download", adapter=source_key, traffic_class="public-file", config={"hunt_id": hunt_id, "url": url})
        source_run_id = self.warehouse.start_source_run(hunt_id, source_key, "direct-download", {"url": url}, case_run_id)
        temporary_path: Path | None = None
        try:
            with session.get(url, headers=headers, timeout=180, stream=True) as response:
                response.raise_for_status()
                media_type = response.headers.get("Content-Type", "application/octet-stream")
                digest = hashlib.sha256()
                byte_count = 0
                with tempfile.NamedTemporaryFile(prefix="property-download-", suffix=_suffix(url, media_type), delete=False, dir=self.warehouse.path.parent) as handle:
                    temporary_path = Path(handle.name)
                    for chunk in response.iter_content(1024 * 1024):
                        if chunk:
                            handle.write(chunk)
                            digest.update(chunk)
                            byte_count += len(chunk)
                response_metadata = {"headers": {str(k): str(v) for k, v in response.headers.items()}, "final_url": response.url}
            artifact_id = self.case_store.record_artifact_path(case_id, temporary_path, "property-source-download", run_id=case_run_id, media_type=media_type, source_uri=url, metadata={"hunt_id": hunt_id, **response_metadata})
            raw_asset_id = self.warehouse.record_raw_asset_reference(hunt_id, source_key, artifact_id, url, byte_count=byte_count, sha256=digest.hexdigest(), run_id=source_run_id, media_type=media_type, response_metadata=response_metadata)
            summary = {"bytes": byte_count, "artifact_id": artifact_id, "raw_asset_id": raw_asset_id, "media_type": media_type}
            self.warehouse.finish_source_run(source_run_id, summary)
            self.case_store.complete_run(case_run_id, summary=summary)
            return summary
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.warehouse.finish_source_run(source_run_id, {}, error)
            self.case_store.complete_run(case_run_id, error=error)
            raise
        finally:
            if temporary_path and temporary_path.is_file():
                temporary_path.unlink()

    def capture_browser_tab(self, hunt_id: str, browser: PropertyBrowserSession, tab_index: int, *, screenshot: bool = True) -> dict[str, Any]:
        hunt = self.warehouse.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        case_id = str(hunt["case_id"])
        capture = browser.capture(tab_index, screenshot=screenshot)
        dom_path = Path(capture["dom_path"])
        source_key = str(capture.get("source_key") or "browser")
        case_run_id = self.case_store.create_run(case_id, "property-browser-capture", adapter="playwright", traffic_class="browser-assisted", config={"hunt_id": hunt_id, "source_key": source_key, "url": capture["url"]})
        dom_artifact_id = self.case_store.record_artifact_path(case_id, dom_path, "browser-rendered-dom", run_id=case_run_id, media_type="text/html", encoding="utf-8", source_uri=str(capture["url"]), metadata={"hunt_id": hunt_id, "source_key": source_key, "browser_capture": capture})
        screenshot_artifact_id = ""
        screenshot_path = Path(capture["screenshot_path"]) if capture.get("screenshot_path") else None
        if screenshot_path and screenshot_path.is_file():
            screenshot_artifact_id = self.case_store.record_artifact_path(case_id, screenshot_path, "browser-screenshot", run_id=case_run_id, media_type="image/png", source_uri=str(capture["url"]), metadata={"hunt_id": hunt_id, "source_key": source_key})
        raw_asset_id = self.warehouse.record_raw_asset_reference(hunt_id, source_key, dom_artifact_id, str(capture["url"]), byte_count=int(capture["dom_bytes"]), sha256=str(capture["dom_sha256"]), run_id="", media_type="text/html", response_metadata={"capture": capture}, normalization_status="captured")
        soup = BeautifulSoup(dom_path.read_bytes(), "html.parser")
        links = []
        for anchor in soup.find_all("a", href=True):
            href = str(anchor.get("href", "")).strip()
            if href.startswith(("http://", "https://")):
                links.append({"text": " ".join(anchor.get_text(" ", strip=True).split())[:300], "url": href})
        links = list({item["url"]: item for item in links}.values())[:5000]
        observation = {"hunt_id": hunt_id, "source_key": source_key, "url": capture["url"], "title": capture["title"], "captured_at": capture["captured_at"], "dom_sha256": capture["dom_sha256"], "links": links}
        observation_id = self.case_store.record_observation(case_id, "property-browser-dom", observation, run_id=case_run_id, normalized_value=str(capture["url"]), source_name=source_key, source_uri=str(capture["url"]), confidence=0.8, artifact_id=dom_artifact_id, metadata={"hunt_id": hunt_id, "raw_asset_id": raw_asset_id})
        self.case_store.add_evidence(case_id, "property-browser-dom", json.dumps({key: value for key, value in observation.items() if key != "links"}, ensure_ascii=False, sort_keys=True), observation_id=observation_id, artifact_id=dom_artifact_id, source_uri=str(capture["url"]))
        capture_id = self.warehouse.record_browser_capture(hunt_id, source_key, dom_artifact_id, str(capture["url"]), str(capture["title"]), screenshot_artifact_id=screenshot_artifact_id, metadata={"raw_asset_id": raw_asset_id, "observation_id": observation_id, "link_count": len(links)})
        summary = {"capture_id": capture_id, "artifact_id": dom_artifact_id, "screenshot_artifact_id": screenshot_artifact_id, "links": len(links), "url": capture["url"]}
        self.case_store.complete_run(case_run_id, summary=summary)
        return summary
