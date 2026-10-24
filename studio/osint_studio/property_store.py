from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

import duckdb
import pandas as pd

from .case_store import json_text, utc_now
from .paths import (
    PROPERTY_DATABASE_PATH,
    ensure_private_directory,
)


PROPERTY_SCHEMA_VERSION = 8
HUNT_STRATEGIES = ("state-weather", "county", "zip-code", "subdivision", "map-polygon", "storm-event", "uploaded-address")
PROPERTY_REVIEW_STATUSES = ("unreviewed", "needs-research", "qualified", "excluded", "approved-for-export", "expired")
PROPERTY_ACTIVATIONS = ("research-only", "exclude", "review", "campaign", "consent-gated")


@dataclass
class PropertyHuntConfig:
    name: str
    case_id: str
    strategy: str = "uploaded-address"
    state: str = "FL"
    county: str = ""
    municipality: str = ""
    zip_codes: list[str] = field(default_factory=list)
    subdivision: str = ""
    polygon_geojson: dict[str, Any] | None = None
    storm_start: str = ""
    storm_end: str = ""
    event_types: list[str] = field(default_factory=list)
    maximum_event_distance_km: float = 10.0
    property_types: list[str] = field(default_factory=list)
    minimum_building_age: int = 0
    permit_lookback_years: int = 15
    maximum_results: int = 10_000
    custom_source_urls: dict[str, str] = field(default_factory=dict)

    def normalized(self) -> PropertyHuntConfig:
        strategy = self.strategy if self.strategy in HUNT_STRATEGIES else "uploaded-address"
        return PropertyHuntConfig(
            name=self.name.strip() or "Property hunt",
            case_id=self.case_id,
            strategy=strategy,
            state=self.state.strip().upper() or "FL",
            county=self.county.strip(),
            municipality=self.municipality.strip(),
            zip_codes=list(dict.fromkeys(str(item).strip() for item in self.zip_codes if str(item).strip())),
            subdivision=self.subdivision.strip(),
            polygon_geojson=self.polygon_geojson,
            storm_start=self.storm_start,
            storm_end=self.storm_end,
            event_types=list(dict.fromkeys(str(item).strip() for item in self.event_types if str(item).strip())),
            maximum_event_distance_km=max(0.1, float(self.maximum_event_distance_km)),
            property_types=list(dict.fromkeys(str(item).strip() for item in self.property_types if str(item).strip())),
            minimum_building_age=max(0, int(self.minimum_building_age)),
            permit_lookback_years=max(0, int(self.permit_lookback_years)),
            maximum_results=max(1, min(1_000_000, int(self.maximum_results))),
            custom_source_urls={str(key): str(value).strip() for key, value in self.custom_source_urls.items() if str(value).strip()},
        )


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER, applied_at TIMESTAMP);

