from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

import folium
import pandas as pd
import streamlit as st
from streamlit_folium import st_folium

from .case_store import CaseStore
from .property_service import PropertyIntelService
from .property_sources import (
    FLORIDA_STATEWIDE_CADASTRAL_LAYER_URL,
    build_public_session,
    census_geocode,
    source_links,
    validate_public_url,
)
from .property_store import PROPERTY_ACTIVATIONS, PROPERTY_REVIEW_STATUSES, PropertyHuntConfig, PropertyWarehouse
from .weather_hunt import US_STATES, state_name
from .weather_map_mode import _build_map, _render_point_actions
from .ui_shell import ACTIVE_CASE_KEY, case_context_header, prefer_active_case, remember_active_case, stage_picker


def _state_label(code: str) -> str:
    return f"{code} — {US_STATES[code][0]}"


def _new_explorer(
    store: CaseStore,
    service: PropertyIntelService,
    name: str,
    state: str,
    maximum_results: int,
) -> tuple[str, str]:
    today = date.today()
    case_id = store.create_case(
        name.strip() or f"{state} property explorer",
        mode="property-research",
        objective="Interactive parcel, property, permit and storm-risk exploration.",
        metadata={"workspace": "geo-explorer", "state": state},
    )
    hunt_id = service.create_hunt(
        PropertyHuntConfig(
            name=name.strip() or f"{state} Geo Explorer",
            case_id=case_id,
            strategy="state-weather",
            state=state,
            storm_start="",
            storm_end="",
            event_types=[],
            maximum_results=maximum_results,
        )
    )
    return case_id, hunt_id


def _quick_start(store: CaseStore, service: PropertyIntelService, *, expanded: bool) -> None:
    with st.expander("Start a new explorer", expanded=expanded):
        with st.form("geo_explorer_quick_start"):
            left, right = st.columns([0.62, 0.38])
            name = left.text_input("Workspace name", value="")
            states = list(US_STATES)
            state = right.selectbox("State", states, index=None, format_func=_state_label)
            maximum = st.number_input("Maximum parcel/property results", 100, 250_000, 10_000, 100)
            submitted = st.form_submit_button("Start exploring", type="primary", width="stretch")
        if submitted:
            if not name.strip() or not state:
                st.warning("Enter a workspace name and choose a state.")
                return
            case_id, hunt_id = _new_explorer(store, service, name, state, int(maximum))
            st.session_state.geo_case_id = case_id
            st.session_state.geo_hunt_id = hunt_id
            st.session_state.research_case_id = case_id
            st.session_state.property_hunt_id = hunt_id
            remember_active_case(case_id)
            try:
                with st.spinner("Loading the official state boundary…"):
                    service.collect_state_boundary(hunt_id)
            except Exception as exc:
                st.session_state.geo_boundary_error = f"{type(exc).__name__}: {exc}"
            st.rerun()


def _selectors(store: CaseStore, warehouse: PropertyWarehouse) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    cases = store.list_cases(250)
    by_case = {str(item["id"]): item for item in cases}
    property_case_ids = [case_id for case_id in by_case if warehouse.list_hunts(case_id)]
    active_case_id = str(st.session_state.get(ACTIVE_CASE_KEY) or "")
    preferred_ids = ([active_case_id] if active_case_id in by_case else []) + [
        case_id for case_id in property_case_ids if case_id != active_case_id
    ]
    preferred_ids = preferred_ids or list(by_case)
    prefer_active_case(preferred_ids, local_key="geo_case_id")
    case_id = st.selectbox(
        "Explorer workspace",
        list(by_case),
        format_func=lambda value: str(by_case[value]["name"]),
        key="geo_case_id",
        placeholder="Start a workspace",
    )
    case = by_case.get(str(case_id)) if case_id else None
    remember_active_case(str(case_id) if case_id else None)
    if not case:
        return None, None
    hunts = warehouse.list_hunts(str(case["id"]))
    by_hunt = {str(item["hunt_id"]): item for item in hunts}
    if st.session_state.get("geo_hunt_id") not in by_hunt:
        st.session_state.geo_hunt_id = next(iter(by_hunt), None)
    hunt_id = st.selectbox(
        "Map hunt",
        list(by_hunt),
        format_func=lambda value: f"{by_hunt[value]['name']} · {by_hunt[value]['state']}",
        key="geo_hunt_id",
        placeholder="Create a map hunt",
    )
    hunt = warehouse.get_hunt(str(hunt_id)) if hunt_id else None
    if hunt:
        st.session_state.research_case_id = str(case["id"])
        st.session_state.property_hunt_id = str(hunt["hunt_id"])
    return case, hunt


