# State Weather Risk Map

The Weather Risk Map is the first state-scale storm-damage research layer inside **Research Mode → Property Intel**. It combines measured rainfall, documented storm events, current alert geometry and property research on one interactive Leaflet map.

## Free public sources

| Layer | Source | Access | Key |
|---|---|---|---|
| State boundary | U.S. Census TIGERweb | ArcGIS REST GeoJSON | None |
| Historical measured rainfall | NOAA NCEI Daily Summaries (`PRCP`) | Access Data Service JSON | None |
| Historical storm reports | NOAA Storm Events | Yearly CSV gzip files | None |
| Current watches and warnings | National Weather Service API | GeoJSON | None |
| Analyst-clicked address | OpenStreetMap Nominatim | User-triggered reverse JSON | None |
| Basemap | OpenStreetMap | Leaflet tiles | None |

Every collector response is preserved as an exact content-addressed case artifact before normalization.

## Workflow

1. Create a `state-weather` hunt and choose a state.
2. Open **Weather Risk Map**.
3. Choose the lookback window and end date.
4. Select measured rainfall, historical reports and/or current alerts.
5. Build the overlay.
6. Switch Leaflet layers and choose total rain, peak daily rain or wet days as the hotspot weight.
7. Click a location and explicitly select **Resolve address**.
8. Open the configured property appraiser, permit portal or official-records system in a separate tab.
9. Add the location to the property review queue, then document verified year-built and permit information.

## What the map means

- Rainfall circles represent reporting GHCN-Daily stations, not parcels.
- The heat layer is a visual concentration surface derived from station measurements. It is not radar imagery and does not assert uniform rainfall between gauges.
- Popups show the selected-window total, largest daily observation and its date, most recent measured rain, wet days and reporting days.
- Storm points come from NOAA Storm Events reports. Their position and timing precision varies by record.
- NWS polygons represent current alert areas, not confirmed damage.
- “Light,” “moderate,” “heavy,” “very heavy” and “extreme” are transparent analyst triage bands based on peak daily millimeters. They are not NOAA damage classifications.

The overlay identifies places for further property research; it does not prove that a building was damaged. Property age, roof permits, claims and observed condition must be verified independently.

## Public-service safeguards

Nominatim is called only after a person clicks one map point and presses **Resolve address**. Results are cached locally so repeated points do not create repeat requests. The Studio does not perform grid reverse-geocoding, autocomplete or bulk address harvesting against the public service. OpenStreetMap attribution is retained.

## Kali setup

The launcher detects the changed dependency lock and installs Folium plus `streamlit-folium` automatically:

```bash
chmod +x ./run.sh
./run.sh --check
./run.sh
```

No live weather collection is required by `--check`.
