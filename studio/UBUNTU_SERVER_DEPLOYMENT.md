# DiveDeep Ubuntu Server Edition 5.27

DiveDeep can now run as three independent Ubuntu services:

1. **Operator UI** — Streamlit on loopback port 8501.
2. **Authenticated API** — FastAPI on loopback port 8600.
3. **Queue worker** — executes allowlisted DiveDeep jobs outside the HTTP request lifecycle.

The server API does not execute arbitrary commands. It can only import a DiveDeep packet, rebuild an authorized package plan, enqueue existing allowlisted job indices, inspect status, and export the normalized result packet.

## Recommended server

Use Ubuntu Server 24.04 LTS x86_64 with at least:

- 4 vCPU
- 8 GB RAM
- 120 GB SSD/NVMe
- A private administrative network or SSH access

For visual administration, add XFCE and xRDP after the core server is installed. XFCE consumes substantially fewer resources than a full GNOME desktop and leaves more RAM available for browsers and recon workers.

## Installation

Unzip DiveDeep, then run:

```bash
cd DiveDeep_FID_WebUI_v5.27.0_Ubuntu_Server
sudo ./deploy/ubuntu/install.sh
```

This installs DiveDeep at `/opt/divedeep`, creates a non-login `divedeep` service account, creates private data directories, installs Playwright Chromium, and starts:

```text
divedeep-ui.service
divedeep-api.service
divedeep-worker.service
```

Configuration is stored in:

```text
/etc/divedeep/divedeep.env
```

Data is stored in:

```text
/var/lib/divedeep/data
```

## Optional visual Ubuntu desktop

Run this as an administrator with an existing Linux login account:

```bash
sudo ./deploy/ubuntu/install-desktop.sh --user YOUR_ADMIN_USER
```

The script installs XFCE, Firefox, and xRDP. RDP is deliberately bound to loopback. From your own computer:

```bash
ssh -L 13389:127.0.0.1:3389 YOUR_ADMIN_USER@YOUR_SERVER_IP
```

Then connect your Remote Desktop client to `127.0.0.1:13389`.

The desktop includes shortcuts for DiveDeep and the worker logs. The actual application continues to run as system services, so closing the desktop does not stop recon jobs.

## API authentication

The installer generates a 64-character API secret and places it in `/etc/divedeep/divedeep.env` as `DIVEDEEP_API_KEY`.

Use either header:

```http
Authorization: Bearer YOUR_KEY
```

or:

```http
X-DiveDeep-API-Key: YOUR_KEY
```

## API workflow

### Health

```bash
curl http://127.0.0.1:8600/health
```

### Import a DiveDeep customer packet

```bash
curl -X POST http://127.0.0.1:8600/v1/intakes \
  -H "Authorization: Bearer $DIVEDEEP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-DiveDeep-Filename: customer.json" \
  -H "X-DiveDeep-Package: deep" \
  --data-binary @customer.json
```

### List workspaces

```bash
curl http://127.0.0.1:8600/v1/workspaces \
  -H "Authorization: Bearer $DIVEDEEP_API_KEY"
```

### Run all eligible jobs

```bash
curl -X POST http://127.0.0.1:8600/v1/workspaces/WORKSPACE_ID/runs \
  -H "Authorization: Bearer $DIVEDEEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"all","continue_on_failure":true,"timeout_seconds":900}'
```

The response contains a server job ID. Poll it:

```bash
curl http://127.0.0.1:8600/v1/jobs/JOB_ID \
  -H "Authorization: Bearer $DIVEDEEP_API_KEY"
```

### Queue a result export

```bash
curl -X POST http://127.0.0.1:8600/v1/workspaces/WORKSPACE_ID/exports \
  -H "Authorization: Bearer $DIVEDEEP_API_KEY"
```

After the export job completes:

```bash
curl -o divedeep-results.json \
  http://127.0.0.1:8600/v1/workspaces/WORKSPACE_ID/results/download \
  -H "Authorization: Bearer $DIVEDEEP_API_KEY"
```

## Private networking

Keep both services bound to `127.0.0.1` by default. Use one of these patterns:

- SSH tunnels for operator access.
- Tailscale between the DiveDeep server and DiveDeep.
- A TLS reverse proxy restricted by firewall and API key.

Do not expose Streamlit, xRDP, or the raw API directly to the public internet.

## Service operations

```bash
sudo systemctl status divedeep-ui divedeep-api divedeep-worker
sudo systemctl restart divedeep-ui divedeep-api divedeep-worker
sudo journalctl -u divedeep-worker -f
sudo journalctl -u divedeep-api -f
```

## Updating

Back up `/etc/divedeep/divedeep.env` and `/var/lib/divedeep/data`, unzip the new release, and rerun:

```bash
sudo ./deploy/ubuntu/install.sh
```

The installer preserves the existing environment file and data directory.

## Versioned upgrades in 5.28+

The active application is now `/opt/divedeep/current`, which points to a verified release under `/opt/divedeep/releases/<version>`.

Use:

```bash
sudo /opt/divedeep/current/deploy/ubuntu/upgrade.sh DiveDeep-vNEXT.zip
```

See `UBUNTU_UPGRADES.md` for backups, drain behavior, rollback, and smoke-test procedures.
