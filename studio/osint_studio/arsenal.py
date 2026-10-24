from __future__ import annotations

import ipaddress
import json
import os
import re
import signal
import socket
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import urlparse

from .case_store import CaseStore
from .executor import ExecutionResult
from .models import CommandPlan
from .paths import DATA_ROOT, ensure_private_directory


ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
EMAIL_RE = re.compile(r"(?i)(?<![\w.+-])([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)")
URL_RE = re.compile(r"(?i)https?://[^\s<>'\"]+")
DOMAIN_RE = re.compile(r"(?i)(?<![@\w-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?![\w-])")
IP_RE = re.compile(r"(?<![\w:])(?:\d{1,3}\.){3}\d{1,3}(?![\w:])")


@dataclass(frozen=True)
class ArsenalPreset:
    key: str
    label: str
    description: str
    use_case: str = ""
    traffic_class: str = "mixed"
    max_threads: int = 3


SPIDERFOOT_PRESETS: tuple[ArsenalPreset, ...] = (
    ArsenalPreset("passive", "Passive public sources", "Use modules in SpiderFoot's Passive group.", "passive", "passive", 3),
    ArsenalPreset("footprint", "External footprint", "Map externally visible assets using SpiderFoot's Footprint group.", "footprint", "mixed", 3),
    ArsenalPreset("investigate", "Investigate indicator", "Enrich and correlate an indicator using the Investigate group.", "investigate", "mixed", 3),
    ArsenalPreset("all", "All configured modules", "Run every configured module; direct target traffic is likely.", "all", "active", 2),
    ArsenalPreset("event_types", "Selected event types", "Let SpiderFoot select modules that produce chosen event types.", "", "mixed", 3),
    ArsenalPreset("modules", "Selected modules", "Run only explicitly named SpiderFoot modules.", "", "mixed", 3),
)


@dataclass
class NormalizedToolEvent:
    event_type: str
    data: str
    module: str
    source_data: str = ""
    confidence: float = 0.5
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class ArsenalIngestSummary:
    parsed_events: int = 0
    observations: int = 0
    entities: int = 0
    identifiers: int = 0
    findings: int = 0
    parser: str = "none"


def spiderfoot_preset(key: str) -> ArsenalPreset:
    return next(item for item in SPIDERFOOT_PRESETS if item.key == key)


def clean_target(value: str) -> str:
    target = value.strip()
    if not target or len(target) > 2048 or any(character in target for character in ("\x00", "\r", "\n")):
        raise ValueError("Enter one valid SpiderFoot target without control characters.")
    return target


def build_spiderfoot_plan(
    executable: str,
    target: str,
    preset_key: str,
    *,
    modules: list[str] | None = None,
    event_types: list[str] | None = None,
    strict: bool = False,
    filter_requested: bool = True,
    max_threads: int | None = None,
) -> CommandPlan:
    target = clean_target(target)
    preset = spiderfoot_preset(preset_key)
    argv = [executable, "-s", target]
    selected_modules = [item.strip() for item in (modules or []) if item.strip()]
    selected_types = [item.strip() for item in (event_types or []) if item.strip()]
    if preset.use_case:
        argv.extend(["-u", preset.use_case])
    elif preset.key == "modules":
        if not selected_modules:
            raise ValueError("Enter at least one SpiderFoot module.")
        argv.extend(["-m", ",".join(selected_modules)])
    elif preset.key == "event_types":
        if not selected_types:
            raise ValueError("Enter at least one SpiderFoot event type.")
        argv.extend(["-t", ",".join(selected_types)])
        if filter_requested:
            argv.append("-f")
        if strict:
            argv.append("-x")
    threads = max(1, min(50, int(max_threads or preset.max_threads)))
    argv.extend(["-o", "json", "-max-threads", str(threads)])
    warnings: list[str] = []
    if preset.traffic_class != "passive":
        warnings.append("This preset may cause direct requests to the target. Confirm authorization and scope before running it.")
    if preset.key == "all":
        warnings.append("All configured modules can include port scans, web crawling, file checks, third-party APIs and other active behavior.")
    return CommandPlan(
        tool_key="spiderfoot_cli",
        argv=tuple(argv),
        summary=f"SpiderFoot · {preset.label} · {target}",
        warnings=tuple(warnings),
        traffic_class=preset.traffic_class,
    )


