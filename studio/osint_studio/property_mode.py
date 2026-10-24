from __future__ import annotations

import json
from dataclasses import asdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pandas as pd
import streamlit as st

from .case_store import CaseStore
from .extension_receiver import ensure_receiver_token
from .property_browser import PropertyBrowserSession
from .property_config import PROPERTY_SECRET_FIELDS, PropertySecretStore
from .owner_verification import EXCLUDED_OWNER_ATTRIBUTES, OWNER_VERIFICATION_RESULTS, OWNER_VERIFICATION_SOURCES
from .property_service import PropertyIntelService
from .property_sources import PROPERTY_SOURCES, florida_parcel_map_url, source_links, validate_public_url
from .property_store import HUNT_STRATEGIES, PROPERTY_ACTIVATIONS, PROPERTY_REVIEW_STATUSES, PropertyHuntConfig, PropertyWarehouse
from .tax_permit import FLORIDA_DOR_2025_NAL_URL, FLORIDA_DOR_2025_NAP_URL, PERMIT_RESULT_STATUSES
from .weather_hunt import US_STATES
from .weather_map_mode import render_weather_risk_map
from .geo_explorer import render_geo_explorer_map
from .ui_shell import case_context_header, prefer_active_case, remember_active_case, stage_picker


EVENT_TYPES = (
    "Hail",
    "Thunderstorm Wind",
    "Tornado",
    "Tropical Storm",
    "Hurricane (Typhoon)",
    "Heavy Rain",
    "Flash Flood",
    "Flood",
    "High Wind",
    "Lightning",
)


def _lines(value: str) -> list[str]:
    return list(dict.fromkeys(item.strip() for item in value.splitlines() if item.strip()))


def _warehouse() -> PropertyWarehouse:
    return PropertyWarehouse()


def _hunt_selector(warehouse: PropertyWarehouse, case_id: str) -> dict[str, Any] | None:
    pending = st.session_state.pop("_pending_property_hunt_id", None)
    hunts = warehouse.list_hunts(case_id)
    by_id = {str(item["hunt_id"]): item for item in hunts}
    if pending in by_id:
        st.session_state.property_hunt_id = pending
    if st.session_state.get("property_hunt_id") not in by_id:
        st.session_state.property_hunt_id = next(iter(by_id), None)
    selected = st.selectbox("Property hunt", list(by_id), format_func=lambda hunt_id: str(by_id[hunt_id]["name"]), key="property_hunt_id", placeholder="Create a property hunt")
    return warehouse.get_hunt(str(selected)) if selected else None


def _render_hunt_builder(service: PropertyIntelService, case_id: str) -> None:
    with st.expander("Create property hunt", expanded=True):
        with st.form("property_hunt_form"):
            name = st.text_input("Hunt name", value="")
            strategy = st.selectbox("Hunt strategy", HUNT_STRATEGIES, index=HUNT_STRATEGIES.index("uploaded-address"))
            location_left, location_middle, location_right = st.columns(3)
            state = location_left.selectbox("State", list(US_STATES), index=None, format_func=lambda code: f"{code} — {US_STATES[code][0]}")
            county = location_middle.text_input("County")
            municipality = location_right.text_input("Municipality")
            zip_codes = st.text_area("ZIP codes — one per line", height=80)
            subdivision = st.text_input("Subdivision")
            polygon_text = st.text_area("Map polygon GeoJSON", height=100, help="Paste a Polygon, MultiPolygon, Feature or FeatureCollection. The map-review stage will use it as the hunt boundary.")
            storm_left, storm_middle = st.columns(2)
            storm_start = storm_left.date_input("Storm start", value=None)
            storm_end = storm_middle.date_input("Storm end", value=None)
            event_types = st.multiselect("Event types", EVENT_TYPES, default=[])
            criteria_left, criteria_middle, criteria_right = st.columns(3)
            distance = criteria_left.number_input("Maximum event distance (km)", 0.1, 500.0, 10.0, 0.5)
            minimum_age = criteria_middle.number_input("Minimum building age", 0, 250, 0)
            permit_lookback = criteria_right.number_input("Permit lookback (years)", 0, 100, 15)
            property_types = st.text_area("Property types — one per line", height=80)
            maximum = st.number_input("Maximum result count", 1, 1_000_000, 10_000, 100)
            with st.expander("Jurisdiction source links"):
                appraiser_url = st.text_input("County property appraiser URL")
                permit_url = st.text_input("County or municipal permit portal URL")
                clerk_url = st.text_input("County clerk official-records URL")
            if st.form_submit_button("Create hunt", type="primary", width="stretch"):
                try:
                    if not name.strip() or not state:
                        raise ValueError("Enter a hunt name and choose a state.")
                    polygon = json.loads(polygon_text) if polygon_text.strip() else None
                    custom_source_urls = {key: value for key, value in {"county_appraiser": appraiser_url, "permit_portal": permit_url, "county_clerk": clerk_url}.items() if value.strip()}
                    custom_source_urls = {key: validate_public_url(value) for key, value in custom_source_urls.items()}
                    hunt_id = service.create_hunt(PropertyHuntConfig(name=name, case_id=case_id, strategy=strategy, state=state, county=county, municipality=municipality, zip_codes=_lines(zip_codes), subdivision=subdivision, polygon_geojson=polygon, storm_start=storm_start.isoformat() if storm_start else "", storm_end=storm_end.isoformat() if storm_end else "", event_types=event_types, maximum_event_distance_km=distance, property_types=_lines(property_types), minimum_building_age=minimum_age, permit_lookback_years=permit_lookback, maximum_results=maximum, custom_source_urls=custom_source_urls))
                    st.session_state._pending_property_hunt_id = hunt_id
                    st.rerun()
                except (ValueError, json.JSONDecodeError) as exc:
                    st.error(f"Hunt configuration is invalid: {exc}")


def _render_overview(warehouse: PropertyWarehouse, hunt: dict[str, Any] | None) -> None:
    if not hunt:
        st.info("Create a property hunt to establish a source scope and review queue.")
        return
    records = warehouse.list_properties(str(hunt["hunt_id"]))
    columns = st.columns(5)
    columns[0].metric("Properties", len(records))
    columns[1].metric("Geocoded", sum(1 for item in records if item.get("latitude") is not None))
    columns[2].metric("Qualified", sum(1 for item in records if item.get("review_status") == "qualified"))
    columns[3].metric("Export approved", sum(1 for item in records if item.get("review_status") == "approved-for-export"))
    columns[4].metric("Sources run", len(warehouse.source_runs(str(hunt["hunt_id"]))))
    st.json(hunt["config"], expanded=False)
    runs = warehouse.source_runs(str(hunt["hunt_id"]))
    if runs:
        st.markdown("#### Recent collection runs")
        st.dataframe(pd.DataFrame(runs), width="stretch", hide_index=True)


