from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import __version__

API_VERSION = "1.1"
INTAKE_SCHEMA_VERSIONS = [2]
RESULT_SCHEMA_VERSIONS = [1]
BUNDLE_SCHEMA_VERSIONS = [1]
FEATURES = [
    "authenticated-api",
    "persistent-job-queue",
    "package-plans",
    "segmented-export",
    "image-recon",
    "run-progress",
    "evidence-manifest",
    "drain-mode",
    "node-telemetry",
    "versioned-releases",
    "atomic-rollback",
    "ephemeral-cloud-run-worker",
    "job-scoped-bootstrap",
    "worker-heartbeats",
    "worker-checkpoints",
    "source-attempt-streaming",
    "candidate-streaming",
    "direct-artifact-transfer",
    "verified-ephemeral-cleanup",
]


def application_root() -> Path:
    return Path(__file__).resolve().parents[1]


def release_manifest_path() -> Path:
    return application_root() / "RELEASE.json"


def load_release_manifest() -> dict[str, Any]:
    path = release_manifest_path()
    if not path.is_file():
        return {
            "product": "DiveDeep",
            "appVersion": __version__,
            "apiVersion": API_VERSION,
            "features": FEATURES,
        }
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        value = {}
    return value if isinstance(value, dict) else {}


def compatibility_payload() -> dict[str, Any]:
    manifest = load_release_manifest()
    return {
        "product": "DiveDeep",
        "appVersion": __version__,
        "apiVersion": API_VERSION,
        "intakeSchemas": INTAKE_SCHEMA_VERSIONS,
        "resultSchemas": RESULT_SCHEMA_VERSIONS,
        "bundleSchemas": BUNDLE_SCHEMA_VERSIONS,
        "features": FEATURES,
        "releaseChannel": manifest.get("releaseChannel", "stable"),
        "releasedAt": manifest.get("releasedAt"),
        "minimumDiveDeepConnectorVersion": manifest.get("minimumDiveDeepConnectorVersion", "1.0"),
        "minimumDiveDeepBackendVersion": manifest.get("minimumDiveDeepBackendVersion", manifest.get("minimumDiveDeepConnectorVersion", "1.0")),
        "workerProtocolVersion": manifest.get("workerProtocolVersion"),
    }
