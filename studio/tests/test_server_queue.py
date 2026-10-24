from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from osint_studio.server_queue import ServerQueue


class ServerQueueTests(unittest.TestCase):
    def test_queue_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            queue = ServerQueue(Path(directory) / "queue.sqlite")
            created = queue.enqueue("run_jobs", Path(directory), {"indices": [1, 2]})
            self.assertEqual(created["status"], "queued")
            claimed = queue.claim_next("test-worker")
            self.assertEqual(claimed["id"], created["id"])
            self.assertEqual(claimed["status"], "running")
            queue.progress(created["id"], 1, 2, "First complete")
            queue.complete(created["id"], {"completedCount": 2})
            finished = queue.get(created["id"])
            self.assertEqual(finished["status"], "completed")
            self.assertEqual(finished["result"]["completedCount"], 2)
            self.assertTrue(finished["events"])

    def test_cancel_queued_job(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            queue = ServerQueue(Path(directory) / "queue.sqlite")
            created = queue.enqueue("export_results", Path(directory), {})
            self.assertTrue(queue.cancel(created["id"]))
            self.assertEqual(queue.get(created["id"])["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
