from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from osint_studio.case_store import CaseStore
from osint_studio.paths import CASE_ARTIFACT_ROOT, CASE_DATABASE_PATH


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage local OSINT Studio cases and migrate v5 data.")
    parser.add_argument("--database", type=Path, default=CASE_DATABASE_PATH)
    parser.add_argument("--artifacts", type=Path, default=CASE_ARTIFACT_ROOT)
    commands = parser.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create", help="Create an empty case.")
    create.add_argument("name")
    create.add_argument("--mode", choices=("research", "analysis"), default="research")
    create.add_argument("--objective", default="")

    list_command = commands.add_parser("list", help="List cases.")
    list_command.add_argument("--limit", type=int, default=100)

    show = commands.add_parser("show", help="Show a case and record counts.")
    show.add_argument("case_id")

    import_job = commands.add_parser("import-discovery", help="Import a v5 discovery SQLite job.")
    import_job.add_argument("source", type=Path)
    import_job.add_argument("--case-id")
    import_job.add_argument("--case-name")

    import_template = commands.add_parser("import-template", help="Attach and normalize a v5 hunt template.")
    import_template.add_argument("case_id")
    import_template.add_argument("source", type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    store = CaseStore(args.database, args.artifacts)

    if args.command == "create":
        case_id = store.create_case(args.name, mode=args.mode, objective=args.objective)
        print_json({"case_id": case_id, "case": store.get_case(case_id)})
        return 0
    if args.command == "list":
        print_json(store.list_cases(args.limit))
        return 0
    if args.command == "show":
        case = store.get_case(args.case_id)
        if not case:
            raise SystemExit(f"Unknown case: {args.case_id}")
        print_json({"case": case, "stats": store.case_stats(args.case_id)})
        return 0
    if args.command == "import-discovery":
        print_json(
            store.import_discovery_job(
                args.source,
                case_id=args.case_id,
                case_name=args.case_name,
            )
        )
        return 0
    if args.command == "import-template":
        print_json(store.import_hunt_template(args.case_id, args.source))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
