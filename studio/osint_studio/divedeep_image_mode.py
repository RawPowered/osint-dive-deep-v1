from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd
import streamlit as st

from .divedeep_image_recon import (
    IMAGE_PROVIDERS,
    add_image_candidate,
    import_image_bundle,
    inspect_image_bundle,
    list_image_sessions,
    load_image_session,
    promote_candidate,
    session_file_bytes,
    update_candidate_review,
    update_provider_run,
)
from .divedeep_segmented_export import (
    create_segmented_result_bundle,
    list_segmented_result_exports,
    segmented_result_bundle_bytes,
)
from .ui_shell import request_workspace

_PENDING_SESSION_KEY = "_divedeep_image_pending_session"
_ACTIVE_SESSION_KEY = "divedeep_image_active_session"


def _apply_pending_state() -> None:
    if _PENDING_SESSION_KEY in st.session_state:
        st.session_state[_ACTIVE_SESSION_KEY] = st.session_state.pop(_PENDING_SESSION_KEY)


def _format_bytes(value: int | float) -> str:
    size = float(value or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} GB"


def _session_label(item: dict[str, Any]) -> str:
    return f"{item.get('displayName') or item.get('customerId')} · {item.get('imageCount', 0)} images · {item.get('importedAt', '')[:10]}"


def _reference_by_id(bundle: dict[str, Any], photo_id: str) -> dict[str, Any] | None:
    for item in bundle["record"].get("images", []) or []:
        if str(item.get("photoId") or "") == str(photo_id or ""):
            return item
    return None


def _candidate_by_id(bundle: dict[str, Any], candidate_id: str) -> dict[str, Any] | None:
    for item in bundle["candidates"].get("candidates", []) or []:
        if str(item.get("candidateId") or "") == str(candidate_id or ""):
            return item
    return None


def _image_file(session: Path, relative_path: str) -> Path | None:
    if not relative_path:
        return None
    path = (session / relative_path).resolve()
    if path != session and not path.is_relative_to(session):
        return None
    return path if path.is_file() else None


def _render_import() -> None:
    st.subheader("Import an Image Recon bundle")
    st.caption(
        "Download the authorized Image Recon Bundle from DiveDeep Admin, then import it here. "
        "The standard customer JSON packet must already exist in DiveDeep."
    )
    uploaded = st.file_uploader(
        "DiveDeep Image Recon ZIP",
        type=["zip"],
        key="divedeep_image_bundle_upload",
        help="DiveDeep validates the manifest, file paths, image signatures, size limits, and SHA-256 values before extraction.",
    )
    if uploaded is None:
        return
    try:
        preview = inspect_image_bundle(uploaded.getvalue())
        manifest = preview["manifest"]
        customer = manifest.get("customer") or {}
        cols = st.columns(4)
        cols[0].metric("Customer", customer.get("displayName") or str(manifest.get("customerId", ""))[:12])
        cols[1].metric("Plan", customer.get("planTier") or "—")
        cols[2].metric("Images", preview["imageCount"])
        cols[3].metric("Expanded size", _format_bytes(preview["expandedBytes"]))
        st.dataframe(
            pd.DataFrame(
                [
                    {
                        "Label": item["label"],
                        "Type": item["mimeType"],
                        "Size": _format_bytes(item["byteSize"]),
                        "Photo ID": item["photoId"],
                        "SHA-256": item["sha256"][:16] + "…",
                    }
                    for item in preview["images"]
                ]
            ),
            hide_index=True,
            use_container_width=True,
        )
        if st.button("Import and prepare images", type="primary", use_container_width=True):
            imported = import_image_bundle(uploaded.name, uploaded.getvalue())
            st.session_state[_PENDING_SESSION_KEY] = imported["session"]
            st.success(f"Prepared {imported['imageCount']} authorized reference images.")
            st.rerun()
    except Exception as exc:
        st.error(str(exc))


