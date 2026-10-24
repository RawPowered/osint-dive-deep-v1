from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from osint_studio.case_store import CaseStore, SCHEMA_VERSION
from osint_studio.supercharger import Candidate, JobStore


class CaseStoreTests(unittest.TestCase):
    def test_schema_upgrade_creates_recoverable_backup(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            database = root / "studio.sqlite"
            with closing(sqlite3.connect(database)) as connection:
                connection.executescript(
                    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);"
                    "INSERT INTO schema_migrations VALUES(1, '2026-01-01T00:00:00+00:00');"
                )
                connection.commit()

            CaseStore(database, root / "artifacts")

            self.assertEqual(len(list(root.glob("studio.schema-v1-backup-*.sqlite"))), 1)

    def test_case_schema_and_v5_imports(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            legacy_path = root / "legacy.sqlite"
            with JobStore(legacy_path) as legacy:
                legacy.upsert_candidate(
                    Candidate(
                        url="https://example.org/about",
                        provider="ddgs",
                        query="example organization",
                        title="Example Organization",
                        rank=1,
                    )
                )

            store = CaseStore(root / "studio.sqlite", root / "artifacts")
            imported = store.import_discovery_job(legacy_path, case_name="Imported research")
            duplicate_import = store.import_discovery_job(legacy_path, case_id=imported["case_id"])
            template = store.import_hunt_template(
                imported["case_id"],
                Path(__file__).resolve().parent.parent / "templates" / "template_starter.json",
            )
            organization_id = store.upsert_entity(imported["case_id"], "organization", "Example Organization")
            domain_id = store.upsert_entity(imported["case_id"], "domain", "example.org")
            store.upsert_relationship(imported["case_id"], organization_id, domain_id, "owns")
            evidence_id = store.add_evidence(imported["case_id"], "analyst-note", "Verified ownership")
            claim_id = store.add_claim(
                imported["case_id"],
                "owns-domain",
                "example.org",
                entity_id=organization_id,
                evidence_ids=[evidence_id],
            )
            store.add_finding(imported["case_id"], "ownership", "Domain ownership verified", claim_id=claim_id)
            stats = store.case_stats(imported["case_id"])

            self.assertEqual(SCHEMA_VERSION, 2)
            self.assertEqual(imported["candidates"], 1)
            self.assertEqual(imported["imported_candidates"], 1)
            self.assertTrue(duplicate_import["already_imported"])
            self.assertEqual(duplicate_import["imported_candidates"], 0)
            self.assertEqual(stats["entities"], 2)
            self.assertEqual(stats["observations"], 2)
            self.assertEqual(stats["evidence"], 3)
            self.assertEqual(stats["artifacts"], 2)
            self.assertEqual(stats["runs"], 3)
            self.assertEqual(stats["relationships"], 1)
            self.assertEqual(stats["claims"], 1)
            self.assertEqual(stats["findings"], 1)
            self.assertTrue(store.artifact_path(imported["artifact_id"]).is_file())
            self.assertEqual(template["summary"]["schema_version"], "osint-query-studio-template-v2")


if __name__ == "__main__":
    unittest.main()
