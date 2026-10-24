from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .divedeep_ops import (
    MISSION_FAMILIES,
    import_uploaded_packet,
    list_workspaces,
    load_workspace_bundle,
    pending_executable_indices,
)
from .release import API_VERSION, compatibility_payload
from .runtime_state import read_state, set_drain
from .server_queue import ServerQueue


APP_VERSION = compatibility_payload()["appVersion"]
MAX_BODY_BYTES = max(1_048_576, min(int(os.environ.get("DIVEDEEP_API_MAX_BODY_BYTES", "10485760")), 52_428_800))
WORKSPACE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,160}$")


def _docs_path() -> str | None:
    return "/docs" if os.environ.get("DIVEDEEP_API_DOCS", "0") == "1" else None


app = FastAPI(
    title="DiveDeep Server API",
    version=API_VERSION,
    docs_url=_docs_path(),
    redoc_url=None,
    openapi_url="/openapi.json" if _docs_path() else None,
)
queue = ServerQueue()


class RunRequest(BaseModel):
    mode: Literal["all", "next", "family", "selected"] = "all"
    family: str | None = None
    indices: list[int] = Field(default_factory=list, max_length=500)
    include_failed: bool = False
    continue_on_failure: bool = True
    timeout_seconds: int = Field(default=900, ge=30, le=7200)


class PlanRequest(BaseModel):
    package_key: str | None = None
    families: list[str] | None = None


class DrainRequest(BaseModel):
    reason: str = Field(default="Scheduled maintenance", min_length=1, max_length=500)
    requested_by: str = Field(default="api", min_length=1, max_length=200)


def _configured_api_key() -> str:
    return os.environ.get("DIVEDEEP_API_KEY", "").strip()


def _supplied_key(authorization: str | None, x_divedeep_api_key: str | None) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return (x_divedeep_api_key or "").strip()


def require_api_key(
    authorization: str | None = Header(default=None),
    x_divedeep_api_key: str | None = Header(default=None),
) -> None:
    expected = _configured_api_key()
    if not expected:
        if os.environ.get("DIVEDEEP_API_ALLOW_UNAUTHENTICATED", "0") == "1":
            return
        raise HTTPException(status_code=503, detail="DiveDeep API authentication is not configured.")
    supplied = _supplied_key(authorization, x_divedeep_api_key)
    if not supplied or not hmac.compare_digest(hashlib.sha256(supplied.encode()).digest(), hashlib.sha256(expected.encode()).digest()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid DiveDeep API key.")


def _workspace_rows() -> list[dict[str, Any]]:
    return list_workspaces()


def _workspace_summary(row: dict[str, Any]) -> dict[str, Any]:
    path = Path(str(row.get("workspace") or ""))
    return {
        "id": path.name,
        "customerId": row.get("customerId"),
        "profileId": row.get("profileId"),
        "displayName": row.get("displayName") or row.get("customerName"),
        "packageKey": row.get("packageKey"),
        "packageLabel": row.get("packageLabel"),
        "findingCount": row.get("findingCount", 0),
        "jobCount": row.get("jobCount", 0),
        "completedJobs": row.get("completedJobs", 0),
        "operatorStatus": row.get("operatorStatus"),
        "updatedAt": row.get("updatedAt"),
    }


def _workspace_path(workspace_id: str) -> Path:
    if not WORKSPACE_ID_RE.fullmatch(workspace_id):
        raise HTTPException(status_code=400, detail="Invalid workspace identifier.")
    for row in _workspace_rows():
        path = Path(str(row.get("workspace") or "")).expanduser().resolve()
        if path.name == workspace_id or str(row.get("customerId") or "") == workspace_id:
            return path
    raise HTTPException(status_code=404, detail="DiveDeep workspace not found.")


def _ensure_accepting_work() -> None:
    drain = (read_state().get("drain") or {})
    if drain.get("enabled"):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "divedeep_draining",
                "message": "DiveDeep is draining for maintenance and is not accepting new work.",
                "reason": drain.get("reason"),
                "requestedAt": drain.get("requestedAt"),
            },
        )