def _render_summary(bundle: dict[str, Any]) -> None:
    record = bundle["record"]
    jobs = bundle["queue"].get("jobs", []) or []
    candidates = bundle["candidates"].get("candidates", []) or []
    provider_complete = sum(
        1
        for job in jobs
        for provider in job.get("providers", []) or []
        if provider.get("status") == "completed"
    )
    reviewed = sum(1 for item in candidates if item.get("decision") not in {"", "pending_review"})
    confirmed = sum(1 for item in candidates if item.get("decision") == "confirmed_match")
    promoted = sum(1 for item in candidates if item.get("promotedAt"))
    cols = st.columns(6)
    cols[0].metric("Reference images", int(record.get("imageCount") or 0))
    cols[1].metric("Provider searches", provider_complete)
    cols[2].metric("Candidates", len(candidates))
    cols[3].metric("Reviewed", reviewed)
    cols[4].metric("Confirmed", confirmed)
    cols[5].metric("Promoted", promoted)


def _render_intake(bundle: dict[str, Any]) -> None:
    record = bundle["record"]
    st.subheader("Image Recon intake")
    left, right = st.columns([0.58, 0.42])
    with left:
        st.write(f"**Customer:** {record.get('displayName') or record.get('customerId')}")
        st.write(f"**Customer ID:** `{record.get('customerId', '')}`")
        st.write(f"**Protected profile:** `{record.get('profileId', '')}`")
        st.write(f"**Plan:** {record.get('planTier') or '—'}")
    with right:
        st.write(f"**Imported:** {record.get('importedAt', '')}")
        st.write(f"**Source archive:** {record.get('sourceFile', '')}")
        st.write(f"**Bundle SHA-256:** `{str(record.get('sourceSha256') or '')[:24]}…`")
        st.write(f"**Private session:** `{record.get('sessionId', '')}`")
    st.info(
        "Originals remain unchanged. Provider uploads use EXIF-stripped derivatives. Candidate images and page screenshots stay local until an operator explicitly promotes a reviewed result."
    )


def _render_gallery(bundle: dict[str, Any]) -> None:
    record = bundle["record"]
    session: Path = bundle["session"]
    images = record.get("images", []) or []
    st.subheader("Authorized reference gallery")
    st.caption("Use the normalized derivative for provider searches. Keep the original as the source-of-truth reference artifact.")
    for offset in range(0, len(images), 3):
        columns = st.columns(3)
        for column, item in zip(columns, images[offset : offset + 3]):
            with column:
                thumb = _image_file(session, str(item.get("thumbnailPath") or ""))
                if thumb:
                    st.image(str(thumb), use_container_width=True)
                st.markdown(f"**{item.get('label') or 'Reference photo'}**")
                st.caption(f"{item.get('width')} × {item.get('height')} · {_format_bytes(item.get('byteSize') or 0)}")
                st.code(
                    f"SHA-256  {item.get('originalSha256', '')}\ndHash    {item.get('differenceHash', '')}\naHash    {item.get('averageHash', '')}",
                    language=None,
                )
                normalized_path = str(item.get("normalizedPath") or "")
                original_path = str(item.get("originalPath") or "")
                if normalized_path:
                    st.download_button(
                        "Download search derivative",
                        data=session_file_bytes(session, normalized_path),
                        file_name=f"{item.get('photoId')}-search.jpg",
                        mime="image/jpeg",
                        key=f"fid_image_norm_{record.get('sessionId')}_{item.get('photoId')}",
                        use_container_width=True,
                    )
                if original_path:
                    st.download_button(
                        "Download original",
                        data=session_file_bytes(session, original_path),
                        file_name=Path(original_path).name,
                        mime=item.get("mimeType") or "application/octet-stream",
                        key=f"fid_image_original_{record.get('sessionId')}_{item.get('photoId')}",
                        use_container_width=True,
                    )


