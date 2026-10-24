from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any

import pandas as pd
import streamlit as st

from osint_studio import __version__
from osint_studio.release import load_release_manifest
from osint_studio.case_store import CaseStore
from osint_studio.evidence_pipeline import ResearchEvidencePipeline
from osint_studio.executor import HISTORY_PATH, load_history, run_command
from osint_studio.help_parser import CACHE_DIR, capture_help
from osint_studio.hunt_profiles import (
    PROFILE_SCHEMA_VERSION,
    TemplateValidationError,
    all_profiles,
    built_in_profiles,
    delete_custom_profile,
    load_custom_profiles,
    load_matrix_draft,
    load_profile_json,
    normalize_profile,
    profile_summary,
    save_custom_profile,
    save_matrix_draft,
    starter_profile,
)
from osint_studio.models import CommandPlan, DiscoveredTool, HelpSnapshot
from osint_studio.option_groups import group_options
from osint_studio.recipes import build_guided_plan, render_command
from osint_studio.registry import discover_tools
from osint_studio.web_recon import (
    DEFAULT_RESULT_FIELDS,
    EXTRACTOR_METHODS,
    EXTRACTOR_SOURCES,
    OPTIONAL_LARGE_FIELDS,
    RULE_OPERATORS,
    RULE_SECTIONS,
    PageRecord,
    SearchResult,
    build_search_query,
    dataframe_to_csv_bytes,
    discover_urls,
    filter_targets,
    run_recon,
    targets_from_urls,
)
from osint_studio.supercharger import (
    CandidateFilter,
    JobStore,
    SuperchargerPlan,
    build_query_matrix,
    estimate_query_matrix_size,
    job_path,
    rows_to_csv_bytes,
    run_discovery_plan,
    run_expansion,
    split_lines as super_split_lines,
)
from osint_studio.research_mode import active_case_id, render_research_mode
from osint_studio.arsenal_mode import render_arsenal_mode
from osint_studio.geo_explorer import render_geo_explorer
from osint_studio.quick_recon import render_quick_recon
from osint_studio.domain_security import render_domain_security_command_center
from osint_studio.property_mode import render_tax_permit_studio
from osint_studio.privacy_mode import render_privacy_removal_studio
from osint_studio.divedeep_mode import render_divedeep_operations
from osint_studio.divedeep_image_mode import render_divedeep_image_recon
from osint_studio.case_workspace import render_case_workspace
from osint_studio.ui_shell import ACTIVE_CASE_KEY, consume_pending_workspace, request_workspace, stage_picker
from osint_studio.extension_receiver import start_background_receiver


APP_ROOT = Path(__file__).resolve().parent


st.set_page_config(
    page_title="OSINT Dive Deep v1",
    page_icon="ðŸ”Ž",
    layout="wide",
    initial_sidebar_state="expanded",
)


@st.cache_resource
def integrated_extension_receiver(port: int):
    return start_background_receiver(port)


if os.environ.get("OSINT_ENABLE_RECEIVER", "").strip() == "1":
    integrated_extension_receiver(int(os.environ.get("OSINT_RECEIVER_PORT", "8765")))

st.markdown(
    """
    <style>
    :root {--divedeep-blue:#1688ff;--divedeep-cyan:#27c7ff;--divedeep-navy:#07101f;}
    .block-container {padding-top: 4rem; padding-bottom: 2rem; max-width: 1600px;}
    .tool-card {border:1px solid rgba(128,128,128,.25);border-radius:12px;padding:14px;margin-bottom:10px;}
    .stage-card {border:1px solid rgba(128,128,128,.25);border-radius:14px;padding:12px 14px;min-height:104px;}
    .stage-number {font-size:.75rem;opacity:.65;text-transform:uppercase;letter-spacing:.08em;}
    .stage-title {font-size:1.05rem;font-weight:700;margin:.1rem 0 .25rem 0;}
    .command-chip {display:inline-block;border:1px solid rgba(128,128,128,.3);border-radius:999px;padding:4px 9px;margin:2px;font-family:monospace;font-size:.82rem;}
    code {white-space: pre-wrap !important;}
    section[data-testid="stSidebar"] {background:linear-gradient(180deg,#050b15 0%,#071426 52%,#06101e 100%);border-right:1px solid rgba(65,145,255,.18);}
    section[data-testid="stSidebar"] [data-testid="stSidebarUserContent"] {padding-top:.65rem;}
    section[data-testid="stSidebar"] [data-testid="stImage"] {display:flex;justify-content:center;}
    section[data-testid="stSidebar"] [data-testid="stImage"] img {border-radius:12px;border:1px solid rgba(65,145,255,.18);}
    section[data-testid="stSidebar"] .stButton > button {justify-content:flex-start;text-align:left;border-radius:9px;border:1px solid transparent;background:transparent;color:#cdd8e8;min-height:2.35rem;padding:.42rem .7rem;}
    section[data-testid="stSidebar"] .stButton > button:hover {border-color:rgba(39,199,255,.28);background:rgba(22,136,255,.09);color:#ffffff;}
    section[data-testid="stSidebar"] .stButton > button[kind="primary"] {background:linear-gradient(90deg,rgba(22,136,255,.28),rgba(39,199,255,.10));border-color:rgba(39,199,255,.42);color:#ffffff;box-shadow:inset 3px 0 0 #27c7ff;}
    section[data-testid="stSidebar"] .nav-section {margin:1rem 0 .3rem .15rem;color:#6e8baa;font-size:.69rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;}
    section[data-testid="stSidebar"] .brand-title {margin:.55rem 0 0;color:#f3f7ff;font-size:1.08rem;font-weight:700;letter-spacing:.13em;text-align:center;}
    section[data-testid="stSidebar"] .brand-subtitle {margin:.12rem 0 .5rem;color:#6f91b7;font-size:.68rem;letter-spacing:.12em;text-align:center;text-transform:uppercase;}
    section[data-testid="stSidebar"] hr {border-color:rgba(65,145,255,.16);margin:.75rem 0;}
    </style>
    """,
    unsafe_allow_html=True,
)


@st.cache_data(show_spinner=False, ttl=30)
def get_tools() -> list[DiscoveredTool]:
    return discover_tools()


@st.cache_data(show_spinner=False, ttl=300)
def get_help_snapshot(tool_key: str, executable: str, force_token: int = 0) -> HelpSnapshot:
    tool = next(item for item in discover_tools() if item.spec.key == tool_key)
    return capture_help(tool, force=force_token > 0)


def init_state() -> None:
    pending = st.session_state.pop("_pending_job_config", None)
    if pending:
        discovery = pending.get("discovery", {})
        for key, value in discovery.items():
            st.session_state[f"recon_{key}"] = value
        matching = pending.get("matching", {})
        st.session_state.recon_within_group = matching.get("within_group", "AND")
        st.session_state.recon_between_groups = matching.get("between_groups", "AND")
        st.session_state.recon_minimum_score = float(matching.get("minimum_score", 0.0))
        prefilter = pending.get("prefilter", {})
        for key, value in prefilter.items():
            st.session_state[f"recon_prefilter_{key}"] = value
        rule_rows = pending.get("rules", [])
        extractor_rows = pending.get("extractors", [])
        st.session_state.recon_rules = pd.DataFrame(
            rule_rows,
            columns=["Group", "Group logic", "Section", "Operator", "Value", "Case sensitive", "Required", "Weight"],
        )
        st.session_state.recon_extractors = pd.DataFrame(
            extractor_rows,
            columns=["Column name", "Method", "Source", "Pattern or selector", "Attribute", "Multiple"],
        )
        selected_fields = pending.get("selected_fields", DEFAULT_RESULT_FIELDS.copy())
        st.session_state.selected_result_fields = selected_fields
        st.session_state.recon_selected_fields_widget = selected_fields
        fetch = pending.get("fetch", {})
        for key, value in fetch.items():
            st.session_state[f"recon_{key}"] = value
        if fetch.get("max_bytes"):
            st.session_state.recon_max_mb = float(fetch["max_bytes"]) / 1_000_000
        for transient_key in (
            "recon_rules_editor",
            "recon_extractors_editor",
            "recon_job_upload",
            "recon_csv_upload",
        ):
            st.session_state.pop(transient_key, None)

    if "recon_targets" not in st.session_state:
        st.session_state.recon_targets = []
    if "recon_results" not in st.session_state:
        st.session_state.recon_results = []
    if "recon_rules" not in st.session_state:
        st.session_state.recon_rules = pd.DataFrame(columns=["Group", "Group logic", "Section", "Operator", "Value", "Case sensitive", "Required", "Weight"])
    if "recon_extractors" not in st.session_state:
        st.session_state.recon_extractors = pd.DataFrame(
            columns=["Column name", "Method", "Source", "Pattern or selector", "Attribute", "Multiple"]
        )
    if "selected_result_fields" not in st.session_state:
        st.session_state.selected_result_fields = DEFAULT_RESULT_FIELDS.copy()

    # Visual prefilters prevent obvious noise from being fetched at all.
    for key in (
        "excluded_domains",
        "excluded_url_terms",
        "excluded_title_terms",
        "excluded_snippet_terms",
        "required_url_terms",
    ):
        st.session_state.setdefault(f"recon_prefilter_{key}", "")

    # Query-builder values are initialized once instead of passing widget defaults on every rerun.
    draft = load_matrix_draft()
    generic_matrix = built_in_profiles()["Blank expansive hunt"]["matrix"]
    matrix_defaults = {**generic_matrix, **draft}
    for key, value in matrix_defaults.items():
        st.session_state.setdefault(f"super_{key}", value)
    st.session_state.setdefault("super_query_shards", [])
    st.session_state.setdefault("super_profile_name", "Blank expansive hunt")


init_state()


def stage_header() -> None:
    columns = st.columns(4)
    stages = [
        ("01", "Discover", "Search the web, paste URLs, or import a CSV target column."),
        ("02", "Inspect", "Fetch public HTML and divide it into semantic page regions."),
        ("03", "Match", "Apply grouped rules against titles, headers, footers, and scripts."),
        ("04", "Export", "Normalize results into a configurable, detailed CSV schema."),
    ]
    for column, (number, title, body) in zip(columns, stages):
        column.markdown(
            f"<div class='stage-card'><div class='stage-number'>Stage {number}</div>"
            f"<div class='stage-title'>{title}</div><div>{body}</div></div>",
            unsafe_allow_html=True,
        )


def search_result_dict(result: SearchResult) -> dict[str, Any]:
    return {
        "url": result.url,
        "title": result.title,
        "snippet": result.snippet,
        "rank": result.rank,
        "query": result.query,
        "source": result.source,
    }