def _confidence(value: Any) -> float:
    if isinstance(value, (int, float)):
        number = float(value)
        return max(0.0, min(1.0, number / 100.0 if number > 1 else number))
    labels = {"high": 0.9, "medium": 0.65, "low": 0.35}
    return labels.get(str(value).strip().casefold(), 0.5)


def _value(record: dict[str, Any], *keys: str) -> Any:
    lowered = {str(key).casefold(): value for key, value in record.items()}
    for key in keys:
        if key.casefold() in lowered:
            return lowered[key.casefold()]
    return ""


def parse_spiderfoot_json(output: str) -> list[NormalizedToolEvent]:
    cleaned = ANSI_RE.sub("", output).strip()
    start, end = cleaned.find("["), cleaned.rfind("]")
    if start < 0 or end < start:
        return []
    try:
        payload = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        return []
    if isinstance(payload, dict):
        payload = [payload]
    events: list[NormalizedToolEvent] = []
    for raw in payload if isinstance(payload, list) else []:
        if not isinstance(raw, dict):
            continue
        data = _value(raw, "data", "value")
        if isinstance(data, (dict, list)):
            data = json.dumps(data, ensure_ascii=False, sort_keys=True)
        source_data = _value(raw, "source data", "source_data", "sourceData", "source")
        if isinstance(source_data, (dict, list)):
            source_data = json.dumps(source_data, ensure_ascii=False, sort_keys=True)
        event_type = str(_value(raw, "eventType", "event_type", "type") or "SPIDERFOOT_EVENT")
        module = str(_value(raw, "module", "sourceModule", "source_module") or "spiderfoot")
        events.append(NormalizedToolEvent(event_type=event_type, data=str(data), module=module, source_data=str(source_data), confidence=_confidence(_value(raw, "confidence")), raw=raw))
    return events


def parse_generic_output(tool_key: str, output: str) -> list[NormalizedToolEvent]:
    cleaned = ANSI_RE.sub("", output)
    events: list[NormalizedToolEvent] = []
    seen: set[tuple[str, str]] = set()

    def add(event_type: str, value: str, line: str) -> None:
        normalized = value.strip().rstrip(".,;)")
        key = (event_type, normalized.casefold())
        if normalized and key not in seen:
            seen.add(key)
            events.append(NormalizedToolEvent(event_type, normalized, tool_key, line.strip(), 0.65, {"line": line.rstrip("\r\n")}))

    domain_tools = {"subfinder", "assetfinder", "amass"}
    username_tools = {"maigret", "sherlock"}
    for line in cleaned.splitlines():
        for value in EMAIL_RE.findall(line):
            add("EMAIL_ADDRESS", value, line)
        for value in URL_RE.findall(line):
            add("URL", value, line)
        for value in IP_RE.findall(line):
            try:
                add("IP_ADDRESS", str(ipaddress.ip_address(value)), line)
            except ValueError:
                pass
        for value in DOMAIN_RE.findall(line):
            if "@" not in value:
                add("DOMAIN_NAME" if tool_key in domain_tools else "INTERNET_NAME", value.lower(), line)
        if tool_key in username_tools:
            for value in URL_RE.findall(line):
                add("ACCOUNT_PROFILE", value, line)
    return events


def _json_payload(output: str) -> Any:
    cleaned = ANSI_RE.sub("", output).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return None


def parse_nuclei_jsonl(output: str) -> list[NormalizedToolEvent]:
    events: list[NormalizedToolEvent] = []
    for line in ANSI_RE.sub("", output).splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        info = row.get("info") if isinstance(row.get("info"), dict) else {}
        severity = str(info.get("severity") or row.get("severity") or "informational").upper()
        name = str(info.get("name") or row.get("template-id") or "Nuclei finding")
        location = str(row.get("matched-at") or row.get("host") or row.get("url") or "")
        events.append(NormalizedToolEvent(f"{severity}_VULNERABILITY", f"{name} · {location}".strip(" ·"), str(row.get("template-id") or "nuclei"), location, 0.9, row))
    return events


