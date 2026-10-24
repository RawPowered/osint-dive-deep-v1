# Privacy Removal Studio

DiveDeep's Privacy Removal Studio turns reviewed public-profile findings into authorized, one-at-a-time privacy requests. It is local workflow software: it does not silently submit requests, mass-email companies, store identity documents, or ingest intimate media.

## Workflow

1. Create a case for the individual or their explicitly authorized agent.
2. Add exact reviewed listing URLs and the company's published privacy/abuse destination.
3. Select an industry-aware template and the specific requested actions.
4. Confirm any jurisdiction-specific legal basis before it is inserted, then edit the complete request.
5. Download a standards-compatible `.eml`, open it in the local mail client, or open the company's web form.
6. Mark the request sent only after the operator submits it.
7. Record acknowledgements, decisions, reference numbers and verification rescans.
8. Export the complete case packet or reviewed findings CSV.

## Guardrails

- Every case requires a self/authorized-agent affirmation and date.
- Collect only the identity fields needed to locate and verify the listing.
- Keep identity documents outside DiveDeep; use a verified secure company channel if requested.
- Legal-basis presets are editable and require an applicability confirmation before use.
- Unverified recipient destinations require explicit acknowledgement.
- There is no bulk-send control. Delivery is an explicit one-request handoff.
- Adult-industry requests are URL-only. Never attach or archive intimate media.
- Content depicting the subject while under 18 is routed to NCMEC Take It Down or the CyberTipline; DiveDeep will not draft or store that content.
- A missing or rejected response is not recorded as successful removal. Re-check the exact URL and record the result.

## Local data

The SQLite database is stored under the configured DiveDeep data root at:

`privacy-removal/privacy-removal.sqlite`

On Kali/POSIX, DiveDeep creates the directory with mode `0700` and database with mode `0600`. Override the root with `OSINT_STUDIO_DATA_DIR` if needed.

## Official resources

- California DROP: <https://privacy.ca.gov/drop/>
- California privacy rights: <https://oag.ca.gov/privacy/ccpa>
- EU data-protection rights: <https://commission.europa.eu/digital-life/protecting-your-data-and-privacy_en>
- UK ICO erasure guidance: <https://ico.org.uk/for-organisations/law-enforcement/guide-to-le-processing/individual-rights/the-right-to-erasure-and-the-right-to-restriction/>
- StopNCII: <https://stopncii.org/>
- NCMEC Take It Down: <https://takeitdown.ncmec.org/>
- NCMEC CyberTipline: <https://report.cybertip.org/>