def _render_search_queue(bundle: dict[str, Any]) -> None:
    jobs = bundle["queue"].get("jobs", []) or []
    session: Path = bundle["session"]
    st.subheader("Provider search queue")
    st.caption(
        "Run each provider deliberately. Download the EXIF-stripped derivative, open the provider, upload the image, and capture only relevant candidate pages."
    )
    if not jobs:
        st.info("No reference images are queued.")
        return
    by_photo = {str(job.get("photoId")): job for job in jobs}
    photo_id = st.selectbox(
        "Reference image",
        list(by_photo),
        format_func=lambda value: str(by_photo[value].get("label") or value),
        key=f"fid_image_queue_photo_{bundle['record'].get('sessionId')}",
    )
    job = by_photo[photo_id]
    reference = _reference_by_id(bundle, photo_id)
    if reference:
        left, right = st.columns([0.28, 0.72])
        with left:
            thumb = _image_file(session, str(reference.get("thumbnailPath") or ""))
            if thumb:
                st.image(str(thumb), use_container_width=True)
            st.download_button(
                "Download provider image",
                data=session_file_bytes(session, str(reference.get("normalizedPath") or "")),
                file_name=f"{photo_id}-search.jpg",
                mime="image/jpeg",
                use_container_width=True,
                key=f"fid_provider_download_{bundle['record'].get('sessionId')}_{photo_id}",
            )
        with right:
            rows = [
                {
                    "Provider": item.get("label"),
                    "Status": str(item.get("status") or "pending").replace("_", " ").title(),
                    "Candidates": int(item.get("candidateCount") or 0),
                    "Started": item.get("startedAt") or "",
                    "Completed": item.get("completedAt") or "",
                    "Notes": item.get("notes") or "",
                }
                for item in job.get("providers", []) or []
            ]
            st.dataframe(pd.DataFrame(rows), hide_index=True, use_container_width=True)

    st.markdown("#### Provider controls")
    for provider_state in job.get("providers", []) or []:
        provider_key = str(provider_state.get("providerKey") or "")
        provider = IMAGE_PROVIDERS.get(provider_key, {})
        with st.expander(f"{provider_state.get('label')} · {str(provider_state.get('status') or 'pending').replace('_', ' ').title()}"):
            st.caption(provider.get("instructions") or "")
            if provider.get("url"):
                st.link_button("Open provider", provider["url"], use_container_width=True)
            notes = st.text_input(
                "Provider note",
                value=str(provider_state.get("notes") or ""),
                key=f"fid_provider_notes_{bundle['record'].get('sessionId')}_{photo_id}_{provider_key}",
            )
            c1, c2, c3, c4 = st.columns(4)
            actions = [
                (c1, "Start", "in_progress"),
                (c2, "Complete", "completed"),
                (c3, "Blocked", "blocked"),
                (c4, "Skip", "skipped"),
            ]
            for column, label, status in actions:
                if column.button(
                    label,
                    key=f"fid_provider_{status}_{bundle['record'].get('sessionId')}_{photo_id}_{provider_key}",
                    use_container_width=True,
                ):
                    try:
                        update_provider_run(session, photo_id, provider_key, status, notes)
                        st.rerun()
                    except Exception as exc:
                        st.error(str(exc))
    st.info("Use Candidate Capture after a provider returns a potentially relevant public image or page.")