def dict_to_search_result(value: dict[str, Any]) -> SearchResult:
    return SearchResult(
        url=str(value.get("url") or ""),
        title=str(value.get("title") or ""),
        snippet=str(value.get("snippet") or ""),
        rank=int(value.get("rank") or 0),
        query=str(value.get("query") or ""),
        source=str(value.get("source") or "web-search"),
    )


def target_table() -> pd.DataFrame:
    rows = st.session_state.recon_targets
    if not rows:
        return pd.DataFrame(columns=["rank", "source", "title", "url", "snippet"])
    return pd.DataFrame(rows)[["rank", "source", "title", "url", "snippet"]]


def load_job_config(payload: dict[str, Any]) -> None:
    """Queue a job config so widget-bound state is applied before the next render."""
    st.session_state._pending_job_config = payload


MATRIX_KEYS = [
    "bases",
    "variants",
    "geographies",
    "excludes",
    "sites",
    "title_terms",
    "url_terms",
    "filetypes",
    "templates",
    "max_queries",
    "candidate_excluded_domains",
    "candidate_excluded_url_terms",
    "candidate_excluded_title_terms",
    "candidate_excluded_snippet_terms",
    "candidate_required_url_terms",
]


def current_matrix_config() -> dict[str, Any]:
    return {key: st.session_state.get(f"super_{key}", "") for key in MATRIX_KEYS}


def apply_matrix_config(matrix: dict[str, Any]) -> None:
    for key in MATRIX_KEYS:
        if key in matrix:
            st.session_state[f"super_{key}"] = matrix[key]
    save_matrix_draft(current_matrix_config())


def visual_payload_from_profile(profile: dict[str, Any]) -> dict[str, Any]:
    normalized, _warnings = normalize_profile(profile, strict=True)
    visual = normalized.get("visual", {})
    current = current_job_config()
    current["schema_version"] = "visual-recon-v2"
    current["matching"] = visual.get("matching", current.get("matching", {}))
    current["prefilter"] = visual.get("prefilter", current.get("prefilter", {}))
    current["rules"] = visual.get("rules", current.get("rules", []))
    current["extractors"] = visual.get("extractors", current.get("extractors", []))
    current["selected_fields"] = visual.get("selected_fields", current.get("selected_fields", DEFAULT_RESULT_FIELDS.copy()))
    current["fetch"] = visual.get("fetch", current.get("fetch", {}))
    return current


def current_hunt_profile(name: str) -> dict[str, Any]:
    config = current_job_config()
    rules = [
        row for row in config["rules"]
        if any(str(row.get(key, "")).strip() for key in ("Section", "Operator", "Value"))
    ]
    extractors = [
        row for row in config["extractors"]
        if any(str(row.get(key, "")).strip() for key in ("Column name", "Method", "Pattern or selector"))
    ]
    payload = {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "template_id": name,
        "name": name,
        "description": "User-saved discovery matrix, fast filters, visual rules, extractors, and fetch controls.",
        "metadata": {
            "tags": ["custom"],
            "author": "OSINT Query Studio user",
            "compatible_app_versions": "5.x",
        },
        "matrix": current_matrix_config(),
        "visual": {
            "matching": config["matching"],
            "prefilter": config.get("prefilter", {}),
            "rules": rules,
            "extractors": extractors,
            "selected_fields": config["selected_fields"],
            "fetch": config.get("fetch", {}),
        },
    }
    normalized, _warnings = normalize_profile(payload, strict=True)
    return normalized


def _apply_hunt_profile(profile: dict[str, Any], mode: str) -> list[str]:
    normalized, warnings = normalize_profile(profile, strict=True)
    if mode in {"discovery", "complete"}:
        apply_matrix_config(normalized.get("matrix", {}))
        st.session_state.super_profile_name = normalized["name"]
    if mode in {"visual", "complete"}:
        load_job_config(visual_payload_from_profile(normalized))
    return warnings


def render_hunt_profile_toolbar(scope: str) -> None:
    profiles = all_profiles()
    names = list(profiles)
    key_prefix = "super" if scope == "discovery" else "visual"
    selected = st.selectbox(
        "Hunt template",
        names,
        key=f"{key_prefix}_hunt_profile",
        help=(
            "Reusable JSON templates can configure discovery terms, query lanes, fast filters, "
            "visual fingerprints, extractors, output fields, and fetch controls."
        ),
    )
    profile = profiles[selected]
    summary = profile_summary(profile)
    st.caption(str(profile.get("description") or ""))
    metric_cols = st.columns(4)
    metric_cols[0].metric("Query lanes", summary["query_templates"])
    metric_cols[1].metric("Rules", summary["rules"])
    metric_cols[2].metric("Extractors", summary["extractors"])
    metric_cols[3].metric("Geographies", summary["geographies"])

    if scope == "discovery":
        col1, col2, col3 = st.columns([1, 1, 2])
        if col1.button("Apply discovery template", key="apply_discovery_profile", type="primary"):
            _apply_hunt_profile(profile, "discovery")
            st.rerun()
        if col2.button("Apply complete hunt", key="apply_complete_profile"):
            _apply_hunt_profile(profile, "complete")
            st.rerun()
        col3.info("Apply complete hunt to configure Discovery and Visual Web Recon together.")
    else:
        col1, col2 = st.columns([1, 3])
        if col1.button("Apply recon template", key="apply_visual_profile", type="primary"):
            _apply_hunt_profile(profile, "visual")
            st.rerun()
        col2.info("This replaces the current rules, extractors, match logic, pre-fetch filters, and fetch controls.")

    with st.expander("Template JSON Center", expanded=False):
        st.caption(
            "Create, validate, import, install, and export complete hunt templates. "
            "Legacy hunt-profile-v1 JSON is migrated automatically."
        )
        save_col, delete_col = st.columns(2)
        custom_name = save_col.text_input("Custom template name", key=f"{key_prefix}_custom_profile_name")
        if save_col.button("Save current setup", key=f"{key_prefix}_save_profile", disabled=not custom_name.strip()):
            try:
                path = save_custom_profile(current_hunt_profile(custom_name.strip()), custom_name.strip())
                st.success(f"Saved reusable template to {path}")
                st.rerun()
            except TemplateValidationError as exc:
                st.error("Cannot save template:\n- " + "\n- ".join(exc.errors))

        custom_profiles = load_custom_profiles()
        if delete_col.button(
            "Delete selected custom template",
            key=f"{key_prefix}_delete_profile",
            disabled=selected not in custom_profiles,
        ):
            if delete_custom_profile(selected):
                st.success(f"Deleted custom template: {selected}")
                st.rerun()

        export_payload: dict[str, Any] | None = None
        try:
            export_payload = current_hunt_profile(custom_name.strip() or "current_hunt")
        except TemplateValidationError as exc:
            st.warning(
                "The current setup contains incomplete or unsupported rows and cannot be exported yet:\n- "
                + "\n- ".join(exc.errors)
            )
        export_col, starter_col = st.columns(2)
        if export_payload is not None:
            export_col.download_button(
                "Export current setup JSON",
                data=json.dumps(export_payload, indent=2, ensure_ascii=False).encode("utf-8"),
                file_name="osint_hunt_template.json",
                mime="application/json",
                key=f"{key_prefix}_export_profile",
            )
        else:
            export_col.info("Complete or remove invalid rows to enable export.")
        starter_col.download_button(
            "Download starter template JSON",
            data=json.dumps(starter_profile(), indent=2, ensure_ascii=False).encode("utf-8"),
            file_name="osint_template_starter.json",
            mime="application/json",
            key=f"{key_prefix}_starter_profile",
        )

        st.markdown("#### Import a JSON template")
        uploaded = st.file_uploader(
            "Choose a hunt template",
            type=["json"],
            key=f"{key_prefix}_profile_upload",
            help="The file is validated before any current settings are replaced.",
        )
        imported_profile: dict[str, Any] | None = None
        imported_warnings: list[str] = []
        if uploaded is not None:
            try:
                imported_profile, imported_warnings = load_profile_json(uploaded.getvalue())
                imported_summary = profile_summary(imported_profile)
                st.success(
                    f"Valid template: {imported_summary['name']} · "
                    f"{imported_summary['query_templates']} query lanes · "
                    f"{imported_summary['rules']} rules · "
                    f"{imported_summary['extractors']} extractors"
                )
                if imported_warnings:
                    st.warning("\n".join(f"â€¢ {item}" for item in imported_warnings))
            except TemplateValidationError as exc:
                st.error("Template validation failed:\n- " + "\n- ".join(exc.errors))

        if imported_profile is not None:
            apply_discovery_col, apply_visual_col, apply_complete_col, install_col = st.columns(4)
            if apply_discovery_col.button("Apply discovery", key=f"{key_prefix}_import_discovery"):
                _apply_hunt_profile(imported_profile, "discovery")
                st.rerun()
            if apply_visual_col.button("Apply recon", key=f"{key_prefix}_import_visual"):
                _apply_hunt_profile(imported_profile, "visual")
                st.rerun()
            if apply_complete_col.button("Apply complete", key=f"{key_prefix}_import_complete", type="primary"):
                _apply_hunt_profile(imported_profile, "complete")
                st.rerun()
            if install_col.button("Install in library", key=f"{key_prefix}_install_import"):
                path = save_custom_profile(imported_profile)
                st.success(f"Installed template at {path}")
                st.rerun()

        with st.expander("Advanced JSON editor", expanded=False):
            editor_key = f"{key_prefix}_template_json_editor"
            st.session_state.setdefault(editor_key, json.dumps(starter_profile(), indent=2, ensure_ascii=False))
            editor_buttons = st.columns(2)
            if editor_buttons[0].button("Load current setup into editor", key=f"{key_prefix}_load_current_editor"):
                if export_payload is not None:
                    st.session_state[editor_key] = json.dumps(export_payload, indent=2, ensure_ascii=False)
                    st.rerun()
                else:
                    st.error("Current setup is not valid enough to load into the JSON editor.")
            if editor_buttons[1].button("Reset editor to starter", key=f"{key_prefix}_reset_editor"):
                st.session_state[editor_key] = json.dumps(starter_profile(), indent=2, ensure_ascii=False)
                st.rerun()
            raw_json = st.text_area(
                "Template JSON",
                key=editor_key,
                height=420,
                help="Use the included AI_INSTRUCTIONS.md and templates/template.schema.json when generating this JSON with AI.",
            )
            validate_col, apply_col, install_editor_col = st.columns(3)
            validated_editor: dict[str, Any] | None = None
            try:
                validated_editor, editor_warnings = load_profile_json(raw_json)
                st.caption(
                    f"Live validation: {validated_editor['name']} · "
                    f"{len(validated_editor['visual']['rules'])} rules · "
                    f"{len(validated_editor['visual']['extractors'])} extractors"
                )
                if editor_warnings:
                    st.caption("Warnings: " + " | ".join(editor_warnings))
            except TemplateValidationError as exc:
                editor_errors = exc.errors
                validated_editor = None
                st.caption("Live validation: errors detected")

            if validate_col.button("Validate JSON", key=f"{key_prefix}_validate_editor"):
                if validated_editor is not None:
                    st.success("Template JSON is valid and compatible.")
                else:
                    st.error("\n".join(f"â€¢ {item}" for item in editor_errors))
            if apply_col.button(
                "Apply editor JSON",
                key=f"{key_prefix}_apply_editor",
                type="primary",
                disabled=validated_editor is None,
            ):
                _apply_hunt_profile(validated_editor or {}, "complete")
                st.rerun()
            if install_editor_col.button(
                "Install editor JSON",
                key=f"{key_prefix}_install_editor",
                disabled=validated_editor is None,
            ):
                path = save_custom_profile(validated_editor or {})
                st.success(f"Installed template at {path}")
                st.rerun()


