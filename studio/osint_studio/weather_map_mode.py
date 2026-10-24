from __future__ import annotations

import html
import json
from datetime import date, timedelta
from typing import Any

import folium
import pandas as pd
import streamlit as st
from folium.plugins import Draw, Fullscreen, HeatMap, MarkerCluster, MeasureControl, MousePosition
from streamlit_folium import st_folium

from .property_service import PropertyIntelService
from .property_sources import florida_parcel_map_url, source_links
from .weather_hunt import geometry_bounds, rainfall_intensity, state_name


def _text(value: Any) -> str:
    return html.escape(str(value if value is not None else ""))


def _center(boundary: dict[str, Any]) -> tuple[float, float]:
    features = boundary.get("features") or []
    properties = (features[0].get("properties") or {}) if features else {}
    try:
        return float(properties["CENTLAT"]), float(properties["CENTLON"])
    except (KeyError, TypeError, ValueError):
        south, west, north, east = geometry_bounds(boundary)
        return (south + north) / 2, (west + east) / 2


def _event_geometry(event: dict[str, Any]) -> dict[str, Any] | None:
    value = (event.get("source_row") or {}).get("NWS_GEOMETRY")
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.get("type") else None


def _build_map(
    boundary: dict[str, Any],
    rainfall: list[dict[str, Any]],
    events: list[dict[str, Any]],
    properties: list[dict[str, Any]],
    metric: str,
    selected_point: dict[str, float] | None,
    fences: list[dict[str, Any]] | None = None,
    drawing: bool = False,
) -> folium.Map:
    center = _center(boundary)
    map_view = folium.Map(location=center, zoom_start=6, tiles=None, control_scale=True, prefer_canvas=True)
    folium.TileLayer("OpenStreetMap", name="Street map", show=True).add_to(map_view)
    folium.TileLayer("CartoDB positron", name="Light map", show=False).add_to(map_view)
    folium.TileLayer(
        tiles="https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
        name="USGS aerial imagery",
        attr="USGS The National Map · USDA",
        overlay=False,
        control=True,
        show=False,
        max_zoom=23,
    ).add_to(map_view)
    folium.GeoJson(
        boundary,
        name="State boundary",
        style_function=lambda _: {"color": "#64748b", "weight": 2, "fillColor": "#64748b", "fillOpacity": 0.04},
        tooltip=folium.GeoJsonTooltip(fields=["NAME"], aliases=["State"]),
    ).add_to(map_view)

    metric_key = {"Total rainfall": "total_mm", "Peak daily rainfall": "max_daily_mm", "Wet days": "wet_days"}[metric]
    values = [max(0.0, float(row.get(metric_key) or 0)) for row in rainfall]
    maximum = max(values, default=0.0)
    rain_heat = folium.FeatureGroup(name=f"Rainfall hotspots · {metric}", show=True)
    heat_rows = []
    for row, value in zip(rainfall, values):
        if value <= 0:
            continue
        weight = value / maximum if maximum else 0
        heat_rows.append([float(row["latitude"]), float(row["longitude"]), weight])
    if heat_rows:
        HeatMap(heat_rows, min_opacity=0.22, radius=24, blur=19, max_zoom=9).add_to(rain_heat)
    rain_heat.add_to(map_view)

    stations = MarkerCluster(name="Rain gauges", show=True)
    for row in rainfall:
        max_daily = float(row.get("max_daily_mm") or 0)
        popup = (
            f"<b>{_text(row.get('station_name') or row.get('station_id'))}</b><br>"
            f"Total: {float(row.get('total_mm') or 0):,.1f} mm<br>"
            f"Peak day: {max_daily:,.1f} mm on {_text(row.get('peak_date'))}<br>"
            f"Last measured rain: {_text(row.get('last_rain_date'))}<br>"
            f"Wet/reporting days: {int(row.get('wet_days') or 0)}/{int(row.get('observation_days') or 0)}<br>"
            f"Triage band: {_text(rainfall_intensity(max_daily))}"
        )
        folium.CircleMarker(
            [float(row["latitude"]), float(row["longitude"])],
            radius=max(4, min(12, 4 + max_daily / 15)),
            color="#2563eb",
            fill=True,
            fill_color="#38bdf8",
            fill_opacity=0.75,
            weight=1,
            tooltip=f"{row.get('station_name') or row.get('station_id')} · {max_daily:.1f} mm peak",
            popup=folium.Popup(popup, max_width=360),
        ).add_to(stations)
    stations.add_to(map_view)

    storm_layer = folium.FeatureGroup(name="Storm reports and alerts", show=True)
    for event in events:
        latitude, longitude = event.get("latitude"), event.get("longitude")
        popup = (
            f"<b>{_text(event.get('event_type'))}</b><br>"
            f"When: {_text(event.get('event_date'))}<br>"
            f"Area: {_text(event.get('county'))}<br>"
            f"Magnitude/severity: {_text(event.get('magnitude'))}"
        )
        geometry = _event_geometry(event)
        if geometry:
            folium.GeoJson(
                {"type": "Feature", "geometry": geometry, "properties": {}},
                style_function=lambda _: {"color": "#dc2626", "weight": 2, "fillColor": "#f97316", "fillOpacity": 0.13},
                popup=folium.Popup(popup, max_width=360),
            ).add_to(storm_layer)
        if latitude is not None and longitude is not None and not pd.isna(latitude) and not pd.isna(longitude):
            folium.CircleMarker(
                [float(latitude), float(longitude)], radius=6, color="#991b1b", fill=True,
                fill_color="#f97316", fill_opacity=0.82, weight=1,
                tooltip=f"{event.get('event_type')} · {event.get('event_date')}", popup=folium.Popup(popup, max_width=360),
            ).add_to(storm_layer)
    storm_layer.add_to(map_view)

    property_layer = MarkerCluster(name="Property review queue", show=True)
    for record in properties:
        latitude, longitude = record.get("latitude"), record.get("longitude")
        if latitude is None or longitude is None or pd.isna(latitude) or pd.isna(longitude):
            continue
        parcel_map_link = ""
        if str(record.get("state") or "").upper() == "FL":
            parcel_map_link = f'<br><a href="{_text(florida_parcel_map_url(float(latitude), float(longitude)))}" target="_blank" rel="noopener">Open Florida parcel map ↗</a>'
        popup = (
            f"<b>{_text(record.get('property_address'))}</b><br>"
            f"Owner of record: {_text(record.get('owner_name') or 'Research required')}<br>"
            f"County: {_text(record.get('county') or 'Research required')}<br>"
            f"Year built: {_text(record.get('year_built') or 'Research required')}<br>"
            f"Roof permit: {_text(record.get('last_roof_permit_status') or 'Research required')}<br>"
            f"Storm distance: {_text(record.get('event_distance_km') or 'Not matched')} km"
            f"{parcel_map_link}"
        )
        folium.Marker(
            [float(latitude), float(longitude)],
            tooltip=str(record.get("property_address") or "Property"),
            popup=folium.Popup(popup, max_width=360),
            icon=folium.Icon(color="blue", icon="home"),
        ).add_to(property_layer)
    property_layer.add_to(map_view)

    if selected_point:
        folium.Marker(
            [selected_point["lat"], selected_point["lng"]],
            tooltip="Selected investigation point",
            icon=folium.Icon(color="green", icon="crosshairs"),
        ).add_to(map_view)
    for fence in fences or []:
        folium.GeoJson(
            fence.get("geojson") or {},
            name=f"Fence · {fence.get('name') or fence.get('fence_id')}",
            style_function=lambda _: {"color": "#16a34a", "weight": 3, "fillColor": "#22c55e", "fillOpacity": 0.08},
            tooltip=str(fence.get("name") or "Saved fence"),
        ).add_to(map_view)
    if drawing:
        Draw(
            export=False,
            position="topleft",
            draw_options={
                "polyline": False,
                "circle": False,
                "circlemarker": False,
                "marker": False,
                "polygon": {"allowIntersection": False, "showArea": True},
                "rectangle": {"showArea": True},
            },
            edit_options={"edit": True, "remove": True},
        ).add_to(map_view)
        Fullscreen(position="topleft", title="Full screen", title_cancel="Exit full screen").add_to(map_view)
        MeasureControl(position="topleft", primary_length_unit="miles", secondary_length_unit="kilometers").add_to(map_view)
        MousePosition(position="bottomright", separator=", ", prefix="Cursor").add_to(map_view)
    folium.LayerControl(collapsed=False).add_to(map_view)
    return map_view


