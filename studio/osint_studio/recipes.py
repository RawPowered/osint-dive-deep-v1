from __future__ import annotations

import ipaddress
import re
import shlex
from collections.abc import Mapping

from .arsenal import build_spiderfoot_plan
from .models import CommandPlan, HelpSnapshot


DOMAIN_RE = re.compile(r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{2,64}$")


def _available_flags(snapshot: HelpSnapshot | None) -> set[str]:
    if not snapshot:
        return set()
    return {flag for option in snapshot.options for flag in option.flags}


def _flag(snapshot: HelpSnapshot | None, *candidates: str) -> str:
    available = _available_flags(snapshot)
    return next((candidate for candidate in candidates if candidate in available), candidates[0])


def _clean_domain(value: str) -> str:
    value = value.strip().lower().removeprefix("http://").removeprefix("https://").split("/", 1)[0]
    if not DOMAIN_RE.fullmatch(value):
        raise ValueError("Enter a valid public domain such as example.org.")
    return value


def _clean_url(value: str) -> str:
    value = value.strip()
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    if len(value) > 2048 or " " in value:
        raise ValueError("Enter a valid HTTP or HTTPS URL.")
    return value


def _clean_ip(value: str) -> str:
    ip = ipaddress.ip_address(value.strip())
    return str(ip)


def build_guided_plan(
    tool_key: str,
    executable: str,
    values: Mapping[str, object],
    snapshot: HelpSnapshot | None,
) -> CommandPlan:
    warnings: list[str] = []
    argv: list[str] = [executable]
    summary = ""

    if tool_key == "shodan":
        action = str(values.get("action", "domain"))
        query = str(values.get("query", "")).strip()
        if action == "domain":
            query = _clean_domain(query)
        elif action == "host":
            query = _clean_ip(query)
        elif not query:
            raise ValueError("Enter a Shodan search query.")
        argv.extend([action, query])
        summary = f"Shodan {action} query"

    elif tool_key == "theharvester":
        domain = _clean_domain(str(values.get("domain", "")))
        sources = str(values.get("sources", "all")).strip() or "all"
        limit = int(values.get("limit", 200))
        argv.extend([
            _flag(snapshot, "-d", "--domain"), domain,
            _flag(snapshot, "-b", "--source"), sources,
            _flag(snapshot, "-l", "--limit"), str(limit),
        ])
        output = str(values.get("output", "")).strip()
        if output:
            argv.extend([_flag(snapshot, "-f", "--filename"), output])
        summary = f"Public contact and host discovery for {domain}"

    elif tool_key == "gospider":
        url = _clean_url(str(values.get("url", "")))
        depth = int(values.get("depth", 2))
        concurrency = int(values.get("concurrency", 2))
        argv.extend([
            _flag(snapshot, "-s", "--site"), url,
            _flag(snapshot, "-d", "--depth"), str(depth),
            _flag(snapshot, "-c", "--concurrent"), str(concurrency),
        ])
        if bool(values.get("include_subdomains", False)):
            argv.append(_flag(snapshot, "--include-subs", "--subs"))
        if bool(values.get("robots", True)):
            argv.append(_flag(snapshot, "--robots"))
        if bool(values.get("sitemap", True)):
            argv.append(_flag(snapshot, "--sitemap"))
        summary = f"Public website crawl for {url}"
        warnings.append("Crawling generates traffic to the target website. Keep depth and concurrency conservative.")

    elif tool_key == "subfinder":
        domain = _clean_domain(str(values.get("domain", "")))
        argv.extend([_flag(snapshot, "-d", "--domain"), domain])
        if bool(values.get("all_sources", False)):
            argv.append(_flag(snapshot, "-all", "--all"))
        if bool(values.get("recursive", False)):
            argv.append(_flag(snapshot, "-recursive", "--recursive"))
        argv.append(_flag(snapshot, "-silent", "--silent"))
        output = str(values.get("output", "")).strip()
        if output:
            argv.extend([_flag(snapshot, "-o", "--output"), output])
        summary = f"Passive subdomain discovery for {domain}"

    elif tool_key == "assetfinder":
        domain = _clean_domain(str(values.get("domain", "")))
        if bool(values.get("subdomains_only", True)):
            argv.append("--subs-only")
        argv.append(domain)
        summary = f"Related-domain discovery for {domain}"

    elif tool_key == "amass":
        domain = _clean_domain(str(values.get("domain", "")))
        argv.extend(["enum"])
        if bool(values.get("passive", True)):
            argv.append("-passive")
        argv.extend(["-d", domain])
        output = str(values.get("output", "")).strip()
        if output:
            argv.extend(["-o", output])
        summary = f"Amass {'passive ' if values.get('passive', True) else ''}enumeration for {domain}"
        if not bool(values.get("passive", True)):
            warnings.append("Non-passive Amass modes may generate direct DNS and network traffic.")

    elif tool_key in {"maigret", "sherlock"}:
        username = str(values.get("username", "")).strip()
        if not USERNAME_RE.fullmatch(username):
            raise ValueError("Enter a username containing only letters, digits, dots, underscores, or hyphens.")
        argv.append(username)
        sites = [str(site) for site in values.get("sites", []) if str(site).strip()]
        for site in sites:
            argv.extend([_flag(snapshot, "--site"), site])
        if tool_key == "maigret":
            argv.extend(["--no-color", "--no-progressbar"])
        else:
            argv.append("--print-found")
        summary = f"Public username search for {username}"

    elif tool_key == "spiderfoot_web":
        host = str(values.get("host", "127.0.0.1")).strip() or "127.0.0.1"
        port = int(values.get("port", 5001))
        argv.extend(["-l", f"{host}:{port}"])
        summary = f"Launch SpiderFoot Web UI on {host}:{port}"
        warnings.append("Keep the listener bound to 127.0.0.1 unless you intentionally secure remote access.")

    elif tool_key == "recon_ng":
        workspace = str(values.get("workspace", "default")).strip() or "default"
        resource = str(values.get("resource", "")).strip()
        argv.extend(["-w", workspace])
        if resource:
            argv.extend(["-r", resource])
        summary = f"Open Recon-ng workspace {workspace}"
        warnings.append("Recon-ng is interactive; direct execution remains attached to the UI process.")

    elif tool_key == "spiderfoot_cli":
        modules = [item.strip() for item in str(values.get("modules", "")).split(",") if item.strip()]
        preset = "modules" if modules else str(values.get("preset", "passive"))
        return build_spiderfoot_plan(
            executable,
            str(values.get("target", "")),
            preset,
            modules=modules,
            max_threads=int(values.get("max_threads", 3)),
        )

    else:
        raise ValueError("No guided recipe is available for this tool. Use the Help-derived Builder tab.")

    return CommandPlan(
        tool_key=tool_key,
        argv=tuple(argv),
        summary=summary,
        warnings=tuple(warnings),
        allow_execute=True,
    )


def render_command(argv: tuple[str, ...] | list[str]) -> str:
    return shlex.join(list(argv))
