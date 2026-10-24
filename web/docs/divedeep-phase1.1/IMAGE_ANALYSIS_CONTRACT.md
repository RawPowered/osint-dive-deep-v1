# Provider-Neutral Image Analysis Contract

A published package version may reference one published image-analysis profile version.

```text
Package version
  -> Source-set version
  -> Image-analysis profile version
  -> Immutable execution manifest
```

## Operations

- Face/reference quality assessment
- Candidate face comparison
- Optional sensitive-content triage
- Optional text/watermark extraction
- Optional broad context labels

## Review bands

- `low_priority`
- `manual_review`
- `high_priority`

These bands prioritize review; they do not determine identity.

## Item lifecycle

```text
discovered
  -> analyzing
  -> likely_match
  -> reviewer_confirmed
  -> customer_validation_requested
  -> customer_confirmed
  -> rejected
  -> expired
```

The actual branch depends on reviewer disposition. `customer_validation_requested` is reserved for plausible candidates that are not strong enough for reviewer confirmation but meet the profile's minimum reviewer-confidence requirement.

## Customer-safe routes

The API is prepared for a later frontend without exposing raw provider data:

- `GET /divedeep/api/image-analysis/sessions`
- `GET /divedeep/api/image-analysis/sessions/:sessionId`
- `POST /divedeep/api/image-analysis/items/:itemId/validation`

Customer dispositions:

- `confirmed`
- `not_me`
- `unsure`

The validation endpoint requires an authenticated customer session and CSRF protection, verifies item ownership, and records an auditable event.

## Worker manifest

The existing DiveDeep customer packet now includes the resolved `imageAnalysis` policy with provider, profile/version, operations, thresholds, limits, quality rules, review requirements, retention declarations, and presentation behavior.
