from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import requests
from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError

from .divedeep_ops import (
    execute_job_direct,
    extract_candidate_records,
    import_uploaded_packet,
    job_install_status,
    load_workspace_bundle,
    read_job_output,
    store_reference_photo,
)
from .divedeep_worker import _validate_public_url

WORKER_VERSION = "5.29.0"
WORKER_PROTOCOL_VERSION = 1
DEFAULT_API_PATH = "/api/workers/v1"
DEFAULT_REQUEST_TIMEOUT = 45


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def clean(value: Any, maximum: int = 2048) -> str:
    return str(value or "").strip()[:maximum]


def env_required(name: str) -> str:
    value = clean(os.getenv(name), 8192)
    if not value:
        raise RuntimeError(f"Required environment variable is missing: {name}")
    return value


def integer(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_attempt_id(job_id: str, index: int, job: dict[str, Any]) -> str:
    raw = f"{job_id}|{index}|{job.get('tool')}|{job.get('targetType')}|{job.get('target')}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:48]


def manifest_to_packet(manifest: dict[str, Any]) -> dict[str, Any]:
    authorized = manifest.get("authorizedInput") if isinstance(manifest.get("authorizedInput"), dict) else {}
    manual = authorized.get("manualProcessing") if isinstance(authorized.get("manualProcessing"), dict) else {}
    if not manual:
        manual = {
            "serviceLevel": (manifest.get("package") or {}).get("packageId") or (manifest.get("package") or {}).get("slug") or "standard",
            "packageVersion": (manifest.get("package") or {}).get("version"),
            "sourceSet": manifest.get("sourceSet") or {},
            "sourcePools": manifest.get("sourcePools") or [],
            "resources": manifest.get("resources") or [],
            "imageAnalysis": manifest.get("imageAnalysis"),
            "instructions": [
                "Use only the authorized targets and package policy in this job manifest.",
                "Return normalized candidate metadata and artifact references to DiveDeep.",
                "Do not retain completed case data in this worker.",
            ],
        }
    packet = {
        "schemaVersion": int(authorized.get("schemaVersion") or 2),
        "product": authorized.get("product") or "OSINT Dive Deep v1",
        "exportedAt": authorized.get("exportedAt") or manifest.get("createdAt") or utc_now(),
        "customer": authorized.get("customer") or {},
        "authorization": authorized.get("authorization") or manifest.get("authorization") or {},
        "divedeep": authorized.get("divedeep") or {},
        "connections": authorized.get("connections") or [],
        "photos": authorized.get("photos") or [],
        "socialMediaCatalog": authorized.get("socialMediaCatalog") or [],
        "manualProcessing": manual,
    }
    if packet["schemaVersion"] != 2 or packet["product"] != "OSINT Dive Deep v1":
        raise RuntimeError("DiveDeep worker manifest does not contain a supported authorized intake packet")
    return packet


@dataclass
class WorkerConfig:
    api_origin: str
    api_path: str
    job_id: str
    execution_id: str
    pool_version_id: str
    bootstrap_token: str
    execution_name: str
    task_index: int
    task_attempt: int
    region: str
    heartbeat_seconds: int
    request_timeout_seconds: int
    job_timeout_seconds: int
    upload_recon_output: bool
    maximum_image_artifacts: int

    @classmethod
    def from_environment(cls) -> "WorkerConfig":
        task_index = integer(os.getenv("CLOUD_RUN_TASK_INDEX", "0"), 0, 0, 100000)
        if task_index != 0:
            raise RuntimeError("DiveDeep Cloud Run worker requires exactly one task with task index 0")
        origin = env_required("DIVEDEEP_API_ORIGIN").rstrip("/")
        if not origin.startswith("https://") and not origin.startswith("http://127.0.0.1") and not origin.startswith("http://localhost"):
            raise RuntimeError("DIVEDEEP_API_ORIGIN must use HTTPS outside local development")
        api_path = clean(os.getenv("DIVEDEEP_WORKER_API_PATH") or DEFAULT_API_PATH, 512)
        if not api_path.startswith("/"):
            api_path = f"/{api_path}"
        return cls(
            api_origin=origin,
            api_path=api_path.rstrip("/"),
            job_id=env_required("DIVEDEEP_RECON_JOB_ID"),
            execution_id=clean(os.getenv("DIVEDEEP_RECON_EXECUTION_ID"), 128),
            pool_version_id=env_required("DIVEDEEP_WORKER_POOL_VERSION_ID"),
            bootstrap_token=env_required("DIVEDEEP_WORKER_BOOTSTRAP_TOKEN"),
            execution_name=clean(os.getenv("CLOUD_RUN_EXECUTION") or os.getenv("K_REVISION") or socket.gethostname(), 1024),
            task_index=task_index,
            task_attempt=integer(os.getenv("CLOUD_RUN_TASK_ATTEMPT", "0"), 0, 0, 1000),
            region=clean(os.getenv("CLOUD_RUN_REGION") or os.getenv("GOOGLE_CLOUD_REGION"), 64),
            heartbeat_seconds=integer(os.getenv("DIVEDEEP_WORKER_HEARTBEAT_SECONDS", "60"), 60, 15, 120),
            request_timeout_seconds=integer(os.getenv("DIVEDEEP_WORKER_REQUEST_TIMEOUT_SECONDS", str(DEFAULT_REQUEST_TIMEOUT)), DEFAULT_REQUEST_TIMEOUT, 10, 180),
            job_timeout_seconds=integer(os.getenv("DIVEDEEP_JOB_TIMEOUT_SECONDS", "900"), 900, 30, 7200),
            upload_recon_output=clean(os.getenv("DIVEDEEP_UPLOAD_RECON_OUTPUT"), 16).lower() in {"1", "true", "yes"},
            maximum_image_artifacts=integer(os.getenv("DIVEDEEP_MAX_IMAGE_ARTIFACTS", "20"), 20, 0, 100),
        )


class WorkerApi:
    def __init__(self, config: WorkerConfig):
        self.config = config
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": f"DiveDeep-Cloud-Worker/{WORKER_VERSION}", "Accept": "application/json"})
        self._token = ""
        self._token_lock = threading.Lock()

    def close(self) -> None:
        self.session.close()

    @property
    def base_url(self) -> str:
        return f"{self.config.api_origin}{self.config.api_path}"

    def set_token(self, token: str) -> None:
        with self._token_lock:
            self._token = clean(token, 8192)

    def token(self) -> str:
        with self._token_lock:
            return self._token

    def _request(self, method: str, path: str, *, payload: Any | None = None, authenticated: bool = True) -> dict[str, Any]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if authenticated:
            token = self.token()
            if not token:
                raise RuntimeError("Worker session token is unavailable")
            headers["Authorization"] = f"Bearer {token}"
        response = self.session.request(
            method,
            url,
            headers=headers,
            data=json.dumps(payload) if payload is not None else None,
            timeout=self.config.request_timeout_seconds,
            allow_redirects=False,
        )
        try:
            body = response.json()
        except ValueError:
            body = {"error": response.text[:1000]}
        if response.status_code < 200 or response.status_code >= 300:
            code = body.get("code") if isinstance(body, dict) else None
            message = body.get("error") if isinstance(body, dict) else None
            raise RuntimeError(f"DiveDeep worker API {method} {path} failed ({response.status_code}, {code or 'unknown'}): {message or 'request failed'}")
        return body if isinstance(body, dict) else {}

    def register(self) -> dict[str, Any]:
        result = self._request(
            "POST",
            "register",
            authenticated=False,
            payload={
                "jobId": self.config.job_id,
                "executionId": self.config.execution_id or None,
                "poolVersionId": self.config.pool_version_id,
                "bootstrapToken": self.config.bootstrap_token,
                "executionName": self.config.execution_name,
                "taskIndex": self.config.task_index,
                "taskAttempt": self.config.task_attempt,
                "workerVersion": WORKER_VERSION,
                "workerProtocolVersion": WORKER_PROTOCOL_VERSION,
                "hostname": socket.gethostname(),
                "region": self.config.region or None,
            },
        )
        self.set_token(result.get("token") or "")
        if not self.token():
            raise RuntimeError("DiveDeep worker registration did not return a session token")
        return result

    def heartbeat(self, *, progress: int, completed: int, candidates: int, status: str = "running", message: str = "") -> dict[str, Any]:
        result = self._request(
            "POST",
            f"jobs/{self.config.job_id}/heartbeat",
            payload={
                "progressPercent": progress,
                "sourceCompletedCount": completed,
                "candidateCount": candidates,
                "status": status,
                "message": message or None,
            },
        )
        if result.get("token"):
            self.set_token(result["token"])
        return result

    def events(self, events: list[dict[str, Any]]) -> None:
        if events:
            self._request("POST", f"jobs/{self.config.job_id}/events", payload={"events": events[:100]})

    def source_attempts(self, attempts: list[dict[str, Any]]) -> dict[str, Any]:
        if not attempts:
            return {"accepted": 0, "attempts": []}
        return self._request("POST", f"jobs/{self.config.job_id}/source-attempts", payload={"attempts": attempts[:100]})

    def get_checkpoints(self) -> list[dict[str, Any]]:
        result = self._request("GET", f"jobs/{self.config.job_id}/checkpoints")
        checkpoints = result.get("checkpoints")
        return checkpoints if isinstance(checkpoints, list) else []

    def checkpoint(self, key: str, sequence: int, state: dict[str, Any]) -> None:
        self._request("POST", f"jobs/{self.config.job_id}/checkpoints", payload={"checkpointKey": key, "sequence": sequence, "state": state})

    def candidates(self, candidates: list[dict[str, Any]]) -> dict[str, Any]:
        if not candidates:
            return {"accepted": 0, "candidateIds": []}
        return self._request("POST", f"jobs/{self.config.job_id}/candidates", payload={"candidates": candidates[:100]})

    def download_artifact(self, artifact_id: str, destination: Path, *, expected_sha256: str = "", expected_size: int | None = None) -> Path:
        grant = self._request("GET", f"jobs/{self.config.job_id}/artifacts/{artifact_id}/download-authorization")
        url = clean(grant.get("url"), 8192)
        if not url:
            raise RuntimeError("Artifact download authorization did not include a URL")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with self.session.get(url, stream=True, timeout=max(self.config.request_timeout_seconds, 120), allow_redirects=False) as response:
            if response.status_code < 200 or response.status_code >= 300:
                raise RuntimeError(f"Private artifact download failed with HTTP {response.status_code}")
            with destination.open("wb") as handle:
                for chunk in response.iter_content(1024 * 1024):
                    if chunk:
                        handle.write(chunk)
        if os.name == "posix":
            destination.chmod(0o600)
        if expected_size is not None and destination.stat().st_size != int(expected_size):
            raise RuntimeError("Downloaded artifact size does not match the manifest")
        if expected_sha256 and file_sha256(destination) != clean(expected_sha256, 64).lower():
            raise RuntimeError("Downloaded artifact checksum does not match the manifest")
        return destination

    def upload_artifact(self, path: Path, *, artifact_type: str, retention_class: str, sensitivity: str, metadata: dict[str, Any], content_type: str = "") -> str:
        if not content_type:
            content_type = {".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower(), "text/plain")
        size = path.stat().st_size
        digest = file_sha256(path)
        reservation = self._request(
            "POST",
            f"jobs/{self.config.job_id}/artifacts/upload-authorizations",
            payload={
                "artifactType": artifact_type,
                "retentionClass": retention_class,
                "contentType": content_type,
                "byteSize": size,
                "sha256": digest,
                "sensitivity": sensitivity,
                "originalName": path.name,
                "metadata": metadata,
            },
        )
        artifact = reservation.get("artifact") or {}
        upload = reservation.get("upload") or {}
        artifact_id = clean(artifact.get("id"), 64)
        upload_url = clean(upload.get("url"), 8192)
        if not artifact_id or not upload_url:
            raise RuntimeError("Artifact reservation did not include an artifact ID and upload URL")
        with path.open("rb") as handle:
            response = requests.put(
                upload_url,
                data=handle,
                headers={str(k): str(v) for k, v in (upload.get("headers") or {}).items()},
                timeout=max(self.config.request_timeout_seconds, 120),
                allow_redirects=False,
            )
        if response.status_code < 200 or response.status_code >= 300:
            raise RuntimeError(f"Private artifact upload failed with HTTP {response.status_code}")
        self._request("POST", f"jobs/{self.config.job_id}/artifacts/{artifact_id}/finalize", payload={})
        return artifact_id

    def complete(self, outcome: str, summary: dict[str, Any], *, error_code: str = "", error_message: str = "") -> dict[str, Any]:
        result = self._request(
            "POST",
            f"jobs/{self.config.job_id}/complete",
            payload={"outcome": outcome, "summary": summary, "errorCode": error_code or None, "errorMessage": error_message or None},
        )
        if result.get("cleanupToken"):
            self.set_token(result["cleanupToken"])
        return result

    def cleanup(self) -> dict[str, Any]:
        return self._request(
            "POST",
            f"jobs/{self.config.job_id}/cleanup",
            payload={"workspaceRemoved": True, "browserProfileRemoved": True, "temporaryFilesRemoved": True, "bytesRemaining": 0},
        )


@dataclass
class RuntimeProgress:
    total: int = 0
    completed: int = 0
    candidate_count: int = 0
    current_message: str = "starting"
    status: str = "running"
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> tuple[int, int, int, str, str]:
        with self.lock:
            progress = 0 if self.total <= 0 else min(99, int((self.completed / self.total) * 100))
            return progress, self.completed, self.candidate_count, self.status, self.current_message


class HeartbeatLoop:
    def __init__(self, api: WorkerApi, progress: RuntimeProgress, interval_seconds: int):
        self.api = api
        self.progress = progress
        self.interval_seconds = interval_seconds
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name="divedeep-heartbeat", daemon=True)
        self.error: Exception | None = None

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=max(self.interval_seconds + 5, 20))

    def _run(self) -> None:
        while not self.stop_event.wait(self.interval_seconds):
            try:
                progress, completed, candidates, status, message = self.progress.snapshot()
                self.api.heartbeat(progress=progress, completed=completed, candidates=candidates, status=status, message=message)
            except Exception as exc:  # Main execution checks this before continuing to avoid working without a valid lease.
                self.error = exc
                self.stop_event.set()
                return


