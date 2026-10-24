# Phase 1.1 — Property Market Intelligence Layer

## Objective

Build a Kali-local property research layer that finds properties matching explicit hunt criteria, preserves exact public-source provenance, calculates explainable property-opportunity signals, and requires analyst review before CSV or GeoJSON activation.

This layer does not score people. Scores may use property, permit, event, imagery, distance, freshness, and source-quality signals only. Demographics, protected characteristics, inferred sensitive traits, and proxies for them are excluded from scoring and segmentation.

Version 5.10 adds a Unified Report that keeps property and market context together while preserving claim boundaries. Parcel/owner fields remain record-level public-property facts. Language observations require an exact source and basis. ACS language, race/ethnicity and income estimates are stored as county aggregates and are never assigned to a named owner or used in the property opportunity score.

## Version 5.9 implementation status

The operational core is implemented in the top-level Geo Explorer and Research Mode → Property Intel: one-form state workspace setup, stable Leaflet exploration, opt-in weather, saved GeoJSON fences, durable coordinate capture queues, automated statewide Florida cadastral enrichment, owner/year/county review, reviewed export, uploaded CSV archival, chunked Florida DOR ZIP/CSV tax-roll ingestion, strict NAL/NAP/SDF separation, municipal-first permit routing, browser-ready parcel query jobs, nationwide Census routing, generic ArcGIS parcel intersection collection, streamed public-file capture, managed Playwright tabs, rendered-DOM and screenshot evidence, nearest-event matching, scoring, and CSV/GeoJSON/Parquet export. County appraiser, permit and clerk systems remain adapter-driven because their interfaces vary by jurisdiction.

## Architecture

```text
Python collectors
      â†“
Immutable raw source archive + SHA-256 manifests
      â†“
DuckDB + partitioned Parquet spatial warehouse
      â†“
Normalization, address reconciliation and scoring
      â†“
Streamlit hunt, map and review UIX
      â†“
Reviewed CSV / Parquet / GeoJSON export
      â†“
Advertising campaign or consent-gated lead workflow
```

Phase 1 remains the control plane:

- `studio.sqlite` owns cases, runs, artifacts, observations, evidence and audit references.
- `property-market.duckdb` owns analytical property, permit, event, spatial-match and scored-result tables.
- Parquet provides partitioned snapshots and scalable interchange.
- Raw responses remain content-addressed local artifacts and are never overwritten by normalized values.

## Local layout

```text
~/.local/share/osint-dive-deep/property-intel/
â”œâ”€â”€ property-market.duckdb
â”œâ”€â”€ raw/<hunt_id>/<source>/<run_id>/
â”œâ”€â”€ parquet/properties/state=<state>/county=<county>/
â”œâ”€â”€ parquet/permits/authority=<authority>/
â”œâ”€â”€ parquet/events/event_type=<type>/year=<year>/
â”œâ”€â”€ exports/<hunt_id>/
â””â”€â”€ audit/actions.jsonl
```

## Hunt contract

Every hunt records:

- Hunt name and stable `hunt_id`
- State
- County or municipality
- ZIP codes
- Map-drawn or uploaded GeoJSON polygon
- Storm date range
- Event types
- Maximum event distance
- Property types
- Minimum building age
- Permit lookback period
- Maximum result count
- Case ID, creator, creation time and configuration hash

Supported hunt strategies:

1. State weather hunt
2. County hunt
3. ZIP-code hunt
4. Subdivision hunt
5. Map polygon hunt
6. Storm-event hunt
7. Uploaded-address hunt

Uploaded-address hunts are the first vertical slice because they allow the complete archive-to-review workflow to be proven without depending on a particular county portal.

## Collector design

Each collector implements a shared contract:

```text
describe()           capability, jurisdiction, source and access method
validate(hunt)       required scope and configuration checks
plan(hunt)           bounded tasks and estimated volume
collect(task)        exact raw bytes plus response metadata
normalize(asset)     typed source records without destroying raw values
checkpoint()         resumable cursor or page state
```

Collector families:

- Parcel and assessor records
- Permit authorities
- Storm and event records
- Address/geocoder services
- Public imagery metadata
- Uploaded CSV, JSON, Parquet and GeoJSON
- Browser-assisted permitted public systems without usable APIs

Every raw asset manifest contains `hunt_id`, `run_id`, collector, source URL, request method, retrieval time, status, media type, byte count, SHA-256, jurisdiction, configuration hash and normalization status.

