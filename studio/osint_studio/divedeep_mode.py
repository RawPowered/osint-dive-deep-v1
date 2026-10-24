from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pandas as pd
import streamlit as st

from .divedeep_ops import (
    MISSION_FAMILIES,
    PACKAGE_FLOWS,
    PACKAGE_ORDER,
    build_job_argv,
    execute_job,
    export_workspace_results,
    extract_candidate_records,
    infer_package_key,
    import_uploaded_packet,
    job_install_status,
    list_workspaces,
    load_operator_state,
    load_workspace_bundle,
    mark_job_status,
    pending_executable_indices,
    read_job_output,
    rebuild_tool_plan,
    record_payload,
    set_operator_status,
    stage_job_candidates,
    store_evidence_upload,
    store_reference_photo,
    workspace_file_bytes,
)
from .privacy_templates import TEMPLATE_BY_KEY
from .ui_shell import request_workspace, stage_picker


STAGES = ("Intake", "Targets", "Tool Runbook", "Findings & Evidence", "Export")

_PENDING_WORKSPACE_KEY = "_divedeep_pending_active_workspace"
_PENDING_STAGE_KEY = "_divedeep_pending_workflow_stage"


def _apply_pending_divedeep_state() -> None:
    """Apply deferred widget state before Streamlit instantiates those widgets."""
    if _PENDING_WORKSPACE_KEY in st.session_state:
        st.session_state["divedeep_active_workspace"] = st.session_state.pop(
            _PENDING_WORKSPACE_KEY
        )

    if _PENDING_STAGE_KEY in st.session_state:
        st.session_state["divedeep_workflow_stage"] = st.session_state.pop(
            _PENDING_STAGE_KEY
        )


def _activate_workspace_on_next_render(
    workspace: str | Path,
    *,
    next_stage: str | None = None,
) -> None:
    """Defer workspace/stage changes until the next Streamlit render cycle."""
    st.session_state[_PENDING_WORKSPACE_KEY] = str(workspace)
    if next_stage:
        st.session_state[_PENDING_STAGE_KEY] = next_stage
    st.rerun()


def _navigate_divedeep(next_stage: str) -> None:
    """Navigate without mutating an already-instantiated stage widget."""
    if next_stage not in STAGES:
        raise ValueError(f"Unsupported DiveDeep workflow stage: {next_stage}")
    st.session_state[_PENDING_STAGE_KEY] = next_stage
    st.rerun()


def _label_workspace(item: dict[str, Any]) -> str:
    name = str(item.get("displayName") or item.get("customerId") or "DiveDeep customer")
    tier = str(item.get("packageLabel") or item.get("planTier") or "unassigned")
    findings = int(item.get("findingCount") or 0)
    return f"{name} · {tier} · {findings} findings"


def _safe_json_download(value: Any) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _package_label(package_key: str) -> str:
    profile = PACKAGE_FLOWS.get(package_key, PACKAGE_FLOWS["standard"])
    return f"{profile['label']} · {profile['description']}"


def _active_workspace_selector() -> str | None:
    rows = list_workspaces()
    if not rows:
        return None
    by_path = {str(item["workspace"]): item for item in rows}
    paths = list(by_path)
    current = st.session_state.get("divedeep_active_workspace")
    if current not in by_path:
        current = paths[0]
        st.session_state.divedeep_active_workspace = current
    selected = st.selectbox(
        "Active customer workspace",
        paths,
        index=paths.index(current),
        format_func=lambda value: _label_workspace(by_path[value]),
        key="divedeep_active_workspace",
    )
    return str(selected)


def _render_header(bundle: dict[str, Any] | None) -> None:
    left, right = st.columns([0.72, 0.28], vertical_alignment="center")
    with left:
        st.title("DiveDeep Operations")
        st.caption("Authorized intake → local recon → evidence review → DiveDeep result packet")
    with right:
        if bundle:
            manifest = bundle["manifest"]
            status = bundle["operatorState"].get("status", "intake")
            st.markdown(
                f"""
                <div class="fid-workspace-badge">
                    <strong>{manifest.get('displayName') or manifest.get('customerId')}</strong><br>
                    <span>{manifest.get('packageLabel') or manifest.get('planTier') or 'unassigned'} · {status.replace('_', ' ')}</span>
                </div>
                """,
                unsafe_allow_html=True,
            )


