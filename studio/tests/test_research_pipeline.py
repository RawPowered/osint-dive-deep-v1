from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from osint_studio.case_store import CaseStore
from osint_studio.evidence_pipeline import ResearchEvidencePipeline
from osint_studio.executor import ExecutionResult
from osint_studio.research_lanes import detect_subject_type, lane_matrix
from osint_studio.web_recon import PageRecord, SearchResult


class ResearchPipelineTests(unittest.TestCase):
    def test_lane_planning_and_exact_web_evidence(self) -> None:
        self.assertEqual(detect_subject_type("example.org"), "domain")
        self.assertIn("pdf", str(lane_matrix("document", ["annual report"])["filetypes"]))

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = CaseStore(root / "studio.sqlite", root / "artifacts")
            case_id = store.create_case("Research")
            pipeline = ResearchEvidencePipeline(store)
            run_id = pipeline.start_web_recon(case_id, {"lane": "domain"})
            raw = b"<html><body>hello@example.org (813) 555-1212</body></html>"
            record = PageRecord(
                fields={
                    "requested_url": "https://example.org",
                    "final_url": "https://example.org/",
                    "fetch_ok": True,
                    "content_type": "text/html",
                    "emails": "hello@example.org",
                    "phones": "(813) 555-1212",
                    "social_links": "https://linkedin.com/company/example",
                },
                raw_bytes=raw,
                response_headers={"Content-Type": "text/html"},
                encoding="utf-8",
            )
            pipeline.ingest_web_page(
                case_id,
                run_id,
                SearchResult("https://example.org", source="test"),
                record,
                {"final_url": "https://example.org/", "match_passed": True},
            )
            pipeline.finish_web_recon(run_id, [{"match_passed": True}])
            tool_run_id = pipeline.start_tool_run(case_id, "example-tool", {"argv": ["example-tool"]}, traffic_class="passive")
            pipeline.ingest_tool_result(
                case_id,
                tool_run_id,
                ExecutionResult(
                    argv=["example-tool", "--version"],
                    started_at="2026-01-01T00:00:00+00:00",
                    finished_at="2026-01-01T00:00:01+00:00",
                    return_code=0,
                    timed_out=False,
                    duration_seconds=1.0,
                    output="example-tool 1.0\n",
                ),
            )

            stats = store.case_stats(case_id)
            self.assertEqual(stats["entities"], 1)
            self.assertEqual(stats["identifiers"], 5)
            self.assertEqual(stats["observations"], 2)
            self.assertEqual(stats["artifacts"], 2)
            web_observation = next(row for row in store.list_observations(case_id) if row["observation_type"] == "web-page-analysis")
            artifact_id = web_observation["artifact_id"]
            self.assertEqual(store.artifact_path(str(artifact_id)).read_bytes(), raw)


if __name__ == "__main__":
    unittest.main()