def _create_hunt_for_case(service: PropertyIntelService, case: dict[str, Any]) -> None:
    with st.form("geo_explorer_add_hunt"):
        states = list(US_STATES)
        state = st.selectbox("State", states, index=None, format_func=_state_label)
        name = st.text_input("Map hunt name", value=f"{state} Geo Explorer")
        if st.form_submit_button("Create map hunt", type="primary", width="stretch"):
            today = date.today()
            hunt_id = service.create_hunt(PropertyHuntConfig(
                name=name,
                case_id=str(case["id"]),
                strategy="state-weather",
                state=state,
                storm_start="",
                storm_end="",
                event_types=["Hail", "Thunderstorm Wind", "Tornado", "Heavy Rain", "Flash Flood"],
            ))
            st.session_state.geo_hunt_id = hunt_id
            try:
                with st.spinner("Loading the official state boundary…"):
                    service.collect_state_boundary(hunt_id)
            except Exception as exc:
                st.session_state.geo_boundary_error = f"{type(exc).__name__}: {exc}"
            st.rerun()


def _latest_drawing(map_state: dict[str, Any]) -> dict[str, Any] | None:
    active = map_state.get("last_active_drawing")
    if isinstance(active, dict):
        return active
    drawings = map_state.get("all_drawings")
    if isinstance(drawings, list) and drawings and isinstance(drawings[-1], dict):
        return drawings[-1]
    return None


def _point_from_map(map_state: dict[str, Any]) -> dict[str, float] | None:
    for key in ("last_object_clicked", "last_clicked"):
        point = map_state.get(key)
        if isinstance(point, dict) and point.get("lat") is not None and point.get("lng") is not None:
            return {"lat": float(point["lat"]), "lng": float(point["lng"])}
    return None


