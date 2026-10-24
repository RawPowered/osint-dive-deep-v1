from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import streamlit as st


ACTIVE_CASE_KEY = "divedeep_active_case_id"
PENDING_WORKSPACE_KEY = "_pending_workspace_mode"


def request_workspace(workspace: str) -> None:
    """Queue sidebar navigation for the next rerun, before its radio is instantiated."""
    st.session_state[PENDING_WORKSPACE_KEY] = workspace


def consume_pending_workspace(valid_workspaces: Sequence[str]) -> None:
    pending = st.session_state.pop(PENDING_WORKSPACE_KEY, None)
    if pending in valid_workspaces:
        st.session_state.workspace_mode = pending


def set_active_case(case_id: str | None) -> None:
    st.session_state[ACTIVE_CASE_KEY] = str(case_id) if case_id else None


def prefer_active_case(valid_ids: Sequence[str], *, local_key: str) -> None:
    identifiers = tuple(str(value) for value in valid_ids)
    active = st.session_state.get(ACTIVE_CASE_KEY)
    local = st.session_state.get(local_key)
    if local not in identifiers and active in identifiers:
        st.session_state[local_key] = active
    elif local not in identifiers:
        st.session_state[local_key] = identifiers[0] if identifiers else None


def remember_active_case(case_id: str | None) -> None:
    if case_id:
        set_active_case(str(case_id))


def stage_picker(label: str, options: Sequence[str], *, key: str, default: str | None = None) -> str:
    choices = tuple(options)
    if not choices:
        raise ValueError("A stage picker requires at least one option.")
    if st.session_state.get(key) not in choices:
        st.session_state[key] = default if default in choices else choices[0]
    return str(st.radio(label, choices, horizontal=True, key=key, label_visibility="collapsed"))


def case_context_header(
    case: dict[str, Any] | None,
    *,
    workspace: str,
    detail: str = "",
) -> None:
    if not case:
        return
    if case.get("id"):
        remember_active_case(str(case["id"]))
    left, right = st.columns([0.74, 0.26], vertical_alignment="center")
    left.markdown(f"**{case.get('name', 'Untitled case')}** · {workspace} · {case.get('status', 'active')}")
    left.caption(detail or str(case.get("objective") or "No objective recorded"))
    if right.button("Case workspace", key=f"open_case_workspace_{workspace}", use_container_width=True):
        request_workspace("Cases")
        st.rerun()
