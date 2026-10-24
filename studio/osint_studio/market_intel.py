from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from .case_store import CaseStore, json_object_text, json_text, new_id, normalized_text, utc_now


REVIEW_STATUSES = ("unreviewed", "needs-research", "qualified", "excluded", "approved-for-export", "expired")
ACTIVATION_STATES = ("research-only", "review-for-campaign", "consent-gated", "approved-campaign", "suppressed")


@dataclass
class MarketProfileConfig:
    entity_types: list[str] = field(default_factory=lambda: ["organization", "domain"])
    required_identifier_types: list[str] = field(default_factory=list)
    required_terms: list[str] = field(default_factory=list)
    preferred_terms: list[str] = field(default_factory=list)
    excluded_terms: list[str] = field(default_factory=list)
    minimum_score: float = 60.0
    refresh_days: int = 30
    weights: dict[str, float] = field(
        default_factory=lambda: {"fit": 40.0, "confidence": 25.0, "freshness": 15.0, "reachability": 20.0}
    )

    @classmethod
    def from_value(cls, value: dict[str, Any] | None) -> MarketProfileConfig:
        source = dict(value or {})
        defaults = cls()
        supplied_weights = dict(source.get("weights") or {})
        weights = {
            key: float(supplied_weights.get(key, default_value))
            for key, default_value in defaults.weights.items()
        }
        return cls(
            entity_types=[str(item) for item in source.get("entity_types", defaults.entity_types)],
            required_identifier_types=[str(item) for item in source.get("required_identifier_types", [])],
            required_terms=[normalized_text(str(item)) for item in source.get("required_terms", []) if str(item).strip()],
            preferred_terms=[normalized_text(str(item)) for item in source.get("preferred_terms", []) if str(item).strip()],
            excluded_terms=[normalized_text(str(item)) for item in source.get("excluded_terms", []) if str(item).strip()],
            minimum_score=max(0.0, min(100.0, float(source.get("minimum_score", defaults.minimum_score)))),
            refresh_days=max(1, int(source.get("refresh_days", defaults.refresh_days))),
            weights=weights,
        )


