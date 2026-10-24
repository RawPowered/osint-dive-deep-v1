from __future__ import annotations

import json
from urllib.parse import urlparse

import pandas as pd
import streamlit as st

from .case_store import CaseStore, utc_now
from .research_lanes import lane_matrix
from .ui_shell import stage_picker


IDENTIFIER_FIELDS: tuple[tuple[str, str], ...] = (
    ("Aliases", "alias"),
    ("Emails", "email"),
    ("Usernames", "username"),
    ("Phone numbers", "phone"),
    ("Locations", "location"),
    ("Known profile URLs", "profile-url"),
)

REVIEW_IDENTIFIER_TYPES = (
    "alias",
    "email",
    "username",
    "phone",
    "profile-url",
    "location",
    "organization",
    "occupation",
    "observed-language",
    "other",
)


def _lines(value: str) -> list[str]:
    return list(dict.fromkeys(item.strip() for item in value.splitlines() if item.strip()))


def _valid_url(value: str) -> bool:
    parsed = urlparse(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc) and not parsed.username and not parsed.password


def _people_subjects(store: CaseStore, case_id: str) -> list[dict[str, object]]:
    return [item for item in store.list_subjects(case_id, limit=500) if str(item.get("subject_type")) == "person"]


def _render_scope(store: CaseStore, case_id: str) -> None:
    st.subheader("Person scope")
    st.caption("Start with known facts. Discovery candidates remain separate until an analyst records an exact-source match.")
    with st.form("person_identity_scope"):
        primary_name = st.text_input("Primary name")
        left, right = st.columns(2)
        captured: dict[str, str] = {}
        for index, (label, identifier_type) in enumerate(IDENTIFIER_FIELDS):
            column = left if index % 2 == 0 else right
            captured[identifier_type] = column.text_area(label, height=72, placeholder="One per line")
        notes = st.text_area("Scope notes", height=80)
        save = st.form_submit_button("Add person to case", type="primary", use_container_width=True)
    if save:
        if not primary_name.strip():
            st.error("Enter the person's primary name.")
        else:
            subject_id = store.add_subject(
                case_id,
                "person",
                primary_name,
                primary_value=primary_name,
                metadata={"research_lane": "person", "notes": notes, "input_basis": "analyst-supplied"},
            )
            store.add_identifier(case_id, "name", primary_name, subject_id=subject_id, confidence=1.0, metadata={"basis": "case-scope"})
            for identifier_type, content in captured.items():
                for value in _lines(content):
                    store.add_identifier(
                        case_id,
                        identifier_type,
                        value,
                        subject_id=subject_id,
                        confidence=1.0,
                        metadata={"basis": "case-scope"},
                    )
            st.success("Person scope saved.")
            st.rerun()

    subjects = _people_subjects(store, case_id)
    identifiers = store.list_identifiers(case_id, limit=500)
    if subjects:
        st.markdown("#### Scoped people")
        st.dataframe(
            pd.DataFrame(
                [{"Name": item["label"], "Status": item["status"], "Added": item["created_at"]} for item in subjects]
            ),
            width="stretch",
            hide_index=True,
        )
    if identifiers:
        st.markdown("#### Known identifiers")
        st.dataframe(
            pd.DataFrame(
                [{"Type": item["identifier_type"], "Value": item["display_value"], "Confidence": item["confidence"]} for item in identifiers]
            ),
            width="stretch",
            hide_index=True,
        )


def _render_discovery(store: CaseStore, case_id: str) -> None:
    st.subheader("Discovery launch")
    subjects = _people_subjects(store, case_id)
    if not subjects:
        st.info("Add a person in Scope before launching discovery.")
        return
    by_id = {str(item["id"]): item for item in subjects}
    selected_ids = st.multiselect(
        "People to investigate",
        list(by_id),
        default=list(by_id),
        format_func=lambda value: str(by_id[value]["label"]),
    )
    geographies = st.text_area("Geographic qualifiers", height=80, placeholder="City, state or country · one per line")
    selected_subject_ids = set(selected_ids)
    identifiers = [item for item in store.list_identifiers(case_id, limit=1000) if str(item.get("subject_id")) in selected_subject_ids]
    seed_values = [str(by_id[value]["label"]) for value in selected_ids]
    seed_values.extend(
        str(item["display_value"])
        for item in identifiers
        if str(item["identifier_type"]) in {"alias", "email", "username", "phone", "profile-url"}
    )
    seed_values = list(dict.fromkeys(seed_values))
    st.caption(f"{len(seed_values)} exact names and identifiers will seed the existing People & Identity discovery lane.")
    primary, secondary, tertiary = st.columns(3)
    if primary.button("Prepare and open Discovery", type="primary", use_container_width=True):
        if not seed_values:
            st.error("Select at least one person.")
        else:
            matrix = lane_matrix("person", seed_values)
            for key, value in matrix.items():
                st.session_state[f"super_{key}"] = value
            st.session_state.super_geographies = "\n".join(_lines(geographies))
            st.session_state.super_query_shards = []
            st.session_state.research_lane = "person"
            st.session_state.research_active_view = "Discovery"
            st.rerun()
    if secondary.button("Open Web Validation", use_container_width=True):
        st.session_state.research_active_view = "Web Validation"
        st.rerun()
    if tertiary.button("Open Tool Arsenal", use_container_width=True):
        st.session_state.research_active_view = "Tool Arsenal"
        st.rerun()


