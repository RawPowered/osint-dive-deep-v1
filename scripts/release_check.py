"""Verify the explicit public source allowlist before staging or packaging."""
from pathlib import Path
import hashlib
import json
import math
import re
import subprocess
from collections import Counter

ROOT = Path(__file__).resolve().parents[1]
SECRET = re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")


def example(host):
    return host in {"localhost", "127.0.0.1", "example.com", "example.net", "example.org"} or host.endswith((".example", ".invalid", ".test", ".example.com", ".example.net", ".example.org"))


def validate_versions(root, manifest):
    """Distinguish product releases from component compatibility versions."""
    errors = []
    studio = json.loads((root / "studio/RELEASE.json").read_text(encoding="utf-8"))
    web = json.loads((root / "web/RELEASE.json").read_text(encoding="utf-8"))
    package = json.loads((root / "web/package.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "web/package-lock.json").read_text(encoding="utf-8"))
    matrix = json.loads((root / "web/deploy/compatibility/COMPATIBILITY_MATRIX.json").read_text(encoding="utf-8"))
    engine_source = (root / "studio/osint_studio/__init__.py").read_text(encoding="utf-8")
    engine = re.search(r'^__version__\s*=\s*"([^"]+)"', engine_source, re.M)
    engine_version = engine[1] if engine else None
    for label, actual in [("studio product", studio.get("product")), ("web product", web.get("product"))]:
        if actual != manifest.get("product"):
            errors.append(f"Version contract: {label} disagrees with release-manifest.json")
    for label, actual in [("studio release", studio.get("releaseVersion")), ("web release", web.get("releaseVersion"))]:
        if actual != manifest.get("version"):
            errors.append(f"Version contract: {label} disagrees with product release")
    if not re.fullmatch(r"\d+\.\d+\.\d+", manifest.get("version", "")):
        errors.append("Version contract: product release must use major.minor.patch")
    for label, actual in [("studio appVersion", studio.get("appVersion")), ("matrix worker tested", matrix.get("divedeepWorker", {}).get("tested"))]:
        if not engine_version or actual != engine_version:
            errors.append(f"Version contract: {label} disagrees with studio engine")
    backend = package.get("version")
    for label, actual in [("web version", web.get("version")), ("web appVersion", web.get("appVersion")), ("lock version", lock.get("version")), ("lock root version", lock.get("packages", {}).get("", {}).get("version")), ("matrix backend release", matrix.get("releaseVersion"))]:
        if not backend or actual != backend:
            errors.append(f"Version contract: {label} disagrees with web/package.json")
    if matrix.get("schemaVersion") != web.get("schemaVersion"):
        errors.append("Version contract: database schema versions disagree")
    config = (root / "web/src/config.js").read_text(encoding="utf-8")
    schema = re.search(r"SCHEMA_VERSION:\s*'([0-9]+)'", config)
    if not schema or int(schema[1]) != web.get("schemaVersion"):
        errors.append("Version contract: runtime database schema disagrees with metadata")
    protocol = matrix.get("divedeepWorker", {}).get("protocol")
    if protocol != f"divedeep-worker-v{studio.get('workerProtocolVersion')}":
        errors.append("Version contract: worker protocol versions disagree")
    return errors


def validate(root=ROOT):
    manifest = json.loads((root / "release-manifest.json").read_text(encoding="utf-8"))
    policy = json.loads((root / "release-policy.json").read_text(encoding="utf-8"))
    approved = manifest["files"]
    errors = validate_versions(root, manifest)
    if not approved or len(approved) != len(set(approved)):
        raise ValueError("Invalid source allowlist")
    for name in approved:
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name:
            errors.append("Invalid allowlist path")
            continue
        path = root / relative
        if not path.is_file() or path.is_symlink():
            errors.append(f"{name}: missing regular source file")
            continue
        if set(relative.parts) & {".git", ".venv", "node_modules", "__pycache__", "output", "tmp", "dist", "cases", "exports", "profiles", "drafts"} or re.search(r"\.(?:sqlite\d*|duckdb|db|parquet|jsonl|log|zip|pem|key|pfx|p12)$", name, re.I) or (relative.name.startswith(".env") and relative.name != ".env.example"):
            errors.append(f"{name}: prohibited runtime or private file")
        data = path.read_bytes()
        if name.endswith(".png"):
            entry = manifest.get("documentationMedia", {}).get(name)
            if not name.startswith("docs/assets/screenshots/") or not entry or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                errors.append(f"{name}: screenshot has not been reviewed")
            continue
        try:
            source = data.decode("utf-8")
        except UnicodeDecodeError:
            errors.append(f"{name}: unapproved binary file")
            continue
        if SECRET.search(source):
            errors.append(f"{name}: possible credential")
        legacy_terms = ["forget" + "id", "nightin" + "gale", "flock" + "sync", "novaedge" + "solutions", "sun" + "prise"]
        if any(term in source.lower() for term in legacy_terms):
            errors.append(f"{name}: legacy installation reference")
        for match in re.finditer(r"https?://([a-zA-Z0-9.-]+)", source):
            host = match[1].lower()
            if not host.strip("."):
                continue
            if not example(host) and host not in policy["publicProviderHosts"]:
                errors.append(f"{name}: unreviewed URL host")
        for match in re.finditer(r"[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})", source):
            if not example(match[1].lower()) and not (name == "web/package-lock.json" and match[1] == "izs.me"):
                errors.append(f"{name}: non-example email")
        if relative.name != "package-lock.json":
            for match in re.finditer(r'''["'`]([A-Za-z0-9+/_=-]{20,})["'`]''', source):
                value = match[1]
                entropy = -sum(c / len(value) * math.log2(c / len(value)) for c in Counter(value).values())
                if re.search("[a-z]", value) and re.search("[A-Z]", value) and re.search("[0-9]", value) and entropy > 4.2:
                    digest = hashlib.sha256(value.encode()).hexdigest()
                    if digest not in policy["reviewedLiteralHashes"]:
                        errors.append(f"{name}: high-entropy literal needs review")
        if name.endswith(".example"):
            for match in re.finditer(r"^(?:export )?([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|ORIGIN|ORIGINS|URL|FIELD_ID|EMAIL|ENTITY_NAME|ALLOWED_HOSTS))=(.*)$", source, re.M):
                if match[2].strip():
                    errors.append(f"{name}: {match[1]} must be blank")
    tracked = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True)
    if tracked.returncode == 0:
        for name in tracked.stdout.decode().split("\0"):
            if name and name not in approved:
                errors.append(f"{name}: tracked outside source allowlist")
    if errors:
        raise ValueError("\n".join(sorted(set(errors))))
    print(f"Release check passed: {len(approved)} approved files; no credential or private installation findings.")
    return approved


if __name__ == "__main__":
    validate()