def parse_wpscan_json(output: str) -> list[NormalizedToolEvent]:
    payload = _json_payload(output)
    if not isinstance(payload, dict):
        return []
    events: list[NormalizedToolEvent] = []
    for section, event_type in (("plugins", "WORDPRESS_PLUGIN"), ("themes", "WORDPRESS_THEME")):
        values = payload.get(section)
        if not isinstance(values, dict):
            continue
        for slug, component in values.items():
            component = component if isinstance(component, dict) else {}
            version = str((component.get("version") or {}).get("number") or "") if isinstance(component.get("version"), dict) else ""
            events.append(NormalizedToolEvent(event_type, f"{slug}{' ' + version if version else ''}", "wpscan", confidence=0.85, raw={"slug": slug, **component}))
            vulnerabilities = component.get("vulnerabilities") if isinstance(component.get("vulnerabilities"), list) else []
            for vulnerability in vulnerabilities:
                if isinstance(vulnerability, dict):
                    title = str(vulnerability.get("title") or vulnerability.get("id") or "Known WordPress component vulnerability")
                    events.append(NormalizedToolEvent("HIGH_VULNERABILITY", f"{slug} · {title}", "wpscan", confidence=0.9, raw=vulnerability))
    version = payload.get("version")
    if isinstance(version, dict) and version.get("number"):
        events.append(NormalizedToolEvent("WORDPRESS_CORE", str(version["number"]), "wpscan", confidence=0.9, raw=version))
        for vulnerability in version.get("vulnerabilities", []) if isinstance(version.get("vulnerabilities"), list) else []:
            if isinstance(vulnerability, dict):
                events.append(NormalizedToolEvent("HIGH_VULNERABILITY", f"WordPress core · {vulnerability.get('title') or vulnerability.get('id')}", "wpscan", confidence=0.9, raw=vulnerability))
    return events


def parse_tool_output(tool_key: str, result: ExecutionResult) -> tuple[str, list[NormalizedToolEvent]]:
    stdout = result.stdout or result.output
    if tool_key == "spiderfoot_cli":
        events = parse_spiderfoot_json(stdout)
        return "spiderfoot-json", events
    if tool_key == "nuclei":
        return "nuclei-jsonl", parse_nuclei_jsonl(stdout)
    if tool_key == "wpscan":
        return "wpscan-json", parse_wpscan_json(stdout)
    return "generic-observable", parse_generic_output(tool_key, stdout)


def _entity_mapping(event: NormalizedToolEvent) -> tuple[str, str, str] | None:
    value = event.data.strip()
    kind = re.sub(r"[^A-Z0-9]+", "_", event.event_type.upper())
    if EMAIL_RE.fullmatch(value):
        return "email-address", value.casefold(), "email"
    if URL_RE.fullmatch(value):
        hostname = (urlparse(value).hostname or "").lower().removeprefix("www.")
        return ("domain", hostname, "url") if hostname else ("url", value, "url")
    try:
        address = str(ipaddress.ip_address(value))
        return "ip-address", address, "ip"
    except ValueError:
        pass
    if DOMAIN_RE.fullmatch(value):
        return "domain", value.casefold(), "domain"
    if "USERNAME" in kind or "ACCOUNT" in kind:
        return "username", value, "username"
    if "PHONE" in kind:
        return "phone-number", value, "phone"
    if any(token in kind for token in ("HUMAN_NAME", "PERSON_NAME")):
        return "person", value, "name"
    if any(token in kind for token in ("COMPANY", "ORGANIZATION")):
        return "organization", value, "name"
    return None


def _severity(event_type: str) -> str:
    kind = re.sub(r"[^A-Z0-9]+", "_", event_type.upper())
    if any(token in kind for token in ("CRITICAL_VULNERABILITY", "LEAKED_PASSWORD", "LEAKED_CREDENTIAL")):
        return "critical"
    if "LOW_VULNERABILITY" in kind:
        return "low"
    if "MEDIUM_VULNERABILITY" in kind:
        return "medium"
    if any(token in kind for token in ("BREACH", "VULNERABILITY", "SUBDOMAIN_HIJACK", "COMPROMISED", "DATA_LEAK")):
        return "high"
    if any(token in kind for token in ("MALICIOUS", "BLACKLIST", "OPEN_PORT", "RISK")):
        return "medium"
    return "informational"


