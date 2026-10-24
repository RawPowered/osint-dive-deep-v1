from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class DiveDeepSegmentedExportTests(unittest.TestCase):
    def test_segmented_bundle_splits_json_and_carries_separate_evidence(self) -> None:
        script = r'''
import hashlib
import io
import json
import zipfile
from pathlib import Path
from PIL import Image
from osint_studio.divedeep_ops import import_uploaded_packet, record_payload
from osint_studio.divedeep_image_recon import add_image_candidate, import_image_bundle, promote_candidate, update_candidate_review
from osint_studio.divedeep_segmented_export import create_segmented_result_bundle, inspect_segmented_result_bundle

root = Path(r"%s")
workspaces = root / "workspaces"
packet = {
    "schemaVersion": 2,
    "product": "OSINT Dive Deep v1",
    "exportedAt": "2026-07-23T20:00:00.000Z",
    "customer": {"id": "cust-phase3", "email": "test@example.com", "displayName": "Phase Three", "planTier": "image", "authorizationAffirmedAt": "2026-07-23T20:00:00.000Z"},
    "divedeep": {"profile": {
        "id": "profile-phase3", "jurisdictionCountry": "US", "jurisdictionRegion": "FL",
        "identifiers": [{"id": "name-1", "type": "name", "value": "Phase Three", "status": "active", "isPrimary": True}],
        "policies": [{"scopeType": "default", "scopeValue": "", "action": "remove"}],
        "authorization": {"status": "active", "requesterRole": "self", "requesterName": "Phase Three", "requesterEmail": "test@example.com", "signedAt": "2026-07-23T20:00:00.000Z", "revokedAt": None}
    }, "exposures": [], "cases": [], "verifications": [], "events": [], "jobs": []},
    "connections": [], "photos": [], "manualProcessing": {"sourceSets": ["authorized-image-match-review"], "instructions": ["Authorized test"]}
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
    "packetType": "divedeep.image-recon-intake", "schemaVersion": 1,
    "generatedAt": "2026-07-23T20:10:00.000Z", "customerId": "cust-phase3", "profileId": "profile-phase3",
    "customer": {"displayName": "Phase Three", "planTier": "image"},
    "authorization": {"status": "active", "revokedAt": None, "sensitiveContentAuthorized": True},
    "images": [{"photoId": "photo-phase3", "fileName": "reference-images/photo-phase3.jpg", "mimeType": "image/jpeg", "byteSize": len(reference), "sha256": hashlib.sha256(reference).hexdigest(), "purpose": "identity_search", "label": "Primary"}]
}
archive_bytes = io.BytesIO()
with zipfile.ZipFile(archive_bytes, "w", compression=zipfile.ZIP_STORED) as archive:
    archive.writestr("manifest.json", json.dumps(manifest))
    archive.writestr("reference-images/photo-phase3.jpg", reference)
image_session = import_image_bundle("images.zip", archive_bytes.getvalue(), workspace_root=workspaces)
session = Path(image_session["session"])
candidate_image = image_bytes((32, 92, 178))
candidate = add_image_candidate(session, photo_id="photo-phase3", provider_key="tineye", source_url="https://example.com/public/photo", candidate_filename="candidate.jpg", candidate_data=candidate_image, source_name="Example")
update_candidate_review(session, candidate["candidateId"], decision="confirmed_match", operator_confidence=0.97, visual_similarity=0.94, signals={"name": "strong", "context": "strong"}, review_notes="Confirmed.")
promote_candidate(session, candidate["candidateId"])
for index in range(8):
    record_payload(workspace, {"findingKey": f"synthetic-{index}", "sourceName": f"Source {index}", "listingUrl": f"https://example.org/profile/{index}", "status": "confirmed", "contentCategory": "people-search", "matchConfidence": 0.9, "notes": (f"Reviewed synthetic finding {index}. " * 65)})
created = create_segmented_result_bundle(session, scope="workspace", target_part_bytes=8 * 1024, hard_part_bytes=16 * 1024, max_findings_per_part=3)
assert created["partCount"] >= 3
assert created["evidenceFileCount"] == 1
zip_path = Path(created["zipPath"])
verified = inspect_segmented_result_bundle(zip_path)
assert verified["findingCount"] == 9
assert verified["partCount"] == created["partCount"]
assert verified["evidenceFileCount"] == 1
with zipfile.ZipFile(zip_path, "r") as archive:
    for expected_part, part in enumerate(verified["parts"], start=1):
        assert part["partNumber"] == expected_part
        payload = archive.read(part["fileName"])
        assert len(payload) == part["byteSize"]
        assert len(payload) <= 16 * 1024
        result_packet = json.loads(payload)
        assert result_packet["batch"]["part"] == expected_part
        assert result_packet["batch"]["totalParts"] == created["partCount"]
        assert [finding["findingKey"] for finding in result_packet["findings"]] == part["findingKeys"]
        assert all("local" not in finding for finding in result_packet["findings"])
    evidence = verified["evidence"][0]
    evidence_payload = archive.read(evidence["fileName"])
    assert len(evidence_payload) == evidence["byteSize"]
    assert evidence["mimeType"] == "image/jpeg"
    assert evidence["uploadRequired"] is True
print(json.dumps({"ok": True, "parts": created["partCount"]}))
''' % str(Path(tempfile.gettempdir()) / "placeholder")
        with tempfile.TemporaryDirectory() as temporary:
            script = script.replace(str(Path(tempfile.gettempdir()) / "placeholder"), temporary)
            env = {**os.environ, "PYTHONPATH": str(ROOT), "OSINT_STUDIO_DATA_DIR": str(Path(temporary) / "data")}
            result = subprocess.run([sys.executable, "-c", script], cwd=ROOT, env=env, check=True, text=True, capture_output=True)
            output = json.loads(result.stdout)
            self.assertTrue(output["ok"])
            self.assertGreaterEqual(output["parts"], 3)


if __name__ == "__main__":
    unittest.main()
