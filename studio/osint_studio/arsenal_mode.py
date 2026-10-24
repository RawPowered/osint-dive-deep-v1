from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import streamlit as st

from .arsenal import SPIDERFOOT_PRESETS, SpiderFootService, build_spiderfoot_plan
from .case_store import CaseStore
from .models import CommandPlan, DiscoveredTool
from .ui_shell import stage_picker


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _archive_service_log(case_id: str | None, service: SpiderFootService, run_id: str) -> str:
    if not case_id or not service.log_path.exists():
        return ""
    store = CaseStore()
    artifact_id = store.record_artifact_path(
        case_id,
        service.log_path,
        "spiderfoot-service-log",
        run_id=run_id or None,
        media_type="text/plain",
        encoding="utf-8",
        source_uri=service.url,
        metadata={"listener": service.url, "executable": service.executable},
    )
    store.record_observation(
        case_id,
        "spiderfoot-local-service",
        {"listener": service.url, "log_path": str(service.log_path)},
        run_id=run_id or None,
        normalized_value=service.url,
        source_name="spiderfoot-web",
        source_uri=service.url,
        confidence=1.0,
        artifact_id=artifact_id,
    )
    if run_id:
        store.complete_run(run_id, summary={"listener": service.url, "log_artifact_id": artifact_id})
    return artifact_id


def _render_spiderfoot(
    tools: list[DiscoveredTool],
    render_plan: Callable[[CommandPlan, DiscoveredTool], None],
    case_id: str | None,
) -> None:
    scanner = next((tool for tool in tools if tool.spec.key == "spiderfoot_cli"), None)
    st.markdown("### SpiderFoot mission builder")
    st.caption(
        "Build a standalone scan with conservative concurrency. JSON output is captured exactly, then normalized into case entities, observations, claims and findings."
    )
    if not scanner or not scanner.installed:
        st.warning("SpiderFoot is not available in PATH. On Kali, install it and refresh local tool discovery.")
        st.code("sudo apt update && sudo apt install spiderfoot", language="bash")
    else:
        left, right = st.columns([0.62, 0.38])
        target = left.text_input(
            "Target",
            placeholder="example.org, 203.0.113.10, analyst@example.org, username…",
            key="arsenal_sf_target",
        )
        preset_key = right.selectbox(
            "Mission preset",
            [preset.key for preset in SPIDERFOOT_PRESETS],
            format_func=lambda key: next(preset.label for preset in SPIDERFOOT_PRESETS if preset.key == key),
            key="arsenal_sf_preset",
        )
        preset = next(item for item in SPIDERFOOT_PRESETS if item.key == preset_key)
        st.info(preset.description)
        modules: list[str] = []
        event_types: list[str] = []
        strict = False
        filter_requested = True
        if preset_key == "modules":
            modules = [value.strip() for value in st.text_area("Module IDs", placeholder="sfp_dnsresolve\nsfp_crt").replace(",", "\n").splitlines() if value.strip()]
        elif preset_key == "event_types":
            event_types = [value.strip() for value in st.text_area("Event types", placeholder="INTERNET_NAME\nEMAILADDR").replace(",", "\n").splitlines() if value.strip()]
            col1, col2 = st.columns(2)
            filter_requested = col1.checkbox("Filter to requested event types", value=True)
            strict = col2.checkbox("Strict type matching", value=False)
        max_threads = st.slider("Maximum worker threads", 1, 20, preset.max_threads)
        try:
            plan = build_spiderfoot_plan(
                scanner.executable or "spiderfoot",
                target,
                preset_key,
                modules=modules,
                event_types=event_types,
                strict=strict,
                filter_requested=filter_requested,
                max_threads=max_threads,
            )
        except ValueError as exc:
            plan = None
            st.caption(str(exc))
        if plan:
            render_plan(plan, scanner)

    with st.expander("SpiderFoot local UI and API-key configuration", expanded=False):
        st.write(
            "The local UI is useful for module configuration, including API keys, and exploratory graph review. "
            "It is fixed to loopback and is never exposed as a hosted service."
        )
        service: SpiderFootService | None = st.session_state.get("spiderfoot_service")
        if service and not service.running():
            service.close_log()
            artifact_id = _archive_service_log(case_id, service, str(st.session_state.get("spiderfoot_service_run_id") or ""))
            st.session_state.pop("spiderfoot_service", None)
            st.session_state.pop("spiderfoot_service_run_id", None)
            service = None
            st.warning(f"The local SpiderFoot process exited. Its log was archived as `{artifact_id}`." if artifact_id else "The local SpiderFoot process exited; select a case before the next launch so its log can be archived.")
        running = bool(service and service.running())
        port = st.number_input("Loopback port", min_value=1024, max_value=65535, value=5001, disabled=running)
        col1, col2, col3 = st.columns([1, 1, 2])
        if not case_id:
            st.caption("Select a Research Mode case before launch so the service lifecycle and exact log are preserved.")
        if col1.button("Start local UI", disabled=running or not scanner or not scanner.installed or not case_id):
            try:
                service = SpiderFootService.start(scanner.executable or "spiderfoot", int(port))
                st.session_state.spiderfoot_service = service
                run_id = ""
                if case_id:
                    run_id = CaseStore().create_run(
                        case_id,
                        "spiderfoot-local-service",
                        adapter="spiderfoot_web",
                        traffic_class="loopback-service",
                        config={"listener": service.url, "executable": service.executable},
                    )
                st.session_state.spiderfoot_service_run_id = run_id
                st.rerun()
            except (OSError, RuntimeError) as exc:
                st.error(str(exc))
        if col2.button("Stop and archive log", disabled=not running):
            assert service is not None
            service.stop()
            artifact_id = _archive_service_log(case_id, service, str(st.session_state.get("spiderfoot_service_run_id") or ""))
            st.session_state.pop("spiderfoot_service", None)
            st.session_state.pop("spiderfoot_service_run_id", None)
            if artifact_id:
                st.success(f"Local service stopped; exact log archived as `{artifact_id}`.")
            st.rerun()
        if running and service:
            col3.success(f"Listening only on {service.url}")
            st.link_button("Open SpiderFoot in a separate browser tab", service.url, type="primary")
            st.caption(f"Service log: {service.log_path}")
        elif not scanner or not scanner.installed:
            col3.caption("Install SpiderFoot before starting its local UI.")


