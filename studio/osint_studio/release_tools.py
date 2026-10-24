from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .release import load_release_manifest
from .runtime_state import read_state, set_drain
from .server_queue import ServerQueue

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_release(source: Path) -> dict[str, Any]:
    source = source.expanduser().resolve()
    manifest_path = source / "RELEASE.json"
    if not manifest_path.is_file():
        raise ValueError("RELEASE.json is missing from the release root.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("RELEASE.json must contain a JSON object.")
    version = str(manifest.get("appVersion") or "")
    if not VERSION_RE.fullmatch(version):
        raise ValueError("RELEASE.json contains an invalid appVersion.")
    required = manifest.get("requiredFiles") or []
    if not isinstance(required, list) or not required:
        raise ValueError("RELEASE.json must declare requiredFiles.")
    missing = [str(item) for item in required if not (source / str(item)).is_file()]
    if missing:
        raise ValueError(f"Release is missing required files: {', '.join(missing)}")
    checksums = manifest.get("checksums") or {}
    if not isinstance(checksums, dict) or not checksums:
        raise ValueError("RELEASE.json must declare file checksums.")
    mismatches: list[str] = []
    for relative, expected in checksums.items():
        path = source / str(relative)
        if not path.is_file() or sha256_file(path) != str(expected):
            mismatches.append(str(relative))
    if mismatches:
        raise ValueError(f"Release checksum verification failed: {', '.join(mismatches)}")
    package_version = (source / "osint_studio" / "__init__.py").read_text(encoding="utf-8")
    if version not in package_version:
        raise ValueError("Package version does not match RELEASE.json.")
    return manifest


def _backup_sqlite(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    input_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    output_connection = sqlite3.connect(destination)
    try:
        input_connection.backup(output_connection)
    finally:
        output_connection.close()
        input_connection.close()


def create_backup(data_root: Path, backup_root: Path) -> dict[str, Any]:
    data_root = data_root.expanduser().resolve()
    backup_root = backup_root.expanduser().resolve()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = backup_root / timestamp
    destination.mkdir(parents=True, mode=0o700)
    sqlite_files = sorted({*data_root.rglob("*.sqlite"), *data_root.rglob("*.sqlite3"), *data_root.rglob("*.db")})
    copied_databases: list[str] = []
    for source in sqlite_files:
        if not source.is_file():
            continue
        relative = source.relative_to(data_root)
        target = destination / "databases" / relative
        try:
            _backup_sqlite(source, target)
            copied_databases.append(str(relative))
        except sqlite3.Error:
            shutil.copy2(source, target)
            copied_databases.append(str(relative))
    metadata_archive = destination / "workspace-metadata.tar.gz"
    excluded_parts = {"raw", "evidence", "case-artifacts", "parquet", "browser", "exports", "backups"}
    with tarfile.open(metadata_archive, "w:gz") as archive:
        for path in sorted(data_root.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(data_root)
            if any(part in excluded_parts for part in relative.parts):
                continue
            if path.suffix.lower() not in {".json", ".jsonl", ".csv", ".txt", ".yaml", ".yml"}:
                continue
            archive.add(path, arcname=str(relative), recursive=False)
    summary = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "dataRoot": str(data_root),
        "backupDirectory": str(destination),
        "databases": copied_databases,
        "metadataArchive": metadata_archive.name,
    }
    (destination / "backup.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="DiveDeep release and maintenance utilities.")
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("source")
    backup = sub.add_parser("backup")
    backup.add_argument("--data-root", required=True)
    backup.add_argument("--backup-root", required=True)
    sub.add_parser("queue-stats")
    requeue = sub.add_parser("requeue-running")
    requeue.add_argument("--reason", default="Requeued during maintenance.")
    drain = sub.add_parser("drain")
    drain.add_argument("--reason", default="Scheduled maintenance")
    drain.add_argument("--requested-by", default="release-tools")
    sub.add_parser("resume")
    sub.add_parser("state")
    args = parser.parse_args()

    if args.command == "verify":
        result = verify_release(Path(args.source))
    elif args.command == "backup":
        result = create_backup(Path(args.data_root), Path(args.backup_root))
    elif args.command == "queue-stats":
        result = ServerQueue().stats()
    elif args.command == "requeue-running":
        result = {"requeued": ServerQueue().requeue_running(args.reason)}
    elif args.command == "drain":
        result = set_drain(True, reason=args.reason, requested_by=args.requested_by)
    elif args.command == "resume":
        result = set_drain(False)
    else:
        result = read_state()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
