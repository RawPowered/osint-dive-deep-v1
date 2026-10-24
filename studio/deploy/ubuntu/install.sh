#!/usr/bin/env bash
set -Eeuo pipefail

[[ $EUID -eq 0 ]] || { echo "Run this installer with sudo." >&2; exit 1; }

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_ROOT="${DIVEDEEP_INSTALL_ROOT:-/opt/divedeep}"
RELEASES_DIR="$INSTALL_ROOT/releases"
CURRENT_LINK="$INSTALL_ROOT/current"
KNOWN_GOOD_LINK="$INSTALL_ROOT/known-good"
SERVICE_USER="divedeep"
SERVICE_HOME="/var/lib/divedeep"
CACHE_DIR="/var/cache/divedeep"
CONFIG_DIR="/etc/divedeep"
ENV_FILE="$CONFIG_DIR/divedeep.env"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  ca-certificates curl git jq openssl rsync unzip \
  python3 python3-pip python3-venv build-essential

PYTHONPATH="$SOURCE_DIR" python3 -m osint_studio.release_tools verify "$SOURCE_DIR" >/tmp/divedeep-install-release.json
VERSION="$(jq -r '.appVersion' /tmp/divedeep-install-release.json)"
TARGET_DIR="$RELEASES_DIR/$VERSION"

if [[ "$(readlink -f "$SOURCE_DIR")" == "$(readlink -f "$INSTALL_ROOT" 2>/dev/null || echo "$INSTALL_ROOT")" ]]; then
  echo "Extract the release outside $INSTALL_ROOT before running install.sh." >&2
  exit 1
fi
if [[ -L "$CURRENT_LINK" ]]; then
  echo "A versioned DiveDeep installation already exists. Use $CURRENT_LINK/deploy/ubuntu/upgrade.sh instead." >&2
  exit 1
fi
LEGACY_INSTALL=0
LEGACY_DIR=""
if [[ -x "$INSTALL_ROOT/run.sh" ]]; then
  LEGACY_INSTALL=1
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$SERVICE_HOME" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 0755 "$INSTALL_ROOT" "$RELEASES_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 \
  "$SERVICE_HOME" "$SERVICE_HOME/data" "$SERVICE_HOME/backups" "$CACHE_DIR" /var/log/divedeep
install -d -o root -g "$SERVICE_USER" -m 0750 "$CONFIG_DIR"

