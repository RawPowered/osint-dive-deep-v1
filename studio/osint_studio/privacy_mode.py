from __future__ import annotations

import json
from datetime import date
from urllib.parse import urlparse

import pandas as pd
import streamlit as st

from .case_store import CaseStore
from .privacy_store import PrivacyStore, utc_now
from .privacy_templates import (
    CA_DROP_URL,
    CYBERTIPLINE_URL,
    LEGAL_BASIS_PRESETS,
    STOP_NCII_URL,
    TAKE_IT_DOWN_URL,
    TEMPLATE_BY_KEY,
    TEMPLATES,
    build_eml,
    mailto_url,
    render_template,
)
from .ui_shell import ACTIVE_CASE_KEY, case_context_header, remember_active_case, stage_picker


CASE_ROLES = {
    "The person named in the request": "self",
    "Authorized agent for the person": "authorized-agent",
}
FINDING_CATEGORIES = (
    "People search / directory",
    "Data broker",
    "Marketing list",
    "B2B lead data",
    "Account or social profile",
    "Search result / cache",
    "Adult platform",
    "Other listing",
)
CONTENT_CATEGORIES = {
    "Standard personal-data listing": "standard",
    "Adult-industry profile or listing": "adult-profile",
    "Adult non-consensual intimate content": "adult-ncii",
    "Sexual content depicting the subject while under 18": "minor-safety",
}
CONTACT_STATUSES = ("unverified", "site-published", "analyst-verified")
REQUEST_STATUSES = ("draft", "ready", "sent", "acknowledged", "completed", "denied", "needs-follow-up", "withdrawn")
VERIFICATION_RESULTS = ("not-checked", "still-listed", "removed", "changed", "blocked")
REQUEST_ACTIONS = (
    "Delete personal information",
    "Remove public profile/listing",
    "Opt out of sale or sharing",
    "Suppress future marketing",
    "Correct inaccurate information",
    "Provide access and source details",
    "Remove controlled snippets/caches",
    "Stop controlled distribution",
)


def _valid_public_url(value: str) -> bool:
    if not value.strip():
        return False
    parsed = urlparse(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc) and not parsed.username and not parsed.password


def _valid_email(value: str) -> bool:
    candidate = value.strip()
    return bool(candidate) and "\n" not in candidate and "\r" not in candidate and candidate.count("@") == 1


def _case_selector(store: PrivacyStore) -> dict[str, object] | None:
    cases = store.list_cases()
    if not cases:
        return None
    by_id = {str(item["privacy_case_id"]): item for item in cases}
    ids = list(by_id)
    current = st.session_state.get("privacy_active_case_id")
    active_studio_case = st.session_state.get(ACTIVE_CASE_KEY)
    linked = next((key for key, item in by_id.items() if item.get("studio_case_id") == active_studio_case), None)
    if linked:
        current = linked
    if current not in by_id:
        current = ids[0]
    selected = st.selectbox(
        "Active privacy case",
        ids,
        index=ids.index(current),
        format_func=lambda key: f"{by_id[key]['case_name']} · {by_id[key]['subject_name']}",
        key="privacy_case_selector",
    )
    st.session_state.privacy_active_case_id = selected
    if by_id[selected].get("studio_case_id"):
        st.session_state.research_case_id = str(by_id[selected]["studio_case_id"])
        remember_active_case(str(by_id[selected]["studio_case_id"]))
    return by_id[selected]


