# Geo Explorer

Geo Explorer is the default, map-first entry into Property Market Intelligence. It runs locally in Streamlit and stores its work in the same case evidence database and DuckDB property warehouse as the full Property Intel workbench.

## Start

1. Launch the Studio with `./run.sh` on Kali.
2. Leave **Geo Explorer** selected in the sidebar.
3. Open **Start a new explorer**, name the workspace and choose a state.
4. Select **Start exploring**. The Studio creates the case and state hunt and requests the official Census TIGERweb state boundary.

Existing cases and property hunts can be reopened with the two selectors above the map. The same explorer is also available under **Research Mode → Property Intel → Geo Explorer**.

Use the layer control in the upper-right corner to switch between the OpenStreetMap street view, a light reference map and official USGS aerial imagery.

## Point investigation

Click a parcel or location and open **Inspect selected point**. Address resolution is an explicit analyst action and is cached locally. The resolved address can be added to the property review queue, and the panel exposes configured links for Census verification, the county property appraiser, permit records and clerk records.

For Florida hunts, every selected coordinate and geocoded property receives a direct Florida Statewide Parcel Map URL in this format:

```text
https://geodata.floridagio.gov/maps/75eb8aaee07d4ce69f7e8f538fc1aeb1/explore?location=<latitude>%2C<longitude>%2C18
```

These links appear in map-marker popups, the Geo Explorer property queue, Property Review and reviewed exports. The statewide map accelerates discovery; county appraiser, clerk and permit sources remain the verification authorities.

The public OpenStreetMap Nominatim service is used only for individual analyst-triggered clicks. It is not used for grid scanning, systematic reverse geocoding or bulk fence collection.

## Fence collection

1. Select the polygon or rectangle tool on the left edge of the map.
2. Draw the desired boundary and use the edit tool if necessary.
3. Open **Fence & collect**, name the shape and save it.
4. For a Florida hunt, select **Run Florida fence capture queue**. The Studio uses the current statewide FDOR cadastral layer automatically.
5. For another jurisdiction or layer, paste a permitted public parcel `FeatureServer/<layer>` URL, optionally add a source-side `where` filter, then capture.

The saved fence is preserved as exact GeoJSON case evidence. The collector converts it to an Esri polygon, sends an `intersects` query, pages the public FeatureServer, archives every exact response, normalizes common situs-address and parcel fields, and creates a durable per-property coordinate queue. The hunt maximum-result setting remains the collection ceiling.

For the statewide Florida layer, normalization includes physical address, parcel ID, DOR county number, owner-of-record name, actual or effective year built and DOR use code. Queue records are marked ready for review only when owner name, year built and county are present; incomplete records remain visible for follow-up.

## Review and export

The explorer is organized as four stages: inspect a point, capture a fence, inspect the durable queue, then review and export. The last stage allows correction and confirmation of owner-of-record name, year built, county, parcel ID and property type. Records must be explicitly marked `approved-for-export` with an eligible next action before appearing in the reviewed CSV or GeoJSON download.

Panning and zooming stay inside the live Leaflet component and do not trigger Streamlit reruns. Point selections are added through a dynamic overlay, so the base map keeps its current viewport while opening the investigation controls. Weather is disabled by default; enable it explicitly before loading rainfall, storm-event or NWS layers.

Fence collection depends on the public layer's schema. Address, parcel, year-built and land-use fields are normalized from common names, but jurisdiction-specific adapters remain appropriate when a source uses unusual field names or a non-ArcGIS portal.

## Weather context

The explorer can display NCEI measured precipitation, NOAA Storm Events, NWS alert geometry and existing property records. Use **Refresh open weather data** to collect those layers for the selected lookback. These are research and triage layers, not parcel-level rainfall estimates or damage determinations.