if [[ "$LEGACY_INSTALL" == "1" ]]; then
  LEGACY_VERSION="$(sed -n 's/^__version__ = "\([^"]*\)"/\1/p' "$INSTALL_ROOT/osint_studio/__init__.py" 2>/dev/null | head -n1)"
  [[ -n "$LEGACY_VERSION" ]] || LEGACY_VERSION="5.27.0-legacy"
  LEGACY_DIR="$RELEASES_DIR/$LEGACY_VERSION"
  if [[ ! -d "$LEGACY_DIR" ]]; then
    mkdir -p "$LEGACY_DIR"
    rsync -a \
      --exclude 'releases/' --exclude 'current' --exclude 'previous' --exclude 'known-good' \
      --exclude '.venv/' --exclude '__pycache__/' --exclude '*.pyc' \
      "$INSTALL_ROOT/" "$LEGACY_DIR/"
    install -d "$LEGACY_DIR/deploy/ubuntu/systemd"
    cp "$SOURCE_DIR/deploy/ubuntu/systemd/"*.service "$LEGACY_DIR/deploy/ubuntu/systemd/"
    chown -R "$SERVICE_USER:$SERVICE_USER" "$LEGACY_DIR"
    chmod +x "$LEGACY_DIR/run.sh"
  fi
  echo "Preserved legacy DiveDeep release at $LEGACY_DIR"
fi

INCOMING="$RELEASES_DIR/.${VERSION}.installing"
rm -rf "$INCOMING"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$INCOMING"
rsync -a --delete \
  --exclude '.venv/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.git/' \
  "$SOURCE_DIR/" "$INCOMING/"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INCOMING"
chmod +x "$INCOMING/run.sh" "$INCOMING/deploy/ubuntu/"*.sh
PYTHONPATH="$INCOMING" python3 -m osint_studio.release_tools verify "$INCOMING" >/dev/null

if [[ -e "$TARGET_DIR" ]]; then
  rm -rf "$TARGET_DIR"
fi
mv "$INCOMING" "$TARGET_DIR"
ln -sfn "$TARGET_DIR" "$INSTALL_ROOT/.current.install"
mv -Tf "$INSTALL_ROOT/.current.install" "$CURRENT_LINK"
ln -sfn "$TARGET_DIR" "$KNOWN_GOOD_LINK"
if [[ -n "$LEGACY_DIR" ]]; then
  ln -sfn "$LEGACY_DIR" "$INSTALL_ROOT/previous"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  API_KEY="$(openssl rand -hex 32)"
  sed "s/REPLACE_WITH_A_LONG_RANDOM_SECRET/$API_KEY/" "$TARGET_DIR/deploy/ubuntu/divedeep.env.example" > "$ENV_FILE"
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  echo "Generated DIVEDEEP_API_KEY in $ENV_FILE"
else
  echo "Preserving existing $ENV_FILE"
fi

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

runuser -u "$SERVICE_USER" -- env \
  HOME="$SERVICE_HOME" \
  OSINT_STUDIO_DATA_DIR="$OSINT_STUDIO_DATA_DIR" \
  OSINT_STUDIO_CACHE_DIR="$OSINT_STUDIO_CACHE_DIR" \
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
  DIVEDEEP_API_DB="$DIVEDEEP_API_DB" \
  "$TARGET_DIR/run.sh" --check

if [[ -n "$LEGACY_DIR" && ! -x "$LEGACY_DIR/.venv/bin/python" ]]; then
  runuser -u "$SERVICE_USER" -- env \
    HOME="$SERVICE_HOME" \
    OSINT_STUDIO_DATA_DIR="$OSINT_STUDIO_DATA_DIR" \
    OSINT_STUDIO_CACHE_DIR="$OSINT_STUDIO_CACHE_DIR" \
    PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
    DIVEDEEP_API_DB="$DIVEDEEP_API_DB" \
    "$LEGACY_DIR/run.sh" --check
fi

runuser -u "$SERVICE_USER" -- env \
  HOME="$SERVICE_HOME" \
  OSINT_STUDIO_DATA_DIR="$OSINT_STUDIO_DATA_DIR" \
  DIVEDEEP_API_DB="$DIVEDEEP_API_DB" \
  "$TARGET_DIR/.venv/bin/python" -m osint_studio.release_tools backup \
    --data-root "$OSINT_STUDIO_DATA_DIR" \
    --backup-root "${DIVEDEEP_BACKUP_DIR:-$SERVICE_HOME/backups}"

"$TARGET_DIR/.venv/bin/python" -m playwright install-deps chromium
runuser -u "$SERVICE_USER" -- env \
  HOME="$SERVICE_HOME" \
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
  "$TARGET_DIR/.venv/bin/python" -m playwright install chromium

install -m 0644 "$TARGET_DIR/deploy/ubuntu/systemd/divedeep-ui.service" /etc/systemd/system/divedeep-ui.service
install -m 0644 "$TARGET_DIR/deploy/ubuntu/systemd/divedeep-api.service" /etc/systemd/system/divedeep-api.service
install -m 0644 "$TARGET_DIR/deploy/ubuntu/systemd/divedeep-worker.service" /etc/systemd/system/divedeep-worker.service

systemctl daemon-reload
systemctl enable divedeep-ui.service divedeep-api.service divedeep-worker.service
systemctl restart divedeep-ui.service divedeep-api.service divedeep-worker.service
"$TARGET_DIR/deploy/ubuntu/smoke-test.sh"

cat <<MSG

DiveDeep $VERSION installation is complete.

Active release:  $CURRENT_LINK -> $TARGET_DIR
Operator UI:     http://127.0.0.1:${OSINT_STUDIO_PORT:-8501}
Server API:      http://127.0.0.1:${DIVEDEEP_API_PORT:-8600}
Environment:     $ENV_FILE
Data:            ${OSINT_STUDIO_DATA_DIR:-$SERVICE_HOME/data}
Backups:         ${DIVEDEEP_BACKUP_DIR:-$SERVICE_HOME/backups}

Upgrade a future release:
  sudo $CURRENT_LINK/deploy/ubuntu/upgrade.sh DiveDeep-vNEXT.zip

Rollback to the previous release:
  sudo $CURRENT_LINK/deploy/ubuntu/rollback.sh

Check services:
  sudo systemctl status divedeep-ui divedeep-api divedeep-worker

Keep the UI and API private until Tailscale, SSH tunneling, or a TLS reverse proxy is configured.
MSG
