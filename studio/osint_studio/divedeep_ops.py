from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from .arsenal import parse_tool_output
from .executor import ExecutionResult, run_command
from .divedeep_bridge import DIVEDEEP_WORKSPACE_ROOT, export_results, import_packet, record_findings
from .paths import ensure_private_directory
from .registry import registry_by_key


OPERATOR_STATE_FILE = "operator-state.json"
OBSERVABLES_FILE = "observables.json"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
RUN_SH_PATH = PROJECT_ROOT / "run.sh"
INTERNAL_TOOLS = {"ddgs-text", "ddgs-images", "url-probe", "photo-fingerprint"}
EXTERNAL_TOOLS = {"sherlock", "maigret", "spiderfoot_cli"}
MANUAL_TOOLS = {"authorized-image-match-review", "sensitive-source-review"}
SUPPORTED_LOCAL_TOOLS = INTERNAL_TOOLS | EXTERNAL_TOOLS | MANUAL_TOOLS
GENERIC_EMAIL_LOCALS = {"admin", "billing", "contact", "hello", "help", "info", "legal", "office", "privacy", "sales", "service", "support"}
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{2,64}$")

MISSION_FAMILIES: dict[str, dict[str, str]] = {
    "web-search": {"label": "Exact web discovery", "description": "Search exact authorized names, aliases, emails, phones, addresses and usernames."},
    "image-search": {"label": "Indexed image discovery", "description": "Search public image indexes using authorized names, aliases and usernames."},
    "username-search": {"label": "Username discovery", "description": "Run Sherlock and Maigret against authorized or safely derived username candidates."},
    "correlation": {"label": "Passive correlation", "description": "Run SpiderFoot's passive source group against supported authorized identifiers."},
    "declared-profiles": {"label": "Declared profile validation", "description": "Fetch bounded metadata from customer-declared public profile URLs."},
    "photo-review": {"label": "Authorized photo review", "description": "Fingerprint downloaded reference photos and prepare a manual reverse-image review step."},
    "sensitive-review": {"label": "Sensitive source review", "description": "Create a restricted manual task when the customer has separately authorized sensitive review."},
}

MISSION_PRESETS: dict[str, tuple[str, ...]] = {
    "Essential": ("web-search", "username-search", "declared-profiles"),
    "Deep": ("web-search", "image-search", "username-search", "correlation", "declared-profiles", "photo-review"),
    "Full authorized": tuple(MISSION_FAMILIES),
}

PACKAGE_ORDER = ("standard", "deep", "image", "sensitive")

PACKAGE_FLOWS: dict[str, dict[str, Any]] = {
    "standard": {
        "label": "Standard Social",
        "description": "Mainstream public-web, username, and declared-profile coverage.",
        "families": ("web-search", "username-search", "declared-profiles"),
        "aliases": ("standard", "social", "essential", "basic", "starter", "level-1", "level1", "tier-1", "tier1"),
        "limits": {
            "textResults": 50,
            "imageResults": 0,
            "nameTargets": 8,
            "identifierTargets": 8,
            "usernameTargets": 15,
            "correlationTargets": 0,
            "declaredProfiles": 25,
            "spiderfootThreads": 0,
        },
    },
    "deep": {
        "label": "Deep Social",
        "description": "Expanded public-web, indexed-image, username, directory, and passive-correlation coverage.",
        "families": ("web-search", "image-search", "username-search", "correlation", "declared-profiles"),
        "aliases": ("deep", "deep-social", "expanded", "advanced", "level-2", "level2", "tier-2", "tier2"),
        "limits": {
            "textResults": 75,
            "imageResults": 50,
            "nameTargets": 12,
            "identifierTargets": 12,
            "usernameTargets": 25,
            "correlationTargets": 30,
            "declaredProfiles": 50,
            "spiderfootThreads": 3,
        },
    },
    "image": {
        "label": "Image Discovery",
        "description": "Deep Social coverage plus authorized photo fingerprinting and image-recon review.",
        "families": ("web-search", "image-search", "username-search", "correlation", "declared-profiles", "photo-review"),
        "aliases": ("image", "images", "image-discovery", "image-recon", "visual", "photo", "photo-recon"),
        "limits": {
            "textResults": 100,
            "imageResults": 100,
            "nameTargets": 12,
            "identifierTargets": 12,
            "usernameTargets": 25,
            "correlationTargets": 40,
            "declaredProfiles": 50,
            "spiderfootThreads": 4,
        },
    },
    "sensitive": {
        "label": "Sensitive Exposure",
        "description": "Full authorized coverage, including image review and separately consented sensitive-source review.",
        "families": tuple(MISSION_FAMILIES),
        "aliases": ("sensitive", "adult", "sensitive-exposure", "premium", "full", "level-3", "level3", "level-4", "level4", "tier-3", "tier3", "tier-4", "tier4"),
        "limits": {
            "textResults": 100,
            "imageResults": 100,
            "nameTargets": 15,
            "identifierTargets": 15,
            "usernameTargets": 25,
            "correlationTargets": 50,
            "declaredProfiles": 50,
            "spiderfootThreads": 5,
        },
    },
}


def normalize_package_key(value: Any) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    for key, profile in PACKAGE_FLOWS.items():
        if normalized == key or normalized in profile.get("aliases", ()):
            return key
    return ""