def _browser_session() -> PropertyBrowserSession | None:
    session = st.session_state.get("property_browser_session")
    if session and session.process.poll() is not None:
        st.session_state.pop("property_browser_session", None)
        return None
    return session


def _render_sources(service: PropertyIntelService, hunt: dict[str, Any] | None) -> None:
    if not hunt:
        st.info("Select a property hunt first.")
        return
    config = hunt["config"]
    records = service.warehouse.list_properties(str(hunt["hunt_id"]), 1)
    sample_address = str(records[0]["property_address"]) if records else ""
    routed_county = str(records[0].get("county") or "") if records else ""
    links = source_links(address=sample_address, county=str(config.get("county") or routed_county), state=str(config.get("state") or "FL"), custom_urls=dict(config.get("custom_source_urls") or {}))
    links_by_key = {item["key"]: item for item in links}
    source_rows = []
    for source in PROPERTY_SOURCES:
        link = links_by_key[source.key]
        source_rows.append({"source": source.label, "category": source.category, "method": source.default_method, "automation": source.automation, "credential": source.credential_field or "none", "fallback": source.fallback, "URL": link["url"]})
    st.dataframe(pd.DataFrame(source_rows), width="stretch", hide_index=True, column_config={"URL": st.column_config.LinkColumn(display_text="Open official source ↗")})

    st.markdown("#### Open separate research tabs")
    default_sources = ["census_tigerweb", "ncei_daily_precip", "noaa_storm_events", "nws_api"]
    if str(config.get("state") or "FL").upper() == "FL":
        default_sources = ["fl_dor_officials", "fl_dor_roll_gis", "fl_geospatial", *default_sources]
    selected_sources = st.multiselect("Sources", [source.key for source in PROPERTY_SOURCES], default=default_sources, format_func=lambda key: next(source.label for source in PROPERTY_SOURCES if source.key == key))
    button_columns = st.columns(3)
    for index, key in enumerate(selected_sources):
        link = links_by_key[key]
        with button_columns[index % 3]:
            if link["url"]:
                st.link_button(f"↗ {link['label']}", link["url"], width="stretch")
            else:
                st.button(link["label"], disabled=True, width="stretch", key=f"unavailable_source_{key}", help="Add the official jurisdiction URL to this hunt.")

    st.markdown("#### Managed browser and rendered-DOM capture")
    st.caption("The managed browser is local, visible and session-based. It does not bypass authentication, CAPTCHAs or access controls. Capture stores the rendered DOM and optional full-page screenshot as exact case evidence.")
    browser = _browser_session()
    controls = st.columns(3)
    if not browser:
        if controls[0].button("Start managed browser", type="primary", width="stretch"):
            try:
                st.session_state.property_browser_session = PropertyBrowserSession.start(headless=False)
                st.rerun()
            except Exception as exc:
                st.error(str(exc))
        controls[1].caption("Install Chromium once with `./run.sh --install-browser`.")
        return
    controls[0].success("Browser session ready")
    if controls[1].button("Stop browser", width="stretch"):
        browser.stop()
        st.session_state.pop("property_browser_session", None)
        st.rerun()
    county_for_resolver = str(config.get("county") or routed_county)
    if controls[2].button("Resolve county appraiser", disabled=not county_for_resolver, width="stretch"):
        with st.spinner("Resolving the official DOR county destination…"):
            result = browser.resolve_florida_appraiser(county_for_resolver)
            service.warehouse.update_hunt_source_url(str(hunt["hunt_id"]), "county_appraiser", validate_public_url(str(result["url"])))
        st.success(f"Resolved {result['county']} Property Appraiser: {result['url']}")
        st.rerun()
    manual_external_only = {"florida_residents_directory", "national_public_data"}
    managed_options = [key for key in selected_sources if key not in manual_external_only]
    managed_sources = st.multiselect("Open in managed browser", managed_options, format_func=lambda key: next(source.label for source in PROPERTY_SOURCES if source.key == key), key="property_managed_sources")
    if any(key in manual_external_only for key in selected_sources):
        st.caption("People-directory sources open only as external manual tabs and are excluded from managed DOM capture.")
    if st.button("Open selected managed tabs", disabled=not managed_sources):
        for key in managed_sources:
            url = links_by_key[key]["url"]
            if url:
                browser.open(url, key)
        st.rerun()
    try:
        tabs = browser.tabs()
    except Exception as exc:
        st.error(f"Managed browser is unavailable: {exc}")
        return
    if not tabs:
        st.info("Open at least one managed browser tab.")
        return
    selected_tab = st.selectbox("Browser tab", range(len(tabs)), format_func=lambda index: f"{index}: {tabs[index]['title'] or tabs[index]['url']} — {tabs[index]['source_key'] or 'unassigned'}")
    capture_left, capture_middle, capture_right = st.columns(3)
    screenshot = capture_left.checkbox("Capture screenshot", value=True)
    if capture_middle.button("Capture DOM into case", type="primary", width="stretch"):
        with st.spinner("Capturing rendered DOM and provenance…"):
            summary = service.capture_browser_tab(str(hunt["hunt_id"]), browser, int(selected_tab), screenshot=screenshot)
        st.success(f"Captured DOM artifact `{summary['artifact_id']}` with {summary['links']:,} absolute links.")
    if capture_right.button("Close selected tab", width="stretch"):
        browser.close_tab(int(selected_tab))
        st.rerun()