def current_job_config() -> dict[str, Any]:
    discovery_keys = [
        "input_mode",
        "base_terms",
        "exact_phrases",
        "any_terms",
        "exclude_terms",
        "site",
        "title_terms",
        "url_terms",
        "filetype",
        "custom_syntax",
        "backend",
        "region",
        "safesearch",
        "timelimit",
        "max_results",
    ]
    fetch_keys = ["workers", "timeout", "verify_tls", "follow_redirects", "max_bytes", "include_nonmatches"]
    return {
        "schema_version": "visual-recon-v2",
        "discovery": {key: st.session_state.get(f"recon_{key}") for key in discovery_keys},
        "matching": {
            "within_group": st.session_state.get("recon_within_group", "AND"),
            "between_groups": st.session_state.get("recon_between_groups", "AND"),
            "minimum_score": st.session_state.get("recon_minimum_score", 0.0),
        },
        "prefilter": {
            key: st.session_state.get(f"recon_prefilter_{key}", "")
            for key in (
                "excluded_domains",
                "excluded_url_terms",
                "excluded_title_terms",
                "excluded_snippet_terms",
                "required_url_terms",
            )
        },
        "rules": st.session_state.recon_rules.fillna("").to_dict("records"),
        "extractors": st.session_state.recon_extractors.fillna("").to_dict("records"),
        "selected_fields": st.session_state.selected_result_fields,
        "fetch": {key: st.session_state.get(f"recon_{key}") for key in fetch_keys},
    }


def render_discovery_tab() -> None:
    st.markdown("### Target discovery")
    st.caption("Build a search query visually, paste direct targets, or import a URL/domain column from a CSV.")

    input_mode = st.radio(
        "Input source",
        ["Search the web", "Paste URL list", "Import CSV"],
        horizontal=True,
        key="recon_input_mode",
    )

    if input_mode == "Search the web":
        left, right = st.columns([1.15, 0.85])
        with left:
            st.markdown("#### Search intent")
            base_terms = st.text_input("General terms", key="recon_base_terms", placeholder="restaurant platform Tampa FL")
            exact_phrases = st.text_area(
                "Exact phrases",
                key="recon_exact_phrases",
                placeholder="One exact phrase per line",
                height=90,
            )
            col1, col2 = st.columns(2)
            any_terms = col1.text_area("Any of these terms", key="recon_any_terms", placeholder="order online, menu, delivery")
            exclude_terms = col2.text_area("Exclude these terms", key="recon_exclude_terms", placeholder="jobs, careers")
        with right:
            st.markdown("#### Search operators")
            col1, col2 = st.columns(2)
            site = col1.text_input("Restrict to site/domain", key="recon_site", placeholder="example.org")
            filetype = col2.text_input("File type", key="recon_filetype", placeholder="pdf")
            title_terms = st.text_area("Text required in indexed title", key="recon_title_terms", height=70)
            url_terms = st.text_area("Text required in indexed URL", key="recon_url_terms", height=70)
            custom_syntax = st.text_input("Additional search syntax", key="recon_custom_syntax")

        query = build_search_query(
            base_terms=base_terms,
            exact_phrases=exact_phrases,
            any_terms=any_terms,
            exclude_terms=exclude_terms,
            site=site,
            title_terms=title_terms,
            url_terms=url_terms,
            filetype=filetype,
            custom_syntax=custom_syntax,
        )
        st.markdown("#### Generated search query")
        st.code(query or "Add search criteria above.", language="text")

        with st.expander("Search engine controls", expanded=False):
            col1, col2, col3, col4 = st.columns(4)
            backend = col1.text_input("DDGS backend", value="auto", key="recon_backend", help="Examples: auto, bing, brave, google, duckduckgo, or a comma-delimited list.")
            region = col2.text_input("Region", value="us-en", key="recon_region")
            safesearch = col3.selectbox("Safe search", ["moderate", "off", "on"], key="recon_safesearch")
            timelimit_label = col4.selectbox("Time limit", ["Any time", "Day", "Week", "Month", "Year"], key="recon_timelimit")
            max_results = st.slider("Maximum search results", 1, 200, 25, key="recon_max_results")
        timelimit_map = {"Any time": None, "Day": "d", "Week": "w", "Month": "m", "Year": "y"}

        if st.button("Discover target URLs", type="primary", disabled=not bool(query)):
            with st.status("Searching through DDGSâ€¦", expanded=True) as status:
                try:
                    results = discover_urls(
                        query,
                        max_results=int(max_results),
                        backend=backend,
                        region=region,
                        safesearch=safesearch,
                        timelimit=timelimit_map[timelimit_label],
                    )
                    st.session_state.recon_targets = [search_result_dict(item) for item in results]
                    status.update(label=f"Discovered {len(results)} unique targets", state="complete")
                except Exception as exc:
                    status.update(label="Search failed", state="error")
                    st.error(f"{type(exc).__name__}: {exc}")

    elif input_mode == "Paste URL list":
        pasted = st.text_area(
            "URLs or domains",
            height=220,
            placeholder="One URL or domain per line",
            key="recon_pasted_urls",
        )
        if st.button("Load pasted targets", type="primary"):
            targets = targets_from_urls(pasted.splitlines(), source="pasted-list")
            st.session_state.recon_targets = [search_result_dict(item) for item in targets]
            st.success(f"Loaded {len(targets)} unique targets.")

    else:
        upload = st.file_uploader("Upload a CSV containing URLs or domains", type=["csv"], key="recon_csv_upload")
        if upload:
            try:
                frame = pd.read_csv(upload, dtype=str, keep_default_na=False)
                if frame.empty:
                    st.warning("The uploaded CSV has no data rows.")
                else:
                    column = st.selectbox("Target column", list(frame.columns), key="recon_csv_column")
                    st.dataframe(frame.head(20), width="stretch", hide_index=True)
                    if st.button("Load CSV targets", type="primary"):
                        targets = targets_from_urls(frame[column].tolist(), source=f"csv:{column}")
                        st.session_state.recon_targets = [search_result_dict(item) for item in targets]
                        st.success(f"Loaded {len(targets)} unique targets from `{column}`.")
            except Exception as exc:
                st.error(f"Could not read the CSV: {exc}")

    st.divider()
    col1, col2 = st.columns([4, 1])
    col1.markdown(f"#### Current target set · {len(st.session_state.recon_targets)} URLs")
    if col2.button("Clear targets", disabled=not st.session_state.recon_targets):
        st.session_state.recon_targets = []
        st.session_state.recon_results = []
        st.rerun()
    st.dataframe(target_table(), width="stretch", hide_index=True, height=340)


