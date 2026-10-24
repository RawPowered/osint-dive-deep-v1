# Tax Record Ingestion and Permit Routing

The **Tax & Permits** tab is the local ingestion and jurisdiction-routing stage for Property Intel. Florida DOR is the first state adapter; the warehouse schema is state-aware so later adapters can normalize other states without changing reviewed property exports.

## Florida DOR import

Upload an original ZIP package or an extracted CSV/TXT file. Studio:

1. Archives the exact uploaded bytes as case evidence.
2. Reads ZIP members in memory without extracting them into the project directory.
3. Processes CSV rows in bounded chunks.
4. Detects the roll from its schema and `FILE_T` value.
5. Upserts normalized tax records while retaining every populated source field as JSON plus the archive member and source row number.
6. Promotes eligible NAL records into Property Review when requested.

The supported Florida lanes are intentionally distinct:

| Roll | `FILE_T` | Meaning | Property-review behavior |
|---|---:|---|---|
| NAL | `R` | Real property, parcel, owner, situs, building and valuation fields | May promote parcel ID, owner of record, situs address, DOR use code and actual/effective year built |
| NAP | `P` | Tangible personal property accounts | Retained as account intelligence; `ACCT_ID` is not treated as a house parcel ID |
| SDF | `S` | Real-property sale records | Retained for later parcel/sale reconciliation |

Large county files remain subject to available workstation memory because Streamlit receives an upload before the chunked importer begins. Original DOR ZIPs are preferred. The local upload ceiling is 1 GB.

## Permit registry

Seven strictly verified parcel-capable entry points are built in: Temple Terrace, Hillsborough County, Clay County, Lee County, Martin County, Pasco County and Polk County. JSON or CSV registry uploads can add the supplied 67-county audit, unresolved gaps and municipal override candidates. Registry uploads are archived before their normalized routes are upserted.

Verification states remain explicit. `LIKELY_PARCEL`, `PORTAL_ONLY` and `NO_CONFIRMED_PARCEL_PORTAL` entries do not become verified merely because they have a URL.

## Municipal-first routing

A mailing or situs city string is not accepted as proof of permitting jurisdiction. Before a job becomes browser-ready, the analyst must choose a route and record one of these bases:

- Parcel/municipal geometry confirmed the authority.
- Analyst confirmed the incorporated municipality.
- Analyst confirmed county or unincorporated authority.

If authority is unresolved, the job stays `pending-jurisdiction`; it does not fall through to the county portal. For Temple Terrace the intended sequence is Hillsborough parcel → incorporated-boundary decision → Temple Terrace override → Click2Gov parcel search.

## Browser jobs and evidence

Permit jobs retain the original parcel identifier plus conservative exact, punctuation-stripped and digits-only variants. The portal opens as an interactive browser entry point—no query parameter is appended unless a route explicitly supports one. The analyst records the exact identifier that produced a match, result URL, DOM/screenshot capture ID and notes.

For the documented 22-character Hillsborough compact form, the Temple Terrace route also prepares explicit range, township, section, subdivision, block, lot and municipality components. Shorter or nonconforming HCPA values are held for manual format review rather than guessed.

An empty result is always `NO_ACCESSIBLE_MATCH`. This means the configured public workflow returned no accessible match; it is not a finding that the property has no permits and never sets `roof_permit_found` to false. A roof-permit conclusion requires an actual matching record or separately documented authoritative confirmation.
