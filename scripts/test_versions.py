"""Release-contract regressions: reject partial release bumps and broken handshakes."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from release_check import ROOT, validate_versions


class VersionContractTests(unittest.TestCase):
    def test_current_versions_agree(self):
        manifest = json.loads((ROOT / "release-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(validate_versions(ROOT, manifest), [])

    def test_partial_release_and_protocol_changes_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["studio/RELEASE.json", "studio/osint_studio/__init__.py", "web/RELEASE.json", "web/package.json", "web/package-lock.json", "web/src/config.js", "web/deploy/compatibility/COMPATIBILITY_MATRIX.json"]:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            manifest = json.loads((ROOT / "release-manifest.json").read_text(encoding="utf-8"))
            manifest["version"] = "9.9.9"
            self.assertTrue(any("product release" in error for error in validate_versions(root, manifest)))
            manifest["version"] = json.loads((ROOT / "release-manifest.json").read_text(encoding="utf-8"))["version"]
            target = root / "studio/RELEASE.json"
            studio = json.loads(target.read_text(encoding="utf-8"))
            studio["workerProtocolVersion"] = "999"
            target.write_text(json.dumps(studio), encoding="utf-8")
            self.assertTrue(any("worker protocol" in error for error in validate_versions(root, manifest)))


if __name__ == "__main__":
    unittest.main()