class ArsenalNormalizer:
    def __init__(self, store: CaseStore):
        self.store = store

    def ingest(self, case_id: str, run_id: str, tool_key: str, result: ExecutionResult, artifact_id: str, raw_evidence_id: str) -> ArsenalIngestSummary:
        parser, events = parse_tool_output(tool_key, result)
        summary = ArsenalIngestSummary(parsed_events=len(events), parser=parser)
        seen: set[tuple[str, str, str]] = set()
        for event in events[:100_000]:
            unique = (event.event_type, event.data, event.module)
            if unique in seen:
                continue
            seen.add(unique)
            mapping = _entity_mapping(event)
            entity_id = None
            if mapping:
                entity_type, canonical, identifier_type = mapping
                entity_id = self.store.upsert_entity(case_id, entity_type, canonical, confidence=event.confidence)
                self.store.add_identifier(case_id, identifier_type, event.data, entity_id=entity_id, confidence=event.confidence, metadata={"run_id": run_id, "tool": tool_key, "module": event.module})
                summary.entities += 1
                summary.identifiers += 1
            observation_id = self.store.record_observation(
                case_id,
                "tool-normalized-event",
                asdict(event),
                run_id=run_id,
                entity_id=entity_id,
                normalized_value=event.data.casefold(),
                source_name=f"{tool_key}:{event.module}",
                confidence=event.confidence,
                artifact_id=artifact_id,
                metadata={"parser": parser, "event_type": event.event_type},
            )
            summary.observations += 1
            severity = _severity(event.event_type)
            if severity != "informational":
                event_evidence_id = self.store.add_evidence(case_id, "tool-normalized-event", json.dumps(event.raw or asdict(event), ensure_ascii=False, sort_keys=True), observation_id=observation_id, artifact_id=artifact_id, metadata={"raw_output_evidence_id": raw_evidence_id, "run_id": run_id})
                claim_id = self.store.add_claim(case_id, f"tool:{event.event_type}", event.data, entity_id=entity_id, confidence=event.confidence, evidence_ids=[raw_evidence_id, event_evidence_id], metadata={"run_id": run_id, "tool": tool_key, "module": event.module})
                self.store.add_finding(case_id, "tool-exposure", f"{event.event_type}: {event.data}", claim_id=claim_id, severity=severity, summary=f"Reported by {tool_key} module {event.module}.", recommendation="Validate against the exact captured output and remediate if the affected asset is in authorized scope.", metadata={"run_id": run_id, "tool": tool_key, "module": event.module})
                summary.findings += 1
        return summary


@dataclass
class SpiderFootService:
    executable: str
    port: int
    process: subprocess.Popen[bytes]
    log_path: Path
    log_handle: BinaryIO

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @classmethod
    def start(cls, executable: str, port: int = 5001) -> SpiderFootService:
        port = max(1024, min(65535, int(port)))
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError(f"127.0.0.1:{port} is already in use.")
        service_root = ensure_private_directory(DATA_ROOT / "services" / "spiderfoot")
        log_path = service_root / f"spiderfoot-{int(time.time())}.log"
        log_handle = log_path.open("ab", buffering=0)
        try:
            process = subprocess.Popen([executable, "-l", f"127.0.0.1:{port}"], stdout=log_handle, stderr=subprocess.STDOUT, shell=False, start_new_session=True)
        except Exception:
            log_handle.close()
            raise
        service = cls(executable, port, process, log_path, log_handle)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if process.poll() is not None:
                service.close_log()
                raise RuntimeError(f"SpiderFoot exited during startup. Inspect {log_path}.")
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    return service
            time.sleep(0.25)
        service.stop()
        raise RuntimeError(f"SpiderFoot did not listen within 20 seconds. Inspect {log_path}.")

    def running(self) -> bool:
        return self.process.poll() is None

    def close_log(self) -> None:
        if not self.log_handle.closed:
            self.log_handle.close()

    def stop(self) -> None:
        if self.process.poll() is None:
            try:
                if os.name == "posix":
                    os.killpg(self.process.pid, signal.SIGTERM)
                else:
                    self.process.terminate()
                self.process.wait(timeout=8)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                if self.process.poll() is None:
                    self.process.kill()
        self.close_log()