def _render_cases(store: PrivacyStore, case: dict[str, object] | None) -> None:
    st.subheader("Authorized privacy cases")
    st.caption("Use the minimum identity information required. Keep identity documents outside DiveDeep and provide them only through a verified company channel.")
    pending_core_case = bool(st.session_state.get("privacy_pending_studio_case_id"))
    with st.expander("Start a privacy-removal case", expanded=case is None or pending_core_case):
        with st.form("privacy_case_create"):
            pending_name = str(st.session_state.get("privacy_pending_case_name") or "")
            case_name = st.text_input("Case name", value=pending_name, placeholder="Jane Doe privacy cleanup")
            subject_name = st.text_input("Subject name")
            subject_email = st.text_input("Subject email or stable identifier (optional)")
            aliases = st.text_input("Aliases or stage names (comma-separated, optional)")
            left, right = st.columns(2)
            with left:
                country = st.text_input("Country / jurisdiction", value="United States")
                requester_role_label = st.selectbox("Requester relationship", tuple(CASE_ROLES))
                requester_name = st.text_input("Requester or authorized agent name")
            with right:
                region = st.text_input("State / region")
                requester_email = st.text_input("Reply email")
                verification_channel = st.text_input("Verification channel note", placeholder="Secure company form if requested")
            authorization_date = st.date_input("Authorization date", value=date.today())
            authorization = st.checkbox(
                "I confirm this request is for me or I have explicit authorization from the named person."
            )
            create = st.form_submit_button("Create privacy case", type="primary")
        if create:
            if not all((case_name.strip(), subject_name.strip(), requester_name.strip(), requester_email.strip())):
                st.error("Case name, subject name, requester name and reply email are required.")
            elif not authorization:
                st.error("Affirm authorization before creating the case.")
            else:
                core_store = CaseStore()
                studio_case_id = str(st.session_state.get("privacy_pending_studio_case_id") or "")
                if not studio_case_id or not core_store.get_case(studio_case_id):
                    studio_case_id = core_store.create_case(
                        case_name,
                        mode="privacy-removal",
                        objective="Authorized privacy removal and verification.",
                        metadata={"hunt_type": "Privacy removal", "created_from": "privacy-removal"},
                    )
                case_id = store.create_case(
                    {
                        "case_name": case_name,
                        "subject_name": subject_name,
                        "subject_email": subject_email,
                        "aliases": [part.strip() for part in aliases.split(",") if part.strip()],
                        "jurisdiction_country": country,
                        "jurisdiction_region": region,
                        "requester_role": CASE_ROLES[requester_role_label],
                        "requester_name": requester_name,
                        "requester_email": requester_email,
                        "authorization_affirmed": True,
                        "authorization_date": authorization_date.isoformat(),
                        "verification_channel": verification_channel,
                        "studio_case_id": studio_case_id,
                    }
                )
                st.session_state.privacy_active_case_id = case_id
                st.session_state.research_case_id = studio_case_id
                remember_active_case(studio_case_id)
                st.session_state.pop("privacy_pending_studio_case_id", None)
                st.session_state.pop("privacy_pending_case_name", None)
                st.success("Privacy case created.")
                st.rerun()

    if case:
        packet = store.case_packet(str(case["privacy_case_id"]))
        findings = packet["findings"]
        requests = packet["requests"]
        completed = sum(1 for item in requests if item["status"] == "completed")
        cols = st.columns(3)
        cols[0].metric("Findings", len(findings))
        cols[1].metric("Requests", len(requests))
        cols[2].metric("Completed", completed)
        st.download_button(
            "Download complete case packet",
            data=json.dumps(packet, indent=2, ensure_ascii=False),
            file_name=f"{case['privacy_case_id']}-privacy-case.json",
            mime="application/json",
        )