def _metric_row(bundle: dict[str, Any]) -> None:
    results = bundle["results"]
    findings = results.get("findings", []) or []
    summary = results.get("summary", {}) or {}
    jobs = bundle["toolPlan"].get("jobs", []) or []
    state_jobs = bundle["operatorState"].get("jobs", {}) or {}
    completed = sum(1 for item in state_jobs.values() if item.get("status") in {"completed", "reviewed", "manual_complete", "skipped"})
    captured = len(bundle.get("observables", {}).get("items", []) or [])
    cols = st.columns(7)
    cols[0].metric("Tool jobs", len(jobs))
    cols[1].metric("Jobs complete", completed)
    cols[2].metric("Captured data", captured)
    cols[3].metric("Findings", len(findings))
    cols[4].metric("Confirmed", int(summary.get("confirmedFindings") or 0))
    cols[5].metric("Requests sent", int(summary.get("requestsSent") or 0))
    cols[6].metric("Removed", int(summary.get("removed") or 0))

def _render_import() -> None:
    st.subheader("Import a DiveDeep customer packet")
    st.caption("Upload the JSON exported from DiveDeep Admin. DiveDeep creates the case folder and package-matched recon queues immediately.")
    uploaded = st.file_uploader("DiveDeep JSON export", type=["json"], key="divedeep_intake_upload")
    if uploaded is not None:
        try:
            preview = json.loads(uploaded.getvalue().decode("utf-8"))
            customer = preview.get("customer", {})
            profile = preview.get("divedeep", {}).get("profile", {})
            inferred_package = infer_package_key(preview)
            c1, c2, c3, c4 = st.columns(4)
            c1.metric("Customer", customer.get("displayName") or customer.get("id", "")[:12])
            c2.metric("Plan", customer.get("planTier", ""))
            c3.metric("Identifiers", len(profile.get("identifiers", []) or []))
            c4.metric("Connections", len(preview.get("connections", []) or []))
            package_key = st.selectbox(
                "DiveDeep service package",
                list(PACKAGE_ORDER),
                index=list(PACKAGE_ORDER).index(inferred_package),
                format_func=_package_label,
                key=f"divedeep_import_package_{customer.get('id') or 'preview'}",
                help="The package determines the recon families, queue depth, and result limits. Customer authorization still limits sensitive and photo work.",
            )
            package = PACKAGE_FLOWS[package_key]
            st.info(
                f"**{package['label']}** prepares: "
                + ", ".join(MISSION_FAMILIES[key]["label"] for key in package["families"])
            )
            auth = profile.get("authorization", {})
            if auth.get("status") != "active" or auth.get("revokedAt"):
                st.error("The packet does not contain an active authorization.")
            elif package_key == "sensitive" and not customer.get("sensitiveContentConsentAt"):
                st.error("Sensitive Exposure requires separate sensitive-content consent in the DiveDeep packet.")
            elif st.button("Import and create recon case", type="primary", use_container_width=True):
                imported = import_uploaded_packet(uploaded.name, uploaded.getvalue(), package_key=package_key)
                _activate_workspace_on_next_render(
                    imported["workspace"],
                    next_stage="Tool Runbook",
                )
        except (UnicodeDecodeError, ValueError, TypeError) as exc:
            st.error(f"Invalid DiveDeep packet: {exc}")


def _render_intake(bundle: dict[str, Any] | None) -> None:
    _render_import()
    if not bundle:
        return
    st.divider()
    intake = bundle["intake"]
    customer = intake.get("customer", {})
    profile = intake.get("divedeep", {}).get("profile", {})
    authorization = profile.get("authorization", {})
    st.subheader("Active customer intake")
    c1, c2, c3 = st.columns([0.42, 0.28, 0.30])
    with c1:
        st.markdown(f"**{customer.get('displayName') or 'Unnamed customer'}**")
        st.caption(customer.get("email", ""))
        st.write(f"Customer ID: `{customer.get('id', '')}`")
        st.write(f"Profile ID: `{profile.get('id', '')}`")
    with c2:
        st.write(f"**Plan:** {customer.get('planTier', '')}")
        st.write(f"**Recon package:** {bundle['manifest'].get('packageLabel') or 'Unassigned'}")
        st.write(f"**Workflow:** {customer.get('workflowStatus', '')}")
        st.write(f"**Jurisdiction:** {profile.get('jurisdictionRegion', '')}, {profile.get('jurisdictionCountry', '')}")
    with c3:
        st.write(f"**Authorization:** {authorization.get('status', '')}")
        st.write(f"**Signed:** {authorization.get('signedAt', '')}")
        st.write(f"**Sensitive consent:** {'Yes' if customer.get('sensitiveContentConsentAt') else 'No'}")

    st.caption(f"Case folder: `{bundle['workspace'] / 'case'}`")

    instructions = intake.get("manualProcessing", {}).get("instructions", []) or []
    with st.expander("Customer authorization and processing instructions", expanded=True):
        for line in instructions:
            st.markdown(f"- {line}")
    photos = intake.get("photos", []) or []
    if photos:
        st.markdown("#### Authorized reference photos")
        st.caption("Download each original from DiveDeep Admin, then attach it here. DiveDeep verifies the recorded SHA-256 when available and stores it in the expected private workspace path.")
        for photo in photos:
            photo_id = str(photo.get("id") or "photo")
            mime_type = str(photo.get("mimeType") or "image/jpeg")
            suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(mime_type, ".bin")
            expected = bundle["workspace"] / "evidence" / "reference-photos" / f"{photo_id}{suffix}"
            left, right = st.columns([0.72, 0.28])
            upload = left.file_uploader(
                f"{photo.get('label') or 'Reference photo'} · {photo_id}",
                type=["jpg", "jpeg", "png", "webp"],
                key=f"divedeep_reference_photo_{bundle['manifest'].get('customerId')}_{photo_id}",
            )
            if expected.is_file():
                right.success("Ready")
            elif upload is None:
                right.warning("Missing")
            if upload is not None and right.button("Store photo", key=f"divedeep_store_photo_{photo_id}", use_container_width=True):
                try:
                    stored = store_reference_photo(
                        bundle["workspace"],
                        photo_id,
                        mime_type,
                        upload.getvalue(),
                        expected_sha256=str(photo.get("sha256") or ""),
                    )
                    st.success(f"Stored {stored.name} in the private workspace.")
                    st.rerun()
                except Exception as exc:
                    st.error(str(exc))


