from __future__ import annotations

import json
from collections.abc import Callable

import pandas as pd
import streamlit as st

from .case_store import CaseStore
from .market_mode import render_market_intelligence
from .property_mode import render_property_intel
from .person_identity_mode import render_person_identity_command_center
from .research_lanes import LANES_BY_KEY, RESEARCH_LANES, detect_subject_type, lane_matrix
from .ui_shell import case_context_header, prefer_active_case, remember_active_case, stage_picker


RESEARCH_VIEWS = ("Overview", "People & Identity", "Domain Security", "Discovery", "Web Validation", "Property Intel", "Market Intelligence", "Evidence", "Tool Arsenal")


def active_case_id() -> str | None:
    value = st.session_state.get("research_case_id")
    return str(value) if value else None


def _case_selector(store: CaseStore) -> dict[str, object] | None:
    pending = st.session_state.pop("_pending_research_case_id", None)
    cases = store.list_cases(250)
    case_by_id = {str(item["id"]): item for item in cases}
    if pending in case_by_id:
        st.session_state.research_case_id = pending
    else:
        prefer_active_case(list(case_by_id), local_key="research_case_id")

    left, right = st.columns([3, 1])
    selected = left.selectbox(
        "Active research case",
        list(case_by_id),
        format_func=lambda case_id: str(case_by_id[case_id]["name"]),
        key="research_case_id",
        placeholder="Create a case to preserve evidence",
    )
    remember_active_case(str(selected) if selected else None)
    with right.popover("New case", use_container_width=True):
        with st.form("research_create_case"):
            name = st.text_input("Case name")
            objective = st.text_area("Objective", height=80)
            if st.form_submit_button("Create", type="primary", use_container_width=True):
                case_id = store.create_case(name, mode="research", objective=objective)
                st.session_state._pending_research_case_id = case_id
                st.rerun()
    return case_by_id.get(str(selected)) if selected else None


def _prepare_lane(store: CaseStore, case_id: str | None, lane_key: str, subjects_text: str) -> None:
    subjects = [item.strip() for item in subjects_text.splitlines() if item.strip()]
    if not subjects:
        st.warning("Add at least one subject or identifier.")
        return
    matrix = lane_matrix(lane_key, subjects)
    for key, value in matrix.items():
        st.session_state[f"super_{key}"] = value
    st.session_state.super_query_shards = []
    st.session_state.research_lane = lane_key
    if case_id:
        lane = LANES_BY_KEY[lane_key]
        for subject in subjects:
            detected = detect_subject_type(subject)
            store.add_subject(
                case_id,
                lane.subject_type if lane.subject_type != "unknown" else detected,
                subject,
                primary_value=subject,
                metadata={"research_lane": lane_key, "detected_type": detected},
            )
    if lane_key == "person":
        st.session_state.person_identity_stage = "Discover"
        st.session_state._pending_research_view = "People & Identity"
    else:
        st.session_state._pending_research_view = "Discovery"
    st.rerun()