def _render_candidate_capture(bundle: dict[str, Any]) -> None:
    session: Path = bundle["session"]
    images = bundle["record"].get("images", []) or []
    st.subheader("Capture a candidate")
    st.caption(
        "Store the public source URL and the matching image itself. A page screenshot is optional but strongly recommended before removal work begins."
    )
    if not images:
        st.info("No authorized reference images are available.")
        return
    image_map = {str(item.get("photoId")): item for item in images}
    provider_keys = list(IMAGE_PROVIDERS)
    with st.form(f"fid_candidate_capture_{bundle['record'].get('sessionId')}", clear_on_submit=True):
        a, b = st.columns(2)
        photo_id = a.selectbox("Reference image", list(image_map), format_func=lambda value: str(image_map[value].get("label") or value))
        provider_key = b.selectbox("Discovery source", provider_keys, format_func=lambda value: IMAGE_PROVIDERS[value]["label"])
        source_url = st.text_input("Public source page URL", placeholder="https://example.com/public-profile-or-page")
        c, d = st.columns(2)
        source_name = c.text_input("Source name", placeholder="Optional; domain is used automatically")
        content_category = d.selectbox("Content category", ["image-match", "social-profile", "directory", "adult", "sensitive", "standard"])
        candidate_upload = st.file_uploader(
            "Downloaded candidate image",
            type=["jpg", "jpeg", "png", "webp"],
            help="Required. Upload the actual matching image, not the authorized reference image.",
        )
        page_upload = st.file_uploader(
            "Public page screenshot",
            type=["jpg", "jpeg", "png", "webp"],
            help="Optional. Capture the page context, username, profile name, and source URL where possible.",
        )
        e, f, g = st.columns(3)
        associated_name = e.text_input("Name shown")
        associated_username = f.text_input("Username shown")
        associated_location = g.text_input("Location/context shown")
        notes = st.text_area("Capture notes", height=90)
        submitted = st.form_submit_button("Add candidate to review queue", type="primary", use_container_width=True)
    if submitted:
        if candidate_upload is None:
            st.error("Upload the candidate image before adding this review item.")
            return
        try:
            candidate = add_image_candidate(
                session,
                photo_id=photo_id,
                provider_key=provider_key,
                source_url=source_url,
                candidate_filename=candidate_upload.name,
                candidate_data=candidate_upload.getvalue(),
                page_screenshot_filename=page_upload.name if page_upload else "",
                page_screenshot_data=page_upload.getvalue() if page_upload else None,
                source_name=source_name,
                content_category=content_category,
                associated_name=associated_name,
                associated_username=associated_username,
                associated_location=associated_location,
                notes=notes,
            )
            if candidate.get("duplicateOf"):
                st.warning("Candidate captured, but the image is an exact duplicate of an existing review item.")
            else:
                st.success("Candidate captured and queued for side-by-side review.")
            st.rerun()
        except Exception as exc:
            st.error(str(exc))


def _candidate_label(item: dict[str, Any]) -> str:
    return f"{item.get('sourceName') or item.get('providerLabel')} · {str(item.get('decision') or 'pending_review').replace('_', ' ')} · {str(item.get('candidateId') or '')[:8]}"