def _render_collect(service: PropertyIntelService, hunt: dict[str, Any] | None) -> None:
    if not hunt:
        st.info("Select a property hunt first.")
        return
    hunt_id = str(hunt["hunt_id"])
    st.markdown("#### Uploaded address or property file")
    uploaded = st.file_uploader("CSV containing address, or street/city/state/zip", type=["csv"], key="property_upload")
    if st.button("Archive and import CSV", type="primary", disabled=uploaded is None):
        with st.spinner("Archiving exact bytes and importing address rows…"):
            summary = service.import_upload(hunt_id, uploaded.name, uploaded.getvalue())
        st.success(f"Imported {summary['rows_imported']:,} of {summary['rows_in_file']:,} rows.")
        st.rerun()

    st.markdown("#### Automated official-source collectors")
    left, middle, right = st.columns(3)
    if left.button("Route unresolved addresses", width="stretch"):
        with st.spinner("Routing through the U.S. Census Geocoder…"):
            summary = service.route_addresses(hunt_id)
        st.success(f"Attempted {summary['attempted']:,}; matched {summary['matched']:,}; errors {summary['errors']:,}.")
        st.rerun()
    if middle.button("Pull NOAA storm history", width="stretch"):
        with st.spinner("Downloading official NOAA Storm Events bulk files…"):
            summary = service.collect_storm_history(hunt_id)
        st.success(f"Inserted {summary['events_inserted']:,} event rows from {summary['raw_assets']:,} exact bulk assets.")
    if right.button("Pull active NWS alerts", width="stretch"):
        with st.spinner("Collecting active selected-state alert GeoJSON…"):
            summary = service.collect_nws_alerts(hunt_id)
        st.success(f"Captured {summary['alerts']:,} active alerts for the hunt state.")

    with st.expander("ArcGIS FeatureServer collector"):
        feature_url = st.text_input("Feature layer URL", placeholder="https://.../FeatureServer/0")
        where = st.text_input("ArcGIS where clause", value="1=1")
        if st.button("Pull ArcGIS features", disabled=not feature_url.strip()):
            with st.spinner("Paging ArcGIS GeoJSON and preserving every response…"):
                summary = service.collect_arcgis(hunt_id, feature_url, where=where)
            st.success(f"Captured {summary['features']:,} features across {summary['pages']:,} pages; imported {summary['properties_imported']:,} addressable properties.")
            st.rerun()

    with st.expander("Direct API or bulk-file fallback"):
        downloadable_sources = [source.key for source in PROPERTY_SOURCES if source.key not in {"florida_residents_directory", "national_public_data"}]
        source_key = st.selectbox("Source", downloadable_sources, format_func=lambda key: next(source.label for source in PROPERTY_SOURCES if source.key == key), key="property_download_source")
        url = st.text_input("Exact download or API URL", key="property_download_url")
        st.caption("Use this for DOR roll/GIS files, county open-data downloads, permit APIs, clerk exports or a direct public file discovered in captured DOM.")
        if st.button("Stream into raw archive", disabled=not url.strip()):
            with st.spinner("Streaming source bytes into the content-addressed archive…"):
                summary = service.download_source(hunt_id, source_key, url)
            st.success(f"Archived {summary['bytes']:,} bytes as `{summary['artifact_id']}`.")