def _render_findings(store: PrivacyStore, case: dict[str, object] | None) -> None:
    st.subheader("Reviewed listings and removal targets")
    if not case:
        st.info("Create an authorized privacy case first.")
        return
    case_id = str(case["privacy_case_id"])
    with st.form("privacy_finding_create"):
        left, right = st.columns(2)
        with left:
            company = st.text_input("Company or site")
            listing_url = st.text_input("Exact profile, listing or content URL")
            listing_identifier = st.text_input("Listing/account identifier (optional)")
            subject_identifier = st.text_input("Subject identifier used by the site (optional)")
        with right:
            industry = st.selectbox("Category", FINDING_CATEGORIES)
            content_label = st.selectbox("Content handling", tuple(CONTENT_CATEGORIES))
            recipient = st.text_input("Privacy or abuse email (optional)")
            form_url = st.text_input("Privacy, opt-out or abuse form URL (optional)")
            contact_status = st.selectbox("Contact status", CONTACT_STATUSES)
        notes = st.text_area("Finding notes", placeholder="How the listing was matched; avoid copying unnecessary sensitive data")
        add = st.form_submit_button("Add reviewed finding", type="primary")
    if add:
        if not company.strip() or not _valid_public_url(listing_url):
            st.error("A company name and valid http(s) listing URL are required.")
        elif recipient.strip() and not _valid_email(recipient):
            st.error("Enter a valid single recipient email address.")
        elif form_url.strip() and not _valid_public_url(form_url):
            st.error("The privacy form must be a valid http(s) URL.")
        else:
            store.create_finding(
                case_id,
                {
                    "company_name": company,
                    "domain": urlparse(listing_url).netloc.lower(),
                    "industry_category": industry,
                    "listing_url": listing_url,
                    "listing_identifier": listing_identifier,
                    "subject_identifier": subject_identifier,
                    "recipient_email": recipient,
                    "privacy_form_url": form_url,
                    "contact_status": contact_status,
                    "content_category": CONTENT_CATEGORIES[content_label],
                    "discovered_at": utc_now(),
                    "notes": notes,
                },
            )
            st.success("Finding added to the case.")
            st.rerun()

    findings = store.list_findings(case_id)
    if not findings:
        st.info("No reviewed listings have been added yet.")
        return
    rows = [
        {
            "Company": item["company_name"],
            "Category": item["industry_category"],
            "URL": item["listing_url"],
            "Contact": item["contact_status"],
            "Status": item["status"],
        }
        for item in findings
    ]
    st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)
    st.download_button(
        "Download findings CSV",
        pd.DataFrame(findings).to_csv(index=False).encode("utf-8"),
        file_name=f"{case_id}-privacy-findings.csv",
        mime="text/csv",
    )


def _template_choices(content_category: str) -> list[str]:
    if content_category == "adult-profile":
        preferred = ["adult-profile-removal", "account-deletion", "data-broker-deletion"]
    elif content_category == "adult-ncii":
        preferred = ["adult-ncii-report", "adult-profile-removal"]
    else:
        preferred = [template.key for template in TEMPLATES if not template.key.startswith("adult-")]
    return preferred