def render_rules_tab() -> None:
    st.markdown("### Visual match-rule builder")
    st.caption("Rules inspect the actual page after retrieval. Search syntax discovers candidates; these rules decide which pages qualify.")

    col1, col2, col3 = st.columns(3)
    within_group = col1.selectbox("Rules inside each group", ["AND", "OR"], key="recon_within_group")
    between_groups = col2.selectbox("Relationship between groups", ["AND", "OR"], key="recon_between_groups")
    minimum_score = col3.number_input("Minimum weighted score (%)", min_value=0.0, max_value=100.0, value=0.0, step=5.0, key="recon_minimum_score")

    st.info(
        f"Default logic: **{within_group} inside each group**, then **{between_groups} between groups**. "
        "The optional Group logic column can override AND/OR for an individual group. Mark a rule Required when it must pass regardless of weighted score."
    )

    if "Group logic" not in st.session_state.recon_rules.columns:
        st.session_state.recon_rules.insert(1, "Group logic", "")
        st.session_state.pop("recon_rules_editor", None)

    with st.expander("Quick fingerprint and exclusion pack builder", expanded=True):
        st.caption("Paste one text phrase, hostname, script fragment, or exclusion per line. The builder creates the correct multi-section rule rows automatically.")
        q1, q2, q3 = st.columns([1.3, 1, 1])
        pack_mode = q1.selectbox(
            "Pattern type",
            [
                "Footer attribution phrase",
                "Script or vendor hostname",
                "Exact page-text fingerprint",
                "Required negative URL filter",
                "Required negative title filter",
            ],
            key="recon_quick_pack_mode",
        )
        pack_group = q2.text_input("Group label", value="Fingerprint", key="recon_quick_pack_group")
        pack_weight = q3.number_input("Primary weight", 1.0, 100.0, 45.0, step=5.0, key="recon_quick_pack_weight")
        patterns = st.text_area(
            "Patterns · one per line",
            key="recon_quick_pack_patterns",
            height=110,
            placeholder="Your exact footer phrase\nYour vendor hostname",
        )
        add_col, clear_col = st.columns([1, 3])
        if add_col.button("Add rule pack", type="primary", key="recon_add_quick_pack", disabled=not patterns.strip()):
            new_rows: list[dict[str, Any]] = []
            for pattern in super_split_lines(patterns):
                common = {
                    "Group": pack_group.strip() or "Fingerprint",
                    "Case sensitive": False,
                    "Required": False,
                }
                if pack_mode == "Footer attribution phrase":
                    new_rows.extend([
                        {**common, "Group logic": "OR", "Section": "Visible footer", "Operator": "contains", "Value": pattern, "Weight": float(pack_weight)},
                        {**common, "Group logic": "OR", "Section": "Full HTML", "Operator": "contains", "Value": pattern, "Weight": max(1.0, float(pack_weight) * 0.55)},
                    ])
                elif pack_mode == "Script or vendor hostname":
                    new_rows.extend([
                        {**common, "Group logic": "OR", "Section": "Footer scripts", "Operator": "contains", "Value": pattern, "Weight": float(pack_weight)},
                        {**common, "Group logic": "OR", "Section": "All scripts", "Operator": "contains", "Value": pattern, "Weight": max(1.0, float(pack_weight) * 0.9)},
                        {**common, "Group logic": "OR", "Section": "Full HTML", "Operator": "contains", "Value": pattern, "Weight": max(1.0, float(pack_weight) * 0.65)},
                    ])
                elif pack_mode == "Exact page-text fingerprint":
                    new_rows.extend([
                        {**common, "Group logic": "OR", "Section": "Page title", "Operator": "contains", "Value": pattern, "Weight": float(pack_weight)},
                        {**common, "Group logic": "OR", "Section": "Visible footer", "Operator": "contains", "Value": pattern, "Weight": float(pack_weight)},
                        {**common, "Group logic": "OR", "Section": "Body text", "Operator": "contains", "Value": pattern, "Weight": max(1.0, float(pack_weight) * 0.7)},
                        {**common, "Group logic": "OR", "Section": "Full HTML", "Operator": "contains", "Value": pattern, "Weight": max(1.0, float(pack_weight) * 0.5)},
                    ])
                elif pack_mode == "Required negative URL filter":
                    new_rows.append({**common, "Group": pack_group.strip() or "Exclusions", "Group logic": "AND", "Section": "URL", "Operator": "does not contain", "Value": pattern, "Required": True, "Weight": 1.0})
                else:
                    new_rows.append({**common, "Group": pack_group.strip() or "Exclusions", "Group logic": "AND", "Section": "Page title", "Operator": "does not contain", "Value": pattern, "Required": True, "Weight": 1.0})
            existing = st.session_state.recon_rules.fillna("")
            combined = pd.concat([existing, pd.DataFrame(new_rows)], ignore_index=True)
            combined = combined.drop_duplicates(subset=["Group", "Section", "Operator", "Value"], keep="last")
            st.session_state.recon_rules = combined
            st.session_state.pop("recon_rules_editor", None)
            st.rerun()
        if clear_col.button("Clear all rule rows", key="recon_clear_rules"):
            st.session_state.recon_rules = pd.DataFrame(columns=["Group", "Group logic", "Section", "Operator", "Value", "Case sensitive", "Required", "Weight"])
            st.session_state.pop("recon_rules_editor", None)
            st.rerun()

    edited = st.data_editor(
        st.session_state.recon_rules,
        num_rows="dynamic",
        width="stretch",
        hide_index=True,
        column_config={
            "Group": st.column_config.TextColumn(help="Rules with the same group label are evaluated together."),
            "Group logic": st.column_config.SelectboxColumn(options=["", "AND", "OR"], help="Optional per-group override. Leave blank to use the default above."),
            "Section": st.column_config.SelectboxColumn(options=RULE_SECTIONS, required=True),
            "Operator": st.column_config.SelectboxColumn(options=RULE_OPERATORS, required=True),
            "Value": st.column_config.TextColumn(width="large", help="Literal text or a regular expression, depending on the operator."),
            "Case sensitive": st.column_config.CheckboxColumn(default=False),
            "Required": st.column_config.CheckboxColumn(default=False),
            "Weight": st.column_config.NumberColumn(min_value=0.0, max_value=100.0, default=1.0),
        },
        key="recon_rules_editor",
    )
    st.session_state.recon_rules = edited

    st.markdown("#### Common rule patterns")
    examples = pd.DataFrame(
        [
            {"Need": "Title contains a phrase", "Section": "Page title", "Operator": "contains", "Example": "Order Online"},
            {"Need": "Footer loads a known vendor", "Section": "Footer scripts", "Operator": "contains", "Example": "cdn.vendor.example"},
            {"Need": "Any script references a tracking ID", "Section": "All scripts", "Operator": "regex", "Example": r"GTM-[A-Z0-9]+"},
            {"Need": "Page excludes a stale notice", "Section": "Body text", "Operator": "does not contain", "Example": "website under construction"},
            {"Need": "Footer is present", "Section": "Visible footer", "Operator": "exists", "Example": "(value can remain blank)"},
        ]
    )
    st.dataframe(examples, width="stretch", hide_index=True)


def render_extractors_tab() -> None:
    st.markdown("### CSV schema and custom extraction")
    st.caption("Choose standard recon fields and define additional columns with CSS selectors, regular expressions, or JSON-LD paths.")

    all_fields = [*DEFAULT_RESULT_FIELDS, *OPTIONAL_LARGE_FIELDS, "tiktok_links"]
    selected = st.multiselect(
        "Standard output columns",
        all_fields,
        default=st.session_state.selected_result_fields,
        key="recon_selected_fields_widget",
    )
    st.session_state.selected_result_fields = selected

    with st.expander("Large-text columns", expanded=False):
        st.warning(
            "HTML and script snippets can make CSV files large. They are optional and truncated per page. "
            "Use custom extractors when you only need a specific value."
        )

    st.markdown("#### Custom columns")
    edited = st.data_editor(
        st.session_state.recon_extractors,
        num_rows="dynamic",
        width="stretch",
        hide_index=True,
        column_config={
            "Column name": st.column_config.TextColumn(required=True, help="Converted to a CSV-safe snake_case column name."),
            "Method": st.column_config.SelectboxColumn(options=EXTRACTOR_METHODS, required=True, default="Regex"),
            "Source": st.column_config.SelectboxColumn(options=EXTRACTOR_SOURCES, required=True, default="Full HTML"),
            "Pattern or selector": st.column_config.TextColumn(width="large", required=True),
            "Attribute": st.column_config.TextColumn(help="Used only by CSS attribute extraction, such as href or content."),
            "Multiple": st.column_config.CheckboxColumn(default=True, help="Join all distinct matches with a pipe separator."),
        },
        key="recon_extractors_editor",
    )
    st.session_state.recon_extractors = edited

    st.markdown("#### Extractor examples")
    examples = pd.DataFrame(
        [
            {"Column": "cta_links", "Method": "CSS attribute", "Source": "Full HTML", "Pattern": "a.cta, a[href*='book']", "Attribute": "href"},
            {"Column": "footer_copyright", "Method": "CSS text", "Source": "Visible footer", "Pattern": "footer .copyright", "Attribute": ""},
            {"Column": "gtm_ids", "Method": "Regex", "Source": "All scripts", "Pattern": r"GTM-[A-Z0-9]+", "Attribute": ""},
            {"Column": "organization_names", "Method": "JSON-LD key", "Source": "Full HTML", "Pattern": "name", "Attribute": ""},
            {"Column": "same_as_profiles", "Method": "JSON-LD key", "Source": "Full HTML", "Pattern": "sameAs", "Attribute": ""},
        ]
    )
    st.dataframe(examples, width="stretch", hide_index=True)


