# DiveDeep Phase 2

Phase 2 revises the existing DiveDeep admin into an operations-first privacy workflow and introduces Google Cloud Run Jobs as the disposable DiveDeep execution provider.

## Included

- Persisted workflow gates
- API-owned recon jobs and event history
- Versioned worker pools
- Cloud Run integration and access verification
- Cloud Run long-running-operation recovery
- Pool capacity accounting
- Work, review, cases, monitoring, and retention queues
- Existing evidence-review and customer-validation preparation

## Not included yet

- DiveDeep Cloud Run container image
- Worker OIDC callback API
- Source-attempt ingestion
- Object-storage artifacts
- Retention deletion worker
- Customer frontend changes

Live dispatch is disabled by default.
