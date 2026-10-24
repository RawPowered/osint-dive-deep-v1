from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path


APP_DIRECTORY = "osint-dive-deep"


def _configured_path(name: str, environ: Mapping[str, str]) -> Path | None:
    value = environ.get(name, "").strip()
    return Path(value).expanduser() if value else None


def resolve_data_root(
    environ: Mapping[str, str] | None = None,
    home: Path | None = None,
) -> Path:
    values = os.environ if environ is None else environ
    configured = _configured_path("OSINT_STUDIO_DATA_DIR", values)
    if configured:
        return configured
    xdg_root = _configured_path("XDG_DATA_HOME", values)
    if xdg_root:
        return xdg_root / APP_DIRECTORY
    return (home or Path.home()) / ".local" / "share" / APP_DIRECTORY


def resolve_cache_root(
    environ: Mapping[str, str] | None = None,
    home: Path | None = None,
) -> Path:
    values = os.environ if environ is None else environ
    configured = _configured_path("OSINT_STUDIO_CACHE_DIR", values)
    if configured:
        return configured
    xdg_root = _configured_path("XDG_CACHE_HOME", values)
    if xdg_root:
        return xdg_root / APP_DIRECTORY
    return (home or Path.home()) / ".cache" / APP_DIRECTORY


def ensure_private_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        path.chmod(0o700)
    return path


DATA_ROOT = resolve_data_root()
CACHE_ROOT = resolve_cache_root()
PROFILE_ROOT = DATA_ROOT / "profiles"
DRAFT_ROOT = DATA_ROOT / "drafts"
JOB_ROOT = DATA_ROOT / "jobs"
CASE_DATABASE_PATH = DATA_ROOT / "studio.sqlite"
CASE_ARTIFACT_ROOT = DATA_ROOT / "case-artifacts"
PROPERTY_ROOT = DATA_ROOT / "property-intel"
PROPERTY_DATABASE_PATH = PROPERTY_ROOT / "property-market.duckdb"
PROPERTY_PARQUET_ROOT = PROPERTY_ROOT / "parquet"
PROPERTY_EXPORT_ROOT = PROPERTY_ROOT / "exports"
PROPERTY_BROWSER_ROOT = PROPERTY_ROOT / "browser"
PROPERTY_SECRET_PATH = PROPERTY_ROOT / "property-secrets.env"
PROPERTY_AUDIT_PATH = PROPERTY_ROOT / "audit" / "actions.jsonl"
PRIVACY_ROOT = DATA_ROOT / "privacy-removal"
PRIVACY_DATABASE_PATH = PRIVACY_ROOT / "privacy-removal.sqlite"
PRIVACY_EXPORT_ROOT = PRIVACY_ROOT / "exports"
CONTACT_ENRICHMENT_ROOT = DATA_ROOT / "contact-enrichment"
CONTACT_ENRICHMENT_DATABASE_PATH = CONTACT_ENRICHMENT_ROOT / "contact-enrichment.sqlite"