def _render_tax_permit_ingestion(service: PropertyIntelService, hunt: dict[str, Any] | None) -> None:
    if not hunt:
        st.info("Select a property hunt first.")
        return
    hunt_id = str(hunt["hunt_id"])
    st.markdown("#### Tax roll ingestion")
    st.caption("Upload an original DOR ZIP or an extracted CSV. Exact upload bytes are archived before chunked normalization; ZIP members are read in memory without extracting into the project tree.")
    source_left, source_right = st.columns(2)
    source_left.link_button("↗ Florida DOR 2025 NAL directory", FLORIDA_DOR_2025_NAL_URL, width="stretch")
    source_right.link_button("↗ Florida DOR 2025 NAP directory", FLORIDA_DOR_2025_NAP_URL, width="stretch")
    tax_upload = st.file_uploader("Florida DOR NAL, NAP or SDF package", type=["zip", "csv", "txt"], key="property_tax_roll_upload")
    promote_nal = st.checkbox("Promote NAL real-property rows into Property Review", value=True, help="NAP account rows remain in the tax-record warehouse and are never silently treated as house parcels.")
    if st.button("Archive and ingest tax roll", type="primary", disabled=tax_upload is None, width="stretch"):
        with st.spinner("Archiving and normalizing the tax roll in bounded chunks…"):
            summary = service.import_tax_roll(hunt_id, tax_upload.name, tax_upload.getvalue(), promote_nal=promote_nal)
        st.success(
            f"Ingested {summary['rows_imported']:,} of {summary['rows_seen']:,} rows as {', '.join(summary['roll_types']) or 'unknown'}; "
            f"promoted {summary.get('properties_promoted', 0):,} new NAL properties."
        )
        st.rerun()

    imports = service.warehouse.list_tax_imports(hunt_id)
    if imports:
        st.markdown("##### Import history")
        st.dataframe(pd.DataFrame(imports), width="stretch", hide_index=True)
    summary_rows = service.warehouse.tax_roll_summary(hunt_id)
    if summary_rows:
        st.markdown("##### Warehouse coverage")
        st.dataframe(pd.DataFrame(summary_rows), width="stretch", hide_index=True)
        roll_types = sorted({str(row["roll_type"]) for row in summary_rows})
        counties = sorted({str(row["county"]) for row in summary_rows if str(row.get("county") or "")})
        preview_left, preview_middle, preview_right = st.columns([0.3, 0.4, 0.3])
        preview_roll = preview_left.selectbox("Preview roll", ["", *roll_types], format_func=lambda value: value or "All")
        preview_county = preview_middle.selectbox("Preview county", ["", *counties], format_func=lambda value: value or "All")
        preview_limit = preview_right.number_input("Preview rows", 25, 5_000, 250, 25)
        preview = service.warehouse.list_tax_records(hunt_id, roll_type=preview_roll, county=preview_county, limit=int(preview_limit))
        if preview:
            st.dataframe(pd.DataFrame(preview), width="stretch", hide_index=True)
    st.info("`NAP` is the tangible-personal-property roll (`FILE_T=P`). Its `ACCT_ID` is retained as an account identifier, not promoted as a real-property parcel. Use `NAL` (`FILE_T=R`) for parcel, owner, building-year and permit routing.")

    st.markdown("#### Permit authority registry")
    st.caption("Seven verified parcel-capable Florida routes are seeded locally. Import the supplied JSON or CSV registry to add the complete 67-county audit and municipal override candidates.")
    registry_upload = st.file_uploader("Permit registry JSON or CSV", type=["json", "csv"], key="permit_registry_upload")
    if st.button("Archive and import permit registry", disabled=registry_upload is None, width="stretch"):
        with st.spinner("Validating public URLs and updating the local authority registry…"):
            registry_summary = service.import_permit_registry(hunt_id, registry_upload.name, registry_upload.getvalue())
        st.success(f"Imported {registry_summary['routes_imported']:,} permit-routing entries.")
        st.rerun()

    all_routes = service.warehouse.list_permit_routes(state=str(hunt["config"].get("state") or "FL"))
    if all_routes:
        route_columns = ["county", "jurisdiction", "verification_status", "parcel_lookup_label", "platform", "direct_search_url", "municipal_override_required", "routing_rule"]
        st.dataframe(pd.DataFrame(all_routes)[route_columns], width="stretch", hide_index=True, column_config={"direct_search_url": st.column_config.LinkColumn("Portal", display_text="Open ↗")})

    st.markdown("#### Build parcel permit-search queue")
    properties = service.warehouse.list_properties(hunt_id)
    routeable = [row for row in properties if str(row.get("parcel_id") or "").strip() and str(row.get("county") or "").strip()]
    if not routeable:
        st.info("Ingest a NAL roll or collect parcel records before building the permit queue.")
    else:
        property_counties = sorted({str(row["county"]) for row in routeable})
        county = st.selectbox("Property county", property_counties, key="permit_queue_county")
        county_routes = [route for route in all_routes if str(route.get("county") or "").casefold() == county.casefold()]
        route_options = {str(route["route_id"]): route for route in county_routes}
        selected_route_id = st.selectbox(
            "Confirmed authority route",
            ["", *route_options],
            format_func=lambda value: "Unresolved — hold for jurisdiction review" if not value else f"{route_options[value]['jurisdiction']} · {route_options[value]['verification_status']}",
        )
        basis_labels = {
            "unresolved": "Unresolved — do not use county fallback",
            "geometry-confirmed": "Confirmed from parcel/municipal geometry",
            "analyst-confirmed-municipality": "Analyst confirmed incorporated municipality",
            "analyst-confirmed-county": "Analyst confirmed county/unincorporated authority",
        }
        basis = st.selectbox("Jurisdiction basis", list(basis_labels), format_func=lambda value: basis_labels[value])
        confirmed = st.checkbox("I confirmed this authority applies to the selected county records", disabled=not selected_route_id or basis == "unresolved")
        queue_disabled = bool(selected_route_id) != (basis != "unresolved") or (basis != "unresolved" and not confirmed)
        if st.button("Create durable permit-search jobs", type="primary", disabled=queue_disabled, width="stretch"):
            queue_summary = service.warehouse.queue_permit_searches(hunt_id, county, route_id=selected_route_id, jurisdiction_basis=basis)
            st.success(f"Queued {queue_summary['queued']:,} parcel jobs; {queue_summary['ready_browser']:,} are ready for a browser session.")
            st.rerun()
        st.caption("A site city or mailing city is not accepted as authority confirmation. Municipal overrides must be resolved before county fallback.")

    jobs = service.warehouse.list_permit_jobs(hunt_id)
    if not jobs:
        return
    st.markdown("#### Browser queue and result capture")
    job_frame = pd.DataFrame([{**job, "query_variants": " | ".join(job.get("query_variants") or [])} for job in jobs])
    visible_job_columns = ["status", "result_status", "property_address", "owner_name", "year_built", "county", "authority", "parcel_id", "query_variants", "portal_url", "attempts"]
    st.dataframe(job_frame[visible_job_columns], width="stretch", hide_index=True, column_config={"portal_url": st.column_config.LinkColumn("Portal", display_text="Open ↗")})
    st.download_button("Download permit queue CSV", job_frame.to_csv(index=False).encode("utf-8"), file_name=f"{hunt_id}-permit-search-queue.csv", mime="text/csv", width="stretch")
    by_job = {str(job["job_id"]): job for job in jobs}
    selected_job_id = st.selectbox("Work a permit job", list(by_job), format_func=lambda value: f"{by_job[value]['property_address']} · {by_job[value]['authority'] or 'authority unresolved'}")
    selected_job = by_job[selected_job_id]
    st.code("\n".join(selected_job.get("query_variants") or [selected_job.get("raw_identifier") or ""]), language="text")
    if selected_job.get("portal_url"):
        action_left, action_right = st.columns(2)
        action_left.link_button("↗ Open portal in a new tab", str(selected_job["portal_url"]), width="stretch")
        browser = _browser_session()
        if action_right.button("Open in managed browser", disabled=browser is None, width="stretch", help="Start the managed browser under Sources & Browser first."):
            browser.open(str(selected_job["portal_url"]), "permit_portal")
            st.success("Permit portal opened in the managed browser. Use the exact variants above and capture the rendered DOM after searching.")
    with st.form("permit_job_result_form"):
        result_status = st.selectbox("Result", PERMIT_RESULT_STATUSES, index=PERMIT_RESULT_STATUSES.index(str(selected_job.get("result_status") or "NOT_SEARCHED")))
        matched_identifier = st.text_input("Exact identifier that produced the match", value=str(selected_job.get("matched_identifier") or ""))
        result_url = st.text_input("Result URL", value=str(selected_job.get("result_url") or ""))
        capture_id = st.text_input("DOM/screenshot capture ID", value=str(selected_job.get("capture_id") or ""))
        notes = st.text_area("Analyst notes", value=str(selected_job.get("analyst_notes") or ""))
        if st.form_submit_button("Save permit-search result", type="primary", width="stretch"):
            safe_result_url = validate_public_url(result_url) if result_url.strip() else ""
            service.warehouse.update_permit_job_result(hunt_id, selected_job_id, result_status, matched_identifier=matched_identifier, result_url=safe_result_url, capture_id=capture_id, notes=notes)
            st.success("Permit-search result saved.")
            st.rerun()
    st.warning("An empty portal response must be recorded as `NO_ACCESSIBLE_MATCH`. It is not evidence that the parcel has no permits, and it never sets `roof_permit_found=False`.")


