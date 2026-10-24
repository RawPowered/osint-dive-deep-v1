from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from osint_studio.cloud_worker import WorkerConfig, candidate_payloads, manifest_to_packet, stable_attempt_id, wipe_directory


class CloudWorkerTests(unittest.TestCase):
    def test_manifest_builds_schema_two_packet(self):
        manifest = {
            "jobId": "job-1",
            "createdAt": "2026-07-25T00:00:00Z",
            "package": {"packageId": "deep", "version": 2},
            "sourceSet": {"versionId": "set-v1"},
            "sourcePools": [],
            "resources": [],
            "authorizedInput": {
                "schemaVersion": 2,
                "product": "OSINT Dive Deep v1",
                "customer": {"id": "customer-1", "planTier": "deep"},
                "authorization": {"id": "auth-1", "status": "active"},
                "divedeep": {"profile": {"id": "profile-1", "authorization": {"status": "active"}}},
                "manualProcessing": {"serviceLevel": "deep", "instructions": []},
            },
        }
        packet = manifest_to_packet(manifest)
        self.assertEqual(packet["schemaVersion"], 2)
        self.assertEqual(packet["product"], "OSINT Dive Deep v1")
        self.assertEqual(packet["customer"]["id"], "customer-1")
        self.assertEqual(packet["manualProcessing"]["serviceLevel"], "deep")

    def test_candidate_payload_requires_review_and_blurs_images(self):
        job = {"tool": "ddgs-images", "targetType": "name", "target": "Authorized Name"}
        records = [{"url": "https://example.test/post", "sourceName": "Example", "notes": "Candidate", "category": "image", "subject": "Authorized Name", "artifactIds": ["raw-artifact", "blurred-artifact"], "evidenceArtifactId": "raw-artifact", "previewArtifactId": "blurred-artifact"}]
        payload = candidate_payloads(records, job, "attempt-1", "source-attempt-db-id", 3)[0]
        self.assertEqual(payload["sourceAttemptId"], "source-attempt-db-id")
        self.assertEqual(payload["reviewBand"], "manual_review")
        self.assertTrue(payload["normalized"]["humanReviewRequired"])
        self.assertTrue(payload["normalized"]["blurredPresentationRequired"])
        self.assertEqual(payload["artifactIds"], ["raw-artifact", "blurred-artifact"])
        self.assertEqual(payload["normalized"]["previewArtifactId"], "blurred-artifact")

    def test_attempt_id_is_stable(self):
        job = {"tool": "ddgs-text", "targetType": "username", "target": "sample"}
        self.assertEqual(stable_attempt_id("job", 1, job), stable_attempt_id("job", 1, job))

    def test_environment_enforces_single_task_and_https(self):
        env = {
            "DIVEDEEP_API_ORIGIN": "https://api.divedeep.example",
            "DIVEDEEP_RECON_JOB_ID": "job-1",
            "DIVEDEEP_RECON_EXECUTION_ID": "execution-1",
            "DIVEDEEP_WORKER_POOL_VERSION_ID": "pool-v1",
            "DIVEDEEP_WORKER_BOOTSTRAP_TOKEN": "bootstrap",
            "CLOUD_RUN_TASK_INDEX": "0",
        }
        with patch.dict(os.environ, env, clear=True):
            config = WorkerConfig.from_environment()
            self.assertEqual(config.task_index, 0)
            self.assertEqual(config.api_path, "/api/workers/v1")
        env["CLOUD_RUN_TASK_INDEX"] = "1"
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(RuntimeError, "exactly one task"):
                WorkerConfig.from_environment()

    def test_ephemeral_workspace_is_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "worker"
            root.mkdir()
            (root / "candidate.jpg").write_bytes(b"test")
            wipe_directory(root)
            self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
