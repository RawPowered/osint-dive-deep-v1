# Cloud Run Jobs Security Contract

## Execution model

- One DiveDeep recon job maps to one Cloud Run Job execution.
- Phase 2 enforces exactly one task per execution.
- The worker will receive an opaque job ID and retrieve authorized work from the API in a later phase.
- The Cloud Run execution must not own durable customer or case data.

## Credentials

Preferred:

- Application Default Credentials
- Workload identity or an attached service account

Fallback:

- Encrypted service-account JSON stored through the DiveDeep integration vault

Permanent worker API credentials are prohibited. The later worker API will validate Google-issued OIDC identity and issue job-scoped access.

## Runtime overrides

Only these non-secret values are sent to the Cloud Run execution:

```text
DIVEDEEP_RECON_JOB_ID
DIVEDEEP_API_ORIGIN
DIVEDEEP_WORKER_MODE
DIVEDEEP_WORKER_POOL_VERSION_ID
```

## Safe activation sequence

1. Build and publish the DiveDeep worker image.
2. Create the Cloud Run Job with a restricted service identity.
3. Implement and validate the worker callback protocol.
4. Configure the integration and verify access.
5. Publish a worker-pool version.
6. Enable dispatch first at the integration, then at the pool version.
7. Run one controlled authorized case.
