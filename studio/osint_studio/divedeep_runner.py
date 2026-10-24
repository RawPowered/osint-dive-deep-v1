from __future__ import annotations

import argparse
import sys

from .divedeep_ops import execute_job_direct


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Execute one allowlisted DiveDeep job from run.sh")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--index", required=True, type=int)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args(argv)

    previous = ""

    def emit(preview: str) -> None:
        nonlocal previous
        if preview.startswith(previous):
            delta = preview[len(previous) :]
        else:
            delta = preview
        if delta:
            print(delta, end="", flush=True)
        previous = preview

    result = execute_job_direct(args.workspace, args.index, timeout_seconds=args.timeout, on_output=emit)
    if result.output and not previous:
        print(result.output, end="" if result.output.endswith("\n") else "\n")
    if result.error:
        print(result.error, file=sys.stderr)
    if result.timed_out:
        return 124
    return int(result.return_code or 0)


if __name__ == "__main__":
    raise SystemExit(main())
