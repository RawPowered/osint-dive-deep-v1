#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "Run this backup with sudo." >&2; exit 1; }
ENV_FILE="${DIVEDEEP_ENV_FILE:-/etc/divedeep/divedeep.env}"
[[ -r "$ENV_FILE" ]] || { echo "Environment file is not readable: $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
CURRENT="$(readlink -f /opt/divedeep/current 2>/dev/null || true)"
[[ -n "$CURRENT" && -x "$CURRENT/.venv/bin/python" ]] || { echo "Active DiveDeep release was not found." >&2; exit 1; }
runuser -u divedeep -- env \
  HOME="${HOME:-/var/lib/divedeep}" \
  OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" \
  DIVEDEEP_API_DB="${DIVEDEEP_API_DB:-/var/lib/divedeep/data/server-jobs.sqlite}" \
  "$CURRENT/.venv/bin/python" -m osint_studio.release_tools backup \
    --data-root "${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" \
    --backup-root "${DIVEDEEP_BACKUP_DIR:-/var/lib/divedeep/backups}"