def _render_point_actions(service: PropertyIntelService, hunt: dict[str, Any], clicked: dict[str, float]) -> None:
    hunt_id = str(hunt["hunt_id"])
    st.markdown("#### Selected investigation point")
    left, right = st.columns([0.72, 0.28])
    left.code(f"{clicked['lat']:.7f}, {clicked['lng']:.7f}", language="text")
    selection_key = f"weather_selection_{hunt_id}"
    if right.button("Resolve address", type="primary", width="stretch"):
        with st.spinner("Resolving this single analyst-selected point…"):
            st.session_state[selection_key] = service.resolve_map_point(hunt_id, clicked["lat"], clicked["lng"])
    selection = st.session_state.get(selection_key)
    if not selection:
        st.caption("Address lookup is sent only after this button is pressed, then cached locally. © OpenStreetMap contributors.")
        return
    address = selection.get("address") if isinstance(selection.get("address"), dict) else {}
    st.success(str(selection.get("display_name") or "Address resolved"))
    st.dataframe(
        [{
            "Street": " ".join(item for item in (str(address.get("house_number") or ""), str(address.get("road") or "")) if item) or "Unknown",
            "Locality": str(address.get("city") or address.get("town") or address.get("village") or "Unknown"),
            "County": str(address.get("county") or "Unknown"),
            "State": str(address.get("state") or address.get("state_code") or "Unknown"),
            "Postal code": str(address.get("postcode") or "Unknown"),
        }],
        width="stretch",
        hide_index=True,
    )

    config = hunt["config"]
    links = source_links(
        address=str(selection.get("display_name") or ""),
        county=str(address.get("county") or config.get("county") or ""),
        state=str(config.get("state") or "FL"),
        custom_urls=dict(config.get("custom_source_urls") or {}),
    )
    link_by_key = {row["key"]: row for row in links}
    st.markdown("##### Property and permit research")
    columns = st.columns(4)
    for index, (key, label) in enumerate((("census_geocoder", "Verify address"), ("county_appraiser", "Property appraiser"), ("permit_portal", "Permit portal"), ("county_clerk", "Official records"))):
        url = str(link_by_key.get(key, {}).get("url") or "")
        if url:
            columns[index].link_button(f"↗ {label}", url, width="stretch")
        else:
            columns[index].button(label, disabled=True, width="stretch", help="Add this jurisdiction URL in the hunt configuration.")
    if str(config.get("state") or "").upper() == "FL":
        st.link_button(
            "↗ Open this coordinate in Florida Statewide Parcel Map",
            florida_parcel_map_url(clicked["lat"], clicked["lng"]),
            width="stretch",
        )
        st.caption("The statewide parcel map is a fast research index. Confirm legal, assessment and permit facts with the relevant county source.")
    if not config.get("custom_source_urls", {}).get("permit_portal"):
        st.caption("Permit systems are jurisdiction-specific. Add the official permit portal URL to this hunt to activate one-click permit research.")
    if st.button("Add point to property review queue", type="primary"):
        record_id = service.warehouse.add_map_property(hunt_id, selection)
        st.success(f"Added property research record `{record_id}`. Use Property Review to enter verified year-built and permit findings.")


