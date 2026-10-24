from __future__ import annotations

import io
import json
import os
import re
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import pandas as pd
import requests
import streamlit as st
from bs4 import BeautifulSoup

from .arsenal import build_spiderfoot_plan
from .case_store import CaseStore
from .contact_enrichment import render_contact_enrichment
from .models import CommandPlan, DiscoveredTool
from .paths import DATA_ROOT, ensure_private_directory
from .research_lanes import lane_matrix
from .ui_shell import stage_picker
from .web_recon import detect_technologies


OWASP_TOP_10_2025: tuple[dict[str, str], ...] = (
    {"id": "A01:2025", "risk": "Broken Access Control", "coverage": "Manual/authenticated validation; ZAP and Nuclei can assist", "mode": "Authenticated + manual"},
    {"id": "A02:2025", "risk": "Security Misconfiguration", "coverage": "Native headers, transport and disclosure checks; Nikto, Nuclei, ZAP", "mode": "Automated + review"},
    {"id": "A03:2025", "risk": "Software Supply Chain Failures", "coverage": "Technology and WordPress component inventory; WPScan and Nuclei", "mode": "Component analysis"},
    {"id": "A04:2025", "risk": "Cryptographic Failures", "coverage": "HTTPS and HSTS baseline; testssl.sh for protocols, ciphers and certificates", "mode": "Automated + review"},
    {"id": "A05:2025", "risk": "Injection", "coverage": "Nuclei/ZAP assistance plus scoped manual verification", "mode": "Active + manual"},
    {"id": "A06:2025", "risk": "Insecure Design", "coverage": "Architecture, trust-boundary and abuse-case review", "mode": "Manual"},
    {"id": "A07:2025", "risk": "Authentication Failures", "coverage": "Authenticated ZAP/manual session and login-control review", "mode": "Authenticated + manual"},
    {"id": "A08:2025", "risk": "Software or Data Integrity Failures", "coverage": "External-script/SRI observations and component review", "mode": "Automated + manual"},
    {"id": "A09:2025", "risk": "Security Logging and Alerting Failures", "coverage": "Client-side evidence cannot prove server alerting; operational review required", "mode": "Manual + client evidence"},
    {"id": "A10:2025", "risk": "Mishandling of Exceptional Conditions", "coverage": "Bounded active testing and manual error-path review", "mode": "Active + manual"},
)

DOMAIN_TOOL_KEYS = ("subfinder", "assetfinder", "theharvester", "gospider", "shodan", "amass", "spiderfoot_cli", "whatweb", "httpx", "nuclei", "nikto", "wpscan", "testssl", "nmap", "zap_baseline", "zap_full")
SINGLE_TARGET_TOOLS = {"assetfinder", "theharvester", "gospider", "shodan", "nikto", "wpscan", "testssl", "zap_baseline", "zap_full", "amass", "spiderfoot_cli"}
SECURITY_HEADERS = {
    "strict-transport-security": "HSTS",
    "content-security-policy": "Content Security Policy",
    "x-content-type-options": "X-Content-Type-Options",
    "referrer-policy": "Referrer-Policy",
    "permissions-policy": "Permissions-Policy",
    "cross-origin-opener-policy": "Cross-Origin-Opener-Policy",
}


def normalize_domain(value: str) -> str:
    candidate = value.strip().lower()
    if not candidate:
        raise ValueError("Domain is empty.")
    if "://" in candidate:
        candidate = urlparse(candidate).hostname or ""
    candidate = candidate.split("/", 1)[0].split(":", 1)[0].strip(".")
    if not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", candidate, re.I):
        raise ValueError(f"Invalid domain: {value}")
    return candidate


def normalize_domains(values: list[str]) -> tuple[list[str], list[str]]:
    domains: list[str] = []
    errors: list[str] = []
    for value in values:
        if not value.strip():
            continue
        try:
            domain = normalize_domain(value)
            if domain not in domains:
                domains.append(domain)
        except ValueError as exc:
            errors.append(str(exc))
    return domains, errors


def _case_domains(store: CaseStore, case_id: str) -> list[str]:
    values = [str(row.get("value") or "") for row in store.list_scopes(case_id, scope_type="domain") if bool(row.get("allowed"))]
    domains, _ = normalize_domains(values)
    return domains


