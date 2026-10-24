from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .paths import PRIVACY_DATABASE_PATH, ensure_private_directory


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class PrivacyStore:
    def __init__(self, path: str | Path = PRIVACY_DATABASE_PATH):
        self.path = Path(path)
        ensure_private_directory(self.path.parent)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS privacy_cases (
                    privacy_case_id TEXT PRIMARY KEY,
                    case_name TEXT NOT NULL,
                    subject_name TEXT NOT NULL,
                    subject_email TEXT NOT NULL DEFAULT '',
                    aliases_json TEXT NOT NULL DEFAULT '[]',
                    jurisdiction_country TEXT NOT NULL DEFAULT '',
                    jurisdiction_region TEXT NOT NULL DEFAULT '',
                    requester_role TEXT NOT NULL,
                    requester_name TEXT NOT NULL,
                    requester_email TEXT NOT NULL,
                    authorization_affirmed INTEGER NOT NULL CHECK (authorization_affirmed IN (0, 1)),
                    authorization_date TEXT NOT NULL,
                    verification_channel TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS privacy_findings (
                    finding_id TEXT PRIMARY KEY,
                    privacy_case_id TEXT NOT NULL REFERENCES privacy_cases(privacy_case_id) ON DELETE CASCADE,
                    company_name TEXT NOT NULL,
                    domain TEXT NOT NULL DEFAULT '',
                    industry_category TEXT NOT NULL,
                    listing_url TEXT NOT NULL,
                    listing_identifier TEXT NOT NULL DEFAULT '',
                    subject_identifier TEXT NOT NULL DEFAULT '',
                    recipient_email TEXT NOT NULL DEFAULT '',
                    privacy_form_url TEXT NOT NULL DEFAULT '',
                    contact_status TEXT NOT NULL DEFAULT 'unverified',
                    content_category TEXT NOT NULL DEFAULT 'standard',
                    discovered_at TEXT NOT NULL,
                    notes TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'open',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS privacy_requests (
                    request_id TEXT PRIMARY KEY,
                    privacy_case_id TEXT NOT NULL REFERENCES privacy_cases(privacy_case_id) ON DELETE CASCADE,
                    finding_id TEXT NOT NULL REFERENCES privacy_findings(finding_id) ON DELETE CASCADE,
                    template_key TEXT NOT NULL,
                    request_types_json TEXT NOT NULL DEFAULT '[]',
                    jurisdiction_basis TEXT NOT NULL DEFAULT '',
                    recipient_email TEXT NOT NULL DEFAULT '',
                    delivery_method TEXT NOT NULL DEFAULT 'email',
                    email_subject TEXT NOT NULL,
                    email_body TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'draft',
                    response_due_date TEXT,
                    sent_at TEXT,
                    confirmation_reference TEXT NOT NULL DEFAULT '',
                    notes TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS privacy_events (
                    event_id TEXT PRIMARY KEY,
                    privacy_case_id TEXT NOT NULL REFERENCES privacy_cases(privacy_case_id) ON DELETE CASCADE,
                    finding_id TEXT,
                    request_id TEXT,
                    event_type TEXT NOT NULL,
                    details_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS privacy_verifications (
                    verification_id TEXT PRIMARY KEY,
                    privacy_case_id TEXT NOT NULL REFERENCES privacy_cases(privacy_case_id) ON DELETE CASCADE,
                    finding_id TEXT NOT NULL REFERENCES privacy_findings(finding_id) ON DELETE CASCADE,
                    request_id TEXT,
                    result TEXT NOT NULL,
                    source_url TEXT NOT NULL DEFAULT '',
                    notes TEXT NOT NULL DEFAULT '',
                    checked_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS privacy_findings_case_idx ON privacy_findings(privacy_case_id);
                CREATE INDEX IF NOT EXISTS privacy_requests_case_idx ON privacy_requests(privacy_case_id);
                CREATE INDEX IF NOT EXISTS privacy_events_case_idx ON privacy_events(privacy_case_id, created_at);
                CREATE INDEX IF NOT EXISTS privacy_verifications_case_idx ON privacy_verifications(privacy_case_id, checked_at);
                """
            )
            columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(privacy_cases)").fetchall()}
            if "studio_case_id" not in columns:
                connection.execute("ALTER TABLE privacy_cases ADD COLUMN studio_case_id TEXT NOT NULL DEFAULT ''")
        if os.name == "posix":
            self.path.chmod(0o600)

    @staticmethod
    def _rows(cursor: sqlite3.Cursor) -> list[dict[str, Any]]:
        return [dict(row) for row in cursor.fetchall()]

    def add_event(
        self,
        case_id: str,
        event_type: str,
        details: dict[str, Any] | None = None,
        *,
        finding_id: str | None = None,
        request_id: str | None = None,
    ) -> str:
        event_id = new_id("event")
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO privacy_events VALUES (?, ?, ?, ?, ?, ?, ?)",
                (event_id, case_id, finding_id, request_id, event_type, _json(details or {}), utc_now()),
            )
        return event_id

    def create_case(self, values: dict[str, Any]) -> str:
        if not values.get("authorization_affirmed"):
            raise ValueError("Authorization must be affirmed before a privacy case can be created.")
        case_id = new_id("privacy")
        now = utc_now()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO privacy_cases (
                    privacy_case_id, case_name, subject_name, subject_email, aliases_json,
                    jurisdiction_country, jurisdiction_region, requester_role, requester_name,
                    requester_email, authorization_affirmed, authorization_date,
                    verification_channel, status, created_at, updated_at, studio_case_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', ?, ?, ?)
                """,
                (
                    case_id,
                    str(values["case_name"]).strip(),
                    str(values["subject_name"]).strip(),
                    str(values.get("subject_email", "")).strip(),
                    _json(values.get("aliases", [])),
                    str(values.get("jurisdiction_country", "")).strip(),
                    str(values.get("jurisdiction_region", "")).strip(),
                    str(values["requester_role"]).strip(),
                    str(values["requester_name"]).strip(),
                    str(values["requester_email"]).strip(),
                    str(values["authorization_date"]).strip(),
                    str(values.get("verification_channel", "")).strip(),
                    now,
                    now,
                    str(values.get("studio_case_id", "")).strip(),
                ),
            )
        self.add_event(case_id, "case.created", {"requester_role": values["requester_role"]})
        return case_id

    def list_cases(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            return self._rows(connection.execute("SELECT * FROM privacy_cases ORDER BY updated_at DESC"))

    def get_case(self, case_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM privacy_cases WHERE privacy_case_id = ?", (case_id,)).fetchone()
        return dict(row) if row else None

    def link_studio_case(self, privacy_case_id: str, studio_case_id: str) -> None:
        with self._connect() as connection:
            result = connection.execute(
                "UPDATE privacy_cases SET studio_case_id = ?, updated_at = ? WHERE privacy_case_id = ?",
                (studio_case_id, utc_now(), privacy_case_id),
            )
            if result.rowcount != 1:
                raise ValueError("Privacy case not found.")
        self.add_event(privacy_case_id, "case.linked", {"studio_case_id": studio_case_id})

    def create_finding(self, case_id: str, values: dict[str, Any]) -> str:
        finding_id = new_id("finding")
        now = utc_now()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO privacy_findings (
                    finding_id, privacy_case_id, company_name, domain, industry_category,
                    listing_url, listing_identifier, subject_identifier, recipient_email,
                    privacy_form_url, contact_status, content_category, discovered_at, notes,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
                """,
                (
                    finding_id,
                    case_id,
                    str(values["company_name"]).strip(),
                    str(values.get("domain", "")).strip(),
                    str(values["industry_category"]).strip(),
                    str(values["listing_url"]).strip(),
                    str(values.get("listing_identifier", "")).strip(),
                    str(values.get("subject_identifier", "")).strip(),
                    str(values.get("recipient_email", "")).strip(),
                    str(values.get("privacy_form_url", "")).strip(),
                    str(values.get("contact_status", "unverified")).strip(),
                    str(values.get("content_category", "standard")).strip(),
                    str(values.get("discovered_at", now)).strip(),
                    str(values.get("notes", "")).strip(),
                    now,
                    now,
                ),
            )
        self.add_event(case_id, "finding.added", {"company_name": values["company_name"]}, finding_id=finding_id)
        return finding_id

    def list_findings(self, case_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            return self._rows(
                connection.execute(
                    "SELECT * FROM privacy_findings WHERE privacy_case_id = ? ORDER BY created_at DESC", (case_id,)
                )
            )

    def get_finding(self, finding_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM privacy_findings WHERE finding_id = ?", (finding_id,)).fetchone()
        return dict(row) if row else None

    def create_request(self, case_id: str, finding_id: str, values: dict[str, Any]) -> str:
        request_id = new_id("request")
        now = utc_now()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO privacy_requests (
                    request_id, privacy_case_id, finding_id, template_key, request_types_json,
                    jurisdiction_basis, recipient_email, delivery_method, email_subject,
                    email_body, status, response_due_date, sent_at, confirmation_reference,
                    notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, '', ?, ?, ?)
                """,
                (
                    request_id,
                    case_id,
                    finding_id,
                    str(values["template_key"]),
                    _json(values.get("request_types", [])),
                    str(values.get("jurisdiction_basis", "")).strip(),
                    str(values.get("recipient_email", "")).strip(),
                    str(values.get("delivery_method", "email")).strip(),
                    str(values["email_subject"]).strip(),
                    str(values["email_body"]).strip(),
                    values.get("response_due_date") or None,
                    str(values.get("notes", "")).strip(),
                    now,
                    now,
                ),
            )
        self.add_event(case_id, "request.drafted", {"template_key": values["template_key"]}, finding_id=finding_id, request_id=request_id)
        return request_id

    def list_requests(self, case_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            return self._rows(
                connection.execute(
                    """
                    SELECT r.*, f.company_name, f.listing_url, f.privacy_form_url
                    FROM privacy_requests r
                    JOIN privacy_findings f ON f.finding_id = r.finding_id
                    WHERE r.privacy_case_id = ?
                    ORDER BY r.updated_at DESC
                    """,
                    (case_id,),
                )
            )

    def get_request(self, request_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT r.*, f.company_name, f.listing_url, f.privacy_form_url
                FROM privacy_requests r JOIN privacy_findings f ON f.finding_id = r.finding_id
                WHERE r.request_id = ?
                """,
                (request_id,),
            ).fetchone()
        return dict(row) if row else None

    def update_request_status(
        self,
        request_id: str,
        status: str,
        *,
        confirmation_reference: str = "",
        notes: str = "",
        response_due_date: str | None = None,
        mark_sent: bool = False,
    ) -> None:
        request = self.get_request(request_id)
        if not request:
            raise ValueError("Request not found.")
        now = utc_now()
        sent_at = now if mark_sent and not request.get("sent_at") else request.get("sent_at")
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE privacy_requests
                SET status = ?, confirmation_reference = ?, notes = ?, response_due_date = ?, sent_at = ?, updated_at = ?
                WHERE request_id = ?
                """,
                (status, confirmation_reference.strip(), notes.strip(), response_due_date or None, sent_at, now, request_id),
            )
        self.add_event(
            str(request["privacy_case_id"]),
            "request.status_changed",
            {"status": status, "confirmation_reference": confirmation_reference},
            finding_id=str(request["finding_id"]),
            request_id=request_id,
        )

    def add_verification(self, case_id: str, finding_id: str, values: dict[str, Any]) -> str:
        verification_id = new_id("verify")
        checked_at = str(values.get("checked_at") or utc_now())
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO privacy_verifications VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    verification_id,
                    case_id,
                    finding_id,
                    values.get("request_id") or None,
                    str(values["result"]),
                    str(values.get("source_url", "")).strip(),
                    str(values.get("notes", "")).strip(),
                    checked_at,
                ),
            )
            finding_status = "removed" if values["result"] == "removed" else "open"
            connection.execute(
                "UPDATE privacy_findings SET status = ?, updated_at = ? WHERE finding_id = ?",
                (finding_status, utc_now(), finding_id),
            )
        self.add_event(case_id, "finding.verified", {"result": values["result"]}, finding_id=finding_id, request_id=values.get("request_id"))
        return verification_id

    def list_verifications(self, case_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            return self._rows(
                connection.execute(
                    "SELECT * FROM privacy_verifications WHERE privacy_case_id = ? ORDER BY checked_at DESC", (case_id,)
                )
            )

    def list_events(self, case_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            return self._rows(
                connection.execute(
                    "SELECT * FROM privacy_events WHERE privacy_case_id = ? ORDER BY created_at DESC", (case_id,)
                )
            )

    def case_packet(self, case_id: str) -> dict[str, Any]:
        case = self.get_case(case_id)
        if not case:
            raise ValueError("Privacy case not found.")
        return {
            "schema_version": 1,
            "generated_at": utc_now(),
            "case": case,
            "findings": self.list_findings(case_id),
            "requests": self.list_requests(case_id),
            "verifications": self.list_verifications(case_id),
            "events": self.list_events(case_id),
        }
