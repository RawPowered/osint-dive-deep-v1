#!/usr/bin/env bash
set -Eeuo pipefail

[[ $EUID -eq 0 ]] || { echo "Run this upgrade with sudo." >&2; exit 1; }
[[ $# -ge 1 ]] || { echo "Usage: sudo $0 RELEASE.zip [--timeout SECONDS] [--force]" >&2; exit 1; }

PACKAGE="$1"
shift
DRAIN_TIMEOUT=900
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) DRAIN_TIMEOUT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ "$DRAIN_TIMEOUT" =~ ^[0-9]+$ ]] || { echo "Timeout must be an integer." >&2; exit 1; }

INSTALL_ROOT="${DIVEDEEP_INSTALL_ROOT:-/opt/divedeep}"
RELEASES_DIR="$INSTALL_ROOT/releases"
CURRENT_LINK="$INSTALL_ROOT/current"
PREVIOUS_LINK="$INSTALL_ROOT/previous"
KNOWN_GOOD_LINK="$INSTALL_ROOT/known-good"
ENV_FILE="${DIVEDEEP_ENV_FILE:-/etc/divedeep/divedeep.env}"
SERVICE_USER="divedeep"
TEMP_DIR="$(mktemp -d /tmp/divedeep-upgrade.XXXXXX)"
trap 'rm -rf "$TEMP_DIR"' EXIT

[[ -r "$ENV_FILE" ]] || { echo "Missing environment file: $ENV_FILE" >&2; exit 1; }
append_env_default() {
  local key="$1"
  local value="$2"
  grep -q "^${key}=" "$ENV_FILE" || printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}
append_env_default DIVEDEEP_STATE_FILE /var/lib/divedeep/data/system-state.json
append_env_default DIVEDEEP_BACKUP_DIR /var/lib/divedeep/backups
append_env_default DIVEDEEP_RELEASE_ROOT /opt/divedeep/releases
append_env_default PYTHONDONTWRITEBYTECODE 1
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -d "$PACKAGE" ]]; then
  SOURCE_ROOT="$(readlink -f "$PACKAGE")"