def _review_frame(records: list[dict[str, Any]]) -> pd.DataFrame:
    rows = []
    for item in records:
        parcel_map_url = (
            florida_parcel_map_url(float(item["latitude"]), float(item["longitude"]))
            if str(item.get("state") or "").upper() == "FL" and not pd.isna(item.get("latitude")) and not pd.isna(item.get("longitude"))
            else ""
        )
        rows.append({"record_id": item["record_id"], "property_address": item["property_address"], "city": item["city"], "county": item["county"], "zip": item["zip"], "parcel_id": item["parcel_id"], "year_built": item["year_built"], "property_type": item["property_type"], "owner_name": item.get("owner_name"), "owner_type": item["owner_type"], "owner_occupancy_indicator": item["owner_occupancy_indicator"], "latitude": item["latitude"], "longitude": item["longitude"], "florida_parcel_map": parcel_map_url, "permit_authority": item["permit_authority"], "roof_permit_found": item["roof_permit_found"], "last_roof_permit_number": item["last_roof_permit_number"], "last_roof_permit_date": item["last_roof_permit_date"], "last_roof_permit_status": item["last_roof_permit_status"], "permit_match_confidence": item["permit_match_confidence"], "selected_event_type": item["selected_event_type"], "event_distance_km": item["event_distance_km"], "imagery_status": item["imagery_status"], "imagery_date": item["imagery_date"], "observable_condition": item["observable_condition"], "score": item["property_opportunity_score"], "confidence": item["score_confidence"], "sources": item["source_count"], "reasons": " | ".join(item["reason_codes"]), "review_status": item["review_status"], "recommended_activation": item["recommended_activation"], "analyst_notes": item["analyst_notes"]})
    return pd.DataFrame(rows)


def _render_review(service: PropertyIntelService, hunt: dict[str, Any] | None) -> None:
    if not hunt:
        st.info("Select a property hunt first.")
        return
    hunt_id = str(hunt["hunt_id"])
    records = service.warehouse.list_properties(hunt_id)
    if not records:
        st.info("Collect or upload property records first.")
        return
    if st.button("Match nearest events and rebuild scores", type="primary"):
        matched = service.warehouse.match_nearest_events(hunt_id)
        count = service.warehouse.score(hunt_id)
        st.success(f"Matched events to {matched:,} properties and scored {count:,} records.")
        st.rerun()
    mapped = pd.DataFrame([{"lat": item["latitude"], "lon": item["longitude"], "property_address": item["property_address"], "score": item["property_opportunity_score"]} for item in records if item.get("latitude") is not None and item.get("longitude") is not None])
    if not mapped.empty:
        st.map(mapped, latitude="lat", longitude="lon", size=6, color="#7C3AED")
    frame = _review_frame(records)
    editable_fields = {"parcel_id", "year_built", "property_type", "owner_name", "owner_type", "owner_occupancy_indicator", "county", "permit_authority", "roof_permit_found", "last_roof_permit_number", "last_roof_permit_date", "last_roof_permit_status", "permit_match_confidence", "imagery_status", "imagery_date", "observable_condition", "review_status", "recommended_activation", "analyst_notes"}
    edited = st.data_editor(frame, width="stretch", hide_index=True, disabled=[column for column in frame.columns if column not in editable_fields], column_config={"florida_parcel_map": st.column_config.LinkColumn("Florida parcel map", display_text="Open parcel ↗"), "review_status": st.column_config.SelectboxColumn(options=list(PROPERTY_REVIEW_STATUSES), required=True), "recommended_activation": st.column_config.SelectboxColumn(options=list(PROPERTY_ACTIVATIONS), required=True), "analyst_notes": st.column_config.TextColumn(width="large"), "observable_condition": st.column_config.TextColumn(width="large"), "permit_match_confidence": st.column_config.NumberColumn(min_value=0.0, max_value=1.0, step=0.05), "reasons": st.column_config.TextColumn(width="large")}, key="property_review_editor")
    if st.button("Save property review decisions", type="primary"):
        for row in edited.to_dict("records"):
            service.warehouse.update_intel_fields(hunt_id, str(row["record_id"]), {key: row.get(key) for key in editable_fields})
            service.warehouse.review(hunt_id, str(row["record_id"]), str(row["review_status"]), str(row["analyst_notes"]), str(row["recommended_activation"]))
        st.success("Review decisions saved.")
        st.rerun()


