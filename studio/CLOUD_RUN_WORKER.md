# DiveDeep 5.29 Cloud Run worker

This distribution adds a headless, single-use worker mode for DiveDeep.

## Lifecycle

1. Cloud Run starts one task.
2. The worker exchanges the one-time bootstrap token for a short-lived job token.
3. It receives the immutable authorized job manifest.
4. It creates a private workspace under `/tmp`.
5. It runs only the generated, allowlisted DiveDeep jobs.
6. It resumes completed source jobs from the latest API checkpoint when a replacement execution is dispatched.
7. It sends heartbeats, source attempts, checkpoints, and candidate metadata to DiveDeep.
8. Reference images are downloaded only through job-scoped, short-lived private grants.
9. Bounded public image candidates are normalized, stripped of metadata, uploaded as private review images, and paired with strongly blurred analysis-wall thumbnails.
10. Optional recon-output files use worker-scoped direct object-storage uploads.
11. It submits completion, receives a cleanup-only token, removes the whole workspace, confirms zero bytes remain, and exits.

The worker does not run Streamlit, FastAPI, SQLite queues, or a persistent case-management service.

## Required execution variables

- `DIVEDEEP_API_ORIGIN`
- `DIVEDEEP_RECON_JOB_ID`
- `DIVEDEEP_RECON_EXECUTION_ID`
- `DIVEDEEP_WORKER_POOL_VERSION_ID`
- `DIVEDEEP_WORKER_BOOTSTRAP_TOKEN`

The final four are supplied by DiveDeep when it starts a Cloud Run Job execution. Do not place permanent DiveDeep credentials in the Cloud Run Job definition.

## Build and deploy

Use `deploy/cloud-run/build.sh`, record the emitted image digest, set `DIVEDEEP_IMAGE_DIGEST`, then use `deploy/cloud-run/deploy-job.sh`. The build uses `cloudbuild.cloudrun.yaml` so the nonstandard `Dockerfile.cloudrun` name is explicit. The deploy helper requires a digest and defaults to the backend-compatible `us-east1` / `divedeep-divedeep` job identity. Dispatch remains disabled in DiveDeep until the integration and published worker pool are deliberately enabled.

The Cloud Run Job defaults to zero platform retries. A consumed bootstrap token cannot be reused safely by an automatic task retry. DiveDeep recovers expired leases and creates a new execution with a new bootstrap token; the replacement worker resumes from API-held checkpoints.

The release image uses hash-locked dependencies in three isolated virtual environments and a digest-pinned Python base. See `DEPENDENCY_PROVENANCE.md` and `GOOGLE_CLOUD_RELEASE.md`.

## Current boundaries

The worker includes direct private artifact upload, reference-image input grants, and bounded candidate-image capture for indexed image results. Candidate files are re-encoded as JPEG to remove embedded metadata; separate blurred thumbnails are produced for the future analysis wall. Raw recon-output upload remains disabled by default. Live Rekognition calls remain deferred until the package-specific image-analysis execution adapter is connected.