def _render_drafting(store: PrivacyStore, case: dict[str, object] | None) -> None:
    st.subheader("Draft and submit one reviewed request")
    st.caption("DiveDeep prepares a local artifact and opens the selected delivery channel. It does not mass-send or silently submit requests.")
    if not case:
        st.info("Create an authorized privacy case first.")
        return
    case_id = str(case["privacy_case_id"])
    findings = store.list_findings(case_id)
    if not findings:
        st.info("Add a reviewed listing before drafting a request.")
        return
    finding_by_id = {str(item["finding_id"]): item for item in findings}
    finding_id = st.selectbox(
        "Finding",
        list(finding_by_id),
        format_func=lambda key: f"{finding_by_id[key]['company_name']} · {finding_by_id[key]['listing_url']}",
        key="privacy_draft_finding",
    )
    finding = finding_by_id[finding_id]
    content_category = str(finding["content_category"])
    if content_category == "minor-safety":
        st.error("Do not upload, attach, download or reproduce sexual content involving a person under 18 in DiveDeep.")
        st.write("Use NCMEC's safety workflow, which creates a hash on the device without uploading the image, or report urgent exploitation to the CyberTipline.")
        cols = st.columns(2)
        cols[0].link_button("Open Take It Down", TAKE_IT_DOWN_URL)
        cols[1].link_button("Open CyberTipline", CYBERTIPLINE_URL)
        return
    if content_category == "adult-ncii":
        st.warning("Use URLs and identifiers only—never place intimate media in the draft or case packet.")
        st.link_button("Open StopNCII hashing service", STOP_NCII_URL)

    choices = _template_choices(content_category)
    template_key = st.selectbox(
        "Request template",
        choices,
        format_func=lambda key: TEMPLATE_BY_KEY[key].label,
        key="privacy_template_key",
    )
    st.caption(TEMPLATE_BY_KEY[template_key].description)
    request_types = st.multiselect("Requested actions", REQUEST_ACTIONS, default=REQUEST_ACTIONS[:2])
    preset_name = st.selectbox("Legal basis preset", tuple(LEGAL_BASIS_PRESETS))
    preset_requires_confirmation = preset_name not in {"Plain-language request", "Custom / no legal assertion"}
    confirmed = True
    if preset_requires_confirmation:
        confirmed = st.checkbox("I confirmed this jurisdiction and legal basis applies to this person and request.")
    legal_basis = st.text_area("Editable legal-basis sentence", value=LEGAL_BASIS_PRESETS[preset_name])
    recipient = st.text_input("Recipient email", value=str(finding["recipient_email"]), key="privacy_draft_recipient")
    delivery_label = st.radio("Delivery handoff", ("Email draft", "Company privacy/abuse form"), horizontal=True)
    due_enabled = st.checkbox("Set a response follow-up date")
    response_due = st.date_input("Follow-up date", value=date.today(), disabled=not due_enabled)
    contact_ack = True
    if finding["contact_status"] == "unverified":
        contact_ack = st.checkbox("I reviewed this unverified destination before using it.")

    requester_statement = (
        f"the person named in this request ({case['subject_name']})"
        if case["requester_role"] == "self"
        else f"an authorized agent acting for {case['subject_name']}"
    )
    values = {
        "company_name": str(finding["company_name"]),
        "subject_name": str(case["subject_name"]),
        "subject_email_or_identifier": str(finding["subject_identifier"] or case["subject_email"] or "Not provided"),
        "profile_url": str(finding["listing_url"]),
        "listing_identifier": str(finding["listing_identifier"] or "Not provided"),
        "request_actions": "\n".join(f"- {action}" for action in request_types) or "- Review and complete the request described above",
        "legal_basis": legal_basis.strip(),
        "case_reference": case_id,
        "requester_statement": requester_statement,
        "requester_name": str(case["requester_name"]),
        "requester_email": str(case["requester_email"]),
    }
    generated_subject, generated_body = render_template(template_key, values)
    draft_state_key = f"{finding_id}_{template_key}"
    subject_key = f"privacy_subject_{draft_state_key}"
    body_key = f"privacy_body_{draft_state_key}"
    if subject_key not in st.session_state:
        st.session_state[subject_key] = generated_subject
    if body_key not in st.session_state:
        st.session_state[body_key] = generated_body
    if st.button("Regenerate from current selections"):
        st.session_state[subject_key] = generated_subject
        st.session_state[body_key] = generated_body
        st.rerun()
    email_subject = st.text_input("Subject", key=subject_key)
    email_body = st.text_area("Request body", height=420, key=body_key)
    if st.button("Save reviewed draft", type="primary"):
        if preset_requires_confirmation and not confirmed:
            st.error("Confirm applicability or select a plain-language/custom basis.")
        elif not request_types:
            st.error("Select at least one requested action.")
        elif not contact_ack:
            st.error("Review and acknowledge the unverified destination.")
        elif delivery_label == "Email draft" and not _valid_email(recipient):
            st.error("Enter a valid single recipient email or use the company form handoff.")
        elif delivery_label == "Company privacy/abuse form" and not _valid_public_url(str(finding["privacy_form_url"])):
            st.error("Add a verified privacy or abuse form URL to this finding first.")
        else:
            request_id = store.create_request(
                case_id,
                finding_id,
                {
                    "template_key": template_key,
                    "request_types": request_types,
                    "jurisdiction_basis": legal_basis,
                    "recipient_email": recipient,
                    "delivery_method": "email" if delivery_label == "Email draft" else "web-form",
                    "email_subject": email_subject,
                    "email_body": email_body,
                    "response_due_date": response_due.isoformat() if due_enabled else None,
                },
            )
            st.session_state.privacy_active_request_id = request_id
            st.success("Reviewed draft saved. Use the handoff area below to submit it yourself.")
            st.rerun()

    _render_submission_handoff(store, case)