def _render_owner_verification(service: PropertyIntelService, hunt: dict[str, Any] | None) -> None:
    st.subheader("Unified property, owner & market report")
    st.caption("Review parcel facts, owner-of-record corroboration, observed language evidence and geographic Census/ACS market context in one workflow.")
    if not hunt:
        st.info("Select a property hunt first.")
        return
    hunt_id = str(hunt["hunt_id"])
    records = service.warehouse.list_properties(hunt_id)
    eligible = [record for record in records if str(record.get("owner_name") or "").strip() and str(record.get("property_address") or "").strip()]
    if not eligible:
        st.info("Ingest a tax roll or add an owner-of-record name and property address before building this review queue.")
        return

    profile_left, profile_right = st.columns((2, 1))
    existing_profiles = service.warehouse.list_area_demographic_profiles(hunt_id)
    profile_left.caption(f"Area context: 2024 ACS 5-year county estimates · {len(existing_profiles):,} county profiles cached locally.")
    has_census_key = bool(service.secrets.effective().get("census_api_key", "").strip())
    if profile_right.button("Refresh ACS market context", disabled=not has_census_key, width="stretch", key=f"refresh_acs_{hunt_id}"):
        try:
            summary = service.collect_area_demographics(hunt_id, year=2024)
            st.success(f"Cached {summary['profiles']:,} county market profiles for {summary['state']}.")
            st.rerun()
        except Exception as exc:
            st.error(f"ACS collection failed: {type(exc).__name__}: {exc}")
    if not has_census_key:
        st.info("Add a free Census Data API key under API Keys to enable county aggregate market context.")

    source_map = {source.key: source for source in OWNER_VERIFICATION_SOURCES}
    with st.expander("Build local review queue", expanded=not bool(service.warehouse.list_owner_verifications(hunt_id, 1))):
        selected_sources = st.multiselect(
            "Manual verification sources",
            list(source_map),
            default=["florida_residents_directory", "national_public_data"] if str(hunt["config"].get("state") or "").upper() == "FL" else ["national_public_data"],
            format_func=lambda key: source_map[key].label,
            key=f"owner_verify_sources_{hunt_id}",
        )
        st.caption(f"{len(eligible):,} property records have both an owner name and property address. Each queued item is opened and reviewed individually by the analyst.")
        if st.button("Build owner-verification queue", type="primary", disabled=not selected_sources, width="stretch", key=f"owner_verify_queue_{hunt_id}"):
            summary = service.warehouse.queue_owner_verifications(hunt_id, selected_sources)
            st.success(f"Queued {summary['queued']:,} new tasks and refreshed {summary['refreshed']:,}; {summary['suppressed']:,} remain suppressed.")
            st.rerun()

    tasks = service.warehouse.list_owner_verifications(hunt_id)
    if not tasks:
        return
    metric_columns = st.columns(3)
    metric_columns[0].metric("Manual review", sum(1 for task in tasks if task["status"] == "manual-review"))
    metric_columns[1].metric("Verified", sum(1 for task in tasks if task["status"] == "verified"))
    metric_columns[2].metric("Conflicts", sum(1 for task in tasks if task["status"] == "conflict"))

    filter_left, filter_right = st.columns(2)
    statuses = sorted({str(task["status"]) for task in tasks})
    status_filter = filter_left.multiselect("Status", statuses, default=statuses, key=f"owner_verify_status_{hunt_id}")
    present_sources = sorted({str(task["source_key"]) for task in tasks})
    source_filter = filter_right.multiselect(
        "Source",
        present_sources,
        default=present_sources,
        format_func=lambda key: source_map[key].label if key in source_map else key,
        key=f"owner_verify_source_filter_{hunt_id}",
    )
    filtered = [task for task in tasks if str(task["status"]) in status_filter and str(task["source_key"]) in source_filter]
    if not filtered:
        st.info("No verification tasks match the current filters.")
        return
    table = pd.DataFrame(
        [
            {
                "status": task["status"],
                "result": task["verification_result"],
                "owner_name": task["owner_name"],
                "property_address": task["property_address"],
                "city": task["city"],
                "state": task["state"],
                "zip": task["zip"],
                "county": task["county"],
                "parcel_id": task["parcel_id"],
                "source": source_map[str(task["source_key"])].label if str(task["source_key"]) in source_map else task["source_key"],
                "confidence": task["match_confidence"],
                "source_url": task["source_url"],
            }
            for task in filtered
        ]
    )
    st.dataframe(
        table,
        width="stretch",
        hide_index=True,
        column_config={"source_url": st.column_config.LinkColumn("Manual source", display_text="Open ↗"), "confidence": st.column_config.NumberColumn(format="%.2f")},
    )

    by_id = {str(task["verification_id"]): task for task in filtered}
    selected_id = st.selectbox(
        "Review owner and property",
        list(by_id),
        format_func=lambda value: f"{by_id[value]['owner_name']} · {by_id[value]['property_address']} · {source_map[str(by_id[value]['source_key'])].label}",
        key=f"owner_verify_task_{hunt_id}",
    )
    task = by_id[selected_id]
    source = source_map[str(task["source_key"])]
    property_by_id = {str(record["record_id"]): record for record in records}
    property_record = property_by_id[str(task["record_id"])]
    st.markdown("#### Selected property report")
    property_facts = pd.DataFrame(
        [
            {"field": "Owner of record", "value": property_record.get("owner_name") or ""},
            {"field": "Property address", "value": property_record.get("property_address") or ""},
            {"field": "Parcel", "value": property_record.get("parcel_id") or ""},
            {"field": "County", "value": property_record.get("county") or ""},
            {"field": "Year built", "value": property_record.get("year_built") or ""},
            {"field": "Property type", "value": property_record.get("property_type") or ""},
            {"field": "Permit authority", "value": property_record.get("permit_authority") or ""},
            {"field": "Storm exposure score", "value": property_record.get("storm_exposure_score") or 0},
        ]
    )
    st.dataframe(property_facts, width="stretch", hide_index=True)
    st.code(f"Owner of record: {task['owner_name']}\nProperty address: {task['property_address']}, {task['city']}, {task['state']} {task['zip']}", language="text")
    st.link_button(f"Open {source.label} in a new tab", source.url, width="stretch")
    st.caption(source.policy_note)

    with st.expander("Firefox structured receiver", expanded=False):
        st.code("./run.sh --with-receiver", language="bash")
        st.caption("Load `firefox_extension/manifest.json` as a temporary Firefox add-on, then configure the loopback URL and token. Raw DOM and full page text are rejected by the receiver.")
        receiver_token = ensure_receiver_token()
        reveal_receiver_token = st.checkbox("Reveal extension token", value=False, key=f"reveal_receiver_token_{hunt_id}")
        st.text_input(
            "Extension token",
            value=receiver_token if reveal_receiver_token else "",
            placeholder="Token is stored locally; enable reveal to copy it",
            type="default" if reveal_receiver_token else "password",
            disabled=not reveal_receiver_token,
            key=f"receiver_token_{hunt_id}",
        )
        if st.button("Signal Firefox to re-scan and submit this row", type="primary", width="stretch", key=f"signal_firefox_{selected_id}"):
            signal_id = service.warehouse.create_extension_capture_signal(hunt_id, selected_id)
            st.success(f"Signal `{signal_id}` is waiting. Keep the add-on popup open in Wait for Studio signal mode.")

    current_result = str(task.get("verification_result") or "NOT_REVIEWED")
    with st.form(f"owner_verification_result_{selected_id}"):
        result = st.selectbox("Verification result", OWNER_VERIFICATION_RESULTS, index=OWNER_VERIFICATION_RESULTS.index(current_result) if current_result in OWNER_VERIFICATION_RESULTS else 0)
        confidence = st.slider("Match confidence", 0.0, 1.0, float(task.get("match_confidence") or 0), 0.05)
        reviewed_url = st.text_input("Exact reviewed page URL (optional)", value=str(task.get("reviewed_source_url") or ""))
        notes = st.text_area("Verification notes", value=str(task.get("analyst_notes") or ""), help="Record only evidence needed to explain the name/address match or conflict.")
        acknowledged = st.checkbox("Notes contain no excluded sensitive-person categories")
        if st.form_submit_button("Save verification", type="primary", disabled=not acknowledged, width="stretch"):
            safe_url = validate_public_url(reviewed_url) if reviewed_url.strip() else ""
            service.warehouse.update_owner_verification(hunt_id, selected_id, result, confidence=confidence, reviewed_source_url=safe_url, notes=notes)
            st.success("Owner verification saved.")
            st.rerun()

    st.markdown("#### Language evidence")
    language_basis_options = ("unknown", "self-declared", "consent-record", "observed-public-profile-language")
    current_basis = str(property_record.get("preferred_language_basis") or "unknown")
    with st.form(f"property_language_evidence_{task['record_id']}"):
        preferred_language = st.text_input("Language", value=str(property_record.get("preferred_language") or ""), help="Use the language explicitly stated by the person, captured with consent, or observed on an identity-matched public profile.")
        language_basis = st.selectbox("Evidence basis", language_basis_options, index=language_basis_options.index(current_basis) if current_basis in language_basis_options else 0)
        language_source_url = st.text_input("Evidence URL (required for public-profile observation)", value=str(property_record.get("preferred_language_source_url") or ""))
        language_confidence = st.slider("Language-evidence confidence", 0.0, 1.0, float(property_record.get("preferred_language_confidence") or 0), 0.05)
        if st.form_submit_button("Save language evidence", width="stretch"):
            if language_basis == "observed-public-profile-language" and not language_source_url.strip():
                st.error("A public-profile observation requires the exact evidence URL.")
            elif language_basis != "unknown" and not preferred_language.strip():
                st.error("Enter the observed or declared language.")
            else:
                safe_language_url = validate_public_url(language_source_url) if language_source_url.strip() else ""
                service.warehouse.update_intel_fields(
                    hunt_id,
                    str(task["record_id"]),
                    {
                        "preferred_language": preferred_language.strip() or None,
                        "preferred_language_basis": language_basis,
                        "preferred_language_source_url": safe_language_url or None,
                        "preferred_language_confidence": language_confidence,
                        "preferred_language_reviewed_at": pd.Timestamp.utcnow().isoformat() if language_basis != "unknown" else None,
                    },
                )
                st.success("Language evidence saved to this property report.")
                st.rerun()
    st.caption("Observed profile language is evidence about the public profile content, not proof of a person's preferred outreach language. Never infer it from race, ethnicity, surname or neighborhood composition.")

    profiles = service.warehouse.list_area_demographic_profiles(hunt_id)
    county_name = str(property_record.get("county") or "").strip().casefold()
    profile = next(
        (
            item for item in profiles
            if str(item.get("geography_name") or "").split(" County", 1)[0].strip().casefold() == county_name
        ),
        None,
    )
    if profile:
        st.markdown("#### Area market context")
        st.caption(f"{profile['geography_name']} · ACS {profile['vintage']} 5-year estimates · aggregate geography, not an individual or household claim.")
        overview = pd.DataFrame(
            [
                {"measure": "Population", "estimate": f"{int(profile['population']):,}"},
                {"measure": "Median household income", "estimate": f"${int(profile['median_household_income']):,}"},
                {"measure": "Language population (age 5+)", "estimate": f"{int(profile['language_total']):,}"},
                {"measure": "Households in income distribution", "estimate": f"{int(profile['household_income_total']):,}"},
            ]
        )
        st.dataframe(overview, width="stretch", hide_index=True)

        def distribution_frame(values: dict[str, int], total: int) -> pd.DataFrame:
            return pd.DataFrame(
                [
                    {"category": label, "estimate": int(count), "share": (float(count) / total if total else 0.0)}
                    for label, count in sorted(values.items(), key=lambda item: int(item[1]), reverse=True)
                ]
            )

        st.markdown("##### Languages")
        st.dataframe(distribution_frame(profile["languages"], int(profile["language_total"])), width="stretch", hide_index=True, column_config={"share": st.column_config.NumberColumn(format="%.1%%")})
        st.markdown("##### Race & ethnicity")
        st.dataframe(distribution_frame(profile["race_ethnicity"], int(profile["race_ethnicity_total"])), width="stretch", hide_index=True, column_config={"share": st.column_config.NumberColumn(format="%.1%%")})
        st.markdown("##### Household income")
        st.dataframe(distribution_frame(profile["household_income_bands"], int(profile["household_income_total"])), width="stretch", hide_index=True, column_config={"share": st.column_config.NumberColumn(format="%.1%%")})
    else:
        st.info("No cached ACS county profile matches this property. Refresh market context after configuring the Census API key.")

    record_tasks = [
        {
            "source": source_map[str(item["source_key"])].label if str(item["source_key"]) in source_map else item["source_key"],
            "result": item["verification_result"],
            "confidence": item["match_confidence"],
            "reviewed_source_url": item["reviewed_source_url"],
            "reviewed_at": item["reviewed_at"],
        }
        for item in tasks if str(item["record_id"]) == str(task["record_id"])
    ]
    safe_property = {key: value for key, value in property_record.items() if key not in {"source_row_json", "provenance"}}
    extension_receipts = service.warehouse.list_extension_capture_receipts(hunt_id, str(task["record_id"]))
    if extension_receipts:
        st.markdown("#### Firefox capture receipts")
        receipt_columns = ["submitted_at", "action", "source_key", "name_similarity", "address_similarity", "observed_language", "language_confidence", "page_url"]
        st.dataframe(pd.DataFrame(extension_receipts)[receipt_columns], width="stretch", hide_index=True, column_config={"page_url": st.column_config.LinkColumn("Evidence page", display_text="Open ↗")})
    unified_report = {
        "report_type": "property-owner-market-context",
        "hunt_id": hunt_id,
        "record_id": task["record_id"],
        "property": safe_property,
        "owner_verification": record_tasks,
        "extension_capture_receipts": extension_receipts,
        "area_market_context": profile,
        "area_context_notice": "Aggregate Census/ACS geography; not an individual or household attribute claim.",
    }
    st.download_button(
        "Download unified report JSON",
        json.dumps(unified_report, ensure_ascii=False, indent=2, default=str).encode("utf-8"),
        file_name=f"{task['record_id']}-unified-property-report.json",
        mime="application/json",
        width="stretch",
    )

    with st.expander("Suppress this source lookup"):
        suppression_reason = st.text_input("Suppression reason", key=f"owner_suppress_reason_{selected_id}")
        if st.button("Suppress task", disabled=not suppression_reason.strip(), key=f"owner_suppress_{selected_id}"):
            service.warehouse.suppress_owner_verification(hunt_id, str(task["record_id"]), str(task["source_key"]), suppression_reason)
            st.success("Task suppressed. Rebuilding the queue will preserve this decision.")
            st.rerun()

    st.warning("Excluded from named-person storage and export: " + "; ".join(EXCLUDED_OWNER_ATTRIBUTES) + ". Race/ethnicity and income are retained only as labeled Census/ACS geographic estimates in this unified report.")