else
  [[ -f "$PACKAGE" ]] || { echo "Release package not found: $PACKAGE" >&2; exit 1; }
  unzip -tq "$PACKAGE" >/dev/null
  unzip -q "$PACKAGE" -d "$TEMP_DIR/package"
  mapfile -t manifests < <(find "$TEMP_DIR/package" -name RELEASE.json -type f -print)
  [[ ${#manifests[@]} -eq 1 ]] || { echo "Release archive must contain exactly one RELEASE.json." >&2; exit 1; }
  SOURCE_ROOT="$(dirname "${manifests[0]}")"
fi

python3 -m compileall -q "$SOURCE_ROOT/osint_studio"
PYTHONPATH="$SOURCE_ROOT" python3 -m osint_studio.release_tools verify "$SOURCE_ROOT" >/tmp/divedeep-release-verify.json
VERSION="$(jq -r '.appVersion' /tmp/divedeep-release-verify.json)"
CURRENT_DIR="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
CURRENT_VERSION=""
if [[ -n "$CURRENT_DIR" && -f "$CURRENT_DIR/RELEASE.json" ]]; then
  CURRENT_VERSION="$(jq -r '.appVersion' "$CURRENT_DIR/RELEASE.json")"
fi
if [[ "$VERSION" == "$CURRENT_VERSION" && "$FORCE" != "1" ]]; then
  echo "Version $VERSION is already active. Use --force to reinstall." >&2
  exit 1
fi

mkdir -p "$RELEASES_DIR"
TARGET_DIR="$RELEASES_DIR/$VERSION"
INCOMING="$RELEASES_DIR/.${VERSION}.incoming"
rm -rf "$INCOMING"
mkdir -p "$INCOMING"
rsync -a --delete --exclude '.venv/' --exclude '__pycache__/' --exclude '*.pyc' --exclude '.git/' "$SOURCE_ROOT/" "$INCOMING/"
PYTHONPATH="$INCOMING" python3 -m osint_studio.release_tools verify "$INCOMING" >/dev/null
chown -R "$SERVICE_USER:$SERVICE_USER" "$INCOMING"
chmod +x "$INCOMING/run.sh" "$INCOMING/deploy/ubuntu/"*.sh

runuser -u "$SERVICE_USER" -- env \
  HOME="${HOME:-/var/lib/divedeep}" \
  OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" \
  OSINT_STUDIO_CACHE_DIR="${OSINT_STUDIO_CACHE_DIR:-/var/cache/divedeep}" \
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/var/cache/divedeep/ms-playwright}" \
  DIVEDEEP_API_DB="${DIVEDEEP_API_DB:-/var/lib/divedeep/data/server-jobs.sqlite}" \
  "$INCOMING/run.sh" --check

"$INCOMING/.venv/bin/python" -m playwright install-deps chromium >/dev/null
runuser -u "$SERVICE_USER" -- env \
  HOME="${HOME:-/var/lib/divedeep}" \
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/var/cache/divedeep/ms-playwright}" \
  "$INCOMING/.venv/bin/python" -m playwright install chromium >/dev/null

if [[ -e "$TARGET_DIR" ]]; then
  [[ "$FORCE" == "1" ]] || { echo "Release directory already exists: $TARGET_DIR" >&2; exit 1; }
  rm -rf "$TARGET_DIR"
fi
mv "$INCOMING" "$TARGET_DIR"

runuser -u "$SERVICE_USER" -- env \
  HOME="${HOME:-/var/lib/divedeep}" \
  OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" \
  DIVEDEEP_API_DB="${DIVEDEEP_API_DB:-/var/lib/divedeep/data/server-jobs.sqlite}" \
  "$TARGET_DIR/.venv/bin/python" -m osint_studio.release_tools backup \
    --data-root "${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" \
    --backup-root "${DIVEDEEP_BACKUP_DIR:-/var/lib/divedeep/backups}"

runuser -u "$SERVICE_USER" -- env \
  HOME="${HOME:-/var/lib/divedeep}" \
  OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" \
  "$TARGET_DIR/.venv/bin/python" -m osint_studio.release_tools drain \
    --reason "Upgrade to $VERSION" --requested-by "upgrade.sh" >/dev/null

systemctl stop divedeep-api.service divedeep-ui.service || true
start_time="$(date +%s)"
while true; do
  stats="$(runuser -u "$SERVICE_USER" -- env HOME="${HOME:-/var/lib/divedeep}" OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" DIVEDEEP_API_DB="${DIVEDEEP_API_DB:-/var/lib/divedeep/data/server-jobs.sqlite}" "$TARGET_DIR/.venv/bin/python" -m osint_studio.release_tools queue-stats)"
  running="$(jq -r '.running' <<<"$stats")"
  [[ "$running" == "0" ]] && break
  now="$(date +%s)"
  if (( now - start_time >= DRAIN_TIMEOUT )); then
    echo "Drain timeout reached; active jobs will be safely requeued."
    break
  fi
  sleep 5
done

systemctl stop divedeep-worker.service || true
runuser -u "$SERVICE_USER" -- env \
  HOME="${HOME:-/var/lib/divedeep}" \
  OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" \
  DIVEDEEP_API_DB="${DIVEDEEP_API_DB:-/var/lib/divedeep/data/server-jobs.sqlite}" \
  "$TARGET_DIR/.venv/bin/python" -m osint_studio.release_tools requeue-running \
    --reason "Requeued during upgrade to $VERSION." >/dev/null

if [[ -n "$CURRENT_DIR" ]]; then
  ln -sfn "$CURRENT_DIR" "$PREVIOUS_LINK"
fi
ln -sfn "$TARGET_DIR" "$INSTALL_ROOT/.current.new"
mv -Tf "$INSTALL_ROOT/.current.new" "$CURRENT_LINK"

install -m 0644 "$TARGET_DIR/deploy/ubuntu/systemd/divedeep-ui.service" /etc/systemd/system/divedeep-ui.service
install -m 0644 "$TARGET_DIR/deploy/ubuntu/systemd/divedeep-api.service" /etc/systemd/system/divedeep-api.service
install -m 0644 "$TARGET_DIR/deploy/ubuntu/systemd/divedeep-worker.service" /etc/systemd/system/divedeep-worker.service
systemctl daemon-reload
systemctl start divedeep-api.service divedeep-ui.service divedeep-worker.service

rollback_on_failure() {
  echo "Upgrade smoke test failed. Rolling back." >&2
  systemctl stop divedeep-api.service divedeep-ui.service divedeep-worker.service || true
  if [[ -n "$CURRENT_DIR" ]]; then
    ln -sfn "$CURRENT_DIR" "$INSTALL_ROOT/.current.rollback"
    mv -Tf "$INSTALL_ROOT/.current.rollback" "$CURRENT_LINK"
  fi
  runuser -u "$SERVICE_USER" -- env HOME="${HOME:-/var/lib/divedeep}" OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" "$TARGET_DIR/.venv/bin/python" -m osint_studio.release_tools resume >/dev/null || true
  systemctl daemon-reload
  systemctl start divedeep-api.service divedeep-ui.service divedeep-worker.service || true
  exit 1
}

"$TARGET_DIR/deploy/ubuntu/smoke-test.sh" --allow-draining || rollback_on_failure
runuser -u "$SERVICE_USER" -- env HOME="${HOME:-/var/lib/divedeep}" OSINT_STUDIO_DATA_DIR="${OSINT_STUDIO_DATA_DIR:-/var/lib/divedeep/data}" "$TARGET_DIR/.venv/bin/python" -m osint_studio.release_tools resume >/dev/null
"$TARGET_DIR/deploy/ubuntu/smoke-test.sh" || rollback_on_failure
ln -sfn "$TARGET_DIR" "$KNOWN_GOOD_LINK"

printf '%s\n' "DiveDeep upgraded successfully: ${CURRENT_VERSION:-unversioned} -> $VERSION"
printf '%s\n' "Current release: $CURRENT_LINK -> $TARGET_DIR"
printf '%s\n' "Previous release: $(readlink -f "$PREVIOUS_LINK" 2>/dev/null || echo none)"
