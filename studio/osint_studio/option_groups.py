from __future__ import annotations

from collections import defaultdict

from .models import HelpOption


CATEGORY_ORDER = ["Target & Input", "Scope & Filters", "Performance", "Output", "Authentication & Config", "Other"]


def categorize_option(option: HelpOption) -> str:
    text = (" ".join(option.flags) + " " + option.description + " " + option.metavar).lower()
    if any(word in text for word in ("output", "outfile", "format", "json", "csv", "save", "report", "silent")):
        return "Output"
    if any(word in text for word in ("timeout", "thread", "worker", "concurr", "rate", "delay", "retry", "parallel", "depth")):
        return "Performance"
    if any(word in text for word in ("api", "key", "token", "proxy", "config", "credential", "cookie", "header", "user-agent")):
        return "Authentication & Config"
    if any(word in text for word in ("domain", "target", "host", "url", "username", "input", "file", "workspace", "query")):
        return "Target & Input"
    if any(word in text for word in ("include", "exclude", "filter", "source", "module", "site", "port", "recursive", "passive", "active", "scope")):
        return "Scope & Filters"
    return "Other"


def group_options(options: list[HelpOption]) -> dict[str, list[HelpOption]]:
    grouped: dict[str, list[HelpOption]] = defaultdict(list)
    for option in options:
        grouped[categorize_option(option)].append(option)
    return {category: grouped.get(category, []) for category in CATEGORY_ORDER if grouped.get(category)}