def _render_matrix(tools: list[DiscoveredTool]) -> None:
    st.markdown("### Capability matrix")
    categories = sorted({tool.spec.category for tool in tools})
    selected_categories = st.multiselect("Categories", categories, default=categories)
    installed_only = st.checkbox("Installed tools only", value=False)
    filtered = [tool for tool in tools if tool.spec.category in selected_categories and (tool.installed or not installed_only)]
    installed = sum(1 for tool in tools if tool.installed)
    normalized = sum(1 for tool in tools if tool.spec.normalized)
    passive = sum(1 for tool in tools if tool.spec.risk == "passive")
    col1, col2, col3 = st.columns(3)
    col1.metric("Installed", f"{installed}/{len(tools)}")
    col2.metric("Normalized adapters", normalized)
    col3.metric("Passive-class tools", passive)
    rows = [
        {
            "Tool": tool.spec.label,
            "Status": "Installed" if tool.installed else "Unavailable",
            "Category": tool.spec.category,
            "Traffic": tool.spec.risk,
            "Targets": ", ".join(tool.spec.target_types),
            "Capabilities": ", ".join(tool.spec.capabilities),
            "Outputs": ", ".join(tool.spec.output_formats),
            "Normalized": tool.spec.normalized,
            "Install": tool.spec.install_hint,
        }
        for tool in filtered
    ]
    st.dataframe(rows, width="stretch", hide_index=True)
    st.caption("Traffic class describes the adapter's possible behavior; review the final command and selected modules before execution.")


def _render_comparison(case_id: str | None) -> None:
    st.markdown("### Findings and run comparison")
    if not case_id:
        st.info("Select or create a Research Mode case to compare arsenal runs and findings.")
        return
    store = CaseStore()
    runs = [row for row in store.list_runs(case_id, limit=500) if row.get("run_type") == "kali-tool-execution"]
    run_rows: list[dict[str, Any]] = []
    for row in runs:
        config = _json_object(row.get("config_json"))
        summary = _json_object(row.get("summary_json"))
        normalization = _json_object(summary.get("normalization"))
        run_rows.append(
            {
                "Run": row.get("id"),
                "Tool": row.get("adapter"),
                "Status": row.get("status"),
                "Traffic": row.get("traffic_class"),
                "Started": row.get("started_at"),
                "Duration (s)": summary.get("duration_seconds"),
                "Parsed events": normalization.get("parsed_events", 0),
                "Findings": normalization.get("findings", 0),
                "Command": " ".join(config.get("argv", [])),
            }
        )
    if run_rows:
        st.dataframe(run_rows, width="stretch", hide_index=True)
    else:
        st.info("No arsenal executions are attached to this case yet.")
    findings = store.list_findings(case_id)
    if findings:
        st.markdown("#### Correlated findings")
        st.dataframe(
            [
                {
                    "Severity": row.get("severity"),
                    "Status": row.get("status"),
                    "Title": row.get("title"),
                    "Tool detail": row.get("summary"),
                    "Created": row.get("created_at"),
                    "Finding ID": row.get("id"),
                }
                for row in findings
            ],
            width="stretch",
            hide_index=True,
        )
        st.caption("Values remain unredacted in this local case so the analyst can validate the exact exposure evidence.")


def render_arsenal_mode(
    tools: list[DiscoveredTool],
    render_plan: Callable[[CommandPlan, DiscoveredTool], None],
    render_legacy: Callable[[], None],
    case_id: str | None,
) -> None:
    st.title("OSINT Tool Arsenal")
    st.caption("SpiderFoot-led multi-tool collection with exact local evidence, normalized outputs and comparable findings.")
    quick_target = str(st.session_state.get("quick_recon_target") or "").strip()
    if quick_target:
        target_type = str(st.session_state.get("quick_recon_target_type") or "target")
        sources = [str(item) for item in st.session_state.get("quick_recon_sources", [])]
        st.info(
            f"Quick target ready · {target_type}: {quick_target}"
            + (f" · selected source steps: {', '.join(sources)}" if sources else "")
        )
    view = stage_picker(
        "Arsenal stage",
        ("SpiderFoot", "Capability Matrix", "Findings & Compare", "Advanced Builders"),
        key="arsenal_workspace_stage",
    )
    if view == "SpiderFoot":
        _render_spiderfoot(tools, render_plan, case_id)
    elif view == "Capability Matrix":
        _render_matrix(tools)
    elif view == "Findings & Compare":
        _render_comparison(case_id)
    else:
        render_legacy()