def _render_quick_target(service: PropertyIntelService, case: dict[str, Any], hunt: dict[str, Any]) -> None:
    """Apply a Quick Recon handoff without rebuilding the Leaflet base map."""
    case_id = str(case["id"])
    hunt_id = str(hunt["hunt_id"])
    point = st.session_state.get("quick_geo_point")
    if isinstance(point, dict) and str(point.get("case_id") or "") == case_id:
        st.session_state[f"geo_clicked_{hunt_id}"] = {"lat": float(point["lat"]), "lng": float(point["lng"])}
        st.session_state.pop("quick_geo_point", None)

    pending = st.session_state.get("quick_geo_target")
    if not isinstance(pending, dict) or str(pending.get("case_id") or "") != case_id:
        return
    value = str(pending.get("value") or "").strip()
    target_type = str(pending.get("target_type") or "address")
    state = str(hunt["config"].get("state") or hunt.get("state") or "FL").upper()
    st.info(f"Quick target queued · {target_type}: {value}")
    links = {item["key"]: item for item in source_links(address=value if target_type == "address" else "", state=state)}
    if target_type == "address":
        resolve, official, clear = st.columns([0.42, 0.38, 0.2])
        if resolve.button("Resolve address on map", type="primary", width="stretch"):
            run_id = service.case_store.create_run(
                case_id,
                "quick-address-routing",
                adapter="census-geocoder",
                traffic_class="public-api",
                config={"hunt_id": hunt_id, "address": value},
            )
            try:
                session = build_public_session(service.secrets.effective().get("nws_contact", ""))
                route, raw, headers, request_url = census_geocode(session, value)
                route_values = route.values()
                artifact_id = service.case_store.record_artifact_bytes(
                    case_id,
                    raw,
                    "census-geocoder-response",
                    run_id=run_id,
                    media_type="application/json",
                    encoding="utf-8",
                    source_uri=request_url,
                    suffix=".json",
                    metadata={"hunt_id": hunt_id, "response_headers": headers, "entrypoint": "quick-recon"},
                )
                observation_id = service.case_store.record_observation(
                    case_id,
                    "quick-address-route",
                    route_values,
                    run_id=run_id,
                    normalized_value=str(route.matched_address or value),
                    source_name="U.S. Census Geocoder",
                    source_uri=request_url,
                    confidence=1.0 if route.geocode_status == "MATCHED" else 0.0,
                    artifact_id=artifact_id,
                    metadata={"hunt_id": hunt_id, "entrypoint": "quick-recon"},
                )
                service.case_store.add_evidence(
                    case_id,
                    "quick-address-route",
                    json.dumps(route_values, ensure_ascii=False, sort_keys=True),
                    observation_id=observation_id,
                    artifact_id=artifact_id,
                    source_uri=request_url,
                )
                service.case_store.complete_run(run_id, summary={"status": route.geocode_status, "matched_address": route.matched_address})
                if route.latitude is None or route.longitude is None:
                    st.warning("The Census Geocoder returned no map coordinates. The exact response was preserved in case evidence.")
                else:
                    st.session_state[f"geo_clicked_{hunt_id}"] = {"lat": float(route.latitude), "lng": float(route.longitude)}
                    st.session_state.pop("quick_geo_target", None)
                    st.rerun()
            except Exception as exc:
                service.case_store.complete_run(run_id, error=f"{type(exc).__name__}: {exc}")
                st.error(f"Address routing failed: {type(exc).__name__}: {exc}")
        census_url = str(links.get("census_geocoder", {}).get("url") or "")
        if census_url:
            official.link_button("Open official geocoder", census_url, width="stretch")
        if clear.button("Clear", width="stretch"):
            st.session_state.pop("quick_geo_target", None)
            st.rerun()
    else:
        st.caption("The exact parcel identifier remains in case evidence. Open an official parcel source, then capture the matched record into the review queue.")
        source_keys = ["fl_geospatial", "fl_dor_officials"] if state == "FL" else ["county_appraiser"]
        columns = st.columns(len(source_keys) + 1)
        for index, key in enumerate(source_keys):
            link = links.get(key, {})
            url = str(link.get("url") or "")
            if url:
                columns[index].link_button(str(link.get("label") or key), url, width="stretch")
            else:
                columns[index].button(str(link.get("label") or key), disabled=True, width="stretch")
        if columns[-1].button("Clear", width="stretch"):
            st.session_state.pop("quick_geo_target", None)
            st.rerun()


def _selection_overlay(selected_point: dict[str, float] | None) -> folium.FeatureGroup:
    """Keep selection updates out of the base-map hash so Leaflet retains its viewport."""
    overlay = folium.FeatureGroup(name="Current selection", show=True)
    if selected_point:
        folium.Marker(
            [selected_point["lat"], selected_point["lng"]],
            tooltip="Selected investigation point",
            icon=folium.Icon(color="green", icon="crosshairs"),
        ).add_to(overlay)
    return overlay


