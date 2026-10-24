from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SAMPLE = Path(os.environ.get("DIVEDEEP_TEST_PACKET", str(ROOT / "tests/fixtures/intake.json")))


class DiveDeepBridgeTests(unittest.TestCase):
    def test_round_trip(self) -> None:
        if not SAMPLE.exists():
            self.skipTest("DiveDeep sample packet is unavailable")
        with tempfile.TemporaryDirectory() as temporary:
            data_root = Path(temporary) / "data"
            workspaces = Path(temporary) / "workspaces"
            env = {**os.environ, "OSINT_STUDIO_DATA_DIR": str(data_root), "PYTHONPATH": str(ROOT)}
            imported = subprocess.run(
                [sys.executable, str(ROOT / "divedeep_cli.py"), "import", str(SAMPLE), "--workspace-root", str(workspaces)],
                cwd=ROOT, env=env, check=True, text=True, capture_output=True,
            )
            workspace = Path(json.loads(imported.stdout)["workspace"])
            finding = {
                "sourceName": "Example Directory",
                "listingUrl": "https://example.com/person/123",
                "subjectIdentifier": "authorized identifier",
                "matchConfidence": 0.91,
                "contentCategory": "people-search",
                "status": "confirmed",
                "notes": "Synthetic bridge test",
                "evidence": [{"type": "reference", "ref": "manual://test", "sha256": "a" * 64}],
                "removal": {"createCase": True, "templateKey": "people-search-removal", "status": "sent"},
                "verification": {"result": "still_present", "sourceUrl": "https://example.com/person/123"},
            }
            finding_path = Path(temporary) / "finding.json"
            finding_path.write_text(json.dumps(finding), encoding="utf-8")
            subprocess.run(
                [sys.executable, str(ROOT / "divedeep_cli.py"), "record", str(workspace), str(finding_path)],
                cwd=ROOT, env=env, check=True, text=True, capture_output=True,
            )
            exported = subprocess.run(
                [sys.executable, str(ROOT / "divedeep_cli.py"), "export", str(workspace)],
                cwd=ROOT, env=env, check=True, text=True, capture_output=True,
            )
            output = Path(json.loads(exported.stdout)["output"])
            packet = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(packet["packetType"], "divedeep.recon-results")
            self.assertEqual(len(packet["findings"]), 1)
            self.assertEqual(packet["findings"][0]["status"], "confirmed")
            self.assertEqual(packet["findings"][0]["verification"]["result"], "still_present")


if __name__ == "__main__":
    unittest.main()