def render_run_tab() -> None:
    st.markdown("### Execute and export")
    target_count = len(st.session_state.recon_targets)
    rule_count = len(st.session_state.recon_rules)
    extractor_count = len(st.session_state.recon_extractors)
    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Targets", target_count)
    col2.metric("Rule rows", rule_count)
    col3.metric("Custom extractors", extractor_count)
    col4.metric("CSV fields", len(st.session_state.selected_result_fields) + extractor_count)

    with st.expander("Fetch and concurrency controls", expanded=True):
        col1, col2, col3 = st.columns(3)
        workers = col1.slider("Concurrent page fetches", 1, 16, 4, key="recon_workers")
        timeout = col2.number_input("Per-page timeout (seconds)", 3, 120, 15, key="recon_timeout")
        max_mb = col3.number_input("Maximum HTML per page (MB)", 0.25, 10.0, 2.5, step=0.25, key="recon_max_mb")
        col1, col2, col3 = st.columns(3)
        verify_tls = col1.checkbox("Verify TLS certificates", value=True, key="recon_verify_tls")
        follow_redirects = col2.checkbox("Follow redirects", value=True, key="recon_follow_redirects")
        include_nonmatches = col3.checkbox("Include non-matching pages in CSV", value=True, key="recon_include_nonmatches")
        st.session_state.recon_max_bytes = int(float(max_mb) * 1_000_000)

    with st.expander("Pre-fetch target filters · skip obvious noise before making HTTP requests", expanded=True):
        pf1, pf2 = st.columns(2)
        pf1.text_area(
            "Excluded domains · one per line",
            key="recon_prefilter_excluded_domains",
            height=120,
            placeholder="yelp.com\nfacebook.com\nget.vendor.example",
        )
        pf2.text_area(
            "Excluded URL fragments · one per line",
            key="recon_prefilter_excluded_url_terms",
            height=120,
            placeholder="/case-studies\n/blog/\n/jobs",
        )
        pf3, pf4 = st.columns(2)
        pf3.text_area(
            "Excluded search-title terms · one per line",
            key="recon_prefilter_excluded_title_terms",
            height=90,
            placeholder="Case Study\nDirectory\nSoftware Platform",
        )
        pf4.text_area(
            "Excluded search-snippet terms · one per line",
            key="recon_prefilter_excluded_snippet_terms",
            height=90,
            placeholder="marketing platform\nbusiness directory",
        )
        st.text_area(
            "Optional required URL fragments · at least one must match",
            key="recon_prefilter_required_url_terms",
            height=70,
        )

    raw_targets = [dict_to_search_result(item) for item in st.session_state.recon_targets]
    filtered_targets, skipped_targets = filter_targets(
        raw_targets,
        excluded_domains=super_split_lines(st.session_state.get("recon_prefilter_excluded_domains", "")),
        excluded_url_terms=super_split_lines(st.session_state.get("recon_prefilter_excluded_url_terms", "")),
        excluded_title_terms=super_split_lines(st.session_state.get("recon_prefilter_excluded_title_terms", "")),
        excluded_snippet_terms=super_split_lines(st.session_state.get("recon_prefilter_excluded_snippet_terms", "")),
        required_url_terms=super_split_lines(st.session_state.get("recon_prefilter_required_url_terms", "")),
    )
    pfm1, pfm2, pfm3 = st.columns(3)
    pfm1.metric("Targets loaded", len(raw_targets))
    pfm2.metric("Will fetch", len(filtered_targets))
    pfm3.metric("Skipped early", len(skipped_targets))
    if skipped_targets:
        with st.expander("Preview skipped targets", expanded=False):
            st.dataframe(pd.DataFrame(skipped_targets).head(500), width="stretch", hide_index=True)
            st.download_button(
                "Download skipped-target report",
                data=dataframe_to_csv_bytes(skipped_targets),
                file_name="osint_prefilter_skipped.csv",
                mime="text/csv",
            )
            if st.button("Remove skipped targets from current target set", key="recon_remove_skipped"):
                st.session_state.recon_targets = [search_result_dict(item) for item in filtered_targets]
                st.rerun()

    acknowledge = st.checkbox(
        "I am authorized to retrieve these public pages and will use conservative concurrency and scope.",
        value=False,
        key="recon_authorized",
    )
    research_case_id = active_case_id()
    if not research_case_id:
        st.warning("Select or create a Research Mode case before running recon so raw responses and evidence are preserved.")

    if st.button("Run visual recon job", type="primary", disabled=not acknowledge or len(filtered_targets) == 0 or not research_case_id):
        targets = filtered_targets
        rules = st.session_state.recon_rules.fillna("").to_dict("records")
        extractors = st.session_state.recon_extractors.fillna("").to_dict("records")
        progress = st.progress(0, text="Preparing jobâ€¦")
        status = st.status("Recon runningâ€¦", expanded=True)
        pipeline = ResearchEvidencePipeline()
        evidence_run_id = pipeline.start_web_recon(
            str(research_case_id),
            {
                "target_count": len(targets),
                "rules": rules,
                "extractors": extractors,
                "selected_fields": st.session_state.selected_result_fields,
                "workers": int(workers),
                "timeout": int(timeout),
                "verify_tls": verify_tls,
                "follow_redirects": follow_redirects,
                "max_bytes": st.session_state.recon_max_bytes,
            },
        )

        def update_progress(done: int, total: int, url: str) -> None:
            progress.progress(done / total if total else 1.0, text=f"{done}/{total} · {url}")

        def capture_result(target: SearchResult, record: PageRecord, result: dict[str, Any]) -> None:
            pipeline.ingest_web_page(str(research_case_id), evidence_run_id, target, record, result)

        try:
            rows = run_recon(
                targets,
                rules=rules,
                extractors=extractors,
                selected_fields=st.session_state.selected_result_fields,
                workers=int(workers),
                timeout=int(timeout),
                verify_tls=verify_tls,
                follow_redirects=follow_redirects,
                max_bytes=st.session_state.recon_max_bytes,
                within_group=st.session_state.get("recon_within_group", "AND"),
                between_groups=st.session_state.get("recon_between_groups", "AND"),
                minimum_score=float(st.session_state.get("recon_minimum_score", 0.0)),
                include_nonmatches=include_nonmatches,
                progress_callback=update_progress,
                result_callback=capture_result,
            )
            st.session_state.recon_results = rows
            pipeline.finish_web_recon(evidence_run_id, rows)
            st.session_state.recon_last_evidence_run = evidence_run_id
            status.update(label=f"Recon complete · {len(rows)} exported rows", state="complete")
        except Exception as exc:
            pipeline.finish_web_recon(evidence_run_id, [], error=f"{type(exc).__name__}: {exc}")
            status.update(label="Recon failed", state="error")
            st.error(f"{type(exc).__name__}: {exc}")

    rows = st.session_state.recon_results
    if rows:
        st.divider()
        frame = pd.DataFrame(rows)
        passed = int(frame["match_passed"].fillna(False).astype(bool).sum()) if "match_passed" in frame.columns else 0
        col1, col2, col3 = st.columns(3)
        col1.metric("Result rows", len(frame))
        col2.metric("Matched pages", passed)
        col3.metric("Fetch errors", int(frame["error"].fillna("").astype(bool).sum()) if "error" in frame.columns else 0)

        view_mode = st.radio("Result view", ["All rows", "Matched only", "Errors only"], horizontal=True)
        view = frame
        if view_mode == "Matched only" and "match_passed" in frame.columns:
            view = frame[frame["match_passed"].fillna(False).astype(bool)]
        elif view_mode == "Errors only" and "error" in frame.columns:
            view = frame[frame["error"].fillna("").astype(bool)]
        st.dataframe(view, width="stretch", hide_index=True, height=500)

        filename = st.text_input("CSV filename", value="osint_visual_recon_results.csv")
        st.download_button(
            "Download detailed CSV",
            data=dataframe_to_csv_bytes(rows),
            file_name=filename,
            mime="text/csv",
            type="primary",
        )
        if st.session_state.get("recon_last_evidence_run"):
            st.success(f"Raw responses and normalized evidence were preserved in run `{st.session_state.recon_last_evidence_run}`.")

    st.divider()
    config = current_job_config()
    col1, col2 = st.columns(2)
    col1.download_button(
        "Export reusable job definition",
        data=json.dumps(config, indent=2, ensure_ascii=False).encode("utf-8"),
        file_name="osint_visual_recon_job.json",
        mime="application/json",
    )
    uploaded_config = col2.file_uploader("Import job definition", type=["json"], key="recon_job_upload")
    if uploaded_config and col2.button("Apply imported job"):
        try:
            payload = json.load(uploaded_config)
            load_job_config(payload)
            st.success("Job definition loaded. Review each stage before execution.")
            st.rerun()
        except Exception as exc:
            st.error(f"Invalid job definition: {exc}")


def render_visual_recon() -> None:
    st.title("Visual Web Recon Builder")
    st.caption(
        "Design a repeatable public-web research job visually, inspect semantic page regions, "
        "and export normalized recon data without hand-writing a crawler."
    )
    render_hunt_profile_toolbar("visual")
    st.divider()
    stage_header()
    st.write("")
    stage = stage_picker(
        "Web recon stage",
        ("1 · Discover", "2–3 · Inspect & Match", "4 · CSV Designer", "Run & Results"),
        key="visual_recon_stage",
    )
    if stage == "1 · Discover":
        render_discovery_tab()
    elif stage == "2–3 · Inspect & Match":
        render_rules_tab()
    elif stage == "4 · CSV Designer":
        render_extractors_tab()
    else:
        render_run_tab()



def _super_lines(key: str) -> list[str]:
    return super_split_lines(st.session_state.get(key, ""))