def _target_rows(intake: dict[str, Any]) -> list[dict[str, Any]]:
    profile = intake.get("divedeep", {}).get("profile", {})
    rows: list[dict[str, Any]] = []
    for item in profile.get("identifiers", []) or []:
        rows.append(
            {
                "Type": item.get("type", ""),
                "Label": item.get("label", ""),
                "Value": item.get("value", ""),
                "Primary": bool(item.get("isPrimary")),
                "Status": item.get("status", ""),
            }
        )
    return rows


def _render_targets(bundle: dict[str, Any]) -> None:
    intake = bundle["intake"]
    workspace = bundle["workspace"]
    st.subheader("Authorized targets and mission setup")
    tabs = st.tabs(["Mission builder", "Identifiers", "Connected profiles", "Visibility rules", "Source sets", "Files"])
    with tabs[0]:
        plan_package = bundle["toolPlan"].get("package") if isinstance(bundle["toolPlan"].get("package"), dict) else {}
        current_package = str(plan_package.get("key") or bundle["manifest"].get("packageKey") or infer_package_key(intake))
        package_key = st.selectbox(
            "DiveDeep service package",
            list(PACKAGE_ORDER),
            index=list(PACKAGE_ORDER).index(current_package) if current_package in PACKAGE_ORDER else 0,
            format_func=_package_label,
            key=f"divedeep_package_flow_{bundle['manifest'].get('customerId')}",
        )
        profile = PACKAGE_FLOWS[package_key]
        included = [MISSION_FAMILIES[key]["label"] for key in profile["families"]]
        st.success(f"**{profile['label']}** · {profile['description']}")
        st.write("Included queues: " + ", ".join(included))
        limits = profile["limits"]
        l1, l2, l3, l4 = st.columns(4)
        l1.metric("Text results/query", limits["textResults"])
        l2.metric("Image results/query", limits["imageResults"])
        l3.metric("Username targets", limits["usernameTargets"])
        l4.metric("Correlation targets", limits["correlationTargets"])

        selected_families = list(profile["families"])
        with st.expander("Advanced package override"):
            selected_families = st.multiselect(
                "Tool families",
                list(MISSION_FAMILIES),
                default=selected_families,
                format_func=lambda key: MISSION_FAMILIES[key]["label"],
                help="Normally leave this matched to the package. Overrides are retained only for this local DiveDeep case.",
            )
            for key in selected_families:
                st.caption(f"**{MISSION_FAMILIES[key]['label']}** · {MISSION_FAMILIES[key]['description']}")

        c1, c2 = st.columns([0.68, 0.32])
        c1.info(
            "Applying a package rebuilds the entire local queue from the authorized customer packet. Existing reviewed findings remain intact; job state is reconciled by tool and target."
        )
        if c2.button("Apply package and rebuild queues", type="primary", use_container_width=True, disabled=not selected_families):
            rebuild_tool_plan(workspace, selected_families, package_key=package_key)
            _navigate_divedeep("Tool Runbook")

        warnings = bundle["toolPlan"].get("warnings", []) or []
        for warning in warnings:
            st.warning(warning)

        rows = []
        for job in bundle["toolPlan"].get("jobs", []) or []:
            status, detail = job_install_status(job)
            rows.append({
                "Family": MISSION_FAMILIES.get(str(job.get("family")), {}).get("label", job.get("family", "")),
                "Tool": job.get("tool", ""),
                "Target type": job.get("targetType", ""),
                "Target": job.get("target", ""),
                "Runtime": status,
                "Detail": detail,
            })
        if rows:
            st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
    with tabs[1]:
        rows = _target_rows(intake)
        st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
    with tabs[2]:
        connections = intake.get("connections", []) or []
        rows = [
            {
                "Provider": item.get("provider", ""),
                "Mode": item.get("connectionMode", ""),
                "Display name": item.get("displayName", ""),
                "Username": item.get("username", ""),
                "Profile URL": item.get("profileUrl", ""),
                "Protected": bool(item.get("protectedFromRemoval")),
                "Status": item.get("status", ""),
            }
            for item in connections
        ]
        st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
    with tabs[3]:
        policies = intake.get("divedeep", {}).get("profile", {}).get("policies", []) or []
        rows = [
            {
                "Scope": item.get("scopeType", ""),
                "Value": item.get("scopeValue", "") or "*",
                "Action": item.get("action", ""),
                "Priority": item.get("priority", 0),
            }
            for item in policies
        ]
        st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
    with tabs[4]:
        source_sets = intake.get("manualProcessing", {}).get("sourceSets", []) or []
        for value in source_sets:
            st.markdown(f"- `{value}`")
    with tabs[5]:
        downloads = [
            ("case/case.json", "Download recon case summary", "application/json"),
            ("case/queue.json", "Download package queue index", "application/json"),
            ("targets/targets.csv", "Download targets.csv", "text/csv"),
            ("tool-plan.json", "Download tool plan", "application/json"),
            ("targets/photos-manifest.json", "Download photo manifest", "application/json"),
        ]
        for relative, label, mime in downloads:
            try:
                data = workspace_file_bytes(workspace, relative)
            except FileNotFoundError:
                continue
            st.download_button(label, data=data, file_name=Path(relative).name, mime=mime, use_container_width=True)

