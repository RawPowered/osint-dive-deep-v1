# DiveDeep Google Cloud release candidate

Packaging revision: `2026-07-28-gcp-rc1`

This source pack is prepared for a controlled Google Cloud Build and Cloud Run Jobs staging deployment. It is not approved for production promotion until the live checks below are complete.

## Release controls

- Python base image is pinned by OCI digest.
- Core, Sherlock, and Maigret dependency graphs are fully resolved and hash locked.
- Maigret is isolated from the core environment because its upstream graph constrains Beautiful Soup below the current core version.
- Artifact Registry repository creation enables immutable tags.
- Cloud Build labels the image with the source-manifest SHA-256.
- Cloud Run deploys the image by digest, never by a mutable tag.
- The job defaults to `us-east1`, name `divedeep-divedeep`, one task, parallelism one, and zero platform retries.
- Binary Authorization is enabled with the default policy unless an explicit policy is supplied.
- The container runs as UID/GID `10001` and uses `/tmp` for job-scoped state.

## Required Google Cloud resources

Use separate projects or rigorously isolated resources for staging and production:

- Artifact Registry Docker repository with immutable tags;
- Cloud Build service account allowed to build and push only to the selected repository;
- dedicated Cloud Run Job service account with least-privilege outbound and logging access;
- operator/deployer identity allowed to update the named job;
- Binary Authorization policy and attestor configuration appropriate to the environment;
- Cloud Logging retention and alerting;
- VPC egress controls if the API or policy requires them.

Do not store permanent DiveDeep credentials in the job definition. The backend supplies the job ID, execution ID, worker-pool version, and single-use bootstrap token as execution overrides. Treat Cloud Run job configuration and environment variables as operator-visible configuration.

## Build

From the DiveDeep source directory:

```bash
export GOOGLE_CLOUD_PROJECT="divedeep-staging-project"
export GOOGLE_CLOUD_REGION="us-east1"
export DIVEDEEP_ARTIFACT_REPOSITORY="divedeep"
export DIVEDEEP_IMAGE_TAG="5.29.0-gcp.1"
./deploy/cloud-run/build.sh
```

Record the emitted `digest=` and `deploy_ref=` values in the deployment record. The build script hashes `FILE_MANIFEST_SHA256.txt` and injects that identity into the OCI revision label.

## Deploy

```bash
export GOOGLE_CLOUD_PROJECT="divedeep-staging-project"
export GOOGLE_CLOUD_REGION="us-east1"
export DIVEDEEP_CLOUD_RUN_JOB="divedeep-divedeep"
export DIVEDEEP_WORKER_SERVICE_ACCOUNT="worker@project.example.invalid"
export DIVEDEEP_IMAGE_DIGEST="sha256:REPLACE_WITH_BUILD_OUTPUT"
export DIVEDEEP_API_ORIGIN="https://api-staging.example.invalid"
./deploy/cloud-run/deploy-job.sh
```

Replace all sample values. The deployment helper will refuse to proceed without an image digest.

## Controlled live test gate

Keep backend dispatch disabled while configuring and reading the job. Then:

1. Confirm the Cloud Run job reads back with the expected digest, service account, region, one task, parallelism one, zero retries, and Binary Authorization policy.
2. In DiveDeep admin, configure worker version `5.29.0` and protocol `divedeep-worker-v1`.
3. Publish only the staging worker pool.
4. Enable staging dispatch for one authorized synthetic or controlled pilot job.
5. Confirm bootstrap exchange, lease, heartbeats, checkpoints, result submission, private artifact transfer, cleanup acknowledgement, and process exit.
6. Confirm no durable job data remains in the task and no automatic retry occurs.
7. Review logs, egress, cost, timeout, IAM denials, and alert behavior.
8. Disable dispatch immediately if cleanup, token scope, artifact privacy, or version gating deviates.

## Promotion evidence

Production promotion requires the source-manifest hash, Cloud Build ID, Artifact Registry digest, Binary Authorization result, deployed job revision, live-test job ID, cleanup acknowledgement, operator approval, and rollback reference.

No local build, import, execution, or test was performed for this packaging revision.
