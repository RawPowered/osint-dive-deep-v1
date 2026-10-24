# DiveDeep Image Recon Phase 3

Version: DiveDeep 5.24.0

Phase 3 adds a size-aware local result package for reviewed DiveDeep evidence.

## Purpose

The normal DiveDeep result packet is convenient for small cases but can become too large when a customer has many reviewed findings. Evidence images must also remain outside JSON. Phase 3 therefore exports:

```text
divedeep-result-bundle-<customer>-<batch>.zip
â”œâ”€â”€ manifest.json
â”œâ”€â”€ findings/
â”‚   â”œâ”€â”€ findings-0001.json
â”‚   â”œâ”€â”€ findings-0002.json
â”‚   â””â”€â”€ ...
â””â”€â”€ evidence/
    â”œâ”€â”€ ev_<id>.jpg
    â””â”€â”€ ...
```

The ZIP is a local transportation container. It is not yet uploaded directly to the public DiveDeep server. Phase 4 will add the admin-side multi-file upload queue.

## JSON segmentation

The default balanced profile targets 512 KB per part and enforces a 1 MB hard limit. No part contains more than 100 findings. The interface also provides conservative and large profiles.

Each part remains a valid `divedeep.recon-results` packet and includes:

- customer and protected-profile identity
- batch ID
- part number and total part count
- recalculated summary
- only the findings assigned to that part

DiveDeep local database IDs are removed from exported findings.

## Evidence handling

Evidence remains separate from JSON. DiveDeep resolves local `divedeep://artifact/...` references, copies each artifact once, calculates SHA-256, and creates manifest mappings to every related finding key.

Limits:

- 25 MB per evidence file
- 1,000 evidence files per bundle
- 500 MB combined evidence data per bundle

Duplicate artifacts are included once and may reference multiple findings.

## Export scopes

- **This Image Recon session:** only candidates explicitly promoted from the selected image-recon session.
- **All reviewed workspace findings:** promoted image evidence plus reviewed non-image findings, excluding ignored and false-positive records.

## Operator workflow

1. Complete candidate review and promote approved evidence.
2. Open **DiveDeep Image Recon → Export Bundle**.
3. Select the export scope and JSON size profile.
4. Build the segmented result bundle.
5. Download the ZIP and keep it private.
6. Do not upload the ZIP to DiveDeep yet. Phase 4 will provide the controlled manifest/JSON/evidence upload queue.
