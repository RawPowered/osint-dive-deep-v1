from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from osint_studio.paths import ensure_private_directory, resolve_cache_root, resolve_data_root


class PathTests(unittest.TestCase):
    def test_explicit_roots_take_priority(self) -> None:
        values = {
            "OSINT_STUDIO_DATA_DIR": "/case-data",
            "OSINT_STUDIO_CACHE_DIR": "/case-cache",
            "XDG_DATA_HOME": "/ignored-data",
            "XDG_CACHE_HOME": "/ignored-cache",
        }
        self.assertEqual(resolve_data_root(values), Path("/case-data"))
        self.assertEqual(resolve_cache_root(values), Path("/case-cache"))

    def test_xdg_roots_are_supported(self) -> None:
        values = {"XDG_DATA_HOME": "/xdg-data", "XDG_CACHE_HOME": "/xdg-cache"}
        self.assertEqual(resolve_data_root(values), Path("/xdg-data/osint-dive-deep"))
        self.assertEqual(resolve_cache_root(values), Path("/xdg-cache/osint-dive-deep"))

    def test_default_roots_are_under_home(self) -> None:
        home = Path("operator-home")
        self.assertEqual(resolve_data_root({}, home), home / ".local/share/osint-dive-deep")
        self.assertEqual(resolve_cache_root({}, home), home / ".cache/osint-dive-deep")

    def test_private_directory_is_created(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "nested" / "data"
            self.assertEqual(ensure_private_directory(path), path)
            self.assertTrue(path.is_dir())


if __name__ == "__main__":
    unittest.main()