def _render_submission_handoff(store: PrivacyStore, case: dict[str, object]) -> None:
    case_id = str(case["privacy_case_id"])
    requests = store.list_requests(case_id)
    if not requests:
        return
    st.divider()
    st.subheader("Submission handoff")
    by_id = {str(item["request_id"]): item for item in requests}
    current = st.session_state.get("privacy_active_request_id")
    if current not in by_id:
        current = list(by_id)[0]
    request_id = st.selectbox(
        "Saved request",
        list(by_id),
        index=list(by_id).index(current),
        format_func=lambda key: f"{by_id[key]['company_name']} · {by_id[key]['status']} · {key}",
        key="privacy_request_handoff",
    )
    st.session_state.privacy_active_request_id = request_id
    request = by_id[request_id]
    eml = build_eml(
        to_address=str(request["recipient_email"]),
        from_address=str(case["requester_email"]),
        subject=str(request["email_subject"]),
        body=str(request["email_body"]),
    )
    cols = st.columns(3)
    cols[0].download_button(
        "Download .eml",
        data=eml,
        file_name=f"{request_id}.eml",
        mime="message/rfc822",
        use_container_width=True,
    )
    if request["delivery_method"] == "email":
        cols[1].link_button(
            "Open in mail client",
            mailto_url(
                to_address=str(request["recipient_email"]),
                subject=str(request["email_subject"]),
                body=str(request["email_body"]),
            ),
            use_container_width=True,
        )
    elif _valid_public_url(str(request["privacy_form_url"])):
        cols[1].link_button("Open company form", str(request["privacy_form_url"]), use_container_width=True)
    cols[2].link_button("Open listing", str(request["listing_url"]), use_container_width=True)
    sent_confirm = st.checkbox("I personally submitted this exact request through the selected destination.", key=f"sent_ack_{request_id}")
    if st.button("Mark this request sent", disabled=not sent_confirm or request["status"] == "sent"):
        store.update_request_status(request_id, "sent", mark_sent=True)
        st.success("Submission recorded in the local audit trail.")
        st.rerun()


def _render_follow_up(store: PrivacyStore, case: dict[str, object] | None) -> None:
    st.subheader("Response tracking and verification")
    if not case:
        st.info("Create an authorized privacy case first.")
        return
    case_id = str(case["privacy_case_id"])
    requests = store.list_requests(case_id)
    findings = store.list_findings(case_id)
    if requests:
        request_by_id = {str(item["request_id"]): item for item in requests}
        selected_request_id = st.selectbox(
            "Request to update",
            list(request_by_id),
            format_func=lambda key: f"{request_by_id[key]['company_name']} · {request_by_id[key]['status']}",
            key="privacy_follow_request",
        )
        selected_request = request_by_id[selected_request_id]
        with st.form("privacy_request_update"):
            status = st.selectbox("Status", REQUEST_STATUSES, index=REQUEST_STATUSES.index(str(selected_request["status"])))
            confirmation = st.text_input("Company confirmation/reference", value=str(selected_request["confirmation_reference"]))
            due_enabled = st.checkbox("Set or replace follow-up date", value=bool(selected_request["response_due_date"]))
            default_due = date.fromisoformat(str(selected_request["response_due_date"])) if selected_request["response_due_date"] else date.today()
            due = st.date_input("Follow-up date", value=default_due, disabled=not due_enabled)
            notes = st.text_area("Response/follow-up notes", value=str(selected_request["notes"]))
            update = st.form_submit_button("Save request status", type="primary")
        if update:
            store.update_request_status(
                selected_request_id,
                status,
                confirmation_reference=confirmation,
                notes=notes,
                response_due_date=due.isoformat() if due_enabled else None,
                mark_sent=status == "sent",
            )
            st.success("Request status updated.")
            st.rerun()
    else:
        st.info("No requests have been drafted yet.")

    if findings:
        st.divider()
        finding_by_id = {str(item["finding_id"]): item for item in findings}
        with st.form("privacy_verification_add"):
            finding_id = st.selectbox(
                "Listing to re-check",
                list(finding_by_id),
                format_func=lambda key: f"{finding_by_id[key]['company_name']} · {finding_by_id[key]['listing_url']}",
            )
            result = st.selectbox("Verification result", VERIFICATION_RESULTS)
            source_url = st.text_input("URL checked", value=str(finding_by_id[finding_id]["listing_url"]))
            notes = st.text_area("Verification notes")
            add = st.form_submit_button("Record verification", type="primary")
        if add:
            if not _valid_public_url(source_url):
                st.error("Enter the exact valid http(s) URL that was checked.")
            else:
                store.add_verification(
                    case_id,
                    finding_id,
                    {"result": result, "source_url": source_url, "notes": notes},
                )
                st.success("Verification recorded.")
                st.rerun()

    events = store.list_events(case_id)
    if events:
        st.divider()
        st.caption("Local audit trail")
        st.dataframe(pd.DataFrame(events), width="stretch", hide_index=True)


