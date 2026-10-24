from __future__ import annotations

import json
import os
import signal
import socket
import sys
import time
from pathlib import Path
from typing import Any

from .divedeep_ops import execute_job_direct, export_workspace_results, rebuild_tool_plan, resolve_workspace
from .runtime_state import is_draining, update_worker
from .server_queue import ServerQueue


_STOP = False


def _stop(_signum: int, _frame: Any) -> None:
    global _STOP
    _STOP = True


def _run_jobs(queue: ServerQueue, record: dict[str, Any]) -> dict[str, Any]:
    payload = record.get("payload") or {}
    workspace = resolve_workspace(record["workspace"])
    indices = [int(value) for value in payload.get("indices", [])]
    timeout = max(30, min(int(payload.get("timeout_seconds", 900)), 7200))
    continue_on_failure = bool(payload.get("continue_on_failure", True))
    completed: list[int] = []
    failed: list[dict[str, Any]] = []
    total = len(indices)
    for position, index in enumerate(indices, start=1):
        if _STOP:
            raise RuntimeError("Worker shutdown requested while a queue was running.")
        queue.progress(record["id"], position - 1, total, f"Starting DiveDeep job index {index}.")
        result = execute_job_direct(workspace, index, timeout_seconds=timeout)
        if result.return_code == 0 and not result.timed_out and not result.error:
            completed.append(index)
            queue.event(record["id"], f"DiveDeep job index {index} completed.")
        else:
            detail = {
                "index": index,
                "returnCode": result.return_code,
                "timedOut": result.timed_out,
                "error": result.error,
            }
            failed.append(detail)
            queue.event(record["id"], f"DiveDeep job index {index} failed: {result.error or result.return_code}", "error")
            if not continue_on_failure:
                break
        queue.progress(record["id"], position, total)
    return {
        "workspace": workspace.name,
        "requested": indices,
        "completed": completed,
        "failed": failed,
        "completedCount": len(completed),
        "failedCount": len(failed),
    }


def _run_action(queue: ServerQueue, record: dict[str, Any]) -> dict[str, Any]:
    action = record["action"]
    payload = record.get("payload") or {}
    workspace = resolve_workspace(record["workspace"])
    if action == "run_jobs":
        return _run_jobs(queue, record)
    if action == "export_results":
        queue.progress(record["id"], 0, 1, "Generating the DiveDeep result packet.")
        packet = export_workspace_results(workspace)
        output = workspace / "out" / "divedeep-results.json"
        queue.progress(record["id"], 1, 1)
        return {
            "workspace": workspace.name,
            "output": str(output),
            "findingCount": len(packet.get("findings", []) or []),
            "summary": packet.get("summary", {}),
        }
    if action == "rebuild_plan":
        queue.progress(record["id"], 0, 1, "Rebuilding the authorized package plan.")
        families = payload.get("families")
        plan = rebuild_tool_plan(workspace, families=families, package_key=payload.get("package_key"))
        queue.progress(record["id"], 1, 1)
        return {
            "workspace": workspace.name,
            "package": plan.get("package", {}),
            "jobCount": len(plan.get("jobs", []) or []),
        }
    raise ValueError(f"Unsupported server action: {action}")


def main() -> int:
    global _STOP
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    queue = ServerQueue()
    stale = queue.recover_stale(int(os.environ.get("DIVEDEEP_STALE_JOB_SECONDS", "3600")))
    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    poll = max(0.5, min(float(os.environ.get("DIVEDEEP_WORKER_POLL_SECONDS", "2")), 30.0))
    update_worker(
        status="idle", workerId=worker_id, pid=os.getpid(), hostname=socket.gethostname(),
        startedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), currentJobId=None, lastError=None,
    )
    print(json.dumps({"event": "worker.started", "workerId": worker_id, "recovered": stale}), flush=True)
    last_heartbeat = 0.0
    while not _STOP:
        now = time.monotonic()
        if now - last_heartbeat >= 15:
            update_worker(status="draining" if is_draining() else "idle", workerId=worker_id, pid=os.getpid())
            last_heartbeat = now
        if is_draining():
            time.sleep(poll)
            continue
        record = queue.claim_next(worker_id)
        if record is None:
            time.sleep(poll)
            continue
        update_worker(status="running", workerId=worker_id, pid=os.getpid(), currentJobId=record["id"], lastError=None)
        try:
            result = _run_action(queue, record)
            queue.complete(record["id"], result)
            update_worker(status="idle", currentJobId=None, lastCompletedJobId=record["id"], lastError=None)
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            queue.fail(record["id"], message)
            update_worker(status="idle", currentJobId=None, lastError=message)
            print(json.dumps({"event": "job.failed", "jobId": record["id"], "error": message}), file=sys.stderr, flush=True)
    update_worker(status="stopped", workerId=worker_id, pid=os.getpid(), currentJobId=None)
    print(json.dumps({"event": "worker.stopped", "workerId": worker_id}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