def _render_resolution(store: CaseStore, case_id: str) -> None:
    st.subheader("Identity resolution")
    st.caption("Record one reviewed identifier at a time. The exact source and matching basis remain attached to the observation and evidence.")
    subjects = _people_subjects(store, case_id)
    default_name = str(subjects[0]["label"]) if subjects else ""
    with st.form("person_identity_resolution"):
        canonical_name = st.text_input("Canonical person name", value=default_name)
        left, right = st.columns(2)
        identifier_type = left.selectbox("Observed field", REVIEW_IDENTIFIER_TYPES)
        identifier_value = right.text_input("Exact observed value")
        source_url = st.text_input("Exact public source URL")
        match_basis = st.multiselect(
            "Matching basis",
            ("name", "alias", "location", "email", "username", "phone", "organization", "cross-source corroboration"),
        )
        confidence = st.slider("Match confidence", min_value=0.0, max_value=1.0, value=0.80, step=0.05)
        notes = st.text_area("Analyst notes", height=90)
        confirmed = st.checkbox("I reviewed this source and the value belongs to the scoped person.")
        save = st.form_submit_button("Record reviewed identity evidence", type="primary", use_container_width=True)
    if save:
        if not canonical_name.strip() or not identifier_value.strip():
            st.error("Canonical name and observed value are required.")
        elif not _valid_url(source_url):
            st.error("Enter the exact valid http(s) source URL.")
        elif not match_basis:
            st.error("Select at least one matching basis.")
        elif not confirmed:
            st.error("Confirm the source review before recording the link.")
        else:
            entity_id = store.upsert_entity(
                case_id,
                "person",
                canonical_name,
                confidence=float(confidence),
                metadata={"resolution": "analyst-reviewed"},
            )
            store.add_identifier(
                case_id,
                identifier_type,
                identifier_value,
                entity_id=entity_id,
                confidence=float(confidence),
                metadata={"source_url": source_url, "match_basis": match_basis},
            )
            value = {
                "canonical_name": canonical_name.strip(),
                "identifier_type": identifier_type,
                "identifier_value": identifier_value.strip(),
                "match_basis": match_basis,
                "analyst_notes": notes.strip(),
            }
            observation_id = store.record_observation(
                case_id,
                "identity-link-reviewed",
                value,
                entity_id=entity_id,
                normalized_value=identifier_value,
                source_name=urlparse(source_url).netloc,
                source_uri=source_url,
                confidence=float(confidence),
                metadata={"reviewed": True},
            )
            evidence_id = store.add_evidence(
                case_id,
                "person-identity-source",
                json.dumps(value, ensure_ascii=False, sort_keys=True),
                observation_id=observation_id,
                source_uri=source_url,
                metadata={"match_basis": match_basis, "unredacted_local_evidence": True},
            )
            store.add_claim(
                case_id,
                f"person.{identifier_type}",
                identifier_value,
                entity_id=entity_id,
                confidence=float(confidence),
                status="analyst-reviewed",
                evidence_ids=[evidence_id],
                metadata={"source_url": source_url},
            )
            st.success("Reviewed identity evidence recorded.")
            st.rerun()

    entities = [item for item in store.list_entities(case_id, limit=500) if str(item.get("entity_type")) == "person"]
    if entities:
        st.markdown("#### Resolved people")
        st.dataframe(pd.DataFrame(entities), width="stretch", hide_index=True)
        selected_entity = st.selectbox(
            "Resolved identity",
            [str(item["id"]) for item in entities],
            format_func=lambda value: next(str(item["canonical_name"]) for item in entities if str(item["id"]) == value),
        )
        st.dataframe(pd.DataFrame(store.list_entity_identifiers(case_id, selected_entity)), width="stretch", hide_index=True)
    else:
        st.info("No reviewed identity links have been recorded yet.")


