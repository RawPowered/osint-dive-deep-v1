from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class DiveDeepImageReconPhase2Tests(unittest.TestCase):
    def test_candidate_review_and_promotion_round_trip(self) -> None:
        script = r'''
import hashlib
import io
import json
import zipfile
from pathlib import Path
from PIL import Image
from osint_studio.divedeep_ops import import_uploaded_packet, load_workspace_bundle
from osint_studio.divedeep_image_recon import (
    add_image_candidate,
    import_image_bundle,
    load_image_session,
    promote_candidate,
    update_candidate_review,
    update_provider_run,
)

root = Path(r"%s")
workspaces = root / "workspaces"
packet = {
    "schemaVersion": 2,
    "product": "OSINT Dive Deep v1",
    "exportedAt": "2026-07-23T20:00:00.000Z",
    "customer": {
        "id": "cust-123",
        "email": "test@example.com",
        "displayName": "Test Customer",
        "planTier": "image",
        "authorizationAffirmedAt": "2026-07-23T20:00:00.000Z",
    },
    "divedeep": {
        "profile": {
            "id": "profile-123",
            "jurisdictionCountry": "US",
            "jurisdictionRegion": "FL",
            "identifiers": [
                {"id": "name-1", "type": "name", "value": "Test Customer", "status": "active", "isPrimary": True},
                {"id": "email-1", "type": "email", "value": "test@example.com", "status": "active", "isPrimary": True},
            ],
            "policies": [{"scopeType": "default", "scopeValue": "", "action": "remove"}],
            "authorization": {
                "status": "active",
                "requesterRole": "self",
                "requesterName": "Test Customer",
                "requesterEmail": "test@example.com",
                "signedAt": "2026-07-23T20:00:00.000Z",
                "revokedAt": None,
            },
        },
        "exposures": [], "cases": [], "verifications": [], "events": [], "jobs": [],
    },
    "connections": [],
    "photos": [],
    "manualProcessing": {"sourceSets": ["authorized-image-match-review"], "instructions": ["Authorized test"]},
}
packet_path = root / "divedeep.json"
packet_path.write_text(json.dumps(packet), encoding="utf-8")
imported = import_uploaded_packet(packet_path.name, packet_path.read_bytes(), workspace_root=workspaces)
workspace = Path(imported["workspace"])

def image_bytes(color):
    output = io.BytesIO()
    Image.new("RGB", (320, 240), color).save(output, format="JPEG", quality=92)
    return output.getvalue()

reference = image_bytes((30, 90, 180))
manifest = {
    "packetType": "divedeep.image-recon-intake",
    "schemaVersion": 1,
    "generatedAt": "2026-07-23T20:10:00.000Z",
    "customerId": "cust-123",
    "profileId": "profile-123",
    "customer": {"displayName": "Test Customer", "planTier": "image"},
    "authorization": {"status": "active", "revokedAt": None, "sensitiveContentAuthorized": True},
    "images": [{
        "photoId": "photo-123",
        "fileName": "reference-images/photo-123.jpg",
        "mimeType": "image/jpeg",
        "byteSize": len(reference),
        "sha256": hashlib.sha256(reference).hexdigest(),
        "purpose": "identity_search",
        "label": "Primary reference",
    }],
}
archive_bytes = io.BytesIO()
with zipfile.ZipFile(archive_bytes, "w", compression=zipfile.ZIP_STORED) as archive:
    archive.writestr("manifest.json", json.dumps(manifest))
    archive.writestr("reference-images/photo-123.jpg", reference)
image_session = import_image_bundle("images.zip", archive_bytes.getvalue(), workspace_root=workspaces)
session = Path(image_session["session"])
update_provider_run(session, "photo-123", "tineye", "in_progress", "Started")
update_provider_run(session, "photo-123", "tineye", "completed", "Reviewed")

candidate_image = image_bytes((32, 92, 178))
candidate = add_image_candidate(
    session,
    photo_id="photo-123",
    provider_key="tineye",
    source_url="https://example.com/public/photo",
    candidate_filename="candidate.jpg",
    candidate_data=candidate_image,
    source_name="Example",
    associated_name="Test Customer",
    notes="Synthetic candidate",
)
assert candidate["decision"] == "pending_review"
reviewed = update_candidate_review(
    session,
    candidate["candidateId"],
    decision="confirmed_match",
    operator_confidence=0.97,
    visual_similarity=0.94,
    signals={"name": "strong", "username": "none", "location": "weak", "context": "strong"},
    associated_name="Test Customer",
    review_notes="Confirmed through image and name context.",
)
assert reviewed["decision"] == "confirmed_match"
promoted = promote_candidate(session, candidate["candidateId"])
assert promoted["findingKey"].startswith("image-")
bundle = load_workspace_bundle(workspace)
assert len(bundle["results"]["findings"]) == 1
assert bundle["results"]["findings"][0]["status"] == "confirmed"
assert bundle["results"]["findings"][0]["contentCategory"] == "image-match"

# Exact candidate images are retained as duplicate review items and cannot be promoted.
duplicate = add_image_candidate(
    session,
    photo_id="photo-123",
    provider_key="manual_source",
    source_url="https://example.net/repost",
    candidate_filename="candidate-copy.jpg",
    candidate_data=candidate_image,
)
assert duplicate["decision"] == "duplicate"
try:
    promote_candidate(session, duplicate["candidateId"])
    raise AssertionError("duplicate promotion should fail")
except ValueError:
    pass

loaded = load_image_session(session)
assert len(loaded["candidates"]["candidates"]) == 2
print(json.dumps({"ok": True, "session": str(session)}))
''' % str(Path(tempfile.gettempdir()) / "placeholder")
        with tempfile.TemporaryDirectory() as temporary:
            script = script.replace(str(Path(tempfile.gettempdir()) / "placeholder"), temporary)
            env = {
                **os.environ,
                "PYTHONPATH": str(ROOT),
                "OSINT_STUDIO_DATA_DIR": str(Path(temporary) / "data"),
            }
            result = subprocess.run(
                [sys.executable, "-c", script],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertTrue(json.loads(result.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