def _render_export(service: PropertyIntelService, hunt: dict[str, Any] | None) -> None:
    if not hunt:
        st.info("Select a property hunt first.")
        return
    hunt_id = str(hunt["hunt_id"])
    rows = service.warehouse.export_rows(hunt_id, approved_only=True)
    st.metric("Approved, activation-ready rows", len(rows))
    if not rows:
        st.info("Only reviewed `approved-for-export` rows with campaign or consent-gated activation are exported.")
        return
    csv_data = service.warehouse.csv_bytes(hunt_id)
    geojson_data = service.warehouse.geojson_bytes(hunt_id)
    left, middle, right = st.columns(3)
    if left.download_button("Download reviewed CSV", csv_data, file_name=f"{hunt['name']}-reviewed.csv", mime="text/csv", type="primary", width="stretch"):
        service.warehouse.register_export(hunt_id, "csv", "browser-download", len(rows), {"approved_only": True, "fields": list(rows[0])})
    if middle.download_button("Download reviewed GeoJSON", geojson_data, file_name=f"{hunt['name']}-reviewed.geojson", mime="application/geo+json", width="stretch"):
        service.warehouse.register_export(hunt_id, "geojson", "browser-download", len(json.loads(geojson_data)["features"]), {"approved_only": True})
    if right.button("Build reviewed Parquet", width="stretch"):
        path = service.warehouse.parquet_path(hunt_id)
        service.warehouse.register_export(hunt_id, "parquet", str(path), len(rows), {"approved_only": True})
        st.session_state.property_parquet_path = str(path)
    parquet_path = Path(st.session_state.get("property_parquet_path", ""))
    if parquet_path.is_file():
        st.download_button("Download reviewed Parquet", parquet_path.read_bytes(), file_name=parquet_path.name, mime="application/octet-stream")


