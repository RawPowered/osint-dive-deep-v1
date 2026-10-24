# Phase 2 Admin API Contract

All routes are part of the existing API-admin application and use its session, RBAC, CSRF, no-store, and Sentinel controls.

## Operations

```text
GET /api/divedeep/operations/overview
GET /api/divedeep/work-queue
GET /api/divedeep/review-queue
GET /api/divedeep/case-queue
GET /api/divedeep/monitoring-queue
GET /api/divedeep/retention-queue
```

## Workflow gates

```text
GET  /api/divedeep/customers/:customerId/workflow-gates
POST /api/divedeep/customers/:customerId/workflow-gates/evaluate
```

## Recon jobs

```text
GET  /api/divedeep/recon-jobs
GET  /api/divedeep/recon-jobs/:jobId
POST /api/divedeep/customers/:customerId/recon-jobs
POST /api/divedeep/recon-jobs/:jobId/dispatch
POST /api/divedeep/recon-jobs/:jobId/sync
POST /api/divedeep/recon-jobs/:jobId/cancel
```

Dispatch and cancellation require root-admin access. Job creation and gate evaluation require an authorized admin session and CSRF token.

## Worker pools

```text
GET   /api/divedeep/worker-pools
POST  /api/divedeep/worker-pools
POST  /api/divedeep/worker-pools/:poolId/versions
PATCH /api/divedeep/worker-pool-versions/:versionId
POST  /api/divedeep/worker-pool-versions/:versionId/publish
```

Published versions are immutable.

## Cloud Run integration

The existing generic integration endpoints manage `google_cloud_run`:

```text
GET  /api/divedeep/integrations
PUT  /api/divedeep/integrations/google_cloud_run
POST /api/divedeep/integrations/google_cloud_run/verify
```

Additional status/access routes are exposed by the Phase 2 admin router. Saved service-account JSON is encrypted and never included in responses.
