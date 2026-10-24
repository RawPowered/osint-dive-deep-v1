#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT}"
REGION="${GOOGLE_CLOUD_REGION:-us-east1}"
REPOSITORY="${DIVEDEEP_ARTIFACT_REPOSITORY:-divedeep}"
IMAGE_TAG="${DIVEDEEP_IMAGE_TAG:-5.29.0-gcp.1}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/divedeep-worker:${IMAGE_TAG}"
sha256sum --check FILE_MANIFEST_SHA256.txt
SOURCE_SHA256="$(sha256sum FILE_MANIFEST_SHA256.txt | awk '{print $1}')"

gcloud artifacts repositories describe "$REPOSITORY" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPOSITORY" \
    --repository-format=docker \
    --immutable-tags \
    --location "$REGION" \
    --project "$PROJECT_ID"

gcloud builds submit \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --config cloudbuild.cloudrun.yaml \
  --substitutions "_IMAGE=$IMAGE,_SOURCE_SHA256=$SOURCE_SHA256" \
  .

IMAGE_DIGEST="$(gcloud artifacts docker images describe "$IMAGE" --project "$PROJECT_ID" --format='value(image_summary.digest)')"
printf 'image=%s\n' "$IMAGE"
printf 'digest=%s\n' "$IMAGE_DIGEST"
printf 'deploy_ref=%s@%s\n' "${IMAGE%:*}" "$IMAGE_DIGEST"