def _render_resources() -> None:
    st.subheader("Official privacy and safety routes")
    st.markdown(
        """
- [California DROP](https://privacy.ca.gov/drop/) — one request for participating registered data brokers; timing and eligibility are controlled by California's official service.
- [California consumer privacy rights](https://oag.ca.gov/privacy/ccpa) — access, correction, deletion and sale/sharing opt-out information.
- [EU data-protection rights](https://commission.europa.eu/digital-life/protecting-your-data-and-privacy_en) — access, correction, erasure and direct-marketing objection guidance.
- [UK ICO erasure guidance](https://ico.org.uk/for-organisations/law-enforcement/guide-to-le-processing/individual-rights/the-right-to-erasure-and-the-right-to-restriction/) — scope and exceptions for erasure/restriction requests.
- [StopNCII](https://stopncii.org/) — on-device hashing for participating platforms when the subject was and is an adult.
- [NCMEC Take It Down](https://takeitdown.ncmec.org/) — on-device hashing when the image or video depicts the subject while under 18.
- [NCMEC CyberTipline](https://report.cybertip.org/) — report suspected child sexual exploitation.
        """
    )
    st.info("Privacy rights and company procedures vary. Templates are editable operational drafts, not a legal determination. Never upload intimate media or identity documents into this Studio.")


def render_privacy_removal_studio() -> None:
    st.title("Privacy Removal Studio")
    st.caption("Authorized discovery, one-at-a-time removal requests, response tracking and verification—stored locally in DiveDeep.")
    store = PrivacyStore()
    case = _case_selector(store)
    if case and not case.get("studio_case_id"):
        core_store = CaseStore()
        studio_case_id = core_store.create_case(
            str(case["case_name"]),
            mode="privacy-removal",
            objective="Authorized privacy removal and verification.",
            metadata={"hunt_type": "Privacy removal", "migrated_from": str(case["privacy_case_id"])},
        )
        store.link_studio_case(str(case["privacy_case_id"]), studio_case_id)
        st.session_state.research_case_id = studio_case_id
        remember_active_case(studio_case_id)
        st.rerun()
    if not case or st.session_state.get("privacy_pending_studio_case_id"):
        st.session_state.privacy_workspace_view = "Case"
    core_case = None
    if case and case.get("studio_case_id"):
        core_case = CaseStore().get_case(str(case["studio_case_id"]))
    case_context_header(core_case, workspace="Privacy Removal", detail=str(case["subject_name"]) if case else "")
    view = stage_picker(
        "Privacy stage",
        ("Case", "Findings", "Draft & submit", "Follow-up", "Resources"),
        key="privacy_workspace_view",
    )
    if view == "Case":
        _render_cases(store, case)
    elif view == "Findings":
        _render_findings(store, case)
    elif view == "Draft & submit":
        _render_drafting(store, case)
    elif view == "Follow-up":
        _render_follow_up(store, case)
    else:
        _render_resources()