def _scope_file(case_id: str, domains: list[str], *, urls: bool) -> Path:
    root = ensure_private_directory(DATA_ROOT / "domain-security" / case_id)
    path = root / ("urls.txt" if urls else "domains.txt")
    values = [f"https://{domain}/" if urls else domain for domain in domains]
    path.write_text("\n".join(values) + "\n", encoding="utf-8")
    if os.name == "posix":
        path.chmod(0o600)
    return path


def build_domain_tool_plan(
    tool: DiscoveredTool,
    case_id: str,
    domains: list[str],
    *,
    profile: str,
    rate_limit: int,
    concurrency: int,
    scheme: str = "https",
) -> CommandPlan:
    if not tool.installed or not tool.executable:
        raise ValueError(f"{tool.spec.label} is not installed.")
    if not domains:
        raise ValueError("Select at least one authorized domain.")
    key = tool.spec.key
    executable = tool.executable
    target = domains[0]
    scheme = "http" if scheme == "http" else "https"
    url = f"{scheme}://{target}/"
    domain_file = _scope_file(case_id, domains, urls=False)
    warnings = () if tool.spec.risk == "passive" else ("Direct requests will be sent only to the authorized scope shown above. Review client rate limits and exclusions before execution.",)

    if key == "subfinder":
        argv = [executable]
        argv.extend(["-dL", str(domain_file)] if len(domains) > 1 else ["-d", target])
        argv.append("-silent")
    elif key == "assetfinder":
        argv = [executable, "--subs-only", target]
    elif key == "theharvester":
        argv = [executable, "-d", target, "-b", "all", "-l", "500"]
    elif key == "gospider":
        depth = "2" if profile == "Baseline" else ("3" if profile == "Standard" else "5")
        argv = [executable, "-s", url, "-d", depth, "-c", str(concurrency), "--robots", "--sitemap"]
    elif key == "shodan":
        argv = [executable, "domain", target]
    elif key == "whatweb":
        argv = [executable, "--aggression", "1", "--log-json=-"]
        argv.extend(["-i", str(domain_file)] if len(domains) > 1 else [url])
    elif key == "httpx":
        argv = [executable, "-l", str(domain_file), "-json", "-status-code", "-title", "-tech-detect", "-web-server", "-tls-probe", "-follow-redirects", "-rate-limit", str(rate_limit), "-threads", str(concurrency)]
    elif key == "nuclei":
        severities = "medium,high,critical" if profile == "Baseline" else "low,medium,high,critical"
        argv = [executable, "-l", str(domain_file), "-jsonl", "-severity", severities, "-rate-limit", str(rate_limit), "-concurrency", str(concurrency)]
        if profile == "Baseline":
            argv.extend(["-tags", "misconfig,exposure,tech"])
    elif key == "nikto":
        argv = [executable, "-h", url, "-nointeractive", "-maxtime", "30m" if profile != "Deep" else "60m"]
    elif key == "wpscan":
        enumerate_values = "vp,vt" if profile == "Baseline" else ("vp,vt,cb,dbe" if profile == "Standard" else "ap,at,cb,dbe")
        detection = "passive" if profile == "Baseline" else ("mixed" if profile == "Standard" else "aggressive")
        argv = [executable, "--url", url, "--format", "json", "--enumerate", enumerate_values, "--plugins-detection", detection, "--themes-detection", detection]
        warnings += ("WPScan vulnerability data uses WPSCAN_API_TOKEN from the local environment when configured; no token is placed in the command preview.",)
    elif key == "testssl":
        argv = [executable, "--quiet", "--warnings", "batch", target]
    elif key == "nmap":
        ports = "100" if profile == "Baseline" else ("1000" if profile == "Standard" else "5000")
        argv = [executable, "-Pn", "-sV", "--top-ports", ports, "--max-rate", str(rate_limit)]
        argv.extend(["-iL", str(domain_file)] if len(domains) > 1 else [target])
    elif key == "zap_baseline":
        argv = [executable, "-t", url, "-m", "5" if profile == "Baseline" else "15"]
    elif key == "zap_full":
        argv = [executable, "-t", url]
        warnings += ("OWASP ZAP Full Scan performs active attacks. Use only inside the written scope and maintenance window approved by the client.",)
    elif key == "amass":
        argv = [executable, "enum", "-passive" if profile != "Deep" else "-active", "-d", target]
    elif key == "spiderfoot_cli":
        preset = "passive" if profile == "Baseline" else ("footprint" if profile == "Standard" else "all")
        return build_spiderfoot_plan(executable, target, preset, max_threads=concurrency)
    else:
        raise ValueError(f"No domain-security plan is registered for {key}.")
    return CommandPlan(
        tool_key=key,
        argv=tuple(argv),
        summary=f"Domain Security · {tool.spec.label} · {len(domains)} target{'s' if len(domains) != 1 else ''} · {profile}",
        warnings=warnings,
        traffic_class=tool.spec.risk,
    )


