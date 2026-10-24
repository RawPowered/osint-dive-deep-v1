# Amazon Rekognition Security Contract

## Credential hierarchy

1. `default_provider_chain`: preferred when the API runtime has an attached AWS identity.
2. `assume_role`: preferred for cross-account access and externally hosted API runtimes.
3. `static_keys`: encrypted fallback only.

Credentials entered in the DiveDeep admin are encrypted by the existing secret-box service and are never returned by administrative APIs. The admin receives only configured-state flags and masked hints.

## Least privilege

The runtime identity should be limited to the operations enabled for DiveDeep:

- `rekognition:DetectFaces`
- `rekognition:CompareFaces`
- `rekognition:DetectModerationLabels`
- `rekognition:DetectText`
- `rekognition:DetectLabels`

When temporary AWS S3 staging is enabled, restrict `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` to the configured bucket prefix.

The Phase 1.1 code does not call collection or indexing APIs.

## Data handling

- Image bytes are not stored in relational tables.
- Normalized provider results are encrypted before database persistence.
- Customer presentation feeds omit raw provider responses and similarity details.
- Candidate thumbnails are represented by artifact IDs and remain blurred by default.
- Sentinel logs operation metadata, status, duration, region, and provider request IDs, but not image bytes, credentials, presigned URLs, detailed landmarks, or raw response bodies.

## Human-review controls

- `CompareFaces` forces `humanReviewRequired=true`.
- `autoConfirm=true` is rejected.
- Similarity alone cannot automatically reject, publish, retain, or trigger removal.
- Customer validation is allowed only after reviewer escalation and only above the profile's reviewer-confidence floor.

## Retention

Default declarations:

- Rejected/nonmatching candidate records: 24 hours
- Pending review/customer validation: 30 days
- Confirmed relevant evidence: case policy

Phase 1.1 stores these declarations and expiration timestamps. The object-storage lifecycle and deletion worker are scheduled for the later artifact/retention phase.
