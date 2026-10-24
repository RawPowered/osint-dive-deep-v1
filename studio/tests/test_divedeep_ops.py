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


class DiveDeepOperationsTests(unittest.TestCase):
    def test_webui_operations_round_trip(self) -> None:
        if not SAMPLE.exists():
            self.skipTest("DiveDeep sample packet is unavailable")
        script = """
import json
from pathlib import Path
from osint_studio.divedeep_ops import (
    export_workspace_results,
    import_uploaded_packet,
    list_workspaces,
    load_workspace_bundle,
    record_payload,
)

sample = Path(r'%s')
imported = import_uploaded_packet(sample.name, sample.read_bytes())
workspace = Path(imported['workspace'])
assert list_workspaces()[0]['customerId'] == imported['manifest']['customerId']
bundle = load_workspace_bundle(workspace)
assert bundle['manifest']['workspaceType'] == 'divedeep.manual-recon'
record_payload(workspace, {
    'sourceName': 'Example',
    'listingUrl': 'https://example.com/profile',
    'matchConfidence': 0.9,
    'contentCategory': 'people-search',
    'status': 'confirmed',
})
exported = export_workspace_results(workspace)
assert Path(exported['output']).is_file()
assert len(exported['packet']['findings']) == 1
print(json.dumps({'ok': True}))
""" % str(SAMPLE).replace("\\", "\\\\")
        with tempfile.TemporaryDirectory() as temporary:
            env = {
                **os.environ,
                "PYTHONPATH": str(ROOT),
                "OSINT_STUDIO_DATA_DIR": str(Path(temporary) / "data"),
            }
            result = subprocess.run(
                [sys.executable, "-c", script],
                cwd=ROOT,
                env=env,
                check=True,
                text=True,
                capture_output=True,
            )
            self.assertTrue(json.loads(result.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()

class DiveDeepMissionPlanTests(unittest.TestCase):
    def test_full_mission_builds_point_click_jobs(self) -> None:
        from osint_studio.divedeep_ops import MISSION_PRESETS, build_identity_job_plan, build_job_argv

        packet = {
            "customer": {"id": "customer-1", "sensitiveContentConsentAt": "2026-01-01T00:00:00Z"},
            "divedeep": {
                "profile": {
                    "id": "profile-1",
                    "jurisdictionRegion": "FL",
                    "jurisdictionCountry": "US",
                    "identifiers": [
                        {"type": "name", "value": "Jane Example", "status": "active"},
                        {"type": "alias", "value": "jane_example", "status": "active"},
                        {"type": "email", "value": "jane1984@example.net", "status": "active"},
                        {"type": "phone", "value": "+1 555 123 4567", "status": "active"},
                    ],
                }
            },
            "connections": [{"profileUrl": "https://facebook.com/jane1984", "username": ""}],
            "photos": [{"id": "photo-1", "mimeType": "image/jpeg", "sha256": "a" * 64}],
            "manualProcessing": {
                "sourceSets": [
                    "sherlock-supported",
                    "maigret-supported",
                    "people-search",
                    "authorized-image-match-review",
                    "sensitive-adult-sites",
                ]
            },
        }
        plan = build_identity_job_plan(packet, MISSION_PRESETS["Full authorized"])
        tools = {job["tool"] for job in plan["jobs"]}
        self.assertTrue({"ddgs-text", "ddgs-images", "sherlock", "maigret", "spiderfoot_cli", "url-probe", "photo-fingerprint"}.issubset(tools))
        internal = next(job for job in plan["jobs"] if job["tool"] == "ddgs-text")
        self.assertIn("osint_studio.divedeep_worker", build_job_argv(internal))

    def test_candidate_json_is_normalized(self) -> None:
        from osint_studio.divedeep_ops import extract_candidate_records

        job = {"tool": "ddgs-text", "target": '"Jane Example"', "contentCategory": "public-web", "values": {"subjectIdentifier": "Jane Example"}}
        output = json.dumps({"kind": "search-result", "url": "https://example.org/jane", "title": "Jane Example", "snippet": "Profile"})
        candidates = extract_candidate_records(output, job)
        self.assertEqual(candidates[0]["url"], "https://example.org/jane")
        self.assertEqual(candidates[0]["subject"], "Jane Example")

class DiveDeepPackageFlowTests(unittest.TestCase):
    def _packet(self, plan_tier: str) -> dict:
        return {
            "schemaVersion": 2,
            "product": "OSINT Dive Deep v1",
            "exportedAt": "2026-07-23T00:00:00Z",
            "customer": {
                "id": "customer-package-test",
                "email": "jane@example.com",
                "displayName": "Jane Example",
                "planTier": plan_tier,
                "authorizationAffirmedAt": "2026-07-23T00:00:00Z",
                "sensitiveContentConsentAt": "2026-07-23T00:00:00Z",
            },
            "divedeep": {
                "profile": {
                    "id": "profile-package-test",
                    "jurisdictionCountry": "US",
                    "jurisdictionRegion": "FL",
                    "identifiers": [
                        {"id": "id-name", "type": "name", "value": "Jane Example", "isPrimary": True, "status": "active"},
                        {"id": "id-email", "type": "email", "value": "jane1984@example.com", "isPrimary": True, "status": "active"},
                        {"id": "id-alias", "type": "alias", "value": "jane1984", "isPrimary": False, "status": "active"},
                    ],
                    "policies": [],
                    "authorization": {
                        "status": "active",
                        "type": "self",
                        "requesterRole": "self",
                        "requesterName": "Jane Example",
                        "requesterEmail": "jane@example.com",
                        "signedAt": "2026-07-23T00:00:00Z",
                        "revokedAt": None,
                    },
                }
            },
            "connections": [{"profileUrl": "https://facebook.com/jane1984", "username": "jane1984", "protectedFromRemoval": True}],
            "photos": [{"id": "photo-1", "mimeType": "image/jpeg", "sha256": "a" * 64, "purpose": "identity_search"}],
            "manualProcessing": {
                "sourceSets": [
                    "mainstream-social",
                    "declared-profiles",
                    "sherlock-supported",
                    "maigret-supported",
                    "people-search",
                    "authorized-image-match-review",
                    "sensitive-adult-sites",
                ],
                "instructions": ["Authorized package test"],
            },
        }

    def test_four_packages_build_expected_scope(self) -> None:
        from osint_studio.divedeep_ops import build_identity_job_plan

        standard = build_identity_job_plan(self._packet("standard"), package_key="standard")
        deep = build_identity_job_plan(self._packet("deep"), package_key="deep")
        image = build_identity_job_plan(self._packet("image"), package_key="image")
        sensitive = build_identity_job_plan(self._packet("sensitive"), package_key="sensitive")

        self.assertNotIn("correlation", standard["missionFamilies"])
        self.assertIn("correlation", deep["missionFamilies"])
        self.assertNotIn("photo-review", deep["missionFamilies"])
        self.assertIn("photo-review", image["missionFamilies"])
        self.assertNotIn("sensitive-review", image["missionFamilies"])
        self.assertIn("sensitive-review", sensitive["missionFamilies"])
        self.assertLess(len(standard["jobs"]), len(deep["jobs"]))
        self.assertLess(len(deep["jobs"]), len(image["jobs"]))
        self.assertLess(len(image["jobs"]), len(sensitive["jobs"]))

    def test_import_creates_package_case_folder(self) -> None:
        script = r'''
import json
from pathlib import Path
from osint_studio.divedeep_ops import import_uploaded_packet, load_workspace_bundle
packet = json.loads(Path(r"%s").read_text())
packet["customer"]["planTier"] = "image"
raw = json.dumps(packet).encode("utf-8")
result = import_uploaded_packet("customer.json", raw, package_key="image")
workspace = Path(result["workspace"])
assert (workspace / "case" / "case.json").is_file()
assert (workspace / "case" / "queue.json").is_file()
assert result["manifest"]["packageKey"] == "image"
assert load_workspace_bundle(workspace)["toolPlan"]["package"]["key"] == "image"
print(json.dumps({"ok": True}))
''' % str(SAMPLE).replace("\\", "\\\\")
        if not SAMPLE.exists():
            self.skipTest("DiveDeep sample packet is unavailable")
        with tempfile.TemporaryDirectory() as temporary:
            env = {
                **os.environ,
                "PYTHONPATH": str(ROOT),
                "OSINT_STUDIO_DATA_DIR": str(Path(temporary) / "data"),
            }
            result = subprocess.run([sys.executable, "-c", script], cwd=ROOT, env=env, check=True, text=True, capture_output=True)
            self.assertTrue(json.loads(result.stdout)["ok"])