def _render_overview(store: CaseStore, case: dict[str, object] | None) -> None:
    st.title("Research Mode")
    st.caption("Universal public-source discovery and verification, organized by case and specialized recon lane.")
    case_id = str(case["id"]) if case else None
    if case_id:
        stats = store.case_stats(case_id)
        columns = st.columns(5)
        columns[0].metric("Subjects", stats["subjects"])
        columns[1].metric("Entities", stats["entities"])
        columns[2].metric("Observations", stats["observations"])
        columns[3].metric("Evidence", stats["evidence"])
        columns[4].metric("Runs", stats["runs"])
        if case.get("objective"):
            st.info(str(case["objective"]))
    else:
        st.info("Create a case to preserve raw artifacts, observations, provenance and verification decisions.")

    st.subheader("Start a specialized recon lane")
    lane_key = st.selectbox(
        "Research lane",
        [lane.key for lane in RESEARCH_LANES],
        format_func=lambda key: LANES_BY_KEY[key].label,
        key="research_lane_picker",
    )
    lane = LANES_BY_KEY[lane_key]
    st.caption(lane.description)
    subjects = st.text_area(
        "Subjects or identifiers · one per line",
        height=140,
        placeholder="Organization, person, domain, username, URL, email, market or research phrase",
        key="research_subjects_draft",
    )
    detected = [
        {"value": item.strip(), "detected type": detect_subject_type(item)}
        for item in subjects.splitlines()
        if item.strip()
    ]
    if detected:
        st.dataframe(pd.DataFrame(detected), width="stretch", hide_index=True)
    if st.button("Build lane and open Discovery", type="primary"):
        _prepare_lane(store, case_id, lane_key, subjects)

    st.subheader("Recon workbenches")
    cards = st.columns(3)
    descriptions = (
        ("Discovery", "Query sharding, provider fusion, filtering and seed expansion."),
        ("Web Validation", "Exact page capture, grouped evidence rules and structured extraction."),
        ("Tool Arsenal", "Guided execution for locally installed Kali OSINT tools."),
    )
    for column, (title, description) in zip(cards, descriptions):
        with column.container(border=True):
            st.markdown(f"**{title}**")
            st.caption(description)


def _render_evidence(store: CaseStore, case: dict[str, object] | None) -> None:
    st.title("Research Evidence")
    if not case:
        st.info("Create or select a research case first.")
        return
    case_id = str(case["id"])
    stats = store.case_stats(case_id)
    metric_columns = st.columns(4)
    metric_columns[0].metric("Entities", stats["entities"])
    metric_columns[1].metric("Identifiers", stats["identifiers"])
    metric_columns[2].metric("Observations", stats["observations"])
    metric_columns[3].metric("Artifacts", stats["artifacts"])
    view = stage_picker("Evidence view", ("Entities", "Observations", "Runs"), key="research_evidence_view")
    if view == "Entities":
        st.dataframe(pd.DataFrame(store.list_entities(case_id)), width="stretch", hide_index=True)
    elif view == "Observations":
        observations = store.list_observations(case_id)
        table_rows = [
            {
                "collected_at": row.get("collected_at"),
                "type": row.get("observation_type"),
                "source": row.get("source_name"),
                "source_uri": row.get("source_uri"),
                "confidence": row.get("confidence"),
                "value": str(row.get("value_json") or "")[:1000],
            }
            for row in observations
        ]
        st.dataframe(pd.DataFrame(table_rows), width="stretch", hide_index=True)
        if observations:
            with st.expander("Latest exact observation"):
                try:
                    st.json(json.loads(str(observations[0]["value_json"])))
                except json.JSONDecodeError:
                    st.code(str(observations[0]["value_json"]), language="text")
    else:
        st.dataframe(pd.DataFrame(store.list_runs(case_id)), width="stretch", hide_index=True)


def render_research_mode(
    render_discovery: Callable[[], None],
    render_web_validation: Callable[[], None],
    render_tool_arsenal: Callable[[], None],
    render_domain_security: Callable[[CaseStore, dict[str, object] | None], None],
) -> None:
    store = CaseStore()
    pending_view = st.session_state.pop("_pending_research_view", None)
    if pending_view in RESEARCH_VIEWS:
        st.session_state.research_active_view = pending_view
    if st.session_state.get("research_active_view") not in RESEARCH_VIEWS:
        st.session_state.research_active_view = "Overview"

    case = _case_selector(store)
    view = str(st.session_state.research_active_view)
    case_context_header(case, workspace="Research", detail=f"Stage: {view}")
    st.divider()

    if view == "Overview":
        _render_overview(store, case)
    elif view == "People & Identity":
        render_person_identity_command_center(store, case)
    elif view == "Domain Security":
        render_domain_security(store, case)
    elif view == "Discovery":
        render_discovery()
    elif view == "Web Validation":
        render_web_validation()
    elif view == "Market Intelligence":
        render_market_intelligence(store, case)
    elif view == "Property Intel":
        render_property_intel(store, case)
    elif view == "Evidence":
        _render_evidence(store, case)
    else:
        render_tool_arsenal()
