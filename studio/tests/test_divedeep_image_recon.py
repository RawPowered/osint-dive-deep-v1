from __future__ import annotations

import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image

from osint_studio.divedeep_image_recon import import_image_bundle, inspect_image_bundle, load_image_session


class DiveDeepImageReconTests(unittest.TestCase):
    def _image_bytes(self) -> bytes:
        buffer = io.BytesIO()
        Image.new("RGB", (320, 240), (22, 96, 180)).save(buffer, format="JPEG", quality=90)
        return buffer.getvalue()

    def _bundle(self, image: bytes, *, extra_name: str | None = None) -> bytes:
        digest = hashlib.sha256(image).hexdigest()
        manifest = {
            "packetType": "divedeep.image-recon-intake",
            "schemaVersion": 1,
            "generatedAt": "2026-07-23T20:00:00.000Z",
            "customerId": "cust-123",
            "profileId": "profile-123",
            "customer": {"displayName": "Test Customer", "planTier": "image"},
            "authorization": {"status": "active", "revokedAt": None, "sensitiveContentAuthorized": True},
            "images": [
                {
                    "photoId": "photo-123",
                    "fileName": "reference-images/photo-123.jpg",
                    "mimeType": "image/jpeg",
                    "byteSize": len(image),
                    "sha256": digest,
                    "purpose": "identity_search",
                    "label": "Primary reference photo",
                }
            ],
        }
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            archive.writestr("reference-images/photo-123.jpg", image)
            if extra_name:
                archive.writestr(extra_name, b"unexpected")
        return output.getvalue()

    def _workspace(self, root: Path) -> Path:
        workspace = root / "cust-123"
        workspace.mkdir(parents=True)
        (workspace / "manifest.json").write_text(
            json.dumps(
                {
                    "workspaceType": "divedeep.manual-recon",
                    "customerId": "cust-123",
                    "profileId": "profile-123",
                    "displayName": "Test Customer",
                    "planTier": "image",
                    "importedAt": "2026-07-23T19:00:00.000Z",
                }
            ),
            encoding="utf-8",
        )
        return workspace

    def test_import_prepares_private_image_session(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._workspace(root)
            image = self._image_bytes()
            bundle = self._bundle(image)
            preview = inspect_image_bundle(bundle)
            self.assertEqual(preview["imageCount"], 1)
            imported = import_image_bundle("bundle.zip", bundle, workspace_root=root)
            session = Path(imported["session"])
            loaded = load_image_session(session)
            record = loaded["record"]
            self.assertEqual(record["customerId"], "cust-123")
            self.assertEqual(record["imageCount"], 1)
            prepared = record["images"][0]
            self.assertTrue((session / prepared["originalPath"]).is_file())
            self.assertTrue((session / prepared["normalizedPath"]).is_file())
            self.assertTrue((session / prepared["thumbnailPath"]).is_file())
            self.assertEqual(prepared["originalSha256"], hashlib.sha256(image).hexdigest())
            self.assertEqual(len(prepared["differenceHash"]), 16)
            self.assertEqual(loaded["queue"]["jobs"][0]["status"], "ready_for_search")

    def test_rejects_undeclared_or_unsafe_members(self) -> None:
        image = self._image_bytes()
        with self.assertRaisesRegex(ValueError, "undeclared files"):
            inspect_image_bundle(self._bundle(image, extra_name="extra.txt"))
        with self.assertRaisesRegex(ValueError, "Unsafe ZIP member"):
            inspect_image_bundle(self._bundle(image, extra_name="../escape.txt"))


if __name__ == "__main__":
    unittest.main()