def candidate_payloads(records: list[dict[str, Any]], job: dict[str, Any], attempt_id: str, source_attempt_id: str | None, index: int) -> list[dict[str, Any]]:
    tool = clean(job.get("tool"), 191)
    is_image = tool == "ddgs-images"
    output: list[dict[str, Any]] = []
    for offset, record in enumerate(records[:500]):
        source_url = clean(record.get("url"), 8192)
        if not source_url:
            continue
        digest = hashlib.sha256(f"{attempt_id}|{offset}|{source_url}".encode("utf-8")).hexdigest()
        output.append(
            {
                "candidateId": digest[:48],
                "sourceAttemptId": source_attempt_id,
                "candidateType": "image_result" if is_image else "web_result",
                "sourceKey": tool,
                "sourceUrl": source_url,
                "title": clean(record.get("sourceName"), 1000),
                "summary": clean(record.get("notes"), 4000),
                "discoveredAt": utc_now(),
                "reviewBand": "manual_review",
                "sensitivity": clean(record.get("sensitivity") or "standard", 32),
                "artifactIds": [clean(value, 64) for value in (record.get("artifactIds") or []) if clean(value, 64)][:10],
                "normalized": {
                    "attemptId": attempt_id,
                    "jobIndex": index,
                    "tool": tool,
                    "targetType": clean(job.get("targetType"), 128),
                    "category": clean(record.get("category"), 128),
                    "subject": clean(record.get("subject"), 512),
                    "humanReviewRequired": True,
                    "blurredPresentationRequired": is_image,
                    "previewArtifactId": clean(record.get("previewArtifactId"), 64) or None,
                    "evidenceArtifactId": clean(record.get("evidenceArtifactId"), 64) or None,
                },
            }
        )
    return output