def _parse_time(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        return None


def _reason(value: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", value.upper()).strip("_")[:80]


class MarketIntelligenceService:
    def __init__(self, store: CaseStore | None = None):
        self.store = store or CaseStore()

    def save_profile(
        self,
        case_id: str,
        name: str,
        config: MarketProfileConfig,
        *,
        description: str = "",
    ) -> str:
        now = utc_now()
        profile_id = new_id("market_profile")
        with self.store.connection() as connection:
            connection.execute(
                """
                INSERT INTO market_profiles(id,case_id,name,description,config_json,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(case_id,name) DO UPDATE SET
                    description=excluded.description,
                    config_json=excluded.config_json,
                    updated_at=excluded.updated_at
                """,
                (profile_id, case_id, name.strip() or "Market profile", description, json_text(asdict(config)), now, now),
            )
            row = connection.execute(
                "SELECT id FROM market_profiles WHERE case_id=? AND name=?",
                (case_id, name.strip() or "Market profile"),
            ).fetchone()
            assert row is not None
            return str(row["id"])

    def list_profiles(self, case_id: str) -> list[dict[str, Any]]:
        with self.store.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM market_profiles WHERE case_id=? ORDER BY updated_at DESC", (case_id,)
            ).fetchall()
        return [dict(row) for row in rows]

    def get_profile(self, profile_id: str) -> dict[str, Any] | None:
        with self.store.connection() as connection:
            row = connection.execute("SELECT * FROM market_profiles WHERE id=?", (profile_id,)).fetchone()
        return dict(row) if row else None

    def derive_attributes(self, case_id: str) -> dict[str, int]:
        attributes = 0
        identifiers = self.store.list_entity_identifiers(case_id)
        for identifier in identifiers:
            self.store.upsert_entity_attribute(
                case_id,
                str(identifier["entity_id"]),
                f"identifier.{identifier['identifier_type']}",
                identifier["display_value"],
                normalized_value=str(identifier["normalized_value"]),
                confidence=float(identifier["confidence"] or 0),
                source_ref=str(identifier["id"]),
            )
            attributes += 1

        field_map = {
            "title": "website_title",
            "meta_description": "description",
            "technologies": "technology",
            "generator": "technology_generator",
            "language": "language",
            "domain": "domain",
            "city": "city",
            "state": "state",
            "zip": "zip",
            "county": "county",
            "property_type": "property_type",
        }
        for observation in self.store.list_observations(case_id, 1_000_000):
            entity_id = observation.get("entity_id")
            if not entity_id:
                continue
            try:
                payload = json.loads(str(observation.get("value_json") or "{}"))
            except (TypeError, ValueError):
                continue
            fields = payload.get("fields") if isinstance(payload, dict) else None
            if not isinstance(fields, dict):
                fields = payload if isinstance(payload, dict) else {}
            for field_name, attribute_name in field_map.items():
                raw_value = fields.get(field_name)
                if raw_value in (None, "", []):
                    continue
                values = str(raw_value).split(" | ") if field_name == "technologies" else [raw_value]
                for value in values:
                    if str(value).strip():
                        self.store.upsert_entity_attribute(
                            case_id,
                            str(entity_id),
                            attribute_name,
                            value,
                            confidence=float(observation.get("confidence") or 0),
                            source_ref=str(observation["id"]),
                            metadata={"observation_id": observation["id"], "source_uri": observation.get("source_uri", "")},
                        )
                        attributes += 1
        return {"identifiers_processed": len(identifiers), "attributes_processed": attributes}

    def evaluate_profile(self, profile_id: str) -> dict[str, int]:
        profile = self.get_profile(profile_id)
        if not profile:
            raise ValueError(f"Unknown market profile: {profile_id}")
        case_id = str(profile["case_id"])
        config = MarketProfileConfig.from_value(json.loads(str(profile["config_json"])))
        self.derive_attributes(case_id)
        entities = [row for row in self.store.list_entities(case_id, 1_000_000) if row["entity_type"] in config.entity_types]
        identifiers = self.store.list_entity_identifiers(case_id)
        attributes = self.store.list_entity_attributes(case_id)
        identifiers_by_entity: dict[str, list[dict[str, Any]]] = {}
        attributes_by_entity: dict[str, list[dict[str, Any]]] = {}
        for item in identifiers:
            identifiers_by_entity.setdefault(str(item["entity_id"]), []).append(item)
        for item in attributes:
            attributes_by_entity.setdefault(str(item["entity_id"]), []).append(item)

        with self.store.connection() as connection:
            source_rows = connection.execute(
                """
                SELECT entity_id, COUNT(DISTINCT CASE
                    WHEN source_uri<>'' THEN source_uri
                    WHEN source_name<>'' THEN source_name
                    ELSE id
                END) AS source_count
                FROM observations WHERE case_id=? AND entity_id IS NOT NULL GROUP BY entity_id
                """,
                (case_id,),
            ).fetchall()
            suppression_rows = connection.execute(
                "SELECT identifier_type,normalized_value FROM suppression_entries WHERE case_id=? AND active=1",
                (case_id,),
            ).fetchall()
        source_counts = {str(row["entity_id"]): int(row["source_count"] or 0) for row in source_rows}
        suppressions = {(str(row["identifier_type"]), str(row["normalized_value"])) for row in suppression_rows}

        now = datetime.now(timezone.utc)
        evaluated_ids: list[str] = []
        for entity in entities:
            entity_id = str(entity["id"])
            entity_identifiers = identifiers_by_entity.get(entity_id, [])
            entity_attributes = attributes_by_entity.get(entity_id, [])
            identifier_types = {str(item["identifier_type"]) for item in entity_identifiers}
            corpus_parts = [str(entity["canonical_name"])]
            corpus_parts.extend(str(item["display_value"]) for item in entity_identifiers)
            corpus_parts.extend(str(item["normalized_value"]) for item in entity_attributes)
            corpus = normalized_text(" ".join(corpus_parts))
            reasons: list[str] = [f"ENTITY_TYPE_{_reason(str(entity['entity_type']))}"]

            fit_score = 100.0
            missing_identifiers = [item for item in config.required_identifier_types if item not in identifier_types]
            missing_terms = [item for item in config.required_terms if item not in corpus]
            excluded_matches = [item for item in config.excluded_terms if item in corpus]
            if missing_identifiers:
                fit_score = 0.0
                reasons.extend(f"MISSING_IDENTIFIER_{_reason(item)}" for item in missing_identifiers)
            if missing_terms:
                fit_score = 0.0
                reasons.extend(f"MISSING_REQUIRED_{_reason(item)}" for item in missing_terms)
            if excluded_matches:
                fit_score = 0.0
                reasons.extend(f"EXCLUDED_TERM_{_reason(item)}" for item in excluded_matches)
            if fit_score and config.preferred_terms:
                preferred_matches = [item for item in config.preferred_terms if item in corpus]
                fit_score = 60.0 + 40.0 * len(preferred_matches) / len(config.preferred_terms)
                reasons.extend(f"PREFERRED_TERM_{_reason(item)}" for item in preferred_matches)

            source_count = source_counts.get(entity_id, 0)
            confidence_score = min(100.0, float(entity.get("confidence") or 0) * 50.0 + min(4, source_count) * 12.5)
            verification = "corroborated" if source_count >= 2 else ("single-source" if source_count == 1 else "unverified")
            reasons.append(f"VERIFICATION_{_reason(verification)}")

            last_seen = _parse_time(str(entity.get("last_seen") or "")) or now
            age_days = max(0.0, (now - last_seen).total_seconds() / 86400.0)
            freshness_score = max(0.0, 100.0 * (1.0 - age_days / config.refresh_days))
            if freshness_score == 0:
                reasons.append("STALE_ENTITY")

            reachability_score = 0.0
            reachability_weights = {"email": 35.0, "phone": 30.0, "url": 20.0, "social-url": 15.0}
            for identifier_type, weight in reachability_weights.items():
                if identifier_type in identifier_types:
                    reachability_score += weight
                    reasons.append(f"HAS_{_reason(identifier_type)}")

            weights = config.weights
            weight_total = sum(max(0.0, float(value)) for value in weights.values()) or 100.0
            total_score = (
                fit_score * max(0.0, weights.get("fit", 0))
                + confidence_score * max(0.0, weights.get("confidence", 0))
                + freshness_score * max(0.0, weights.get("freshness", 0))
                + reachability_score * max(0.0, weights.get("reachability", 0))
            ) / weight_total

            suppressed = any((str(item["identifier_type"]), str(item["normalized_value"])) in suppressions for item in entity_identifiers)
            activation = "suppressed" if suppressed else (
                "review-for-campaign" if total_score >= config.minimum_score and fit_score > 0 and verification == "corroborated" else "research-only"
            )
            if suppressed:
                reasons.append("SUPPRESSION_MATCH")
            expires_at = (now + timedelta(days=config.refresh_days)).isoformat(timespec="seconds")
            record_id = new_id("market_record")
            with self.store.connection() as connection:
                existing = connection.execute(
                    "SELECT review_status,recommended_activation,analyst_notes FROM market_records WHERE profile_id=? AND entity_id=?",
                    (profile_id, entity_id),
                ).fetchone()
                review_status = str(existing["review_status"]) if existing else "unreviewed"
                analyst_notes = str(existing["analyst_notes"]) if existing else ""
                if existing and review_status in {"approved-for-export", "excluded"} and not suppressed:
                    activation = str(existing["recommended_activation"])
                connection.execute(
                    """
                    INSERT INTO market_records(id,case_id,profile_id,entity_id,fit_score,confidence_score,freshness_score,reachability_score,total_score,verification_status,review_status,recommended_activation,reason_codes_json,source_count,conflict_count,last_evaluated,expires_at,analyst_notes,metadata_json)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(profile_id,entity_id) DO UPDATE SET
                        fit_score=excluded.fit_score,
                        confidence_score=excluded.confidence_score,
                        freshness_score=excluded.freshness_score,
                        reachability_score=excluded.reachability_score,
                        total_score=excluded.total_score,
                        verification_status=excluded.verification_status,
                        review_status=excluded.review_status,
                        recommended_activation=excluded.recommended_activation,
                        reason_codes_json=excluded.reason_codes_json,
                        source_count=excluded.source_count,
                        conflict_count=excluded.conflict_count,
                        last_evaluated=excluded.last_evaluated,
                        expires_at=excluded.expires_at,
                        analyst_notes=excluded.analyst_notes,
                        metadata_json=excluded.metadata_json
                    """,
                    (
                        record_id, case_id, profile_id, entity_id, round(fit_score, 2), round(confidence_score, 2),
                        round(freshness_score, 2), round(reachability_score, 2), round(total_score, 2), verification,
                        review_status, activation, json_text(sorted(set(reasons))), source_count, 0, now.isoformat(timespec="seconds"),
                        expires_at, analyst_notes, json_object_text({"identifier_types": sorted(identifier_types)}),
                    ),
                )
                row = connection.execute(
                    "SELECT id FROM market_records WHERE profile_id=? AND entity_id=?", (profile_id, entity_id)
                ).fetchone()
                assert row is not None
                evaluated_ids.append(str(row["id"]))
        with self.store.connection() as connection:
            if evaluated_ids:
                placeholders = ",".join("?" for _ in evaluated_ids)
                connection.execute(
                    f"DELETE FROM market_records WHERE profile_id=? AND id NOT IN ({placeholders})",
                    [profile_id, *evaluated_ids],
                )
            else:
                connection.execute("DELETE FROM market_records WHERE profile_id=?", (profile_id,))
        return {"entities_evaluated": len(evaluated_ids), "profiles": 1}

    def list_records(self, profile_id: str) -> list[dict[str, Any]]:
        with self.store.connection() as connection:
            rows = connection.execute(
                """
                SELECT mr.*, e.entity_type, e.canonical_name
                FROM market_records mr JOIN entities e ON e.id=mr.entity_id
                WHERE mr.profile_id=? ORDER BY mr.total_score DESC, e.canonical_name
                """,
                (profile_id,),
            ).fetchall()
        output: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["reason_codes"] = json.loads(str(item.pop("reason_codes_json") or "[]"))
            output.append(item)
        return output

    def update_review(self, record_id: str, review_status: str, analyst_notes: str, recommended_activation: str) -> None:
        if review_status not in REVIEW_STATUSES:
            raise ValueError(f"Unsupported review status: {review_status}")
        if recommended_activation not in ACTIVATION_STATES:
            raise ValueError(f"Unsupported activation state: {recommended_activation}")
        with self.store.connection() as connection:
            connection.execute(
                "UPDATE market_records SET review_status=?,analyst_notes=?,recommended_activation=? WHERE id=?",
                (review_status, analyst_notes, recommended_activation, record_id),
            )

    def add_suppression(self, case_id: str, identifier_type: str, value: str, reason: str = "") -> str:
        suppression_id = new_id("suppression")
        now = utc_now()
        normalized = normalized_text(value)
        with self.store.connection() as connection:
            connection.execute(
                """
                INSERT INTO suppression_entries(id,case_id,identifier_type,normalized_value,reason,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(case_id,identifier_type,normalized_value) DO UPDATE SET
                    reason=excluded.reason,active=1,updated_at=excluded.updated_at
                """,
                (suppression_id, case_id, identifier_type, normalized, reason, now, now),
            )
            row = connection.execute(
                "SELECT id FROM suppression_entries WHERE case_id=? AND identifier_type=? AND normalized_value=?",
                (case_id, identifier_type, normalized),
            ).fetchone()
            assert row is not None
            return str(row["id"])

    def list_suppressions(self, case_id: str) -> list[dict[str, Any]]:
        with self.store.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM suppression_entries WHERE case_id=? AND active=1 ORDER BY updated_at DESC", (case_id,)
            ).fetchall()
        return [dict(row) for row in rows]

    def save_segment(self, case_id: str, profile_id: str, name: str, filters: dict[str, Any]) -> str:
        segment_id = new_id("segment")
        now = utc_now()
        with self.store.connection() as connection:
            connection.execute(
                """
                INSERT INTO market_segments(id,case_id,profile_id,name,filter_json,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(case_id,profile_id,name) DO UPDATE SET filter_json=excluded.filter_json,updated_at=excluded.updated_at
                """,
                (segment_id, case_id, profile_id, name.strip() or "Segment", json_object_text(filters), now, now),
            )
            row = connection.execute(
                "SELECT id FROM market_segments WHERE case_id=? AND profile_id=? AND name=?",
                (case_id, profile_id, name.strip() or "Segment"),
            ).fetchone()
            assert row is not None
            segment_id = str(row["id"])
        self.materialize_segment(segment_id)
        return segment_id

    def list_segments(self, case_id: str, profile_id: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM market_segments WHERE case_id=?"
        params: list[Any] = [case_id]
        if profile_id:
            sql += " AND profile_id=?"
            params.append(profile_id)
        sql += " ORDER BY updated_at DESC"
        with self.store.connection() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    @staticmethod
    def _record_matches(record: dict[str, Any], filters: dict[str, Any]) -> bool:
        if float(record["total_score"]) < float(filters.get("minimum_score", 0)):
            return False
        for key, record_key in (("entity_types", "entity_type"), ("review_statuses", "review_status"), ("verification_statuses", "verification_status"), ("activation_states", "recommended_activation")):
            allowed = [str(item) for item in filters.get(key, [])]
            if allowed and str(record[record_key]) not in allowed:
                return False
        return True

    def materialize_segment(self, segment_id: str) -> int:
        with self.store.connection() as connection:
            segment = connection.execute("SELECT * FROM market_segments WHERE id=?", (segment_id,)).fetchone()
        if not segment:
            raise ValueError(f"Unknown segment: {segment_id}")
        filters = json.loads(str(segment["filter_json"]))
        records = [row for row in self.list_records(str(segment["profile_id"])) if self._record_matches(row, filters)]
        with self.store.connection() as connection:
            connection.execute("DELETE FROM market_segment_members WHERE segment_id=?", (segment_id,))
            connection.executemany(
                "INSERT INTO market_segment_members(segment_id,market_record_id,included_at) VALUES(?,?,?)",
                [(segment_id, str(record["id"]), utc_now()) for record in records],
            )
        return len(records)

    def segment_records(self, segment_id: str) -> list[dict[str, Any]]:
        with self.store.connection() as connection:
            segment = connection.execute("SELECT profile_id FROM market_segments WHERE id=?", (segment_id,)).fetchone()
            member_rows = connection.execute(
                "SELECT market_record_id FROM market_segment_members WHERE segment_id=?", (segment_id,)
            ).fetchall()
        if not segment:
            return []
        members = {str(row["market_record_id"]) for row in member_rows}
        return [row for row in self.list_records(str(segment["profile_id"])) if str(row["id"]) in members]

    def export_rows(self, profile_id: str, *, segment_id: str | None = None, approved_only: bool = True) -> list[dict[str, Any]]:
        records = self.segment_records(segment_id) if segment_id else self.list_records(profile_id)
        if approved_only:
            records = [row for row in records if row["review_status"] == "approved-for-export" and row["recommended_activation"] != "suppressed"]
        if not records:
            return []
        case_id = str(records[0]["case_id"])
        identifiers_by_entity: dict[str, list[dict[str, Any]]] = {}
        attributes_by_entity: dict[str, list[dict[str, Any]]] = {}
        suppressions = {
            (str(item["identifier_type"]), str(item["normalized_value"]))
            for item in self.list_suppressions(case_id)
        }
        for item in self.store.list_entity_identifiers(case_id):
            identifiers_by_entity.setdefault(str(item["entity_id"]), []).append(item)
        for item in self.store.list_entity_attributes(case_id):
            attributes_by_entity.setdefault(str(item["entity_id"]), []).append(item)
        output: list[dict[str, Any]] = []
        for record in records:
            entity_id = str(record["entity_id"])
            identifiers = identifiers_by_entity.get(entity_id, [])
            attributes = attributes_by_entity.get(entity_id, [])
            if approved_only and any(
                (str(item["identifier_type"]), str(item["normalized_value"])) in suppressions
                for item in identifiers
            ):
                continue
            output.append(
                {
                    "record_id": record["id"],
                    "entity_id": entity_id,
                    "entity_type": record["entity_type"],
                    "name": record["canonical_name"],
                    "fit_score": record["fit_score"],
                    "confidence_score": record["confidence_score"],
                    "freshness_score": record["freshness_score"],
                    "reachability_score": record["reachability_score"],
                    "market_score": record["total_score"],
                    "verification_status": record["verification_status"],
                    "review_status": record["review_status"],
                    "recommended_activation": record["recommended_activation"],
                    "reason_codes": " | ".join(record["reason_codes"]),
                    "source_count": record["source_count"],
                    "last_evaluated": record["last_evaluated"],
                    "record_expires_at": record["expires_at"],
                    "analyst_notes": record["analyst_notes"],
                    "identifiers_json": json_text([{"type": item["identifier_type"], "value": item["display_value"]} for item in identifiers]),
                    "attributes_json": json_text([{"name": item["attribute_name"], "value": json.loads(str(item["value_json"]))} for item in attributes]),
                }
            )
        return output

    @staticmethod
    def csv_bytes(rows: list[dict[str, Any]]) -> bytes:
        if not rows:
            return b""
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
        return ("\ufeff" + stream.getvalue()).encode("utf-8")

    def register_export(
        self,
        case_id: str,
        profile_id: str,
        rows: list[dict[str, Any]],
        *,
        segment_id: str | None = None,
        export_format: str = "csv",
    ) -> str:
        export_id = new_id("market_export")
        manifest = {
            "case_id": case_id,
            "profile_id": profile_id,
            "segment_id": segment_id,
            "approved_only": True,
            "created_at": utc_now(),
        }
        with self.store.connection() as connection:
            connection.execute(
                "INSERT INTO market_exports(id,case_id,profile_id,segment_id,export_format,row_count,fields_json,manifest_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (export_id, case_id, profile_id, segment_id, export_format, len(rows), json_text(list(rows[0]) if rows else []), json_object_text(manifest), manifest["created_at"]),
            )
        return export_id
