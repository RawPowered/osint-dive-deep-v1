# DiveDeep Phase 1.1: Assisted Image Analysis

Phase 1.1 adds Amazon Rekognition as an optional, consent-gated image-analysis provider inside the existing DiveDeep admin on the API subdomain.

It does not modify the customer frontend and does not create a separate DiveDeep administration surface.

## Included

- Encrypted Rekognition credentials through the existing integration vault
- Default provider chain, assume-role, and static-key credential modes
- Region and temporary S3 staging configuration
- Operation allowlists and call budgets
- Versioned image-analysis profiles linked to package versions
- Provider-neutral package manifests for future DiveDeep workers
- Blurred analysis-wall presentation contracts
- Reviewer confirmation and customer-validation escalation
- Customer-safe session/feed/validation API contracts
- Encrypted normalized provider results
- Sentinel control actions and integration audit events

## Deliberately excluded

- Rekognition face collections
- Persistent provider-side face vectors
- Automatic identity confirmation
- Automatic removal requests based on similarity scores
- Customer frontend implementation
- Live AWS calls during build validation
- DiveDeep worker execution
- Final object-storage implementation

## Core rule

Rekognition supplies review assistance. A score is never treated as proof. Face-comparison candidates require human review, and lower-confidence-but-plausible candidates may be sent to the authenticated customer for validation only when the package profile permits it.