Browser collectors use Playwright only for permitted public pages. They do not bypass authentication, CAPTCHAs, access controls or published usage restrictions.

## Warehouse tables

Core DuckDB tables:

- `hunts`
- `source_registry`
- `source_runs`
- `raw_assets`
- `property_records_raw`
- `properties_normalized`
- `permit_records`
- `event_records`
- `imagery_observations`
- `address_matches`
- `property_event_matches`
- `property_intel`
- `geo_capture_queue`
- `tax_import_batches`
- `tax_records`
- `permit_authority_registry`
- `permit_search_jobs`
- `analyst_reviews`
- `export_runs`
- `audit_log`

All normalized rows retain source record IDs and raw artifact references. Re-normalization creates a new version instead of rewriting the source record.

## Strong-intel output contract

| Field | Type | Meaning |
|---|---|---|
| `hunt_id` | string | Hunt that produced the record |
| `record_id` | string | Stable normalized result ID |
| `parcel_id` | string/null | Jurisdiction parcel identifier |
| `property_address` | string | Reviewed display address |
| `city` | string | City |
| `state` | string | State abbreviation |
| `zip` | string | ZIP code retained as text |
| `county` | string | County |
| `municipality` | string/null | Municipality |
| `latitude` | double/null | WGS84 latitude |
| `longitude` | double/null | WGS84 longitude |
| `property_type` | string/null | Normalized property class |
| `year_built` | integer/null | Best-supported construction year |
| `owner_name` | string/null | Exact public owner-of-record name retained for analyst verification |
| `owner_type` | string/null | Public-record owner category, not a demographic profile |
| `owner_occupancy_indicator` | string/null | Public-record occupancy signal with provenance |
| `permit_authority` | string/null | Permit jurisdiction/source |
| `roof_permit_found` | boolean/null | Whether a matching roof permit was found |
| `last_roof_permit_number` | string/null | Exact permit number |
| `last_roof_permit_date` | date/null | Most recent matching permit date |
| `last_roof_permit_status` | string/null | Permit status |
| `permit_match_confidence` | double | Explainable match confidence from 0 to 1 |
| `selected_event_id` | string/null | Selected nearby event |
| `selected_event_type` | string/null | Event type |
| `selected_event_date` | timestamp/null | Event time/date |
| `event_distance_km` | double/null | Geodesic property-to-event distance |
| `storm_exposure_score` | double | Event exposure component from 0 to 100 |
| `imagery_status` | string/null | Imagery availability/review state |
| `imagery_date` | date/null | Imagery capture date |
| `observable_condition` | string/null | Analyst-reviewed visible property condition |
| `property_opportunity_score` | double | Property-only opportunity score from 0 to 100 |
| `reason_codes` | string array | Machine-readable explanations |
| `review_status` | string | Review workflow state |
| `analyst_notes` | string | Local analyst notes |
| `recommended_activation` | string | Research, exclude, review, campaign or consent-gated recommendation |
| `source_count` | integer | Independent supporting source count |
| `retrieved_at` | timestamp | Latest source retrieval time |
| `score_generated_at` | timestamp | Score calculation time |
| `record_expires_at` | timestamp | Required refresh time |

Additional warehouse-only fields retain source IDs, artifact IDs, normalization version, address-match method, conflict flags and individual score components.

## Address and entity reconciliation

Address matching proceeds in stages:

1. Preserve the exact source address.
2. Normalize whitespace, unit markers, directionals, street suffixes, state and ZIP formatting.
3. Use parcel ID as the strongest jurisdiction-level key when present.
4. Use Census Geocoder results where supported.
5. Use RapidFuzz only for candidate ranking, never silent merging.
6. Require coordinate, ZIP, municipality or parcel corroboration for ambiguous matches.
7. Send low-confidence and conflicting matches to analyst review.

Every match stores its method, compared values, confidence, conflict flags and supporting source IDs.

## Spatial processing

- Store coordinates in WGS84 for exchange.
- Use DuckDB Spatial for SQL intersections, containment and buffers when installed.
- Use Shapely/GeoPandas for geometry validation and fallback processing.
- Calculate property-to-event geodesic distance in kilometers.
- Reject invalid polygons and explicitly resolve boundary behavior.
- Use QGIS for optional manual validation of parcels, event buffers and clusters.

