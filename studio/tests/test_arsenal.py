from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from osint_studio.arsenal import ArsenalNormalizer, build_spiderfoot_plan, parse_spiderfoot_json
from osint_studio.case_store import CaseStore
from osint_studio.executor import ExecutionResult


class ArsenalTests(unittest.TestCase):
    def test_spiderfoot_scan_plan_uses_standalone_scanner_json(self) -> None:
        plan = build_spiderfoot_plan("/usr/bin/spiderfoot", "example.org", "passive", max_threads=2)
        self.assertEqual(plan.argv[:3], ("/usr/bin/spiderfoot", "-s", "example.org"))
        self.assertIn("passive", plan.argv)
        self.assertIn("json", plan.argv)
        self.assertNotIn("spiderfoot-cli", plan.argv)

    def test_spiderfoot_json_is_unredacted_and_normalized(self) -> None:
        exposed = "rotating-key-live-123456@example.org"
        payload = json.dumps(
            [
                {
                    "type": "Internet Name",
                    "eventType": "INTERNET_NAME",
                    "data": "api.example.org",
                    "module": "sfp_dnsresolve",
                    "source": "example.org",
                    "confidence": 100,
                },
                {
                    "type": "Data Breach",
                    "eventType": "DATA_BREACH",
                    "data": exposed,
                    "module": "sfp_breach",
                    "source": "example.org",
                    "confidence": 80,
                },
            ]
        )
        events = parse_spiderfoot_json(f"startup log\n{payload}\n")
        self.assertEqual(events[1].data, exposed)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = CaseStore(root / "studio.sqlite", root / "artifacts")
            case_id = store.create_case("Arsenal")
            run_id = store.create_run(case_id, "kali-tool-execution", adapter="spiderfoot_cli")
            artifact_id = store.record_artifact_bytes(case_id, payload.encode(), "tool-output", run_id=run_id)
            evidence_id = store.add_evidence(case_id, "tool-output", payload, artifact_id=artifact_id)
            result = ExecutionResult(
                argv=["spiderfoot", "-s", "example.org", "-o", "json"],
                started_at="2026-01-01T00:00:00+00:00",
                finished_at="2026-01-01T00:00:01+00:00",
                return_code=0,
                timed_out=False,
                duration_seconds=1.0,
                output=payload,
                stdout=payload,
                stdout_bytes=payload.encode(),
            )
            summary = ArsenalNormalizer(store).ingest(
                case_id, run_id, "spiderfoot_cli", result, artifact_id, evidence_id
            )
            self.assertEqual(summary.parsed_events, 2)
            self.assertEqual(summary.findings, 1)
            finding = store.list_findings(case_id)[0]
            self.assertIn(exposed, finding["title"])


if __name__ == "__main__":
    unittest.main()