def render_supercharger() -> None:
    st.title("Discovery Supercharger")
    st.caption(
        "Generate large query matrices, fuse multiple passive discovery sources, expand strong seeds, "
        "deduplicate into a resumable SQLite job, and export thousands of normalized candidates."
    )
    render_hunt_profile_toolbar("discovery")
    st.divider()

    stage = stage_picker(
        "Discovery stage",
        ("1 · Query Matrix", "2 · Providers & Scale", "3 · Expansion", "4 · Run & Export"),
        key="discovery_supercharger_stage",
    )

    if stage == "1 · Query Matrix":
        st.markdown("### Query fan-out")
        st.info(
            "Large discovery jobs come from many narrow, high-quality queries rather than one broad query. "
            "Each populated dimension is combined through the template below, then duplicate queries are removed."
        )
        left, right = st.columns(2)
        with left:
            bases = st.text_area(
                "Base intents · one per line",
                height=130,
                key="super_bases",
                help="The central entity, topic, or exact phrase to discover.",
            )
            variants = st.text_area(
                "Discovery variants · one per line",
                height=130,
                key="super_variants",
                help="Synonyms, evidence types, technologies, services, or alternate discovery language.",
            )
            geographies = st.text_area(
                "Geographies · one per line",
                height=130,
                key="super_geographies",
            )
            excludes = st.text_area(
                "Excluded terms · one per line",
                height=90,
                key="super_excludes",
            )
        with right:
            sites = st.text_area(
                "Optional site restrictions · one per line",
                placeholder="example-platform.com\n*.vendor-host.com",
                height=105,
                key="super_sites",
            )
            title_terms = st.text_area(
                "Optional indexed-title terms · one per line",
                placeholder="restaurant\nlocal business",
                height=90,
                key="super_title_terms",
            )
            url_terms = st.text_area(
                "Optional URL-path terms · one per line",
                placeholder="contact\nabout",
                height=90,
                key="super_url_terms",
            )
            filetypes = st.text_area(
                "Optional file types · one per line",
                placeholder="pdf\ncsv",
                height=75,
                key="super_filetypes",
            )
            templates = st.text_area(
                "Query templates · one per line",
                height=120,
                key="super_templates",
                help=(
                    "Available placeholders: {base}, {variant}, {geo}, {site}, {title}, {url}, {filetype}, "
                    "{site_op}, {title_op}, {url_op}, {filetype_op}."
                ),
            )

        with st.expander("Fast candidate filters · applied before URLs enter the job database", expanded=True):
            st.caption(
                "These filters remove known aggregators, vendor marketing pages, irrelevant paths, and noisy titles before Visual Web Recon fetches anything."
            )
            f1, f2 = st.columns(2)
            f1.text_area(
                "Excluded domains · one per line",
                key="super_candidate_excluded_domains",
                height=130,
                placeholder="yelp.com\nfacebook.com\nget.vendor.example",
            )
            f2.text_area(
                "Excluded URL fragments · one per line",
                key="super_candidate_excluded_url_terms",
                height=130,
                placeholder="/case-studies\n/blog/\n/jobs",
            )
            f3, f4 = st.columns(2)
            f3.text_area(
                "Excluded indexed-title terms · one per line",
                key="super_candidate_excluded_title_terms",
                height=100,
                placeholder="Case Study\nSoftware Platform\nDirectory",
            )
            f4.text_area(
                "Excluded search-snippet terms · one per line",
                key="super_candidate_excluded_snippet_terms",
                height=100,
                placeholder="marketing platform\nrestaurant directory",
            )
            st.text_area(
                "Optional required URL fragments · at least one must match",
                key="super_candidate_required_url_terms",
                height=75,
                placeholder="Leave blank for broad first-party discovery",
            )

        max_queries = st.number_input(
            "Maximum generated queries",
            min_value=1,
            max_value=25000,
            step=100,
            key="super_max_queries",
        )
        estimates = estimate_query_matrix_size(
            bases=_super_lines("super_bases"),
            variants=_super_lines("super_variants"),
            geographies=_super_lines("super_geographies"),
            sites=_super_lines("super_sites"),
            title_terms=_super_lines("super_title_terms"),
            url_terms=_super_lines("super_url_terms"),
            filetypes=_super_lines("super_filetypes"),
            templates=_super_lines("super_templates"),
        )
        theoretical_queries = sum(estimates.values())
        if theoretical_queries > int(max_queries):
            st.warning(
                f"The matrix can produce about {theoretical_queries:,} combinations, but the cap is {int(max_queries):,}. "
                "Templates are now interleaved so later templates are not silently starved. Increase the cap or split the hunt into lanes for full coverage."
            )
        try:
            shards = build_query_matrix(
                bases=_super_lines("super_bases"),
                variants=_super_lines("super_variants"),
                geographies=_super_lines("super_geographies"),
                sites=_super_lines("super_sites"),
                title_terms=_super_lines("super_title_terms"),
                url_terms=_super_lines("super_url_terms"),
                filetypes=_super_lines("super_filetypes"),
                templates=_super_lines("super_templates"),
                exclude_terms=_super_lines("super_excludes"),
                max_queries=int(max_queries),
            )
            st.session_state.super_query_shards = shards
        except Exception as exc:
            shards = []
            st.session_state.super_query_shards = []
            st.error(f"Query matrix error: {exc}")

        col1, col2, col3 = st.columns(3)
        col1.metric("Generated query shards", len(shards))
        col2.metric("Base intents", len(_super_lines("super_bases")))
        col3.metric("Geographies", len(_super_lines("super_geographies")))
        with st.expander("Query-lane diagnostics", expanded=False):
            st.dataframe(
                pd.DataFrame([{"template": template, "estimated combinations": count} for template, count in estimates.items()]),
                width="stretch",
                hide_index=True,
            )
        preview = pd.DataFrame([{"query": item.query, "base": item.base, "variant": item.variant, "geo": item.geography, "template": item.template} for item in shards[:500]])
        st.dataframe(preview, width="stretch", hide_index=True, height=380)
        if len(shards) > 500:
            st.caption(f"Showing the first 500 of {len(shards):,} generated queries.")
        save_matrix_draft(current_matrix_config())

    elif stage == "2 · Providers & Scale":
        st.markdown("### Provider fusion")
        st.caption(
            "Semantic search engines are query-limited. Thousands of candidates are achieved by query sharding, "
            "provider fusion, and large public URL inventories—not by asking one provider for an impossible page size."
        )
        providers = st.multiselect(
            "Enabled discovery providers",
            ["ddgs", "brave", "urlscan", "commoncrawl"],
            default=["ddgs", "commoncrawl"],
            key="super_providers",
        )

        ddgs_col, brave_col = st.columns(2)
        with ddgs_col:
            st.markdown("#### DDGS")
            ddgs_backend = st.text_input("Backend", value="auto", key="super_ddgs_backend")
            ddgs_per_query = st.number_input(
                "Maximum results per query",
                min_value=5,
                max_value=500,
                value=50,
                step=5,
                key="super_ddgs_per_query",
            )
            st.caption("Use multiple narrow query shards. Actual provider yield may be lower than the requested maximum.")
        with brave_col:
            st.markdown("#### Brave Search API · optional")
            brave_key = st.text_input(
                "API key",
                value=os.environ.get("BRAVE_SEARCH_API_KEY", ""),
                type="password",
                key="super_brave_key",
            )
            brave_per_query = st.number_input(
                "Maximum results per query",
                min_value=20,
                max_value=200,
                value=100,
                step=20,
                key="super_brave_per_query",
            )
            col1, col2 = st.columns(2)
            brave_country = col1.text_input("Country", value="US", key="super_brave_country")
            brave_language = col2.text_input("Language", value="en", key="super_brave_language")

        urlscan_col, cc_col = st.columns(2)
        with urlscan_col:
            st.markdown("#### urlscan historical search")
            urlscan_key = st.text_input(
                "API key · optional but strongly recommended",
                value=os.environ.get("URLSCAN_API_KEY", ""),
                type="password",
                key="super_urlscan_key",
            )
            urlscan_queries_text = st.text_area(
                "Raw urlscan Search API queries · one per line",
                placeholder='page.title:"Order Online" AND page.country:US\ndomain:vendor-cdn.example',
                height=120,
                key="super_urlscan_queries",
            )
            urlscan_max = st.number_input(
                "Maximum results per urlscan query",
                min_value=100,
                max_value=10000,
                value=2000,
                step=100,
                key="super_urlscan_max",
            )
        with cc_col:
            st.markdown("#### Common Crawl URL inventory")
            cc_patterns_text = st.text_area(
                "URL patterns · one per line",
                placeholder="example.org/*\n*.example.org",
                height=120,
                key="super_cc_patterns",
                help="Common Crawl indexes URLs, not arbitrary page text. Use domain and URL-prefix patterns.",
            )
            cc_index = st.text_input("Crawl index", value="latest", key="super_cc_index")
            cc_max = st.number_input(
                "Maximum results per pattern",
                min_value=100,
                max_value=50000,
                value=5000,
                step=500,
                key="super_cc_max",
            )

        st.markdown("#### Execution budget")
        col1, col2 = st.columns(2)
        workers = col1.slider("Concurrent provider tasks", 1, 16, 4, key="super_workers")
        delay = col2.number_input("Courtesy delay after each task", 0.0, 10.0, 0.25, step=0.1, key="super_delay")

        shards = st.session_state.get("super_query_shards", [])
        semantic_providers = sum(1 for item in providers if item in {"ddgs", "brave"})
        estimated_tasks = len(shards) * semantic_providers
        if "urlscan" in providers:
            estimated_tasks += len(super_split_lines(urlscan_queries_text))
        if "commoncrawl" in providers:
            estimated_tasks += len(super_split_lines(cc_patterns_text))
        possible_semantic = len(shards) * (
            (int(ddgs_per_query) if "ddgs" in providers else 0)
            + (int(brave_per_query) if "brave" in providers else 0)
        )
        col1, col2 = st.columns(2)
        col1.metric("Estimated provider tasks", estimated_tasks)
        col2.metric("Theoretical semantic result ceiling", f"{possible_semantic:,}")
        st.warning(
            "Theoretical ceilings are not guaranteed. Search providers overlap, cap deep pagination, and may return fewer results. "
            "The SQLite accumulator deduplicates all sources by canonical URL."
        )

    elif stage == "3 · Expansion":
        st.markdown("### Seed expansion")
        st.caption("Turn each strong domain seed into additional page URLs after the first discovery pass.")
        col1, col2 = st.columns(2)
        with col1:
            sitemap_enabled = st.checkbox("Expand XML sitemaps and robots.txt Sitemap entries", value=True, key="super_sitemap_enabled")
            sitemap_domain_limit = st.number_input("Maximum domains to expand", 1, 10000, 500, key="super_sitemap_domain_limit")
            sitemap_urls = st.number_input("Maximum URLs per domain", 10, 100000, 1000, step=100, key="super_sitemap_urls")
        with col2:
            crawl_enabled = st.checkbox("Run bounded same-domain crawl", value=False, key="super_crawl_enabled")
            crawl_seed_limit = st.number_input("Maximum crawl seeds", 1, 10000, 100, key="super_crawl_seed_limit")
            crawl_pages = st.number_input("Maximum pages per domain", 5, 5000, 100, step=25, key="super_crawl_pages")
            crawl_depth = st.slider("Maximum crawl depth", 0, 3, 1, key="super_crawl_depth")
        st.info(
            "Sitemap expansion is the preferred high-volume method. Bounded crawling is slower and creates direct traffic to target sites; "
            "use it only for authorized, scoped research."
        )

    else:
        st.markdown("### Persistent discovery job")
        col1, col2 = st.columns([2, 1])
        job_name = col1.text_input("Job name", value="discovery_supercharger", key="super_job_name")
        resume = col2.checkbox("Resume completed provider queries", value=True, key="super_resume")
        db_path = job_path(job_name)
        store = JobStore(db_path)
        counts = store.counts()
        metric_cols = st.columns(4)
        metric_cols[0].metric("Unique URLs", f"{counts['candidates']:,}")
        metric_cols[1].metric("Unique domains", f"{counts['domains']:,}")
        metric_cols[2].metric("Queries completed", f"{counts['queries_complete']:,}")
        metric_cols[3].metric("Queries failed", f"{counts['queries_failed']:,}")
        st.code(str(db_path), language="text")

        acknowledge = st.checkbox(
            "I am authorized to collect these public results and will respect provider quotas, robots policies, and target-site rate limits.",
            key="super_authorized",
        )

        shards = st.session_state.get("super_query_shards", [])
        providers = st.session_state.get("super_providers", ["ddgs", "commoncrawl"])
        plan = SuperchargerPlan(
            query_shards=shards,
            providers=providers,
            ddgs_backend=st.session_state.get("super_ddgs_backend", "auto"),
            ddgs_results_per_query=int(st.session_state.get("super_ddgs_per_query", 50)),
            brave_results_per_query=int(st.session_state.get("super_brave_per_query", 100)),
            brave_api_key=st.session_state.get("super_brave_key", ""),
            brave_country=st.session_state.get("super_brave_country", "US"),
            brave_language=st.session_state.get("super_brave_language", "en"),
            urlscan_queries=super_split_lines(st.session_state.get("super_urlscan_queries", "")),
            urlscan_api_key=st.session_state.get("super_urlscan_key", ""),
            urlscan_max_results=int(st.session_state.get("super_urlscan_max", 2000)),
            commoncrawl_patterns=super_split_lines(st.session_state.get("super_cc_patterns", "")),
            commoncrawl_index=st.session_state.get("super_cc_index", "latest"),
            commoncrawl_max_results=int(st.session_state.get("super_cc_max", 5000)),
            workers=int(st.session_state.get("super_workers", 4)),
            delay_seconds=float(st.session_state.get("super_delay", 0.25)),
            candidate_filter=CandidateFilter.from_values(
                excluded_domains=_super_lines("super_candidate_excluded_domains"),
                excluded_url_terms=_super_lines("super_candidate_excluded_url_terms"),
                excluded_title_terms=_super_lines("super_candidate_excluded_title_terms"),
                excluded_snippet_terms=_super_lines("super_candidate_excluded_snippet_terms"),
                required_url_terms=_super_lines("super_candidate_required_url_terms"),
            ),
        )
        current_case_id = active_case_id()
        if not current_case_id:
            st.warning("Select or create a Research Mode case before collection so discovery provenance is preserved.")

        run_col, expand_col, prune_col, clear_col = st.columns(4)
        if run_col.button("Run discovery fan-out", type="primary", disabled=not acknowledge or not current_case_id):
            progress = st.progress(0.0, text="Preparing provider tasksâ€¦")
            status = st.status("Discovery runningâ€¦", expanded=True)

            def update(done: int, total: int, label: str, summary: Any) -> None:
                progress.progress(done / total if total else 1.0, text=f"{done}/{total} · {label}")

            try:
                summaries = run_discovery_plan(plan, store, resume=resume, progress_callback=update)
                st.session_state.super_last_summaries = {key: vars(value) for key, value in summaries.items()}
                new_counts = store.counts()
                try:
                    st.session_state.super_last_case_sync = CaseStore().import_discovery_job(db_path, case_id=str(current_case_id))
                    st.session_state.pop("super_last_case_sync_error", None)
                except Exception as sync_exc:
                    st.session_state.super_last_case_sync_error = f"{type(sync_exc).__name__}: {sync_exc}"
                status.update(label=f"Discovery complete · {new_counts['candidates']:,} unique URLs", state="complete")
                st.rerun()
            except Exception as exc:
                status.update(label="Discovery failed", state="error")
                st.error(f"{type(exc).__name__}: {exc}")

        if expand_col.button("Run seed expansion", disabled=not acknowledge or not current_case_id or counts["candidates"] == 0):
            progress = st.progress(0.0, text="Preparing expansionâ€¦")
            status = st.status("Expansion runningâ€¦", expanded=True)

            def update_expansion(done: int, total: int, label: str) -> None:
                progress.progress(done / total if total else 1.0, text=f"{done}/{total} · {label}")

            try:
                expansion_summary = run_expansion(
                    store,
                    sitemap_enabled=bool(st.session_state.get("super_sitemap_enabled", True)),
                    sitemap_domain_limit=int(st.session_state.get("super_sitemap_domain_limit", 500)),
                    sitemap_urls_per_domain=int(st.session_state.get("super_sitemap_urls", 1000)),
                    crawl_enabled=bool(st.session_state.get("super_crawl_enabled", False)),
                    crawl_seed_limit=int(st.session_state.get("super_crawl_seed_limit", 100)),
                    crawl_pages_per_domain=int(st.session_state.get("super_crawl_pages", 100)),
                    crawl_depth=int(st.session_state.get("super_crawl_depth", 1)),
                    workers=int(st.session_state.get("super_workers", 4)),
                    candidate_filter=plan.candidate_filter,
                    progress_callback=update_expansion,
                )
                try:
                    st.session_state.super_last_case_sync = CaseStore().import_discovery_job(db_path, case_id=str(current_case_id))
                    st.session_state.pop("super_last_case_sync_error", None)
                except Exception as sync_exc:
                    st.session_state.super_last_case_sync_error = f"{type(sync_exc).__name__}: {sync_exc}"
                status.update(label=f"Expansion complete · {expansion_summary}", state="complete")
                st.rerun()
            except Exception as exc:
                status.update(label="Expansion failed", state="error")
                st.error(f"{type(exc).__name__}: {exc}")

        if prune_col.button("Prune noise with filters", disabled=counts["candidates"] == 0):
            removed = store.prune_candidates(plan.candidate_filter)
            st.success(f"Removed {removed:,} stored candidates that match the active fast filters.")
            st.rerun()

        if clear_col.button("Clear this job database", disabled=counts["candidates"] == 0 and counts["queries_complete"] == 0):
            store.clear()
            st.rerun()

        summaries = st.session_state.get("super_last_summaries")
        if summaries:
            st.markdown("#### Latest provider summary")
            st.dataframe(pd.DataFrame(summaries.values()), width="stretch", hide_index=True)
        case_sync = st.session_state.get("super_last_case_sync")
        if case_sync:
            st.caption(f"Latest discovery evidence run: `{case_sync['run_id']}`")
        if st.session_state.get("super_last_case_sync_error"):
            st.warning(f"Discovery completed, but case evidence sync failed: {st.session_state.super_last_case_sync_error}")

        preview_limit = st.slider("Preview rows", 25, 5000, 250, step=25, key="super_preview_limit")
        rows = store.candidate_rows(limit=int(preview_limit))
        st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True, height=500)

        all_rows = store.candidate_rows()
        if all_rows:
            col1, col2, col3 = st.columns(3)
            col1.download_button(
                "Download discovery CSV",
                data=rows_to_csv_bytes(all_rows),
                file_name=f"{job_name}_discovery.csv",
                mime="text/csv",
                type="primary",
            )
            transfer_limit = col2.number_input("Transfer first N URLs to Visual Web Recon", 1, 100000, min(5000, len(all_rows)))
            if col2.button("Send candidates to Visual Web Recon"):
                selected = all_rows[: int(transfer_limit)]
                st.session_state.recon_targets = [
                    {
                        "url": row["url"],
                        "title": row["title"],
                        "snippet": row["snippet"],
                        "rank": int(row["best_rank"] or 0),
                        "query": row["queries"],
                        "source": row["providers"],
                    }
                    for row in selected
                ]
                st.success(f"Transferred {len(selected):,} candidates. Open Visual Web Recon to inspect, match, and export detailed page data.")
            if col3.button("Sync discovery evidence to case", disabled=not current_case_id):
                try:
                    imported = CaseStore().import_discovery_job(db_path, case_id=str(current_case_id))
                    if imported.get("already_imported"):
                        st.info("This exact discovery snapshot is already preserved in the active case.")
                    else:
                        st.success(f"Preserved {imported['imported_candidates']:,} new or changed discovery records in the active case.")
                except Exception as exc:
                    st.error(f"Evidence sync failed: {type(exc).__name__}: {exc}")

        plan_payload = {
            "schema_version": "discovery-supercharger-v2",
            "query_shards": [vars(item) for item in shards],
            "providers": providers,
            "settings": {
                "ddgs_backend": plan.ddgs_backend,
                "ddgs_results_per_query": plan.ddgs_results_per_query,
                "brave_results_per_query": plan.brave_results_per_query,
                "brave_country": plan.brave_country,
                "brave_language": plan.brave_language,
                "urlscan_queries": plan.urlscan_queries,
                "urlscan_max_results": plan.urlscan_max_results,
                "commoncrawl_patterns": plan.commoncrawl_patterns,
                "commoncrawl_index": plan.commoncrawl_index,
                "commoncrawl_max_results": plan.commoncrawl_max_results,
                "workers": plan.workers,
                "delay_seconds": plan.delay_seconds,
                "candidate_filter": {
                    "excluded_domains": list(plan.candidate_filter.excluded_domains),
                    "excluded_url_terms": list(plan.candidate_filter.excluded_url_terms),
                    "excluded_title_terms": list(plan.candidate_filter.excluded_title_terms),
                    "excluded_snippet_terms": list(plan.candidate_filter.excluded_snippet_terms),
                    "required_url_terms": list(plan.candidate_filter.required_url_terms),
                },
            },
        }
        st.download_button(
            "Export discovery plan JSON",
            data=json.dumps(plan_payload, indent=2, ensure_ascii=False).encode("utf-8"),
            file_name=f"{job_name}_plan.json",
            mime="application/json",
        )

