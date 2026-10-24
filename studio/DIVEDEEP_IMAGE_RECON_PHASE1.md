# DiveDeep Image Recon — Phase 1

## Operator flow

1. Import the customer's normal DiveDeep JSON packet under **DiveDeep Workflow**.
2. In DiveDeep Admin, download **Image Recon Bundle**.
3. Open **DiveDeep Image Recon** in DiveDeep.
4. Upload the ZIP and review the manifest preview.
5. Click **Import and prepare images**.
6. Review the prepared originals, normalized derivatives, thumbnails, and local hashes.

## Local layout

```text
divedeep-workspaces/<customer-id>/image-recon/<session-id>/
â”œâ”€â”€ intake/manifest.json
â”œâ”€â”€ references/
â”‚   â”œâ”€â”€ originals/
â”‚   â”œâ”€â”€ normalized/
â”‚   â””â”€â”€ thumbnails/
â”œâ”€â”€ candidates/
â”œâ”€â”€ evidence/
â”œâ”€â”€ raw/
â”œâ”€â”€ exports/
â”œâ”€â”€ search-queue.json
â””â”€â”€ session.json
```

## Validation controls

- Expected packet type and schema
- Active authorization
- Exact customer and profile binding
- Maximum 20 images
- Maximum 5 MB per image
- Maximum 75 MB expanded bundle
- No absolute paths, path traversal, symbolic links, encrypted entries, or undeclared files
- JPEG, PNG, and WebP signature verification
- Full SHA-256 verification against the DiveDeep manifest
- Safe image decoding and a 40-megapixel processing ceiling

## Phase boundary

Phase 1 prepares verified, provider-ready images. Reverse-image provider execution, candidate comparison, verdicts, and result-bundle upload are intentionally reserved for Phase 2.
