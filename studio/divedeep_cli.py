from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from osint_studio.divedeep_bridge import export_results, import_packet, record_findings, validate_result_packet


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manual DiveDeep <-> DiveDeep JSON bridge.")
    commands = parser.add_subparsers(dest="command", required=True)

    import_command = commands.add_parser("import", help="Create or refresh a local DiveDeep workspace from a DiveDeep export.")
    import_command.add_argument("packet", type=Path)
    import_command.add_argument("--workspace-root", type=Path)

    record = commands.add_parser("record", help="Record one finding or a batch of findings into the local workspace.")
    record.add_argument("workspace", type=Path)
    record.add_argument("finding", type=Path)

    export = commands.add_parser("export", help="Create the JSON packet to import in DiveDeep Admin.")
    export.add_argument("workspace", type=Path)
    export.add_argument("--output", type=Path)

    validate = commands.add_parser("validate-results", help="Validate a DiveDeep result packet without importing it.")
    validate.add_argument("packet", type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "import":
        print_json(import_packet(args.packet, workspace_root=args.workspace_root))
        return 0
    if args.command == "record":
        print_json(record_findings(args.workspace, args.finding))
        return 0
    if args.command == "export":
        print_json(export_results(args.workspace, args.output))
        return 0
    if args.command == "validate-results":
        packet = json.loads(args.packet.read_text(encoding="utf-8"))
        validate_result_packet(packet)
        print_json({"ok": True, "findings": len(packet.get("findings", []))})
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
