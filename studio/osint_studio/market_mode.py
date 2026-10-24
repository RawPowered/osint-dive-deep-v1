from __future__ import annotations

import json
from typing import Any

import pandas as pd
import streamlit as st

from .case_store import CaseStore
from .market_intel import ACTIVATION_STATES, REVIEW_STATUSES, MarketIntelligenceService, MarketProfileConfig
from .ui_shell import stage_picker


def _lines(value: str) -> list[str]:
    return list(dict.fromkeys(item.strip() for item in value.splitlines() if item.strip()))


def _profile_selector(service: MarketIntelligenceService, case_id: str) -> dict[str, Any] | None:
    pending = st.session_state.pop("_pending_market_profile_id", None)
    profiles = service.list_profiles(case_id)
    by_id = {str(item["id"]): item for item in profiles}
    if pending in by_id:
        st.session_state.market_profile_id = pending
    if st.session_state.get("market_profile_id") not in by_id:
        st.session_state.market_profile_id = next(iter(by_id), None)
    selected = st.selectbox(
        "Market profile",
        list(by_id),
        format_func=lambda profile_id: str(by_id[profile_id]["name"]),
        key="market_profile_id",
        placeholder="Create a market profile",
    )
    return by_id.get(str(selected)) if selected else None


def _render_profiles(
    service: MarketIntelligenceService,
    store: CaseStore,
    case_id: str,
    profile: dict[str, Any] | None,
) -> None:
    with st.expander("Create or update a market profile", expanded=profile is None):
        entity_types = sorted({str(item["entity_type"]) for item in store.list_entities(case_id, 1_000_000)})
        existing_config = MarketProfileConfig.from_value(json.loads(str(profile["config_json"]))) if profile else MarketProfileConfig()
        default_types = [item for item in existing_config.entity_types if item in entity_types]
        if not default_types:
            default_types = [item for item in ("organization", "domain") if item in entity_types] or entity_types
        with st.form("market_profile_form"):
            name = st.text_input("Profile name", value=str(profile["name"]) if profile else "Market universe")
            description = st.text_area("Description", value=str(profile["description"]) if profile else "", height=80)
            selected_types = st.multiselect("Entity types", entity_types, default=default_types)
            required_identifiers = st.multiselect(
                "Required contact identifiers",
                ["url", "email", "phone", "social-url", "domain"],
                default=existing_config.required_identifier_types,
                help="An entity must contain every selected identifier type to receive a fit score.",
            )
            left, middle, right = st.columns(3)
            required_terms = left.text_area("Required evidence terms", value="\n".join(existing_config.required_terms), height=110)
            preferred_terms = middle.text_area("Preferred evidence terms", value="\n".join(existing_config.preferred_terms), height=110)
            excluded_terms = right.text_area("Excluded evidence terms", value="\n".join(existing_config.excluded_terms), height=110)
            score_col, refresh_col = st.columns(2)
            minimum_score = score_col.number_input("Minimum recommended score", 0.0, 100.0, float(existing_config.minimum_score), 1.0)
            refresh_days = refresh_col.number_input("Refresh after days", 1, 3650, int(existing_config.refresh_days))
            if st.form_submit_button("Save profile", type="primary", width="stretch"):
                config = MarketProfileConfig(
                    entity_types=selected_types,
                    required_identifier_types=required_identifiers,
                    required_terms=_lines(required_terms),
                    preferred_terms=_lines(preferred_terms),
                    excluded_terms=_lines(excluded_terms),
                    minimum_score=float(minimum_score),
                    refresh_days=int(refresh_days),
                )
                profile_id = service.save_profile(case_id, name, config, description=description)
                st.session_state._pending_market_profile_id = profile_id
                st.rerun()

    if not profile:
        st.info("Create a market profile after Research Mode has discovered at least one entity.")
        return
    config = MarketProfileConfig.from_value(json.loads(str(profile["config_json"])))
    st.json({"profile": profile["name"], **vars(config)}, expanded=False)
    if st.button("Derive enrichment and rebuild scores", type="primary"):
        with st.spinner("Deriving evidence-backed attributes and scoring the market…"):
            summary = service.evaluate_profile(str(profile["id"]))
        st.success(f"Evaluated {summary['entities_evaluated']:,} entities.")
        st.rerun()


def _review_frame(records: list[dict[str, Any]]) -> pd.DataFrame:
    rows = []
    for record in records:
        rows.append(
            {
                "id": record["id"],
                "name": record["canonical_name"],
                "type": record["entity_type"],
                "market score": record["total_score"],
                "fit": record["fit_score"],
                "confidence": record["confidence_score"],
                "freshness": record["freshness_score"],
                "reachability": record["reachability_score"],
                "verification": record["verification_status"],
                "sources": record["source_count"],
                "reasons": " | ".join(record["reason_codes"]),
                "review status": record["review_status"],
                "activation": record["recommended_activation"],
                "analyst notes": record["analyst_notes"],
                "expires": record["expires_at"],
            }
        )
    return pd.DataFrame(rows)


