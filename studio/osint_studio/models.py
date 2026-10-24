from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass(frozen=True)
class ToolSpec:
    key: str
    label: str
    executables: tuple[str, ...]
    category: str
    description: str
    help_variants: tuple[tuple[str, ...], ...] = (("--help",), ("-h",), ("help",))
    interactive: bool = False
    risk: Literal["passive", "mixed", "active"] = "passive"
    homepage: str = ""
    capabilities: tuple[str, ...] = ()
    target_types: tuple[str, ...] = ()
    output_formats: tuple[str, ...] = ("text",)
    install_hint: str = ""
    normalized: bool = True


@dataclass(frozen=True)
class DiscoveredTool:
    spec: ToolSpec
    executable: str | None

    @property
    def installed(self) -> bool:
        return self.executable is not None


@dataclass(frozen=True)
class HelpOption:
    flags: tuple[str, ...]
    metavar: str = ""
    description: str = ""
    takes_value: bool = False
    repeatable: bool = False

    @property
    def primary_flag(self) -> str:
        long_flags = [flag for flag in self.flags if flag.startswith("--")]
        return long_flags[0] if long_flags else self.flags[0]

    @property
    def key(self) -> str:
        return self.primary_flag.lstrip("-").replace("-", "_")


@dataclass
class HelpSnapshot:
    tool_key: str
    executable: str
    invocation: list[str]
    text: str
    options: list[HelpOption] = field(default_factory=list)
    captured_at: str = ""
    return_code: int = 0
    error: str = ""


@dataclass(frozen=True)
class CommandPlan:
    tool_key: str
    argv: tuple[str, ...]
    summary: str
    warnings: tuple[str, ...] = ()
    allow_execute: bool = True
    traffic_class: Literal["passive", "mixed", "active"] | None = None