def infer_package_key(packet: dict[str, Any]) -> str:
    customer = packet.get("customer") if isinstance(packet.get("customer"), dict) else {}
    direct = normalize_package_key(customer.get("planTier"))
    if direct:
        return direct
    source_sets = {str(item).strip().lower() for item in packet.get("manualProcessing", {}).get("sourceSets", []) or []}
    if "sensitive-adult-sites" in source_sets and customer.get("sensitiveContentConsentAt"):
        return "sensitive"
    if "authorized-image-match-review" in source_sets or packet.get("photos"):
        return "image"
    if {"people-search", "maigret-supported"} & source_sets:
        return "deep"
    return "standard"


def package_flow(package_key: str | None) -> dict[str, Any]:
    key = normalize_package_key(package_key) or "standard"
    profile = PACKAGE_FLOWS[key]
    return {
        "key": key,
        "label": profile["label"],
        "description": profile["description"],
        "families": list(profile["families"]),
        "limits": dict(profile["limits"]),
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    if os.name == "posix":
        path.chmod(0o600)


def safe_name(value: str, fallback: str = "item") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "")).strip("._")
    return cleaned[:120] or fallback


def resolve_workspace(value: str | Path) -> Path:
    workspace = Path(value).expanduser().resolve()
    if not workspace.is_dir() or not (workspace / "manifest.json").is_file():
        raise ValueError("The selected DiveDeep workspace is invalid.")
    manifest = _read_json(workspace / "manifest.json", {})
    if manifest.get("workspaceType") != "divedeep.manual-recon":
        raise ValueError("The selected directory is not a DiveDeep workspace.")
    return workspace