def _render_review(service: MarketIntelligenceService, profile: dict[str, Any] | None) -> None:
    if not profile:
        st.info("Select a market profile first.")
        return
    records = service.list_records(str(profile["id"]))
    if not records:
        st.info("Build scores from the Profiles tab first.")
        return
    columns = st.columns(4)
    columns[0].metric("Market records", len(records))
    columns[1].metric("Corroborated", sum(1 for row in records if row["verification_status"] == "corroborated"))
    columns[2].metric("Qualified", sum(1 for row in records if row["review_status"] == "qualified"))
    columns[3].metric("Export approved", sum(1 for row in records if row["review_status"] == "approved-for-export"))
    frame = _review_frame(records)
    edited = st.data_editor(
        frame,
        width="stretch",
        hide_index=True,
        disabled=[column for column in frame.columns if column not in {"review status", "activation", "analyst notes"}],
        column_config={
            "review status": st.column_config.SelectboxColumn(options=list(REVIEW_STATUSES), required=True),
            "activation": st.column_config.SelectboxColumn(options=list(ACTIVATION_STATES), required=True),
            "analyst notes": st.column_config.TextColumn(width="large"),
            "reasons": st.column_config.TextColumn(width="large"),
        },
        key="market_review_editor",
    )
    if st.button("Save review decisions", type="primary"):
        for row in edited.to_dict("records"):
            service.update_review(str(row["id"]), str(row["review status"]), str(row["analyst notes"]), str(row["activation"]))
        st.success("Review decisions saved.")
        st.rerun()


def _render_segments(service: MarketIntelligenceService, case_id: str, profile: dict[str, Any] | None) -> None:
    if not profile:
        st.info("Select a market profile first.")
        return
    profile_id = str(profile["id"])
    with st.form("market_segment_form"):
        name = st.text_input("Segment name", value="Approved market")
        minimum_score = st.slider("Minimum market score", 0.0, 100.0, 60.0, 1.0)
        review_statuses = st.multiselect("Review states", list(REVIEW_STATUSES), default=["approved-for-export"])
        verification_statuses = st.multiselect("Verification states", ["unverified", "single-source", "corroborated"], default=["corroborated"])
        activation_states = st.multiselect("Activation states", list(ACTIVATION_STATES), default=["approved-campaign", "consent-gated"])
        if st.form_submit_button("Save and materialize segment", type="primary", width="stretch"):
            segment_id = service.save_segment(
                case_id,
                profile_id,
                name,
                {
                    "minimum_score": minimum_score,
                    "review_statuses": review_statuses,
                    "verification_statuses": verification_statuses,
                    "activation_states": activation_states,
                },
            )
            st.session_state.market_segment_id = segment_id
            st.rerun()

    segments = service.list_segments(case_id, profile_id)
    by_id = {str(item["id"]): item for item in segments}
    if st.session_state.get("market_segment_id") not in by_id:
        st.session_state.market_segment_id = next(iter(by_id), None)
    selected_segment = st.selectbox(
        "Saved segment",
        list(by_id),
        format_func=lambda segment_id: str(by_id[segment_id]["name"]),
        key="market_segment_id",
        placeholder="Save a segment",
    )
    if selected_segment:
        segment_records = service.segment_records(str(selected_segment))
        count_col, refresh_col = st.columns([4, 1])
        count_col.caption(f"{len(segment_records):,} records are in this materialized segment.")
        if refresh_col.button("Refresh segment", width="stretch"):
            count = service.materialize_segment(str(selected_segment))
            st.success(f"Segment refreshed with {count:,} records.")
            st.rerun()
    export_rows = service.export_rows(profile_id, segment_id=str(selected_segment) if selected_segment else None, approved_only=True)
    if not export_rows:
        st.info("No non-suppressed, approved-for-export records currently match the export selection.")
        return
    csv_data = service.csv_bytes(export_rows)
    if st.download_button(
        "Download reviewed market CSV",
        data=csv_data,
        file_name=f"{profile['name']}_reviewed_market.csv",
        mime="text/csv",
        type="primary",
    ):
        export_id = service.register_export(
            case_id,
            profile_id,
            export_rows,
            segment_id=str(selected_segment) if selected_segment else None,
        )
        st.success(f"Export manifest recorded as `{export_id}`.")


def _render_suppressions(service: MarketIntelligenceService, case_id: str) -> None:
    st.caption("Suppression prevents matching identifiers from entering recommended or approved campaign exports; evidence remains local.")
    with st.form("market_suppression_form"):
        left, middle = st.columns(2)
        identifier_type = left.selectbox("Identifier type", ["email", "phone", "url", "domain", "social-url"])
        value = middle.text_input("Exact identifier value")
        reason = st.text_input("Reason")
        if st.form_submit_button("Add suppression", type="primary", width="stretch"):
            if not value.strip():
                st.warning("Enter an identifier value.")
            else:
                service.add_suppression(case_id, identifier_type, value, reason)
                st.success("Suppression saved. Rebuild scores to apply it to current records.")
                st.rerun()
    st.dataframe(pd.DataFrame(service.list_suppressions(case_id)), width="stretch", hide_index=True)


def render_market_intelligence(store: CaseStore, case: dict[str, object] | None) -> None:
    st.title("Market Intelligence")
    st.caption("Evidence-backed market census, enrichment, verification, segmentation and reviewed activation exports.")
    if not case:
        st.info("Create or select a Research Mode case first.")
        return
    case_id = str(case["id"])
    service = MarketIntelligenceService(store)
    profile = _profile_selector(service, case_id)
    view = stage_picker(
        "Market stage",
        ("Profiles & Scoring", "Review", "Segments & Export", "Suppression"),
        key="market_workspace_stage",
    )
    if view == "Profiles & Scoring":
        _render_profiles(service, store, case_id, profile)
    elif view == "Review":
        _render_review(service, profile)
    elif view == "Segments & Export":
        _render_segments(service, case_id, profile)
    else:
        _render_suppressions(service, case_id)
