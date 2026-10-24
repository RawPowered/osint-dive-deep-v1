from __future__ import annotations

import json
from typing import Any

import pandas as pd
import streamlit as st

from .case_store import CaseStore
from .ui_shell import remember_active_case, request_workspace, stage_picker


HUNT_TYPES: dict[str, dict[str, str]] = {
    "Universal research": {"mode": "research", "workspace": "Research Mode", "view": "Overview", "lane": "universal"},
    "People & identity": {"mode": "research", "workspace": "Research Mode", "view": "People & Identity", "lane": "person"},
    "Organization & market": {"mode": "market", "workspace": "Research Mode", "view": "Market Intelligence", "lane": "organization"},
    "Web & technology": {"mode": "technical", "workspace": "Research Mode", "view": "Domain Security", "lane": "technology"},
    "Infrastructure & exposure": {"mode": "technical", "workspace": "Research Mode", "view": "Tool Arsenal", "lane": "exposure"},
    "Location & property": {"mode": "property-research", "workspace": "Geo Explorer", "view": "", "lane": ""},
    "Privacy removal": {"mode": "privacy-removal", "workspace": "Privacy Removal", "view": "", "lane": ""},
}


def _metadata(case: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(str(case.get("metadata_json") or "{}"))
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def _destination(case: dict[str, Any]) -> dict[str, str]:
    metadata = _metadata(case)
    hunt_type = str(metadata.get("hunt_type") or "")
    if hunt_type in HUNT_TYPES:
        return HUNT_TYPES[hunt_type]
    mode = str(case.get("mode") or "research")
    if mode == "property-research":
        return HUNT_TYPES["Location & property"]
    if mode == "privacy-removal":
        return HUNT_TYPES["Privacy removal"]
    if mode == "market":
        return HUNT_TYPES["Organization & market"]
    if mode == "technical":
        return HUNT_TYPES["Infrastructure & exposure"]
    return HUNT_TYPES["Universal research"]


def _resume(case: dict[str, Any], action: dict[str, str] | None = None) -> None:
    case_id = str(case["id"])
    remember_active_case(case_id)
    destination = _destination(case)
    st.session_state.research_case_id = case_id
    st.session_state.geo_case_id = case_id
    if destination["view"]:
        st.session_state.research_active_view = destination["view"]
    if destination["lane"]:
        st.session_state.research_lane_picker = destination["lane"]
    if action and action.get("research_view"):
        st.session_state.research_active_view = action["research_view"]
    if action and action.get("privacy_view"):
        st.session_state.privacy_workspace_view = action["privacy_view"]
    if action and action.get("person_stage"):
        st.session_state.person_identity_stage = action["person_stage"]
    if action and action.get("geo_hunt_id"):
        hunt_id = action["geo_hunt_id"]
        st.session_state.geo_hunt_id = hunt_id
        if action.get("geo_stage"):
            st.session_state[f"geo_explorer_stage_{hunt_id}"] = action["geo_stage"]
    if destination["workspace"] == "Privacy Removal":
        st.session_state.privacy_pending_studio_case_id = case_id
        st.session_state.privacy_pending_case_name = str(case["name"])
    request_workspace(destination["workspace"])
    st.rerun()


def _next_action(case: dict[str, Any], stats: dict[str, int]) -> dict[str, str]:
    case_id = str(case["id"])
    mode = str(case.get("mode") or "research")
    if mode == "privacy-removal":
        from .privacy_store import PrivacyStore

        privacy_store = PrivacyStore()
        privacy_case = next(
            (item for item in privacy_store.list_cases() if str(item.get("studio_case_id") or "") == case_id),
            None,
        )
        if not privacy_case:
            return {"label": "Complete authorization intake", "privacy_view": "Case"}
        privacy_id = str(privacy_case["privacy_case_id"])
        findings = privacy_store.list_findings(privacy_id)
        requests = privacy_store.list_requests(privacy_id)
        if not findings:
            return {"label": "Add a reviewed listing", "privacy_view": "Findings"}
        if not requests:
            return {"label": "Draft the first request", "privacy_view": "Draft & submit"}
        if any(str(item["status"]) not in {"completed", "withdrawn"} for item in requests):
            return {"label": "Review responses and follow-up", "privacy_view": "Follow-up"}
        return {"label": "Verify completed removals", "privacy_view": "Follow-up"}
    if mode == "property-research":
        from .property_store import PropertyWarehouse

        warehouse = PropertyWarehouse()
        hunts = warehouse.list_hunts(case_id)
        if not hunts:
            return {"label": "Create the property hunt"}
        hunt_id = str(hunts[0]["hunt_id"])
        queue = warehouse.list_geo_capture_queue(hunt_id, limit=25)
        if not queue:
            return {"label": "Inspect the map or draw a fence", "geo_hunt_id": hunt_id, "geo_stage": "1 · Inspect point"}
        if any(str(item.get("status")) != "reviewed" for item in queue):
            return {"label": "Review captured properties", "geo_hunt_id": hunt_id, "geo_stage": "4 · Review & export"}
        return {"label": "Continue property exploration", "geo_hunt_id": hunt_id, "geo_stage": "1 · Inspect point"}
    if mode == "market":
        return {"label": "Continue market review", "research_view": "Market Intelligence"}
    if mode == "technical":
        destination = _destination(case)
        if destination.get("view") == "Domain Security":
            return {"label": "Continue domain assessment", "research_view": "Domain Security"}
        return {"label": "Continue technical recon", "research_view": "Tool Arsenal"}
    metadata = _metadata(case)
    if metadata.get("hunt_type") == "People & identity":
        if stats["subjects"] == 0:
            return {"label": "Add the first person", "research_view": "People & Identity", "person_stage": "Scope"}
        if stats["runs"] == 0:
            return {"label": "Prepare person discovery", "research_view": "People & Identity", "person_stage": "Discover"}
        if stats["evidence"] == 0:
            return {"label": "Resolve discovered identities", "research_view": "People & Identity", "person_stage": "Resolve"}
        return {"label": "Review the person report", "research_view": "People & Identity", "person_stage": "Report"}
    if stats["subjects"] == 0:
        return {"label": "Define subjects and scope", "research_view": "Overview"}
    if stats["runs"] == 0:
        return {"label": "Start discovery", "research_view": "Discovery"}
    if stats["observations"] == 0:
        return {"label": "Review collection runs", "research_view": "Evidence"}
    return {"label": "Review evidence", "research_view": "Evidence"}


def _create_case(store: CaseStore) -> None:
    with st.form("case_workspace_create"):
        hunt_type = st.selectbox("Hunt type", tuple(HUNT_TYPES))
        name = st.text_input("Case name")
        objective = st.text_area("Objective", height=90)
        submitted = st.form_submit_button("Create and open", type="primary", use_container_width=True)
    if not submitted:
        return
    if not name.strip():
        st.error("Enter a case name.")
        return
    config = HUNT_TYPES[hunt_type]
    case_id = store.create_case(
        name,
        mode=config["mode"],
        objective=objective,
        metadata={"hunt_type": hunt_type, "created_from": "case-workspace"},
    )
    case = store.get_case(case_id)
    if case:
        _resume(case)


def _manage_case(store: CaseStore, case: dict[str, Any]) -> None:
    with st.expander("Manage case"):
        with st.form("case_workspace_manage"):
            name = st.text_input("Case name", value=str(case["name"]))
            objective = st.text_area("Objective", value=str(case.get("objective") or ""), height=90)
            status = st.selectbox("Status", ("active", "completed", "archived"), index=("active", "completed", "archived").index(str(case["status"])) if case["status"] in {"active", "completed", "archived"} else 0)
            save = st.form_submit_button("Save case")
        if save:
            store.update_case(str(case["id"]), name=name, objective=objective, status=status)
            st.success("Case updated.")
            st.rerun()


def _case_detail(store: CaseStore, case: dict[str, Any]) -> None:
    case_id = str(case["id"])
    stats = store.case_stats(case_id)
    destination = _destination(case)
    action = _next_action(case, stats)
    st.subheader(str(case["name"]))
    st.caption(str(case.get("objective") or "No objective recorded"))
    cols = st.columns(3)
    cols[0].metric("Evidence", stats["evidence"])
    cols[1].metric("Findings", stats["findings"])
    cols[2].metric("Runs", stats["runs"])
    action_left, action_right = st.columns([0.72, 0.28])
    st.info(f"Next action: {action['label']}")
    if action_left.button(f"Continue · {action['label']}", type="primary", use_container_width=True):
        _resume(case, action)
    archived = str(case.get("status")) == "archived"
    if action_right.button("Restore" if archived else "Archive", use_container_width=True):
        store.update_case(case_id, status="active" if archived else "archived")
        st.rerun()
    _manage_case(store, case)
    detail_view = stage_picker("Case detail", ("Hunts", "Evidence", "Activity", "Export"), key="case_detail_view")
    if detail_view == "Hunts":
        metadata = _metadata(case)
        st.write(
            {
                "hunt_type": metadata.get("hunt_type") or case.get("mode"),
                "status": case.get("status"),
                "created": case.get("created_at"),
                "updated": case.get("updated_at"),
            }
        )
        subjects = store.list_subjects(case_id, limit=100)
        if subjects:
            st.markdown("#### Research subjects")
            st.dataframe(pd.DataFrame(subjects), width="stretch", hide_index=True)
        if str(case.get("mode")) == "property-research":
            from .property_store import PropertyWarehouse

            hunts = PropertyWarehouse().list_hunts(case_id)
            if hunts:
                st.markdown("#### Property hunts")
                st.dataframe(pd.DataFrame(hunts), width="stretch", hide_index=True)
    elif detail_view == "Evidence":
        findings = store.list_findings(case_id, limit=100)
        observations = store.list_observations(case_id, limit=100)
        st.markdown("#### Findings")
        st.dataframe(pd.DataFrame(findings), width="stretch", hide_index=True)
        st.markdown("#### Recent observations")
        st.dataframe(pd.DataFrame(observations), width="stretch", hide_index=True)
    elif detail_view == "Activity":
        st.dataframe(pd.DataFrame(store.list_runs(case_id, limit=100)), width="stretch", hide_index=True)
    else:
        packet = {
            "schema_version": 1,
            "case": case,
            "stats": stats,
            "subjects": store.list_subjects(case_id, limit=500),
            "entities": store.list_entities(case_id, limit=500),
            "findings": store.list_findings(case_id, limit=500),
            "runs": store.list_runs(case_id, limit=500),
        }
        st.download_button(
            "Download case summary JSON",
            data=json.dumps(packet, ensure_ascii=False, indent=2),
            file_name=f"{case_id}-summary.json",
            mime="application/json",
            use_container_width=True,
        )


def render_case_workspace(store: CaseStore) -> None:
    st.title("Case Workspace")
    st.caption("Create once, resume exactly where you left off, and manage every DiveDeep hunt from one place.")
    cases = store.list_cases(500)
    toolbar_left, toolbar_right = st.columns([0.72, 0.28])
    query = toolbar_left.text_input("Find a case", placeholder="Name, objective or case ID", label_visibility="collapsed")
    status_filter = toolbar_right.selectbox("Status", ("Active", "Completed", "Archived", "All"), label_visibility="collapsed")
    status_value = status_filter.casefold()
    filtered = [
        case for case in cases
        if (status_filter == "All" or str(case.get("status") or "active") == status_value)
        and (not query.strip() or query.casefold() in " ".join((str(case.get("name") or ""), str(case.get("objective") or ""), str(case.get("id") or ""))).casefold())
    ]
    with st.expander("New case", expanded=not cases):
        _create_case(store)
    if not filtered:
        st.info("No cases match this view.")
        return
    rows = [
        {
            "Case": case["name"],
            "Type": _metadata(case).get("hunt_type") or case["mode"],
            "Status": case["status"],
            "Updated": case["updated_at"],
        }
        for case in filtered[:100]
    ]
    st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)
    by_id = {str(case["id"]): case for case in filtered}
    if st.session_state.get("case_workspace_selected_id") not in by_id:
        st.session_state.case_workspace_selected_id = next(iter(by_id))
    selected_id = st.selectbox(
        "Working case",
        list(by_id),
        format_func=lambda value: f"{by_id[value]['name']} · {by_id[value]['status']}",
        key="case_workspace_selected_id",
    )
    remember_active_case(str(selected_id))
    _case_detail(store, by_id[selected_id])