def _packet_groups(packet: dict[str, Any]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    profile = packet.get("divedeep", {}).get("profile", {})
    for item in profile.get("identifiers", []) or []:
        if not isinstance(item, dict) or item.get("status") not in {None, "active"}:
            continue
        kind = str(item.get("type") or "other").strip().lower()
        value = str(item.get("value") or "").strip()
        if value and value not in groups.setdefault(kind, []):
            groups[kind].append(value)
    for connection in packet.get("connections", []) or []:
        username = str(connection.get("username") or "").strip()
        if username and username not in groups.setdefault("username", []):
            groups["username"].append(username)
    return groups


def _username_candidates(packet: dict[str, Any]) -> list[str]:
    groups = _packet_groups(packet)
    candidates = list(groups.get("username", []))
    for email in groups.get("email", []):
        local = email.split("@", 1)[0].strip()
        if local.casefold() not in GENERIC_EMAIL_LOCALS and USERNAME_RE.fullmatch(local) and local not in candidates:
            candidates.append(local)
    for alias in groups.get("alias", []):
        if USERNAME_RE.fullmatch(alias) and alias not in candidates:
            candidates.append(alias)
    for connection in packet.get("connections", []) or []:
        path = urlparse(str(connection.get("profileUrl") or "")).path.strip("/")
        tail = path.split("/")[-1] if path else ""
        if tail.casefold() not in {"", "profile", "people", "user", "users"} and USERNAME_RE.fullmatch(tail) and tail not in candidates:
            candidates.append(tail)
    return candidates[:25]


def _jurisdiction_hint(packet: dict[str, Any]) -> str:
    profile = packet.get("divedeep", {}).get("profile", {})
    region = str(profile.get("jurisdictionRegion") or "").strip()
    country = str(profile.get("jurisdictionCountry") or "").strip()
    return ", ".join(item for item in (region, country) if item)


def _job(tool: str, target_type: str, target: str, *, family: str, category: str, values: dict[str, Any] | None = None, auto_stage: bool = True, traffic: str = "passive") -> dict[str, Any]:
    return {
        "tool": tool,
        "targetType": target_type,
        "target": target,
        "family": family,
        "contentCategory": category,
        "trafficClass": traffic,
        "autoStage": auto_stage,
        "values": values or {},
    }


def build_identity_job_plan(
    packet: dict[str, Any],
    families: list[str] | tuple[str, ...] | None = None,
    *,
    package_key: str | None = None,
) -> dict[str, Any]:
    resolved_package = normalize_package_key(package_key) or infer_package_key(packet)
    flow = package_flow(resolved_package)
    selected = tuple(dict.fromkeys(families or flow["families"]))
    unsupported = [value for value in selected if value not in MISSION_FAMILIES]
    if unsupported:
        raise ValueError(f"Unknown mission families: {', '.join(unsupported)}")

    limits = flow["limits"]
    groups = _packet_groups(packet)
    usernames = _username_candidates(packet)[: int(limits["usernameTargets"])]
    jurisdiction = _jurisdiction_hint(packet)
    source_sets = {str(item) for item in packet.get("manualProcessing", {}).get("sourceSets", []) or []}
    jobs: list[dict[str, Any]] = []
    warnings: list[str] = []

    def add(record: dict[str, Any]) -> None:
        key = (record["tool"], record["targetType"], record["target"])
        if key not in {(item["tool"], item["targetType"], item["target"]) for item in jobs}:
            jobs.append(record)

    if "web-search" in selected:
        names = (groups.get("name", []) + groups.get("alias", []))[: int(limits["nameTargets"])]
        for value in names:
            exact_query = f'"{value}"'
            add(_job("ddgs-text", "query", exact_query, family="web-search", category="public-web", values={"query": exact_query, "maxResults": limits["textResults"], "subjectIdentifier": value}))
            if jurisdiction:
                local_query = f'"{value}" "{jurisdiction}"'
                add(_job("ddgs-text", "query", local_query, family="web-search", category="public-web", values={"query": local_query, "maxResults": limits["textResults"], "subjectIdentifier": value}))
        for kind in ("email", "phone", "address"):
            for value in groups.get(kind, [])[: int(limits["identifierTargets"])]:
                query = f'"{value}"'
                add(_job("ddgs-text", "query", query, family="web-search", category="people-search" if kind != "email" else "public-web", values={"query": query, "maxResults": limits["textResults"], "subjectIdentifier": value}))
        for value in usernames:
            exact_query = f'"{value}"'
            profile_query = f'"{value}" profile OR account OR user'
            add(_job("ddgs-text", "query", exact_query, family="web-search", category="social-profile", values={"query": exact_query, "maxResults": limits["textResults"], "subjectIdentifier": value}))
            add(_job("ddgs-text", "query", profile_query, family="web-search", category="social-profile", values={"query": profile_query, "maxResults": limits["textResults"], "subjectIdentifier": value}))
        if resolved_package in {"deep", "image", "sensitive"}:
            for value in groups.get("domain", [])[: int(limits["identifierTargets"])]:
                query = f'"{value}"'
                add(_job("ddgs-text", "query", query, family="web-search", category="public-web", values={"query": query, "maxResults": limits["textResults"], "subjectIdentifier": value}))

    if "image-search" in selected:
        image_targets = (groups.get("name", []) + groups.get("alias", []) + usernames)[: int(limits["usernameTargets"])]
        for value in image_targets:
            query = f'"{value}"'
            add(_job("ddgs-images", "query", query, family="image-search", category="image-match", values={"query": query, "maxResults": limits["imageResults"], "subjectIdentifier": value}))

    if "username-search" in selected:
        allow_sherlock = "sherlock-supported" in source_sets or not source_sets
        allow_maigret = "maigret-supported" in source_sets or not source_sets
        if not allow_sherlock:
            warnings.append("Sherlock was excluded because the intake packet does not authorize the sherlock-supported source set.")
        if not allow_maigret:
            warnings.append("Maigret was excluded because the intake packet does not authorize the maigret-supported source set.")
        for username in usernames:
            if allow_sherlock:
                add(_job("sherlock", "username", username, family="username-search", category="social-profile", values={"username": username, "sites": []}))
            if allow_maigret:
                add(_job("maigret", "username", username, family="username-search", category="social-profile", values={"username": username, "sites": []}))

    if "correlation" in selected:
        correlation_targets: list[tuple[str, str]] = []
        for kind in ("name", "alias", "email", "phone", "username", "domain"):
            correlation_targets.extend((kind, value) for value in groups.get(kind, [])[: int(limits["identifierTargets"])])
        correlation_targets.extend(("username", value) for value in usernames if value not in groups.get("username", []))
        for target_type, target in correlation_targets[: int(limits["correlationTargets"])]:
            add(_job("spiderfoot_cli", target_type, target, family="correlation", category="identity-correlation", values={"target": target, "preset": "passive", "maxThreads": limits["spiderfootThreads"]}))

    if "declared-profiles" in selected:
        urls: list[str] = []
        for connection in packet.get("connections", []) or []:
            url = str(connection.get("profileUrl") or "").strip()
            if url.startswith(("http://", "https://")) and url not in urls:
                urls.append(url)
        for url in urls[: int(limits["declaredProfiles"])]:
            add(_job("url-probe", "url", url, family="declared-profiles", category="social-profile", values={"url": url, "timeout": 30}))

    if "photo-review" in selected:
        authorized = "authorized-image-match-review" in source_sets or not source_sets
        photos = packet.get("photos", []) or []
        if not authorized:
            warnings.append("Photo review was excluded because the intake packet does not authorize image-match review.")
        elif not photos:
            warnings.append("The selected package includes image review, but the customer packet contains no reference photos.")
        else:
            for photo in photos:
                extension = ".jpg" if photo.get("mimeType") == "image/jpeg" else ".png" if photo.get("mimeType") == "image/png" else ".webp"
                relative = f"evidence/reference-photos/{photo.get('id')}{extension}"
                add(_job("photo-fingerprint", "reference-photo", relative, family="photo-review", category="image-match", values={"path": relative, "photoId": photo.get("id"), "sha256": photo.get("sha256", "")}, auto_stage=False))
                add(_job("authorized-image-match-review", "reference-photo", relative, family="photo-review", category="image-match", values={"photoId": photo.get("id"), "sha256": photo.get("sha256", ""), "purpose": photo.get("purpose", "identity_search")}, auto_stage=False, traffic="manual-provider"))

    customer = packet.get("customer", {})
    if "sensitive-review" in selected:
        if "sensitive-adult-sites" not in source_sets:
            warnings.append("Sensitive-source review was excluded because the intake packet does not authorize that source set.")
        elif not customer.get("sensitiveContentConsentAt"):
            warnings.append("Sensitive-source review was excluded because separate customer consent is missing.")
        else:
            add(_job("sensitive-source-review", "authorized-profile", str(packet.get("divedeep", {}).get("profile", {}).get("id") or "profile"), family="sensitive-review", category="sensitive", values={"consentAt": customer.get("sensitiveContentConsentAt")}, auto_stage=False, traffic="manual-provider"))

    family_counts: dict[str, int] = {}
    for job in jobs:
        family = str(job.get("family") or "other")
        family_counts[family] = family_counts.get(family, 0) + 1

    return {
        "schemaVersion": 3,
        "generatedAt": utc_now(),
        "customerId": packet.get("customer", {}).get("id", ""),
        "profileId": packet.get("divedeep", {}).get("profile", {}).get("id", ""),
        "package": flow,
        "missionFamilies": list(selected),
        "authorizedSourceSets": sorted(source_sets),
        "familyCounts": family_counts,
        "warnings": warnings,
        "jobs": jobs,
        "notes": [
            "Every executable job is generated from an authorized identifier, declared profile, or reference-photo record.",
            "The package profile controls scope and result depth; intake authorization still controls sensitive and provider-specific work.",
            "The UI launches allowlisted jobs through run.sh and stores exact raw output before normalization.",
            "Candidate URLs remain review findings until an operator confirms the identity match.",
        ],
    }


def _write_recon_case_files(workspace: Path, packet: dict[str, Any], plan: dict[str, Any]) -> Path:
    case_dir = ensure_private_directory(workspace / "case")
    package = plan.get("package") if isinstance(plan.get("package"), dict) else package_flow(infer_package_key(packet))
    family_counts = plan.get("familyCounts") if isinstance(plan.get("familyCounts"), dict) else {}
    customer = packet.get("customer") if isinstance(packet.get("customer"), dict) else {}
    profile = packet.get("divedeep", {}).get("profile", {})
    case_summary = {
        "schemaVersion": 1,
        "caseType": "divedeep.identity-recon",
        "createdAt": utc_now(),
        "customerId": customer.get("id", ""),
        "profileId": profile.get("id", ""),
        "displayName": customer.get("displayName", ""),
        "sourcePlanTier": customer.get("planTier", ""),
        "package": package,
        "jobCount": len(plan.get("jobs", []) or []),
        "familyCounts": family_counts,
        "warnings": plan.get("warnings", []) or [],
        "workspace": str(workspace),
        "toolPlan": "../tool-plan.json",
        "operatorState": "../operator-state.json",
        "results": "../results.json",
    }
    _write_json(case_dir / "case.json", case_summary)
    _write_json(case_dir / "package-flow.json", package)
    _write_json(
        case_dir / "queue.json",
        {
            "schemaVersion": 1,
            "generatedAt": utc_now(),
            "packageKey": package.get("key", "standard"),
            "familyCounts": family_counts,
            "jobs": [
                {
                    "index": index,
                    "family": job.get("family", ""),
                    "tool": job.get("tool", ""),
                    "targetType": job.get("targetType", ""),
                    "target": job.get("target", ""),
                    "trafficClass": job.get("trafficClass", "passive"),
                }
                for index, job in enumerate(plan.get("jobs", []) or [])
            ],
        },
    )
    readme = (
        f"# DiveDeep Recon Case\n\n"
        f"Customer: {customer.get('displayName') or customer.get('id', '')}\n\n"
        f"Package: {package.get('label', '')}\n\n"
        f"Jobs: {len(plan.get('jobs', []) or [])}\n\n"
        "Launch DiveDeep with `./run.sh`, open DiveDeep Operations, select this workspace, and run the package queues.\n"
    )
    readme_path = case_dir / "START-HERE.md"
    readme_path.write_text(readme, encoding="utf-8")
    if os.name == "posix":
        readme_path.chmod(0o600)
    return case_dir


def rebuild_tool_plan(
    workspace_value: str | Path,
    families: list[str] | tuple[str, ...] | None = None,
    *,
    package_key: str | None = None,
) -> dict[str, Any]:
    workspace = resolve_workspace(workspace_value)
    packet = _read_json(workspace / "intake" / "divedeep-export.json", {}) or {}
    selected_package = normalize_package_key(package_key) or str((_read_json(workspace / "manifest.json", {}) or {}).get("packageKey") or infer_package_key(packet))
    plan = build_identity_job_plan(packet, families, package_key=selected_package)
    _write_json(workspace / "tool-plan.json", plan)
    initialize_operator_state(workspace)
    manifest = _read_json(workspace / "manifest.json", {}) or {}
    manifest.update(
        {
            "packageKey": plan["package"]["key"],
            "packageLabel": plan["package"]["label"],
            "caseDirectory": "case",
            "updatedAt": utc_now(),
        }
    )
    _write_json(workspace / "manifest.json", manifest)
    _write_recon_case_files(workspace, packet, plan)
    return plan


def list_workspaces(workspace_root: str | Path | None = None) -> list[dict[str, Any]]:
    root = Path(workspace_root).expanduser() if workspace_root else DIVEDEEP_WORKSPACE_ROOT
    if not root.exists():
        return []
    rows: list[dict[str, Any]] = []
    for manifest_path in root.glob("*/manifest.json"):
        manifest = _read_json(manifest_path, {})
        if manifest.get("workspaceType") != "divedeep.manual-recon":
            continue
        workspace = manifest_path.parent
        results = _read_json(workspace / "results.json", {}) or {}
        state = load_operator_state(workspace)
        rows.append(
            {
                **manifest,
                "workspace": str(workspace),
                "packageKey": manifest.get("packageKey") or str(((_read_json(workspace / "tool-plan.json", {}) or {}).get("package") or {}).get("key") or ""),
                "packageLabel": manifest.get("packageLabel") or str(((_read_json(workspace / "tool-plan.json", {}) or {}).get("package") or {}).get("label") or ""),
                "findingCount": len(results.get("findings", []) or []),
                "jobCount": len((_read_json(workspace / "tool-plan.json", {}) or {}).get("jobs", []) or []),
                "completedJobs": sum(1 for item in (state.get("jobs", {}) or {}).values() if item.get("status") in {"completed", "reviewed", "manual_complete"}),
                "operatorStatus": state.get("status", "intake"),
                "updatedAt": state.get("updatedAt") or manifest.get("importedAt", ""),
            }
        )
    return sorted(rows, key=lambda item: str(item.get("updatedAt") or ""), reverse=True)


def load_observables(workspace_value: str | Path) -> dict[str, Any]:
    workspace = Path(workspace_value).expanduser().resolve()
    return _read_json(workspace / OBSERVABLES_FILE, {"schemaVersion": 1, "updatedAt": utc_now(), "items": []}) or {"schemaVersion": 1, "items": []}


def load_workspace_bundle(workspace_value: str | Path) -> dict[str, Any]:
    workspace = resolve_workspace(workspace_value)
    return {
        "workspace": workspace,
        "manifest": _read_json(workspace / "manifest.json", {}) or {},
        "intake": _read_json(workspace / "intake" / "divedeep-export.json", {}) or {},
        "toolPlan": _read_json(workspace / "tool-plan.json", {}) or {},
        "results": _read_json(workspace / "results.json", {}) or {},
        "operatorState": load_operator_state(workspace),
        "observables": load_observables(workspace),
        "caseSummary": _read_json(workspace / "case" / "case.json", {}) or {},
    }


def import_uploaded_packet(
    filename: str,
    data: bytes,
    *,
    workspace_root: str | Path | None = None,
    package_key: str | None = None,
) -> dict[str, Any]:
    root = ensure_private_directory(Path(workspace_root).expanduser() if workspace_root else DIVEDEEP_WORKSPACE_ROOT)
    incoming = ensure_private_directory(root / "_incoming")
    digest = hashlib.sha256(data).hexdigest()[:12]
    path = incoming / f"{safe_name(Path(filename).stem, 'divedeep')}-{digest}.json"
    path.write_bytes(data)
    if os.name == "posix":
        path.chmod(0o600)
    imported = import_packet(path, workspace_root=root)
    workspace = Path(imported["workspace"])
    packet = _read_json(workspace / "intake" / "divedeep-export.json", {}) or {}
    selected_package = normalize_package_key(package_key) or infer_package_key(packet)
    plan = build_identity_job_plan(packet, package_key=selected_package)
    _write_json(workspace / "tool-plan.json", plan)
    initialize_operator_state(workspace)
    manifest = _read_json(workspace / "manifest.json", {}) or {}
    manifest.update(
        {
            "packageKey": plan["package"]["key"],
            "packageLabel": plan["package"]["label"],
            "caseDirectory": "case",
            "updatedAt": utc_now(),
        }
    )
    _write_json(workspace / "manifest.json", manifest)
    case_dir = _write_recon_case_files(workspace, packet, plan)
    imported["manifest"] = manifest
    imported["package"] = plan["package"]
    imported["caseDirectory"] = str(case_dir)
    imported["toolJobs"] = len(plan.get("jobs", []))
    return imported


def _job_key(index: int, job: dict[str, Any]) -> str:
    raw = f"{index}|{job.get('tool')}|{job.get('targetType')}|{job.get('target')}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def load_operator_state(workspace_value: str | Path) -> dict[str, Any]:
    workspace = Path(workspace_value).expanduser().resolve()
    plan = _read_json(workspace / "tool-plan.json", {}) or {}
    existing = _read_json(workspace / OPERATOR_STATE_FILE, {}) or {}
    jobs = existing.get("jobs") if isinstance(existing.get("jobs"), dict) else {}
    old_by_identity = {(item.get("tool"), item.get("targetType"), item.get("target")): item for item in jobs.values() if isinstance(item, dict)}
    normalized: dict[str, Any] = {}
    for index, job in enumerate(plan.get("jobs", []) or []):
        key = _job_key(index, job)
        prior = jobs.get(key) or old_by_identity.get((job.get("tool"), job.get("targetType"), job.get("target"))) or {}
        normalized[key] = {
            "jobKey": key,
            "index": index,
            "tool": job.get("tool", ""),
            "targetType": job.get("targetType", ""),
            "target": job.get("target", ""),
            "family": job.get("family", ""),
            "status": prior.get("status", "pending"),
            "startedAt": prior.get("startedAt"),
            "completedAt": prior.get("completedAt"),
            "returnCode": prior.get("returnCode"),
            "timedOut": prior.get("timedOut", False),
            "durationSeconds": prior.get("durationSeconds"),
            "outputPath": prior.get("outputPath", ""),
            "error": prior.get("error", ""),
            "notes": prior.get("notes", ""),
            "candidateCount": int(prior.get("candidateCount") or 0),
            "observableCount": int(prior.get("observableCount") or 0),
            "stagedCount": int(prior.get("stagedCount") or 0),
        }
    return {
        "schemaVersion": 2,
        "status": existing.get("status", "intake"),
        "operatorNotes": existing.get("operatorNotes", ""),
        "updatedAt": existing.get("updatedAt") or utc_now(),
        "jobs": normalized,
    }


def initialize_operator_state(workspace_value: str | Path) -> dict[str, Any]:
    workspace = resolve_workspace(workspace_value)
    state = load_operator_state(workspace)
    _write_json(workspace / OPERATOR_STATE_FILE, state)
    if not (workspace / OBSERVABLES_FILE).is_file():
        _write_json(workspace / OBSERVABLES_FILE, {"schemaVersion": 1, "updatedAt": utc_now(), "items": []})
    return state


def save_operator_state(workspace_value: str | Path, state: dict[str, Any]) -> None:
    workspace = resolve_workspace(workspace_value)
    state["updatedAt"] = utc_now()
    _write_json(workspace / OPERATOR_STATE_FILE, state)


def set_operator_status(workspace_value: str | Path, status: str, notes: str | None = None) -> dict[str, Any]:
    state = load_operator_state(workspace_value)
    state["status"] = status
    if notes is not None:
        state["operatorNotes"] = notes
    save_operator_state(workspace_value, state)
    return state


def _external_executable(tool_key: str) -> str | None:
    spec = registry_by_key().get(tool_key)
    if not spec:
        return None
    return next((shutil.which(name) for name in spec.executables if shutil.which(name)), None)


def job_install_status(job: dict[str, Any]) -> tuple[str, str]:
    tool = str(job.get("tool") or "")
    if tool in INTERNAL_TOOLS:
        return "Ready", "Included with DiveDeep"
    if tool in MANUAL_TOOLS:
        return "Manual", "Operator/provider review"
    executable = _external_executable(tool)
    spec = registry_by_key().get(tool)
    return ("Ready", executable or "") if executable else ("Missing", spec.install_hint if spec else "Install the required executable")


def build_job_argv(job: dict[str, Any], workspace_value: str | Path | None = None) -> list[str] | None:
    tool = str(job.get("tool") or "")
    target = str(job.get("target") or "").strip()
    values = job.get("values") if isinstance(job.get("values"), dict) else {}
    if not target:
        return None
    if tool == "sherlock":
        executable = _external_executable("sherlock") or "sherlock"
        return [executable, target, "--print-found"]
    if tool == "maigret":
        executable = _external_executable("maigret") or "maigret"
        return [executable, target, "--no-color", "--no-progressbar"]
    if tool == "spiderfoot_cli":
        executable = _external_executable("spiderfoot_cli") or "spiderfoot"
        return [executable, "-s", target, "-u", "passive", "-o", "json", "-max-threads", str(max(1, min(int(values.get("maxThreads") or 3), 5)))]
    if tool == "ddgs-text":
        return [sys.executable, "-m", "osint_studio.divedeep_worker", "search-text", "--query", str(values.get("query") or target), "--max-results", str(max(1, min(int(values.get("maxResults") or 30), 100)))]
    if tool == "ddgs-images":
        return [sys.executable, "-m", "osint_studio.divedeep_worker", "search-images", "--query", str(values.get("query") or target), "--max-results", str(max(1, min(int(values.get("maxResults") or 25), 100)))]
    if tool == "url-probe":
        return [sys.executable, "-m", "osint_studio.divedeep_worker", "probe-url", "--url", str(values.get("url") or target), "--timeout", str(max(5, min(int(values.get("timeout") or 20), 60)))]
    if tool == "photo-fingerprint":
        workspace = resolve_workspace(workspace_value) if workspace_value else Path.cwd()
        path = Path(str(values.get("path") or target))
        if not path.is_absolute():
            path = (workspace / path).resolve()
        return [sys.executable, "-m", "osint_studio.divedeep_worker", "fingerprint-photo", "--path", str(path)]
    return None


def job_output_path(workspace_value: str | Path, job: dict[str, Any]) -> Path:
    workspace = resolve_workspace(workspace_value)
    tool = safe_name(str(job.get("tool") or "manual"))
    target = safe_name(str(job.get("target") or "target"))
    output_dir = ensure_private_directory(workspace / "raw" / tool)
    return output_dir / f"{target}.txt"


def _append_observables(workspace: Path, index: int, job: dict[str, Any], result: ExecutionResult) -> int:
    tool = str(job.get("tool") or "")
    parser_key = tool if tool not in {"ddgs-text", "ddgs-images", "url-probe", "photo-fingerprint"} else "generic"
    _, events = parse_tool_output(parser_key, result)
    store = load_observables(workspace)
    current = store.get("items") if isinstance(store.get("items"), list) else []
    known = {(str(item.get("type")), str(item.get("value")).casefold(), str(item.get("sourceJob"))) for item in current if isinstance(item, dict)}
    added = 0
    for event in events[:5000]:
        key = (event.event_type, event.data.casefold(), _job_key(index, job))
        if key in known:
            continue
        current.append({
            "type": event.event_type,
            "value": event.data,
            "module": event.module,
            "confidence": event.confidence,
            "sourceJob": key[2],
            "tool": tool,
            "target": job.get("target", ""),
            "capturedAt": utc_now(),
        })
        known.add(key)
        added += 1
    store.update({"schemaVersion": 1, "updatedAt": utc_now(), "items": current[-25000:]})
    _write_json(workspace / OBSERVABLES_FILE, store)
    return added


def _json_records(text: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def extract_candidate_records(text: str, job: dict[str, Any]) -> list[dict[str, Any]]:
    tool = str(job.get("tool") or "")
    category = str(job.get("contentCategory") or "social-profile")
    subject = str((job.get("values") or {}).get("subjectIdentifier") or job.get("target") or "")
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for record in _json_records(text):
        kind = str(record.get("kind") or "")
        url = str(record.get("url") or record.get("canonicalUrl") or record.get("requestedUrl") or "").strip()
        if kind == "image-result":
            url = str(record.get("url") or record.get("source") or record.get("imageUrl") or "").strip()
        if not url.startswith(("http://", "https://")) or url in seen:
            continue
        seen.add(url)
        notes = " · ".join(value for value in (str(record.get("title") or "").strip(), str(record.get("snippet") or record.get("description") or "").strip()) if value)
        if record.get("imageUrl"):
            notes = (notes + f" · Image: {record.get('imageUrl')}").strip(" ·")
        candidate = {"url": url, "sourceName": str(record.get("source") or urlparse(url).hostname or "Unknown source"), "notes": notes, "category": category, "subject": subject}
        image_url = str(record.get("imageUrl") or record.get("thumbnail") or "").strip()
        if kind == "image-result" and image_url.startswith(("http://", "https://")):
            candidate["imageUrl"] = image_url
        candidates.append(candidate)
    if not candidates:
        for url in extract_public_urls(text):
            if url in seen:
                continue
            seen.add(url)
            candidates.append({"url": url, "sourceName": urlparse(url).hostname or "Unknown source", "notes": f"Candidate captured from {tool} output.", "category": category, "subject": subject})
    return candidates[:500]


def execute_job_direct(
    workspace_value: str | Path,
    index: int,
    *,
    timeout_seconds: int = 900,
    on_output: Callable[[str], None] | None = None,
) -> ExecutionResult:
    workspace = resolve_workspace(workspace_value)
    plan = _read_json(workspace / "tool-plan.json", {}) or {}
    jobs = plan.get("jobs", []) or []
    if index < 0 or index >= len(jobs):
        raise IndexError("Tool job index is outside the current plan.")
    job = jobs[index]
    tool = str(job.get("tool") or "")
    if tool not in SUPPORTED_LOCAL_TOOLS:
        raise ValueError("This tool is not approved for DiveDeep local execution.")
    argv = build_job_argv(job, workspace)
    if not argv:
        raise ValueError("This job is manual-only and cannot be launched as code.")
    status, hint = job_install_status(job)
    if status == "Missing":
        raise FileNotFoundError(hint)

    state = load_operator_state(workspace)
    key = _job_key(index, job)
    item = state["jobs"][key]
    item.update({"status": "running", "startedAt": utc_now(), "error": ""})
    state["status"] = "researching"
    save_operator_state(workspace, state)

    result = run_command(argv, timeout_seconds=max(30, min(int(timeout_seconds), 7200)), cwd=str(PROJECT_ROOT), on_output=on_output)
    output_path = job_output_path(workspace, job)
    output_path.write_text(result.output or result.error, encoding="utf-8")
    if os.name == "posix":
        output_path.chmod(0o600)

    observable_count = _append_observables(workspace, index, job, result)
    candidate_count = len(extract_candidate_records(result.output, job))
    staged_count = 0
    if result.return_code == 0 and not result.timed_out and not result.error and bool(job.get("autoStage", True)):
        staged = stage_job_candidates(workspace, index)
        staged_count = int(staged.get("recorded", 0)) + int(staged.get("updated", 0))

    state = load_operator_state(workspace)
    item = state["jobs"][key]
    item.update(
        {
            "status": "completed" if result.return_code == 0 and not result.timed_out and not result.error else "failed",
            "completedAt": utc_now(),
            "returnCode": result.return_code,
            "timedOut": result.timed_out,
            "durationSeconds": result.duration_seconds,
            "outputPath": str(output_path.relative_to(workspace)),
            "error": result.error,
            "candidateCount": candidate_count,
            "observableCount": observable_count,
            "stagedCount": staged_count,
        }
    )
    save_operator_state(workspace, state)
    return result


def execute_job(
    workspace_value: str | Path,
    index: int,
    *,
    timeout_seconds: int = 900,
    on_output: Callable[[str], None] | None = None,
) -> ExecutionResult:
    workspace = resolve_workspace(workspace_value)
    if os.name == "posix" and RUN_SH_PATH.is_file() and os.access(RUN_SH_PATH, os.X_OK):
        return run_command(
            [str(RUN_SH_PATH), "--divedeep-job", str(workspace), str(index), "--timeout", str(max(30, min(int(timeout_seconds), 7200)))],
            timeout_seconds=max(90, min(int(timeout_seconds) + 120, 7320)),
            cwd=str(PROJECT_ROOT),
            on_output=on_output,
        )
    return execute_job_direct(workspace, index, timeout_seconds=timeout_seconds, on_output=on_output)


def pending_executable_indices(workspace_value: str | Path, *, include_failed: bool = False) -> list[int]:
    workspace = resolve_workspace(workspace_value)
    bundle = load_workspace_bundle(workspace)
    jobs = bundle["toolPlan"].get("jobs", []) or []
    state_by_index = {int(item.get("index", -1)): item for item in bundle["operatorState"].get("jobs", {}).values()}
    accepted = {"pending"} | ({"failed"} if include_failed else set())
    output: list[int] = []
    for index, job in enumerate(jobs):
        if state_by_index.get(index, {}).get("status", "pending") not in accepted:
            continue
        status, _ = job_install_status(job)
        if status == "Ready" and build_job_argv(job, workspace):
            output.append(index)
    return output


def mark_job_status(workspace_value: str | Path, index: int, status: str, notes: str = "") -> dict[str, Any]:
    workspace = resolve_workspace(workspace_value)
    plan = _read_json(workspace / "tool-plan.json", {}) or {}
    jobs = plan.get("jobs", []) or []
    if index < 0 or index >= len(jobs):
        raise IndexError("Tool job index is outside the current plan.")
    state = load_operator_state(workspace)
    key = _job_key(index, jobs[index])
    state["jobs"][key]["status"] = status
    state["jobs"][key]["notes"] = notes
    if status in {"completed", "reviewed", "manual_complete", "skipped"}:
        state["jobs"][key]["completedAt"] = utc_now()
    save_operator_state(workspace, state)
    return state


def read_job_output(workspace_value: str | Path, index: int) -> str:
    workspace = resolve_workspace(workspace_value)
    plan = _read_json(workspace / "tool-plan.json", {}) or {}
    jobs = plan.get("jobs", []) or []
    if index < 0 or index >= len(jobs):
        return ""
    state = load_operator_state(workspace)
    key = _job_key(index, jobs[index])
    relative = str(state["jobs"].get(key, {}).get("outputPath") or "")
    path = (workspace / relative).resolve() if relative else job_output_path(workspace, jobs[index])
    if not str(path).startswith(str(workspace)) or not path.is_file():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def extract_public_urls(text: str) -> list[str]:
    candidates = re.findall(r"https?://[^\s<>'\"\]\)]+", text or "")
    results: list[str] = []
    for value in candidates:
        clean = value.rstrip(".,;:!?")
        parsed = urlparse(clean)
        if parsed.scheme in {"http", "https"} and parsed.netloc and clean not in results:
            results.append(clean)
    return results[:500]



def store_reference_photo(
    workspace_value: str | Path,
    photo_id: str,
    mime_type: str,
    data: bytes,
    *,
    expected_sha256: str = "",
) -> Path:
    workspace = resolve_workspace(workspace_value)
    digest = hashlib.sha256(data).hexdigest()
    expected = str(expected_sha256 or "").strip().lower()
    if expected and re.fullmatch(r"[0-9a-f]{64}", expected) and digest != expected:
        raise ValueError("The uploaded reference photo does not match the SHA-256 recorded by DiveDeep.")
    normalized_mime = str(mime_type).lower()
    suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(normalized_mime)
    if not suffix:
        raise ValueError("Reference photos must be JPEG, PNG, or WebP.")
    signatures = {
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP",
    }
    if not signatures[normalized_mime]:
        raise ValueError("The uploaded file signature does not match the recorded image type.")
    directory = ensure_private_directory(workspace / "evidence" / "reference-photos")
    path = directory / f"{safe_name(photo_id, 'photo')}{suffix}"
    path.write_bytes(data)
    if os.name == "posix":
        path.chmod(0o600)
    return path

def store_evidence_upload(workspace_value: str | Path, filename: str, data: bytes) -> Path:
    workspace = resolve_workspace(workspace_value)
    digest = hashlib.sha256(data).hexdigest()
    suffix = Path(filename).suffix.lower()[:12]
    stored = ensure_private_directory(workspace / "evidence" / "operator-uploads") / f"{digest[:16]}-{safe_name(Path(filename).stem)}{suffix}"
    if not stored.exists():
        stored.write_bytes(data)
        if os.name == "posix":
            stored.chmod(0o600)
    return stored


def record_payload(workspace_value: str | Path, payload: dict[str, Any] | list[dict[str, Any]]) -> dict[str, Any]:
    workspace = resolve_workspace(workspace_value)
    records = payload if isinstance(payload, list) else [payload]
    audit_dir = ensure_private_directory(workspace / "intake" / "operator-records")
    digest = hashlib.sha256(json.dumps(records, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:12]
    path = audit_dir / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{digest}.json"
    _write_json(path, {"findings": records})
    result = record_findings(workspace, path)
    state = load_operator_state(workspace)
    state["status"] = "results_ready"
    save_operator_state(workspace, state)
    return result


def stage_job_candidates(workspace_value: str | Path, index: int, selected_urls: list[str] | None = None) -> dict[str, Any]:
    workspace = resolve_workspace(workspace_value)
    plan = _read_json(workspace / "tool-plan.json", {}) or {}
    jobs = plan.get("jobs", []) or []
    if index < 0 or index >= len(jobs):
        raise IndexError("Tool job index is outside the current plan.")
    job = jobs[index]
    output = read_job_output(workspace, index)
    candidates = extract_candidate_records(output, job)
    if selected_urls is not None:
        allowed = set(selected_urls)
        candidates = [item for item in candidates if item["url"] in allowed]
    evidence_path = job_output_path(workspace, job)
    records: list[dict[str, Any]] = []
    for item in candidates:
        records.append(
            {
                "sourceName": item["sourceName"],
                "listingUrl": item["url"],
                "subjectIdentifier": item["subject"],
                "matchConfidence": 0.55 if str(job.get("tool")) in {"ddgs-text", "ddgs-images"} else 0.65,
                "contentCategory": item["category"],
                "status": "review",
                "notes": (item["notes"] + f" Candidate staged from {job.get('tool')} output; identity review required.").strip(),
                "evidence": [
                    {
                        "type": "tool-output",
                        "path": str(evidence_path.relative_to(workspace)),
                        "notes": f"{job.get('tool')} output for authorized target {job.get('target')}",
                        "mediaType": "text/plain",
                    }
                ],
            }
        )
    if not records:
        return {"workspace": str(workspace), "recorded": 0, "updated": 0, "total": len((_read_json(workspace / "results.json", {}) or {}).get("findings", []))}
    result = record_payload(workspace, records)
    return result


def stage_urls_from_job(workspace_value: str | Path, index: int, urls: list[str] | None = None) -> dict[str, Any]:
    return stage_job_candidates(workspace_value, index, urls)


def export_workspace_results(workspace_value: str | Path) -> dict[str, Any]:
    workspace = resolve_workspace(workspace_value)
    result = export_results(workspace)
    output = Path(result["output"])
    state = load_operator_state(workspace)
    state["status"] = "exported"
    save_operator_state(workspace, state)
    return {"output": str(output), "packet": _read_json(output, {}) or {}}


def workspace_file_bytes(workspace_value: str | Path, relative_path: str) -> bytes:
    workspace = resolve_workspace(workspace_value)
    path = (workspace / relative_path).resolve()
    if not str(path).startswith(str(workspace)) or not path.is_file():
        raise FileNotFoundError(relative_path)
    return path.read_bytes()
