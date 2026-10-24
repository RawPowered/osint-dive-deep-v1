#!/usr/bin/env bash
set -Eeuo pipefail

ALLOW_DRAINING=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-draining) ALLOW_DRAINING=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

ENV_FILE="${DIVEDEEP_ENV_FILE:-/etc/divedeep/divedeep.env}"
[[ -r "$ENV_FILE" ]] || { echo "Environment file is not readable: $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

API_URL="http://${DIVEDEEP_API_HOST:-127.0.0.1}:${DIVEDEEP_API_PORT:-8600}"
UI_URL="http://127.0.0.1:${OSINT_STUDIO_PORT:-8501}"
API_KEY="${DIVEDEEP_API_KEY:-}"
[[ -n "$API_KEY" ]] || { echo "DIVEDEEP_API_KEY is not configured." >&2; exit 1; }

wait_http() {
  local url="$1"
  local attempts="${2:-30}"
  local code
  for ((i=1; i<=attempts; i++)); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$url" || true)"
    if [[ "$code" =~ ^2[0-9][0-9]$ || "$code" == "503" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $url" >&2
  return 1
}

wait_http "$API_URL/health" 45
wait_http "$UI_URL" 45

health="$(curl -fsS "$API_URL/health")"
version="$(curl -fsS -H "Authorization: Bearer $API_KEY" "$API_URL/v1/version")"
status="$(curl -fsS -H "Authorization: Bearer $API_KEY" "$API_URL/v1/system/status")"
ready_code="$(curl -sS -o /tmp/divedeep-ready.json -w '%{http_code}' "$API_URL/ready")"

jq -e '.status == "ok" and (.version | type == "string")' <<<"$health" >/dev/null
jq -e '.appVersion and .apiVersion and (.features | index("versioned-releases"))' <<<"$version" >/dev/null
jq -e '.queue and .worker and .drain and .storage' <<<"$status" >/dev/null

if [[ "$ALLOW_DRAINING" == "1" ]]; then
  [[ "$ready_code" == "200" || "$ready_code" == "503" ]] || { echo "Unexpected readiness code: $ready_code" >&2; exit 1; }
else
  [[ "$ready_code" == "200" ]] || { cat /tmp/divedeep-ready.json >&2; echo "DiveDeep is not ready." >&2; exit 1; }
  jq -e '.acceptingWork == true' /tmp/divedeep-ready.json >/dev/null
fi

printf '%s\n' "DiveDeep smoke test passed."
printf '%s\n' "$version" | jq '{appVersion, apiVersion, features}'
