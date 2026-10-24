#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR="$SCRIPT_DIR/.venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"
PORT="${OSINT_STUDIO_PORT:-8501}"
ACTION="start"
RESET_VENV=0
WITH_RECEIVER=0
STREAMLIT_ARGS=()
RECEIVER_PORT="${OSINT_RECEIVER_PORT:-8765}"
API_HOST="${DIVEDEEP_API_HOST:-127.0.0.1}"
API_PORT="${DIVEDEEP_API_PORT:-8600}"
DIVEDEEP_WORKSPACE=""
DIVEDEEP_JOB_INDEX=""
DIVEDEEP_JOB_TIMEOUT="900"

log() {
  printf '[OSINT Studio] %s\n' "$*"
}

fail() {
  printf '\n[OSINT Studio] ERROR: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) RESET_VENV=1; shift ;;
    --check) ACTION="check"; shift ;;
    --test) ACTION="test"; shift ;;
    --install-browser) ACTION="install-browser"; shift ;;
    --receiver) ACTION="receiver"; shift ;;
    --api) ACTION="api"; shift ;;
    --worker) ACTION="worker"; shift ;;
    --cloud-worker) ACTION="cloud-worker"; shift ;;
    --status) ACTION="status"; shift ;;
    --drain) ACTION="drain"; shift ;;
    --resume) ACTION="resume"; shift ;;
    --version) ACTION="version"; shift ;;
    --with-receiver) WITH_RECEIVER=1; shift ;;
    --divedeep-job)
      [[ $# -ge 3 ]] || fail "--divedeep-job requires WORKSPACE and INDEX."
      ACTION="divedeep-job"
      DIVEDEEP_WORKSPACE="$2"
      DIVEDEEP_JOB_INDEX="$3"
      shift 3
      ;;
    --timeout)
      [[ $# -ge 2 ]] || fail "--timeout requires a number of seconds."
      DIVEDEEP_JOB_TIMEOUT="$2"
      shift 2
      ;;
    --server.address|--server.address=*) fail "The UI address is fixed to 127.0.0.1 and cannot be overridden." ;;
    *) STREAMLIT_ARGS+=("$1"); shift ;;
  esac
done

if [[ ! -r /etc/os-release ]]; then
  fail "Unable to identify the Linux distribution."
fi
. /etc/os-release
case "${ID:-}" in
  kali|ubuntu|debian) ;;
  *) fail "DiveDeep supports Ubuntu, Debian, and Kali Linux. Detected: ${ID:-unknown}." ;;
esac

[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) \
  || fail "OSINT_STUDIO_PORT must be a number from 1024 through 65535."

[[ "$RECEIVER_PORT" =~ ^[0-9]+$ ]] && (( RECEIVER_PORT >= 1024 && RECEIVER_PORT <= 65535 )) \
  || fail "OSINT_RECEIVER_PORT must be a number from 1024 through 65535."

[[ "$RECEIVER_PORT" != "$PORT" ]] \
  || fail "OSINT_RECEIVER_PORT must differ from OSINT_STUDIO_PORT."

[[ "$API_PORT" =~ ^[0-9]+$ ]] && (( API_PORT >= 1024 && API_PORT <= 65535 )) \
  || fail "DIVEDEEP_API_PORT must be a number from 1024 through 65535."

[[ "$API_PORT" != "$PORT" && "$API_PORT" != "$RECEIVER_PORT" ]] \
  || fail "DIVEDEEP_API_PORT must differ from the UI and receiver ports."

if [[ "$API_HOST" != "127.0.0.1" && "$API_HOST" != "::1" && "${DIVEDEEP_ALLOW_PUBLIC_BIND:-0}" != "1" ]]; then
  fail "Refusing a non-loopback API bind. Set DIVEDEEP_ALLOW_PUBLIC_BIND=1 only behind a private network or hardened reverse proxy."
fi

if [[ "$ACTION" == "divedeep-job" ]]; then
  [[ "$DIVEDEEP_JOB_INDEX" =~ ^[0-9]+$ ]] || fail "DiveDeep job index must be a non-negative integer."
  [[ "$DIVEDEEP_JOB_TIMEOUT" =~ ^[0-9]+$ ]] || fail "DiveDeep job timeout must be an integer."
  (( DIVEDEEP_JOB_TIMEOUT >= 30 && DIVEDEEP_JOB_TIMEOUT <= 7200 )) || fail "DiveDeep job timeout must be from 30 through 7200 seconds."
fi

if [[ "$RESET_VENV" == "1" ]]; then
  log "Removing the local virtual environment..."
  rm -rf "$VENV_DIR"
fi

command -v "$PYTHON_BIN" >/dev/null 2>&1 \
  || fail "python3 was not found. Install it with: sudo apt update && sudo apt install -y python3 python3-venv python3-pip"

if [[ -e "$VENV_DIR" && ! -x "$VENV_DIR/bin/python" ]]; then
  log "Incomplete .venv detected; rebuilding it."
  rm -rf "$VENV_DIR"
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  log "Creating virtual environment at $VENV_DIR"
  if ! "$PYTHON_BIN" -m venv "$VENV_DIR"; then
    cat >&2 <<'MSG'

Virtual-environment creation failed. On Ubuntu, Debian, or Kali, install the venv package:

  sudo apt update
  sudo apt install -y python3-venv python3-pip

Then run:

  ./run.sh --reset
MSG
    exit 1
  fi
fi

VENV_PYTHON="$VENV_DIR/bin/python"