def _response_findings(url: str, headers: dict[str, str], soup: BeautifulSoup, generator: str) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    lower = {key.lower(): value for key, value in headers.items()}

    def add(category: str, severity: str, title: str, summary: str, recommendation: str) -> None:
        findings.append({"owasp": category, "severity": severity, "title": title, "summary": summary, "recommendation": recommendation})

    if urlparse(url).scheme != "https":
        add("A04:2025", "high", "Application served without HTTPS", "The final application URL used cleartext HTTP.", "Enforce HTTPS and redirect all HTTP requests to TLS.")
    elif "strict-transport-security" not in lower:
        add("A02:2025 / A04:2025", "medium", "HSTS header not observed", "The HTTPS response did not include Strict-Transport-Security.", "Deploy HSTS after confirming every required subdomain supports HTTPS.")
    if "content-security-policy" not in lower:
        add("A02:2025", "low", "Content Security Policy not observed", "The response did not include a Content-Security-Policy header.", "Define and test a restrictive CSP appropriate to the application.")
    if "x-content-type-options" not in lower:
        add("A02:2025", "low", "X-Content-Type-Options not observed", "The response did not include X-Content-Type-Options.", "Set X-Content-Type-Options: nosniff where compatible.")
    if lower.get("access-control-allow-origin") == "*":
        add("A02:2025", "low", "Wildcard CORS policy observed", "The response allowed any origin. This may be intentional for public resources and requires endpoint review.", "Restrict allowed origins for endpoints that return non-public or credentialed data.")
    if generator and re.search(r"\d+(?:\.\d+)+", generator):
        add("A02:2025 / A03:2025", "low", "Application version disclosed by generator metadata", f"Generator metadata disclosed: {generator}", "Remove unnecessary version disclosure and keep the component patched.")
    server = lower.get("server", "")
    if server and re.search(r"\d+(?:\.\d+)+", server):
        add("A02:2025", "low", "Web server version disclosed", f"Server header disclosed: {server}", "Minimize server-version disclosure and maintain current patches.")
    if urlparse(url).scheme == "http" and soup.select_one('input[type="password"]'):
        add("A04:2025 / A07:2025", "high", "Password field delivered over HTTP", "A password input was observed on a cleartext page.", "Require HTTPS before presenting or submitting authentication forms.")
    external_scripts = [node for node in soup.find_all("script", src=True) if urlparse(str(node.get("src") or "")).netloc]
    without_integrity = [node for node in external_scripts if not node.get("integrity")]
    if without_integrity:
        add("A03:2025 / A08:2025", "informational", "External scripts require integrity review", f"{len(without_integrity)} externally hosted script reference(s) lacked an integrity attribute. SRI is not appropriate for every dynamic provider.", "Review third-party trust, pinning, CSP and SRI feasibility for each external dependency.")
    return findings