def _node_telemetry() -> dict[str, Any]:
    state = read_state()
    usage = shutil.disk_usage(queue.path.parent)
    queue_stats = queue.stats()
    browser_root = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")).expanduser() if os.environ.get("PLAYWRIGHT_BROWSERS_PATH") else None
    tools = {
        "sherlock": bool(shutil.which("sherlock")),
        "maigret": bool(shutil.which("maigret")),
        "spiderfoot": bool(shutil.which("spiderfoot") or shutil.which("spiderfoot-cli")),
        "playwrightBrowserCache": bool(browser_root and browser_root.exists()),
        "ddgs": True,
    }
    free_percent = round((usage.free / usage.total) * 100, 2) if usage.total else 0
    return {
        "compatibility": compatibility_payload(),
        "drain": state.get("drain", {}),
        "worker": state.get("worker", {}),
        "queue": queue_stats,
        "tools": tools,
        "storage": {
            "path": str(queue.path.parent),
            "totalBytes": usage.total,
            "usedBytes": usage.used,
            "freeBytes": usage.free,
            "freePercent": free_percent,
            "warning": free_percent < 15,
        },
    }


def _job_public(item: dict[str, Any] | None) -> dict[str, Any]:
    if not item:
        raise HTTPException(status_code=404, detail="Server job not found.")
    workspace = Path(str(item.get("workspace") or ""))
    return {
        **{key: value for key, value in item.items() if key != "workspace"},
        "workspaceId": workspace.name,
    }


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "service": "divedeep-api", "version": APP_VERSION, "apiVersion": API_VERSION}


@app.get("/ready")
def ready() -> JSONResponse:
    configured = bool(_configured_api_key()) or os.environ.get("DIVEDEEP_API_ALLOW_UNAUTHENTICATED", "0") == "1"
    state = read_state()
    draining = bool((state.get("drain") or {}).get("enabled"))
    ready_state = configured and not draining
    if not configured:
        label = "configuration-required"
    elif draining:
        label = "draining"
    else:
        label = "ready"
    return JSONResponse(
        {
            "status": label,
            "apiKeyConfigured": configured,
            "acceptingWork": ready_state,
            "drain": state.get("drain", {}),
            "compatibility": compatibility_payload(),
        },
        status_code=200 if ready_state else 503,
    )


@app.get("/v1/version", dependencies=[Depends(require_api_key)])
def version() -> dict[str, Any]:
    return {**compatibility_payload(), "missionFamilies": MISSION_FAMILIES}

@app.get("/v1/system/status", dependencies=[Depends(require_api_key)])
def system_status() -> dict[str, Any]:
    return _node_telemetry()


@app.post("/v1/system/drain", dependencies=[Depends(require_api_key)])
def enable_drain(body: DrainRequest) -> dict[str, Any]:
    set_drain(True, reason=body.reason, requested_by=body.requested_by)
    return _node_telemetry()


@app.delete("/v1/system/drain", dependencies=[Depends(require_api_key)])
def disable_drain() -> dict[str, Any]:
    set_drain(False)
    return _node_telemetry()


@app.post("/v1/intakes", status_code=201, dependencies=[Depends(require_api_key)])
async def create_intake(
    request: Request,
    x_divedeep_filename: str | None = Header(default=None),
    x_divedeep_package: str | None = Header(default=None),
) -> dict[str, Any]:
    _ensure_accepting_work()
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail=f"Intake JSON must not exceed {MAX_BODY_BYTES} bytes.")
        chunks.append(chunk)
    body = b"".join(chunks)
    if not body:
        raise HTTPException(status_code=400, detail="DiveDeep intake JSON is empty.")
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON intake: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="DiveDeep intake must be a JSON object.")
    filename = Path(x_divedeep_filename or "divedeep-intake.json").name
    imported = import_uploaded_packet(filename, body, package_key=x_divedeep_package)
    workspace = Path(imported["workspace"])
    return {
        "workspaceId": workspace.name,
        "customerId": (imported.get("manifest") or {}).get("customerId"),
        "profileId": (imported.get("manifest") or {}).get("profileId"),
        "package": imported.get("package"),
        "toolJobs": imported.get("toolJobs", 0),
        "caseDirectory": "case",
    }


@app.get("/v1/workspaces", dependencies=[Depends(require_api_key)])
def workspaces() -> dict[str, Any]:
    rows = [_workspace_summary(row) for row in _workspace_rows()]
    return {"items": rows, "count": len(rows)}


