#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "Run this rollback with sudo." >&2; exit 1; }
TARGET_VERSION="${1:-}"
INSTALL_ROOT="${DIVEDEEP_INSTALL_ROOT:-/opt/divedeep}"
CURRENT_LINK="$INSTALL_ROOT/current"
PREVIOUS_LINK="$INSTALL_ROOT/previous"
KNOWN_GOOD_LINK="$INSTALL_ROOT/known-good"
ENV_FILE="${DIVEDEEP_ENV_FILE:-/etc/divedeep/divedeep.env}"
SERVICE_USER="divedeep"
[[ -r "$ENV_FILE" ]] || { echo "Missing environment file: $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -n "$TARGET_VERSION" ]]; then
  TARGET="$INSTALL_ROOT/releases/$TARGET_VERSION"
else
  TARGET="$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || true)"
fi
[[ -n "$TARGET" && -d "$TARGET" && -f "$TARGET/RELEASE.json" ]] || { echo "Rollback target was not found." >&2; exit 1; }
PYTHONPATH="$TARGET" python3 -m osint_studio.release_tools verify "$TARGET" >/dev/null
CURRENT="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
[[ "$TARGET" != "$CURRENT" ]] || { echo "Target release is already active." >&2; exit 1; }

runuser -u "$SERVICE_USER" -- env HOME="${HOME:-/var/lib/divedeep}" OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" "$TARGET/.venv/bin/python" -m osint_studio.release_tools drain --reason "Rollback" --requested-by "rollback.sh" >/dev/null
systemctl stop divedeep-api.service divedeep-ui.service divedeep-worker.service || true
runuser -u "$SERVICE_USER" -- env HOME="${HOME:-/var/lib/divedeep}" OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" DIVEDEEP_API_DB="${DIVEDEEP_API_DB:-/var/lib/divedeep/data/server-jobs.sqlite}" "$TARGET/.venv/bin/python" -m osint_studio.release_tools requeue-running --reason "Requeued during rollback." >/dev/null

[[ -z "$CURRENT" ]] || ln -sfn "$CURRENT" "$PREVIOUS_LINK"
ln -sfn "$TARGET" "$INSTALL_ROOT/.current.rollback"
mv -Tf "$INSTALL_ROOT/.current.rollback" "$CURRENT_LINK"
install -m 0644 "$TARGET/deploy/ubuntu/systemd/divedeep-ui.service" /etc/systemd/system/divedeep-ui.service
install -m 0644 "$TARGET/deploy/ubuntu/systemd/divedeep-api.service" /etc/systemd/system/divedeep-api.service
install -m 0644 "$TARGET/deploy/ubuntu/systemd/divedeep-worker.service" /etc/systemd/system/divedeep-worker.service
systemctl daemon-reload
systemctl start divedeep-api.service divedeep-ui.service divedeep-worker.service
"$TARGET/deploy/ubuntu/smoke-test.sh" --allow-draining
runuser -u "$SERVICE_USER" -- env HOME="${HOME:-/var/lib/divedeep}" OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" "$TARGET/.venv/bin/python" -m osint_studio.release_tools resume >/dev/null
"$TARGET/deploy/ubuntu/smoke-test.sh"
ln -sfn "$TARGET" "$KNOWN_GOOD_LINK"
echo "Rollback completed. Active release: $(jq -r '.appVersion' "$TARGET/RELEASE.json")"