def _fingerprint_one(session: requests.Session, domain: str, maximum_bytes: int) -> dict[str, Any]:
    response: requests.Response | None = None
    errors: list[str] = []
    requested_url = ""
    for requested_url in (f"https://{domain}/", f"http://{domain}/"):
        try:
            response = session.get(requested_url, timeout=(10, 30), allow_redirects=True, stream=True)
            break
        except requests.RequestException as exc:
            errors.append(f"{requested_url}: {type(exc).__name__}: {exc}")
    if response is None:
        return {"domain": domain, "requested_url": requested_url, "fetch_ok": False, "errors": errors, "raw_bytes": b"", "findings": []}
    chunks: list[bytes] = []
    size = 0
    truncated = False
    for chunk in response.iter_content(64 * 1024):
        if not chunk:
            continue
        remaining = maximum_bytes - size
        if remaining <= 0:
            truncated = True
            break
        chunks.append(chunk[:remaining])
        size += min(len(chunk), remaining)
        if len(chunk) > remaining:
            truncated = True
            break
    raw = b"".join(chunks)
    encoding = response.encoding or "utf-8"
    text = raw.decode(encoding, errors="replace")
    soup = BeautifulSoup(text, "html.parser")
    generator_node = soup.find("meta", attrs={"name": re.compile(r"^generator$", re.I)})
    generator = str(generator_node.get("content") or "").strip() if generator_node else ""
    scripts = [str(node.get("src") or "") for node in soup.find_all("script", src=True)]
    technologies = detect_technologies(text, generator, scripts)
    plugins = sorted(set(re.findall(r"/wp-content/plugins/([A-Za-z0-9._-]+)", text, re.I)))
    themes = sorted(set(re.findall(r"/wp-content/themes/([A-Za-z0-9._-]+)", text, re.I)))
    headers = {str(key): str(value) for key, value in response.headers.items()}
    lower_headers = {key.lower(): value for key, value in headers.items()}
    response.close()
    return {
        "domain": domain,
        "requested_url": requested_url,
        "final_url": response.url,
        "status_code": response.status_code,
        "fetch_ok": True,
        "content_type": response.headers.get("Content-Type", ""),
        "encoding": encoding,
        "bytes_captured": len(raw),
        "truncated": truncated,
        "redirects": [item.url for item in response.history],
        "response_headers": headers,
        "security_headers": {label: lower_headers.get(header, "") for header, label in SECURITY_HEADERS.items()},
        "generator": generator,
        "technologies": technologies,
        "wordpress_detected": "WordPress" in technologies or bool(plugins or themes),
        "wordpress_plugins": plugins,
        "wordpress_themes": themes,
        "findings": _response_findings(response.url, headers, soup, generator),
        "errors": errors,
        "raw_bytes": raw,
    }


def run_native_fingerprint(store: CaseStore, case_id: str, domains: list[str], maximum_bytes: int) -> list[dict[str, Any]]:
    run_id = store.create_run(case_id, "domain-security-baseline", adapter="native-domain-fingerprint", traffic_class="direct-observational", config={"targets": domains, "maximum_bytes": maximum_bytes})
    session = requests.Session()
    session.headers.update({"User-Agent": "DiveDeep-Authorized-Security-Assessment/5.17"})
    output: list[dict[str, Any]] = []
    failures = 0
    try:
        for domain in domains:
            record = _fingerprint_one(session, domain, maximum_bytes)
            raw = bytes(record.pop("raw_bytes", b""))
            entity_id = store.upsert_entity(case_id, "domain", domain, confidence=1.0)
            store.add_identifier(case_id, "domain", domain, entity_id=entity_id, confidence=1.0, metadata={"run_id": run_id, "authorized_scope": True})
            artifact_id = store.record_artifact_bytes(case_id, raw or json.dumps(record, ensure_ascii=False).encode("utf-8"), "domain-baseline-response", run_id=run_id, media_type=str(record.get("content_type") or "application/octet-stream"), encoding=str(record.get("encoding") or ""), source_uri=str(record.get("final_url") or record.get("requested_url") or ""), suffix=".html" if raw else ".json", metadata={"domain": domain, "response_headers": record.get("response_headers", {}), "truncated": record.get("truncated", False)})
            observation_id = store.record_observation(case_id, "domain-security-baseline", record, run_id=run_id, entity_id=entity_id, normalized_value=domain, source_name="DiveDeep native fingerprint", source_uri=str(record.get("final_url") or ""), confidence=0.9 if record.get("fetch_ok") else 0.0, artifact_id=artifact_id)
            evidence_id = store.add_evidence(case_id, "domain-security-baseline", json.dumps(record, ensure_ascii=False, sort_keys=True), observation_id=observation_id, artifact_id=artifact_id, source_uri=str(record.get("final_url") or ""))
            for finding in record.get("findings", []):
                claim_id = store.add_claim(case_id, f"owasp:{finding['owasp']}", finding["title"], entity_id=entity_id, confidence=0.75, evidence_ids=[evidence_id], metadata={"run_id": run_id, "domain": domain})
                store.add_finding(case_id, "domain-security", f"{domain} · {finding['title']}", claim_id=claim_id, severity=finding["severity"], summary=finding["summary"], recommendation=finding["recommendation"], metadata={"run_id": run_id, "domain": domain, "owasp": finding["owasp"]})
            if not record.get("fetch_ok"):
                failures += 1
            output.append(record)
        store.complete_run(run_id, summary={"targets": len(domains), "completed": len(output), "failures": failures, "wordpress_sites": sum(1 for row in output if row.get("wordpress_detected"))})
    except Exception as exc:
        store.complete_run(run_id, summary={"targets": len(domains), "completed": len(output)}, error=f"{type(exc).__name__}: {exc}")
        raise
    return output


