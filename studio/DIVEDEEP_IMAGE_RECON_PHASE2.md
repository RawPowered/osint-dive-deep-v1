# DiveDeep Image Recon — Phase 2

## Objective

Turn prepared reference images into a controlled human-reviewed candidate workflow. Phase 2 does not automate identity decisions and does not treat visual similarity as proof.

## Operator flow

1. Open **DiveDeep Image Recon** and select an imported image session.
2. Under **Search Queue**, download the EXIF-stripped derivative.
3. Open one of the fixed reverse-image providers and upload the derivative.
4. Track the provider as Started, Completed, Blocked, or Skipped.
5. Under **Candidate Capture**, enter the public source page URL and upload the downloaded candidate image.
6. Optionally attach a screenshot showing the page context, username, name, or source.
7. Under **Candidate Review**, compare the reference and candidate side-by-side.
8. Record visual similarity, corroborating identity signals, operator confidence, and a verdict.
9. Under **Confirmed Evidence**, promote only confirmed, preserved, or intentionally published inconclusive candidates.
10. Open the standard **DiveDeep Workflow** to finish request preparation and export.

## Verdict controls

- **Confirmed Match**: strong enough to become a confirmed DiveDeep exposure.
- **Not This Person**: retained locally as review history and never exported.
- **Inconclusive**: remains local unless the operator explicitly publishes it for customer review.
- **Preserve**: documents an intentional public profile without creating a removal target.
- **Duplicate**: exact candidate-image duplicate; never exported.
- **Pending Review**: no decision yet.

## Evidence rules

- The authorized reference image is not published as discovered evidence.
- Candidate images and page screenshots remain under the private customer workspace.
- Only a deliberate promotion sends normalized evidence references into the standard DiveDeep result packet.
- Local aHash and dHash measurements indicate near-duplicate structure only. They are not face recognition and do not establish identity.
- A confirmed verdict should use image comparison plus corroborating name, username, location, or page context whenever available.

## Local layout additions

```text
image-recon/<session-id>/
â”œâ”€â”€ candidates.json
â”œâ”€â”€ candidates/
â”‚   â”œâ”€â”€ files/
â”‚   â”œâ”€â”€ normalized/
â”‚   â””â”€â”€ thumbnails/
â””â”€â”€ evidence/
    â””â”€â”€ page-screenshots/
```

## Phase boundary

Phase 2 completes local provider tracking, candidate review, and promotion into the existing DiveDeep evidence feed. Segmented result bundles and queued evidence-file uploads to the public DiveDeep admin portal remain Phase 3 and Phase 4 work.