def _refresh_weather(service: PropertyIntelService, hunt_id: str, start: date, end: date) -> None:
    progress = st.status("Refreshing open weather layers…", expanded=True)
    failures: list[str] = []
    for label, action in (
        ("Rain gauges", lambda: service.collect_rainfall(hunt_id, start, end, maximum_observations=250_000)),
        ("Storm reports", lambda: service.collect_storm_history(hunt_id, start=start, end=end)),
        ("Current NWS alerts", lambda: service.collect_nws_alerts(hunt_id)),
    ):
        try:
            summary = action()
            progress.write(f"{label}: {summary}")
        except Exception as exc:
            failures.append(f"{label}: {type(exc).__name__}: {exc}")
    if failures:
        progress.update(label="Weather refresh completed with source errors", state="error")
        for failure in failures:
            st.warning(failure)
    else:
        progress.update(label="Weather layers ready", state="complete")


def _render_fence_workflow(service: PropertyIntelService, hunt: dict[str, Any], draft: dict[str, Any] | None) -> None:
    hunt_id = str(hunt["hunt_id"])
    fences = service.warehouse.list_map_fences(hunt_id)
    st.markdown("#### Fence collection")
    st.caption("Draw a polygon or rectangle on the map, save it as evidence, then query a permitted public parcel FeatureServer for intersecting address records.")
    config = hunt["config"]
    links = source_links(
        county=str(config.get("county") or ""),
        state=str(config.get("state") or "FL"),
        custom_urls=dict(config.get("custom_source_urls") or {}),
    )
    link_by_key = {item["key"]: item for item in links}
    with st.expander("Find the official parcel layer", expanded=False):
        st.caption("Use the state or county open-data directory to locate a public ArcGIS FeatureServer layer, then paste the layer URL below.")
        source_keys = ["fl_geospatial", "fl_dor_roll_gis"] if str(config.get("state") or "").upper() == "FL" else ["county_appraiser"]
        columns = st.columns(len(source_keys))
        for index, key in enumerate(source_keys):
            link = link_by_key.get(key, {})
            url = str(link.get("url") or "")
            if url:
                columns[index].link_button(f"↗ {link.get('label') or key}", url, width="stretch")
            else:
                columns[index].button(str(link.get("label") or key), disabled=True, width="stretch", help="Configure this jurisdiction's official source URL in Property Intel → Hunt.")

    if draft:
        geometry = draft.get("geometry") if draft.get("type") == "Feature" else draft
        geometry_type = str((geometry or {}).get("type") or "Unknown")
        left, right = st.columns([0.72, 0.28])
        fence_name = left.text_input("Fence name", value=f"Explorer fence {len(fences) + 1}", key=f"geo_fence_name_{hunt_id}")
        if right.button("Save fence", type="primary", width="stretch"):
            try:
                result = service.save_map_fence(hunt_id, fence_name, draft)
                st.session_state.pop(f"geo_draft_fence_{hunt_id}", None)
                st.success(f"Saved {geometry_type} fence `{result['fence_id']}` with exact GeoJSON evidence.")
                st.rerun()
            except ValueError as exc:
                st.error(str(exc))
    elif not fences:
        st.info("Use the polygon or rectangle tool on the left side of the map to define the first collection area.")

    if not fences:
        return
    by_id = {str(item["fence_id"]): item for item in fences}
    selected_id = st.selectbox(
        "Saved fence",
        list(by_id),
        format_func=lambda value: f"{by_id[value]['name']} · {by_id[value]['created_at']}",
        key=f"geo_saved_fence_{hunt_id}",
    )
    selected = by_id[str(selected_id)]
    is_florida = str(config.get("state") or "").upper() == "FL"
    if is_florida:
        st.caption("The Florida queue uses the statewide FDOR cadastral layer and preserves every raw ArcGIS response before review.")
        if st.button("Run Florida fence capture queue", type="primary", width="stretch"):
            try:
                with st.spinner("Capturing statewide parcel attributes and building the durable coordinate queue…"):
                    summary = service.collect_florida_fence_queue(hunt_id, selected)
                st.success(
                    f"Captured {summary['features']:,} parcels; queued {summary['queued']:,} for review "
                    f"({summary['ready_for_review']:,} complete, {summary['incomplete']:,} requiring follow-up)."
                )
                st.rerun()
            except Exception as exc:
                st.error(f"Florida fence queue failed: {type(exc).__name__}: {exc}")
    custom_urls = dict(config.get("custom_source_urls") or {})
    default_url = str(custom_urls.get("parcel_feature_layer") or (FLORIDA_STATEWIDE_CADASTRAL_LAYER_URL if is_florida else ""))
    with st.form(f"geo_fence_collect_{hunt_id}"):
        endpoint = st.text_input(
            "Public parcel FeatureServer layer URL",
            value=default_url,
            placeholder="https://…/FeatureServer/0",
            help="Use the layer URL, not its /query URL. The collector sends the saved polygon as an intersects filter.",
        )
        where = st.text_input("Optional source filter", value="1=1")
        collect = st.form_submit_button("Capture custom parcel source", type="primary", width="stretch")
    if collect:
        try:
            endpoint = validate_public_url(endpoint)
            service.warehouse.update_hunt_source_url(hunt_id, "parcel_feature_layer", endpoint)
            with st.spinner("Querying intersecting public parcel features and preserving each raw response…"):
                summary = service.collect_arcgis(hunt_id, endpoint, where=where, polygon_geojson=selected["geojson"])
                queue = service.warehouse.queue_fence_properties(hunt_id, str(selected["fence_id"]), selected["geojson"])
            st.success(
                f"Captured {summary['features']:,} features, added {summary['properties_imported']:,} properties, "
                f"and placed {queue['queued']:,} records in the review queue."
            )
            st.rerun()
        except Exception as exc:
            st.error(f"Parcel collection failed: {type(exc).__name__}: {exc}")