def _render_candidate_review(bundle: dict[str, Any]) -> None:
    session: Path = bundle["session"]
    candidates = bundle["candidates"].get("candidates", []) or []
    st.subheader("Candidate review")
    st.caption("Compare the authorized reference against the captured public candidate. Local hashes indicate near-duplicates only; they do not prove identity.")
    if not candidates:
        st.info("No candidate images have been captured yet.")
        return
    candidate_ids = [str(item.get("candidateId")) for item in candidates]
    selected_id = st.selectbox(
        "Candidate",
        candidate_ids,
        format_func=lambda value: _candidate_label(_candidate_by_id(bundle, value) or {}),
        key=f"fid_candidate_review_select_{bundle['record'].get('sessionId')}",
    )
    candidate = _candidate_by_id(bundle, selected_id)
    if not candidate:
        return
    reference = _reference_by_id(bundle, str(candidate.get("photoId") or ""))
    left, right = st.columns(2)
    with left:
        st.markdown("#### Authorized reference")
        if reference:
            ref_path = _image_file(session, str(reference.get("thumbnailPath") or ""))
            if ref_path:
                st.image(str(ref_path), use_container_width=True)
            st.caption(f"{reference.get('label')} · {reference.get('width')} × {reference.get('height')}")
    with right:
        st.markdown("#### Public candidate")
        candidate_path = _image_file(session, str(candidate.get("candidateThumbnailPath") or candidate.get("candidatePath") or ""))
        if candidate_path:
            st.image(str(candidate_path), use_container_width=True)
        st.caption(f"{candidate.get('sourceName')} · {candidate.get('candidateWidth')} × {candidate.get('candidateHeight')}")
    metrics = st.columns(4)
    metrics[0].metric("Local near-duplicate", f"{float(candidate.get('localNearDuplicateSimilarity') or 0):.0%}")
    metrics[1].metric("aHash distance", candidate.get("averageHashDistance") if candidate.get("averageHashDistance") is not None else "—")
    metrics[2].metric("dHash distance", candidate.get("differenceHashDistance") if candidate.get("differenceHashDistance") is not None else "—")
    metrics[3].metric("Duplicate", "Yes" if candidate.get("duplicateOf") else "No")
    st.markdown(f"**Public source:** {candidate.get('sourceUrl')}")
    if candidate.get("pageScreenshot"):
        with st.expander("View captured page screenshot"):
            screenshot = _image_file(session, str(candidate["pageScreenshot"].get("path") or ""))
            if screenshot:
                st.image(str(screenshot), use_container_width=True)

    decision_values = ["pending_review", "confirmed_match", "not_this_person", "inconclusive", "preserve", "duplicate"]
    signal_values = ["none", "weak", "strong"]
    existing_signals = candidate.get("signals") if isinstance(candidate.get("signals"), dict) else {}
    with st.form(f"fid_candidate_review_form_{selected_id}"):
        c1, c2, c3 = st.columns(3)
        operator_confidence = c1.slider("Operator confidence", 0.0, 1.0, float(candidate.get("operatorConfidence") or 0.0), 0.01)
        visual_similarity = c2.slider("Visual similarity", 0.0, 1.0, float(candidate.get("visualSimilarity") or 0.0), 0.01)
        decision_default = str(candidate.get("decision") or "pending_review")
        decision = c3.selectbox("Verdict", decision_values, index=decision_values.index(decision_default) if decision_default in decision_values else 0, format_func=lambda value: value.replace("_", " ").title())
        s1, s2, s3, s4 = st.columns(4)
        name_signal = s1.selectbox("Name corroboration", signal_values, index=signal_values.index(str(existing_signals.get("name") or "none")))
        username_signal = s2.selectbox("Username corroboration", signal_values, index=signal_values.index(str(existing_signals.get("username") or "none")))
        location_signal = s3.selectbox("Location corroboration", signal_values, index=signal_values.index(str(existing_signals.get("location") or "none")))
        context_signal = s4.selectbox("Context corroboration", signal_values, index=signal_values.index(str(existing_signals.get("context") or "none")))
        i1, i2, i3 = st.columns(3)
        associated_name = i1.text_input("Name shown", value=str(candidate.get("associatedName") or ""))
        associated_username = i2.text_input("Username shown", value=str(candidate.get("associatedUsername") or ""))
        associated_location = i3.text_input("Location/context shown", value=str(candidate.get("associatedLocation") or ""))
        review_notes = st.text_area("Operator review notes", value=str(candidate.get("reviewNotes") or candidate.get("notes") or ""), height=120)
        saved = st.form_submit_button("Save candidate verdict", type="primary", use_container_width=True)
    if saved:
        try:
            update_candidate_review(
                session,
                selected_id,
                decision=decision,
                operator_confidence=operator_confidence,
                visual_similarity=visual_similarity,
                signals={"name": name_signal, "username": username_signal, "location": location_signal, "context": context_signal},
                associated_name=associated_name,
                associated_username=associated_username,
                associated_location=associated_location,
                review_notes=review_notes,
            )
            st.success("Candidate verdict saved.")
            st.rerun()
        except Exception as exc:
            st.error(str(exc))