def _scope_inputs(upload: Any, text: str) -> tuple[list[str], list[str]]:
    values = [item for line in text.splitlines() for item in re.split(r"[,;\t]", line) if item.strip()]
    if upload is not None:
        try:
            frame = pd.read_csv(io.BytesIO(upload.getvalue()), dtype=str, keep_default_na=False)
            preferred = next((column for column in frame.columns if str(column).strip().casefold() in {"domain", "url", "host", "hostname", "target"}), frame.columns[0] if len(frame.columns) else None)
            if preferred is not None:
                values.extend(frame[preferred].astype(str).tolist())
        except Exception as exc:
            return [], [f"CSV import failed: {type(exc).__name__}: {exc}"]
    return normalize_domains(values)


def _render_scope(store: CaseStore, case_id: str, targets_key: str) -> None:
    st.markdown("### Authorized client scope")
    mode = st.radio("Scope size", ("Single domain", "Domain list"), horizontal=True)
    quick_seed = st.session_state.get("domain_security_quick_seed")
    quick = "\n".join(str(item) for item in quick_seed) if isinstance(quick_seed, list) else (str(st.session_state.get("quick_recon_target") or "") if st.session_state.get("quick_recon_target_type") in {"domain", "url"} else "")
    text = st.text_area("Domain or URL" if mode == "Single domain" else "Domains or URLs · one per line", value=quick if mode == "Single domain" and not st.session_state.get(targets_key) else "", height=90 if mode == "Single domain" else 180, placeholder="client.example\nportal.client.example")
    upload = st.file_uploader("Optional CSV domain list", type=["csv"], disabled=mode == "Single domain")
    notes = st.text_input("Engagement scope reference", placeholder="SOW, ticket, authorization window or client contact")
    authorized = st.checkbox("I confirm these assets are owned by the client or explicitly authorized for this assessment.")
    if st.button("Save authorized scope", type="primary", width="stretch"):
        domains, errors = _scope_inputs(upload, text)
        if errors:
            st.error("\n".join(errors[:10]))
        elif not domains:
            st.error("Add at least one valid domain.")
        elif not authorized:
            st.error("Confirm the assessment authorization before saving scope.")
        else:
            for domain in domains:
                store.add_scope(case_id, "domain", domain, allowed=True, notes=notes)
                subject_id = store.add_subject(case_id, "domain", domain, primary_value=domain, metadata={"authorized_scope": True, "scope_reference": notes})
                store.add_identifier(case_id, "domain", domain, subject_id=subject_id, confidence=1.0, metadata={"authorized_scope": True})
            st.session_state[targets_key] = _case_domains(store, case_id)
            st.session_state.pop("domain_security_quick_seed", None)
            st.success(f"Saved {len(domains):,} authorized domain{'s' if len(domains) != 1 else ''}.")
            st.rerun()
    current = _case_domains(store, case_id)
    if current:
        st.divider()
        left, right = st.columns(2)
        if left.button("Open full domain discovery", width="stretch"):
            matrix = lane_matrix("domain", current)
            for key, value in matrix.items():
                st.session_state[f"super_{key}"] = value
            st.session_state.super_query_shards = []
            st.session_state.research_lane = "domain"
            st.session_state.research_active_view = "Discovery"
            st.rerun()
        if right.button("Continue to tool runs", width="stretch"):
            st.session_state._pending_domain_security_stage = "5 · Tool Runs"
            st.rerun()


