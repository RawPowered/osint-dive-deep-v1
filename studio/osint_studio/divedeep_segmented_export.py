from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .case_store import CaseStore
from .divedeep_bridge import RESULT_PACKET_TYPE, RESULT_SCHEMA_VERSION
from .divedeep_ops import resolve_workspace
from .paths import ensure_private_directory

BUNDLE_PACKET_TYPE = "divedeep.recon-result-bundle"
BUNDLE_SCHEMA_VERSION = 1
MANIFEST_PACKET_TYPE = "divedeep.recon-result-manifest"
TARGET_PART_BYTES = 512 * 1024
HARD_PART_BYTES = 1024 * 1024
MAX_FINDINGS_PER_PART = 100
MAX_EVIDENCE_FILES = 1000
MAX_EVIDENCE_FILE_BYTES = 25 * 1024 * 1024
MAX_EVIDENCE_TOTAL_BYTES = 500 * 1024 * 1024


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
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    if os.name == "posix":
        path.chmod(0o600)


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_token(value: str, fallback: str = "item") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", str(value or "")).strip("-")
    return cleaned[:120] or fallback


def _artifact_id(ref: str) -> str:
    prefix = "divedeep://artifact/"
    return ref[len(prefix) :] if str(ref or "").startswith(prefix) else ""


def _content_sensitivity(finding: dict[str, Any]) -> str:
    category = str(finding.get("contentCategory") or "").strip().lower()
    return "sensitive" if category in {"adult", "sensitive", "ncii", "explicit", "intimate"} else "standard"


def _normalize_media_type(value: Any, path: Path) -> str:
    media_type = str(value or "application/octet-stream").split(";", 1)[0].strip().lower()
    aliases = {"image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png"}
    media_type = aliases.get(media_type, media_type)
    try:
        with path.open("rb") as handle:
            header = handle.read(12)
    except OSError:
        header = b""
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    if media_type == "application/octet-stream":
        suffix = path.suffix.lower()
        if suffix in {".jpg", ".jpeg"}:
            return "image/jpeg"
        if suffix == ".png":
            return "image/png"
        if suffix == ".webp":
            return "image/webp"
    return media_type or "application/octet-stream"