def _render_capture_queue(service: PropertyIntelService, hunt: dict[str, Any]) -> None:
    hunt_id = str(hunt["hunt_id"])
    queue = service.warehouse.list_geo_capture_queue(hunt_id)
    if not queue:
        st.info("Save a fence and run its capture queue to populate this stage.")
        return
    counts = pd.Series([str(item.get("status") or "unknown") for item in queue]).value_counts().to_dict()
    metrics = st.columns(3)
    metrics[0].metric("Queued properties", len(queue))
    metrics[1].metric("Ready for review", int(counts.get("ready-for-review", 0)))
    metrics[2].metric("Incomplete", int(counts.get("captured-incomplete", 0)))
    columns = ["status", "property_address", "owner_name", "year_built", "county", "parcel_id", "source_url", "attempts", "completed_at"]
    st.dataframe(
        pd.DataFrame(queue)[columns],
        width="stretch",
        hide_index=True,
        column_config={"source_url": st.column_config.LinkColumn("Florida parcel map", display_text="Open parcel ↗")},
    )


def _render_queue_review(service: PropertyIntelService, hunt: dict[str, Any]) -> None:
    hunt_id = str(hunt["hunt_id"])
    queue = service.warehouse.list_geo_capture_queue(hunt_id)
    if not queue:
        st.info("The review stage opens after a fence capture queue has run.")
        return
    rows = []
    for item in queue:
        rows.append({
            "record_id": item["record_id"],
            "property_address": item["property_address"],
            "owner_name": item.get("owner_name"),
            "year_built": item.get("year_built"),
            "county": item.get("county"),
            "parcel_id": item.get("parcel_id"),
            "property_type": item.get("property_type"),
            "florida_parcel_map": item.get("source_url"),
            "review_status": item.get("review_status"),
            "recommended_activation": item.get("recommended_activation"),
            "analyst_notes": item.get("analyst_notes"),
        })
    frame = pd.DataFrame(rows)
    editable = {"owner_name", "year_built", "county", "parcel_id", "property_type", "review_status", "recommended_activation", "analyst_notes"}
    edited = st.data_editor(
        frame,
        width="stretch",
        hide_index=True,
        disabled=[column for column in frame.columns if column not in editable],
        column_config={
            "owner_name": st.column_config.TextColumn("Owner of record", width="medium"),
            "year_built": st.column_config.NumberColumn("Year built", min_value=1600, max_value=date.today().year, step=1),
            "county": st.column_config.TextColumn("County"),
            "florida_parcel_map": st.column_config.LinkColumn("Parcel map", display_text="Verify ↗"),
            "review_status": st.column_config.SelectboxColumn("Review status", options=list(PROPERTY_REVIEW_STATUSES), required=True),
            "recommended_activation": st.column_config.SelectboxColumn("Next action", options=list(PROPERTY_ACTIVATIONS), required=True),
            "analyst_notes": st.column_config.TextColumn("Analyst notes", width="large"),
        },
        key=f"geo_queue_review_{hunt_id}",
    )
    st.caption("Owner names are public owner-of-record fields from the source roll. Confirm parcel-specific facts with the county property appraiser before use.")
    if st.button("Save reviewed property details", type="primary", width="stretch"):
        for row in edited.to_dict("records"):
            record_id = str(row["record_id"])
            service.warehouse.update_intel_fields(hunt_id, record_id, {key: row.get(key) for key in editable})
            service.warehouse.review(hunt_id, record_id, str(row["review_status"]), str(row.get("analyst_notes") or ""), str(row["recommended_activation"]))
            service.warehouse.mark_geo_queue_reviewed(hunt_id, record_id, str(row["review_status"]))
        st.success("Review decisions and corrected property fields saved.")
        st.rerun()

    approved = [item for item in service.warehouse.list_properties(hunt_id) if item.get("review_status") == "approved-for-export" and item.get("recommended_activation") not in {"exclude", "research-only"}]
    st.markdown(f"##### Reviewed export · {len(approved):,} approved")
    export_left, export_right = st.columns(2)
    export_left.download_button(
        "Download reviewed CSV",
        data=service.warehouse.csv_bytes(hunt_id, approved_only=True),
        file_name=f"{hunt_id}-reviewed-properties.csv",
        mime="text/csv",
        disabled=not approved,
        width="stretch",
    )
    export_right.download_button(
        "Download reviewed GeoJSON",
        data=service.warehouse.geojson_bytes(hunt_id, approved_only=True),
        file_name=f"{hunt_id}-reviewed-properties.geojson",
        mime="application/geo+json",
        disabled=not approved,
        width="stretch",
    )


