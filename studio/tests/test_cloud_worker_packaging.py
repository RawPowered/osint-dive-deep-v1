from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CloudWorkerPackagingTests(unittest.TestCase):
    def test_cloud_run_files_are_present_and_safe(self):
        dockerfile = (ROOT / "Dockerfile.cloudrun").read_text(encoding="utf-8")
        deploy = (ROOT / "deploy/cloud-run/deploy-job.sh").read_text(encoding="utf-8")
        build = (ROOT / "deploy/cloud-run/build.sh").read_text(encoding="utf-8")
        cloudbuild = (ROOT / "cloudbuild.cloudrun.yaml").read_text(encoding="utf-8")
        worker = (ROOT / "osint_studio/cloud_worker.py").read_text(encoding="utf-8")
        self.assertIn("USER 10001:10001", dockerfile)
        self.assertIn("--tasks 1", deploy)
        self.assertIn("DIVEDEEP_MAX_RETRIES:-0", deploy)
        self.assertIn("--config cloudbuild.cloudrun.yaml", build)
        self.assertIn("--file=Dockerfile.cloudrun", cloudbuild)
        self.assertIn("DIVEDEEP_WORKER_BOOTSTRAP_TOKEN", worker)
        self.assertIn("WORKER_PROTOCOL_VERSION = 1", worker)
        self.assertIn("def get_checkpoints", worker)
        self.assertIn("if index in completed_indices", worker)
        self.assertIn("return 0", worker)
        self.assertIn("/tmp", worker)
        self.assertNotIn("verify=False", worker)
        self.assertNotIn("streamlit", (ROOT / "requirements-cloud-worker.txt").read_text(encoding="utf-8").lower())

    def test_release_declares_cloud_worker(self):
        release = json.loads((ROOT / "RELEASE.json").read_text(encoding="utf-8"))
        self.assertEqual(release["appVersion"], "5.29.0")
        self.assertIn("ephemeral-cloud-run-worker", release["features"])


if __name__ == "__main__":
    unittest.main()