def guided_fields(tool_key: str) -> dict[str, object]:
    values: dict[str, object] = {}
    if tool_key == "shodan":
        values["action"] = st.selectbox("Shodan action", ["domain", "host", "search", "count"])
        values["query"] = st.text_input("Domain, IP, or Shodan search query")
    elif tool_key == "theharvester":
        values["domain"] = st.text_input("Domain")
        values["sources"] = st.text_input("Sources", value="all", help="Examples: all, bing, crtsh, duckduckgo")
        values["limit"] = st.number_input("Result limit", min_value=1, max_value=5000, value=200)
        values["output"] = st.text_input("Optional output base name")
    elif tool_key == "gospider":
        values["url"] = st.text_input("Starting URL")
        col1, col2 = st.columns(2)
        values["depth"] = col1.number_input("Depth", min_value=1, max_value=10, value=2)
        values["concurrency"] = col2.number_input("Concurrency", min_value=1, max_value=20, value=2)
        values["include_subdomains"] = st.checkbox("Include subdomains", value=False)
        values["robots"] = st.checkbox("Check robots.txt", value=True)
        values["sitemap"] = st.checkbox("Check sitemap", value=True)
    elif tool_key == "subfinder":
        values["domain"] = st.text_input("Domain")
        values["all_sources"] = st.checkbox("Use all sources", value=False)
        values["recursive"] = st.checkbox("Recursive sources", value=False)
        values["output"] = st.text_input("Optional output file")
    elif tool_key == "assetfinder":
        values["domain"] = st.text_input("Domain")
        values["subdomains_only"] = st.checkbox("Subdomains only", value=True)
    elif tool_key == "amass":
        values["domain"] = st.text_input("Domain")
        values["passive"] = st.checkbox("Passive mode", value=True)
        values["output"] = st.text_input("Optional output file")
    elif tool_key in {"maigret", "sherlock"}:
        values["username"] = st.text_input("Username")
        values["sites"] = st.multiselect("Limit platforms", ["Facebook", "Instagram", "YouTube", "TikTok", "X"])
    elif tool_key == "spiderfoot_web":
        col1, col2 = st.columns(2)
        values["host"] = col1.text_input("Listen host", value="127.0.0.1")
        values["port"] = col2.number_input("Port", min_value=1024, max_value=65535, value=5001)
    elif tool_key == "recon_ng":
        values["workspace"] = st.text_input("Workspace", value="default")
        values["resource"] = st.text_input("Optional resource script (.rc)")
    elif tool_key == "spiderfoot_cli":
        values["target"] = st.text_input("Target")
        values["preset"] = st.selectbox("Preset", ["passive", "footprint", "investigate", "all"])
        values["modules"] = st.text_input("Optional module list")
        values["max_threads"] = st.number_input("Maximum threads", min_value=1, max_value=50, value=3)
    else:
        st.info("This tool currently uses the Help-derived Builder.")
    return values


def visual_help_builder(snapshot: HelpSnapshot, executable: str, tool_key: str) -> CommandPlan | None:
    st.caption(f"Captured with: `{render_command(snapshot.invocation)}` · {len(snapshot.options)} parsed options")
    positional = st.text_input(
        "Primary target or positional arguments",
        help="Enter positional values as shell-style tokens. They are parsed safely and never executed through a shell.",
        key=f"positional_{tool_key}",
    )
    selected_args: list[str] = [executable]
    positional_tokens: list[str] = []
    if positional.strip():
        try:
            positional_tokens = shlex.split(positional)
            selected_args.extend(positional_tokens)
        except ValueError as exc:
            st.error(f"Positional argument parsing failed: {exc}")
            return None

    filter_text = st.text_input("Find an option", key=f"filter_{tool_key}").strip().lower()
    options = [
        option
        for option in snapshot.options
        if not filter_text
        or filter_text in " ".join(option.flags).lower()
        or filter_text in option.description.lower()
    ]
    grouped = group_options(options)
    selected_blocks: list[str] = [Path(executable).name, *positional_tokens]

    for category, category_options in grouped.items():
        with st.expander(f"{category} · {len(category_options)} options", expanded=category in {"Target & Input", "Scope & Filters"}):
            for index, option in enumerate(category_options):
                label = " / ".join(option.flags)
                key = f"opt_{tool_key}_{category}_{index}_{option.key}"
                with st.container(border=True):
                    col1, col2 = st.columns([0.34, 0.66])
                    enabled = col1.toggle(label, key=key + "_enabled", help=option.description)
                    col2.caption(option.description or "No local description was supplied by this tool.")
                    if enabled:
                        if option.takes_value:
                            value = st.text_input(
                                option.metavar or "Value",
                                key=key + "_value",
                                placeholder=option.metavar,
                            )
                            if value:
                                selected_args.extend([option.primary_flag, value])
                                selected_blocks.append(f"{option.primary_flag} {value}")
                            else:
                                selected_blocks.append(f"{option.primary_flag} <{option.metavar or 'VALUE'}>")
                        else:
                            selected_args.append(option.primary_flag)
                            selected_blocks.append(option.primary_flag)

    st.markdown("#### Command structure")
    chips = "".join(f"<span class='command-chip'>{block}</span>" for block in selected_blocks)
    st.markdown(chips, unsafe_allow_html=True)
    return CommandPlan(
        tool_key=tool_key,
        argv=tuple(selected_args),
        summary="Help-derived visual command",
        warnings=(),
        allow_execute=True,
    )