CREATE TABLE IF NOT EXISTS hunts(
    hunt_id VARCHAR PRIMARY KEY,
    case_id VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    strategy VARCHAR NOT NULL,
    state VARCHAR NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'draft',
    config_json VARCHAR NOT NULL,
    config_sha256 VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS source_registry(
    source_key VARCHAR PRIMARY KEY,
    label VARCHAR NOT NULL,
    category VARCHAR NOT NULL,
    official_url VARCHAR NOT NULL,
    capability VARCHAR NOT NULL,
    access_methods_json VARCHAR NOT NULL,
    default_method VARCHAR NOT NULL,
    automation VARCHAR NOT NULL,
    credential_field VARCHAR NOT NULL,
    fallback VARCHAR NOT NULL,
    analyst_review BOOLEAN NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS source_runs(
    run_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    case_run_id VARCHAR,
    source_key VARCHAR NOT NULL,
    method VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    request_json VARCHAR NOT NULL,
    summary_json VARCHAR NOT NULL DEFAULT '{}',
    started_at TIMESTAMP NOT NULL,
    finished_at TIMESTAMP,
    error VARCHAR NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS raw_assets(
    raw_asset_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    run_id VARCHAR,
    source_key VARCHAR NOT NULL,
    case_artifact_id VARCHAR NOT NULL,
    source_url VARCHAR NOT NULL,
    media_type VARCHAR NOT NULL,
    byte_count BIGINT NOT NULL,
    sha256 VARCHAR NOT NULL,
    retrieved_at TIMESTAMP NOT NULL,
    response_metadata_json VARCHAR NOT NULL,
    normalization_status VARCHAR NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS property_intel(
    hunt_id VARCHAR NOT NULL,
    record_id VARCHAR NOT NULL,
    parcel_id VARCHAR,
    property_address VARCHAR NOT NULL,
    city VARCHAR NOT NULL DEFAULT '',
    state VARCHAR NOT NULL DEFAULT '',
    zip VARCHAR NOT NULL DEFAULT '',
    county VARCHAR NOT NULL DEFAULT '',
    municipality VARCHAR NOT NULL DEFAULT '',
    latitude DOUBLE,
    longitude DOUBLE,
    property_type VARCHAR,
    year_built INTEGER,
    owner_name VARCHAR,
    owner_type VARCHAR,
    owner_occupancy_indicator VARCHAR,
    preferred_language VARCHAR,
    preferred_language_basis VARCHAR,
    preferred_language_source_url VARCHAR,
    preferred_language_confidence DOUBLE NOT NULL DEFAULT 0,
    preferred_language_reviewed_at TIMESTAMP,
    permit_authority VARCHAR,
    roof_permit_found BOOLEAN,
    last_roof_permit_number VARCHAR,
    last_roof_permit_date DATE,
    last_roof_permit_status VARCHAR,
    permit_match_confidence DOUBLE NOT NULL DEFAULT 0,
    selected_event_id VARCHAR,
    selected_event_type VARCHAR,
    selected_event_date TIMESTAMP,
    event_distance_km DOUBLE,
    storm_exposure_score DOUBLE NOT NULL DEFAULT 0,
    imagery_status VARCHAR,
    imagery_date DATE,
    observable_condition VARCHAR,
    property_opportunity_score DOUBLE NOT NULL DEFAULT 0,
    score_confidence DOUBLE NOT NULL DEFAULT 0,
    reason_codes_json VARCHAR NOT NULL DEFAULT '[]',
    review_status VARCHAR NOT NULL DEFAULT 'unreviewed',
    analyst_notes VARCHAR NOT NULL DEFAULT '',
    recommended_activation VARCHAR NOT NULL DEFAULT 'research-only',
    source_count INTEGER NOT NULL DEFAULT 1,
    retrieved_at TIMESTAMP NOT NULL,
    score_generated_at TIMESTAMP,
    record_expires_at TIMESTAMP NOT NULL,
    source_row_json VARCHAR NOT NULL DEFAULT '{}',
    provenance_json VARCHAR NOT NULL DEFAULT '[]',
    PRIMARY KEY(hunt_id, record_id)
);

CREATE TABLE IF NOT EXISTS address_matches(
    match_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    record_id VARCHAR NOT NULL,
    input_address VARCHAR NOT NULL,
    matched_address VARCHAR NOT NULL,
    method VARCHAR NOT NULL,
    confidence DOUBLE NOT NULL,
    county_fips VARCHAR NOT NULL,
    state_fips VARCHAR NOT NULL,
    conflict_flags_json VARCHAR NOT NULL,
    raw_asset_id VARCHAR,
    created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS event_records(
    hunt_id VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    event_type VARCHAR NOT NULL,
    event_date TIMESTAMP,
    latitude DOUBLE,
    longitude DOUBLE,
    county VARCHAR NOT NULL DEFAULT '',
    state VARCHAR NOT NULL DEFAULT '',
    magnitude VARCHAR NOT NULL DEFAULT '',
    source_row_json VARCHAR NOT NULL,
    raw_asset_id VARCHAR,
    PRIMARY KEY(hunt_id, event_id)
);

CREATE TABLE IF NOT EXISTS state_boundaries(
    hunt_id VARCHAR NOT NULL,
    state VARCHAR NOT NULL,
    state_fips VARCHAR NOT NULL,
    geojson VARCHAR NOT NULL,
    raw_asset_id VARCHAR,
    retrieved_at TIMESTAMP NOT NULL,
    PRIMARY KEY(hunt_id, state)
);

CREATE TABLE IF NOT EXISTS rainfall_observations(
    hunt_id VARCHAR NOT NULL,
    station_id VARCHAR NOT NULL,
    station_name VARCHAR NOT NULL DEFAULT '',
    observation_date DATE NOT NULL,
    latitude DOUBLE NOT NULL,
    longitude DOUBLE NOT NULL,
    precipitation_mm DOUBLE NOT NULL,
    attributes VARCHAR NOT NULL DEFAULT '',
    raw_asset_id VARCHAR,
    PRIMARY KEY(hunt_id, station_id, observation_date)
);
CREATE INDEX IF NOT EXISTS idx_rainfall_hunt_date ON rainfall_observations(hunt_id, observation_date);

CREATE TABLE IF NOT EXISTS map_selections(
    selection_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    latitude DOUBLE NOT NULL,
    longitude DOUBLE NOT NULL,
    display_name VARCHAR NOT NULL,
    address_json VARCHAR NOT NULL,
    raw_asset_id VARCHAR,
    created_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_selections_hunt ON map_selections(hunt_id, created_at);

CREATE TABLE IF NOT EXISTS map_fences(
    fence_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    geojson VARCHAR NOT NULL,
    case_artifact_id VARCHAR,
    created_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_fences_hunt ON map_fences(hunt_id, created_at);

CREATE TABLE IF NOT EXISTS geo_capture_queue(
    queue_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    fence_id VARCHAR NOT NULL,
    record_id VARCHAR NOT NULL,
    latitude DOUBLE NOT NULL,
    longitude DOUBLE NOT NULL,
    source_url VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error VARCHAR NOT NULL DEFAULT '',
    queued_at TIMESTAMP NOT NULL,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    UNIQUE(hunt_id, fence_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_geo_capture_queue_hunt ON geo_capture_queue(hunt_id, status, queued_at);

CREATE TABLE IF NOT EXISTS tax_import_batches(
    import_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    case_run_id VARCHAR,
    filename VARCHAR NOT NULL,
    archive_type VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    raw_asset_id VARCHAR,
    state VARCHAR NOT NULL,
    roll_types_json VARCHAR NOT NULL DEFAULT '[]',
    members_json VARCHAR NOT NULL DEFAULT '[]',
    rows_seen BIGINT NOT NULL DEFAULT 0,
    rows_imported BIGINT NOT NULL DEFAULT 0,
    rows_rejected BIGINT NOT NULL DEFAULT 0,
    properties_promoted BIGINT NOT NULL DEFAULT 0,
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    error VARCHAR NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tax_import_hunt ON tax_import_batches(hunt_id, started_at);

CREATE TABLE IF NOT EXISTS tax_records(
    tax_record_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    import_id VARCHAR NOT NULL,
    raw_asset_id VARCHAR,
    source_member VARCHAR NOT NULL,
    source_row_number BIGINT,
    state VARCHAR NOT NULL,
    county_no VARCHAR NOT NULL,
    county VARCHAR NOT NULL,
    assessment_year VARCHAR NOT NULL,
    roll_type VARCHAR NOT NULL,
    source_identifier VARCHAR NOT NULL,
    parcel_id VARCHAR,
    account_id VARCHAR,
    tax_authority_code VARCHAR,
    owner_name VARCHAR,
    owner_mailing_address VARCHAR,
    owner_city VARCHAR,
    owner_state VARCHAR,
    owner_zip VARCHAR,
    site_address VARCHAR,
    site_city VARCHAR,
    site_zip VARCHAR,
    property_use_code VARCHAR,
    year_built INTEGER,
    source_row_json VARCHAR NOT NULL,
    imported_at TIMESTAMP NOT NULL,
    UNIQUE(hunt_id,assessment_year,roll_type,county_no,source_identifier)
);
CREATE INDEX IF NOT EXISTS idx_tax_records_hunt ON tax_records(hunt_id, roll_type, county, assessment_year);
CREATE INDEX IF NOT EXISTS idx_tax_records_parcel ON tax_records(hunt_id, parcel_id);

CREATE TABLE IF NOT EXISTS permit_authority_registry(
    route_id VARCHAR PRIMARY KEY,
    state VARCHAR NOT NULL,
    county VARCHAR NOT NULL,
    jurisdiction VARCHAR NOT NULL,
    coverage_scope VARCHAR NOT NULL,
    portal_name VARCHAR NOT NULL,
    direct_search_url VARCHAR NOT NULL,
    platform VARCHAR NOT NULL,
    verification_status VARCHAR NOT NULL,
    parcel_lookup_label VARCHAR NOT NULL,
    query_method VARCHAR NOT NULL,
    supports_direct_url_parameter BOOLEAN NOT NULL DEFAULT FALSE,
    parcel_format_notes VARCHAR NOT NULL,
    municipal_override_required BOOLEAN NOT NULL DEFAULT TRUE,
    routing_rule VARCHAR NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    source_url VARCHAR NOT NULL,
    last_reviewed VARCHAR NOT NULL,
    registry_source VARCHAR NOT NULL,
    imported_at TIMESTAMP NOT NULL,
    UNIQUE(state,county,jurisdiction,direct_search_url)
);
CREATE INDEX IF NOT EXISTS idx_permit_registry_location ON permit_authority_registry(state, county, priority);

CREATE TABLE IF NOT EXISTS permit_search_jobs(
    job_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    record_id VARCHAR NOT NULL,
    route_id VARCHAR NOT NULL,
    state VARCHAR NOT NULL,
    county VARCHAR NOT NULL,
    municipality VARCHAR NOT NULL,
    authority VARCHAR NOT NULL,
    authority_resolution_status VARCHAR NOT NULL,
    jurisdiction_basis VARCHAR NOT NULL,
    portal_url VARCHAR NOT NULL,
    platform VARCHAR NOT NULL,
    verification_status VARCHAR NOT NULL,
    raw_identifier VARCHAR NOT NULL,
    query_variants_json VARCHAR NOT NULL,
    matched_identifier VARCHAR NOT NULL DEFAULT '',
    status VARCHAR NOT NULL,
    result_status VARCHAR NOT NULL DEFAULT 'NOT_SEARCHED',
    result_url VARCHAR NOT NULL DEFAULT '',
    capture_id VARCHAR NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error VARCHAR NOT NULL DEFAULT '',
    analyst_notes VARCHAR NOT NULL DEFAULT '',
    queued_at TIMESTAMP NOT NULL,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    UNIQUE(hunt_id,record_id,route_id)
);
CREATE INDEX IF NOT EXISTS idx_permit_jobs_hunt ON permit_search_jobs(hunt_id, status, county, queued_at);

CREATE TABLE IF NOT EXISTS owner_verification_queue(
    verification_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    record_id VARCHAR NOT NULL,
    source_key VARCHAR NOT NULL,
    source_url VARCHAR NOT NULL,
    owner_name VARCHAR NOT NULL,
    property_address VARCHAR NOT NULL,
    city VARCHAR NOT NULL DEFAULT '',
    state VARCHAR NOT NULL DEFAULT '',
    zip VARCHAR NOT NULL DEFAULT '',
    status VARCHAR NOT NULL DEFAULT 'manual-review',
    verification_result VARCHAR NOT NULL DEFAULT 'NOT_REVIEWED',
    match_confidence DOUBLE NOT NULL DEFAULT 0,
    reviewed_source_url VARCHAR NOT NULL DEFAULT '',
    analyst_notes VARCHAR NOT NULL DEFAULT '',
    queued_at TIMESTAMP NOT NULL,
    reviewed_at TIMESTAMP,
    UNIQUE(hunt_id,record_id,source_key)
);
CREATE INDEX IF NOT EXISTS idx_owner_verification_hunt ON owner_verification_queue(hunt_id,status,queued_at);

CREATE TABLE IF NOT EXISTS owner_verification_suppressions(
    suppression_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    record_id VARCHAR NOT NULL,
    source_key VARCHAR NOT NULL,
    reason VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL,
    UNIQUE(hunt_id,record_id,source_key)
);
CREATE INDEX IF NOT EXISTS idx_owner_suppressions_hunt ON owner_verification_suppressions(hunt_id,created_at);

CREATE TABLE IF NOT EXISTS area_demographic_profiles(
    profile_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    geography_type VARCHAR NOT NULL,
    geography_name VARCHAR NOT NULL,
    state VARCHAR NOT NULL,
    state_fips VARCHAR NOT NULL,
    county_fips VARCHAR NOT NULL,
    vintage INTEGER NOT NULL,
    population BIGINT NOT NULL,
    median_household_income BIGINT NOT NULL,
    race_ethnicity_total BIGINT NOT NULL,
    race_ethnicity_json VARCHAR NOT NULL,
    language_total BIGINT NOT NULL,
    languages_json VARCHAR NOT NULL,
    household_income_total BIGINT NOT NULL,
    household_income_bands_json VARCHAR NOT NULL,
    source_url VARCHAR NOT NULL,
    raw_asset_id VARCHAR,
    retrieved_at TIMESTAMP NOT NULL,
    UNIQUE(hunt_id,geography_type,state_fips,county_fips,vintage)
);
CREATE INDEX IF NOT EXISTS idx_area_demographic_hunt ON area_demographic_profiles(hunt_id,state,geography_name,vintage);

CREATE TABLE IF NOT EXISTS extension_capture_signals(
    signal_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    verification_id VARCHAR NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL,
    consumed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_extension_signals ON extension_capture_signals(verification_id,status,created_at);

CREATE TABLE IF NOT EXISTS extension_capture_receipts(
    receipt_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    verification_id VARCHAR NOT NULL,
    record_id VARCHAR NOT NULL,
    source_key VARCHAR NOT NULL,
    page_url VARCHAR NOT NULL,
    page_title VARCHAR NOT NULL,
    candidate_name VARCHAR NOT NULL,
    candidate_address VARCHAR NOT NULL,
    name_similarity DOUBLE NOT NULL,
    address_similarity DOUBLE NOT NULL,
    content_sha256 VARCHAR NOT NULL,
    observed_language VARCHAR NOT NULL,
    language_confidence DOUBLE NOT NULL,
    action VARCHAR NOT NULL,
    submitted_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extension_receipts ON extension_capture_receipts(hunt_id,record_id,submitted_at);

CREATE TABLE IF NOT EXISTS browser_captures(
    capture_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    source_key VARCHAR NOT NULL,
    case_artifact_id VARCHAR NOT NULL,
    screenshot_artifact_id VARCHAR,
    url VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    captured_at TIMESTAMP NOT NULL,
    metadata_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS export_runs(
    export_id VARCHAR PRIMARY KEY,
    hunt_id VARCHAR NOT NULL,
    export_format VARCHAR NOT NULL,
    output_path VARCHAR NOT NULL,
    row_count INTEGER NOT NULL,
    manifest_json VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL
);
"""


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _sha256_text(value: str) -> str:
    import hashlib

    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _safe_label(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-.")
    return cleaned[:80] or "property-hunt"


def _is_number(value: Any) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def _point_in_ring(longitude: float, latitude: float, ring: list[list[float]]) -> bool:
    inside = False
    previous = len(ring) - 1
    for current in range(len(ring)):
        x1, y1 = ring[current][:2]
        x2, y2 = ring[previous][:2]
        if (y1 > latitude) != (y2 > latitude):
            crossing = (x2 - x1) * (latitude - y1) / ((y2 - y1) or 1e-15) + x1
            if longitude < crossing:
                inside = not inside
        previous = current
    return inside


def _geojson_contains(value: dict[str, Any] | None, longitude: float, latitude: float) -> bool:
    if not value:
        return True
    geometry = value.get("geometry") if value.get("type") == "Feature" else value
    if geometry.get("type") == "FeatureCollection":
        return any(_geojson_contains(item, longitude, latitude) for item in geometry.get("features", []))
    coordinates = geometry.get("coordinates") or []
    polygons = [coordinates] if geometry.get("type") == "Polygon" else coordinates if geometry.get("type") == "MultiPolygon" else []
    for polygon in polygons:
        if polygon and _point_in_ring(longitude, latitude, polygon[0]):
            if not any(_point_in_ring(longitude, latitude, hole) for hole in polygon[1:]):
                return True
    return False


class PropertyWarehouse:
    def __init__(self, path: str | Path = PROPERTY_DATABASE_PATH):
        self.path = Path(path).expanduser()
        self.root = ensure_private_directory(self.path.parent)
        self.parquet_root = ensure_private_directory(self.root / "parquet")
        self.export_root = ensure_private_directory(self.root / "exports")
        self.audit_path = self.root / "audit" / "actions.jsonl"
        ensure_private_directory(self.audit_path.parent)
        self._initialize()

    @contextmanager
    def connection(self, *, read_only: bool = False) -> Iterator[duckdb.DuckDBPyConnection]:
        connection = duckdb.connect(str(self.path), read_only=read_only)
        try:
            yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self.connection() as connection:
            connection.execute(SCHEMA_SQL)
            current = connection.execute("SELECT COALESCE(MAX(version), 0) FROM schema_meta").fetchone()[0]
            if int(current) > PROPERTY_SCHEMA_VERSION:
                raise RuntimeError(f"Property warehouse schema {current} is newer than supported {PROPERTY_SCHEMA_VERSION}.")
            if int(current) < 4:
                connection.execute("ALTER TABLE property_intel ADD COLUMN IF NOT EXISTS owner_name VARCHAR")
            connection.execute("ALTER TABLE property_intel ADD COLUMN IF NOT EXISTS preferred_language VARCHAR")
            connection.execute("ALTER TABLE property_intel ADD COLUMN IF NOT EXISTS preferred_language_basis VARCHAR")
            connection.execute("ALTER TABLE property_intel ADD COLUMN IF NOT EXISTS preferred_language_source_url VARCHAR")
            connection.execute("ALTER TABLE property_intel ADD COLUMN IF NOT EXISTS preferred_language_confidence DOUBLE DEFAULT 0")
            connection.execute("ALTER TABLE property_intel ADD COLUMN IF NOT EXISTS preferred_language_reviewed_at TIMESTAMP")
            connection.execute("ALTER TABLE tax_records ADD COLUMN IF NOT EXISTS source_row_number BIGINT")
            connection.execute("INSERT INTO schema_meta SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM schema_meta WHERE version=?)", [PROPERTY_SCHEMA_VERSION, utc_now(), PROPERTY_SCHEMA_VERSION])

    def audit(self, action: str, details: dict[str, Any]) -> None:
        entry = {"timestamp": utc_now(), "action": action, **details}
        with self.audit_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
        if os.name == "posix":
            self.audit_path.chmod(0o600)

    def sync_sources(self, sources: list[dict[str, Any]]) -> None:
        now = utc_now()
        with self.connection() as connection:
            for source in sources:
                values = [source["label"], source["category"], source["official_url"], source["capability"], json_text(source["access_methods"]), source["default_method"], source["automation"], source["credential_field"], source["fallback"], source["analyst_review"]]
                current = connection.execute("SELECT label,category,official_url,capability,access_methods_json,default_method,automation,credential_field,fallback,analyst_review FROM source_registry WHERE source_key=?", [source["key"]]).fetchone()
                if current and list(current) == values:
                    continue
                connection.execute(
                    """INSERT INTO source_registry VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(source_key) DO UPDATE SET label=excluded.label,category=excluded.category,official_url=excluded.official_url,capability=excluded.capability,access_methods_json=excluded.access_methods_json,default_method=excluded.default_method,automation=excluded.automation,credential_field=excluded.credential_field,fallback=excluded.fallback,analyst_review=excluded.analyst_review,updated_at=excluded.updated_at""",
                    [source["key"], *values, now],
                )

    def create_hunt(self, config: PropertyHuntConfig) -> str:
        normalized = config.normalized()
        config_json = json_text(asdict(normalized))
        hunt_id = _id("hunt")
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO hunts VALUES(?,?,?,?,?,?,?,?,?,?)",
                [hunt_id, normalized.case_id, normalized.name, normalized.strategy, normalized.state, "draft", config_json, _sha256_text(config_json), now, now],
            )
        self.audit("hunt-created", {"hunt_id": hunt_id, "case_id": normalized.case_id, "strategy": normalized.strategy})
        return hunt_id

    def list_hunts(self, case_id: str) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute("SELECT * FROM hunts WHERE case_id=? ORDER BY updated_at DESC", [case_id]).fetchdf()
        return frame.to_dict("records")

    def get_hunt(self, hunt_id: str) -> dict[str, Any] | None:
        with self.connection(read_only=True) as connection:
            frame = connection.execute("SELECT * FROM hunts WHERE hunt_id=?", [hunt_id]).fetchdf()
        if frame.empty:
            return None
        item = frame.iloc[0].to_dict()
        item["config"] = json.loads(str(item["config_json"]))
        return item

    def update_hunt_source_url(self, hunt_id: str, source_key: str, url: str) -> None:
        hunt = self.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(f"Unknown property hunt: {hunt_id}")
        config = dict(hunt["config"])
        custom = dict(config.get("custom_source_urls") or {})
        custom[source_key] = url
        config["custom_source_urls"] = custom
        config_json = json_text(config)
        with self.connection() as connection:
            connection.execute("UPDATE hunts SET config_json=?,config_sha256=?,updated_at=? WHERE hunt_id=?", [config_json, _sha256_text(config_json), utc_now(), hunt_id])
        self.audit("hunt-source-url-updated", {"hunt_id": hunt_id, "source_key": source_key, "url": url})

    def update_hunt_polygon(self, hunt_id: str, polygon_geojson: dict[str, Any]) -> None:
        hunt = self.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(f"Unknown property hunt: {hunt_id}")
        config = dict(hunt["config"])
        config["polygon_geojson"] = polygon_geojson
        config["strategy"] = "map-polygon"
        config_json = json_text(config)
        with self.connection() as connection:
            connection.execute(
                "UPDATE hunts SET strategy='map-polygon',config_json=?,config_sha256=?,updated_at=? WHERE hunt_id=?",
                [config_json, _sha256_text(config_json), utc_now(), hunt_id],
            )
        self.audit("hunt-polygon-updated", {"hunt_id": hunt_id})

    def start_source_run(self, hunt_id: str, source_key: str, method: str, request: dict[str, Any], case_run_id: str = "") -> str:
        run_id = _id("property_run")
        with self.connection() as connection:
            connection.execute("INSERT INTO source_runs(run_id,hunt_id,case_run_id,source_key,method,status,request_json,started_at) VALUES(?,?,?,?,?,?,?,?)", [run_id, hunt_id, case_run_id, source_key, method, "running", json_text(request), utc_now()])
        return run_id

    def finish_source_run(self, run_id: str, summary: dict[str, Any], error: str = "") -> None:
        with self.connection() as connection:
            connection.execute("UPDATE source_runs SET status=?,summary_json=?,finished_at=?,error=? WHERE run_id=?", ["failed" if error else "completed", json_text(summary), utc_now(), error, run_id])

    def record_raw_asset(self, hunt_id: str, source_key: str, case_artifact_id: str, source_url: str, content: bytes, *, run_id: str = "", media_type: str = "application/octet-stream", response_metadata: dict[str, Any] | None = None, normalization_status: str = "pending") -> str:
        import hashlib

        return self.record_raw_asset_reference(
            hunt_id,
            source_key,
            case_artifact_id,
            source_url,
            byte_count=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
            run_id=run_id,
            media_type=media_type,
            response_metadata=response_metadata,
            normalization_status=normalization_status,
        )

    def record_raw_asset_reference(self, hunt_id: str, source_key: str, case_artifact_id: str, source_url: str, *, byte_count: int, sha256: str, run_id: str = "", media_type: str = "application/octet-stream", response_metadata: dict[str, Any] | None = None, normalization_status: str = "pending") -> str:
        raw_asset_id = _id("raw")
        with self.connection() as connection:
            connection.execute("INSERT INTO raw_assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [raw_asset_id, hunt_id, run_id or None, source_key, case_artifact_id, source_url, media_type, int(byte_count), sha256, utc_now(), json_text(response_metadata or {}), normalization_status])
        return raw_asset_id

    def start_tax_import(self, hunt_id: str, filename: str, case_run_id: str = "") -> str:
        import_id = _id("tax_import")
        archive_type = "zip" if filename.lower().endswith(".zip") else "csv"
        with self.connection() as connection:
            connection.execute(
                """INSERT INTO tax_import_batches(import_id,hunt_id,case_run_id,filename,archive_type,status,state,started_at)
                VALUES(?,?,?,?,?,?,?,?)""",
                [import_id, hunt_id, case_run_id or None, filename, archive_type, "running", "FL", utc_now()],
            )
        return import_id

    def finish_tax_import(self, import_id: str, summary: dict[str, Any], error: str = "") -> None:
        with self.connection() as connection:
            connection.execute(
                """UPDATE tax_import_batches SET status=?,raw_asset_id=?,roll_types_json=?,members_json=?,
                rows_seen=?,rows_imported=?,rows_rejected=?,properties_promoted=?,completed_at=?,error=? WHERE import_id=?""",
                [
                    "failed" if error else "completed",
                    summary.get("raw_asset_id") or None,
                    json_text(summary.get("roll_types", [])),
                    json_text(summary.get("members", [])),
                    int(summary.get("rows_seen", 0)),
                    int(summary.get("rows_imported", 0)),
                    int(summary.get("rows_rejected", 0)),
                    int(summary.get("properties_promoted", 0)),
                    utc_now(),
                    error,
                    import_id,
                ],
            )

    def import_tax_frame(self, hunt_id: str, import_id: str, raw_asset_id: str, frame: pd.DataFrame) -> int:
        if frame.empty:
            return 0
        incoming = frame.copy()
        incoming.insert(0, "tax_record_id", [_id("tax") for _ in range(len(incoming))])
        incoming.insert(1, "hunt_id", hunt_id)
        incoming.insert(2, "import_id", import_id)
        incoming.insert(3, "raw_asset_id", raw_asset_id)
        incoming["imported_at"] = utc_now()
        with self.connection() as connection:
            connection.register("incoming_tax_records", incoming)
            try:
                connection.execute(
                    """INSERT INTO tax_records(
                    tax_record_id,hunt_id,import_id,raw_asset_id,source_member,source_row_number,state,county_no,county,assessment_year,
                    roll_type,source_identifier,parcel_id,account_id,tax_authority_code,owner_name,owner_mailing_address,
                    owner_city,owner_state,owner_zip,site_address,site_city,site_zip,property_use_code,year_built,
                    source_row_json,imported_at)
                    SELECT tax_record_id,hunt_id,import_id,NULLIF(raw_asset_id,''),source_member,source_row_number,state,county_no,county,
                    assessment_year,roll_type,source_identifier,NULLIF(parcel_id,''),NULLIF(account_id,''),
                    NULLIF(tax_authority_code,''),NULLIF(owner_name,''),NULLIF(owner_mailing_address,''),NULLIF(owner_city,''),
                    NULLIF(owner_state,''),NULLIF(owner_zip,''),NULLIF(site_address,''),NULLIF(site_city,''),NULLIF(site_zip,''),
                    NULLIF(property_use_code,''),TRY_CAST(NULLIF(year_built,'') AS INTEGER),source_row_json,TRY_CAST(imported_at AS TIMESTAMP)
                    FROM incoming_tax_records
                    ON CONFLICT(hunt_id,assessment_year,roll_type,county_no,source_identifier) DO UPDATE SET
                    import_id=excluded.import_id,raw_asset_id=excluded.raw_asset_id,source_member=excluded.source_member,
                    parcel_id=COALESCE(excluded.parcel_id,tax_records.parcel_id),account_id=COALESCE(excluded.account_id,tax_records.account_id),
                    owner_name=COALESCE(excluded.owner_name,tax_records.owner_name),site_address=COALESCE(excluded.site_address,tax_records.site_address),
                    site_city=COALESCE(excluded.site_city,tax_records.site_city),site_zip=COALESCE(excluded.site_zip,tax_records.site_zip),
                    property_use_code=COALESCE(excluded.property_use_code,tax_records.property_use_code),
                    year_built=COALESCE(excluded.year_built,tax_records.year_built),source_row_json=excluded.source_row_json,
                    imported_at=excluded.imported_at"""
                )
            finally:
                connection.unregister("incoming_tax_records")
        return len(incoming)

    def promote_tax_import(self, hunt_id: str, import_id: str) -> dict[str, int]:
        hunt = self.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        maximum = int(hunt["config"].get("maximum_results", 10_000))
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                """SELECT parcel_id,site_address,site_city,site_zip,county,owner_name,property_use_code,year_built,raw_asset_id
                FROM tax_records WHERE hunt_id=? AND import_id=? AND roll_type='NAL' AND COALESCE(site_address,'')<>''
                ORDER BY county,parcel_id LIMIT ?""",
                [hunt_id, import_id, maximum],
            ).fetchdf()
        if frame.empty:
            return {"nal_candidates": 0, "properties_promoted": 0}
        frame["address"] = frame.apply(
            lambda row: ", ".join(str(value).strip() for value in (row.get("site_address"), row.get("site_city"), "FL", row.get("site_zip")) if value is not None and not pd.isna(value) and str(value).strip()),
            axis=1,
        )
        frame["city"] = frame["site_city"]
        frame["state"] = "FL"
        frame["zip"] = frame["site_zip"]
        frame["property_type"] = frame["property_use_code"]
        raw_asset_id = str(next((value for value in frame["raw_asset_id"] if value is not None and not pd.isna(value)), ""))
        promoted = self.import_address_frame(
            hunt_id,
            frame[["address", "city", "state", "zip", "county", "parcel_id", "year_built", "owner_name", "property_type"]],
            raw_asset_id,
            source_key="fl_dor_tax_roll",
        )
        return {"nal_candidates": len(frame), "properties_promoted": promoted}

    def list_tax_imports(self, hunt_id: str, limit: int = 100) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                "SELECT * FROM tax_import_batches WHERE hunt_id=? ORDER BY started_at DESC LIMIT ?",
                [hunt_id, max(1, int(limit))],
            ).fetchdf()
        rows = frame.to_dict("records")
        for row in rows:
            row["roll_types"] = json.loads(str(row.pop("roll_types_json") or "[]"))
            row["members"] = json.loads(str(row.pop("members_json") or "[]"))
        return rows

    def tax_roll_summary(self, hunt_id: str) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                """SELECT state,county,assessment_year,roll_type,COUNT(*) AS records,
                COUNT(parcel_id) AS parcel_ids,COUNT(owner_name) AS owner_names,COUNT(year_built) AS years_built
                FROM tax_records WHERE hunt_id=? GROUP BY ALL ORDER BY assessment_year DESC,county,roll_type""",
                [hunt_id],
            ).fetchdf()
        return frame.to_dict("records")

    def list_tax_records(self, hunt_id: str, *, roll_type: str = "", county: str = "", limit: int = 5_000) -> list[dict[str, Any]]:
        clauses = ["hunt_id=?"]
        values: list[Any] = [hunt_id]
        if roll_type:
            clauses.append("roll_type=?")
            values.append(roll_type)
        if county:
            clauses.append("lower(county)=lower(?)")
            values.append(county)
        values.append(max(1, int(limit)))
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                f"""SELECT tax_record_id,assessment_year,roll_type,county,source_identifier,parcel_id,account_id,
                owner_name,site_address,site_city,site_zip,property_use_code,year_built,source_member,source_row_number,imported_at
                FROM tax_records WHERE {' AND '.join(clauses)} ORDER BY county,source_identifier LIMIT ?""",
                values,
            ).fetchdf()
        return frame.to_dict("records")

    def upsert_permit_routes(self, routes: list[dict[str, Any]], registry_source: str) -> int:
        count = 0
        now = utc_now()
        with self.connection() as connection:
            for row in routes:
                if not str(row.get("state") or "").strip() or not str(row.get("county") or "").strip() or not str(row.get("jurisdiction") or "").strip():
                    continue
                connection.execute(
                    """INSERT INTO permit_authority_registry(route_id,state,county,jurisdiction,coverage_scope,portal_name,
                    direct_search_url,platform,verification_status,parcel_lookup_label,query_method,supports_direct_url_parameter,
                    parcel_format_notes,municipal_override_required,routing_rule,priority,source_url,last_reviewed,registry_source,imported_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(state,county,jurisdiction,direct_search_url) DO UPDATE SET
                    coverage_scope=excluded.coverage_scope,portal_name=excluded.portal_name,platform=excluded.platform,
                    verification_status=excluded.verification_status,parcel_lookup_label=excluded.parcel_lookup_label,
                    query_method=excluded.query_method,supports_direct_url_parameter=excluded.supports_direct_url_parameter,
                    parcel_format_notes=excluded.parcel_format_notes,municipal_override_required=excluded.municipal_override_required,
                    routing_rule=excluded.routing_rule,priority=excluded.priority,source_url=excluded.source_url,
                    last_reviewed=excluded.last_reviewed,registry_source=excluded.registry_source,imported_at=excluded.imported_at""",
                    [
                        _id("permit_route"), str(row.get("state") or "").upper(), str(row.get("county") or ""),
                        str(row.get("jurisdiction") or ""), str(row.get("coverage_scope") or ""), str(row.get("portal_name") or ""),
                        str(row.get("direct_search_url") or ""), str(row.get("platform") or ""), str(row.get("verification_status") or "UNVERIFIED"),
                        str(row.get("parcel_lookup_label") or ""), str(row.get("query_method") or "browser_form"), bool(row.get("supports_direct_url_parameter")),
                        str(row.get("parcel_format_notes") or ""), bool(row.get("municipal_override_required", True)), str(row.get("routing_rule") or ""),
                        int(row.get("priority") or 100), str(row.get("source_url") or row.get("direct_search_url") or ""),
                        str(row.get("last_reviewed") or ""), registry_source, now,
                    ],
                )
                count += 1
        self.audit("permit-registry-upserted", {"rows": count, "source": registry_source})
        return count

    def list_permit_routes(self, *, state: str = "FL", county: str = "") -> list[dict[str, Any]]:
        clauses = ["state=?"]
        values: list[Any] = [state.upper()]
        if county:
            clauses.append("lower(county)=lower(?)")
            values.append(county)
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                f"SELECT * FROM permit_authority_registry WHERE {' AND '.join(clauses)} ORDER BY county,priority,jurisdiction",
                values,
            ).fetchdf()
        return frame.to_dict("records")

    def queue_permit_searches(self, hunt_id: str, county: str, *, route_id: str = "", jurisdiction_basis: str = "unresolved") -> dict[str, int]:
        from .tax_permit import permit_query_variants

        allowed_basis = {"unresolved", "geometry-confirmed", "analyst-confirmed-municipality", "analyst-confirmed-county"}
        if jurisdiction_basis not in allowed_basis:
            raise ValueError(jurisdiction_basis)
        route: dict[str, Any] | None = None
        if route_id:
            with self.connection(read_only=True) as connection:
                route_frame = connection.execute("SELECT * FROM permit_authority_registry WHERE route_id=?", [route_id]).fetchdf()
            route = route_frame.iloc[0].to_dict() if not route_frame.empty else None
            if not route:
                raise ValueError("Unknown permit route")
            if str(route.get("county") or "").casefold() != county.casefold():
                raise ValueError("The selected permit route does not match the record county.")
        with self.connection(read_only=True) as connection:
            properties = connection.execute(
                """SELECT record_id,state,county,municipality,parcel_id FROM property_intel
                WHERE hunt_id=? AND lower(county)=lower(?) AND COALESCE(parcel_id,'')<>'' ORDER BY record_id""",
                [hunt_id, county],
            ).fetchdf().to_dict("records")
        queued = pending = 0
        now = utc_now()
        with self.connection() as connection:
            for record in properties:
                confirmed = jurisdiction_basis != "unresolved" and route is not None
                verification = str(route.get("verification_status") or "UNRESOLVED") if route else "UNRESOLVED"
                status = "ready-browser" if confirmed and verification == "VERIFIED_PARCEL" else "manual-review" if confirmed else "pending-jurisdiction"
                if status != "ready-browser":
                    pending += 1
                raw_identifier = str(record.get("parcel_id") or "")
                connection.execute(
                    """INSERT INTO permit_search_jobs(job_id,hunt_id,record_id,route_id,state,county,municipality,authority,
                    authority_resolution_status,jurisdiction_basis,portal_url,platform,verification_status,raw_identifier,
                    query_variants_json,status,queued_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(hunt_id,record_id,route_id) DO UPDATE SET authority=excluded.authority,
                    authority_resolution_status=excluded.authority_resolution_status,jurisdiction_basis=excluded.jurisdiction_basis,
                    portal_url=excluded.portal_url,platform=excluded.platform,verification_status=excluded.verification_status,
                    query_variants_json=excluded.query_variants_json,status=excluded.status,queued_at=excluded.queued_at""",
                    [
                        _id("permit_job"), hunt_id, str(record["record_id"]), str(route.get("route_id") or "") if route else "",
                        str(record.get("state") or "FL"), county, str(record.get("municipality") or ""),
                        str(route.get("jurisdiction") or "") if route else "", "confirmed" if confirmed else "unresolved",
                        jurisdiction_basis, str(route.get("direct_search_url") or "") if route else "",
                        str(route.get("platform") or "") if route else "", verification, raw_identifier,
                        json_text(permit_query_variants(raw_identifier, county, str(route.get("jurisdiction") or "") if route else "")), status, now,
                    ],
                )
                queued += 1
        self.audit("permit-searches-queued", {"hunt_id": hunt_id, "county": county, "route_id": route_id, "basis": jurisdiction_basis, "queued": queued})
        return {"queued": queued, "ready_browser": queued - pending, "pending_or_manual": pending}

    def list_permit_jobs(self, hunt_id: str, limit: int = 100_000) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                """SELECT j.*,p.property_address,p.owner_name,p.year_built,p.parcel_id
                FROM permit_search_jobs j JOIN property_intel p ON p.hunt_id=j.hunt_id AND p.record_id=j.record_id
                WHERE j.hunt_id=? ORDER BY j.queued_at DESC,p.property_address LIMIT ?""",
                [hunt_id, max(1, int(limit))],
            ).fetchdf()
        rows = frame.to_dict("records")
        for row in rows:
            row["query_variants"] = json.loads(str(row.pop("query_variants_json") or "[]"))
        return rows

    def update_permit_job_result(self, hunt_id: str, job_id: str, result_status: str, *, matched_identifier: str = "", result_url: str = "", capture_id: str = "", notes: str = "") -> None:
        from .tax_permit import PERMIT_RESULT_STATUSES

        if result_status not in PERMIT_RESULT_STATUSES:
            raise ValueError(result_status)
        job_status = "ready-browser" if result_status == "NOT_SEARCHED" else "completed-inconclusive" if result_status == "NO_ACCESSIBLE_MATCH" else "completed"
        with self.connection() as connection:
            connection.execute(
                """UPDATE permit_search_jobs SET result_status=?,matched_identifier=?,result_url=?,capture_id=?,analyst_notes=?,
                status=?,attempts=attempts+1,started_at=COALESCE(started_at,?),completed_at=? WHERE hunt_id=? AND job_id=?""",
                [result_status, matched_identifier, result_url, capture_id, notes, job_status, utc_now(), None if result_status == "NOT_SEARCHED" else utc_now(), hunt_id, job_id],
            )
            if result_status == "MATCH_FOUND":
                connection.execute(
                    """UPDATE property_intel SET permit_authority=(SELECT authority FROM permit_search_jobs WHERE job_id=?),
                    permit_match_confidence=GREATEST(permit_match_confidence,0.5) WHERE hunt_id=? AND record_id=(SELECT record_id FROM permit_search_jobs WHERE job_id=?)""",
                    [job_id, hunt_id, job_id],
                )
        self.audit("permit-search-result", {"hunt_id": hunt_id, "job_id": job_id, "result_status": result_status, "matched_identifier": matched_identifier})

    def queue_owner_verifications(self, hunt_id: str, source_keys: list[str]) -> dict[str, int]:
        from .owner_verification import OWNER_VERIFICATION_SOURCES

        sources = {source.key: source for source in OWNER_VERIFICATION_SOURCES}
        selected = [sources[key] for key in dict.fromkeys(source_keys) if key in sources]
        if not selected:
            raise ValueError("Select at least one owner-verification source.")
        with self.connection(read_only=True) as connection:
            properties = connection.execute(
                """SELECT record_id,owner_name,property_address,city,state,zip FROM property_intel
                WHERE hunt_id=? AND COALESCE(owner_name,'')<>'' AND COALESCE(property_address,'')<>''
                ORDER BY property_address""",
                [hunt_id],
            ).fetchdf().to_dict("records")
            suppressions = {
                (str(record_id), str(source_key))
                for record_id, source_key in connection.execute(
                    "SELECT record_id,source_key FROM owner_verification_suppressions WHERE hunt_id=?",
                    [hunt_id],
                ).fetchall()
            }
            existing = {
                (str(record_id), str(source_key))
                for record_id, source_key in connection.execute(
                    "SELECT record_id,source_key FROM owner_verification_queue WHERE hunt_id=?",
                    [hunt_id],
                ).fetchall()
            }
        queued = refreshed = suppressed = skipped = 0
        now = utc_now()
        with self.connection() as connection:
            for record in properties:
                for source in selected:
                    if source.key == "florida_residents_directory" and str(record.get("state") or "").upper() != "FL":
                        skipped += 1
                        continue
                    key = (str(record["record_id"]), source.key)
                    is_suppressed = key in suppressions
                    status = "suppressed" if is_suppressed else "manual-review"
                    result = "SUPPRESSED" if is_suppressed else "NOT_REVIEWED"
                    connection.execute(
                        """INSERT INTO owner_verification_queue(
                        verification_id,hunt_id,record_id,source_key,source_url,owner_name,property_address,city,state,zip,
                        status,verification_result,queued_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(hunt_id,record_id,source_key) DO UPDATE SET
                        source_url=excluded.source_url,owner_name=excluded.owner_name,property_address=excluded.property_address,
                        city=excluded.city,state=excluded.state,zip=excluded.zip,
                        status=CASE WHEN owner_verification_queue.status='suppressed' THEN 'suppressed' ELSE owner_verification_queue.status END,
                        verification_result=CASE WHEN owner_verification_queue.status='suppressed' THEN 'SUPPRESSED' ELSE owner_verification_queue.verification_result END""",
                        [
                            _id("owner_verify"), hunt_id, str(record["record_id"]), source.key, source.url,
                            str(record.get("owner_name") or ""), str(record.get("property_address") or ""),
                            str(record.get("city") or ""), str(record.get("state") or ""), str(record.get("zip") or ""),
                            status, result, now,
                        ],
                    )
                    if is_suppressed:
                        suppressed += 1
                    elif key in existing:
                        refreshed += 1
                    else:
                        queued += 1
        self.audit(
            "owner-verification-queue-built",
            {"hunt_id": hunt_id, "sources": [source.key for source in selected], "queued": queued, "refreshed": refreshed, "suppressed": suppressed, "skipped": skipped},
        )
        return {"queued": queued, "refreshed": refreshed, "suppressed": suppressed, "skipped": skipped}

    def list_owner_verifications(self, hunt_id: str, limit: int = 100_000) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                """SELECT q.verification_id,q.hunt_id,q.record_id,q.source_key,q.source_url,q.owner_name,
                q.property_address,q.city,q.state,q.zip,q.status,q.verification_result,q.match_confidence,
                q.reviewed_source_url,q.analyst_notes,q.queued_at,q.reviewed_at,p.parcel_id,p.county,p.year_built
                FROM owner_verification_queue q JOIN property_intel p
                  ON p.hunt_id=q.hunt_id AND p.record_id=q.record_id
                WHERE q.hunt_id=? ORDER BY q.queued_at DESC,q.property_address,q.source_key LIMIT ?""",
                [hunt_id, max(1, int(limit))],
            ).fetchdf()
        return frame.to_dict("records")

    def list_extension_match_candidates(self, source_key: str = "", limit: int = 10_000) -> list[dict[str, Any]]:
        clauses = ["q.status<>'suppressed'"]
        parameters: list[Any] = []
        if source_key:
            clauses.append("q.source_key=?")
            parameters.append(source_key)
        parameters.append(max(1, min(100_000, int(limit))))
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                f"""SELECT q.*,p.parcel_id,p.county,p.property_type,p.owner_type,p.preferred_language,
                p.preferred_language_basis,p.preferred_language_source_url,p.preferred_language_confidence
                FROM owner_verification_queue q JOIN property_intel p
                  ON p.hunt_id=q.hunt_id AND p.record_id=q.record_id
                WHERE {' AND '.join(clauses)} ORDER BY q.queued_at DESC LIMIT ?""",
                parameters,
            ).fetchdf()
        return frame.to_dict("records")

    def update_owner_verification(
        self,
        hunt_id: str,
        verification_id: str,
        result: str,
        *,
        confidence: float = 0,
        reviewed_source_url: str = "",
        notes: str = "",
    ) -> None:
        from .owner_verification import OWNER_VERIFICATION_RESULTS, RESULT_TO_STATUS

        if result not in OWNER_VERIFICATION_RESULTS:
            raise ValueError(result)
        confidence = max(0.0, min(1.0, float(confidence)))
        status = RESULT_TO_STATUS[result]
        reviewed_at = None if result == "NOT_REVIEWED" else utc_now()
        with self.connection() as connection:
            connection.execute(
                """UPDATE owner_verification_queue SET verification_result=?,status=?,match_confidence=?,
                reviewed_source_url=?,analyst_notes=?,reviewed_at=? WHERE hunt_id=? AND verification_id=?""",
                [result, status, confidence, reviewed_source_url.strip(), notes.strip()[:4000], reviewed_at, hunt_id, verification_id],
            )
        self.audit("owner-verification-reviewed", {"hunt_id": hunt_id, "verification_id": verification_id, "result": result, "confidence": confidence})

    def suppress_owner_verification(self, hunt_id: str, record_id: str, source_key: str, reason: str) -> None:
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                """INSERT INTO owner_verification_suppressions VALUES(?,?,?,?,?,?)
                ON CONFLICT(hunt_id,record_id,source_key) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at""",
                [_id("owner_suppress"), hunt_id, record_id, source_key, reason.strip() or "Analyst suppression", now],
            )
            connection.execute(
                """UPDATE owner_verification_queue SET status='suppressed',verification_result='SUPPRESSED',
                match_confidence=0,analyst_notes=?,reviewed_at=? WHERE hunt_id=? AND record_id=? AND source_key=?""",
                [reason.strip()[:4000], now, hunt_id, record_id, source_key],
            )
        self.audit("owner-verification-suppressed", {"hunt_id": hunt_id, "record_id": record_id, "source_key": source_key, "reason": reason.strip()})

    def list_owner_suppressions(self, hunt_id: str) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                "SELECT * FROM owner_verification_suppressions WHERE hunt_id=? ORDER BY created_at DESC",
                [hunt_id],
            ).fetchdf()
        return frame.to_dict("records")

    def upsert_area_demographic_profiles(self, hunt_id: str, profiles: list[dict[str, Any]], raw_asset_id: str = "") -> int:
        now = utc_now()
        with self.connection() as connection:
            for profile in profiles:
                connection.execute(
                    """INSERT INTO area_demographic_profiles(
                    profile_id,hunt_id,geography_type,geography_name,state,state_fips,county_fips,vintage,population,
                    median_household_income,race_ethnicity_total,race_ethnicity_json,language_total,languages_json,
                    household_income_total,household_income_bands_json,source_url,raw_asset_id,retrieved_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(hunt_id,geography_type,state_fips,county_fips,vintage) DO UPDATE SET
                    geography_name=excluded.geography_name,population=excluded.population,
                    median_household_income=excluded.median_household_income,
                    race_ethnicity_total=excluded.race_ethnicity_total,race_ethnicity_json=excluded.race_ethnicity_json,
                    language_total=excluded.language_total,languages_json=excluded.languages_json,
                    household_income_total=excluded.household_income_total,
                    household_income_bands_json=excluded.household_income_bands_json,source_url=excluded.source_url,
                    raw_asset_id=excluded.raw_asset_id,retrieved_at=excluded.retrieved_at""",
                    [
                        _id("area_demo"), hunt_id, str(profile.get("geography_type") or "county"),
                        str(profile.get("geography_name") or ""), str(profile.get("state") or ""),
                        str(profile.get("state_fips") or ""), str(profile.get("county_fips") or ""), int(profile.get("vintage") or 0),
                        int(profile.get("population") or 0), int(profile.get("median_household_income") or 0),
                        int(profile.get("race_ethnicity_total") or 0), json_text(profile.get("race_ethnicity") or {}),
                        int(profile.get("language_total") or 0), json_text(profile.get("languages") or {}),
                        int(profile.get("household_income_total") or 0), json_text(profile.get("household_income_bands") or {}),
                        str(profile.get("source_url") or ""), raw_asset_id or None, now,
                    ],
                )
        self.audit("area-demographics-upserted", {"hunt_id": hunt_id, "profiles": len(profiles), "raw_asset_id": raw_asset_id})
        return len(profiles)

    def list_area_demographic_profiles(self, hunt_id: str) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                "SELECT * FROM area_demographic_profiles WHERE hunt_id=? ORDER BY vintage DESC,geography_name",
                [hunt_id],
            ).fetchdf()
        rows = frame.to_dict("records")
        for row in rows:
            row["race_ethnicity"] = json.loads(str(row.pop("race_ethnicity_json") or "{}"))
            row["languages"] = json.loads(str(row.pop("languages_json") or "{}"))
            row["household_income_bands"] = json.loads(str(row.pop("household_income_bands_json") or "{}"))
        return rows

    def create_extension_capture_signal(self, hunt_id: str, verification_id: str) -> str:
        signal_id = _id("extension_signal")
        with self.connection() as connection:
            exists = connection.execute(
                "SELECT 1 FROM owner_verification_queue WHERE hunt_id=? AND verification_id=?",
                [hunt_id, verification_id],
            ).fetchone()
            if not exists:
                raise ValueError("Unknown owner-verification task.")
            connection.execute(
                "UPDATE extension_capture_signals SET status='superseded' WHERE verification_id=? AND status='pending'",
                [verification_id],
            )
            connection.execute(
                "INSERT INTO extension_capture_signals(signal_id,hunt_id,verification_id,status,created_at) VALUES(?,?,?,?,?)",
                [signal_id, hunt_id, verification_id, "pending", utc_now()],
            )
        self.audit("extension-capture-signaled", {"hunt_id": hunt_id, "verification_id": verification_id, "signal_id": signal_id})
        return signal_id

    def consume_extension_capture_signal(self, verification_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            frame = connection.execute(
                """SELECT * FROM extension_capture_signals
                WHERE verification_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1""",
                [verification_id],
            ).fetchdf()
            if frame.empty:
                return None
            signal = frame.iloc[0].to_dict()
            connection.execute(
                "UPDATE extension_capture_signals SET status='consumed',consumed_at=? WHERE signal_id=?",
                [utc_now(), str(signal["signal_id"])],
            )
        self.audit("extension-capture-signal-consumed", {"verification_id": verification_id, "signal_id": str(signal["signal_id"])})
        return signal

    def record_extension_capture_receipt(self, values: dict[str, Any]) -> str:
        receipt_id = _id("extension_receipt")
        with self.connection() as connection:
            connection.execute(
                """INSERT INTO extension_capture_receipts(
                receipt_id,hunt_id,verification_id,record_id,source_key,page_url,page_title,candidate_name,
                candidate_address,name_similarity,address_similarity,content_sha256,observed_language,
                language_confidence,action,submitted_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                [
                    receipt_id, str(values.get("hunt_id") or ""), str(values.get("verification_id") or ""),
                    str(values.get("record_id") or ""), str(values.get("source_key") or ""),
                    str(values.get("page_url") or ""), str(values.get("page_title") or "")[:500],
                    str(values.get("candidate_name") or "")[:500], str(values.get("candidate_address") or "")[:1000],
                    max(0.0, min(1.0, float(values.get("name_similarity") or 0))),
                    max(0.0, min(1.0, float(values.get("address_similarity") or 0))),
                    str(values.get("content_sha256") or "")[:64], str(values.get("observed_language") or "")[:64],
                    max(0.0, min(1.0, float(values.get("language_confidence") or 0))),
                    str(values.get("action") or "structured-verification"), utc_now(),
                ],
            )
        self.audit("extension-capture-received", {"receipt_id": receipt_id, "hunt_id": values.get("hunt_id"), "verification_id": values.get("verification_id"), "source_key": values.get("source_key")})
        return receipt_id

    def list_extension_capture_receipts(self, hunt_id: str, record_id: str = "") -> list[dict[str, Any]]:
        clauses = ["hunt_id=?"]
        parameters: list[Any] = [hunt_id]
        if record_id:
            clauses.append("record_id=?")
            parameters.append(record_id)
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                f"SELECT * FROM extension_capture_receipts WHERE {' AND '.join(clauses)} ORDER BY submitted_at DESC",
                parameters,
            ).fetchdf()
        return frame.to_dict("records")

    def import_address_frame(self, hunt_id: str, frame: pd.DataFrame, raw_asset_id: str, *, source_key: str = "uploaded_address") -> int:
        hunt = self.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(f"Unknown property hunt: {hunt_id}")
        config = hunt["config"]
        maximum = int(config.get("maximum_results", 10_000))
        now = datetime.now(timezone.utc)
        expires = now + timedelta(days=30)
        count = 0
        with self.connection() as connection:
            for _, row in frame.head(maximum).iterrows():
                exact = {str(key): ("" if pd.isna(value) else str(value)) for key, value in row.to_dict().items()}
                address = exact.get("address", "").strip()
                if not address:
                    address = ", ".join(item for item in (exact.get("street", "").strip(), exact.get("city", "").strip(), exact.get("state", "").strip(), exact.get("zip", "").strip()) if item)
                if not address:
                    continue
                parcel_id = exact.get("parcel_id", "").strip()
                duplicate = connection.execute(
                    """SELECT record_id,provenance_json FROM property_intel
                    WHERE hunt_id=? AND ((?<>'' AND parcel_id=?) OR lower(property_address)=lower(?)) LIMIT 1""",
                    [hunt_id, parcel_id, parcel_id, address],
                ).fetchone()
                if duplicate:
                    provenance = json.loads(str(duplicate[1] or "[]"))
                    marker = {"source_key": source_key, "raw_asset_id": raw_asset_id}
                    if marker not in provenance:
                        provenance.append(marker)
                        connection.execute(
                            """UPDATE property_intel SET source_count=source_count+1,provenance_json=?,retrieved_at=?,
                            owner_name=COALESCE(NULLIF(?,''),owner_name),
                            year_built=COALESCE(?,year_built),
                            county=CASE WHEN ?<>'' THEN ? ELSE county END,
                            city=CASE WHEN ?<>'' THEN ? ELSE city END,
                            zip=CASE WHEN ?<>'' THEN ? ELSE zip END,
                            property_type=COALESCE(NULLIF(?,''),property_type)
                            WHERE hunt_id=? AND record_id=?""",
                            [
                                json_text(provenance), now, exact.get("owner_name", ""),
                                int(exact["year_built"]) if exact.get("year_built", "").isdigit() else None,
                                exact.get("county", ""), exact.get("county", ""),
                                exact.get("city", ""), exact.get("city", ""),
                                exact.get("zip", ""), exact.get("zip", ""), exact.get("property_type", ""),
                                hunt_id, str(duplicate[0]),
                            ],
                        )
                    continue
                record_id = _id("property")
                connection.execute(
                    """INSERT INTO property_intel(hunt_id,record_id,parcel_id,property_address,city,state,zip,county,municipality,latitude,longitude,property_type,year_built,owner_name,owner_type,owner_occupancy_indicator,reason_codes_json,review_status,recommended_activation,source_count,retrieved_at,record_expires_at,source_row_json,provenance_json)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    [hunt_id, record_id, parcel_id or None, address, exact.get("city", ""), exact.get("state", config.get("state", "FL")), exact.get("zip", ""), exact.get("county", config.get("county", "")), exact.get("municipality", config.get("municipality", "")), float(exact["latitude"]) if _is_number(exact.get("latitude", "")) else None, float(exact["longitude"]) if _is_number(exact.get("longitude", "")) else None, exact.get("property_type") or None, int(exact["year_built"]) if exact.get("year_built", "").isdigit() else None, exact.get("owner_name") or None, exact.get("owner_type") or None, exact.get("owner_occupancy_indicator") or None, "[]", "unreviewed", "research-only", 1, now, expires, json_text(exact), json_text([{"source_key": source_key, "raw_asset_id": raw_asset_id}])],
                )
                count += 1
        self.audit("addresses-imported", {"hunt_id": hunt_id, "rows": count, "raw_asset_id": raw_asset_id, "source_key": source_key})
        return count

    def list_properties(self, hunt_id: str, limit: int = 100_000) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute("SELECT * FROM property_intel WHERE hunt_id=? ORDER BY property_opportunity_score DESC, property_address LIMIT ?", [hunt_id, int(limit)]).fetchdf()
        records = frame.to_dict("records")
        for item in records:
            item["reason_codes"] = json.loads(str(item.pop("reason_codes_json") or "[]"))
            item["provenance"] = json.loads(str(item.pop("provenance_json") or "[]"))
        return records

    def apply_address_route(self, hunt_id: str, record_id: str, route: dict[str, Any], raw_asset_id: str) -> None:
        confidence = 1.0 if route.get("geocode_status") == "MATCHED" else 0.0
        conflicts = [] if confidence else [str(route.get("geocode_status") or "NO_MATCH")]
        with self.connection() as connection:
            row = connection.execute(
                "SELECT provenance_json FROM property_intel WHERE hunt_id=? AND record_id=?",
                [hunt_id, record_id],
            ).fetchone()
            provenance = json.loads(str(row[0] or "[]")) if row else []
            if not isinstance(provenance, list):
                provenance = [provenance]
            provenance.append({"source_key": "census_geocoder", "raw_asset_id": raw_asset_id})
            connection.execute(
                """UPDATE property_intel SET property_address=CASE WHEN ?<>'' THEN ? ELSE property_address END,
                state=CASE WHEN ?<>'' THEN ? ELSE state END,county=CASE WHEN ?<>'' THEN ? ELSE county END,
                latitude=?,longitude=?,source_count=source_count+1,
                provenance_json=? WHERE hunt_id=? AND record_id=?""",
                [route.get("matched_address", ""), route.get("matched_address", ""), route.get("state_abbreviation", ""), route.get("state_abbreviation", ""), route.get("county", ""), route.get("county", ""), route.get("latitude"), route.get("longitude"), json_text(provenance), hunt_id, record_id],
            )
            connection.execute("INSERT INTO address_matches VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [_id("address_match"), hunt_id, record_id, route.get("input_address", ""), route.get("matched_address", ""), "census-geocoder", confidence, route.get("county_fips", ""), route.get("state_fips", ""), json_text(conflicts), raw_asset_id, utc_now()])

    def upsert_events(self, hunt_id: str, frame: pd.DataFrame, raw_asset_id: str) -> int:
        count = 0
        with self.connection() as connection:
            for _, row in frame.iterrows():
                exact = {str(key): ("" if pd.isna(value) else str(value)) for key, value in row.to_dict().items()}
                event_id = exact.get("EVENT_ID") or _id("event")
                latitude = pd.to_numeric(exact.get("BEGIN_LAT", ""), errors="coerce")
                longitude = pd.to_numeric(exact.get("BEGIN_LON", ""), errors="coerce")
                event_date = pd.to_datetime(exact.get("BEGIN_DATE_TIME", ""), errors="coerce")
                connection.execute(
                    """INSERT INTO event_records VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(hunt_id,event_id) DO UPDATE SET event_type=excluded.event_type,event_date=excluded.event_date,latitude=excluded.latitude,longitude=excluded.longitude,county=excluded.county,state=excluded.state,magnitude=excluded.magnitude,source_row_json=excluded.source_row_json,raw_asset_id=excluded.raw_asset_id""",
                    [hunt_id, event_id, exact.get("EVENT_TYPE", ""), None if pd.isna(event_date) else event_date.to_pydatetime(), None if pd.isna(latitude) else float(latitude), None if pd.isna(longitude) else float(longitude), exact.get("CZ_NAME", ""), exact.get("STATE", ""), exact.get("MAGNITUDE", ""), json_text(exact), raw_asset_id],
                )
                count += 1
        return count

    def upsert_state_boundary(self, hunt_id: str, state: str, state_fips: str, geojson: dict[str, Any], raw_asset_id: str) -> None:
        with self.connection() as connection:
            connection.execute(
                """INSERT INTO state_boundaries VALUES(?,?,?,?,?,?)
                ON CONFLICT(hunt_id,state) DO UPDATE SET state_fips=excluded.state_fips,geojson=excluded.geojson,raw_asset_id=excluded.raw_asset_id,retrieved_at=excluded.retrieved_at""",
                [hunt_id, state.upper(), state_fips, json_text(geojson), raw_asset_id or None, utc_now()],
            )
        self.audit("state-boundary-upserted", {"hunt_id": hunt_id, "state": state.upper(), "raw_asset_id": raw_asset_id})

    def get_state_boundary(self, hunt_id: str) -> dict[str, Any] | None:
        with self.connection(read_only=True) as connection:
            row = connection.execute("SELECT * FROM state_boundaries WHERE hunt_id=? ORDER BY retrieved_at DESC LIMIT 1", [hunt_id]).fetchone()
            columns = [item[0] for item in connection.description] if row else []
        if not row:
            return None
        result = dict(zip(columns, row))
        result["geojson"] = json.loads(str(result.pop("geojson") or "{}"))
        return result

    def upsert_rainfall(self, hunt_id: str, frame: pd.DataFrame, raw_asset_id: str, boundary_geojson: dict[str, Any]) -> int:
        count = 0
        with self.connection() as connection:
            for _, row in frame.iterrows():
                exact = {str(key).upper(): ("" if pd.isna(value) else value) for key, value in row.to_dict().items()}
                station_id = str(exact.get("STATION") or exact.get("STATION_ID") or "").strip()
                observed = pd.to_datetime(exact.get("DATE", ""), errors="coerce")
                latitude = pd.to_numeric(exact.get("LATITUDE", ""), errors="coerce")
                longitude = pd.to_numeric(exact.get("LONGITUDE", ""), errors="coerce")
                precipitation = pd.to_numeric(exact.get("PRCP", ""), errors="coerce")
                if not station_id or pd.isna(observed) or pd.isna(latitude) or pd.isna(longitude) or pd.isna(precipitation):
                    continue
                if not _geojson_contains(boundary_geojson, float(longitude), float(latitude)):
                    continue
                connection.execute(
                    """INSERT INTO rainfall_observations VALUES(?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(hunt_id,station_id,observation_date) DO UPDATE SET station_name=excluded.station_name,latitude=excluded.latitude,longitude=excluded.longitude,precipitation_mm=excluded.precipitation_mm,attributes=excluded.attributes,raw_asset_id=excluded.raw_asset_id""",
                    [hunt_id, station_id, str(exact.get("NAME") or exact.get("STATION_NAME") or station_id), observed.date(), float(latitude), float(longitude), max(0.0, float(precipitation)), str(exact.get("PRCP_ATTRIBUTES") or ""), raw_asset_id or None],
                )
                count += 1
        self.audit("rainfall-observations-upserted", {"hunt_id": hunt_id, "rows": count, "raw_asset_id": raw_asset_id})
        return count

    def rainfall_summary(self, hunt_id: str, start: date, end: date) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                """SELECT station_id,MAX(station_name) AS station_name,AVG(latitude) AS latitude,AVG(longitude) AS longitude,
                SUM(precipitation_mm) AS total_mm,MAX(precipitation_mm) AS max_daily_mm,
                COUNT(*) FILTER (WHERE precipitation_mm > 0) AS wet_days,COUNT(*) AS observation_days,
                arg_max(observation_date, precipitation_mm) AS peak_date,
                MAX(observation_date) FILTER (WHERE precipitation_mm > 0) AS last_rain_date
                FROM rainfall_observations
                WHERE hunt_id=? AND observation_date BETWEEN ? AND ?
                GROUP BY station_id ORDER BY total_mm DESC""",
                [hunt_id, start, end],
            ).fetchdf()
        return frame.to_dict("records")

    def rainfall_timeline(self, hunt_id: str, start: date, end: date) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                """SELECT observation_date,AVG(precipitation_mm) AS mean_station_mm,MAX(precipitation_mm) AS max_station_mm,
                COUNT(*) AS reporting_stations
                FROM rainfall_observations WHERE hunt_id=? AND observation_date BETWEEN ? AND ?
                GROUP BY observation_date ORDER BY observation_date""",
                [hunt_id, start, end],
            ).fetchdf()
        return frame.to_dict("records")

    def list_events(self, hunt_id: str, start: date | None = None, end: date | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM event_records WHERE hunt_id=?"
        parameters: list[Any] = [hunt_id]
        if start:
            sql += " AND CAST(event_date AS DATE)>=?"
            parameters.append(start)
        if end:
            sql += " AND CAST(event_date AS DATE)<=?"
            parameters.append(end)
        sql += " ORDER BY event_date DESC"
        with self.connection(read_only=True) as connection:
            frame = connection.execute(sql, parameters).fetchdf()
        records = frame.to_dict("records")
        for item in records:
            try:
                item["source_row"] = json.loads(str(item.pop("source_row_json") or "{}"))
            except (TypeError, ValueError):
                item["source_row"] = {}
        return records

    def cached_map_selection(self, hunt_id: str, latitude: float, longitude: float, tolerance: float = 0.00002) -> dict[str, Any] | None:
        with self.connection(read_only=True) as connection:
            row = connection.execute(
                """SELECT * FROM map_selections WHERE hunt_id=? AND ABS(latitude-?)<=? AND ABS(longitude-?)<=?
                ORDER BY created_at DESC LIMIT 1""",
                [hunt_id, latitude, tolerance, longitude, tolerance],
            ).fetchone()
            columns = [item[0] for item in connection.description] if row else []
        if not row:
            return None
        result = dict(zip(columns, row))
        result["address"] = json.loads(str(result.pop("address_json") or "{}"))
        return result

    def record_map_selection(self, hunt_id: str, latitude: float, longitude: float, payload: dict[str, Any], raw_asset_id: str) -> dict[str, Any]:
        selection_id = _id("map_point")
        display_name = str(payload.get("display_name") or f"{latitude:.6f}, {longitude:.6f}")
        address = payload.get("address") if isinstance(payload.get("address"), dict) else {}
        with self.connection() as connection:
            connection.execute("INSERT INTO map_selections VALUES(?,?,?,?,?,?,?,?)", [selection_id, hunt_id, latitude, longitude, display_name, json_text(address), raw_asset_id or None, utc_now()])
        self.audit("map-point-resolved", {"hunt_id": hunt_id, "selection_id": selection_id, "latitude": latitude, "longitude": longitude})
        return {"selection_id": selection_id, "hunt_id": hunt_id, "latitude": latitude, "longitude": longitude, "display_name": display_name, "address": address, "raw_asset_id": raw_asset_id}

    def save_map_fence(self, hunt_id: str, name: str, geojson: dict[str, Any], case_artifact_id: str = "") -> str:
        fence_id = _id("fence")
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO map_fences VALUES(?,?,?,?,?,?)",
                [fence_id, hunt_id, name.strip() or "Explorer fence", json_text(geojson), case_artifact_id or None, utc_now()],
            )
        self.update_hunt_polygon(hunt_id, geojson)
        self.audit("map-fence-saved", {"hunt_id": hunt_id, "fence_id": fence_id, "case_artifact_id": case_artifact_id})
        return fence_id

    def list_map_fences(self, hunt_id: str, limit: int = 100) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                "SELECT * FROM map_fences WHERE hunt_id=? ORDER BY created_at DESC LIMIT ?",
                [hunt_id, max(1, int(limit))],
            ).fetchdf()
        records = frame.to_dict("records")
        for item in records:
            item["geojson"] = json.loads(str(item["geojson"] or "{}"))
        return records

    def queue_fence_properties(self, hunt_id: str, fence_id: str, geojson: dict[str, Any]) -> dict[str, int]:
        from .property_sources import florida_parcel_map_url

        records = self.list_properties(hunt_id)
        queued = incomplete = 0
        now = utc_now()
        with self.connection() as connection:
            for record in records:
                latitude, longitude = record.get("latitude"), record.get("longitude")
                if latitude is None or longitude is None or pd.isna(latitude) or pd.isna(longitude):
                    continue
                if not _geojson_contains(geojson, float(longitude), float(latitude)):
                    continue
                state = str(record.get("state") or "").upper()
                source_url = florida_parcel_map_url(float(latitude), float(longitude)) if state == "FL" else ""
                def present(value: Any) -> bool:
                    try:
                        return value is not None and not pd.isna(value) and bool(str(value).strip())
                    except (TypeError, ValueError):
                        return False
                complete = all(present(record.get(key)) for key in ("owner_name", "year_built", "county"))
                status = "ready-for-review" if complete else "captured-incomplete"
                if not complete:
                    incomplete += 1
                connection.execute(
                    """INSERT INTO geo_capture_queue VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(hunt_id,fence_id,record_id) DO UPDATE SET
                    latitude=excluded.latitude,longitude=excluded.longitude,source_url=excluded.source_url,
                    status=excluded.status,attempts=geo_capture_queue.attempts+1,last_error='',
                    started_at=excluded.started_at,completed_at=excluded.completed_at""",
                    [_id("geo_queue"), hunt_id, fence_id, str(record["record_id"]), float(latitude), float(longitude), source_url, status, 1, "", now, now, now],
                )
                queued += 1
        self.audit("geo-fence-properties-queued", {"hunt_id": hunt_id, "fence_id": fence_id, "queued": queued, "incomplete": incomplete})
        return {"queued": queued, "ready_for_review": queued - incomplete, "incomplete": incomplete}

    def list_geo_capture_queue(self, hunt_id: str, limit: int = 100_000) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            frame = connection.execute(
                """SELECT q.*,p.property_address,p.city,p.state,p.zip,p.county,p.parcel_id,p.year_built,p.owner_name,
                p.property_type,p.review_status,p.analyst_notes,p.recommended_activation
                FROM geo_capture_queue q JOIN property_intel p
                  ON p.hunt_id=q.hunt_id AND p.record_id=q.record_id
                WHERE q.hunt_id=? ORDER BY q.queued_at DESC,p.property_address LIMIT ?""",
                [hunt_id, max(1, int(limit))],
            ).fetchdf()
        return frame.to_dict("records")

    def mark_geo_queue_reviewed(self, hunt_id: str, record_id: str, review_status: str) -> None:
        status = "ready-for-review" if review_status in {"unreviewed", "needs-research"} else "reviewed"
        with self.connection() as connection:
            connection.execute(
                "UPDATE geo_capture_queue SET status=? WHERE hunt_id=? AND record_id=?",
                [status, hunt_id, record_id],
            )

    def add_map_property(self, hunt_id: str, selection: dict[str, Any]) -> str:
        hunt = self.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(hunt_id)
        address = selection.get("address") if isinstance(selection.get("address"), dict) else {}
        street = " ".join(item for item in (str(address.get("house_number") or ""), str(address.get("road") or "")) if item).strip()
        display_name = str(selection.get("display_name") or street or "Selected map location")
        city = str(address.get("city") or address.get("town") or address.get("village") or address.get("municipality") or "")
        county = str(address.get("county") or "").removesuffix(" County")
        raw_state_code = str(address.get("state_code") or hunt["state"])
        selected_state = re.split(r"[-/]", raw_state_code)[-1].upper()
        record_id = _id("property")
        now = datetime.now(timezone.utc)
        expires = now + timedelta(days=30)
        provenance = [{"source_key": "osm_nominatim", "raw_asset_id": selection.get("raw_asset_id"), "selection_id": selection.get("selection_id")}]
        with self.connection() as connection:
            duplicate = connection.execute("SELECT record_id FROM property_intel WHERE hunt_id=? AND ABS(latitude-?)<0.00002 AND ABS(longitude-?)<0.00002 LIMIT 1", [hunt_id, float(selection["latitude"]), float(selection["longitude"])]).fetchone()
            if duplicate:
                return str(duplicate[0])
            connection.execute(
                """INSERT INTO property_intel(hunt_id,record_id,property_address,city,state,zip,county,municipality,latitude,longitude,reason_codes_json,review_status,recommended_activation,source_count,retrieved_at,record_expires_at,source_row_json,provenance_json)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                [hunt_id, record_id, street or display_name, city, selected_state, str(address.get("postcode") or ""), county, str(address.get("municipality") or city), float(selection["latitude"]), float(selection["longitude"]), json_text(["MAP_SELECTED", "PROPERTY_RECORD_RESEARCH_REQUIRED"]), "needs-research", "research-only", 1, now, expires, json_text({"display_name": display_name, "address": address}), json_text(provenance)],
            )
        self.audit("map-point-added-to-property-queue", {"hunt_id": hunt_id, "record_id": record_id, "selection_id": selection.get("selection_id")})
        return record_id

    def match_nearest_events(self, hunt_id: str) -> int:
        hunt = self.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(f"Unknown property hunt: {hunt_id}")
        maximum_distance = float(hunt["config"].get("maximum_event_distance_km", 10.0))
        with self.connection(read_only=True) as connection:
            properties = connection.execute("SELECT record_id,latitude,longitude FROM property_intel WHERE hunt_id=? AND latitude IS NOT NULL AND longitude IS NOT NULL", [hunt_id]).fetchall()
            events = connection.execute("SELECT event_id,event_type,event_date,latitude,longitude FROM event_records WHERE hunt_id=? AND latitude IS NOT NULL AND longitude IS NOT NULL", [hunt_id]).fetchall()

        def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
            radius = 6371.0088
            phi1, phi2 = math.radians(lat1), math.radians(lat2)
            delta_phi = math.radians(lat2 - lat1)
            delta_lambda = math.radians(lon2 - lon1)
            a = math.sin(delta_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
            return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

        matched = 0
        with self.connection() as connection:
            for record_id, latitude, longitude in properties:
                nearest: tuple[Any, ...] | None = None
                nearest_distance = float("inf")
                for event in events:
                    candidate_distance = distance_km(float(latitude), float(longitude), float(event[3]), float(event[4]))
                    if candidate_distance < nearest_distance:
                        nearest, nearest_distance = event, candidate_distance
                if nearest and nearest_distance <= maximum_distance:
                    exposure = max(0.0, 100.0 * (1.0 - nearest_distance / maximum_distance))
                    connection.execute("UPDATE property_intel SET selected_event_id=?,selected_event_type=?,selected_event_date=?,event_distance_km=?,storm_exposure_score=? WHERE hunt_id=? AND record_id=?", [nearest[0], nearest[1], nearest[2], round(nearest_distance, 3), round(exposure, 2), hunt_id, record_id])
                    matched += 1
                else:
                    connection.execute("UPDATE property_intel SET selected_event_id=NULL,selected_event_type=NULL,selected_event_date=NULL,event_distance_km=NULL,storm_exposure_score=0 WHERE hunt_id=? AND record_id=?", [hunt_id, record_id])
        self.audit("property-events-matched", {"hunt_id": hunt_id, "properties_matched": matched, "maximum_distance_km": maximum_distance})
        return matched

    def score(self, hunt_id: str) -> int:
        hunt = self.get_hunt(hunt_id)
        if not hunt:
            raise ValueError(f"Unknown property hunt: {hunt_id}")
        config = hunt["config"]
        current_year = datetime.now(timezone.utc).year
        records = self.list_properties(hunt_id)
        with self.connection() as connection:
            for record in records:
                reasons: list[str] = []
                score = 0.0
                in_scope = True
                confidence = min(100.0, float(record.get("source_count") or 0) * 20.0)
                zip_scope = {str(item) for item in config.get("zip_codes", [])}
                if zip_scope and str(record.get("zip") or "") not in zip_scope:
                    in_scope = False
                    reasons.append("OUTSIDE_ZIP_SCOPE" if record.get("zip") else "ZIP_REVIEW_REQUIRED")
                county_scope = str(config.get("county") or "").strip().casefold()
                if county_scope and str(record.get("county") or "").strip().casefold() != county_scope:
                    in_scope = False
                    reasons.append("OUTSIDE_COUNTY_SCOPE" if record.get("county") else "COUNTY_REVIEW_REQUIRED")
                polygon = config.get("polygon_geojson")
                if polygon:
                    if record.get("latitude") is None or record.get("longitude") is None:
                        in_scope = False
                        reasons.append("POLYGON_REVIEW_REQUIRES_GEOCODE")
                    elif not _geojson_contains(polygon, float(record["longitude"]), float(record["latitude"])):
                        in_scope = False
                        reasons.append("OUTSIDE_HUNT_POLYGON")
                year_built = record.get("year_built")
                if year_built and int(year_built) <= current_year:
                    age = current_year - int(year_built)
                    minimum_age = int(config.get("minimum_building_age", 0))
                    if age >= minimum_age:
                        score += min(20.0, 10.0 + max(0, age - minimum_age) * 0.5)
                        reasons.append(f"BUILDING_AGE_{age}")
                if record.get("selected_event_id"):
                    distance = record.get("event_distance_km")
                    maximum_distance = float(config.get("maximum_event_distance_km", 10.0))
                    if distance is not None and float(distance) <= maximum_distance:
                        event_component = max(0.0, 30.0 * (1.0 - float(distance) / maximum_distance))
                        score += event_component
                        reasons.append("EVENT_WITHIN_DISTANCE")
                if record.get("roof_permit_found") is False:
                    score += 20.0
                    reasons.append("NO_ROOF_PERMIT_IN_LOOKBACK")
                if config.get("property_types"):
                    if record.get("property_type") in config["property_types"]:
                        score += 10.0
                        reasons.append("PROPERTY_TYPE_MATCH")
                    else:
                        in_scope = False
                        reasons.append("PROPERTY_TYPE_REVIEW_REQUIRED" if not record.get("property_type") else "PROPERTY_TYPE_OUTSIDE_SCOPE")
                elif record.get("property_type"):
                    score += 10.0
                    reasons.append("PROPERTY_TYPE_DOCUMENTED")
                if record.get("latitude") is not None and record.get("longitude") is not None:
                    score += 5.0
                    reasons.append("ADDRESS_GEOCODED")
                if confidence < 40:
                    reasons.append("SOURCE_CORROBORATION_REQUIRED")
                activation = "review" if in_scope and score > 0 and confidence >= 40 else "research-only"
                connection.execute("UPDATE property_intel SET property_opportunity_score=?,score_confidence=?,storm_exposure_score=CASE WHEN selected_event_id IS NULL THEN 0 ELSE storm_exposure_score END,reason_codes_json=?,recommended_activation=CASE WHEN review_status IN ('approved-for-export','excluded') THEN recommended_activation ELSE ? END,score_generated_at=? WHERE hunt_id=? AND record_id=?", [round(min(score, 100.0), 2), round(confidence, 2), json_text(reasons), activation, utc_now(), hunt_id, record["record_id"]])
        self.audit("property-scores-rebuilt", {"hunt_id": hunt_id, "records": len(records)})
        return len(records)

    def review(self, hunt_id: str, record_id: str, status: str, notes: str, activation: str) -> None:
        if status not in PROPERTY_REVIEW_STATUSES:
            raise ValueError(status)
        if activation not in PROPERTY_ACTIVATIONS:
            raise ValueError(activation)
        with self.connection() as connection:
            connection.execute("UPDATE property_intel SET review_status=?,analyst_notes=?,recommended_activation=? WHERE hunt_id=? AND record_id=?", [status, notes, activation, hunt_id, record_id])
        self.audit("property-reviewed", {"hunt_id": hunt_id, "record_id": record_id, "review_status": status, "activation": activation})

    def update_intel_fields(self, hunt_id: str, record_id: str, values: dict[str, Any]) -> None:
        allowed = {
            "parcel_id", "property_type", "year_built", "owner_name", "owner_type", "owner_occupancy_indicator",
            "preferred_language", "preferred_language_basis", "preferred_language_source_url", "preferred_language_confidence", "preferred_language_reviewed_at",
            "county", "city", "zip",
            "permit_authority", "roof_permit_found", "last_roof_permit_number", "last_roof_permit_date",
            "last_roof_permit_status", "permit_match_confidence", "imagery_status", "imagery_date",
            "observable_condition",
        }
        selected: dict[str, Any] = {}
        for key, value in values.items():
            if key not in allowed:
                continue
            try:
                selected[key] = None if pd.isna(value) else value
            except (TypeError, ValueError):
                selected[key] = value
        if not selected:
            return
        assignments = ",".join(f"{key}=?" for key in selected)
        parameters = list(selected.values()) + [hunt_id, record_id]
        with self.connection() as connection:
            connection.execute(f"UPDATE property_intel SET {assignments} WHERE hunt_id=? AND record_id=?", parameters)
        self.audit("property-intel-updated", {"hunt_id": hunt_id, "record_id": record_id, "fields": sorted(selected)})

    def export_rows(self, hunt_id: str, *, approved_only: bool = True) -> list[dict[str, Any]]:
        from .property_sources import florida_parcel_map_url

        records = self.list_properties(hunt_id)
        if approved_only:
            records = [item for item in records if item["review_status"] == "approved-for-export" and item["recommended_activation"] not in {"exclude", "research-only"}]
        omit = {"source_row_json", "provenance"}
        rows = [{key: (" | ".join(value) if key == "reason_codes" else value) for key, value in record.items() if key not in omit} for record in records]
        for row in rows:
            latitude, longitude = row.get("latitude"), row.get("longitude")
            row["florida_parcel_map"] = (
                florida_parcel_map_url(float(latitude), float(longitude))
                if str(row.get("state") or "").upper() == "FL" and latitude is not None and longitude is not None and not pd.isna(latitude) and not pd.isna(longitude)
                else ""
            )
        return rows

    def csv_bytes(self, hunt_id: str, *, approved_only: bool = True) -> bytes:
        rows = self.export_rows(hunt_id, approved_only=approved_only)
        if not rows:
            return b""
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
        return ("\ufeff" + stream.getvalue()).encode("utf-8")

    def geojson_bytes(self, hunt_id: str, *, approved_only: bool = True) -> bytes:
        rows = self.export_rows(hunt_id, approved_only=approved_only)
        features = []
        for row in rows:
            latitude, longitude = row.get("latitude"), row.get("longitude")
            if latitude is None or longitude is None or pd.isna(latitude) or pd.isna(longitude):
                continue
            properties = {key: value for key, value in row.items() if key not in {"latitude", "longitude"}}
            features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(longitude), float(latitude)]}, "properties": properties})
        return json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, default=str).encode("utf-8")

    def parquet_path(self, hunt_id: str, *, approved_only: bool = True) -> Path:
        rows = self.export_rows(hunt_id, approved_only=approved_only)
        if not rows:
            raise ValueError("No reviewed property rows are available for Parquet export.")
        destination = self.parquet_root / f"{_safe_label(hunt_id)}-reviewed.parquet"
        frame = pd.DataFrame(rows)
        with self.connection() as connection:
            connection.register("property_export_frame", frame)
            escaped_destination = str(destination).replace("'", "''")
            connection.execute(f"COPY property_export_frame TO '{escaped_destination}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        return destination

    def register_export(self, hunt_id: str, export_format: str, output_path: str, row_count: int, manifest: dict[str, Any]) -> str:
        export_id = _id("property_export")
        with self.connection() as connection:
            connection.execute("INSERT INTO export_runs VALUES(?,?,?,?,?,?,?)", [export_id, hunt_id, export_format, output_path, row_count, json_text(manifest), utc_now()])
        self.audit("property-exported", {"hunt_id": hunt_id, "export_id": export_id, "format": export_format, "rows": row_count})
        return export_id

    def record_browser_capture(self, hunt_id: str, source_key: str, case_artifact_id: str, url: str, title: str, *, screenshot_artifact_id: str = "", metadata: dict[str, Any] | None = None) -> str:
        capture_id = _id("browser_capture")
        with self.connection() as connection:
            connection.execute("INSERT INTO browser_captures VALUES(?,?,?,?,?,?,?,?,?)", [capture_id, hunt_id, source_key, case_artifact_id, screenshot_artifact_id or None, url, title, utc_now(), json_text(metadata or {})])
        self.audit("browser-dom-captured", {"hunt_id": hunt_id, "capture_id": capture_id, "source_key": source_key, "url": url})
        return capture_id

    def source_runs(self, hunt_id: str) -> list[dict[str, Any]]:
        with self.connection(read_only=True) as connection:
            return connection.execute("SELECT * FROM source_runs WHERE hunt_id=? ORDER BY started_at DESC", [hunt_id]).fetchdf().to_dict("records")
