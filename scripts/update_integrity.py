"""Refresh studio integrity records using only already-allowlisted source files."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "release-manifest.json").read_text(encoding="utf-8"))
files = sorted(name[7:] for name in manifest["files"] if name.startswith("studio/"))
studio = root / "studio"
release_path = studio / "RELEASE.json"
release = json.loads(release_path.read_text(encoding="utf-8"))
release["checksums"] = {name: hashlib.sha256((studio / name).read_bytes()).hexdigest() for name in files if name not in {"RELEASE.json", "FILE_MANIFEST_SHA256.txt"}}
release_path.write_text(json.dumps(release, indent=2) + "\n", encoding="utf-8", newline="\n")
(studio / "FILE_MANIFEST_SHA256.txt").write_text("".join(f"{hashlib.sha256((studio / name).read_bytes()).hexdigest()}  {name}\n" for name in files if name != "FILE_MANIFEST_SHA256.txt"), encoding="utf-8", newline="\n")
print(f"Refreshed integrity records for {len(release['checksums'])} allowlisted studio files.")