def _render_evidence(store: CaseStore, case_id: str) -> None:
    st.subheader("Person evidence")
    evidence = store.list_evidence(case_id, limit=500)
    findings = store.list_findings(case_id, limit=500)
    observations = store.list_observations(case_id, limit=500)
    if evidence:
        st.dataframe(
            pd.DataFrame(
                [{"Captured": item["captured_at"], "Type": item["evidence_type"], "Source": item["source_uri"], "SHA-256": item["sha256"]} for item in evidence]
            ),
            width="stretch",
            hide_index=True,
        )
        by_id = {str(item["id"]): item for item in evidence}
        selected_id = st.selectbox("Exact evidence", list(by_id), format_func=lambda value: f"{by_id[value]['evidence_type']} · {by_id[value]['captured_at']}")
        st.code(str(by_id[selected_id]["value_text"]), language="json")
    else:
        st.info("No promoted person-identity evidence yet. Discovery observations remain available below.")
    if observations:
        with st.expander(f"Discovery observations · {len(observations)}"):
            st.dataframe(pd.DataFrame(observations), width="stretch", hide_index=True)
    if findings:
        with st.expander(f"Findings · {len(findings)}"):
            st.dataframe(pd.DataFrame(findings), width="stretch", hide_index=True)


def _render_report(store: CaseStore, case: dict[str, object]) -> None:
    case_id = str(case["id"])
    subjects = _people_subjects(store, case_id)
    entities = [item for item in store.list_entities(case_id, limit=1000) if str(item.get("entity_type")) == "person"]
    identifiers = store.list_identifiers(case_id, limit=2000)
    observations = store.list_observations(case_id, limit=2000)
    evidence = store.list_evidence(case_id, limit=2000)
    claims = store.list_claims(case_id, limit=2000)
    findings = store.list_findings(case_id, limit=2000)
    report = {
        "schema_version": 1,
        "report_type": "person-identity-command-center",
        "generated_at": utc_now(),
        "case": case,
        "subjects": subjects,
        "resolved_people": entities,
        "identifiers": identifiers,
        "observations": observations,
        "evidence": evidence,
        "claims": claims,
        "findings": findings,
    }
    st.subheader("Consolidated person identity report")
    st.caption("The export preserves exact local values, provenance, confidence and analyst review state in one report.")
    st.download_button(
        "Download complete person report JSON",
        data=json.dumps(report, ensure_ascii=False, indent=2),
        file_name=f"{case_id}-person-identity-report.json",
        mime="application/json",
        type="primary",
        use_container_width=True,
    )
    if identifiers:
        st.download_button(
            "Download identity index CSV",
            data=pd.DataFrame(identifiers).to_csv(index=False).encode("utf-8"),
            file_name=f"{case_id}-identity-index.csv",
            mime="text/csv",
            use_container_width=True,
        )


def render_person_identity_command_center(store: CaseStore, case: dict[str, object] | None) -> None:
    st.title("People & Identity Command Center")
    st.caption("Case-scoped person discovery, exact-source resolution and consolidated identity evidence.")
    if not case:
        st.info("Create or select a research case first.")
        return
    case_id = str(case["id"])
    stats = store.case_stats(case_id)
    resolved_people = [item for item in store.list_entities(case_id, limit=500) if str(item.get("entity_type")) == "person"]
    columns = st.columns(3)
    columns[0].metric("Scoped people", len(_people_subjects(store, case_id)))
    columns[1].metric("Resolved people", len(resolved_people))
    columns[2].metric("Evidence", stats["evidence"])
    if stats["subjects"] == 0:
        default_stage = "Scope"
    elif stats["runs"] == 0:
        default_stage = "Discover"
    elif stats["evidence"] == 0:
        default_stage = "Resolve"
    else:
        default_stage = "Evidence"
    stage = stage_picker(
        "People and identity stage",
        ("Scope", "Discover", "Resolve", "Evidence", "Report"),
        key="person_identity_stage",
        default=default_stage,
    )
    if stage == "Scope":
        _render_scope(store, case_id)
    elif stage == "Discover":
        _render_discovery(store, case_id)
    elif stage == "Resolve":
        _render_resolution(store, case_id)
    elif stage == "Evidence":
        _render_evidence(store, case_id)
    else:
        _render_report(store, case)
