from __future__ import annotations

import json
import re
import subprocess
from dataclasses import asdict
from datetime import datetime, timezone

from .models import DiscoveredTool, HelpOption, HelpSnapshot
from .paths import CACHE_ROOT, ensure_private_directory


CACHE_DIR = CACHE_ROOT
OPTION_LINE = re.compile(
    r"^\s*((?:-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*(?:[ =][A-Z][A-Z0-9_\-\[\]<>.]*)?)(?:\s*,?\s*-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*(?:[ =][A-Z][A-Z0-9_\-\[\]<>.]*)?)*)\s{2,}(.*)$"
)
FLAG_RE = re.compile(r"-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*")
METAVAR_RE = re.compile(r"(?:=|\s)([A-Z][A-Z0-9_\-\[\]<>.]*)$")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _snapshot_path(tool_key: str) -> Path:
    return ensure_private_directory(CACHE_DIR) / f"{tool_key}.json"


def _option_from_line(left: str, description: str) -> HelpOption | None:
    flags = tuple(FLAG_RE.findall(left))
    if not flags:
        return None
    metavar_match = METAVAR_RE.search(left)
    metavar = metavar_match.group(1) if metavar_match else ""
    lower_description = description.lower()
    repeatable = any(word in lower_description for word in ("repeat", "multiple", "may be specified"))
    return HelpOption(
        flags=flags,
        metavar=metavar,
        description=" ".join(description.split()),
        takes_value=bool(metavar),
        repeatable=repeatable,
    )


def parse_help_options(text: str) -> list[HelpOption]:
    options: list[HelpOption] = []
    seen: set[tuple[str, ...]] = set()
    pending: HelpOption | None = None

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        match = OPTION_LINE.match(line)
        if match:
            option = _option_from_line(match.group(1), match.group(2))
            if option and option.flags not in seen:
                options.append(option)
                seen.add(option.flags)
                pending = option
            continue

        if pending and line.startswith(("    ", "\t")) and line.strip() and not line.lstrip().startswith("-"):
            replacement = HelpOption(
                flags=pending.flags,
                metavar=pending.metavar,
                description=(pending.description + " " + line.strip()).strip(),
                takes_value=pending.takes_value,
                repeatable=pending.repeatable,
            )
            options[-1] = replacement
            pending = replacement
        elif line.strip():
            pending = None

    return options


def capture_help(tool: DiscoveredTool, timeout: int = 15, force: bool = False) -> HelpSnapshot:
    if not tool.executable:
        return HelpSnapshot(
            tool_key=tool.spec.key,
            executable="",
            invocation=[],
            text="",
            error="Tool executable was not found in PATH.",
            captured_at=_utc_now(),
            return_code=127,
        )

    cache_path = _snapshot_path(tool.spec.key)
    if cache_path.exists() and not force:
        try:
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
            payload["options"] = [HelpOption(**item) for item in payload.get("options", [])]
            return HelpSnapshot(**payload)
        except (OSError, ValueError, TypeError):
            pass

    best: HelpSnapshot | None = None
    for variant in tool.spec.help_variants:
        argv = [tool.executable, *variant]
        try:
            completed = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
            text = "\n".join(part for part in (completed.stdout, completed.stderr) if part).strip()
            snapshot = HelpSnapshot(
                tool_key=tool.spec.key,
                executable=tool.executable,
                invocation=argv,
                text=text,
                options=parse_help_options(text),
                captured_at=_utc_now(),
                return_code=completed.returncode,
                error="" if text else "Help command returned no output.",
            )
        except subprocess.TimeoutExpired:
            snapshot = HelpSnapshot(
                tool_key=tool.spec.key,
                executable=tool.executable,
                invocation=argv,
                text="",
                options=[],
                captured_at=_utc_now(),
                return_code=124,
                error=f"Help command exceeded {timeout} seconds.",
            )
        except OSError as exc:
            snapshot = HelpSnapshot(
                tool_key=tool.spec.key,
                executable=tool.executable,
                invocation=argv,
                text="",
                options=[],
                captured_at=_utc_now(),
                return_code=126,
                error=f"{type(exc).__name__}: {exc}",
            )

        if best is None or (len(snapshot.options), len(snapshot.text)) > (len(best.options), len(best.text)):
            best = snapshot
        if snapshot.options:
            break

    assert best is not None
    try:
        serializable = asdict(best)
        cache_path.write_text(json.dumps(serializable, indent=2), encoding="utf-8")
    except OSError:
        pass
    return best