def _render_settings(secret_store: PropertySecretStore) -> None:
    current = secret_store.effective()
    reveal = st.checkbox("Reveal configured values", value=False, help="Values remain on this workstation. Reveal is explicit so keys can be visually verified when rotating them.")
    st.caption(f"Local credential file: `{secret_store.path}` · environment variables take precedence over file values.")
    entered: dict[str, str] = {}
    with st.form("property_credentials_form"):
        for logical_name, env_name in PROPERTY_SECRET_FIELDS.items():
            value = current.get(logical_name, "")
            label = env_name.replace("OSINT_", "").replace("_", " ").title()
            entered[logical_name] = st.text_input(label, value=value if reveal else "", type="default" if reveal else "password", placeholder=secret_store.masked(value), help=env_name)
        clear = st.multiselect("Clear stored values", list(PROPERTY_SECRET_FIELDS), format_func=lambda key: PROPERTY_SECRET_FIELDS[key])
        if st.form_submit_button("Save local source configuration", type="primary", width="stretch"):
            updates = {key: value for key, value in entered.items() if value}
            updates.update({key: "" for key in clear})
            secret_store.save(updates)
            st.success("Local property-source configuration saved with private file permissions.")
            st.rerun()
    st.info("The Census Data API uses a free key for ACS market profiles. NOAA/NCEI precipitation, NOAA Storm Events, NWS alerts, TIGERweb and analyst-triggered OpenStreetMap address resolution do not require API keys. ArcGIS, county appraiser, permit and clerk credentials remain optional.")


def render_tax_permit_studio(store: CaseStore) -> None:
    st.title("Tax & Permit Studio")
    st.caption("Ingest public tax rolls, enrich real-property records, resolve permitting authority and work durable parcel-search jobs.")
    warehouse = _warehouse()
    cases = store.list_cases(250)
    eligible = [case for case in cases if warehouse.list_hunts(str(case["id"]))]
    if not eligible:
        st.info("Start a Geo Explorer workspace first; it creates the case and property hunt used by this ingestion unit.")
        return
    by_case = {str(case["id"]): case for case in eligible}
    prefer_active_case(list(by_case), local_key="tax_permit_case_id")
    case_id = st.selectbox("Workspace", list(by_case), format_func=lambda value: str(by_case[value]["name"]), key="tax_permit_case_id")
    remember_active_case(str(case_id))
    hunts = warehouse.list_hunts(case_id)
    by_hunt = {str(hunt["hunt_id"]): hunt for hunt in hunts}
    if st.session_state.get("tax_permit_hunt_id") not in by_hunt:
        st.session_state.tax_permit_hunt_id = next(iter(by_hunt), None)
    hunt_id = st.selectbox("Property hunt", list(by_hunt), format_func=lambda value: f"{by_hunt[value]['name']} · {by_hunt[value]['state']}", key="tax_permit_hunt_id")
    hunt = warehouse.get_hunt(str(hunt_id)) if hunt_id else None
    service = PropertyIntelService(store, warehouse)
    case_context_header(by_case[case_id], workspace="Tax & Permits", detail=f"Hunt: {hunt['name'] if hunt else hunt_id}")
    view = stage_picker("Tax and permit stage", ("Tax & Permits", "Unified Property Report"), key="tax_permit_stage")
    if view == "Tax & Permits":
        _render_tax_permit_ingestion(service, hunt)
    else:
        _render_owner_verification(service, hunt)


def render_property_intel(store: CaseStore, case: dict[str, object] | None) -> None:
    st.title("Property Market Intel")
    st.caption("State-scale weather risk discovery with Florida-first parcel adapters, interactive address selection, exact local evidence and reviewed activation exports.")
    if not case:
        st.info("Create or select a Research Mode case first.")
        return
    warehouse = _warehouse()
    service = PropertyIntelService(store, warehouse)
    hunt = _hunt_selector(warehouse, str(case["id"]))
    view = stage_picker(
        "Property stage",
        ("Scope", "Explore", "Collect", "Enrich", "Review", "Export", "Settings"),
        key="property_workspace_stage",
    )
    if view == "Scope":
        _render_overview(warehouse, hunt)
        _render_hunt_builder(service, str(case["id"]))
    elif view == "Explore":
        explore_view = stage_picker("Explorer view", ("Map & parcels", "Weather risk"), key="property_explore_view")
        if explore_view == "Map & parcels":
            if hunt:
                render_geo_explorer_map(service, hunt)
            else:
                st.info("Create or select a property hunt first.")
        else:
            if hunt:
                render_weather_risk_map(service, hunt)
            else:
                st.info("Create or select a property hunt first.")
    elif view == "Collect":
        _render_sources(service, hunt)
        _render_collect(service, hunt)
    elif view == "Enrich":
        _render_tax_permit_ingestion(service, hunt)
        _render_owner_verification(service, hunt)
    elif view == "Review":
        _render_review(service, hunt)
    elif view == "Export":
        _render_export(service, hunt)
    else:
        _render_settings(service.secrets)