def render_geo_explorer_map(service: PropertyIntelService, hunt: dict[str, Any]) -> None:
    hunt_id = str(hunt["hunt_id"])
    state = str(hunt["config"].get("state") or hunt.get("state") or "FL").upper()
    boundary = service.warehouse.get_state_boundary(hunt_id)
    boundary_error = st.session_state.pop("geo_boundary_error", "")
    if boundary_error:
        st.warning(f"The workspace was created, but the state boundary could not be loaded: {boundary_error}")
    if not boundary:
        st.info("Load the official state outline to initialize the map. Weather and parcel layers can be added afterward.")
        if st.button("Load state map", type="primary", width="stretch"):
            try:
                with st.spinner("Loading the official Census TIGERweb boundary…"):
                    service.collect_state_boundary(hunt_id)
                st.rerun()
            except Exception as exc:
                st.error(f"Boundary collection failed: {type(exc).__name__}: {exc}")
        return

    show_weather = st.toggle("Enable weather overlays", value=False, key=f"geo_weather_enabled_{hunt_id}")
    lookback = 90
    metric = "Peak daily rainfall"
    if show_weather:
        control_left, control_right = st.columns(2)
        lookback = control_left.select_slider("Weather window", options=[7, 14, 30, 60, 90, 180, 365], value=90, format_func=lambda value: f"Last {value} days")
        metric = control_right.selectbox("Rain hotspot", ["Peak daily rainfall", "Total rainfall", "Wet days"])
    end = date.today()
    start = end - timedelta(days=int(lookback) - 1)
    if show_weather:
        if st.button("Load or refresh open weather data", width="stretch"):
            _refresh_weather(service, hunt_id, start, end)
            st.rerun()
    else:
        st.caption("Weather is off. Enable it only when you are ready to load rainfall, storm-event and NWS alert layers.")

    rainfall = service.warehouse.rainfall_summary(hunt_id, start, end) if show_weather else []
    events = service.warehouse.list_events(hunt_id, start, end) if show_weather else []
    properties = service.warehouse.list_properties(hunt_id)
    fences = service.warehouse.list_map_fences(hunt_id)
    clicked_key = f"geo_clicked_{hunt_id}"
    draft_key = f"geo_draft_fence_{hunt_id}"
    selected_point = st.session_state.get(clicked_key)
    map_view = _build_map(
        boundary["geojson"],
        sorted(rainfall, key=lambda row: float(row.get({"Peak daily rainfall": "max_daily_mm", "Total rainfall": "total_mm", "Wet days": "wet_days"}[metric]) or 0), reverse=True)[:2000],
        events[:5000],
        properties[:5000],
        metric,
        None,
        fences=fences[:25],
        drawing=True,
    )
    map_state = st_folium(
        map_view,
        height=720,
        width=None,
        use_container_width=True,
        returned_objects=["last_clicked", "last_object_clicked", "all_drawings", "last_active_drawing"],
        key=f"geo_explorer_leaflet_{hunt_id}",
        feature_group_to_add=_selection_overlay(selected_point),
    )
    point = _point_from_map(map_state)
    if point:
        previous = st.session_state.get(clicked_key)
        if not previous or abs(previous["lat"] - point["lat"]) > 1e-7 or abs(previous["lng"] - point["lng"]) > 1e-7:
            st.session_state[clicked_key] = point
            st.session_state.pop(f"weather_selection_{hunt_id}", None)
    drawing = _latest_drawing(map_state)
    if drawing:
        st.session_state[draft_key] = drawing

    stage = stage_picker(
        "Explorer stage",
        ("1 · Inspect point", "2 · Fence capture", "3 · Capture queue", "4 · Review & export"),
        key=f"geo_explorer_stage_{hunt_id}",
    )
    if stage == "1 · Inspect point":
        clicked = st.session_state.get(clicked_key)
        if clicked:
            _render_point_actions(service, hunt, clicked)
        else:
            st.info("Click a parcel or map location to resolve its address and open property, permit and official-record sources.")
    elif stage == "2 · Fence capture":
        _render_fence_workflow(service, hunt, st.session_state.get(draft_key))
    elif stage == "3 · Capture queue":
        _render_capture_queue(service, hunt)
    else:
        _render_queue_review(service, hunt)


def render_geo_explorer(store: CaseStore) -> None:
    st.title("Geo Explorer")
    st.caption("Click-to-investigate property intelligence, open weather context and polygon-based parcel collection in one map-first workspace.")
    warehouse = PropertyWarehouse()
    service = PropertyIntelService(store, warehouse)
    cases = store.list_cases(250)
    _quick_start(store, service, expanded=not cases)
    if not cases:
        return
    selector_left, selector_right = st.columns([0.58, 0.42])
    with selector_left:
        case, hunt = _selectors(store, warehouse)
    with selector_right:
        if hunt:
            state = str(hunt["config"].get("state") or hunt.get("state") or "FL")
            st.metric("Exploration scope", state_name(state))
    if not case:
        return
    if not hunt:
        st.info("This case does not have a map hunt yet.")
        _create_hunt_for_case(service, case)
        return
    case_context_header(case, workspace="Geo Explorer", detail=f"Hunt: {hunt['name']}")
    _render_quick_target(service, case, hunt)
    render_geo_explorer_map(service, hunt)