def _baseline_rows(store: CaseStore, case_id: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for observation in store.list_observations(case_id, limit=10_000):
        if observation.get("observation_type") != "domain-security-baseline":
            continue
        try:
            value = json.loads(str(observation.get("value_json") or "{}"))
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def _render_fingerprint(store: CaseStore, case_id: str, targets: list[str]) -> None:
    st.markdown("### Native baseline fingerprint")
    st.caption("One bounded homepage request per domain captures redirects, headers, technologies and visible WordPress component paths before heavier tools are used.")
    if not targets:
        st.info("Save an authorized domain scope first.")
        return
    left, right = st.columns(2)
    count = left.number_input("Targets this batch", 1, len(targets), min(len(targets), 50))
    maximum_mb = right.selectbox("Maximum response capture", (1, 2, 4), index=1, format_func=lambda value: f"{value} MB per target")
    acknowledge = st.checkbox("Run the bounded direct fingerprint against the selected authorized assets.")
    if st.button("Run baseline fingerprint", type="primary", disabled=not acknowledge, width="stretch"):
        with st.status("Fingerprinting authorized domains…", expanded=True) as status:
            try:
                rows = run_native_fingerprint(store, case_id, targets[: int(count)], int(maximum_mb) * 1024 * 1024)
                status.update(label=f"Baseline complete · {len(rows)} domains", state="complete")
                st.session_state.domain_security_last_baseline = rows
            except Exception as exc:
                status.update(label="Baseline failed", state="error")
                st.error(f"{type(exc).__name__}: {exc}")
    rows = _baseline_rows(store, case_id)
    if rows:
        st.dataframe(pd.DataFrame([{"Domain": row.get("domain"), "Status": row.get("status_code"), "Final URL": row.get("final_url"), "Technology": ", ".join(row.get("technologies", [])), "WordPress": bool(row.get("wordpress_detected")), "Plugins": ", ".join(row.get("wordpress_plugins", [])), "Themes": ", ".join(row.get("wordpress_themes", []))} for row in rows]), width="stretch", hide_index=True)


def _render_owasp(store: CaseStore, case_id: str) -> None:
    st.markdown("### OWASP analysis coverage")
    st.caption("OWASP Top 10:2025 organizes risk reporting; OWASP WSTG v4.2 supplies stable test references. A missing automated alert is never treated as proof that a category passed.")
    runs = store.list_runs(case_id, limit=1000)
    adapters = {str(row.get("adapter") or "") for row in runs if row.get("status") == "complete"}
    baseline = bool(_baseline_rows(store, case_id))
    tool_coverage = {
        "A01:2025": {"nuclei", "zap_baseline", "zap_full"},
        "A02:2025": {"nuclei", "nikto", "zap_baseline", "zap_full", "whatweb", "httpx"},
        "A03:2025": {"wpscan", "nuclei", "whatweb", "httpx"},
        "A04:2025": {"testssl", "zap_baseline", "zap_full", "httpx"},
        "A05:2025": {"nuclei", "zap_full"},
        "A06:2025": set(),
        "A07:2025": {"zap_full"},
        "A08:2025": {"wpscan", "nuclei", "zap_baseline", "zap_full"},
        "A09:2025": set(),
        "A10:2025": {"nuclei", "zap_full"},
    }
    rows = []
    for item in OWASP_TOP_10_2025:
        status = "Planned"
        if baseline and item["id"] in {"A02:2025", "A03:2025", "A04:2025", "A08:2025"}:
            status = "Baseline evidence collected"
        if adapters.intersection(tool_coverage[item["id"]]):
            status = "Tool evidence collected · review required"
        rows.append({"Category": item["id"], "Risk": item["risk"], "Studio coverage": item["coverage"], "Validation": item["mode"], "Case status": status})
    st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)
    left, right = st.columns(2)
    left.link_button("OWASP Top 10:2025", "https://owasp.org/Top10/", width="stretch")
    right.link_button("OWASP WSTG v4.2", "https://owasp.org/www-project-web-security-testing-guide/v42/", width="stretch")


def _render_tools(case_id: str, targets: list[str], tools: list[DiscoveredTool], render_plan: Callable[[CommandPlan, DiscoveredTool], None]) -> None:
    st.markdown("### Recon and security tool runs")
    if not targets:
        st.info("Save an authorized domain scope first.")
        return
    supported = [tool for tool in tools if tool.spec.key in DOMAIN_TOOL_KEYS]
    if not supported:
        st.warning("No supported domain-security tools were discovered in PATH.")
        return
    selected_key = st.selectbox("Tool", [tool.spec.key for tool in supported], format_func=lambda key: next(f"{item.spec.label} · {'ready' if item.installed else 'not installed'}" for item in supported if item.spec.key == key))
    tool = next(item for item in supported if item.spec.key == selected_key)
    if not tool.installed:
        st.warning(f"Not installed. {tool.spec.install_hint}")
        return
    profile = st.radio("Assessment profile", ("Baseline", "Standard", "Deep"), horizontal=True, index=1)
    scheme = st.radio("Preferred scheme for single-target tools", ("https", "http"), horizontal=True)
    selected_targets = targets
    if selected_key in SINGLE_TARGET_TOOLS:
        selected_targets = [st.selectbox("Authorized target", targets)]
    else:
        use_all = st.checkbox(f"Use all {len(targets):,} authorized targets", value=True)
        selected_targets = targets if use_all else st.multiselect("Authorized targets", targets, default=targets[: min(len(targets), 100)])
    controls = st.columns(2)
    rate = controls[0].number_input("Maximum requests/packets per second", 1, 500, 25)
    concurrency = controls[1].number_input("Maximum concurrency", 1, 50, 5)
    try:
        plan = build_domain_tool_plan(tool, case_id, selected_targets, profile=profile, rate_limit=int(rate), concurrency=int(concurrency), scheme=scheme)
    except ValueError as exc:
        st.info(str(exc))
        return
    render_plan(plan, tool)