def _download_public_image(url: str, destination: Path, *, maximum_bytes: int = 8_000_000) -> Path:
    current = _validate_public_url(url)
    session = requests.Session()
    session.headers.update({"User-Agent": f"DiveDeep-Cloud-Worker/{WORKER_VERSION}", "Accept": "image/jpeg,image/png,image/webp,image/*;q=0.8"})
    response = None
    for _ in range(3):
        response = session.get(current, stream=True, timeout=30, allow_redirects=False)
        if response.is_redirect or response.is_permanent_redirect:
            location = response.headers.get("location") or ""
            from urllib.parse import urljoin
            current = _validate_public_url(urljoin(current, location))
            response.close()
            continue
        break
    if response is None or response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(f"Candidate image download failed with HTTP {getattr(response, 'status_code', 'unknown')}")
    content_type = clean(response.headers.get("content-type"), 128).split(";", 1)[0].lower()
    if content_type not in {"image/jpeg", "image/png", "image/webp", "image/gif"}:
        response.close()
        raise RuntimeError("Candidate URL did not return a supported image")
    destination.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with destination.open("wb") as handle:
        for chunk in response.iter_content(256 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > maximum_bytes:
                response.close()
                destination.unlink(missing_ok=True)
                raise RuntimeError("Candidate image exceeded the worker download limit")
            handle.write(chunk)
    response.close()
    if os.name == "posix":
        destination.chmod(0o600)
    return destination


def prepare_candidate_image_assets(api: WorkerApi, record: dict[str, Any], workspace: Path, *, attempt_id: str, index: int, offset: int) -> dict[str, Any]:
    image_url = clean(record.get("imageUrl"), 8192)
    if not image_url:
        return record
    download = workspace / "candidate-downloads" / f"{index:04d}-{offset:04d}.bin"
    _download_public_image(image_url, download)
    Image.MAX_IMAGE_PIXELS = 40_000_000
    try:
        with Image.open(download) as opened:
            if int(opened.width) * int(opened.height) > 40_000_000:
                raise RuntimeError("Candidate image exceeded the decoded-pixel limit")
            opened.load()
            image = ImageOps.exif_transpose(opened).convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        download.unlink(missing_ok=True)
        raise RuntimeError(f"Candidate image could not be decoded safely: {exc}") from exc
    finally:
        download.unlink(missing_ok=True)
    image.thumbnail((2048, 2048))
    normalized = workspace / "candidate-assets" / f"{index:04d}-{offset:04d}-review.jpg"
    blurred = workspace / "candidate-assets" / f"{index:04d}-{offset:04d}-blurred.jpg"
    normalized.parent.mkdir(parents=True, exist_ok=True)
    image.save(normalized, format="JPEG", quality=85, optimize=True)
    preview = image.copy()
    preview.thumbnail((640, 640))
    preview = preview.filter(ImageFilter.GaussianBlur(radius=18))
    preview.save(blurred, format="JPEG", quality=65, optimize=True)
    if os.name == "posix":
        normalized.chmod(0o600)
        blurred.chmod(0o600)
    category = clean(record.get("category"), 128).lower()
    sensitivity = "sensitive" if any(value in category for value in ("sensitive", "adult", "explicit")) else "standard"
    shared = {"jobIndex": index, "candidateOffset": offset, "attemptId": attempt_id, "sourceHost": clean(record.get("sourceName"), 255)}
    evidence_id = api.upload_artifact(normalized, artifact_type="candidate_image", retention_class="pending_review", sensitivity=sensitivity, metadata={**shared, "presentation": "review_only"}, content_type="image/jpeg")
    preview_id = api.upload_artifact(blurred, artifact_type="blurred_thumbnail", retention_class="pending_review", sensitivity=sensitivity, metadata={**shared, "presentation": "blurred_analysis_wall"}, content_type="image/jpeg")
    normalized.unlink(missing_ok=True)
    blurred.unlink(missing_ok=True)
    return {**record, "artifactIds": [evidence_id, preview_id], "evidenceArtifactId": evidence_id, "previewArtifactId": preview_id, "sensitivity": sensitivity}


def classify_attempt(result: Any, candidate_count: int) -> tuple[str, str | None]:
    if getattr(result, "timed_out", False):
        return "timed_out", "timeout"
    if getattr(result, "return_code", 1) != 0 or getattr(result, "error", ""):
        text = clean(getattr(result, "error", ""), 1000).lower()
        if "429" in text or "rate limit" in text:
            return "rate_limited", "rate_limit"
        if "403" in text or "blocked" in text:
            return "blocked", "access_blocked"
        return "failed", "execution_error"
    return ("candidate_found", None) if candidate_count else ("no_result", None)


def wipe_directory(root: Path) -> None:
    if root.exists():
        shutil.rmtree(root)
    if root.exists():
        raise RuntimeError("Temporary DiveDeep workspace could not be removed")


def run_worker(config: WorkerConfig) -> int:
    api = WorkerApi(config)
    temp_root = Path(os.getenv("DIVEDEEP_EPHEMERAL_ROOT") or f"/tmp/divedeep/{config.job_id}").resolve()
    if not str(temp_root).startswith("/tmp/"):
        raise RuntimeError("DIVEDEEP_EPHEMERAL_ROOT must be under /tmp")
    temp_root.mkdir(parents=True, exist_ok=False)
    if os.name == "posix":
        temp_root.chmod(0o700)
    os.environ["HOME"] = str(temp_root / "home")
    Path(os.environ["HOME"]).mkdir(mode=0o700)

    progress = RuntimeProgress()
    heartbeat: HeartbeatLoop | None = None
    completion_sent = False
    cleanup_token_received = False
    summary: dict[str, Any] = {"workerVersion": WORKER_VERSION, "jobId": config.job_id, "startedAt": utc_now()}
    failures: list[dict[str, Any]] = []
    artifact_ids: list[str] = []
    try:
        registration = api.register()
        manifest = registration.get("manifest") if isinstance(registration.get("manifest"), dict) else {}
        if clean(manifest.get("jobId"), 64) != config.job_id:
            raise RuntimeError("Registered manifest does not match the Cloud Run job assignment")
        packet = manifest_to_packet(manifest)
        imported = import_uploaded_packet(
            f"divedeep-{config.job_id}.json",
            json.dumps(packet, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
            workspace_root=temp_root,
            package_key=clean((manifest.get("package") or {}).get("packageId") or (packet.get("customer") or {}).get("planTier"), 64),
        )
        workspace = Path(imported["workspace"])
        input_artifacts = manifest.get("inputArtifacts") if isinstance(manifest.get("inputArtifacts"), list) else []
        for input_artifact in input_artifacts[:25]:
            if not isinstance(input_artifact, dict) or input_artifact.get("artifactType") != "reference_image":
                continue
            artifact_id = clean(input_artifact.get("id"), 64)
            content_type = clean(input_artifact.get("contentType"), 128)
            photo_id = clean(input_artifact.get("photoId") or artifact_id, 128)
            suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(content_type)
            if not artifact_id or not suffix:
                continue
            temporary_photo = temp_root / "downloads" / f"{photo_id}{suffix}"
            api.download_artifact(
                artifact_id,
                temporary_photo,
                expected_sha256=clean(input_artifact.get("sha256"), 64),
                expected_size=int(input_artifact.get("byteSize")) if input_artifact.get("byteSize") is not None else None,
            )
            store_reference_photo(
                workspace,
                photo_id,
                content_type,
                temporary_photo.read_bytes(),
                expected_sha256=clean(input_artifact.get("sha256"), 64),
            )
            temporary_photo.unlink(missing_ok=True)
        bundle = load_workspace_bundle(workspace)
        jobs = bundle.get("toolPlan", {}).get("jobs", []) or []
        completed_indices: list[int] = []
        resumed_candidate_count = 0
        for checkpoint in api.get_checkpoints():
            if not isinstance(checkpoint, dict) or checkpoint.get("checkpointKey") != "source-jobs":
                continue
            state = checkpoint.get("state") if isinstance(checkpoint.get("state"), dict) else {}
            completed_indices = sorted({
                int(value) for value in (state.get("completedIndices") or [])
                if isinstance(value, int) or (isinstance(value, str) and value.isdigit())
            })
            completed_indices = [value for value in completed_indices if 0 <= value < len(jobs)]
            resumed_candidate_count = max(int(state.get("candidateCount") or 0), 0)
            break
        progress.total = max(len(jobs), 1)
        progress.completed = len(completed_indices)
        progress.candidate_count = resumed_candidate_count
        heartbeat = HeartbeatLoop(api, progress, config.heartbeat_seconds)
        heartbeat.start()
        api.events([{
            "type": "worker.execution_started",
            "details": {
                "workerVersion": WORKER_VERSION,
                "jobCount": len(jobs),
                "taskAttempt": config.task_attempt,
                "resumedCompletedJobCount": len(completed_indices),
            },
        }])

        for index, job in enumerate(jobs):
            if index in completed_indices:
                continue
            if heartbeat.error:
                raise RuntimeError(f"Worker heartbeat failed: {heartbeat.error}")
            tool = clean(job.get("tool"), 191) or "unknown"
            attempt_id = stable_attempt_id(config.job_id, index, job)
            started_at = utc_now()
            with progress.lock:
                progress.current_message = f"Running authorized {tool} check {index + 1} of {len(jobs)}"
            started_response = api.source_attempts([{
                "attemptId": attempt_id,
                "sourceKey": tool,
                "status": "started",
                "startedAt": started_at,
                "metadata": {"jobIndex": index, "targetType": clean(job.get("targetType"), 128)},
            }])
            source_attempt_id = next((item.get("id") for item in started_response.get("attempts", []) if item.get("clientAttemptId") == attempt_id), None)
            install_status, install_hint = job_install_status(job)
            if install_status == "Manual":
                api.source_attempts([{
                    "attemptId": attempt_id,
                    "sourceKey": tool,
                    "status": "skipped",
                    "startedAt": started_at,
                    "completedAt": utc_now(),
                    "errorClass": "manual_review_required",
                    "metadata": {"jobIndex": index, "reason": "This step requires provider or human review"},
                }])
                completed_indices.append(index)
            elif install_status == "Missing":
                api.source_attempts([{
                    "attemptId": attempt_id,
                    "sourceKey": tool,
                    "status": "unsupported",
                    "startedAt": started_at,
                    "completedAt": utc_now(),
                    "errorClass": "tool_unavailable",
                    "metadata": {"jobIndex": index, "installHint": clean(install_hint, 500)},
                }])
                failures.append({"index": index, "tool": tool, "status": "unsupported"})
                completed_indices.append(index)
            else:
                started_monotonic = time.monotonic()
                result = execute_job_direct(workspace, index, timeout_seconds=config.job_timeout_seconds)
                output_text = read_job_output(workspace, index)
                records = extract_candidate_records(output_text, job)
                if tool == "ddgs-images" and config.maximum_image_artifacts > 0:
                    enriched_records: list[dict[str, Any]] = []
                    for offset, record in enumerate(records):
                        if offset >= config.maximum_image_artifacts:
                            enriched_records.append(record)
                            continue
                        try:
                            enriched_records.append(prepare_candidate_image_assets(api, record, workspace, attempt_id=attempt_id, index=index, offset=offset))
                        except Exception as image_error:
                            enriched_records.append(record)
                            api.events([{
                                "type": "worker.candidate_image_skipped",
                                "details": {"jobIndex": index, "candidateOffset": offset, "errorType": type(image_error).__name__, "message": clean(str(image_error), 500)},
                            }])
                    records = enriched_records
                payloads = candidate_payloads(records, job, attempt_id, source_attempt_id, index)
                candidate_response = api.candidates(payloads)
                accepted_candidates = int(candidate_response.get("accepted") or 0)
                if config.upload_recon_output and output_text:
                    output_path = workspace / "raw" / "cloud-worker-exports" / f"{index:04d}-{tool}.txt"
                    output_path.parent.mkdir(parents=True, exist_ok=True)
                    output_path.write_text(output_text, encoding="utf-8")
                    if os.name == "posix":
                        output_path.chmod(0o600)
                    artifact_ids.append(api.upload_artifact(
                        output_path,
                        artifact_type="recon_output",
                        retention_class="pending_review" if accepted_candidates else "transient_nonmatch",
                        sensitivity="standard",
                        metadata={"jobIndex": index, "tool": tool, "attemptId": attempt_id},
                    ))
                status, error_class = classify_attempt(result, accepted_candidates)
                duration_ms = int((time.monotonic() - started_monotonic) * 1000)
                api.source_attempts([{
                    "attemptId": attempt_id,
                    "sourceKey": tool,
                    "status": status,
                    "startedAt": started_at,
                    "completedAt": utc_now(),
                    "candidateCount": accepted_candidates,
                    "durationMs": duration_ms,
                    "errorClass": error_class,
                    "metadata": {
                        "jobIndex": index,
                        "returnCode": getattr(result, "return_code", None),
                        "timedOut": bool(getattr(result, "timed_out", False)),
                        "candidateRecords": len(records),
                    },
                }])
                if status in {"failed", "timed_out", "blocked", "rate_limited"}:
                    failures.append({"index": index, "tool": tool, "status": status})
                completed_indices.append(index)
                with progress.lock:
                    progress.candidate_count += accepted_candidates
            with progress.lock:
                progress.completed = len(completed_indices)
            api.checkpoint(
                "source-jobs",
                len(completed_indices),
                {"completedIndices": completed_indices, "candidateCount": progress.candidate_count, "updatedAt": utc_now()},
            )
            snap = progress.snapshot()
            api.heartbeat(progress=snap[0], completed=snap[1], candidates=snap[2], status="running", message=snap[4])

        if heartbeat:
            heartbeat.stop()
            if heartbeat.error:
                raise RuntimeError(f"Worker heartbeat failed: {heartbeat.error}")
            heartbeat = None
        outcome = "partial" if failures else "completed"
        summary.update({
            "completedAt": utc_now(),
            "outcome": outcome,
            "jobCount": len(jobs),
            "completedJobCount": len(completed_indices),
            "candidateCount": progress.candidate_count,
            "failureCount": len(failures),
            "failures": failures[:100],
            "artifactIds": artifact_ids,
        })
        result = api.complete(outcome, summary)
        completion_sent = True
        cleanup_token_received = bool(result.get("cleanupToken"))
        wipe_directory(temp_root)
        api.cleanup()
        return 0
    except Exception as exc:
        if heartbeat:
            heartbeat.stop()
        error_message = f"{type(exc).__name__}: {exc}"
        summary.update({"completedAt": utc_now(), "outcome": "failed", "error": error_message, "trace": traceback.format_exc(limit=10)[-12000:]})
        try:
            api.events([{"type": "worker.execution_failed", "details": {"errorType": type(exc).__name__, "message": clean(str(exc), 1000)}}])
        except Exception:
            pass
        if not completion_sent:
            try:
                result = api.complete("failed", summary, error_code="DIVEDEEP_WORKER_FAILED", error_message=clean(error_message, 2000))
                cleanup_token_received = bool(result.get("cleanupToken"))
            except Exception:
                pass
        try:
            wipe_directory(temp_root)
        except Exception:
            pass
        if cleanup_token_received:
            try:
                api.cleanup()
            except Exception:
                pass
        print(json.dumps({"status": "failed", "jobId": config.job_id, "error": error_message}), file=sys.stderr, flush=True)
        return 1
    finally:
        api.close()


def main() -> int:
    try:
        return run_worker(WorkerConfig.from_environment())
    except Exception as exc:
        print(json.dumps({"status": "startup_failed", "error": f"{type(exc).__name__}: {exc}"}), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
