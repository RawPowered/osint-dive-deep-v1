#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from osint_studio.hunt_profiles import (
    PROFILE_ROOT,
    TemplateValidationError,
    all_profiles,
    load_profile_json,
    profile_summary,
    save_custom_profile,
    starter_profile,
)


def write_json(payload: dict, output: str | None) -> None:
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    if output:
        Path(output).expanduser().write_text(text, encoding="utf-8")
    else:
        print(text, end="")


def load_path(path: str) -> tuple[dict, list[str]]:
    file_path = Path(path).expanduser()
    if not file_path.exists():
        raise TemplateValidationError([f"Template file does not exist: {file_path}"])
    return load_profile_json(file_path.read_bytes())


def command_validate(args: argparse.Namespace) -> int:
    profile, warnings = load_path(args.path)
    print(json.dumps(profile_summary(profile), indent=2, ensure_ascii=False))
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    print("VALID", file=sys.stderr)
    return 0


def command_normalize(args: argparse.Namespace) -> int:
    profile, warnings = load_path(args.path)
    write_json(profile, args.output)
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    return 0


def command_install(args: argparse.Namespace) -> int:
    profile, warnings = load_path(args.path)
    path = save_custom_profile(profile, args.name)
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    print(path)
    return 0


def command_starter(args: argparse.Namespace) -> int:
    write_json(starter_profile(), args.output)
    return 0


def command_list(_args: argparse.Namespace) -> int:
    rows = []
    for name, profile in all_profiles().items():
        summary = profile_summary(profile)
        rows.append(
            {
                "name": name,
                "template_id": summary["template_id"],
                "query_templates": summary["query_templates"],
                "rules": summary["rules"],
                "extractors": summary["extractors"],
            }
        )
    print(json.dumps({"profile_root": str(PROFILE_ROOT), "templates": rows}, indent=2, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate, normalize, install, and list OSINT Query Studio JSON hunt templates."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="Validate a JSON template and print its summary.")
    validate.add_argument("path")
    validate.set_defaults(func=command_validate)

    normalize = subparsers.add_parser("normalize", help="Migrate and rewrite a template into canonical v2 JSON.")
    normalize.add_argument("path")
    normalize.add_argument("-o", "--output")
    normalize.set_defaults(func=command_normalize)

    install = subparsers.add_parser("install", help="Validate and install a template into the local template library.")
    install.add_argument("path")
    install.add_argument("--name", help="Optional replacement display name.")
    install.set_defaults(func=command_install)

    starter = subparsers.add_parser("starter", help="Print or save a canonical starter template.")
    starter.add_argument("-o", "--output")
    starter.set_defaults(func=command_starter)

    list_command = subparsers.add_parser("list", help="List built-in, bundled, and installed templates.")
    list_command.set_defaults(func=command_list)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except TemplateValidationError as exc:
        print("INVALID TEMPLATE", file=sys.stderr)
        for error in exc.errors:
            print(f"- {error}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