@app.get("/v1/workspaces/{workspace_id}", dependencies=[Depends(require_api_key)])
def workspace(workspace_id: str, include_sensitive: bool = Query(default=False)) -> dict[str, Any]:
    path = _workspace_path(workspace_id)
    bundle = load_workspace_bundle(path)
    response = {
        "workspaceId": path.name,
        "manifest": bundle["manifest"],
        "package": bundle["toolPlan"].get("package", {}),
        "toolPlan": bundle["toolPlan"],
        "operatorState": bundle["operatorState"],
        "caseSummary": bundle["caseSummary"],
        "resultSummary": bundle["results"].get("summary", {}),
        "findingCount": len(bundle["results"].get("findings", []) or []),
        "observableCount": len(bundle["observables"].get("items", []) or []),
    }
    if include_sensitive:
        response["intake"] = bundle["intake"]
        response["results"] = bundle["results"]
        response["observables"] = bundle["observables"]
    return response


@app.post("/v1/workspaces/{workspace_id}/runs", status_code=202, dependencies=[Depends(require_api_key)])
def create_run(workspace_id: str, body: RunRequest) -> dict[str, Any]:
    _ensure_accepting_work()
    path = _workspace_path(workspace_id)
    bundle = load_workspace_bundle(path)
    jobs = bundle["toolPlan"].get("jobs", []) or []
    pending = pending_executable_indices(path, include_failed=body.include_failed)
    if body.mode == "next":
        selected = pending[:1]
    elif body.mode == "family":
        if not body.family or body.family not in MISSION_FAMILIES:
            raise HTTPException(status_code=400, detail="A valid mission family is required.")
        selected = [index for index in pending if str(jobs[index].get("family") or "") == body.family]
    elif body.mode == "selected":
        requested = sorted(set(body.indices))
        selected = [index for index in requested if index in pending]
    else:
        selected = pending
    if not selected:
        raise HTTPException(status_code=409, detail="No executable pending jobs match this request.")
    record = queue.enqueue(
        "run_jobs",
        path,
        {
            "indices": selected,
            "timeout_seconds": body.timeout_seconds,
            "continue_on_failure": body.continue_on_failure,
            "mode": body.mode,
            "family": body.family,
        },
    )
    return _job_public(record)


@app.post("/v1/workspaces/{workspace_id}/plans/rebuild", status_code=202, dependencies=[Depends(require_api_key)])
def rebuild_plan(workspace_id: str, body: PlanRequest) -> dict[str, Any]:
    _ensure_accepting_work()
    path = _workspace_path(workspace_id)
    if body.families:
        invalid = [family for family in body.families if family not in MISSION_FAMILIES]
        if invalid:
            raise HTTPException(status_code=400, detail=f"Unsupported mission families: {', '.join(invalid)}")
    record = queue.enqueue(
        "rebuild_plan",
        path,
        {"package_key": body.package_key, "families": body.families},
    )
    return _job_public(record)


@app.post("/v1/workspaces/{workspace_id}/exports", status_code=202, dependencies=[Depends(require_api_key)])
def export_results(workspace_id: str) -> dict[str, Any]:
    _ensure_accepting_work()
    path = _workspace_path(workspace_id)
    return _job_public(queue.enqueue("export_results", path, {}))


@app.get("/v1/workspaces/{workspace_id}/results", dependencies=[Depends(require_api_key)])
def results(workspace_id: str) -> dict[str, Any]:
    path = _workspace_path(workspace_id)
    return load_workspace_bundle(path)["results"]


@app.get("/v1/workspaces/{workspace_id}/results/download", dependencies=[Depends(require_api_key)])
def download_results(workspace_id: str):
    path = _workspace_path(workspace_id)
    output = path / "out" / "divedeep-results.json"
    if not output.is_file():
        raise HTTPException(status_code=404, detail="No exported result packet is available. Queue an export first.")
    return FileResponse(output, media_type="application/json", filename=f"{path.name}-divedeep-results.json")


@app.get("/v1/jobs", dependencies=[Depends(require_api_key)])
def jobs(limit: int = Query(default=100, ge=1, le=500), job_status: str | None = Query(default=None, alias="status")) -> dict[str, Any]:
    items = [_job_public(item) for item in queue.list(limit=limit, status=job_status)]
    return {"items": items, "count": len(items)}


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(require_api_key)])
def job(job_id: str) -> dict[str, Any]:
    return _job_public(queue.get(job_id))


@app.delete("/v1/jobs/{job_id}", dependencies=[Depends(require_api_key)])
def cancel_job(job_id: str) -> dict[str, Any]:
    if not queue.get(job_id, include_events=False):
        raise HTTPException(status_code=404, detail="Server job not found.")
    if not queue.cancel(job_id):
        raise HTTPException(status_code=409, detail="Only queued jobs can be cancelled.")
    return _job_public(queue.get(job_id))