def render_plan(plan: CommandPlan, tool: DiscoveredTool) -> None:
    st.subheader("Command preview")
    command_text = render_command(plan.argv)
    st.code(command_text, language="bash")
    st.caption(plan.summary)
    for warning in plan.warnings:
        st.warning(warning)

    col1, col2, col3 = st.columns([1, 1, 2])
    timeout = col1.number_input("Timeout (seconds)", min_value=5, max_value=86400, value=900, step=30, key=f"timeout_{plan.tool_key}_{plan.summary}")
    cwd = col2.text_input("Working directory", value=str(Path.cwd()), key=f"cwd_{plan.tool_key}_{plan.summary}")
    traffic_class = plan.traffic_class or tool.spec.risk
    acknowledge = True
    if traffic_class in {"mixed", "active"}:
        acknowledge = st.checkbox(
            "I am authorized to query or interact with the selected target and understand that some options may generate direct traffic.",
            value=False,
            key=f"ack_{plan.tool_key}_{plan.summary}",
        )
    research_case_id = active_case_id()
    if not research_case_id:
        st.warning("Select or create a Research Mode case before executing a tool so its exact output is preserved.")

    if col3.button("Run command", type="primary", disabled=not acknowledge or not plan.allow_execute or not research_case_id, key=f"run_{plan.tool_key}_{plan.summary}"):
        output_area = st.empty()
        status = st.status("Command runningâ€¦", expanded=True)
        evidence_pipeline = ResearchEvidencePipeline()
        evidence_run_id = evidence_pipeline.start_tool_run(
            str(research_case_id),
            plan.tool_key,
            {"argv": list(plan.argv), "summary": plan.summary, "cwd": cwd, "timeout_seconds": int(timeout)},
            traffic_class=traffic_class,
        )
        result = run_command(
            list(plan.argv),
            timeout_seconds=int(timeout),
            cwd=cwd or None,
            on_output=lambda text: output_area.code(text or "Waiting for outputâ€¦", language="text"),
        )
        evidence_pipeline.ingest_tool_result(str(research_case_id), evidence_run_id, result)
        if result.error:
            status.update(label="Execution failed", state="error")
            st.error(result.error)
        elif result.timed_out:
            status.update(label="Command timed out", state="error")
            st.warning(f"Stopped after {result.duration_seconds:.1f} seconds.")
        elif result.return_code == 0:
            status.update(label="Command completed", state="complete")
        else:
            status.update(label=f"Command exited with code {result.return_code}", state="error")
        output_area.code(result.output or "No output returned.", language="text")
        st.caption(f"Exact command output preserved in evidence run `{evidence_run_id}`.")


def render_legacy_tool_studio(*, embedded: bool = False) -> None:
    if not embedded:
        st.title("Tool Command Studio")
        st.caption("Discover installed OSINT tools, harvest their local help output, and build commands as structured option blocks.")
    tools = get_tools()
    installed = [tool for tool in tools if tool.installed]
    if not installed:
        st.error("No supported OSINT executables were found in PATH.")
        return

    selected_key = st.selectbox(
        "Tool",
        [tool.spec.key for tool in installed],
        format_func=lambda key: next(tool.spec.label for tool in installed if tool.spec.key == key),
    )
    selected_tool = next(tool for tool in installed if tool.spec.key == selected_key)
    view = stage_picker(
        "Tool stage",
        ("Tool Overview", "Guided Builder", "Visual Help Builder", "Raw Help"),
        key="legacy_tool_stage",
    )
    force_token = 0
    if view == "Raw Help":
        if st.button("Refresh help from executable"):
            force_token = 1
            get_help_snapshot.clear()
        snapshot = get_help_snapshot(selected_tool.spec.key, selected_tool.executable or "", force_token)
        if snapshot.error:
            st.warning(snapshot.error)
        st.code(snapshot.text or "No help text captured.", language="text")
        return

    snapshot = get_help_snapshot(selected_tool.spec.key, selected_tool.executable or "", force_token)
    if view == "Tool Overview":
        st.markdown(f"### {selected_tool.spec.label}")
        st.write(selected_tool.spec.description)
        col1, col2, col3 = st.columns(3)
        col1.metric("Status", "Installed")
        col2.metric("Executable", selected_tool.executable or "Not found")
        col3.metric("Mode", selected_tool.spec.risk.title())
        st.info(f"Help output is captured from the local executable and cached under `{CACHE_DIR}`.")

    elif view == "Guided Builder":
        st.markdown("### Guided query")
        values = guided_fields(selected_tool.spec.key)
        try:
            plan = build_guided_plan(selected_tool.spec.key, selected_tool.executable or "", values, snapshot)
        except ValueError as exc:
            plan = None
            st.info(str(exc))
        if plan:
            render_plan(plan, selected_tool)

    else:
        st.markdown("### Assemble command blocks from local help")
        if not snapshot.options:
            st.warning("No machine-readable options were parsed. Use raw help or positional arguments.")
        advanced_plan = visual_help_builder(snapshot, selected_tool.executable or "", selected_tool.spec.key)
        if advanced_plan:
            render_plan(advanced_plan, selected_tool)


def render_tool_studio() -> None:
    render_arsenal_mode(
        get_tools(),
        render_plan,
        lambda: render_legacy_tool_studio(embedded=True),
        active_case_id(),
    )


def render_history() -> None:
    st.title("Execution History")
    records = load_history()
    if not records:
        st.info(f"No executions recorded yet. History will be stored at `{HISTORY_PATH}`.")
        return
    rows = []
    for record in records:
        rows.append(
            {
                "Started": record.get("started_at"),
                "Command": render_command(record.get("argv", [])),
                "Exit": record.get("return_code"),
                "Timed out": record.get("timed_out"),
                "Duration": record.get("duration_seconds"),
            }
        )
    st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)
    with st.expander("Latest full record"):
        st.json(records[0])


WORKSPACES = ("Cases", "DiveDeep Workflow", "DiveDeep Image Recon", "Quick Recon", "Geo Explorer", "Tax & Permits", "Research Mode", "Privacy Removal", "Execution History")
NAVIGATION_GROUPS = (
    (
        "Command",
        (
            ("Case Workspace", "Cases", None),
            ("Quick Recon", "Quick Recon", None),
        ),
    ),
    (
        "Research",
        (
            ("Research Hub", "Research Mode", "Overview"),
            ("People & Identity", "Research Mode", "People & Identity"),
            ("Domain Security", "Research Mode", "Domain Security"),
            ("Discovery", "Research Mode", "Discovery"),
            ("Web Validation", "Research Mode", "Web Validation"),
            ("Evidence Review", "Research Mode", "Evidence"),
            ("Tool Arsenal", "Research Mode", "Tool Arsenal"),
        ),
    ),
    (
        "Property & Market",
        (
            ("Property Explorer", "Geo Explorer", None),
            ("Tax & Permits", "Tax & Permits", None),
            ("Property Intelligence", "Research Mode", "Property Intel"),
            ("Market Intelligence", "Research Mode", "Market Intelligence"),
        ),
    ),
    (
        "Protection & System",
        (
            ("DiveDeep Workflow", "DiveDeep Workflow", None),
            ("DiveDeep Image Recon", "DiveDeep Image Recon", None),
            ("Privacy Removal", "Privacy Removal", None),
            ("Execution History", "Execution History", None),
        ),
    ),
)


def render_sidebar_navigation(current_workspace: str) -> None:
    current_research_view = str(st.session_state.get("_pending_research_view") or st.session_state.get("research_active_view") or "Overview")
    for group, destinations in NAVIGATION_GROUPS:
        st.markdown(f'<div class="nav-section">{group}</div>', unsafe_allow_html=True)
        for label, destination, research_view in destinations:
            active = current_workspace == destination and (research_view is None or current_research_view == research_view)
            if st.button(
                label,
                key=f"divedeep_nav_{destination}_{research_view or 'root'}",
                type="primary" if active else "secondary",
                use_container_width=True,
            ):
                if research_view:
                    st.session_state._pending_research_view = research_view
                request_workspace(destination)
                st.rerun()


consume_pending_workspace(WORKSPACES)
workspace = str(st.session_state.get("workspace_mode") or "Cases")
if workspace not in WORKSPACES:
    workspace = "Cases"
    st.session_state.workspace_mode = workspace

with st.sidebar:
    st.markdown('<div class="brand-title">OSINT DIVE DEEP</div><div class="brand-subtitle">Investigation & Research Studio</div>', unsafe_allow_html=True)
    sidebar_store = CaseStore()
    sidebar_case_id = st.session_state.get(ACTIVE_CASE_KEY)
    sidebar_case = sidebar_store.get_case(str(sidebar_case_id)) if sidebar_case_id else None
    if sidebar_case:
        st.caption(f"Working case · {sidebar_case['name']}")
        if st.button("Open case workspace", use_container_width=True):
            request_workspace("Cases")
            st.rerun()
    render_sidebar_navigation(workspace)
    st.divider()
    with st.expander("System & tools"):
        tools = get_tools()
        installed_count = sum(1 for tool in tools if tool.installed)
        st.caption(f"{installed_count} tools available · {len(tools) - installed_count} unavailable")
        if st.button("Refresh local tool discovery"):
            get_tools.clear()
            get_help_snapshot.clear()
            st.rerun()
    st.caption(f"Release {load_release_manifest().get('releaseVersion', 'unknown')} · Studio engine {__version__}")

if workspace == "Cases":
    render_case_workspace(CaseStore())
elif workspace == "DiveDeep Workflow":
    render_divedeep_operations()
elif workspace == "DiveDeep Image Recon":
    render_divedeep_image_recon()
elif workspace == "Quick Recon":
    render_quick_recon(CaseStore())
elif workspace == "Geo Explorer":
    render_geo_explorer(CaseStore())
elif workspace == "Tax & Permits":
    render_tax_permit_studio(CaseStore())
elif workspace == "Research Mode":
    render_research_mode(
        render_supercharger,
        render_visual_recon,
        render_tool_studio,
        lambda store, case: render_domain_security_command_center(store, case, get_tools(), render_plan),
    )
elif workspace == "Privacy Removal":
    render_privacy_removal_studio()
else:
    render_history()