def _ensure_finding_keys(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    used: set[str] = set()
    for index, source in enumerate(findings, start=1):
        finding = dict(source)
        requested = str(finding.get("findingKey") or "").strip()[:128]
        basis = "|".join(
            [
                requested,
                str(finding.get("listingUrl") or ""),
                str(finding.get("listingIdentifier") or ""),
                str(finding.get("sourceName") or ""),
                str(finding.get("discoveredAt") or ""),
                str(index),
            ]
        )
        candidate = requested or f"finding_{hashlib.sha256(basis.encode('utf-8')).hexdigest()[:24]}"
        if candidate in used:
            candidate = f"{candidate[:100]}_{hashlib.sha256(basis.encode('utf-8')).hexdigest()[:16]}"
        if candidate in used:
            raise ValueError("Unable to create unique finding keys for the export bundle.")
        finding["findingKey"] = candidate
        used.add(candidate)
        normalized.append(finding)
    return normalized


def _summary(findings: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "sourcesReviewed": len({str(item.get("domain") or "") for item in findings if item.get("domain")}),
        "candidatesReviewed": len(findings),
        "confirmedFindings": sum(str(item.get("status") or "") in {"confirmed", "removed", "reappeared", "still_present"} for item in findings),
        "requestsSent": sum(str((item.get("removal") or {}).get("status") or "") in {"sent", "acknowledged", "completed", "needs_action"} for item in findings),
        "removed": sum(str(item.get("status") or "") == "removed" or str((item.get("verification") or {}).get("result") or "") == "removed" for item in findings),
        "stillPresent": sum(str(item.get("status") or "") == "still_present" or str((item.get("verification") or {}).get("result") or "") == "still_present" for item in findings),
    }


def _copy_evidence(
    finding: dict[str, Any],
    evidence_directory: Path,
    evidence_index: dict[str, dict[str, Any]],
    case_store: CaseStore,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    finding_key = str(finding.get("findingKey") or "")
    sensitivity = _content_sensitivity(finding)
    for item in list(finding.get("evidence") or [])[:50]:
        if not isinstance(item, dict):
            continue
        record = {
            "type": str(item.get("type") or "reference")[:64],
            "ref": str(item.get("ref") or "")[:1024],
            "sha256": str(item.get("sha256") or "")[:64].lower(),
            "capturedAt": str(item.get("capturedAt") or ""),
            "notes": str(item.get("notes") or "")[:2000],
        }
        artifact_id = _artifact_id(record["ref"])
        source_path: Path | None = None
        artifact: dict[str, Any] = {}
        if artifact_id:
            try:
                artifact = case_store.get_artifact(artifact_id) or {}
                source_path = case_store.artifact_path(artifact_id)
            except (KeyError, OSError, ValueError):
                source_path = None
        if source_path and source_path.is_file():
            size = int(source_path.stat().st_size)
            if size <= 0 or size > MAX_EVIDENCE_FILE_BYTES:
                raise ValueError(f"Evidence file {source_path.name} exceeds the 25 MB per-file export limit.")
            digest = _sha256_file(source_path)
            media_type = _normalize_media_type(artifact.get("media_type"), source_path)
            suffix = source_path.suffix.lower()
            preferred_suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(media_type)
            if preferred_suffix:
                suffix = preferred_suffix
            elif not re.fullmatch(r"\.[A-Za-z0-9]{1,10}", suffix):
                suffix = ""
            evidence_id = "ev_" + hashlib.sha256(f"{digest}|{record['type']}".encode("utf-8")).hexdigest()[:32]
            relative_name = f"evidence/{evidence_id}{suffix}"
            destination = evidence_directory / f"{evidence_id}{suffix}"
            if not destination.exists():
                shutil.copyfile(source_path, destination)
                if os.name == "posix":
                    destination.chmod(0o600)
            indexed = evidence_index.setdefault(
                evidence_id,
                {
                    "evidenceId": evidence_id,
                    "fileName": relative_name,
                    "sha256": digest,
                    "mimeType": media_type,
                    "uploadRequired": media_type in {"image/jpeg", "image/png", "image/webp"},
                    "byteSize": size,
                    "evidenceType": record["type"],
                    "sensitivity": sensitivity,
                    "capturedAt": record["capturedAt"],
                    "findingKeys": [],
                },
            )
            if finding_key and finding_key not in indexed["findingKeys"]:
                indexed["findingKeys"].append(finding_key)
            if sensitivity == "sensitive":
                indexed["sensitivity"] = "sensitive"
            record.update(
                {
                    "evidenceId": evidence_id,
                    "fileName": relative_name,
                    "sha256": digest,
                    "mediaType": indexed["mimeType"],
                    "byteSize": size,
                    "sensitivity": sensitivity,
                }
            )
        normalized.append(record)
    return normalized


def _clean_finding(
    finding: dict[str, Any],
    evidence_directory: Path,
    evidence_index: dict[str, dict[str, Any]],
    case_store: CaseStore,
) -> dict[str, Any]:
    cleaned = {key: value for key, value in finding.items() if key != "local"}
    cleaned["evidence"] = _copy_evidence(cleaned, evidence_directory, evidence_index, case_store)
    return cleaned


def _packet_template(results: dict[str, Any], batch_id: str, scope: str) -> dict[str, Any]:
    return {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "packetType": RESULT_PACKET_TYPE,
        "product": str(results.get("product") or "DiveDeep"),
        "generatedAt": utc_now(),
        "source": dict(results.get("source") or {}),
        "batch": {
            "batchId": batch_id,
            "scope": scope,
            "part": 0,
            "totalParts": 0,
        },
        "summary": {},
        "findings": [],
    }


def _packet_for_findings(template: dict[str, Any], findings: list[dict[str, Any]], part: int, total_parts: int) -> dict[str, Any]:
    packet = json.loads(json.dumps(template))
    packet["generatedAt"] = utc_now()
    packet["batch"]["part"] = part
    packet["batch"]["totalParts"] = total_parts
    packet["summary"] = _summary(findings)
    packet["findings"] = findings
    return packet


def _split_findings(
    template: dict[str, Any],
    findings: list[dict[str, Any]],
    *,
    target_part_bytes: int,
    hard_part_bytes: int,
    max_findings_per_part: int,
) -> list[list[dict[str, Any]]]:
    if target_part_bytes < 8 * 1024 or hard_part_bytes < target_part_bytes:
        raise ValueError("Invalid segmented-export size limits.")
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for finding in findings:
        single = _packet_for_findings(template, [finding], 1, 1)
        if len(_json_bytes(single)) > hard_part_bytes:
            raise ValueError(f"Finding {finding.get('findingKey') or '<unknown>'} cannot fit within the hard JSON part limit.")
        candidate = [*current, finding]
        packet = _packet_for_findings(template, candidate, 1, 1)
        exceeds_target = len(_json_bytes(packet)) > target_part_bytes
        exceeds_count = len(candidate) > max_findings_per_part
        if current and (exceeds_target or exceeds_count):
            groups.append(current)
            current = [finding]
        else:
            current = candidate
    if current or not groups:
        groups.append(current)
    return groups


def _selected_findings(session: Path, results: dict[str, Any], scope: str) -> list[dict[str, Any]]:
    findings = list(results.get("findings") or [])
    if scope == "workspace":
        return [item for item in findings if str(item.get("status") or "") not in {"false_positive", "ignored"}]
    candidates = _read_json(session / "candidates.json", {}) or {}
    promoted_keys = {
        str(item.get("findingKey") or "")
        for item in candidates.get("candidates", []) or []
        if item.get("promotedAt") and item.get("findingKey")
    }
    return [item for item in findings if str(item.get("findingKey") or "") in promoted_keys]


def create_segmented_result_bundle(
    session_value: str | Path,
    *,
    scope: str = "image_session",
    target_part_bytes: int = TARGET_PART_BYTES,
    hard_part_bytes: int = HARD_PART_BYTES,
    max_findings_per_part: int = MAX_FINDINGS_PER_PART,
) -> dict[str, Any]:
    session = Path(session_value).expanduser().resolve()
    session_record = _read_json(session / "session.json", {}) or {}
    if not session.is_dir() or session_record.get("workspaceType") != "divedeep.image-recon":
        raise ValueError("The selected Image Recon session is invalid.")
    if scope not in {"image_session", "workspace"}:
        raise ValueError("Export scope must be image_session or workspace.")
    workspace = resolve_workspace(session.parent.parent)
    results = _read_json(workspace / "results.json", {}) or {}
    source = results.get("source") if isinstance(results.get("source"), dict) else {}
    if str(source.get("customerId") or "") != str(session_record.get("customerId") or ""):
        raise ValueError("Image session customer does not match the DiveDeep workspace result packet.")
    if str(source.get("profileId") or "") != str(session_record.get("profileId") or ""):
        raise ValueError("Image session profile does not match the DiveDeep workspace result packet.")

    selected = _ensure_finding_keys(_selected_findings(session, results, scope))
    if not selected:
        raise ValueError("No promoted reviewed findings are available for this export scope.")

    batch_id = str(uuid.uuid4())
    export_root = ensure_private_directory(session / "exports" / batch_id)
    findings_directory = ensure_private_directory(export_root / "findings")
    evidence_directory = ensure_private_directory(export_root / "evidence")
    case_store = CaseStore()
    evidence_index: dict[str, dict[str, Any]] = {}
    cleaned_findings = [_clean_finding(item, evidence_directory, evidence_index, case_store) for item in selected]
    evidence_records = sorted(evidence_index.values(), key=lambda item: item["evidenceId"])
    if len(evidence_records) > MAX_EVIDENCE_FILES:
        raise ValueError("The result bundle exceeds the 1,000 evidence-file safety limit.")
    evidence_total = sum(int(item.get("byteSize") or 0) for item in evidence_records)
    if evidence_total > MAX_EVIDENCE_TOTAL_BYTES:
        raise ValueError("The result bundle exceeds the 500 MB evidence safety limit.")

    template = _packet_template(results, batch_id, scope)
    groups = _split_findings(
        template,
        cleaned_findings,
        target_part_bytes=target_part_bytes,
        hard_part_bytes=hard_part_bytes,
        max_findings_per_part=max_findings_per_part,
    )
    total_parts = len(groups)
    part_records: list[dict[str, Any]] = []
    for index, group in enumerate(groups, start=1):
        packet = _packet_for_findings(template, group, index, total_parts)
        payload = _json_bytes(packet)
        if len(payload) > hard_part_bytes:
            raise ValueError(f"Generated part {index} exceeds the hard JSON part limit.")
        file_name = f"findings/findings-{index:04d}.json"
        path = export_root / file_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        if os.name == "posix":
            path.chmod(0o600)
        part_records.append(
            {
                "partNumber": index,
                "fileName": file_name,
                "sha256": _sha256_bytes(payload),
                "byteSize": len(payload),
                "findingCount": len(group),
                "findingKeys": [str(item.get("findingKey") or "") for item in group],
            }
        )

    manifest = {
        "packetType": MANIFEST_PACKET_TYPE,
        "schemaVersion": BUNDLE_SCHEMA_VERSION,
        "product": "DiveDeep",
        "generatedAt": utc_now(),
        "batchId": batch_id,
        "scope": scope,
        "customerId": str(source.get("customerId") or ""),
        "profileId": str(source.get("profileId") or ""),
        "sessionId": str(session_record.get("sessionId") or ""),
        "summary": _summary(cleaned_findings),
        "findingCount": len(cleaned_findings),
        "partCount": total_parts,
        "evidenceFileCount": len(evidence_records),
        "evidenceBytes": evidence_total,
        "limits": {
            "targetPartBytes": target_part_bytes,
            "hardPartBytes": hard_part_bytes,
            "maxFindingsPerPart": max_findings_per_part,
        },
        "parts": part_records,
        "evidence": evidence_records,
        "instructions": [
            "Import this ZIP directly in DiveDeep Admin, or select its extracted folder.",
            "DiveDeep validates and imports findings JSON parts in numeric order.",
            "Evidence images remain separate from JSON and are uploaded automatically.",
            "Every declared byte size and SHA-256 value is verified before review.",
        ],
    }
    manifest_path = export_root / "manifest.json"
    _write_json(manifest_path, manifest)

    zip_name = f"divedeep-result-bundle-{_safe_token(manifest['customerId'], 'customer')}-{batch_id[:8]}.zip"
    zip_path = session / "exports" / zip_name
    temporary_zip = zip_path.with_name(f".{zip_path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with zipfile.ZipFile(temporary_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path in sorted(export_root.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(export_root).as_posix())
        os.replace(temporary_zip, zip_path)
        if os.name == "posix":
            zip_path.chmod(0o600)
        inspect_segmented_result_bundle(zip_path)
    except Exception:
        temporary_zip.unlink(missing_ok=True)
        zip_path.unlink(missing_ok=True)
        raise
    bundle_sha256 = _sha256_file(zip_path)
    export_record = {
        "packetType": BUNDLE_PACKET_TYPE,
        "schemaVersion": BUNDLE_SCHEMA_VERSION,
        "batchId": batch_id,
        "scope": scope,
        "createdAt": utc_now(),
        "directory": str(export_root),
        "zipPath": str(zip_path),
        "zipFileName": zip_name,
        "zipSha256": bundle_sha256,
        "zipBytes": zip_path.stat().st_size,
        "findingCount": len(cleaned_findings),
        "partCount": total_parts,
        "evidenceFileCount": len(evidence_records),
        "evidenceBytes": evidence_total,
        "manifest": manifest,
    }
    _write_json(export_root / "export-record.json", export_record)
    return export_record


def list_segmented_result_exports(session_value: str | Path) -> list[dict[str, Any]]:
    session = Path(session_value).expanduser().resolve()
    rows: list[dict[str, Any]] = []
    export_dir = session / "exports"
    if not export_dir.is_dir():
        return rows
    for record_path in export_dir.glob("*/export-record.json"):
        record = _read_json(record_path, {}) or {}
        zip_path = Path(str(record.get("zipPath") or ""))
        if record.get("packetType") == BUNDLE_PACKET_TYPE and zip_path.is_file():
            rows.append(record)
    return sorted(rows, key=lambda item: str(item.get("createdAt") or ""), reverse=True)


def segmented_result_bundle_bytes(record: dict[str, Any]) -> bytes:
    path = Path(str(record.get("zipPath") or "")).expanduser().resolve()
    if not path.is_file():
        raise ValueError("The segmented result bundle is unavailable.")
    return path.read_bytes()


def inspect_segmented_result_bundle(path_or_bytes: str | Path | bytes) -> dict[str, Any]:
    if isinstance(path_or_bytes, bytes):
        import io

        source = io.BytesIO(path_or_bytes)
    else:
        source = Path(path_or_bytes).expanduser()
    with zipfile.ZipFile(source, "r") as archive:
        names = set(archive.namelist())
        if "manifest.json" not in names:
            raise ValueError("Segmented result bundle is missing manifest.json.")
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        if manifest.get("packetType") != MANIFEST_PACKET_TYPE or int(manifest.get("schemaVersion") or 0) != BUNDLE_SCHEMA_VERSION:
            raise ValueError("Unsupported segmented result manifest.")
        parts = list(manifest.get("parts", []) or [])
        if len(parts) != int(manifest.get("partCount") or 0):
            raise ValueError("Segmented result manifest part count is inconsistent.")
        expected_batch = str(manifest.get("batchId") or "")
        for expected_part, part in enumerate(parts, start=1):
            name = str(part.get("fileName") or "")
            part_number = int(part.get("partNumber") or 0)
            if part_number != expected_part or name != f"findings/findings-{expected_part:04d}.json":
                raise ValueError(f"Segmented result part ordering is invalid: {name}")
            if name not in names:
                raise ValueError(f"Segmented result part is missing: {name}")
            payload = archive.read(name)
            if len(payload) != int(part.get("byteSize") or 0):
                raise ValueError(f"Segmented result part byte size mismatch: {name}")
            if _sha256_bytes(payload) != str(part.get("sha256") or ""):
                raise ValueError(f"Segmented result part hash mismatch: {name}")
            packet = json.loads(payload.decode("utf-8"))
            if packet.get("packetType") != RESULT_PACKET_TYPE or int(packet.get("schemaVersion") or 0) != RESULT_SCHEMA_VERSION:
                raise ValueError(f"Invalid result packet: {name}")
            batch = packet.get("batch") if isinstance(packet.get("batch"), dict) else {}
            if str(batch.get("batchId") or "") != expected_batch or int(batch.get("part") or 0) != expected_part or int(batch.get("totalParts") or 0) != len(parts):
                raise ValueError(f"Segmented result part metadata mismatch: {name}")
            findings = list(packet.get("findings") or [])
            if len(findings) != int(part.get("findingCount") or 0):
                raise ValueError(f"Segmented result finding count mismatch: {name}")
            if [str(item.get("findingKey") or "") for item in findings] != list(part.get("findingKeys") or []):
                raise ValueError(f"Segmented result finding keys mismatch: {name}")
        evidence_rows = list(manifest.get("evidence", []) or [])
        if len(evidence_rows) != int(manifest.get("evidenceFileCount") or 0):
            raise ValueError("Segmented result manifest evidence count is inconsistent.")
        for evidence in evidence_rows:
            name = str(evidence.get("fileName") or "")
            if name not in names:
                raise ValueError(f"Evidence file is missing: {name}")
            payload = archive.read(name)
            if len(payload) != int(evidence.get("byteSize") or 0):
                raise ValueError(f"Evidence byte size mismatch: {name}")
            if _sha256_bytes(payload) != str(evidence.get("sha256") or ""):
                raise ValueError(f"Evidence hash mismatch: {name}")
        if sum(int(part.get("findingCount") or 0) for part in parts) != int(manifest.get("findingCount") or 0):
            raise ValueError("Segmented result manifest finding count is inconsistent.")
        return manifest
