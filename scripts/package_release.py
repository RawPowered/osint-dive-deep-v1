"""Build allowlisted Windows/Linux source archives with published checksums."""
from pathlib import Path
import hashlib
import tarfile
import zipfile
from release_check import ROOT, validate

files = validate()
stem = "osint-dive-deep-v1-1.0.0"
destination = ROOT / "dist"
destination.mkdir(exist_ok=True)
with zipfile.ZipFile(destination / f"{stem}-windows.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        info = zipfile.ZipInfo(f"{stem}/{name}", (2026, 10, 24, 0, 0, 0))
        info.external_attr = ((0o100755 if name.endswith(".sh") else 0o100644) << 16)
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, (ROOT / name).read_bytes())
with tarfile.open(destination / f"{stem}-linux.tar.gz", "w:gz") as archive:
    for name in files:
        info = archive.gettarinfo(str(ROOT / name), arcname=f"{stem}/{name}")
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        info.mtime = 0
        info.mode = 0o755 if name.endswith(".sh") else 0o644
        with (ROOT / name).open("rb") as source:
            archive.addfile(info, source)
artifacts = sorted(destination.glob(f"{stem}-*"))
(destination / "SHA256SUMS.txt").write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in artifacts), encoding="utf-8", newline="\n")
print("Created Windows ZIP, Linux tar.gz, and SHA256SUMS.txt from the same complete source allowlist.")
