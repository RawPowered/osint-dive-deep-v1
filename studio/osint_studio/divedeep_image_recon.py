from __future__ import annotations

import hashlib
import io
import json
import os
import re
import zipfile
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

from .divedeep_bridge import DIVEDEEP_WORKSPACE_ROOT
from .divedeep_ops import list_workspaces, record_payload, resolve_workspace
from .paths import ensure_private_directory

PACKET_TYPE = "divedeep.image-recon-intake"
SCHEMA_VERSION = 1
MAX_IMAGES = 20
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_EXPANDED_BYTES = 75 * 1024 * 1024
MAX_ARCHIVE_BYTES = 80 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
ALLOWED_MIME_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
SESSION_FILE = "session.json"
QUEUE_FILE = "search-queue.json"
CANDIDATES_FILE = "candidates.json"
MAX_CANDIDATE_IMAGE_BYTES = 10 * 1024 * 1024
MAX_CANDIDATES = 1000
PROVIDER_STATUSES = {"pending", "in_progress", "completed", "blocked", "skipped"}
CANDIDATE_DECISIONS = {"pending_review", "confirmed_match", "not_this_person", "inconclusive", "preserve", "duplicate"}
IMAGE_PROVIDERS = {
    "google_lens": {
        "label": "Google Lens",
        "url": "https://lens.google.com/",
        "instructions": "Upload the normalized search derivative and record each relevant public source page.",
    },
    "bing_visual_search": {
        "label": "Bing Visual Search",
        "url": "https://www.bing.com/visualsearch",
        "instructions": "Upload the normalized image, then capture candidate page URLs and downloaded matching images.",
    },
    "tineye": {
        "label": "TinEye",
        "url": "https://tineye.com/",
        "instructions": "Use for exact and transformed copies. Record the source page rather than only the image CDN URL.",
    },
    "yandex_images": {
        "label": "Yandex Images",
        "url": "https://yandex.com/images/",
        "instructions": "Use the image search control and review visually similar results manually.",
    },
    "saucenao": {
        "label": "SauceNAO",
        "url": "https://saucenao.com/",
        "instructions": "Use when illustrations, avatars, reposted media, or derivative image sources are relevant.",
    },
    "manual_source": {
        "label": "Manual source review",
        "url": "",
        "instructions": "Record an image discovered through another authorized search or public-source workflow.",
    },
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


def _safe_id(value: str, fallback: str = "item") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", str(value or "")).strip("-")
    return cleaned[:100] or fallback


def _safe_zip_name(value: str) -> str:
    raw = str(value or "").replace("\\", "/")
    path = PurePosixPath(raw)
    if not raw or raw.startswith("/") or ".." in path.parts or path.is_absolute():
        raise ValueError(f"Unsafe ZIP member path: {raw or '<empty>'}")
    return path.as_posix()


def _zip_is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0o170000
    return mode == 0o120000


def _detect_image(data: bytes) -> tuple[str, str] | None:
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg", "jpg"
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png", "png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    return None


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hash_bits(image: Image.Image, *, width: int, height: int, difference: bool = False) -> str:
    gray = image.convert("L").resize((width, height), Image.Resampling.LANCZOS)
    pixels = list(gray.get_flattened_data()) if hasattr(gray, "get_flattened_data") else list(gray.getdata())
    if difference:
        bits = []
        for row in range(height):
            start = row * width
            bits.extend(pixels[start + col] > pixels[start + col + 1] for col in range(width - 1))
    else:
        mean = sum(pixels) / max(len(pixels), 1)
        bits = [value >= mean for value in pixels]
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    length = (len(bits) + 3) // 4
    return f"{value:0{length}x}"


def _normalize_image(data: bytes, normalized_path: Path, thumbnail_path: Path) -> dict[str, Any]:
    try:
        with Image.open(io.BytesIO(data)) as opened:
            opened.load()
            image = ImageOps.exif_transpose(opened)
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("Image dimensions exceed the safe processing limit.")
            if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
                rgba = image.convert("RGBA")
                background = Image.new("RGB", rgba.size, "white")
                background.paste(rgba, mask=rgba.getchannel("A"))
                prepared = background
            else:
                prepared = image.convert("RGB")

            normalized_path.parent.mkdir(parents=True, exist_ok=True)
            prepared.save(normalized_path, format="JPEG", quality=92, optimize=True, progressive=True)
            thumbnail = prepared.copy()
            thumbnail.thumbnail((640, 640), Image.Resampling.LANCZOS)
            thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
            thumbnail.save(thumbnail_path, format="JPEG", quality=86, optimize=True)

            return {
                "width": width,
                "height": height,
                "averageHash": _hash_bits(prepared, width=8, height=8),
                "differenceHash": _hash_bits(prepared, width=9, height=8, difference=True),
            }
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("The image could not be decoded safely.") from exc


def _open_bundle(data: bytes) -> zipfile.ZipFile:
    if not data or len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("The image bundle exceeds the 80 MB archive limit.")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data), "r")
    except zipfile.BadZipFile as exc:
        raise ValueError("The uploaded file is not a valid ZIP archive.") from exc
    return archive