def _render_report(store: CaseStore, case_id: str, targets: list[str]) -> None:
    st.markdown("### Consolidated client review")
    baseline = _baseline_rows(store, case_id)
    findings = store.list_findings(case_id, limit=10_000)
    runs = [row for row in store.list_runs(case_id, limit=10_000) if row.get("run_type") in {"domain-security-baseline", "kali-tool-execution"}]
    if findings:
        st.dataframe(pd.DataFrame([{"Severity": row.get("severity"), "Finding": row.get("title"), "Summary": row.get("summary"), "Recommendation": row.get("recommendation"), "Created": row.get("created_at")} for row in findings]), width="stretch", hide_index=True)
    else:
        st.info("No findings are recorded yet. Run the native baseline or an authorized tool plan.")
    report = {"schema": "divedeep-domain-security-v1", "targets": targets, "baseline": baseline, "findings": findings, "runs": runs, "owasp_reference": "OWASP Top 10:2025", "testing_reference": "OWASP WSTG v4.2"}
    left, right = st.columns(2)
    left.download_button("Download consolidated JSON", json.dumps(report, ensure_ascii=False, indent=2), file_name=f"{case_id}-domain-security.json", mime="application/json", width="stretch")
    finding_frame = pd.DataFrame(findings)
    right.download_button("Download findings CSV", finding_frame.to_csv(index=False), file_name=f"{case_id}-domain-findings.csv", mime="text/csv", disabled=finding_frame.empty, width="stretch")


def render_domain_security_command_center(
    store: CaseStore,
    case: dict[str, object] | None,
    tools: list[DiscoveredTool],
    render_plan: Callable[[CommandPlan, DiscoveredTool], None],
) -> None:
    st.title("Domain Security Command Center")
    st.caption("Single-domain and portfolio-scale external reconnaissance, technology fingerprinting, WordPress component analysis and OWASP-aligned client testing.")
    if not case:
        st.info("Create or select a research case before defining an authorized domain scope.")
        return
    case_id = str(case["id"])
    targets_key = f"domain_security_targets_{case_id}"
    pending = st.session_state.pop("domain_security_pending_targets", None)
    if isinstance(pending, list):
        normalized, _ = normalize_domains([str(item) for item in pending])
        if normalized:
            st.session_state.domain_security_quick_seed = normalized
    targets = list(st.session_state.get(targets_key) or _case_domains(store, case_id))
    pending_stage = st.session_state.pop("_pending_domain_security_stage", None)
    if pending_stage:
        st.session_state[f"domain_security_stage_{case_id}"] = pending_stage
    stage = stage_picker("Domain stage", ("1 · Scope", "2 · Contact Enrichment", "3 · Fingerprint", "4 · OWASP Analysis", "5 · Tool Runs", "6 · Findings & Export"), key=f"domain_security_stage_{case_id}")
    if targets:
        st.caption(f"Authorized working scope · {len(targets):,} domain{'s' if len(targets) != 1 else ''}")
    if stage == "1 · Scope":
        _render_scope(store, case_id, targets_key)
    elif stage == "2 · Contact Enrichment":
        render_contact_enrichment(store, case_id)
    elif stage == "3 · Fingerprint":
        _render_fingerprint(store, case_id, targets)
    elif stage == "4 · OWASP Analysis":
        _render_owasp(store, case_id)
    elif stage == "5 · Tool Runs":
        _render_tools(case_id, targets, tools, render_plan)
    else:
        _render_report(store, case_id, targets)