def render_weather_risk_map(service: PropertyIntelService, hunt: dict[str, Any] | None) -> None:
    if not hunt:
        st.info("Create or select a property hunt first.")
        return
    hunt_id = str(hunt["hunt_id"])
    state = str(hunt["config"].get("state") or hunt.get("state") or "FL").upper()
    st.markdown(f"### {state_name(state)} storm and rainfall intelligence")
    st.caption("Measured precipitation, documented storm reports, current alert geometry and analyst-selected property research on one local interactive map.")

    control_a, control_b, control_c = st.columns([0.34, 0.33, 0.33])
    lookback = control_a.select_slider("Lookback", options=[7, 14, 30, 60, 90, 180, 365], value=90, format_func=lambda value: f"Last {value} days")
    end = control_b.date_input("Through", value=date.today(), max_value=date.today())
    start = end - timedelta(days=int(lookback) - 1)
    maximum = control_c.number_input("Maximum rain observations", 10_000, 500_000, 250_000, 10_000)
    include_rain, include_storms, include_alerts = st.columns(3)
    rain_enabled = include_rain.checkbox("Measured rainfall", value=True)
    storms_enabled = include_storms.checkbox("Historical storm reports", value=True)
    alerts_enabled = include_alerts.checkbox("Current NWS alerts", value=True)
    if st.button("Build or refresh weather overlay", type="primary", width="stretch"):
        progress = st.status("Building state weather overlay…", expanded=True)
        failures: list[str] = []
        try:
            service.collect_state_boundary(hunt_id)
            progress.write("State boundary captured from Census TIGERweb.")
        except Exception as exc:
            failures.append(f"Boundary: {type(exc).__name__}: {exc}")
        if rain_enabled and not failures:
            try:
                summary = service.collect_rainfall(hunt_id, start, end, maximum_observations=int(maximum))
                progress.write(f"Rainfall: {summary['observations_inserted']:,} daily observations across {summary['stations']:,} stations.")
                if summary.get("observation_limit_reached"):
                    progress.write("Rainfall collection reached the configured observation ceiling; increase it to broaden station coverage.")
            except Exception as exc:
                failures.append(f"Rainfall: {type(exc).__name__}: {exc}")
        if storms_enabled:
            try:
                summary = service.collect_storm_history(hunt_id, start=start, end=end)
                progress.write(f"Storm history: {summary['events_inserted']:,} documented events.")
            except Exception as exc:
                failures.append(f"Storm history: {type(exc).__name__}: {exc}")
        if alerts_enabled:
            try:
                summary = service.collect_nws_alerts(hunt_id)
                progress.write(f"Current alerts: {summary['alerts']:,} records.")
            except Exception as exc:
                failures.append(f"NWS alerts: {type(exc).__name__}: {exc}")
        if failures:
            progress.update(label="Overlay completed with source errors", state="error")
            for failure in failures:
                st.warning(failure)
        else:
            progress.update(label="Weather overlay ready", state="complete")
        st.rerun()

    boundary_record = service.warehouse.get_state_boundary(hunt_id)
    if not boundary_record:
        st.info("Build the overlay to load the official state boundary and weather layers.")
        return
    rainfall = service.warehouse.rainfall_summary(hunt_id, start, end)
    timeline = service.warehouse.rainfall_timeline(hunt_id, start, end)
    events = service.warehouse.list_events(hunt_id, start, end)
    properties = service.warehouse.list_properties(hunt_id)
    max_total = max((float(row.get("total_mm") or 0) for row in rainfall), default=0.0)
    max_daily = max((float(row.get("max_daily_mm") or 0) for row in rainfall), default=0.0)
    metrics = st.columns(4)
    metrics[0].metric("Reporting stations", len(rainfall))
    metrics[1].metric("Highest station total", f"{max_total:,.1f} mm")
    metrics[2].metric("Highest daily reading", f"{max_daily:,.1f} mm")
    metrics[3].metric("Storm reports / alerts", len(events))
    metric = st.radio("Hotspot weight", ["Total rainfall", "Peak daily rainfall", "Wet days"], horizontal=True)
    metric_key = {"Total rainfall": "total_mm", "Peak daily rainfall": "max_daily_mm", "Wet days": "wet_days"}[metric]
    mapped_rainfall = sorted(rainfall, key=lambda row: float(row.get(metric_key) or 0), reverse=True)[:2000]
    mapped_events = events[:5000]
    mapped_properties = properties[:3000]
    if len(mapped_rainfall) < len(rainfall) or len(mapped_events) < len(events) or len(mapped_properties) < len(properties):
        st.caption(f"For responsive mapping, this view shows {len(mapped_rainfall):,}/{len(rainfall):,} stations, {len(mapped_events):,}/{len(events):,} events and {len(mapped_properties):,}/{len(properties):,} properties. All records remain in DuckDB.")
    clicked_key = f"weather_clicked_{hunt_id}"
    map_view = _build_map(boundary_record["geojson"], mapped_rainfall, mapped_events, mapped_properties, metric, st.session_state.get(clicked_key))
    map_state = st_folium(map_view, height=650, width=None, key=f"weather_leaflet_{hunt_id}")
    if map_state.get("last_clicked"):
        point = {"lat": float(map_state["last_clicked"]["lat"]), "lng": float(map_state["last_clicked"]["lng"])}
        previous = st.session_state.get(clicked_key)
        if not previous or abs(previous["lat"] - point["lat"]) > 1e-7 or abs(previous["lng"] - point["lng"]) > 1e-7:
            st.session_state[clicked_key] = point
            st.session_state.pop(f"weather_selection_{hunt_id}", None)
            st.rerun()
    clicked = st.session_state.get(clicked_key)
    if clicked:
        _render_point_actions(service, hunt, clicked)
    if timeline:
        with st.expander("Rainfall timeline", expanded=False):
            frame = pd.DataFrame(timeline).set_index("observation_date")
            st.line_chart(frame[["mean_station_mm", "max_station_mm"]], y_label="Precipitation (mm)", x_label="Date")
            st.caption("The mean is the average among stations reporting that day; station coverage varies by date. Rainfall bands are analyst triage labels, not official damage determinations.")
