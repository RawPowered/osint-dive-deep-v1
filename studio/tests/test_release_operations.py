from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from osint_studio.release import compatibility_payload
from osint_studio.release_tools import verify_release
from osint_studio.runtime_state import is_draining, read_state, set_drain
from osint_studio.server_queue import ServerQueue


class ReleaseOperationsTests(unittest.TestCase):
    def test_runtime_drain_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_file = Path(temporary) / "system-state.json"
            with patch.dict(os.environ, {"DIVEDEEP_STATE_FILE": str(state_file)}):
                self.assertFalse(is_draining())
                state = set_drain(True, reason="Upgrade", requested_by="test")
                self.assertTrue(state["drain"]["enabled"])
                self.assertTrue(is_draining())
                self.assertEqual(read_state()["drain"]["reason"], "Upgrade")
                set_drain(False)
                self.assertFalse(is_draining())

    def test_queue_stats_and_requeue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            queue = ServerQueue(Path(temporary) / "queue.sqlite")
            workspace = Path(temporary) / "workspace"
            workspace.mkdir()
            first = queue.enqueue("export_results", workspace, {})
            second = queue.enqueue("export_results", workspace, {})
            claimed = queue.claim_next("worker:test")
            self.assertEqual(claimed["id"], first["id"])
            stats = queue.stats()
            self.assertEqual(stats["running"], 1)
            self.assertEqual(stats["queued"], 1)
            self.assertEqual(queue.requeue_running("maintenance"), 1)
            self.assertEqual(queue.stats()["queued"], 2)
            self.assertEqual(queue.get(first["id"])["status"], "queued")
            self.assertEqual(queue.get(second["id"])["status"], "queued")

    def test_compatibility_contract(self) -> None:
        payload = compatibility_payload()
        self.assertEqual(payload["appVersion"], "5.29.0")
        self.assertEqual(payload["apiVersion"], "1.1")
        self.assertIn("drain-mode", payload["features"])
        self.assertIn("versioned-releases", payload["features"])
        self.assertIn("ephemeral-cloud-run-worker", payload["features"])
        self.assertEqual(payload["workerProtocolVersion"], "1")
        self.assertEqual(payload["intakeSchemas"], [2])

    def test_release_manifest_verifies(self) -> None:
        source = Path(__file__).resolve().parents[1]
        manifest = verify_release(source)
        self.assertEqual(manifest["appVersion"], "5.29.0")

    def test_api_rejects_new_work_while_draining(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_file = Path(temporary) / "system-state.json"
            with patch.dict(os.environ, {"DIVEDEEP_STATE_FILE": str(state_file)}):
                set_drain(True, reason="Upgrade", requested_by="test")
                from osint_studio.server_api import _ensure_accepting_work
                with self.assertRaises(HTTPException) as raised:
                    _ensure_accepting_work()
                self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
