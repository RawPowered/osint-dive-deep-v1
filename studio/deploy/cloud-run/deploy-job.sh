#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT}"
REGION="${GOOGLE_CLOUD_REGION:-us-east1}"
JOB_NAME="${DIVEDEEP_CLOUD_RUN_JOB:-divedeep-divedeep}"
REPOSITORY="${DIVEDEEP_ARTIFACT_REPOSITORY:-divedeep}"
IMAGE_DIGEST="${DIVEDEEP_IMAGE_DIGEST:?Set DIVEDEEP_IMAGE_DIGEST to the sha256 digest emitted by build.sh}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/divedeep-worker@${IMAGE_DIGEST}"
SERVICE_ACCOUNT="${DIVEDEEP_WORKER_SERVICE_ACCOUNT:?Set DIVEDEEP_WORKER_SERVICE_ACCOUNT}"
API_ORIGIN="${DIVEDEEP_API_ORIGIN:?Set DIVEDEEP_API_ORIGIN}"
WORKER_PATH="${DIVEDEEP_WORKER_API_PATH:-/api/workers/v1}"

gcloud run jobs deploy "$JOB_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$SERVICE_ACCOUNT" \
  --tasks 1 \
  --parallelism 1 \
  --max-retries "${DIVEDEEP_MAX_RETRIES:-0}" \
  --task-timeout "${DIVEDEEP_TASK_TIMEOUT:-3600s}" \
  --cpu "${DIVEDEEP_CPU:-2}" \
  --memory "${DIVEDEEP_MEMORY:-4Gi}" \
  --binary-authorization "${DIVEDEEP_BINARY_AUTHORIZATION_POLICY:-default}" \
  --labels "component=divedeep-worker,release=5-29-0,packaging-revision=2026-07-28-gcp-rc1" \
  --set-env-vars "DIVEDEEP_API_ORIGIN=${API_ORIGIN},DIVEDEEP_WORKER_API_PATH=${WORKER_PATH},DIVEDEEP_WORKER_HEARTBEAT_SECONDS=60,DIVEDEEP_JOB_TIMEOUT_SECONDS=900,DIVEDEEP_UPLOAD_RECON_OUTPUT=false,DIVEDEEP_MAX_IMAGE_ARTIFACTS=20"