def _render_confirmed_evidence(bundle: dict[str, Any]) -> None:
    candidates = bundle["candidates"].get("candidates", []) or []
    eligible = [item for item in candidates if item.get("decision") in {"confirmed_match", "preserve", "inconclusive"}]
    rejected = [item for item in candidates if item.get("decision") in {"not_this_person", "duplicate"}]
    pending = [item for item in candidates if item.get("decision") == "pending_review"]
    st.subheader("Reviewed evidence promotion")
    st.caption("Only reviewed candidates can enter the standard DiveDeep evidence feed. False positives and duplicates remain local and are never exported.")
    metrics = st.columns(4)
    metrics[0].metric("Eligible", len(eligible))
    metrics[1].metric("Already promoted", sum(1 for item in eligible if item.get("promotedAt")))
    metrics[2].metric("Rejected locally", len(rejected))
    metrics[3].metric("Pending review", len(pending))
    if not eligible:
        st.info("Confirm, preserve, or intentionally mark a candidate inconclusive before promoting it.")
        return
    rows = [
        {
            "Source": item.get("sourceName"),
            "Verdict": str(item.get("decision") or "").replace("_", " ").title(),
            "Confidence": float(item.get("operatorConfidence") or 0),
            "URL": item.get("sourceUrl"),
            "Promoted": "Yes" if item.get("promotedAt") else "No",
            "Finding key": item.get("findingKey") or "",
        }
        for item in eligible
    ]
    st.dataframe(pd.DataFrame(rows), hide_index=True, use_container_width=True)
    by_id = {str(item.get("candidateId")): item for item in eligible}
    candidate_id = st.selectbox(
        "Evidence candidate",
        list(by_id),
        format_func=lambda value: _candidate_label(by_id[value]),
        key=f"fid_candidate_promote_{bundle['record'].get('sessionId')}",
    )
    selected = by_id[candidate_id]
    publish_inconclusive = False
    if selected.get("decision") == "inconclusive":
        publish_inconclusive = st.checkbox(
            "Publish this inconclusive candidate for customer review",
            help="This creates a Review finding, not a confirmed exposure or removal case.",
        )
    if st.button("Promote to DiveDeep evidence feed", type="primary", use_container_width=True):
        try:
            promoted = promote_candidate(bundle["session"], candidate_id, publish_inconclusive=publish_inconclusive)
            st.success(f"Promoted as finding `{promoted['findingKey']}`. It is now available in the standard DiveDeep Workflow export.")
            st.rerun()
        except Exception as exc:
            st.error(str(exc))
    if st.button("Open standard DiveDeep Workflow", use_container_width=True):
        request_workspace("DiveDeep Workflow")
        st.rerun()



def _render_segmented_export(bundle: dict[str, Any]) -> None:
    session: Path = bundle["session"]
    candidates = bundle["candidates"].get("candidates", []) or []
    promoted = [item for item in candidates if item.get("promotedAt") and item.get("findingKey")]
    st.subheader("Segmented result export")
    st.caption(
        "Build a local transport ZIP containing small ordered JSON packets, a SHA-256 manifest, "
        "and separate evidence files. Images are never embedded in JSON."
    )
    metrics = st.columns(4)
    metrics[0].metric("Promoted image findings", len(promoted))
    metrics[1].metric("Default JSON target", "512 KB")
    metrics[2].metric("Hard JSON limit", "1 MB")
    metrics[3].metric("Evidence delivery", "Separate files")

    scope = st.radio(
        "Export scope",
        ["image_session", "workspace"],
        format_func=lambda value: "This Image Recon session" if value == "image_session" else "All reviewed workspace findings",
        horizontal=True,
        help="Image-session scope exports only candidates explicitly promoted from this session. Workspace scope also includes reviewed non-image findings.",
        key=f"fid_segmented_scope_{bundle['record'].get('sessionId')}",
    )
    size_profile = st.selectbox(
        "JSON segment size",
        ["conservative", "balanced", "large"],
        index=1,
        format_func=lambda value: {
            "conservative": "Conservative · target 256 KB / hard 512 KB",
            "balanced": "Balanced · target 512 KB / hard 1 MB",
            "large": "Large · target 768 KB / hard 1 MB",
        }[value],
        key=f"fid_segmented_size_{bundle['record'].get('sessionId')}",
    )
    sizes = {
        "conservative": (256 * 1024, 512 * 1024),
        "balanced": (512 * 1024, 1024 * 1024),
        "large": (768 * 1024, 1024 * 1024),
    }
    target_bytes, hard_bytes = sizes[size_profile]
    st.info(
        "The generated ZIP is ready for direct upload in DiveDeep Admin. The admin can also accept the extracted folder, "
        "verifies every declared hash and file size, and keeps all imported evidence private until publication."
    )
    if st.button("Build import-ready evidence package", type="primary", use_container_width=True):
        try:
            created = create_segmented_result_bundle(
                session,
                scope=scope,
                target_part_bytes=target_bytes,
                hard_part_bytes=hard_bytes,
            )
            st.success(
                f"Created {created['partCount']} JSON part(s) with {created['findingCount']} finding(s) "
                f"and {created['evidenceFileCount']} evidence file(s)."
            )
            st.rerun()
        except Exception as exc:
            st.error(str(exc))

    exports = list_segmented_result_exports(session)
    if not exports:
        st.warning("No segmented export has been generated for this session.")
        return
    st.markdown("#### Generated bundles")
    for record in exports[:10]:
        left, middle, right = st.columns([0.52, 0.28, 0.20])
        with left:
            st.markdown(f"**{record.get('zipFileName')}**")
            st.caption(
                f"{record.get('createdAt', '')} · scope {record.get('scope')} · "
                f"SHA-256 {str(record.get('zipSha256') or '')[:20]}…"
            )
        with middle:
            st.write(
                f"{record.get('findingCount', 0)} findings · {record.get('partCount', 0)} parts · "
                f"{record.get('evidenceFileCount', 0)} files"
            )
            st.caption(f"Bundle {_format_bytes(record.get('zipBytes') or 0)} · Evidence {_format_bytes(record.get('evidenceBytes') or 0)}")
        with right:
            st.download_button(
                "Download ZIP",
                data=segmented_result_bundle_bytes(record),
                file_name=str(record.get("zipFileName") or "divedeep-result-bundle.zip"),
                mime="application/zip",
                key=f"fid_segmented_download_{record.get('batchId')}",
                use_container_width=True,
            )
        with st.expander(f"Manifest summary · {str(record.get('batchId') or '')[:8]}"):
            manifest = record.get("manifest") or {}
            st.json(
                {
                    "batchId": manifest.get("batchId"),
                    "scope": manifest.get("scope"),
                    "findingCount": manifest.get("findingCount"),
                    "partCount": manifest.get("partCount"),
                    "evidenceFileCount": manifest.get("evidenceFileCount"),
                    "parts": manifest.get("parts"),
                    "evidence": manifest.get("evidence"),
                },
                expanded=False,
            )