def inspect_image_bundle(data: bytes) -> dict[str, Any]:
    with _open_bundle(data) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_IMAGES + 8:
            raise ValueError("The image bundle contains too many entries.")
        expanded = 0
        members: dict[str, zipfile.ZipInfo] = {}
        for info in infos:
            name = _safe_zip_name(info.filename)
            if info.flag_bits & 0x1:
                raise ValueError("Encrypted ZIP entries are not supported.")
            if _zip_is_symlink(info):
                raise ValueError("Symbolic links are not allowed in image bundles.")
            if info.is_dir():
                continue
            expanded += int(info.file_size)
            if expanded > MAX_EXPANDED_BYTES:
                raise ValueError("The expanded image bundle exceeds 75 MB.")
            members[name] = info

        manifest_info = members.get("manifest.json")
        if not manifest_info:
            raise ValueError("The image bundle is missing manifest.json.")
        if manifest_info.file_size > 512 * 1024:
            raise ValueError("The image bundle manifest is unexpectedly large.")
        try:
            manifest = json.loads(archive.read(manifest_info).decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError("The image bundle manifest is invalid JSON.") from exc
        if manifest.get("packetType") != PACKET_TYPE or int(manifest.get("schemaVersion") or 0) != SCHEMA_VERSION:
            raise ValueError("Unsupported DiveDeep image bundle schema.")
        customer_id = str(manifest.get("customerId") or "").strip()
        profile_id = str(manifest.get("profileId") or "").strip()
        if not customer_id or not profile_id:
            raise ValueError("The image bundle does not identify a customer and protected profile.")
        authorization = manifest.get("authorization") or {}
        if authorization.get("status") != "active" or authorization.get("revokedAt"):
            raise ValueError("The image bundle does not contain active customer authorization.")
        images = manifest.get("images") or []
        if not isinstance(images, list) or not images or len(images) > MAX_IMAGES:
            raise ValueError(f"The image bundle must contain between 1 and {MAX_IMAGES} authorized images.")

        declared_names: set[str] = set()
        declared_bytes = 0
        preview_images: list[dict[str, Any]] = []
        for record in images:
            if not isinstance(record, dict):
                raise ValueError("The image manifest contains an invalid record.")
            photo_id = str(record.get("photoId") or "").strip()
            file_name = _safe_zip_name(record.get("fileName") or "")
            mime_type = str(record.get("mimeType") or "").lower()
            expected_hash = str(record.get("sha256") or "").lower()
            if not photo_id or mime_type not in ALLOWED_MIME_TYPES or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
                raise ValueError("Each image record requires a photo ID, supported MIME type, and full SHA-256.")
            info = members.get(file_name)
            if not info:
                raise ValueError(f"The bundle is missing declared image {file_name}.")
            if info.file_size <= 0 or info.file_size > MAX_IMAGE_BYTES:
                raise ValueError(f"Image {file_name} exceeds the 5 MB per-image limit.")
            if file_name in declared_names:
                raise ValueError(f"Image {file_name} is declared more than once.")
            declared_names.add(file_name)
            declared_bytes += int(info.file_size)
            preview_images.append({
                "photoId": photo_id,
                "fileName": file_name,
                "mimeType": mime_type,
                "byteSize": int(info.file_size),
                "sha256": expected_hash,
                "label": str(record.get("label") or "Reference photo"),
                "purpose": str(record.get("purpose") or "identity_search"),
            })
        extras = [name for name in members if name != "manifest.json" and name not in declared_names]
        if extras:
            raise ValueError(f"The image bundle contains undeclared files: {', '.join(extras[:3])}")
        return {
            "manifest": manifest,
            "images": preview_images,
            "imageCount": len(preview_images),
            "expandedBytes": declared_bytes,
            "archiveBytes": len(data),
        }


def _find_workspace(customer_id: str, profile_id: str, workspace_root: str | Path | None = None) -> Path:
    rows = list_workspaces(workspace_root)
    for row in rows:
        if str(row.get("customerId") or "") == customer_id and str(row.get("profileId") or "") == profile_id:
            return resolve_workspace(row["workspace"])
    raise ValueError("Import the customer's standard DiveDeep JSON packet before importing the image bundle.")


def import_image_bundle(filename: str, data: bytes, *, workspace_root: str | Path | None = None) -> dict[str, Any]:
    preview = inspect_image_bundle(data)
    manifest = preview["manifest"]
    customer_id = str(manifest["customerId"])
    profile_id = str(manifest["profileId"])
    workspace = _find_workspace(customer_id, profile_id, workspace_root)
    digest = _sha256(data)
    generated = str(manifest.get("generatedAt") or utc_now())
    date_part = re.sub(r"[^0-9]", "", generated)[:14] or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    session_id = f"{date_part}-{digest[:10]}"
    session = ensure_private_directory(workspace / "image-recon" / session_id)
    intake_dir = ensure_private_directory(session / "intake")
    original_dir = ensure_private_directory(session / "references" / "originals")
    normalized_dir = ensure_private_directory(session / "references" / "normalized")
    thumbnail_dir = ensure_private_directory(session / "references" / "thumbnails")
    ensure_private_directory(session / "candidates")
    ensure_private_directory(session / "evidence")
    ensure_private_directory(session / "raw")
    ensure_private_directory(session / "exports")

    (intake_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if os.name == "posix":
        (intake_dir / "manifest.json").chmod(0o600)

    processed: list[dict[str, Any]] = []
    queue: list[dict[str, Any]] = []
    with _open_bundle(data) as archive:
        records_by_name = {item["fileName"]: item for item in preview["images"]}
        for file_name, record in records_by_name.items():
            raw = archive.read(file_name)
            actual_hash = _sha256(raw)
            if actual_hash != record["sha256"]:
                raise ValueError(f"SHA-256 mismatch for {file_name}.")
            detected = _detect_image(raw)
            if not detected or detected[0] != record["mimeType"]:
                raise ValueError(f"File signature does not match the declared image type for {file_name}.")
            photo_id = _safe_id(record["photoId"], "photo")
            extension = detected[1]
            original_path = original_dir / f"{photo_id}.{extension}"
            normalized_path = normalized_dir / f"{photo_id}.jpg"
            thumbnail_path = thumbnail_dir / f"{photo_id}.jpg"
            original_path.write_bytes(raw)
            if os.name == "posix":
                original_path.chmod(0o600)
            image_meta = _normalize_image(raw, normalized_path, thumbnail_path)
            normalized_hash = _sha256(normalized_path.read_bytes())
            result = {
                **record,
                **image_meta,
                "originalPath": str(original_path.relative_to(session)),
                "normalizedPath": str(normalized_path.relative_to(session)),
                "thumbnailPath": str(thumbnail_path.relative_to(session)),
                "originalSha256": actual_hash,
                "normalizedSha256": normalized_hash,
                "status": "ready",
            }
            processed.append(result)
            queue.append({
                "jobId": f"image-{photo_id}",
                "photoId": record["photoId"],
                "label": record["label"],
                "normalizedPath": result["normalizedPath"],
                "status": "ready_for_search",
                "providers": [
                    {
                        "providerKey": key,
                        "label": provider["label"],
                        "status": "pending",
                        "startedAt": None,
                        "completedAt": None,
                        "notes": "",
                        "candidateCount": 0,
                    }
                    for key, provider in IMAGE_PROVIDERS.items()
                    if key != "manual_source"
                ],
                "candidateCount": 0,
                "updatedAt": utc_now(),
            })

    session_record = {
        "workspaceType": "divedeep.image-recon",
        "schemaVersion": 1,
        "sessionId": session_id,
        "customerId": customer_id,
        "profileId": profile_id,
        "displayName": (manifest.get("customer") or {}).get("displayName") or customer_id,
        "planTier": (manifest.get("customer") or {}).get("planTier") or "",
        "sourceFile": Path(filename).name,
        "sourceSha256": digest,
        "importedAt": utc_now(),
        "imageCount": len(processed),
        "expandedBytes": preview["expandedBytes"],
        "images": processed,
    }
    _write_json(session / SESSION_FILE, session_record)
    _write_json(session / QUEUE_FILE, {"schemaVersion": 2, "updatedAt": utc_now(), "jobs": queue})
    _write_json(session / CANDIDATES_FILE, {"schemaVersion": 1, "updatedAt": utc_now(), "candidates": []})
    return {"session": str(session), "workspace": str(workspace), **session_record}


def list_image_sessions(workspace_root: str | Path | None = None) -> list[dict[str, Any]]:
    root = Path(workspace_root).expanduser() if workspace_root else DIVEDEEP_WORKSPACE_ROOT
    rows: list[dict[str, Any]] = []
    if not root.exists():
        return rows
    for session_file in root.glob("*/image-recon/*/session.json"):
        record = _read_json(session_file, {}) or {}
        if record.get("workspaceType") != "divedeep.image-recon":
            continue
        rows.append({**record, "session": str(session_file.parent)})
    return sorted(rows, key=lambda item: str(item.get("importedAt") or ""), reverse=True)


def _session_path(value: str | Path) -> Path:
    session = Path(value).expanduser().resolve()
    record = _read_json(session / SESSION_FILE, {}) or {}
    if not session.is_dir() or record.get("workspaceType") != "divedeep.image-recon":
        raise ValueError("The selected DiveDeep Image Recon session is invalid.")
    return session


def _reference_by_id(record: dict[str, Any], photo_id: str) -> dict[str, Any]:
    for item in record.get("images", []) or []:
        if str(item.get("photoId") or "") == str(photo_id or ""):
            return item
    raise ValueError("The selected reference image is not part of this authorized session.")


def _provider_rows() -> list[dict[str, Any]]:
    return [
        {
            "providerKey": key,
            "label": provider["label"],
            "status": "pending",
            "startedAt": None,
            "completedAt": None,
            "notes": "",
            "candidateCount": 0,
        }
        for key, provider in IMAGE_PROVIDERS.items()
        if key != "manual_source"
    ]


def _ensure_phase2_files(session: Path, record: dict[str, Any], queue: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    changed = False
    queue.setdefault("jobs", [])
    for job in queue["jobs"]:
        existing = {str(item.get("providerKey") or ""): item for item in job.get("providers", []) or []}
        providers = []
        for default in _provider_rows():
            providers.append({**default, **existing.get(default["providerKey"], {})})
        if providers != (job.get("providers") or []):
            job["providers"] = providers
            changed = True
        if "candidateCount" not in job:
            job["candidateCount"] = 0
            changed = True
    if int(queue.get("schemaVersion") or 0) < 2:
        queue["schemaVersion"] = 2
        changed = True
    if changed:
        queue["updatedAt"] = utc_now()
        _write_json(session / QUEUE_FILE, queue)
    candidates = _read_json(session / CANDIDATES_FILE, None)
    if not isinstance(candidates, dict):
        candidates = {"schemaVersion": 1, "updatedAt": utc_now(), "candidates": []}
        _write_json(session / CANDIDATES_FILE, candidates)
    candidates.setdefault("candidates", [])
    return queue, candidates


def load_image_session(value: str | Path) -> dict[str, Any]:
    session = _session_path(value)
    record = _read_json(session / SESSION_FILE, {}) or {}
    queue = _read_json(session / QUEUE_FILE, {"schemaVersion": 2, "jobs": []}) or {"schemaVersion": 2, "jobs": []}
    queue, candidates = _ensure_phase2_files(session, record, queue)
    return {"session": session, "workspace": session.parent.parent, "record": record, "queue": queue, "candidates": candidates}


def _validate_public_url(value: str) -> str:
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("A public HTTP or HTTPS source URL is required.")
    if len(raw) > 2048:
        raise ValueError("The source URL is too long.")
    return raw


def _candidate_image_metadata(data: bytes) -> dict[str, Any]:
    if not data or len(data) > MAX_CANDIDATE_IMAGE_BYTES:
        raise ValueError("Candidate images must be between 1 byte and 10 MB.")
    detected = _detect_image(data)
    if not detected:
        raise ValueError("Candidate evidence must be JPEG, PNG, or WebP.")
    try:
        with Image.open(io.BytesIO(data)) as opened:
            opened.load()
            image = ImageOps.exif_transpose(opened).convert("RGB")
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("Candidate image dimensions exceed the safe processing limit.")
            return {
                "mimeType": detected[0],
                "extension": detected[1],
                "width": width,
                "height": height,
                "sha256": _sha256(data),
                "averageHash": _hash_bits(image, width=8, height=8),
                "differenceHash": _hash_bits(image, width=9, height=8, difference=True),
            }
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("The candidate image could not be decoded safely.") from exc


def _hash_distance(left: str, right: str) -> int | None:
    if not left or not right or len(left) != len(right):
        return None
    try:
        return (int(left, 16) ^ int(right, 16)).bit_count()
    except ValueError:
        return None


def update_provider_run(
    session_value: str | Path,
    photo_id: str,
    provider_key: str,
    status: str,
    notes: str = "",
) -> dict[str, Any]:
    session = _session_path(session_value)
    bundle = load_image_session(session)
    if provider_key not in IMAGE_PROVIDERS or provider_key == "manual_source":
        raise ValueError("Unsupported image-search provider.")
    if status not in PROVIDER_STATUSES:
        raise ValueError("Unsupported provider status.")
    target_job = None
    for job in bundle["queue"].get("jobs", []) or []:
        if str(job.get("photoId") or "") == str(photo_id or ""):
            target_job = job
            break
    if not target_job:
        raise ValueError("The selected image-search job is unavailable.")
    provider = next((item for item in target_job.get("providers", []) if item.get("providerKey") == provider_key), None)
    if not provider:
        raise ValueError("The selected provider is unavailable for this job.")
    now = utc_now()
    provider["status"] = status
    provider["notes"] = str(notes or "")[:2000]
    if status == "in_progress" and not provider.get("startedAt"):
        provider["startedAt"] = now
    if status in {"completed", "blocked", "skipped"}:
        provider["completedAt"] = now
    elif status == "pending":
        provider["startedAt"] = None
        provider["completedAt"] = None
    target_job["updatedAt"] = now
    target_job["status"] = "search_in_progress" if any(item.get("status") == "in_progress" for item in target_job.get("providers", [])) else target_job.get("status", "ready_for_search")
    if all(item.get("status") in {"completed", "blocked", "skipped"} for item in target_job.get("providers", [])):
        target_job["status"] = "provider_review_complete"
    bundle["queue"]["updatedAt"] = now
    _write_json(session / QUEUE_FILE, bundle["queue"] )
    return provider


def add_image_candidate(
    session_value: str | Path,
    *,
    photo_id: str,
    provider_key: str,
    source_url: str,
    candidate_filename: str,
    candidate_data: bytes,
    page_screenshot_filename: str = "",
    page_screenshot_data: bytes | None = None,
    source_name: str = "",
    content_category: str = "image-match",
    associated_name: str = "",
    associated_username: str = "",
    associated_location: str = "",
    notes: str = "",
) -> dict[str, Any]:
    session = _session_path(session_value)
    bundle = load_image_session(session)
    reference = _reference_by_id(bundle["record"], photo_id)
    if provider_key not in IMAGE_PROVIDERS:
        raise ValueError("Unsupported image-search provider.")
    source_url = _validate_public_url(source_url)
    if len(bundle["candidates"].get("candidates", [])) >= MAX_CANDIDATES:
        raise ValueError("This image session has reached the 1,000-candidate safety limit.")
    candidate_meta = _candidate_image_metadata(candidate_data)
    candidate_id = str(uuid.uuid4())
    files_dir = ensure_private_directory(session / "candidates" / "files")
    normalized_dir = ensure_private_directory(session / "candidates" / "normalized")
    thumbnails_dir = ensure_private_directory(session / "candidates" / "thumbnails")
    candidate_path = files_dir / f"{candidate_id}.{candidate_meta['extension']}"
    normalized_path = normalized_dir / f"{candidate_id}.jpg"
    thumbnail_path = thumbnails_dir / f"{candidate_id}.jpg"
    candidate_path.write_bytes(candidate_data)
    if os.name == "posix":
        candidate_path.chmod(0o600)
    normalized_meta = _normalize_image(candidate_data, normalized_path, thumbnail_path)
    screenshot_record: dict[str, Any] | None = None
    if page_screenshot_data:
        screenshot_meta = _candidate_image_metadata(page_screenshot_data)
        screenshot_dir = ensure_private_directory(session / "evidence" / "page-screenshots")
        screenshot_path = screenshot_dir / f"{candidate_id}.{screenshot_meta['extension']}"
        screenshot_path.write_bytes(page_screenshot_data)
        if os.name == "posix":
            screenshot_path.chmod(0o600)
        screenshot_record = {
            "path": str(screenshot_path.relative_to(session)),
            "originalName": Path(page_screenshot_filename or "page-screenshot").name,
            **screenshot_meta,
        }
    a_distance = _hash_distance(str(reference.get("averageHash") or ""), candidate_meta["averageHash"])
    d_distance = _hash_distance(str(reference.get("differenceHash") or ""), candidate_meta["differenceHash"])
    similarities = [1 - (distance / 64) for distance in (a_distance, d_distance) if distance is not None]
    local_similarity = round(sum(similarities) / len(similarities), 4) if similarities else 0.0
    duplicate_of = ""
    for existing in bundle["candidates"].get("candidates", []):
        if existing.get("candidateSha256") == candidate_meta["sha256"]:
            duplicate_of = str(existing.get("candidateId") or "")
            break
    now = utc_now()
    candidate = {
        "candidateId": candidate_id,
        "photoId": str(photo_id),
        "referenceLabel": reference.get("label") or "Reference photo",
        "providerKey": provider_key,
        "providerLabel": IMAGE_PROVIDERS[provider_key]["label"],
        "sourceUrl": source_url,
        "sourceName": str(source_name or urlparse(source_url).hostname or "Unknown source")[:255],
        "contentCategory": str(content_category or "image-match")[:64],
        "associatedName": str(associated_name or "")[:512],
        "associatedUsername": str(associated_username or "")[:512],
        "associatedLocation": str(associated_location or "")[:512],
        "notes": str(notes or "")[:5000],
        "candidateOriginalName": Path(candidate_filename or "candidate-image").name,
        "candidatePath": str(candidate_path.relative_to(session)),
        "candidateNormalizedPath": str(normalized_path.relative_to(session)),
        "candidateThumbnailPath": str(thumbnail_path.relative_to(session)),
        "candidateMimeType": candidate_meta["mimeType"],
        "candidateSha256": candidate_meta["sha256"],
        "candidateWidth": candidate_meta["width"],
        "candidateHeight": candidate_meta["height"],
        "candidateAverageHash": candidate_meta["averageHash"],
        "candidateDifferenceHash": candidate_meta["differenceHash"],
        "averageHashDistance": a_distance,
        "differenceHashDistance": d_distance,
        "localNearDuplicateSimilarity": local_similarity,
        "pageScreenshot": screenshot_record,
        "duplicateOf": duplicate_of,
        "decision": "duplicate" if duplicate_of else "pending_review",
        "operatorConfidence": 0.0,
        "visualSimilarity": 0.0,
        "signals": {"name": "none", "username": "none", "location": "none", "context": "none"},
        "reviewNotes": "",
        "createdAt": now,
        "updatedAt": now,
        "reviewedAt": None,
        "promotedAt": None,
        "findingKey": "",
    }
    bundle["candidates"]["candidates"].append(candidate)
    bundle["candidates"]["updatedAt"] = now
    _write_json(session / CANDIDATES_FILE, bundle["candidates"] )
    for job in bundle["queue"].get("jobs", []):
        if str(job.get("photoId") or "") != str(photo_id):
            continue
        job["candidateCount"] = int(job.get("candidateCount") or 0) + 1
        for provider in job.get("providers", []):
            if provider.get("providerKey") == provider_key:
                provider["candidateCount"] = int(provider.get("candidateCount") or 0) + 1
        job["updatedAt"] = now
    bundle["queue"]["updatedAt"] = now
    _write_json(session / QUEUE_FILE, bundle["queue"] )
    return candidate


def update_candidate_review(
    session_value: str | Path,
    candidate_id: str,
    *,
    decision: str,
    operator_confidence: float,
    visual_similarity: float,
    signals: dict[str, str] | None = None,
    associated_name: str = "",
    associated_username: str = "",
    associated_location: str = "",
    review_notes: str = "",
) -> dict[str, Any]:
    if decision not in CANDIDATE_DECISIONS:
        raise ValueError("Unsupported candidate decision.")
    session = _session_path(session_value)
    bundle = load_image_session(session)
    candidate = next((item for item in bundle["candidates"].get("candidates", []) if item.get("candidateId") == candidate_id), None)
    if not candidate:
        raise ValueError("The selected image candidate is unavailable.")
    if candidate.get("duplicateOf") and decision not in {"duplicate", "not_this_person"}:
        raise ValueError("Exact duplicate candidates must remain Duplicate or be rejected as Not This Person.")
    allowed_signal_values = {"none", "weak", "strong"}
    normalized_signals = {}
    for key in ("name", "username", "location", "context"):
        value = str((signals or {}).get(key) or "none")
        normalized_signals[key] = value if value in allowed_signal_values else "none"
    candidate.update({
        "decision": decision,
        "operatorConfidence": min(1.0, max(0.0, float(operator_confidence))),
        "visualSimilarity": min(1.0, max(0.0, float(visual_similarity))),
        "signals": normalized_signals,
        "associatedName": str(associated_name or candidate.get("associatedName") or "")[:512],
        "associatedUsername": str(associated_username or candidate.get("associatedUsername") or "")[:512],
        "associatedLocation": str(associated_location or candidate.get("associatedLocation") or "")[:512],
        "reviewNotes": str(review_notes or "")[:5000],
        "reviewedAt": utc_now(),
        "updatedAt": utc_now(),
    })
    bundle["candidates"]["updatedAt"] = utc_now()
    _write_json(session / CANDIDATES_FILE, bundle["candidates"] )
    return candidate


def _candidate_finding_key(candidate: dict[str, Any]) -> str:
    material = f"image|{candidate.get('photoId')}|{candidate.get('sourceUrl')}|{candidate.get('candidateSha256')}"
    return "image-" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:40]


def promote_candidate(
    session_value: str | Path,
    candidate_id: str,
    *,
    publish_inconclusive: bool = False,
) -> dict[str, Any]:
    session = _session_path(session_value)
    bundle = load_image_session(session)
    candidate = next((item for item in bundle["candidates"].get("candidates", []) if item.get("candidateId") == candidate_id), None)
    if not candidate:
        raise ValueError("The selected image candidate is unavailable.")
    decision = str(candidate.get("decision") or "pending_review")
    if decision not in {"confirmed_match", "preserve", "inconclusive"}:
        raise ValueError("Only confirmed, preserved, or intentionally published inconclusive candidates can advance.")
    if decision == "inconclusive" and not publish_inconclusive:
        raise ValueError("Confirm that this inconclusive candidate should be published for customer review.")
    status = {"confirmed_match": "confirmed", "preserve": "preserved", "inconclusive": "review"}[decision]
    workspace = session.parent.parent
    evidence: list[dict[str, Any]] = []
    candidate_file = session / str(candidate.get("candidatePath") or "")
    if candidate_file.is_file():
        evidence.append({
            "type": "candidate_image",
            "path": str(candidate_file.relative_to(workspace)),
            "mediaType": candidate.get("candidateMimeType") or "application/octet-stream",
            "sha256": candidate.get("candidateSha256") or "",
            "notes": "Candidate image retained from the reviewed public source.",
        })
    screenshot = candidate.get("pageScreenshot") if isinstance(candidate.get("pageScreenshot"), dict) else None
    if screenshot and screenshot.get("path"):
        screenshot_file = session / str(screenshot["path"] )
        if screenshot_file.is_file():
            evidence.append({
                "type": "page_screenshot",
                "path": str(screenshot_file.relative_to(workspace)),
                "mediaType": screenshot.get("mimeType") or "application/octet-stream",
                "sha256": screenshot.get("sha256") or "",
                "notes": "Screenshot of the public page associated with the image candidate.",
            })
    signals = candidate.get("signals") if isinstance(candidate.get("signals"), dict) else {}
    signal_text = ", ".join(f"{key}={value}" for key, value in signals.items() if value and value != "none") or "no corroborating identity signals recorded"
    notes = (
        f"Image Recon operator decision: {decision}. "
        f"Operator confidence {float(candidate.get('operatorConfidence') or 0):.0%}; "
        f"visual comparison {float(candidate.get('visualSimilarity') or 0):.0%}; "
        f"local near-duplicate signal {float(candidate.get('localNearDuplicateSimilarity') or 0):.0%}; "
        f"{signal_text}. {candidate.get('reviewNotes') or candidate.get('notes') or ''}"
    ).strip()
    finding_key = str(candidate.get("findingKey") or _candidate_finding_key(candidate))
    subject_identifier = str(candidate.get("associatedUsername") or candidate.get("associatedName") or f"photo:{candidate.get('photoId')}")
    payload = {
        "findingKey": finding_key,
        "sourceName": candidate.get("sourceName") or candidate.get("providerLabel") or "Image source",
        "listingUrl": candidate.get("sourceUrl"),
        "subjectIdentifier": subject_identifier,
        "matchConfidence": float(candidate.get("operatorConfidence") or 0),
        "contentCategory": candidate.get("contentCategory") or "image-match",
        "status": status,
        "notes": notes,
        "evidence": evidence,
    }
    result = record_payload(workspace, payload)
    candidate["findingKey"] = finding_key
    candidate["promotedAt"] = utc_now()
    candidate["updatedAt"] = utc_now()
    bundle["candidates"]["updatedAt"] = utc_now()
    _write_json(session / CANDIDATES_FILE, bundle["candidates"] )
    return {"candidate": candidate, "result": result, "findingKey": finding_key}


def session_file_bytes(session_value: str | Path, relative_path: str) -> bytes:
    session = Path(session_value).expanduser().resolve()
    candidate = (session / relative_path).resolve()
    if candidate != session and not candidate.is_relative_to(session):
        raise ValueError("Invalid Image Recon file path.")
    if not candidate.is_file():
        raise ValueError("Image Recon file is unavailable.")
    return candidate.read_bytes()
