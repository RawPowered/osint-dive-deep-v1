from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .paths import CASE_ARTIFACT_ROOT, CASE_DATABASE_PATH, ensure_private_directory


SCHEMA_VERSION = 2


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def json_object_text(value: dict[str, Any] | None) -> str:
    return json_text(value or {})


def normalized_text(value: str) -> str:
    return " ".join(value.strip().casefold().split())


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'research',
    objective TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_cases_updated ON cases(updated_at DESC);

CREATE TABLE IF NOT EXISTS scopes (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL,
    value TEXT NOT NULL,
    allowed INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(case_id, scope_type, value)
);

CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    subject_type TEXT NOT NULL,
    label TEXT NOT NULL,
    primary_value TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_subjects_case ON subjects(case_id, subject_type);

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unreviewed',
    confidence REAL NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(case_id, entity_type, normalized_name)
);
CREATE INDEX IF NOT EXISTS idx_entities_case ON entities(case_id, entity_type);

CREATE TABLE IF NOT EXISTS identifiers (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
    identifier_type TEXT NOT NULL,
    display_value TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(case_id, identifier_type, normalized_value)
);
CREATE INDEX IF NOT EXISTS idx_identifiers_lookup ON identifiers(case_id, identifier_type, normalized_value);

CREATE TABLE IF NOT EXISTS entity_identifiers (
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    identifier_id TEXT NOT NULL REFERENCES identifiers(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL DEFAULT 'identified-by',
    confidence REAL NOT NULL DEFAULT 0,
    PRIMARY KEY(entity_id, identifier_id, relationship)
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    run_type TEXT NOT NULL,
    adapter TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    traffic_class TEXT NOT NULL DEFAULT 'passive',
    started_at TEXT,
    completed_at TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    summary_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_runs_case ON runs(case_id, started_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    artifact_type TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    byte_size INTEGER NOT NULL,
    encoding TEXT NOT NULL DEFAULT '',
    source_uri TEXT NOT NULL DEFAULT '',
    captured_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(case_id, artifact_type, sha256)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_case ON artifacts(case_id, artifact_type);

CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
    entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    observation_type TEXT NOT NULL,
    value_json TEXT NOT NULL,
    normalized_value TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL DEFAULT '',
    source_uri TEXT NOT NULL DEFAULT '',
    collected_at TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_observations_case ON observations(case_id, observation_type, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id, observation_type);

CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
    evidence_type TEXT NOT NULL,
    value_text TEXT NOT NULL DEFAULT '',
    source_uri TEXT NOT NULL DEFAULT '',
    captured_at TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_evidence_case ON evidence(case_id, evidence_type, captured_at DESC);

CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(case_id, source_entity_id, target_entity_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    predicate TEXT NOT NULL,
    object_json TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unreviewed',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_claims_case ON claims(case_id, status, predicate);

CREATE TABLE IF NOT EXISTS claim_evidence (
    claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    direction TEXT NOT NULL DEFAULT 'supports',
    PRIMARY KEY(claim_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    claim_id TEXT REFERENCES claims(id) ON DELETE SET NULL,
    finding_type TEXT NOT NULL,
    title TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'informational',
    status TEXT NOT NULL DEFAULT 'open',
    summary TEXT NOT NULL DEFAULT '',
    recommendation TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_findings_case ON findings(case_id, status, severity);

CREATE TABLE IF NOT EXISTS entity_attributes (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    attribute_name TEXT NOT NULL,
    value_json TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    source_count INTEGER NOT NULL DEFAULT 1,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'observed',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(entity_id, attribute_name, normalized_value)
);
CREATE INDEX IF NOT EXISTS idx_entity_attributes ON entity_attributes(case_id, entity_id, attribute_name);

CREATE TABLE IF NOT EXISTS market_profiles (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(case_id, name)
);

CREATE TABLE IF NOT EXISTS market_records (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES market_profiles(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    fit_score REAL NOT NULL DEFAULT 0,
    confidence_score REAL NOT NULL DEFAULT 0,
    freshness_score REAL NOT NULL DEFAULT 0,
    reachability_score REAL NOT NULL DEFAULT 0,
    total_score REAL NOT NULL DEFAULT 0,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    review_status TEXT NOT NULL DEFAULT 'unreviewed',
    recommended_activation TEXT NOT NULL DEFAULT 'research-only',
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    source_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    last_evaluated TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    analyst_notes TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(profile_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_market_records ON market_records(case_id, profile_id, total_score DESC);

CREATE TABLE IF NOT EXISTS market_segments (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES market_profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    filter_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(case_id, profile_id, name)
);

CREATE TABLE IF NOT EXISTS market_segment_members (
    segment_id TEXT NOT NULL REFERENCES market_segments(id) ON DELETE CASCADE,
    market_record_id TEXT NOT NULL REFERENCES market_records(id) ON DELETE CASCADE,
    included_at TEXT NOT NULL,
    PRIMARY KEY(segment_id, market_record_id)
);

CREATE TABLE IF NOT EXISTS suppression_entries (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    identifier_type TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(case_id, identifier_type, normalized_value)
);

CREATE TABLE IF NOT EXISTS market_exports (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    profile_id TEXT REFERENCES market_profiles(id) ON DELETE SET NULL,
    segment_id TEXT REFERENCES market_segments(id) ON DELETE SET NULL,
    export_format TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    fields_json TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


class CaseStore:
    def __init__(self, path: str | Path = CASE_DATABASE_PATH, artifact_root: str | Path = CASE_ARTIFACT_ROOT):
        self.path = Path(path).expanduser()
        self.artifact_root = Path(artifact_root).expanduser()
        ensure_private_directory(self.path.parent)
        ensure_private_directory(self.artifact_root)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _existing_schema_version(self) -> int | None:
        if not self.path.is_file() or self.path.stat().st_size == 0:
            return None
        with closing(sqlite3.connect(self.path, timeout=30)) as connection:
            has_migrations = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
            ).fetchone()
            if has_migrations:
                row = connection.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()
                return int(row[0] if row else 0)
            return int(connection.execute("PRAGMA user_version").fetchone()[0])

    def _backup_before_schema_upgrade(self, current_version: int) -> Path:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_path = self.path.with_name(
            f"{self.path.stem}.schema-v{current_version}-backup-{stamp}-{uuid.uuid4().hex[:8]}{self.path.suffix}"
        )
        with closing(sqlite3.connect(self.path, timeout=30)) as source, closing(sqlite3.connect(backup_path)) as destination:
            source.backup(destination)
        if os.name == "posix":
            backup_path.chmod(0o600)
        return backup_path

    def _initialize(self) -> None:
        current = self._existing_schema_version()
        if current is not None and current > SCHEMA_VERSION:
            raise RuntimeError(f"Case database schema {current} is newer than supported schema {SCHEMA_VERSION}.")
        if current is not None and current < SCHEMA_VERSION:
            self._backup_before_schema_upgrade(current)
        with self.connection() as connection:
            connection.executescript(SCHEMA_SQL)
            current = int(connection.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()[0])
            connection.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)",
                (SCHEMA_VERSION, utc_now()),
            )
            connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        if os.name == "posix":
            self.path.chmod(0o600)

    def create_case(
        self,
        name: str,
        *,
        mode: str = "research",
        objective: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        case_id = new_id("case")
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO cases(id,name,mode,objective,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?)",
                (case_id, name.strip() or "Untitled case", mode, objective, now, now, json_object_text(metadata)),
            )
        return case_id

    def get_case(self, case_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        return dict(row) if row else None

    def list_cases(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM cases ORDER BY updated_at DESC LIMIT ?", (max(1, int(limit)),)
            ).fetchall()
        return [dict(row) for row in rows]

    def update_case(
        self,
        case_id: str,
        *,
        name: str | None = None,
        objective: str | None = None,
        status: str | None = None,
    ) -> None:
        assignments = ["updated_at=?"]
        values: list[Any] = [utc_now()]
        if name is not None:
            assignments.append("name=?")
            values.append(name.strip() or "Untitled case")
        if objective is not None:
            assignments.append("objective=?")
            values.append(objective.strip())
        if status is not None:
            assignments.append("status=?")
            values.append(status.strip() or "active")
        values.append(case_id)
        with self.connection() as connection:
            result = connection.execute(f"UPDATE cases SET {', '.join(assignments)} WHERE id=?", values)
            if result.rowcount != 1:
                raise ValueError(f"Unknown case: {case_id}")

    def list_entities(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM entities WHERE case_id=? ORDER BY last_seen DESC LIMIT ?",
                (case_id, max(1, int(limit))),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_subjects(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM subjects WHERE case_id=? ORDER BY updated_at DESC LIMIT ?",
                (case_id, max(1, int(limit))),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_observations(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM observations WHERE case_id=? ORDER BY collected_at DESC LIMIT ?",
                (case_id, max(1, int(limit))),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_runs(self, case_id: str, limit: int = 100) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM runs WHERE case_id=? ORDER BY started_at DESC LIMIT ?",
                (case_id, max(1, int(limit))),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_runs_for_ids(self, run_ids: list[str]) -> list[dict[str, Any]]:
        identifiers = [str(value) for value in run_ids if str(value)]
        if not identifiers:
            return []
        placeholders = ",".join("?" for _ in identifiers)
        with self.connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM runs WHERE id IN ({placeholders})",
                identifiers,
            ).fetchall()
        return [dict(row) for row in rows]

    def list_entity_identifiers(self, case_id: str, entity_id: str | None = None) -> list[dict[str, Any]]:
        sql = """
            SELECT i.*, ei.entity_id, ei.relationship
            FROM identifiers i
            JOIN entity_identifiers ei ON ei.identifier_id=i.id
            WHERE i.case_id=?
        """
        params: list[Any] = [case_id]
        if entity_id:
            sql += " AND ei.entity_id=?"
            params.append(entity_id)
        sql += " ORDER BY i.identifier_type, i.normalized_value"
        with self.connection() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def list_identifiers(self, case_id: str, limit: int = 1000) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM identifiers WHERE case_id=? ORDER BY last_seen DESC LIMIT ?",
                (case_id, max(1, int(limit))),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_evidence(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM evidence WHERE case_id=? ORDER BY captured_at DESC LIMIT ?",
                (case_id, max(1, int(limit))),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_claims(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM claims WHERE case_id=? ORDER BY last_seen DESC LIMIT ?",
                (case_id, max(1, int(limit))),
            ).fetchall()
        return [dict(row) for row in rows]

    def upsert_entity_attribute(
        self,
        case_id: str,
        entity_id: str,
        attribute_name: str,
        value: Any,
        *,
        normalized_value: str = "",
        confidence: float = 0,
        source_ref: str = "",
        expires_at: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        normalized = normalized_value or normalized_text(str(value))
        now = utc_now()
        with self.connection() as connection:
            row = connection.execute(
                "SELECT id,confidence,metadata_json FROM entity_attributes WHERE entity_id=? AND attribute_name=? AND normalized_value=?",
                (entity_id, attribute_name, normalized),
            ).fetchone()
            sources: set[str] = set()
            merged_metadata = dict(metadata or {})
            if row:
                try:
                    existing_metadata = json.loads(str(row["metadata_json"] or "{}"))
                    sources.update(str(item) for item in existing_metadata.get("sources", []) if str(item))
                    existing_metadata.update(merged_metadata)
                    merged_metadata = existing_metadata
                except (TypeError, ValueError):
                    pass
            if source_ref:
                sources.add(source_ref)
            merged_metadata["sources"] = sorted(sources)
            if row:
                attribute_id = str(row["id"])
                connection.execute(
                    "UPDATE entity_attributes SET value_json=?,confidence=?,source_count=?,last_seen=?,expires_at=?,metadata_json=? WHERE id=?",
                    (json_text(value), max(float(row["confidence"]), float(confidence)), max(1, len(sources)), now, expires_at, json_object_text(merged_metadata), attribute_id),
                )
            else:
                attribute_id = new_id("attribute")
                connection.execute(
                    "INSERT INTO entity_attributes(id,case_id,entity_id,attribute_name,value_json,normalized_value,confidence,source_count,first_seen,last_seen,expires_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (attribute_id, case_id, entity_id, attribute_name, json_text(value), normalized, confidence, max(1, len(sources)), now, now, expires_at, json_object_text(merged_metadata)),
                )
        return attribute_id

    def list_entity_attributes(self, case_id: str, entity_id: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM entity_attributes WHERE case_id=?"
        params: list[Any] = [case_id]
        if entity_id:
            sql += " AND entity_id=?"
            params.append(entity_id)
        sql += " ORDER BY entity_id,attribute_name,normalized_value"
        with self.connection() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def add_scope(self, case_id: str, scope_type: str, value: str, *, allowed: bool = True, notes: str = "") -> str:
        scope_id = new_id("scope")
        with self.connection() as connection:
            existing = connection.execute(
                "SELECT id FROM scopes WHERE case_id=? AND scope_type=? AND value=?",
                (case_id, scope_type, value),
            ).fetchone()
            if existing:
                return str(existing["id"])
            connection.execute(
                "INSERT INTO scopes(id,case_id,scope_type,value,allowed,notes,created_at) VALUES(?,?,?,?,?,?,?)",
                (scope_id, case_id, scope_type, value, int(allowed), notes, utc_now()),
            )
        return scope_id

    def list_scopes(self, case_id: str, *, scope_type: str = "") -> list[dict[str, Any]]:
        sql = "SELECT * FROM scopes WHERE case_id=?"
        params: list[Any] = [case_id]
        if scope_type:
            sql += " AND scope_type=?"
            params.append(scope_type)
        sql += " ORDER BY created_at, value"
        with self.connection() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def add_subject(
        self,
        case_id: str,
        subject_type: str,
        label: str,
        *,
        primary_value: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        now = utc_now()
        with self.connection() as connection:
            existing = connection.execute(
                "SELECT id FROM subjects WHERE case_id=? AND subject_type=? AND primary_value=? LIMIT 1",
                (case_id, subject_type, primary_value),
            ).fetchone()
            if existing:
                connection.execute(
                    "UPDATE subjects SET label=?,updated_at=? WHERE id=?",
                    (label, now, existing["id"]),
                )
                return str(existing["id"])
            subject_id = new_id("subject")
            connection.execute(
                "INSERT INTO subjects(id,case_id,subject_type,label,primary_value,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?)",
                (subject_id, case_id, subject_type, label, primary_value, now, now, json_object_text(metadata)),
            )
        return subject_id

    def upsert_entity(
        self,
        case_id: str,
        entity_type: str,
        canonical_name: str,
        *,
        confidence: float = 0,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        normalized = normalized_text(canonical_name)
        now = utc_now()
        with self.connection() as connection:
            entity_id = new_id("entity")
            connection.execute(
                """
                INSERT INTO entities(id,case_id,entity_type,canonical_name,normalized_name,confidence,first_seen,last_seen,metadata_json)
                VALUES(?,?,?,?,?,?,?,?,?)
                ON CONFLICT(case_id,entity_type,normalized_name) DO UPDATE SET
                    canonical_name=excluded.canonical_name,
                    confidence=MAX(entities.confidence, excluded.confidence),
                    last_seen=excluded.last_seen
                """,
                (entity_id, case_id, entity_type, canonical_name, normalized, confidence, now, now, json_object_text(metadata)),
            )
            row = connection.execute(
                "SELECT id FROM entities WHERE case_id=? AND entity_type=? AND normalized_name=?",
                (case_id, entity_type, normalized),
            ).fetchone()
            assert row is not None
            entity_id = str(row["id"])
        return entity_id

    def add_identifier(
        self,
        case_id: str,
        identifier_type: str,
        value: str,
        *,
        subject_id: str | None = None,
        entity_id: str | None = None,
        confidence: float = 0,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        normalized = normalized_text(value)
        now = utc_now()
        with self.connection() as connection:
            identifier_id = new_id("identifier")
            connection.execute(
                """
                INSERT INTO identifiers(id,case_id,subject_id,identifier_type,display_value,normalized_value,confidence,first_seen,last_seen,metadata_json)
                VALUES(?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(case_id,identifier_type,normalized_value) DO UPDATE SET
                    display_value=excluded.display_value,
                    confidence=MAX(identifiers.confidence, excluded.confidence),
                    last_seen=excluded.last_seen,
                    subject_id=COALESCE(identifiers.subject_id, excluded.subject_id)
                """,
                (identifier_id, case_id, subject_id, identifier_type, value, normalized, confidence, now, now, json_object_text(metadata)),
            )
            row = connection.execute(
                "SELECT id FROM identifiers WHERE case_id=? AND identifier_type=? AND normalized_value=?",
                (case_id, identifier_type, normalized),
            ).fetchone()
            assert row is not None
            identifier_id = str(row["id"])
            if entity_id:
                connection.execute(
                    "INSERT OR IGNORE INTO entity_identifiers(entity_id,identifier_id,confidence) VALUES(?,?,?)",
                    (entity_id, identifier_id, confidence),
                )
        return identifier_id

    def create_run(
        self,
        case_id: str,
        run_type: str,
        *,
        adapter: str = "",
        traffic_class: str = "passive",
        config: dict[str, Any] | None = None,
    ) -> str:
        run_id = new_id("run")
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO runs(id,case_id,run_type,adapter,status,traffic_class,started_at,config_json) VALUES(?,?,?,?,?,?,?,?)",
                (run_id, case_id, run_type, adapter, "running", traffic_class, utc_now(), json_object_text(config)),
            )
        return run_id

    def complete_run(self, run_id: str, *, summary: dict[str, Any] | None = None, error: str = "") -> None:
        with self.connection() as connection:
            connection.execute(
                "UPDATE runs SET status=?,completed_at=?,summary_json=?,error=? WHERE id=?",
                ("failed" if error else "complete", utc_now(), json_object_text(summary), error, run_id),
            )

    @staticmethod
    def _safe_suffix(value: str) -> str:
        suffix = re.sub(r"[^A-Za-z0-9.]+", "", value.lower())[:16]
        return suffix if suffix.startswith(".") else (f".{suffix}" if suffix else "")

    def _artifact_destination(self, digest: str, suffix: str = "") -> tuple[Path, str]:
        relative = Path(digest[:2]) / f"{digest}{self._safe_suffix(suffix)}"
        destination = ensure_private_directory(self.artifact_root / relative.parent) / relative.name
        return destination, relative.as_posix()

    def record_artifact_path(
        self,
        case_id: str,
        source_path: str | Path,
        artifact_type: str,
        *,
        run_id: str | None = None,
        media_type: str = "application/octet-stream",
        encoding: str = "",
        source_uri: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        source = Path(source_path)
        digest_builder = hashlib.sha256()
        with source.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest_builder.update(chunk)
        digest = digest_builder.hexdigest()
        destination, relative = self._artifact_destination(digest, source.suffix)
        if not destination.exists():
            temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
            shutil.copyfile(source, temporary)
            os.replace(temporary, destination)
            if os.name == "posix":
                destination.chmod(0o600)
        return self._register_artifact(
            case_id,
            artifact_type,
            relative,
            digest,
            source.stat().st_size,
            run_id=run_id,
            media_type=media_type,
            encoding=encoding,
            source_uri=source_uri,
            metadata=metadata,
        )

    def record_artifact_bytes(
        self,
        case_id: str,
        content: bytes,
        artifact_type: str,
        *,
        run_id: str | None = None,
        media_type: str = "application/octet-stream",
        encoding: str = "",
        source_uri: str = "",
        suffix: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        digest = hashlib.sha256(content).hexdigest()
        destination, relative = self._artifact_destination(digest, suffix)
        if not destination.exists():
            temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
            temporary.write_bytes(content)
            os.replace(temporary, destination)
            if os.name == "posix":
                destination.chmod(0o600)
        return self._register_artifact(
            case_id,
            artifact_type,
            relative,
            digest,
            len(content),
            run_id=run_id,
            media_type=media_type,
            encoding=encoding,
            source_uri=source_uri,
            metadata=metadata,
        )

    def _register_artifact(
        self,
        case_id: str,
        artifact_type: str,
        storage_path: str,
        digest: str,
        byte_size: int,
        *,
        run_id: str | None,
        media_type: str,
        encoding: str,
        source_uri: str,
        metadata: dict[str, Any] | None,
    ) -> str:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT id FROM artifacts WHERE case_id=? AND artifact_type=? AND sha256=?",
                (case_id, artifact_type, digest),
            ).fetchone()
            if row:
                return str(row["id"])
            artifact_id = new_id("artifact")
            connection.execute(
                "INSERT INTO artifacts(id,case_id,run_id,artifact_type,storage_path,sha256,media_type,byte_size,encoding,source_uri,captured_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (artifact_id, case_id, run_id, artifact_type, storage_path, digest, media_type, byte_size, encoding, source_uri, utc_now(), json_object_text(metadata)),
            )
        return artifact_id

    def record_observation(
        self,
        case_id: str,
        observation_type: str,
        value: Any,
        *,
        run_id: str | None = None,
        subject_id: str | None = None,
        entity_id: str | None = None,
        normalized_value: str = "",
        source_name: str = "",
        source_uri: str = "",
        confidence: float = 0,
        artifact_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        observation_id = new_id("observation")
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO observations(id,case_id,run_id,subject_id,entity_id,observation_type,value_json,normalized_value,source_name,source_uri,collected_at,confidence,artifact_id,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (observation_id, case_id, run_id, subject_id, entity_id, observation_type, json_text(value), normalized_value, source_name, source_uri, utc_now(), confidence, artifact_id, json_object_text(metadata)),
            )
        return observation_id

    def add_evidence(
        self,
        case_id: str,
        evidence_type: str,
        value: str,
        *,
        observation_id: str | None = None,
        artifact_id: str | None = None,
        source_uri: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        evidence_id = new_id("evidence")
        digest = hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).hexdigest()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO evidence(id,case_id,observation_id,artifact_id,evidence_type,value_text,source_uri,captured_at,sha256,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (evidence_id, case_id, observation_id, artifact_id, evidence_type, value, source_uri, utc_now(), digest, json_object_text(metadata)),
            )
        return evidence_id

    def get_artifact(self, artifact_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        return dict(row) if row else None

    def artifact_path(self, artifact_id: str) -> Path:
        record = self.get_artifact(artifact_id)
        if not record:
            raise KeyError(f"Unknown artifact: {artifact_id}")
        root = self.artifact_root.resolve()
        path = (root / str(record["storage_path"])).resolve()
        if path != root and root not in path.parents:
            raise ValueError("Artifact path escaped the local artifact root.")
        return path

    def upsert_relationship(
        self,
        case_id: str,
        source_entity_id: str,
        target_entity_id: str,
        relationship_type: str,
        *,
        confidence: float = 0,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        now = utc_now()
        with self.connection() as connection:
            row = connection.execute(
                "SELECT id,confidence FROM relationships WHERE case_id=? AND source_entity_id=? AND target_entity_id=? AND relationship_type=?",
                (case_id, source_entity_id, target_entity_id, relationship_type),
            ).fetchone()
            if row:
                connection.execute(
                    "UPDATE relationships SET confidence=?,last_seen=? WHERE id=?",
                    (max(float(row["confidence"]), float(confidence)), now, row["id"]),
                )
                return str(row["id"])
            relationship_id = new_id("relationship")
            connection.execute(
                "INSERT INTO relationships(id,case_id,source_entity_id,target_entity_id,relationship_type,confidence,first_seen,last_seen,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)",
                (relationship_id, case_id, source_entity_id, target_entity_id, relationship_type, confidence, now, now, json_object_text(metadata)),
            )
        return relationship_id

    def add_claim(
        self,
        case_id: str,
        predicate: str,
        value: Any,
        *,
        entity_id: str | None = None,
        confidence: float = 0,
        status: str = "unreviewed",
        evidence_ids: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        claim_id = new_id("claim")
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO claims(id,case_id,entity_id,predicate,object_json,confidence,status,first_seen,last_seen,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (claim_id, case_id, entity_id, predicate, json_text(value), confidence, status, now, now, json_object_text(metadata)),
            )
            connection.executemany(
                "INSERT INTO claim_evidence(claim_id,evidence_id) VALUES(?,?)",
                [(claim_id, evidence_id) for evidence_id in (evidence_ids or [])],
            )
        return claim_id

    def add_finding(
        self,
        case_id: str,
        finding_type: str,
        title: str,
        *,
        claim_id: str | None = None,
        severity: str = "informational",
        summary: str = "",
        recommendation: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        finding_id = new_id("finding")
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO findings(id,case_id,claim_id,finding_type,title,severity,summary,recommendation,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (finding_id, case_id, claim_id, finding_type, title, severity, summary, recommendation, now, now, json_object_text(metadata)),
            )
        return finding_id

    def list_findings(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT f.*, c.predicate AS claim_predicate, c.object_json AS claim_object_json,
                       c.confidence AS claim_confidence
                FROM findings f
                LEFT JOIN claims c ON c.id=f.claim_id
                WHERE f.case_id=?
                ORDER BY
                    CASE f.severity
                        WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                        WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4
                    END,
                    f.created_at DESC
                LIMIT ?
                """,
                (case_id, max(1, int(limit))),
            ).fetchall()
        return [dict(row) for row in rows]

    def case_stats(self, case_id: str) -> dict[str, int]:
        tables = ("subjects", "entities", "identifiers", "runs", "artifacts", "observations", "evidence", "relationships", "claims", "findings")
        output: dict[str, int] = {}
        with self.connection() as connection:
            for table in tables:
                output[table] = int(connection.execute(f"SELECT COUNT(*) FROM {table} WHERE case_id=?", (case_id,)).fetchone()[0])
        return output

    def _sqlite_snapshot(self, source: Path) -> Path:
        temporary_dir = Path(tempfile.mkdtemp(prefix="osint-studio-import-"))
        snapshot = temporary_dir / source.name
        source_connection = sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True)
        destination_connection = sqlite3.connect(snapshot)
        try:
            source_connection.backup(destination_connection)
        finally:
            destination_connection.close()
            source_connection.close()
        return snapshot

    def import_discovery_job(
        self,
        source_path: str | Path,
        *,
        case_id: str | None = None,
        case_name: str | None = None,
    ) -> dict[str, Any]:
        source = Path(source_path).expanduser().resolve()
        if not source.is_file():
            raise FileNotFoundError(source)
        if case_id is None:
            case_id = self.create_case(case_name or source.stem, objective="Imported v5 discovery job")
        elif not self.get_case(case_id):
            raise ValueError(f"Unknown case: {case_id}")
        run_id = self.create_run(case_id, "legacy-discovery-import", adapter="v5-job-store", config={"source": str(source)})
        snapshot = self._sqlite_snapshot(source)
        try:
            artifact_id = self.record_artifact_path(
                case_id,
                snapshot,
                "legacy-discovery-sqlite",
                run_id=run_id,
                media_type="application/vnd.sqlite3",
                source_uri=str(source),
            )
            with self.connection() as existing_connection:
                existing_observations = int(
                    existing_connection.execute(
                        "SELECT COUNT(*) FROM observations WHERE case_id=? AND artifact_id=? AND observation_type='discovered-url'",
                        (case_id, artifact_id),
                    ).fetchone()[0]
                )
            if existing_observations:
                summary = {"candidates": existing_observations, "imported_candidates": 0, "query_runs": 0, "events": 0, "artifact_id": artifact_id, "already_imported": True}
                self.complete_run(run_id, summary=summary)
                return {"case_id": case_id, "run_id": run_id, **summary}
            connection = sqlite3.connect(snapshot)
            connection.row_factory = sqlite3.Row
            try:
                table_names = {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if "candidates" not in table_names:
                    raise ValueError("The selected SQLite file is not a v5 discovery job.")
                candidate_rows = connection.execute("SELECT * FROM candidates ORDER BY canonical_url").fetchall()
                query_count = connection.execute("SELECT COUNT(*) FROM query_runs").fetchone()[0] if "query_runs" in table_names else 0
                event_count = connection.execute("SELECT COUNT(*) FROM events").fetchone()[0] if "events" in table_names else 0
            finally:
                connection.close()

            imported_candidates = 0
            for row in candidate_rows:
                values = dict(row)
                domain = str(values.get("domain") or "")
                url = str(values.get("url") or values.get("canonical_url") or "")
                canonical = str(values.get("canonical_url") or url)
                serialized = json_text(values)
                with self.connection() as existing_connection:
                    existing = existing_connection.execute(
                        "SELECT id FROM observations WHERE case_id=? AND observation_type='discovered-url' AND normalized_value=? AND value_json=? LIMIT 1",
                        (case_id, canonical, serialized),
                    ).fetchone()
                if existing:
                    continue
                entity_id = self.upsert_entity(case_id, "domain", domain, confidence=0.5) if domain else None
                if entity_id and domain:
                    self.add_identifier(case_id, "domain", domain, entity_id=entity_id, confidence=0.5)
                if entity_id and url:
                    self.add_identifier(case_id, "url", url, entity_id=entity_id, confidence=0.5)
                observation_id = self.record_observation(
                    case_id,
                    "discovered-url",
                    values,
                    run_id=run_id,
                    entity_id=entity_id,
                    normalized_value=canonical,
                    source_name=str(values.get("providers_json") or values.get("first_provider") or "v5-discovery"),
                    source_uri=url,
                    confidence=0.5,
                    artifact_id=artifact_id,
                    metadata={"legacy_table": "candidates"},
                )
                self.add_evidence(
                    case_id,
                    "legacy-discovery-record",
                    serialized,
                    observation_id=observation_id,
                    artifact_id=artifact_id,
                    source_uri=url,
                )
                imported_candidates += 1
            summary = {"candidates": len(candidate_rows), "imported_candidates": imported_candidates, "query_runs": int(query_count), "events": int(event_count), "artifact_id": artifact_id}
            self.complete_run(run_id, summary=summary)
            return {"case_id": case_id, "run_id": run_id, **summary}
        except Exception as exc:
            self.complete_run(run_id, error=f"{type(exc).__name__}: {exc}")
            raise
        finally:
            shutil.rmtree(snapshot.parent, ignore_errors=True)

    def import_hunt_template(self, case_id: str, source_path: str | Path) -> dict[str, Any]:
        from .hunt_profiles import load_profile_json, profile_summary

        source = Path(source_path).expanduser().resolve()
        raw = source.read_bytes()
        profile, warnings = load_profile_json(raw)
        run_id = self.create_run(case_id, "hunt-template-import", adapter="v5-template-loader", config={"source": str(source)})
        try:
            artifact_id = self.record_artifact_bytes(
                case_id,
                raw,
                "hunt-template-json",
                run_id=run_id,
                media_type="application/json",
                encoding="utf-8",
                source_uri=str(source),
                suffix=".json",
                metadata={"warnings": warnings},
            )
            summary = profile_summary(profile)
            observation_id = self.record_observation(
                case_id,
                "hunt-template",
                profile,
                run_id=run_id,
                normalized_value=str(profile.get("template_id") or profile.get("name") or ""),
                source_name="v5-template-loader",
                source_uri=str(source),
                confidence=1.0,
                artifact_id=artifact_id,
                metadata={"warnings": warnings},
            )
            self.add_evidence(
                case_id,
                "hunt-template-source",
                raw.decode("utf-8"),
                observation_id=observation_id,
                artifact_id=artifact_id,
                source_uri=str(source),
            )
            self.complete_run(run_id, summary=summary)
            return {"case_id": case_id, "run_id": run_id, "artifact_id": artifact_id, "summary": summary, "warnings": warnings}
        except Exception as exc:
            self.complete_run(run_id, error=f"{type(exc).__name__}: {exc}")
            raise
