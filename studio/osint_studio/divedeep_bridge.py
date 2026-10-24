from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .case_store import CaseStore
from .paths import DATA_ROOT, ensure_private_directory
from .privacy_store import PrivacyStore
from .privacy_templates import LEGAL_BASIS_PRESETS, TEMPLATE_BY_KEY, render_template


DIVEDEEP_WORKSPACE_ROOT = DATA_ROOT / "divedeep-workspaces"
RESULT_PACKET_TYPE = "divedeep.recon-results"
RESULT_SCHEMA_VERSION = 1


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read_json(path: str | Path) -> dict[str, Any]:
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("JSON root must be an object.")
    return value


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    if os.name == "posix":
        path.chmod(0o600)


def _write_text(path: Path, value: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(value, encoding="utf-8")
    os.replace(temporary, path)
    if os.name == "posix":
        path.chmod(mode)


def _slug(value: str, fallback: str = "divedeep-customer") -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return cleaned[:80] or fallback


def _safe_url(value: Any, label: str = "listingUrl") -> str:
    text = str(value or "").strip()
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{label} must be a public HTTP or HTTPS URL.")
    return text[:2048]


def _confidence(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = 0.0
    return max(0.0, min(1.0, number))


def _packet_digest(packet: dict[str, Any]) -> str:
    canonical = json.dumps(packet, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def validate_intake_packet(packet: dict[str, Any]) -> None:
    if packet.get("product") != "OSINT Dive Deep v1":
        raise ValueError("This is not a OSINT Dive Deep v1 export packet.")
    if int(packet.get("schemaVersion") or 0) != 2:
        raise ValueError("Unsupported DiveDeep export schema. Expected schemaVersion 2.")
    customer = packet.get("customer")
    divedeep = packet.get("divedeep")
    profile = divedeep.get("profile") if isinstance(divedeep, dict) else None
    if not isinstance(customer, dict) or not str(customer.get("id") or "").strip():
        raise ValueError("DiveDeep customer ID is missing.")
    if not isinstance(profile, dict) or not str(profile.get("id") or "").strip():
        raise ValueError("Protected profile is missing.")
    authorization = profile.get("authorization")
    if not isinstance(authorization, dict) or authorization.get("status") != "active" or authorization.get("revokedAt"):
        raise ValueError("An active, non-revoked customer authorization is required.")
    instructions = packet.get("manualProcessing", {}).get("instructions", [])
    if not isinstance(instructions, list):
        raise ValueError("manualProcessing.instructions must be an array.")


def _workspace_from_input(value: str | Path) -> Path:
    path = Path(value).expanduser().resolve()
    if path.is_file() and path.name == "manifest.json":
        path = path.parent
    if not path.is_dir() or not (path / "manifest.json").is_file():
        raise ValueError("Workspace must contain manifest.json.")
    return path


def _manifest(workspace: Path) -> dict[str, Any]:
    value = _read_json(workspace / "manifest.json")
    if value.get("workspaceType") != "divedeep.manual-recon":
        raise ValueError("Not a DiveDeep DiveDeep workspace.")
    return value


def _identifier_groups(packet: dict[str, Any]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    profile = packet["divedeep"]["profile"]
    for item in profile.get("identifiers", []):
        if not isinstance(item, dict) or item.get("status") != "active":
            continue
        kind = str(item.get("type") or "other").strip().lower()
        value = str(item.get("value") or "").strip()
        if value and value not in groups.setdefault(kind, []):
            groups[kind].append(value)
    for connection in packet.get("connections", []):
        username = str(connection.get("username") or "").strip()
        if username and username not in groups.setdefault("username", []):
            groups["username"].append(username)
    return groups


def _preserve_urls(packet: dict[str, Any]) -> set[str]:
    urls: set[str] = set()
    profile = packet["divedeep"]["profile"]
    for policy in profile.get("policies", []):
        if policy.get("scopeType") == "profile_url" and policy.get("action") == "preserve":
            urls.add(str(policy.get("scopeValue") or "").strip().lower().rstrip("/"))
    for connection in packet.get("connections", []):
        if connection.get("protectedFromRemoval") and connection.get("profileUrl"):
            urls.add(str(connection["profileUrl"]).strip().lower().rstrip("/"))
    return {value for value in urls if value}


def _write_target_files(workspace: Path, packet: dict[str, Any]) -> None:
    targets = ensure_private_directory(workspace / "targets")
    groups = _identifier_groups(packet)
    file_map = {
        "name": "names.txt",
        "alias": "aliases.txt",
        "email": "emails.txt",
        "phone": "phones.txt",
        "address": "addresses.txt",
        "username": "usernames.txt",
        "domain": "domains.txt",
    }
    for kind, filename in file_map.items():
        _write_text(targets / filename, "\n".join(groups.get(kind, [])) + ("\n" if groups.get(kind) else ""))

    profile_urls = []
    for connection in packet.get("connections", []):
        url = str(connection.get("profileUrl") or "").strip()
        if url and url not in profile_urls:
            profile_urls.append(url)
    _write_text(targets / "declared-profile-urls.txt", "\n".join(profile_urls) + ("\n" if profile_urls else ""))
    _write_text(targets / "preserve-urls.txt", "\n".join(sorted(_preserve_urls(packet))) + ("\n" if _preserve_urls(packet) else ""))
    _write_json(targets / "photos-manifest.json", {
        "photos": packet.get("photos", []),
        "downloadInstruction": "Download authorized originals from DiveDeep Admin into evidence/reference-photos before image-match review.",
    })

    source_sets = packet.get("manualProcessing", {}).get("sourceSets", [])
    _write_text(targets / "source-sets.txt", "\n".join(str(item) for item in source_sets) + ("\n" if source_sets else ""))

    with (targets / "targets.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["record_type", "category", "label", "value", "action", "source_id"])
        for item in packet["divedeep"]["profile"].get("identifiers", []):
            writer.writerow(["identifier", item.get("type", ""), item.get("label", ""), item.get("value", ""), "authorized", item.get("id", "")])
        for item in packet.get("connections", []):
            writer.writerow(["social_connection", item.get("provider", ""), item.get("displayName", ""), item.get("profileUrl") or item.get("username", ""), "preserve" if item.get("protectedFromRemoval") else "review", item.get("id", "")])
        for item in packet["divedeep"]["profile"].get("policies", []):
            writer.writerow(["visibility_policy", item.get("scopeType", ""), "", item.get("scopeValue", ""), item.get("action", ""), item.get("id", "")])
    if os.name == "posix":
        (targets / "targets.csv").chmod(0o600)


def _write_tool_plan(workspace: Path, packet: dict[str, Any]) -> None:
    groups = _identifier_groups(packet)
    usernames = groups.get("username", [])
    jobs: list[dict[str, Any]] = []
    source_sets = set(str(item) for item in packet.get("manualProcessing", {}).get("sourceSets", []))
    for username in usernames:
        if "sherlock-supported" in source_sets:
            jobs.append({"tool": "sherlock", "targetType": "username", "target": username, "trafficClass": "passive", "values": {"username": username, "sites": []}})
        if "maigret-supported" in source_sets:
            jobs.append({"tool": "maigret", "targetType": "username", "target": username, "trafficClass": "passive", "values": {"username": username, "sites": []}})
    if "authorized-image-match-review" in source_sets:
        for photo in packet.get("photos", []):
            extension = ".jpg" if photo.get("mimeType") == "image/jpeg" else ".png" if photo.get("mimeType") == "image/png" else ".webp"
            jobs.append({
                "tool": "authorized-image-match-review",
                "targetType": "reference-photo",
                "target": f"evidence/reference-photos/{photo.get('id')}{extension}",
                "trafficClass": "manual-provider",
                "values": {"photoId": photo.get("id"), "sha256": photo.get("sha256", ""), "purpose": photo.get("purpose", "identity_search")},
            })
    plan = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "customerId": packet["customer"]["id"],
        "profileId": packet["divedeep"]["profile"]["id"],
        "authorizedSourceSets": sorted(source_sets),
        "jobs": jobs,
        "notes": [
            "Run only against the authorized identifiers in this workspace.",
            "Review tool output before publishing any finding.",
            "Preserved profile URLs must not become removal cases.",
        ],
    }
    _write_json(workspace / "tool-plan.json", plan)

    lines = ["# Generated convenience commands. Review before running.", "set -eu", "mkdir -p raw/sherlock raw/maigret", ""]
    for username in usernames:
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", username)[:120]
        if "sherlock-supported" in source_sets:
            lines.append(f"sherlock {json.dumps(username)} --print-found > {json.dumps('raw/sherlock/' + safe + '.txt')} 2>&1 || true")
        if "maigret-supported" in source_sets:
            lines.append(f"maigret {json.dumps(username)} --no-color --no-progressbar > {json.dumps('raw/maigret/' + safe + '.txt')} 2>&1 || true")
    _write_text(workspace / "run-username-tools.sh", "\n".join(lines) + "\n", 0o700)


def _write_workspace_readme(workspace: Path, packet: dict[str, Any]) -> None:
    customer = packet["customer"]
    profile = packet["divedeep"]["profile"]
    instructions = "\n".join(f"- {line}" for line in packet.get("manualProcessing", {}).get("instructions", []))
    text = f"""# DiveDeep manual DiveDeep workspace

Customer ID: `{customer['id']}`  
Protected profile ID: `{profile['id']}`  
Plan: `{customer.get('planTier', '')}`  
Authorization status: `{profile.get('authorization', {}).get('status', '')}`

## Minimal workflow

1. Review `targets/targets.csv`, `targets/preserve-urls.txt`, and `tool-plan.json`.
2. Download any authorized reference photos from DiveDeep Admin into `evidence/reference-photos/` when the plan includes image review.
3. Run approved DiveDeep/Kali tools locally. `run-username-tools.sh` is an optional convenience wrapper for Sherlock and Maigret.
4. Review every candidate. Do not publish uncertain or preserved profiles as removal cases.
5. Create a finding JSON using `finding-example.json` and record it:

   `python divedeep_cli.py record {workspace} finding.json`

6. Export the result packet:

   `python divedeep_cli.py export {workspace}`

7. In DiveDeep Admin, select the same customer and import the generated `out/divedeep-results.json`.

## Customer instructions

{instructions}

## Important

- This workspace is local and private. Do not serve it over HTTP.
- Evidence files remain local. The result packet carries hashes and references, not image or page contents.
- The server import is idempotent by listing URL and local finding key.
"""
    _write_text(workspace / "README.md", text)


def _empty_results(manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "packetType": RESULT_PACKET_TYPE,
        "product": "DiveDeep",
        "generatedAt": utc_now(),
        "source": {
            "customerId": manifest["customerId"],
            "profileId": manifest["profileId"],
            "diveDeepExportedAt": manifest["diveDeepExportedAt"],
            "diveDeepPacketSha256": manifest["diveDeepPacketSha256"],
            "divedeepCaseId": manifest["divedeepCaseId"],
            "privacyCaseId": manifest["privacyCaseId"],
        },
        "summary": {"sourcesReviewed": 0, "candidatesReviewed": 0, "confirmedFindings": 0, "requestsSent": 0, "removed": 0, "stillPresent": 0},
        "findings": [],
    }


def import_packet(source: str | Path, *, workspace_root: str | Path | None = None) -> dict[str, Any]:
    packet = _read_json(source)
    validate_intake_packet(packet)
    customer = packet["customer"]
    profile = packet["divedeep"]["profile"]
    root = ensure_private_directory(Path(workspace_root).expanduser() if workspace_root else DIVEDEEP_WORKSPACE_ROOT)
    workspace = ensure_private_directory(root / str(customer["id"]))
    ensure_private_directory(workspace / "intake")
    ensure_private_directory(workspace / "raw")
    ensure_private_directory(workspace / "evidence")
    ensure_private_directory(workspace / "evidence" / "reference-photos")
    ensure_private_directory(workspace / "out")

    core_store = CaseStore()
    privacy_store = PrivacyStore()
    previous_manifest = _read_json(workspace / "manifest.json") if (workspace / "manifest.json").is_file() else {}
    core_case_id = str(previous_manifest.get("divedeepCaseId") or "")
    privacy_case_id = str(previous_manifest.get("privacyCaseId") or "")
    if not core_case_id or not core_store.get_case(core_case_id):
        core_case_id = core_store.create_case(
            f"DiveDeep - {customer.get('displayName') or customer['id']}",
            mode="privacy-removal",
            objective="Authorized identity discovery, evidence collection, removal request preparation, and verification.",
            metadata={"divedeep_customer_id": customer["id"], "divedeep_profile_id": profile["id"], "source": "divedeep-export-v2"},
        )
        primary_name = next((str(item.get("value") or "") for item in profile.get("identifiers", []) if item.get("type") == "name" and item.get("isPrimary")), str(customer.get("displayName") or ""))
        subject_id = core_store.add_subject(core_case_id, "person", str(customer.get("displayName") or primary_name or customer["id"]), primary_value=primary_name, metadata={"divedeep_customer_id": customer["id"]})
        for identifier in profile.get("identifiers", []):
            value = str(identifier.get("value") or "").strip()
            if value and identifier.get("status") == "active":
                core_store.add_identifier(core_case_id, str(identifier.get("type") or "other"), value, subject_id=subject_id, confidence=1.0, metadata={"divedeep_identifier_id": identifier.get("id"), "label": identifier.get("label", "")})
        for policy in profile.get("policies", []):
            value = f"{policy.get('scopeType', 'default')}:{policy.get('scopeValue', '')}"
            core_store.add_scope(core_case_id, str(policy.get("scopeType") or "default"), str(policy.get("scopeValue") or "*"), allowed=policy.get("action") not in {"preserve", "ignore"}, notes=f"DiveDeep action={policy.get('action')}; policy={value}")

    if not privacy_case_id or not privacy_store.get_case(privacy_case_id):
        authorization = profile["authorization"]
        identifiers = _identifier_groups(packet)
        subject_name = (identifiers.get("name") or [customer.get("displayName") or customer["id"]])[0]
        subject_email = (identifiers.get("email") or [customer.get("email") or ""])[0]
        privacy_case_id = privacy_store.create_case({
            "case_name": f"DiveDeep - {customer.get('displayName') or customer['id']}",
            "subject_name": subject_name,
            "subject_email": subject_email,
            "aliases": identifiers.get("alias", []),
            "jurisdiction_country": profile.get("jurisdictionCountry", ""),
            "jurisdiction_region": profile.get("jurisdictionRegion", ""),
            "requester_role": authorization.get("requesterRole") or authorization.get("type") or "self",
            "requester_name": authorization.get("requesterName") or subject_name,
            "requester_email": authorization.get("requesterEmail") or subject_email,
            "authorization_affirmed": True,
            "authorization_date": authorization.get("signedAt") or customer.get("authorizationAffirmedAt") or utc_now(),
            "verification_channel": authorization.get("verificationChannel", ""),
            "studio_case_id": core_case_id,
        })

    manifest = {
        "workspaceType": "divedeep.manual-recon",
        "workspaceSchemaVersion": 1,
        "customerId": customer["id"],
        "profileId": profile["id"],
        "displayName": customer.get("displayName", ""),
        "planTier": customer.get("planTier", ""),
        "diveDeepExportedAt": packet.get("exportedAt", ""),
        "diveDeepPacketSha256": _packet_digest(packet),
        "divedeepCaseId": core_case_id,
        "privacyCaseId": privacy_case_id,
        "importedAt": utc_now(),
        "workspace": str(workspace),
    }
    _write_json(workspace / "manifest.json", manifest)
    shutil.copy2(Path(source).expanduser(), workspace / "intake" / "divedeep-export.json")
    if os.name == "posix":
        (workspace / "intake" / "divedeep-export.json").chmod(0o600)
    _write_target_files(workspace, packet)
    _write_tool_plan(workspace, packet)
    _write_workspace_readme(workspace, packet)
    if not (workspace / "results.json").is_file():
        _write_json(workspace / "results.json", _empty_results(manifest))
    _write_json(workspace / "finding-example.json", {
        "sourceName": "Example Directory",
        "listingUrl": "https://example.com/public-profile/123",
        "listingIdentifier": "123",
        "subjectIdentifier": "matched authorized email or username",
        "matchConfidence": 0.95,
        "contentCategory": "people-search",
        "status": "confirmed",
        "discoveredAt": utc_now(),
        "notes": "Explain why the record belongs to the customer.",
        "evidence": [{"type": "screenshot", "path": "evidence/example.png", "notes": "Public listing capture"}],
        "removal": {"createCase": True, "recipientEmail": "privacy@example.com", "deliveryMethod": "email", "templateKey": "people-search-removal", "requestActions": "Remove or suppress this public listing.", "status": "draft"},
    })
    return {"workspace": str(workspace), "manifest": manifest, "toolJobs": len(_read_json(workspace / "tool-plan.json").get("jobs", []))}


def _preserved(packet: dict[str, Any], listing_url: str) -> bool:
    candidate = listing_url.lower().rstrip("/")
    for value in _preserve_urls(packet):
        if candidate == value or candidate.endswith(value) or value.endswith(candidate):
            return True
    return False


def _normalize_evidence(workspace: Path, core_store: CaseStore, case_id: str, evidence: list[Any], listing_url: str) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for item in evidence[:50]:
        if not isinstance(item, dict):
            continue
        record: dict[str, Any] = {
            "type": str(item.get("type") or "reference")[:64],
            "ref": str(item.get("ref") or "")[:1024],
            "sha256": str(item.get("sha256") or "")[:64],
            "capturedAt": str(item.get("capturedAt") or utc_now()),
            "notes": str(item.get("notes") or "")[:2000],
        }
        path_value = str(item.get("path") or "").strip()
        if path_value:
            path = Path(path_value).expanduser()
            if not path.is_absolute():
                path = (workspace / path).resolve()
            if path.is_file():
                media_type = str(item.get("mediaType") or "application/octet-stream")
                artifact_id = core_store.record_artifact_path(case_id, path, record["type"], media_type=media_type, source_uri=listing_url, metadata={"notes": record["notes"], "divedeep_bridge": True})
                artifact = core_store.get_artifact(artifact_id) or {}
                record["ref"] = f"divedeep://artifact/{artifact_id}"
                record["sha256"] = str(artifact.get("sha256") or "")
                core_store.add_evidence(case_id, record["type"], record["notes"] or path.name, artifact_id=artifact_id, source_uri=listing_url, metadata={"captured_at": record["capturedAt"]})
        if record["ref"] or record["sha256"] or record["notes"]:
            normalized.append(record)
    return normalized


def _request_values(packet: dict[str, Any], finding: dict[str, Any], local_finding_id: str, privacy_case_id: str) -> tuple[dict[str, Any] | None, str]:
    removal = finding.get("removal") if isinstance(finding.get("removal"), dict) else {}
    if not removal or not removal.get("createCase"):
        return None, ""
    template_key = str(removal.get("templateKey") or "data-broker-deletion")
    if template_key not in TEMPLATE_BY_KEY:
        raise ValueError(f"Unknown privacy template: {template_key}")
    authorization = packet["divedeep"]["profile"]["authorization"]
    groups = _identifier_groups(packet)
    subject_name = (groups.get("name") or [packet["customer"].get("displayName") or "Customer"])[0]
    subject_identifier = str(finding.get("subjectIdentifier") or (groups.get("email") or groups.get("username") or [""])[0])
    case_reference = f"{privacy_case_id}:{local_finding_id}"
    values = {
        "company_name": str(finding.get("sourceName") or "Privacy Team"),
        "requester_statement": "the person identified in this request" if authorization.get("requesterRole") == "self" else "an authorized representative of the person identified in this request",
        "subject_name": subject_name,
        "subject_email_or_identifier": subject_identifier,
        "profile_url": str(finding.get("listingUrl") or ""),
        "listing_identifier": str(finding.get("listingIdentifier") or ""),
        "request_actions": str(removal.get("requestActions") or "Delete or suppress the identified personal information and prevent republication under the same identity, subject to lawful exceptions."),
        "legal_basis": str(removal.get("legalBasis") or LEGAL_BASIS_PRESETS["Plain-language request"]),
        "case_reference": case_reference,
        "requester_name": str(authorization.get("requesterName") or subject_name),
        "requester_email": str(authorization.get("requesterEmail") or packet["customer"].get("email") or ""),
    }
    subject, body = render_template(template_key, values)
    return {
        "template_key": template_key,
        "request_types": removal.get("requestTypes") or ["deletion"],
        "jurisdiction_basis": values["legal_basis"],
        "recipient_email": str(removal.get("recipientEmail") or ""),
        "delivery_method": str(removal.get("deliveryMethod") or "email"),
        "email_subject": str(removal.get("emailSubject") or subject),
        "email_body": str(removal.get("emailBody") or body),
        "response_due_date": removal.get("responseDueAt"),
        "notes": str(removal.get("notes") or ""),
    }, str(removal.get("status") or "draft")


def record_findings(workspace_value: str | Path, source: str | Path) -> dict[str, Any]:
    workspace = _workspace_from_input(workspace_value)
    manifest = _manifest(workspace)
    intake = _read_json(workspace / "intake" / "divedeep-export.json")
    payload = _read_json(source)
    incoming = payload.get("findings") if isinstance(payload.get("findings"), list) else [payload]
    if len(incoming) > 500:
        raise ValueError("A batch cannot contain more than 500 findings.")
    results = _read_json(workspace / "results.json")
    current = {str(item.get("findingKey")): item for item in results.get("findings", []) if item.get("findingKey")}
    core_store = CaseStore()
    privacy_store = PrivacyStore()
    recorded = 0
    updated = 0

    for raw in incoming:
        if not isinstance(raw, dict):
            continue
        listing_url = _safe_url(raw.get("listingUrl"))
        source_name = str(raw.get("sourceName") or urlparse(listing_url).hostname or "Unknown source").strip()[:255]
        finding_key = str(raw.get("findingKey") or hashlib.sha256(f"{source_name.lower()}|{listing_url.lower()}".encode()).hexdigest()[:32])
        status = str(raw.get("status") or "review").strip().lower()
        if _preserved(intake, listing_url):
            status = "preserved"
        if status not in {"review", "confirmed", "preserved", "ignored", "false_positive", "removed", "reappeared", "still_present"}:
            raise ValueError(f"Unsupported finding status: {status}")
        evidence = _normalize_evidence(workspace, core_store, manifest["divedeepCaseId"], list(raw.get("evidence") or []), listing_url)
        normalized = {
            "findingKey": finding_key,
            "sourceName": source_name,
            "domain": str(raw.get("domain") or urlparse(listing_url).hostname or "").lower()[:255],
            "listingUrl": listing_url,
            "listingIdentifier": str(raw.get("listingIdentifier") or "")[:1024],
            "subjectIdentifier": str(raw.get("subjectIdentifier") or "")[:2048],
            "matchConfidence": _confidence(raw.get("matchConfidence")),
            "contentCategory": str(raw.get("contentCategory") or "standard")[:64].lower(),
            "discoveredAt": str(raw.get("discoveredAt") or utc_now()),
            "status": status,
            "notes": str(raw.get("notes") or "")[:5000],
            "evidence": evidence,
            "removal": raw.get("removal") if isinstance(raw.get("removal"), dict) else {},
            "verification": raw.get("verification") if isinstance(raw.get("verification"), dict) else {},
        }
        privacy_finding_id = str(current.get(finding_key, {}).get("local", {}).get("privacyFindingId") or "")
        if not privacy_finding_id:
            privacy_finding_id = privacy_store.create_finding(manifest["privacyCaseId"], {
                "company_name": source_name,
                "domain": normalized["domain"],
                "industry_category": normalized["contentCategory"],
                "listing_url": listing_url,
                "listing_identifier": normalized["listingIdentifier"],
                "subject_identifier": normalized["subjectIdentifier"],
                "recipient_email": str(normalized["removal"].get("recipientEmail") or ""),
                "privacy_form_url": str(normalized["removal"].get("privacyFormUrl") or ""),
                "contact_status": "verified" if normalized["removal"].get("recipientEmail") or normalized["removal"].get("privacyFormUrl") else "unverified",
                "content_category": normalized["contentCategory"],
                "discovered_at": normalized["discoveredAt"],
                "notes": normalized["notes"],
            })
        core_finding_id = core_store.add_finding(
            manifest["divedeepCaseId"],
            "privacy-exposure",
            f"{source_name}: {normalized['contentCategory']}",
            severity="high" if normalized["contentCategory"] in {"adult", "sensitive", "ncii"} else "informational",
            summary=normalized["notes"] or f"Authorized identity exposure at {listing_url}",
            recommendation="Review and prepare a removal request if the match is confirmed and not preserved.",
            metadata={"divedeep_finding_key": finding_key, "listing_url": listing_url, "match_confidence": normalized["matchConfidence"], "status": status, "evidence": evidence},
        )
        request_values, request_status = _request_values(intake, normalized, privacy_finding_id, manifest["privacyCaseId"])
        privacy_request_id = str(current.get(finding_key, {}).get("local", {}).get("privacyRequestId") or "")
        if request_values and not privacy_request_id:
            privacy_request_id = privacy_store.create_request(manifest["privacyCaseId"], privacy_finding_id, request_values)
            if request_status != "draft":
                privacy_store.update_request_status(
                    privacy_request_id,
                    request_status,
                    confirmation_reference=str(normalized["removal"].get("confirmationReference") or ""),
                    notes=str(normalized["removal"].get("notes") or ""),
                    response_due_date=normalized["removal"].get("responseDueAt"),
                    mark_sent=request_status in {"sent", "acknowledged", "completed", "needs_action"},
                )
        verification = normalized["verification"]
        local_verification_id = ""
        if verification.get("result"):
            allowed_results = {"removed", "still_present", "changed", "unreachable", "needs_review"}
            if verification["result"] not in allowed_results:
                raise ValueError(f"Unsupported verification result: {verification['result']}")
            local_verification_id = privacy_store.add_verification(manifest["privacyCaseId"], privacy_finding_id, {
                "request_id": privacy_request_id or None,
                "result": verification["result"],
                "source_url": verification.get("sourceUrl") or listing_url,
                "notes": verification.get("notes", ""),
                "checked_at": verification.get("checkedAt") or utc_now(),
            })
        normalized["local"] = {"privacyFindingId": privacy_finding_id, "privacyRequestId": privacy_request_id, "privacyVerificationId": local_verification_id, "coreFindingId": core_finding_id}
        if finding_key in current:
            updated += 1
        else:
            recorded += 1
        current[finding_key] = normalized

    findings = list(current.values())
    results["findings"] = findings
    results["generatedAt"] = utc_now()
    results["summary"] = {
        "sourcesReviewed": len({item.get("domain") for item in findings if item.get("domain")}),
        "candidatesReviewed": len(findings),
        "confirmedFindings": sum(item.get("status") in {"confirmed", "removed", "reappeared", "still_present"} for item in findings),
        "requestsSent": sum(str(item.get("removal", {}).get("status") or "") in {"sent", "acknowledged", "completed", "needs_action"} for item in findings),
        "removed": sum(item.get("status") == "removed" or item.get("verification", {}).get("result") == "removed" for item in findings),
        "stillPresent": sum(item.get("status") == "still_present" or item.get("verification", {}).get("result") == "still_present" for item in findings),
    }
    _write_json(workspace / "results.json", results)
    return {"workspace": str(workspace), "recorded": recorded, "updated": updated, "total": len(findings)}


def validate_result_packet(packet: dict[str, Any]) -> None:
    if int(packet.get("schemaVersion") or 0) != RESULT_SCHEMA_VERSION or packet.get("packetType") != RESULT_PACKET_TYPE:
        raise ValueError("Unsupported DiveDeep result packet.")
    source = packet.get("source")
    if not isinstance(source, dict) or not source.get("customerId") or not source.get("profileId"):
        raise ValueError("Result packet source identity is missing.")
    findings = packet.get("findings")
    if not isinstance(findings, list) or len(findings) > 500:
        raise ValueError("findings must be an array containing at most 500 records.")
    for index, item in enumerate(findings):
        if not isinstance(item, dict):
            raise ValueError(f"findings[{index}] must be an object.")
        _safe_url(item.get("listingUrl"), f"findings[{index}].listingUrl")
        if not str(item.get("sourceName") or "").strip():
            raise ValueError(f"findings[{index}].sourceName is required.")


def export_results(workspace_value: str | Path, output: str | Path | None = None) -> dict[str, Any]:
    workspace = _workspace_from_input(workspace_value)
    packet = _read_json(workspace / "results.json")
    packet["generatedAt"] = utc_now()
    validate_result_packet(packet)
    output_path = Path(output).expanduser() if output else workspace / "out" / "divedeep-results.json"
    _write_json(output_path, packet)
    return {"output": str(output_path), "findings": len(packet["findings"]), "summary": packet.get("summary", {})}
