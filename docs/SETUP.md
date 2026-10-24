# Setup

## Local research studio

Use Python 3.12 or 3.13. Run `python launch.py` on Windows or `python3 launch.py` on Linux from the repository root. Linux distributions may require their Python venv package. Open the printed localhost address. The launcher binds only to your computer.

New installs have no cases, targets, saved searches, or credentials. The default data directory is `~/.local/share/osint-dive-deep`; the cache is `~/.cache/osint-dive-deep`, including on Windows. Set `OSINT_STUDIO_DATA_DIR` / `OSINT_STUDIO_CACHE_DIR` before launch for a different private location. Avoid shared or version-controlled directories.

Review `studio/env.example` for optional provider and local API settings. Export chosen values in the process environment; the launcher does not automatically load this shell-oriented example. Missing paid provider keys disable those provider features. Browser-assisted property research requires installing the Playwright Chromium browser in the studio environment:

```powershell
# Windows
.venv/Scripts/python.exe -m playwright install chromium
```

```sh
# Linux
.venv/bin/python -m playwright install chromium
```

## Optional research tools

The Tool Arsenal detects executables on PATH. Install tools in separate environments to avoid conflicts with the studio's dependencies. A Python package manager such as pipx can expose them on PATH:

```sh
pipx install sherlock-project==0.16.0
pipx install maigret==0.6.1
pipx install shodan
```

Initialize Shodan with your own account credential according to its CLI documentation. Never commit that credential or its user configuration. Sherlock and Maigret are public-profile discovery aids; a matching username is not proof of identity. Tools provided through Linux distributions may not run natively on Windows. The core studio remains usable when an optional executable is unavailable.

## Web platform

Install Node 22+ and MySQL 8. In `web/`, run `npm ci`, then `npm start`. With no database configured, the installer should be shown; complete it using your own local database and administrator details. The backend's environment example is `web/.env.example`; never commit a populated `.env`.

For local development, set `NODE_ENV=development`, `HOST=127.0.0.1`, and `COOKIE_SECURE=false`. Hosted production uses HTTPS, secure cookies, strong independent session/encryption/integrity keys, a unique installation identity, exact allowed origins, and the supplied environment-separation gates. Configure the legal entity, privacy contact and policies for your operation before enabling customer onboarding.

The customer pages are under `/divedeep/`; administration uses the installation-specific path. The static frontend supports a separate runtime API origin. For hosted jobs, configure Cloud Run and private artifact storage after the API is installed. See `studio/deploy/cloud-run/`, `studio/Dockerfile.cloudrun`, and `web/deploy/`.

No deployment project, domain, bucket, customer account or secret is preconfigured. The examples are reference templates, not ready-to-run production credentials.