## Explainable scoring

Default score components are configurable per hunt:

| Component | Default maximum |
|---|---:|
| Event proximity and exposure | 30 |
| Event type and recency | 20 |
| Building age | 20 |
| Relevant permit absence or age | 20 |
| Property-type fit and source quality | 10 |

Rules emit reason codes such as:

```text
EVENT_WITHIN_5_KM
EVENT_WITHIN_DATE_RANGE
BUILDING_AGE_OVER_20
NO_ROOF_PERMIT_IN_LOOKBACK
ROOF_PERMIT_MATCH_LOW_CONFIDENCE
PROPERTY_TYPE_MATCH
ADDRESS_REVIEW_REQUIRED
STALE_SOURCE
```

The score cannot use names, race, ethnicity, religion, disability, family status, health, income, credit, political affiliation or inferred demographic proxies. Missing evidence reduces confidence; it is not treated automatically as evidence of opportunity.

## Analyst UIX

The Streamlit workbench has six stages:

1. **Define Hunt** — strategy and required hunt fields.
2. **Select Sources** — jurisdiction coverage, access method, freshness and expected volume.
3. **Collect and Normalize** — resumable progress, raw archive, failures and record counts.
4. **Map and Score** — drawn polygon, parcels, event buffers, clusters and reason-code filters.
5. **Review** — exact provenance, permit/event evidence, conflicts, notes and bulk disposition.
6. **Export** — reviewed CSV, Parquet or GeoJSON with an export manifest.

Review states:

```text
unreviewed
needs-research
qualified
excluded
approved-for-export
expired
```

## Activation boundary

- Default exports include only `approved-for-export` records.
- Every export records hunt configuration, filters, analyst, timestamp, row count and source versions.
- Suppression and exclusion states survive refreshes.
- Outreach systems are downstream; this layer does not send messages automatically.
- B2C activation is consent-gated where the downstream workflow requires consent.
- Exact property evidence remains local even when a reduced campaign export is produced.

## Technology tiers

### Core runtime

- DuckDB
- Polars, Pandas and PyArrow
- Pydantic Settings
- RapidFuzz
- Shapely

### Spatial and review

- DuckDB Spatial
- GeoPandas and GDAL
- PyDeck or Folium with a drawing control
- QGIS as an external Kali analyst tool

### Collection and orchestration

- Requests-based API/file collectors
- Playwright for permitted browser-assisted sources
- Prefect for local scheduling, retries and execution history

Heavy spatial, browser and orchestration dependencies remain optional extras so the existing Studio installation stays lean.

## Implementation slices

### 1.1A — Contracts and warehouse

- Add property settings, hunt models, schemas and source registry.
- Initialize DuckDB and Parquet directories.
- Link hunts and source runs to Phase 1 case/run IDs.

### 1.1B — First vertical slice

- Implement uploaded-address and uploaded-property collectors.
- Archive exact uploads and manifests.
- Normalize addresses and produce a reviewable property table.

### 1.1C — Public-source collectors

- Add parcel, permit and event collector adapters.
- Add jurisdiction capability metadata, rate limits and checkpoints.
- Add Playwright adapters only when no usable permitted API/file source exists.

### 1.1D — Spatial matching and scoring

- Add polygon, ZIP, subdivision, county and event-distance filters.
- Add permit reconciliation and transparent reason-code scoring.
- Write versioned Parquet snapshots.

### 1.1E — Analyst UIX and export

- Add the hunt wizard, map drawing, run monitor, evidence review and dispositions.
- Add reviewed CSV, Parquet and GeoJSON exports plus manifests.

### 1.1F — Local operations

- Add Prefect-backed scheduling and retries.
- Add refresh/expiry workflows, JSONL audit logs and DuckDB audit views.
- Benchmark large hunts and document QGIS validation workflows.

## Acceptance criteria

- An uploaded-address hunt completes archive → normalize → score → review → GeoJSON/CSV export locally.
- Re-running normalization never alters the raw source artifact.
- Every output row resolves to source records and SHA-256 artifacts.
- Polygon and event-distance results are reproducible.
- Every score exposes components and reason codes.
- Ambiguous addresses and permit matches enter review instead of merging silently.
- Only reviewed records enter the default activation export.
- No protected or inferred demographic attribute influences scoring.
- A stopped hunt resumes without duplicating raw assets or normalized records.
