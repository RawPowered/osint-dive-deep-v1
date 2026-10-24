from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .paths import DATA_ROOT, ensure_private_directory


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_queue_path() -> Path:
    configured = os.environ.get("DIVEDEEP_API_DB", "").strip()
    return Path(configured).expanduser() if configured else DATA_ROOT / "server-jobs.sqlite"


class ServerQueue:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path).expanduser().resolve() if path else default_queue_path().expanduser().resolve()
        ensure_private_directory(self.path.parent)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS server_jobs (
                    id TEXT PRIMARY KEY,
                    action TEXT NOT NULL,
                    workspace TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress_current INTEGER NOT NULL DEFAULT 0,
                    progress_total INTEGER NOT NULL DEFAULT 0,
                    result_json TEXT,
                    error TEXT,
                    worker_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    heartbeat_at TEXT,
                    completed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_server_jobs_status_created
                    ON server_jobs(status, created_at);

                CREATE TABLE IF NOT EXISTS server_job_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL REFERENCES server_jobs(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    level TEXT NOT NULL,
                    message TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_server_job_events_job
                    ON server_job_events(job_id, id);
                """
            )
        if os.name == "posix":
            self.path.chmod(0o600)

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        item = dict(row)
        for key in ("payload_json", "result_json"):
            raw = item.pop(key, None)
            public_key = "payload" if key == "payload_json" else "result"
            try:
                item[public_key] = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                item[public_key] = None
        return item

    def enqueue(self, action: str, workspace: str | Path, payload: dict[str, Any]) -> dict[str, Any]:
        job_id = str(uuid.uuid4())
        now = utc_now()
        total = len(payload.get("indices", []) or []) if action == "run_jobs" else 1
        with closing(self._connect()) as connection:
            connection.execute(
                """
                INSERT INTO server_jobs (
                    id, action, workspace, payload_json, status,
                    progress_current, progress_total, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
                """,
                (job_id, action, str(Path(workspace).expanduser().resolve()), json.dumps(payload, sort_keys=True), total, now, now),
            )
            connection.execute(
                "INSERT INTO server_job_events (job_id, created_at, level, message) VALUES (?, ?, 'info', ?)",
                (job_id, now, f"Queued {action}."),
            )
        return self.get(job_id) or {"id": job_id, "status": "queued"}

    def get(self, job_id: str, *, include_events: bool = True) -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            item = self._row(connection.execute("SELECT * FROM server_jobs WHERE id = ?", (job_id,)).fetchone())
            if item is None:
                return None
            if include_events:
                item["events"] = [dict(row) for row in connection.execute(
                    "SELECT created_at, level, message FROM server_job_events WHERE job_id = ? ORDER BY id",
                    (job_id,),
                ).fetchall()]
            return item

    def list(self, *, limit: int = 100, status: str | None = None) -> list[dict[str, Any]]:
        bounded = max(1, min(int(limit), 500))
        with closing(self._connect()) as connection:
            if status:
                rows = connection.execute(
                    "SELECT * FROM server_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?",
                    (status, bounded),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM server_jobs ORDER BY created_at DESC LIMIT ?",
                    (bounded,),
                ).fetchall()
        return [self._row(row) or {} for row in rows]

    def claim_next(self, worker_id: str) -> dict[str, Any] | None:
        now = utc_now()
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM server_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row is None:
                connection.execute("COMMIT")
                return None
            connection.execute(
                """
                UPDATE server_jobs
                SET status = 'running', worker_id = ?, started_at = COALESCE(started_at, ?),
                    heartbeat_at = ?, updated_at = ?
                WHERE id = ? AND status = 'queued'
                """,
                (worker_id, now, now, now, row["id"]),
            )
            changed = connection.execute("SELECT changes()").fetchone()[0]
            if changed != 1:
                connection.execute("ROLLBACK")
                return None
            connection.execute(
                "INSERT INTO server_job_events (job_id, created_at, level, message) VALUES (?, ?, 'info', ?)",
                (row["id"], now, f"Claimed by worker {worker_id}."),
            )
            connection.execute("COMMIT")
            return self.get(str(row["id"]), include_events=False)
        except Exception:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            connection.close()

    def event(self, job_id: str, message: str, level: str = "info") -> None:
        now = utc_now()
        with closing(self._connect()) as connection:
            connection.execute(
                "INSERT INTO server_job_events (job_id, created_at, level, message) VALUES (?, ?, ?, ?)",
                (job_id, now, level[:16], message[:4000]),
            )
            connection.execute(
                "UPDATE server_jobs SET heartbeat_at = ?, updated_at = ? WHERE id = ?",
                (now, now, job_id),
            )

    def progress(self, job_id: str, current: int, total: int, message: str | None = None) -> None:
        now = utc_now()
        with closing(self._connect()) as connection:
            connection.execute(
                """
                UPDATE server_jobs
                SET progress_current = ?, progress_total = ?, heartbeat_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (max(0, int(current)), max(0, int(total)), now, now, job_id),
            )
            if message:
                connection.execute(
                    "INSERT INTO server_job_events (job_id, created_at, level, message) VALUES (?, ?, 'info', ?)",
                    (job_id, now, message[:4000]),
                )

    def complete(self, job_id: str, result: dict[str, Any]) -> None:
        now = utc_now()
        with closing(self._connect()) as connection:
            connection.execute(
                """
                UPDATE server_jobs
                SET status = 'completed', result_json = ?, error = NULL,
                    progress_current = progress_total, heartbeat_at = ?, updated_at = ?, completed_at = ?
                WHERE id = ?
                """,
                (json.dumps(result, sort_keys=True), now, now, now, job_id),
            )
            connection.execute(
                "INSERT INTO server_job_events (job_id, created_at, level, message) VALUES (?, ?, 'info', 'Job completed.')",
                (job_id, now),
            )

    def fail(self, job_id: str, error: str) -> None:
        now = utc_now()
        with closing(self._connect()) as connection:
            connection.execute(
                """
                UPDATE server_jobs
                SET status = 'failed', error = ?, heartbeat_at = ?, updated_at = ?, completed_at = ?
                WHERE id = ?
                """,
                (error[:16000], now, now, now, job_id),
            )
            connection.execute(
                "INSERT INTO server_job_events (job_id, created_at, level, message) VALUES (?, ?, 'error', ?)",
                (job_id, now, error[:4000]),
            )

    def cancel(self, job_id: str) -> bool:
        now = utc_now()
        with closing(self._connect()) as connection:
            connection.execute(
                "UPDATE server_jobs SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ? AND status = 'queued'",
                (now, now, job_id),
            )
            changed = connection.execute("SELECT changes()").fetchone()[0]
            if changed:
                connection.execute(
                    "INSERT INTO server_job_events (job_id, created_at, level, message) VALUES (?, ?, 'warning', 'Queued job cancelled.')",
                    (job_id, now),
                )
        return bool(changed)


    def stats(self) -> dict[str, int]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT status, COUNT(*) AS count FROM server_jobs GROUP BY status"
            ).fetchall()
        values = {str(row["status"]): int(row["count"]) for row in rows}
        return {
            "queued": values.get("queued", 0),
            "running": values.get("running", 0),
            "completed": values.get("completed", 0),
            "failed": values.get("failed", 0),
            "cancelled": values.get("cancelled", 0),
            "outstanding": values.get("queued", 0) + values.get("running", 0),
            "total": sum(values.values()),
        }

    def requeue_running(self, reason: str = "Requeued during maintenance.") -> int:
        now = utc_now()
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT id FROM server_jobs WHERE status = 'running'"
            ).fetchall()
            for row in rows:
                connection.execute(
                    """
                    UPDATE server_jobs
                    SET status = 'queued', worker_id = NULL, started_at = NULL,
                        heartbeat_at = NULL, updated_at = ?, error = NULL
                    WHERE id = ?
                    """,
                    (now, row["id"]),
                )
                connection.execute(
                    "INSERT INTO server_job_events (job_id, created_at, level, message) VALUES (?, ?, 'warning', ?)",
                    (row["id"], now, reason[:4000]),
                )
        return len(rows)

    def recover_stale(self, stale_seconds: int = 3600) -> int:
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=max(300, int(stale_seconds)))).isoformat()
        now = utc_now()
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT id FROM server_jobs WHERE status = 'running' AND COALESCE(heartbeat_at, started_at, updated_at) < ?",
                (cutoff,),
            ).fetchall()
            for row in rows:
                connection.execute(
                    """
                    UPDATE server_jobs SET status = 'queued', worker_id = NULL, started_at = NULL,
                        heartbeat_at = NULL, updated_at = ?, error = NULL WHERE id = ?
                    """,
                    (now, row["id"]),
                )
                connection.execute(
                    "INSERT INTO server_job_events (job_id, created_at, level, message) VALUES (?, ?, 'warning', 'Recovered stale running job.')",
                    (row["id"], now),
                )
        return len(rows)
