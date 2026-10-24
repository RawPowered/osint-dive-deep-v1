# Property Intel source and automation matrix

Property Intel treats the Florida DOR directory as authoritative for county routing and preserves exact source bytes or rendered DOM before normalization. API keys are optional and remain local.

The Census Data API uses a free API key for ACS market-profile queries. People-directory review is manual and single-record only: local queue creation sends no source requests, Florida Residents Directory automation is disabled under its current terms, and National Public Data remains manual-only until permitted reuse terms are verified.

| Source | Automated path | Browser or fallback path | Local configuration |
|---|---|---|---|
| U.S. Census Geocoder | REST address/geography lookup; batch endpoint is source-ready | Official geocoder page | No key |
| Florida DOR — Find a County Official | Managed Playwright county resolver | Separate official-directory tab and DOM capture | No key |
| Florida DOR — Assessment Roll and GIS Data | Stream a discovered roll/GIS download into the raw archive | Open portal, capture DOM, select its direct file link | No key |
| Florida DOR — Tax Roll Ingestion | Upload original ZIP or extracted CSV; chunked NAL/NAP/SDF detection and DuckDB normalization with exact upload preservation | Open the official NAL/NAP directory and download manually | No key |
| Florida Geospatial Open Data Portal / FDOR statewide cadastral layer | Automatic saved-fence intersection against the public statewide FeatureServer; paginated GeoJSON responses are archived and normalized into parcel ID, situs address, owner-of-record name, county, year built and land-use fields | Coordinate-specific Statewide Parcel Map link, portal discovery and DOM capture; direct GeoJSON/shapefile download | No key for the configured statewide layer; `OSINT_ARCGIS_TOKEN` remains available for other layers that require one |
| NOAA Storm Events Database | Discover and download official yearly details CSV gzip files | Storm Events search page | No key |
| NOAA NCEI Daily Precipitation | Daily Summaries `PRCP` JSON by state bounding area, date window and station location | NCEI Data Access search | No key |
| U.S. Census TIGERweb | State boundary GeoJSON used for map framing and exact point clipping | ArcGIS REST directory | No key |
| NWS API | Active selected-state alert GeoJSON and alert geometry | API documentation or exact endpoint tab | `OSINT_NWS_CONTACT` for the descriptive User-Agent contact |
| OpenStreetMap Nominatim | One reverse lookup for an analyst-clicked coordinate, cached locally | Manual OSM review | No key; public-service policy applies |
| NOAA Data Access Viewer | Dataset links discovered from captured DOM or direct downloads | Interactive, separate managed tab | No key |
| Florida Sunbiz | Rendered-DOM and screenshot evidence | Manual or careful managed-browser research | No key |
| County property appraiser | Seeded Florida destinations, DOR resolver, direct API/file capture | Jurisdiction-specific managed tab | `OSINT_COUNTY_PROPERTY_API_KEY` when applicable |
| County or municipal permit portal | Direct API/open-data/file capture when configured | Jurisdiction-specific managed tab and analyst review | `OSINT_PERMIT_API_KEY` when applicable |
| County clerk official records | Direct public export capture when configured | Jurisdiction-specific managed tab and analyst review | `OSINT_CLERK_API_KEY` when applicable |

## Browser capture workflow

1. Run `./run.sh --install-browser` once on Kali.
2. Create or select a property hunt.
3. Open **Sources & Browser** and start the managed browser.
4. Open one or more official-source tabs.
5. Navigate or search normally in the visible browser.
6. Select the tab in Studio and capture it.
7. Studio stores the rendered DOM, optional full-page screenshot, URL, title, capture time, SHA-256, extracted absolute links, case observation and evidence reference.

The browser does not bypass authentication, CAPTCHAs, access controls or published limits. When a portal exposes a direct public download or API endpoint, use **Collect → Direct API or bulk-file fallback** to stream it into the content-addressed archive.

The public Nominatim service is never queried as a grid or batch collector. Lookup happens only after the analyst clicks **Resolve address**, and repeat coordinates are served from the local cache. OpenStreetMap attribution remains visible on the Leaflet map.

The configured Florida fence workflow uses the current public FDOR statewide cadastral layer and preserves each raw ArcGIS response before normalization. The statewide roll is a discovery and triage source. Owner names are displayed exactly as published as **owner of record**; analysts should use the linked county property appraiser, clerk and permit systems for parcel-level confirmation.

## County adapter contract

County-specific modules can be added without changing the UI flow. An adapter should declare jurisdiction, source URL, access method, credential field, lookup keys, supported output fields, rate behavior and fallback URL. It must return exact raw assets plus normalized property or permit fields with confidence and provenance.
