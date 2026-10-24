from __future__ import annotations

import argparse
import json
import os
import socket
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .paths import DATA_ROOT, ensure_private_directory


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def state_path() -> Path:
    configured = os.environ.get("DIVEDEEP_STATE_FILE", "").strip()
    return Path(configured).expanduser() if configured else DATA_ROOT / "system-state.json"


def _default_state() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "drain": {
            "enabled": False,
            "reason": None,
            "requestedAt": None,
            "requestedBy": None,
        },
        "worker": {
            "status": "unknown",
            "workerId": None,
            "pid": None,
            "hostname": socket.gethostname(),
            "startedAt": None,
            "heartbeatAt": None,
            "currentJobId": None,
            "lastCompletedJobId": None,
            "lastError": None,
        },
        "updatedAt": utc_now(),
    }


@contextmanager
def _state_lock():
    path = state_path()
    ensure_private_directory(path.parent)
    lock_path = path.with_suffix(path.suffix + ".lock")
    handle = lock_path.open("a+")
    if os.name == "posix":
        lock_path.chmod(0o600)
    try:
        if os.name == "posix":
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        if os.name == "posix":
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def _mutate_state(mutator: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    with _state_lock():
        state = read_state()
        mutator(state)
        return write_state(state)


def read_state() -> dict[str, Any]:
    path = state_path()
    if not path.is_file():
        return _default_state()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _default_state()
    if not isinstance(value, dict):
        return _default_state()
    state = _default_state()
    state.update(value)
    if isinstance(value.get("drain"), dict):
        state["drain"].update(value["drain"])
    if isinstance(value.get("worker"), dict):
        state["worker"].update(value["worker"])
    return state


def write_state(state: dict[str, Any]) -> dict[str, Any]:
    path = state_path()
    ensure_private_directory(path.parent)
    state["updatedAt"] = utc_now()
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return state


def set_drain(enabled: bool, *, reason: str | None = None, requested_by: str | None = None) -> dict[str, Any]:
    def apply(state: dict[str, Any]) -> None:
        state["drain"] = {
            "enabled": bool(enabled),
            "reason": (reason or "Scheduled maintenance")[:500] if enabled else None,
            "requestedAt": utc_now() if enabled else None,
            "requestedBy": (requested_by or "system")[:200] if enabled else None,
        }
    return _mutate_state(apply)


def is_draining() -> bool:
    return bool((read_state().get("drain") or {}).get("enabled"))


def update_worker(**values: Any) -> dict[str, Any]:
    def apply(state: dict[str, Any]) -> None:
        worker = state.setdefault("worker", {})
        worker.update(values)
        worker["heartbeatAt"] = utc_now()
        state["worker"] = worker
    return _mutate_state(apply)


def main() -> int:
    parser = argparse.ArgumentParser(description="Read or update DiveDeep runtime state.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--drain", action="store_true")
    group.add_argument("--resume", action="store_true")
    parser.add_argument("--reason", default="Scheduled maintenance")
    parser.add_argument("--requested-by", default="command-line")
    args = parser.parse_args()
    if args.drain:
        state = set_drain(True, reason=args.reason, requested_by=args.requested_by)
    elif args.resume:
        state = set_drain(False)
    else:
        state = read_state()
    print(json.dumps(state, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
