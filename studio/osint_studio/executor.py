from __future__ import annotations

import hashlib
import json
import os
import selectors
import signal
import subprocess
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .paths import DATA_ROOT, ensure_private_directory

HISTORY_DIR = DATA_ROOT
HISTORY_PATH = HISTORY_DIR / "history.jsonl"


@dataclass
class ExecutionResult:
    argv: list[str]
    started_at: str
    finished_at: str
    return_code: int | None
    timed_out: bool
    duration_seconds: float
    output: str
    error: str = ""
    stdout: str = ""
    stderr: str = ""
    stdout_bytes: bytes = b""
    stderr_bytes: bytes = b""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def append_history(record: dict[str, object]) -> None:
    ensure_private_directory(HISTORY_DIR)
    with HISTORY_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def load_history(limit: int = 200) -> list[dict[str, object]]:
    if not HISTORY_PATH.exists():
        return []
    records: list[dict[str, object]] = []
    try:
        with HISTORY_PATH.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    records.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        return []
    return records[-limit:][::-1]


def run_command(
    argv: list[str],
    *,
    timeout_seconds: int,
    cwd: str | None = None,
    on_output: Callable[[str], None] | None = None,
    max_output_chars: int = 1_000_000,
) -> ExecutionResult:
    started_at = _utc_now()
    start = time.monotonic()
    combined_parts: list[bytes] = []
    stdout_parts: list[bytes] = []
    stderr_parts: list[bytes] = []
    error = ""
    timed_out = False
    return_code: int | None = None

    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd or None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            shell=False,
            start_new_session=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        assert process.stdout is not None
        assert process.stderr is not None
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")

        def emit_preview() -> None:
            if on_output:
                preview = b"".join(combined_parts)[-max_output_chars:].decode("utf-8", errors="replace")
                on_output(preview)

        while True:
            elapsed = time.monotonic() - start
            if elapsed > timeout_seconds:
                timed_out = True
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=3)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                break

            events = selector.select(timeout=0.2)
            for key, _ in events:
                chunk = os.read(key.fd, 64 * 1024)
                if chunk:
                    combined_parts.append(chunk)
                    (stdout_parts if key.data == "stdout" else stderr_parts).append(chunk)
                    emit_preview()

            if process.poll() is not None:
                for stream, parts in ((process.stdout, stdout_parts), (process.stderr, stderr_parts)):
                    remainder = stream.read()
                    if remainder:
                        parts.append(remainder)
                        combined_parts.append(remainder)
                emit_preview()
                return_code = process.returncode
                break

        if return_code is None:
            return_code = process.poll()
        if timed_out:
            for stream, parts in ((process.stdout, stdout_parts), (process.stderr, stderr_parts)):
                remainder = stream.read()
                if remainder:
                    parts.append(remainder)
                    combined_parts.append(remainder)
            emit_preview()
        selector.close()
    except OSError as exc:
        error = f"{type(exc).__name__}: {exc}"

    stdout_bytes = b"".join(stdout_parts)
    stderr_bytes = b"".join(stderr_parts)
    output_bytes = b"".join(combined_parts)
    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    output = output_bytes.decode("utf-8", errors="replace")
    finished_at = _utc_now()
    result = ExecutionResult(
        argv=argv,
        started_at=started_at,
        finished_at=finished_at,
        return_code=return_code,
        timed_out=timed_out,
        duration_seconds=round(time.monotonic() - start, 3),
        output=output,
        error=error,
        stdout=stdout,
        stderr=stderr,
        stdout_bytes=stdout_bytes,
        stderr_bytes=stderr_bytes,
    )
    history = asdict(result)
    history.pop("stdout_bytes", None)
    history.pop("stderr_bytes", None)
    history["stdout_byte_count"] = len(stdout_bytes)
    history["stderr_byte_count"] = len(stderr_bytes)
    history["stdout_sha256"] = hashlib.sha256(stdout_bytes).hexdigest()
    history["stderr_sha256"] = hashlib.sha256(stderr_bytes).hexdigest()
    append_history(history)
    return result