def _job_rows(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    jobs = bundle["toolPlan"].get("jobs", []) or []
    state = bundle["operatorState"].get("jobs", {}) or {}
    by_index = {int(item.get("index", -1)): item for item in state.values()}
    rows: list[dict[str, Any]] = []
    for index, job in enumerate(jobs):
        item = by_index.get(index, {})
        status, detail = job_install_status(job)
        rows.append(
            {
                "#": index + 1,
                "Family": MISSION_FAMILIES.get(str(job.get("family")), {}).get("label", job.get("family", "")),
                "Tool": job.get("tool", ""),
                "Target type": job.get("targetType", ""),
                "Target": job.get("target", ""),
                "Status": item.get("status", "pending"),
                "Runtime": status,
                "Captured": item.get("observableCount", 0),
                "Candidates": item.get("candidateCount", 0),
                "Staged": item.get("stagedCount", 0),
                "Duration": item.get("durationSeconds"),
                "Detail": detail,
            }
        )
    return rows

def _selected_job(bundle: dict[str, Any]) -> tuple[int, dict[str, Any]] | None:
    jobs = bundle["toolPlan"].get("jobs", []) or []
    if not jobs:
        return None
    options = list(range(len(jobs)))
    index = st.selectbox(
        "Selected job",
        options,
        format_func=lambda value: f"{value + 1}. {jobs[value].get('tool')} · {jobs[value].get('target')}",
        key=f"divedeep_job_select_{bundle['manifest'].get('customerId')}",
    )
    return int(index), jobs[int(index)]


def _render_runbook(bundle: dict[str, Any]) -> None:
    workspace = bundle["workspace"]
    jobs = bundle["toolPlan"].get("jobs", []) or []
    rows = _job_rows(bundle)
    package = bundle["toolPlan"].get("package") if isinstance(bundle["toolPlan"].get("package"), dict) else {}
    package_label = str(package.get("label") or bundle["manifest"].get("packageLabel") or "DiveDeep package")

    st.subheader("Point-and-click identity recon")
    st.caption("DiveDeep was launched with `./run.sh`. Package queues execute allowlisted jobs through `run.sh`, preserve exact output, extract observables, and stage candidates for review.")
    if not rows:
        st.info("No mission jobs exist yet. Open Targets and apply a DiveDeep package.")
        return

    warnings = bundle["toolPlan"].get("warnings", []) or []
    for warning in warnings:
        st.warning(warning)

    family_counts = bundle["toolPlan"].get("familyCounts", {}) or {}
    st.markdown(f"#### {package_label} queue")
    if family_counts:
        family_frame = pd.DataFrame([
            {
                "Queue": MISSION_FAMILIES.get(key, {}).get("label", key),
                "Jobs": count,
            }
            for key, count in family_counts.items()
        ])
        st.dataframe(family_frame, hide_index=True, width="stretch")

    config1, config2, config3 = st.columns([0.34, 0.33, 0.33])
    timeout = config1.number_input("Per-job timeout", min_value=30, max_value=7200, value=900, step=30)
    retry_failed = config2.checkbox("Include failed jobs", value=False)
    continue_on_failure = config3.checkbox("Continue after failures", value=True)

    pending = pending_executable_indices(workspace, include_failed=retry_failed)
    pending_families = sorted({str(jobs[index].get("family") or "") for index in pending if str(jobs[index].get("family") or "")})
    manual_count = sum(1 for job in jobs if not build_job_argv(job, workspace))

    action1, action2, action3 = st.columns([0.40, 0.30, 0.30])
    run_all = action1.button(
        f"Run all {len(pending)} automatic jobs",
        type="primary",
        disabled=not pending,
        use_container_width=True,
        help="Runs every ready automatic job in the package queue sequentially.",
    )
    run_next = action2.button("Run next pending", disabled=not pending, use_container_width=True)
    batch_size = action3.number_input("Quick batch size", min_value=1, max_value=100, value=min(10, max(1, len(pending))), step=1)
    run_batch = action3.button("Run quick batch", disabled=not pending, use_container_width=True)

    family1, family2 = st.columns([0.72, 0.28])
    family_choice = family1.selectbox(
        "Run one queue family",
        pending_families or [""],
        format_func=lambda key: MISSION_FAMILIES.get(key, {}).get("label", key or "No ready family queues"),
        disabled=not pending_families,
    )
    run_family = family2.button("Run family queue", disabled=not pending_families, use_container_width=True)
    st.caption(f"Manual/provider tasks remaining: {manual_count}. These are reviewed separately and are never launched as arbitrary commands.")

    def run_indices(indices: list[int], label: str) -> None:
        progress = st.progress(0.0, text=f"Preparing {label}...")
        live = st.empty()
        failures: list[int] = []
        for position, job_index in enumerate(indices):
            job = jobs[job_index]
            progress.progress(position / max(1, len(indices)), text=f"{label}: {position + 1}/{len(indices)} · {job.get('tool')} · {job.get('target')}")
            result = execute_job(
                workspace,
                job_index,
                timeout_seconds=int(timeout),
                on_output=lambda value: live.code(value[-30000:], language="text"),
            )
            failed = result.return_code not in {0, None} or result.timed_out or bool(result.error)
            if failed:
                failures.append(job_index)
                st.warning(f"Job {job_index + 1} failed or timed out. Exact output was retained.")
                if not continue_on_failure:
                    break
        completed = len(indices) - len(failures)
        progress.progress(1.0, text=f"{label} finished · {completed} completed · {len(failures)} failed")
        st.rerun()

    if run_all and pending:
        run_indices(pending, f"{package_label} full queue")
    if run_next and pending:
        run_indices(pending[:1], "Next job")
    if run_batch and pending:
        run_indices(pending[: int(batch_size)], "Quick batch")
    if run_family and family_choice:
        family_indices = [index for index in pending if str(jobs[index].get("family") or "") == family_choice]
        run_indices(family_indices, MISSION_FAMILIES.get(family_choice, {}).get("label", family_choice))

    queue_tab, captured_tab = st.tabs(["Mission queue", "Captured data"])
    with queue_tab:
        st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
        selected = _selected_job(bundle)
        if not selected:
            return
        index, job = selected
        argv = build_job_argv(job, workspace)
        state = load_operator_state(workspace)
        state_item = next((item for item in state.get("jobs", {}).values() if int(item.get("index", -1)) == index), {})
        runtime_status, runtime_detail = job_install_status(job)
        a, b, c, d = st.columns([0.25, 0.25, 0.25, 0.25])
        if argv:
            a.code(" ".join(str(value) for value in argv), language="bash")
            if b.button("Run selected job", type="primary", disabled=runtime_status != "Ready", use_container_width=True):
                live = st.empty()
                result = execute_job(workspace, index, timeout_seconds=int(timeout), on_output=lambda value: live.code(value[-30000:], language="text"))
                if result.return_code == 0 and not result.timed_out and not result.error:
                    st.success("Job completed. Output was captured and candidates were staged automatically.")
                else:
                    st.warning(f"Job ended with return code {result.return_code}; exact output was retained.")
                st.rerun()
            if c.button("Retry selected", disabled=runtime_status != "Ready", use_container_width=True):
                mark_job_status(workspace, index, "pending", "Queued for retry by operator.")
                st.rerun()
            if d.button("Skip selected", use_container_width=True):
                mark_job_status(workspace, index, "skipped", "Skipped by operator.")
                st.rerun()
            if runtime_status == "Missing":
                st.warning(runtime_detail)
        else:
            a.info("Manual authorized step")
            b.caption(runtime_detail)
            if c.button("Mark manual job complete", use_container_width=True):
                mark_job_status(workspace, index, "manual_complete", "Completed manually by the operator.")
                st.rerun()
            if d.button("Skip manual step", use_container_width=True):
                mark_job_status(workspace, index, "skipped", "Skipped by operator.")
                st.rerun()

        output = read_job_output(workspace, index)
        if output:
            with st.expander("Exact saved output", expanded=True):
                st.code(output[-50000:], language="text")
                st.download_button("Download raw output", data=output.encode("utf-8"), file_name=f"{job.get('tool')}-{job.get('target')}.txt", mime="text/plain")
            candidates = extract_candidate_records(output, job)
            if candidates:
                urls = [item["url"] for item in candidates]
                selected_urls = st.multiselect(
                    "Candidate URLs",
                    urls,
                    default=urls[: min(len(urls), 50)],
                    key=f"divedeep_stage_urls_{bundle['manifest'].get('customerId')}_{index}",
                )
                if st.button("Stage selected candidates again", disabled=not selected_urls, use_container_width=True):
                    staged = stage_job_candidates(workspace, index, selected_urls)
                    st.success(f"Recorded {staged.get('recorded', 0)} and updated {staged.get('updated', 0)} candidate(s).")
                    st.rerun()
        elif state_item.get("status") in {"completed", "reviewed"}:
            st.info("The job is complete but no raw output file is available.")

    with captured_tab:
        observables = bundle.get("observables", {}).get("items", []) or []
        if not observables:
            st.info("Captured emails, URLs, domains, usernames, IPs and other normalized values will appear here after jobs run.")
        else:
            frame = pd.DataFrame([
                {
                    "Type": item.get("type", ""),
                    "Value": item.get("value", ""),
                    "Tool": item.get("tool", ""),
                    "Target": item.get("target", ""),
                    "Confidence": item.get("confidence", 0),
                    "Captured": item.get("capturedAt", ""),
                }
                for item in observables
            ])
            types = sorted(frame["Type"].dropna().unique().tolist()) if not frame.empty else []
            selected_types = st.multiselect("Observable types", types, default=types)
            if selected_types:
                frame = frame[frame["Type"].isin(selected_types)]
            st.dataframe(frame, hide_index=True, width="stretch")
            st.download_button("Download captured-data.json", data=_safe_json_download(bundle.get("observables", {})), file_name="captured-data.json", mime="application/json", use_container_width=True)

def _identifier_options(intake: dict[str, Any]) -> list[str]:
    values: list[str] = []
    profile = intake.get("divedeep", {}).get("profile", {})
    for item in profile.get("identifiers", []) or []:
        value = str(item.get("value") or "").strip()
        if value and value not in values:
            values.append(value)
    for item in intake.get("connections", []) or []:
        value = str(item.get("username") or item.get("profileUrl") or "").strip()
        if value and value not in values:
            values.append(value)
    return values


def _finding_label(item: dict[str, Any]) -> str:
    return f"{item.get('sourceName', 'Unknown')} · {item.get('status', 'review')} · {urlparse(str(item.get('listingUrl') or '')).hostname or ''}"


def _render_finding_form(bundle: dict[str, Any]) -> None:
    workspace = bundle["workspace"]
    intake = bundle["intake"]
    findings = bundle["results"].get("findings", []) or []
    options = ["__new__"] + [str(item.get("findingKey")) for item in findings if item.get("findingKey")]
    by_key = {str(item.get("findingKey")): item for item in findings if item.get("findingKey")}
    selected_key = st.selectbox(
        "Create or update finding",
        options,
        format_func=lambda value: "New finding" if value == "__new__" else _finding_label(by_key[value]),
        key=f"divedeep_finding_select_{bundle['manifest'].get('customerId')}",
    )
    existing = by_key.get(selected_key, {})
    existing_removal = existing.get("removal", {}) if isinstance(existing.get("removal"), dict) else {}
    existing_verification = existing.get("verification", {}) if isinstance(existing.get("verification"), dict) else {}
    identifiers = _identifier_options(intake)
    statuses = ["review", "confirmed", "preserved", "ignored", "false_positive", "removed", "reappeared", "still_present"]
    categories = ["social-profile", "people-search", "directory", "public-record", "image-match", "adult", "sensitive", "standard"]
    request_statuses = ["draft", "sent", "acknowledged", "completed", "needs_action", "failed"]
    verification_results = ["none", "removed", "still_present", "changed", "unreachable", "needs_review"]

    with st.form(f"divedeep_finding_form_{bundle['manifest'].get('customerId')}_{selected_key}", clear_on_submit=False):
        a, b = st.columns(2)
        source_name = a.text_input("Source name", value=str(existing.get("sourceName") or ""))
        listing_url = b.text_input("Public listing URL", value=str(existing.get("listingUrl") or ""))
        c, d, e = st.columns([0.34, 0.33, 0.33])
        confidence = c.slider("Match confidence", 0.0, 1.0, float(existing.get("matchConfidence") or 0.75), 0.01)
        category_default = str(existing.get("contentCategory") or "social-profile")
        content_category = d.selectbox("Content category", categories, index=categories.index(category_default) if category_default in categories else 0)
        status_default = str(existing.get("status") or "review")
        status = e.selectbox("Finding status", statuses, index=statuses.index(status_default) if status_default in statuses else 0)
        subject_default = str(existing.get("subjectIdentifier") or "")
        subject_identifier = st.selectbox(
            "Matched authorized identifier",
            [""] + identifiers,
            index=([""] + identifiers).index(subject_default) if subject_default in identifiers else 0,
        )
        notes = st.text_area("Review notes", value=str(existing.get("notes") or ""), height=110)
        uploads = st.file_uploader(
            "Attach screenshots, page saves, or supporting files",
            accept_multiple_files=True,
            key=f"divedeep_evidence_upload_{bundle['manifest'].get('customerId')}_{selected_key}",
        )
        evidence_notes = st.text_input("New evidence note", value="Public-source evidence reviewed by the operator.")

        st.markdown("#### Removal case")
        create_case = st.checkbox("Create or maintain a removal case", value=bool(existing_removal.get("createCase")))
        r1, r2 = st.columns(2)
        recipient_email = r1.text_input("Privacy recipient email", value=str(existing_removal.get("recipientEmail") or ""))
        privacy_form_url = r2.text_input("Privacy form URL", value=str(existing_removal.get("privacyFormUrl") or ""))
        r3, r4, r5 = st.columns(3)
        template_keys = list(TEMPLATE_BY_KEY)
        template_default = str(existing_removal.get("templateKey") or "data-broker-deletion")
        template_key = r3.selectbox("Request template", template_keys, index=template_keys.index(template_default) if template_default in template_keys else 0)
        delivery_method = r4.selectbox("Delivery method", ["email", "web_form", "manual"], index=["email", "web_form", "manual"].index(str(existing_removal.get("deliveryMethod") or "email")) if str(existing_removal.get("deliveryMethod") or "email") in ["email", "web_form", "manual"] else 0)
        request_default = str(existing_removal.get("status") or "draft")
        request_status = r5.selectbox("Request status", request_statuses, index=request_statuses.index(request_default) if request_default in request_statuses else 0)
        request_actions = st.text_area(
            "Requested action",
            value=str(existing_removal.get("requestActions") or "Remove or suppress the identified personal information and prevent republication where supported."),
            height=80,
        )
        confirmation_reference = st.text_input("Confirmation/reference", value=str(existing_removal.get("confirmationReference") or ""))

        st.markdown("#### Verification")
        verification_default = str(existing_verification.get("result") or "none")
        v1, v2 = st.columns([0.32, 0.68])
        verification_result = v1.selectbox("Verification result", verification_results, index=verification_results.index(verification_default) if verification_default in verification_results else 0)
        verification_notes = v2.text_input("Verification note", value=str(existing_verification.get("notes") or ""))

        submitted = st.form_submit_button("Save reviewed finding", type="primary", use_container_width=True)

    if submitted:
        evidence = list(existing.get("evidence", []) or [])
        for upload in uploads or []:
            stored = store_evidence_upload(workspace, upload.name, upload.getvalue())
            evidence.append(
                {
                    "type": "screenshot" if str(upload.type).startswith("image/") else "document",
                    "path": str(stored.relative_to(workspace)),
                    "notes": evidence_notes,
                    "mediaType": upload.type or "application/octet-stream",
                }
            )
        payload: dict[str, Any] = {
            "sourceName": source_name,
            "listingUrl": listing_url,
            "subjectIdentifier": subject_identifier,
            "matchConfidence": confidence,
            "contentCategory": content_category,
            "status": status,
            "notes": notes,
            "evidence": evidence,
        }
        if selected_key != "__new__":
            payload["findingKey"] = selected_key
        if create_case:
            payload["removal"] = {
                "createCase": True,
                "recipientEmail": recipient_email,
                "privacyFormUrl": privacy_form_url,
                "deliveryMethod": delivery_method,
                "templateKey": template_key,
                "requestActions": request_actions,
                "status": request_status,
                "confirmationReference": confirmation_reference,
            }
        if verification_result != "none":
            payload["verification"] = {
                "result": verification_result,
                "sourceUrl": listing_url,
                "notes": verification_notes,
            }
        try:
            result = record_payload(workspace, payload)
            st.success(f"Saved. Total reviewed findings: {result.get('total', 0)}.")
            st.rerun()
        except Exception as exc:
            st.error(f"Could not save finding: {exc}")


def _render_findings(bundle: dict[str, Any]) -> None:
    findings = bundle["results"].get("findings", []) or []
    st.subheader("Findings and evidence")
    if findings:
        rows = [
            {
                "Source": item.get("sourceName", ""),
                "Status": item.get("status", ""),
                "Confidence": item.get("matchConfidence", 0),
                "Category": item.get("contentCategory", ""),
                "URL": item.get("listingUrl", ""),
                "Evidence": len(item.get("evidence", []) or []),
                "Request": item.get("removal", {}).get("status", "") if isinstance(item.get("removal"), dict) else "",
                "Verification": item.get("verification", {}).get("result", "") if isinstance(item.get("verification"), dict) else "",
            }
            for item in findings
        ]
        st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
    else:
        st.info("No findings recorded yet. Run a tool job or add a reviewed finding below.")
    _render_finding_form(bundle)


def _render_export(bundle: dict[str, Any]) -> None:
    workspace = bundle["workspace"]
    findings = bundle["results"].get("findings", []) or []
    unresolved = [item for item in findings if item.get("status") == "review"]
    st.subheader("Return results to DiveDeep")
    st.caption("The result packet contains normalized evidence references, removal states, and verification outcomes. Evidence binaries remain local.")
    if unresolved:
        st.warning(f"{len(unresolved)} finding(s) still require review. They may be exported, but the customer-facing system should not treat them as confirmed.")
    notes = st.text_area(
        "Operator handoff note",
        value=str(bundle["operatorState"].get("operatorNotes") or ""),
        key=f"divedeep_operator_notes_{bundle['manifest'].get('customerId')}",
    )
    c1, c2, c3 = st.columns(3)
    if c1.button("Save handoff note", use_container_width=True):
        set_operator_status(workspace, bundle["operatorState"].get("status", "results_ready"), notes)
        st.success("Operator note saved.")
    if c2.button("Open local privacy case", use_container_width=True):
        request_workspace("Privacy Removal")
        st.rerun()
    if c3.button("Open DiveDeep case", use_container_width=True):
        request_workspace("Cases")
        st.rerun()

    if st.button("Generate DiveDeep result packet", type="primary", use_container_width=True):
        exported = export_workspace_results(workspace)
        st.session_state["divedeep_last_export"] = exported
        st.success(f"Generated packet with {len(exported['packet'].get('findings', []))} finding(s).")

    exported = st.session_state.get("divedeep_last_export")
    if exported and exported.get("packet", {}).get("source", {}).get("customerId") == bundle["manifest"].get("customerId"):
        packet = exported["packet"]
        st.download_button(
            "Download divedeep-results.json",
            data=_safe_json_download(packet),
            file_name="divedeep-results.json",
            mime="application/json",
            type="primary",
            use_container_width=True,
        )
        with st.expander("Result packet preview"):
            st.json(packet)
    else:
        output_path = workspace / "out" / "divedeep-results.json"
        if output_path.is_file():
            st.download_button(
                "Download existing result packet",
                data=output_path.read_bytes(),
                file_name="divedeep-results.json",
                mime="application/json",
                use_container_width=True,
            )


def render_divedeep_operations() -> None:
    _apply_pending_divedeep_state()
    st.markdown(
        """
        <style>
        .fid-workspace-badge {
            border:1px solid rgba(39,199,255,.28);
            background:linear-gradient(135deg,rgba(22,136,255,.12),rgba(39,199,255,.05));
            border-radius:14px;padding:12px 14px;text-align:right;
        }
        .fid-workspace-badge span {opacity:.72;font-size:.82rem;text-transform:capitalize;}
        </style>
        """,
        unsafe_allow_html=True,
    )
    workspace = _active_workspace_selector()
    bundle = load_workspace_bundle(workspace) if workspace else None
    _render_header(bundle)
    if bundle:
        _metric_row(bundle)
    stage = stage_picker("DiveDeep workflow stage", STAGES, key="divedeep_workflow_stage", default="Intake")
    st.divider()
    if stage == "Intake":
        _render_intake(bundle)
    elif bundle is None:
        st.info("Import a DiveDeep customer packet before continuing.")
    elif stage == "Targets":
        _render_targets(bundle)
    elif stage == "Tool Runbook":
        _render_runbook(bundle)
    elif stage == "Findings & Evidence":
        _render_findings(bundle)
    else:
        _render_export(bundle)
