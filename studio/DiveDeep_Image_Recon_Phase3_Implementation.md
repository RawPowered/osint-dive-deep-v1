# DiveDeep Image Recon Phase 3 Implementation

## Baseline

- DiveDeep FID WebUI v5.23.0
- DiveDeep backend v1.5.0 remains unchanged in Phase 3
- No live customer bundle, evidence, or public-server import was used during implementation

## Delivered workflow

```text
Reviewed DiveDeep findings
→ choose Image Session or Entire Workspace scope
→ resolve DiveDeep evidence artifacts
→ remove local-only record IDs
→ split findings into bounded JSON packets
→ create SHA-256 manifest
→ copy evidence as separate files
→ generate private local transport ZIP
```

## New WebUI stage

Open:

```text
Protection & System
â””â”€â”€ DiveDeep Image Recon
    â””â”€â”€ Export Bundle
```

The operator can select:

- **This Image Recon session**: exports only candidates promoted from the active session.
- **All reviewed workspace findings**: exports all non-ignored, non-false-positive findings in the linked DiveDeep workspace.

JSON profiles:

- Conservative: target 256 KB, hard 512 KB
- Balanced: target 512 KB, hard 1 MB
- Large: target 768 KB, hard 1 MB

Every part is also capped at 100 findings.

## Bundle structure

```text
divedeep-result-bundle-<customer>-<batch>.zip
â”œâ”€â”€ manifest.json
â”œâ”€â”€ findings/
â”‚   â”œâ”€â”€ findings-0001.json
â”‚   â”œâ”€â”€ findings-0002.json
â”‚   â””â”€â”€ ...
â””â”€â”€ evidence/
    â”œâ”€â”€ ev_<stable-id>.jpg
    â”œâ”€â”€ ev_<stable-id>.png
    â””â”€â”€ ...
```

## Manifest

The manifest records:

- batch, customer, profile, and image-session identity
- export scope
- part count and finding count
- part filenames, SHA-256, byte sizes, and finding keys
- evidence filenames, SHA-256, MIME types, byte sizes, sensitivity, and related finding keys
- active segmentation limits

## Evidence behavior

- Images and screenshots are never embedded in JSON.
- `divedeep://artifact/...` references are resolved through the existing CaseStore.
- Duplicate artifacts are copied only once.
- One evidence file can map to multiple findings.
- DiveDeep-local database IDs are removed from findings.
- Missing or metadata-only evidence remains represented in JSON without inventing a file.

Safety limits:

- 25 MB per evidence file
- 1,000 evidence files per bundle
- 500 MB total evidence per bundle

## Phase 4 boundary

This ZIP is intentionally a local transportation container. The current DiveDeep public server should not ingest it directly.

Phase 4 will add:

1. Admin multi-file/folder selection
2. Manifest validation
3. Ordered JSON-part import
4. Per-file evidence upload queue
5. Finding-key to exposure mapping
6. Retry, progress, hash validation, and staged publication
