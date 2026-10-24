from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from osint_studio.case_store import CaseStore
from osint_studio.market_intel import MarketIntelligenceService, MarketProfileConfig


class MarketIntelligenceTests(unittest.TestCase):
    def test_score_review_segment_export_and_suppression(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = CaseStore(root / "studio.sqlite", root / "artifacts")
            case_id = store.create_case("Market")
            entity_id = store.upsert_entity(case_id, "domain", "example.org", confidence=0.9)
            store.add_identifier(case_id, "domain", "example.org", entity_id=entity_id, confidence=1.0)
            store.add_identifier(case_id, "url", "https://example.org", entity_id=entity_id, confidence=1.0)
            store.add_identifier(case_id, "email", "hello@example.org", entity_id=entity_id, confidence=0.9)
            for source in ("https://search.example/result", "https://example.org"):
                store.record_observation(
                    case_id,
                    "web-page-analysis",
                    {"fields": {"title": "Example Roofing", "technologies": "WordPress | VendorX"}},
                    entity_id=entity_id,
                    source_name="test",
                    source_uri=source,
                    confidence=0.9,
                )

            service = MarketIntelligenceService(store)
            profile_id = service.save_profile(
                case_id,
                "Roofing market",
                MarketProfileConfig(
                    entity_types=["domain"],
                    required_identifier_types=["email"],
                    preferred_terms=["roofing", "vendorx"],
                    minimum_score=50,
                ),
            )
            service.evaluate_profile(profile_id)
            record = service.list_records(profile_id)[0]
            self.assertEqual(record["verification_status"], "corroborated")
            self.assertEqual(record["fit_score"], 100)
            self.assertGreater(record["total_score"], 50)

            service.update_review(record["id"], "approved-for-export", "Reviewed", "consent-gated")
            segment_id = service.save_segment(
                case_id,
                profile_id,
                "Approved",
                {
                    "minimum_score": 50,
                    "review_statuses": ["approved-for-export"],
                    "verification_statuses": ["corroborated"],
                    "activation_states": ["consent-gated"],
                },
            )
            exported = service.export_rows(profile_id, segment_id=segment_id)
            self.assertEqual(len(exported), 1)
            self.assertIn("hello@example.org", exported[0]["identifiers_json"])

            service.add_suppression(case_id, "email", "hello@example.org", "Do not activate")
            self.assertEqual(service.export_rows(profile_id), [])

            service.evaluate_profile(profile_id)
            self.assertEqual(service.list_records(profile_id)[0]["recommended_activation"], "suppressed")
            self.assertEqual(service.export_rows(profile_id), [])


if __name__ == "__main__":
    unittest.main()