def render_divedeep_image_recon() -> None:
    _apply_pending_state()
    st.title("DiveDeep Image Recon")
    st.caption("Authorized image intake → provider search → candidate comparison → reviewed evidence promotion")

    sessions = list_image_sessions()
    by_path = {str(item["session"]): item for item in sessions}
    active_path: str | None = None
    if sessions:
        paths = list(by_path)
        current = st.session_state.get(_ACTIVE_SESSION_KEY)
        if current not in by_path:
            st.session_state[_ACTIVE_SESSION_KEY] = paths[0]
            current = paths[0]
        active_path = st.selectbox(
            "Active Image Recon session",
            paths,
            index=paths.index(current),
            format_func=lambda value: _session_label(by_path[value]),
            key=_ACTIVE_SESSION_KEY,
        )

    bundle = load_image_session(active_path) if active_path else None
    if bundle:
        _render_summary(bundle)

    tabs = st.tabs([
        "Import",
        "Intake",
        "Reference Gallery",
        "Search Queue",
        "Candidate Capture",
        "Candidate Review",
        "Confirmed Evidence",
        "Export Bundle",
    ])
    renderers = [
        lambda: _render_import(),
        lambda: _render_intake(bundle) if bundle else st.info("Import a DiveDeep Image Recon Bundle to start a dedicated image session."),
        lambda: _render_gallery(bundle) if bundle else st.info("No image session is active."),
        lambda: _render_search_queue(bundle) if bundle else st.info("No image session is active."),
        lambda: _render_candidate_capture(bundle) if bundle else st.info("No image session is active."),
        lambda: _render_candidate_review(bundle) if bundle else st.info("No image session is active."),
        lambda: _render_confirmed_evidence(bundle) if bundle else st.info("No image session is active."),
        lambda: _render_segmented_export(bundle) if bundle else st.info("No image session is active."),
    ]
    for tab, renderer in zip(tabs, renderers):
        with tab:
            renderer()