if ! "$VENV_PYTHON" -m pip --version >/dev/null 2>&1; then
  log "Bootstrapping pip inside the virtual environment."
  "$VENV_PYTHON" -m ensurepip --upgrade \
    || fail "pip could not be installed in .venv. Install python3-venv and rerun ./run.sh --reset"
fi

REQUIREMENTS_HASH="$("$VENV_PYTHON" -c 'import hashlib, pathlib; print(hashlib.sha256(pathlib.Path("requirements.txt").read_bytes()).hexdigest())')"
REQUIREMENTS_STAMP="$VENV_DIR/.requirements.sha256"
INSTALLED_HASH="$(cat "$REQUIREMENTS_STAMP" 2>/dev/null || true)"

if [[ "$REQUIREMENTS_HASH" != "$INSTALLED_HASH" ]]; then
  log "Installing application dependencies..."
  "$VENV_PYTHON" -m pip install --disable-pip-version-check --upgrade pip setuptools wheel
  "$VENV_PYTHON" -m pip install --disable-pip-version-check -r requirements.txt
  printf '%s\n' "$REQUIREMENTS_HASH" > "$REQUIREMENTS_STAMP"
else
  log "Application dependencies are current."
fi

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

if [[ "$ACTION" == "install-browser" ]]; then
  log "Installing the pinned Playwright Chromium browser..."
  "$VENV_PYTHON" -m playwright install chromium \
    || fail "Chromium installation failed. Run: sudo .venv/bin/python -m playwright install-deps chromium"
  log "Managed property browser is ready."
  exit 0
fi

if [[ "$ACTION" == "check" ]]; then
  "$VENV_PYTHON" -c 'import bs4, ddgs, duckdb, fastapi, folium, pandas, playwright, requests, streamlit, streamlit_folium, uvicorn; from osint_studio.release import compatibility_payload; from osint_studio.server_queue import ServerQueue; ServerQueue(); print("Dependency check passed", compatibility_payload()["appVersion"])'
  log "Data directory: ${OSINT_STUDIO_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/osint-dive-deep}"
  log "Cache directory: ${OSINT_STUDIO_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/osint-dive-deep}"
  log "Loopback UI: http://127.0.0.1:$PORT"
  log "Server API: http://$API_HOST:$API_PORT"
  exit 0
fi

if [[ "$ACTION" == "test" ]]; then
  exec "$VENV_PYTHON" -m unittest discover -s tests -v
fi

if [[ "$ACTION" == "version" ]]; then
  exec "$VENV_PYTHON" -c 'import json; from osint_studio.release import compatibility_payload; print(json.dumps(compatibility_payload(), indent=2, sort_keys=True))'
fi

if [[ "$ACTION" == "status" ]]; then
  exec "$VENV_PYTHON" -m osint_studio.runtime_state
fi

if [[ "$ACTION" == "drain" ]]; then
  exec "$VENV_PYTHON" -m osint_studio.runtime_state --drain --reason "${DIVEDEEP_DRAIN_REASON:-Manual maintenance}" --requested-by "run.sh"
fi

if [[ "$ACTION" == "resume" ]]; then
  exec "$VENV_PYTHON" -m osint_studio.runtime_state --resume
fi

if [[ "$ACTION" == "receiver" ]]; then
  log "Starting the Firefox structured receiver at http://127.0.0.1:$RECEIVER_PORT"
  exec "$VENV_PYTHON" -m osint_studio.extension_receiver --port "$RECEIVER_PORT"
fi

if [[ "$ACTION" == "api" ]]; then
  log "Starting the authenticated DiveDeep API at http://$API_HOST:$API_PORT"
  exec "$VENV_PYTHON" -m uvicorn osint_studio.server_api:app \
    --host "$API_HOST" \
    --port "$API_PORT" \
    --proxy-headers \
    --no-server-header
fi

if [[ "$ACTION" == "worker" ]]; then
  log "Starting the DiveDeep server queue worker"
  exec "$VENV_PYTHON" -m osint_studio.server_worker
fi

if [[ "$ACTION" == "cloud-worker" ]]; then
  log "Starting the ephemeral DiveDeep Cloud Run worker"
  exec "$VENV_PYTHON" -m osint_studio.cloud_worker
fi

if [[ "$ACTION" == "divedeep-job" ]]; then
  exec "$VENV_PYTHON" -m osint_studio.divedeep_runner \
    --workspace "$DIVEDEEP_WORKSPACE" \
    --index "$DIVEDEEP_JOB_INDEX" \
    --timeout "$DIVEDEEP_JOB_TIMEOUT"
fi

if [[ "$WITH_RECEIVER" == "1" ]]; then
  export OSINT_ENABLE_RECEIVER=1
  export OSINT_RECEIVER_PORT="$RECEIVER_PORT"
  RECEIVER_TOKEN="$("$VENV_PYTHON" -c 'from osint_studio.extension_receiver import ensure_receiver_token; print(ensure_receiver_token())')"
  log "Firefox receiver will run inside Studio at http://127.0.0.1:$RECEIVER_PORT"
  log "Firefox extension token: $RECEIVER_TOKEN"
fi

log "Starting at http://127.0.0.1:$PORT"
exec "$VENV_PYTHON" -m streamlit run app.py \
  --server.address 127.0.0.1 \
  --server.port "$PORT" \
  --server.headless true \
  --browser.gatherUsageStats false \
  "${STREAMLIT_ARGS[@]}"
