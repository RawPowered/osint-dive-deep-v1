from __future__ import annotations

from dataclasses import dataclass
from email.message import EmailMessage
from urllib.parse import quote


STOP_NCII_URL = "https://stopncii.org/"
TAKE_IT_DOWN_URL = "https://takeitdown.ncmec.org/"
CYBERTIPLINE_URL = "https://report.cybertip.org/"
CA_DROP_URL = "https://privacy.ca.gov/drop/"


@dataclass(frozen=True)
class PrivacyTemplate:
    key: str
    label: str
    category: str
    subject: str
    body: str
    description: str


TEMPLATES = (
    PrivacyTemplate(
        "marketing-suppression",
        "Marketing suppression / unsubscribe",
        "Marketing",
        "Marketing suppression request — {case_reference}",
        """Hello {company_name} Privacy Team,

I am {requester_statement}. I am requesting that you stop using the personal information listed below for direct marketing and suppress it from future marketing imports or campaigns.

Subject: {subject_name}
Email or identifier: {subject_email_or_identifier}
Listing or source URL: {profile_url}

Requested action:
{request_actions}

You may retain only the minimum suppression information necessary to ensure this person is not re-added, where permitted. {legal_basis}

Please confirm completion or explain any information you must retain and why. Please use case reference {case_reference} in your response.

Regards,
{requester_name}
{requester_email}""",
        "Stops campaign use while allowing a minimal suppression marker to prevent re-import.",
    ),
    PrivacyTemplate(
        "data-broker-deletion",
        "Data broker deletion + sale/share opt-out",
        "Data broker",
        "Delete and opt-out request — {case_reference}",
        """Hello {company_name} Privacy Team,

I am {requester_statement}. Please delete personal information associated with the subject below and opt the subject out of the sale or sharing of personal information, where applicable.

Subject: {subject_name}
Email or identifier: {subject_email_or_identifier}
Profile/listing URL: {profile_url}
Listing ID: {listing_identifier}

Requested action:
{request_actions}

This request includes public-facing records, profiles, derived attributes and inferences controlled by your organization, subject to lawful exceptions. {legal_basis}

Please confirm the action taken, identify any data you cannot delete and the reason for retaining it, and provide a confirmation or reference number. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}""",
        "Requests deletion plus opt-out without claiming that every record is legally erasable.",
    ),
    PrivacyTemplate(
        "people-search-removal",
        "People-search profile removal",
        "People search",
        "Remove public profile — {case_reference}",
        """Hello {company_name} Privacy Team,

I am {requester_statement}. Please remove or suppress the public profile and search result identified below from your site and from future publication under the same identity.

Subject: {subject_name}
Profile URL: {profile_url}
Listing ID: {listing_identifier}
Related identifier: {subject_email_or_identifier}

Requested action:
{request_actions}

Please also remove controlled thumbnails, snippets and cached copies that reproduce the listing, where applicable. {legal_basis}

Please confirm completion or provide the exact verification step required. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}""",
        "For people-search and directory listings selected and reviewed by the operator.",
    ),
    PrivacyTemplate(
        "b2b-contact-removal",
        "B2B lead/contact removal",
        "B2B lead data",
        "Remove business contact record — {case_reference}",
        """Hello {company_name} Privacy Team,

I am {requester_statement}. Please remove the subject's personal contact record from your lead, enrichment, prospecting and audience products.

Subject: {subject_name}
Email or identifier: {subject_email_or_identifier}
Record URL: {profile_url}

Requested action:
{request_actions}

Please propagate the suppression to controlled marketing products and future imports where applicable. {legal_basis}

Please confirm completion and provide a reference number. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}""",
        "For personal data appearing in lead, enrichment and prospecting products.",
    ),
    PrivacyTemplate(
        "account-deletion",
        "Account/profile deletion",
        "Account",
        "Account deletion request — {case_reference}",
        """Hello {company_name} Privacy Team,

I am {requester_statement}. Please close the identified account and delete the associated personal information, subject to records you are legally required to retain.

Subject: {subject_name}
Account or profile: {profile_url}
Account identifier: {subject_email_or_identifier}

Requested action:
{request_actions}

{legal_basis}

Please confirm completion and explain any retention that remains. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}""",
        "Closes an account and requests deletion while recognizing mandatory retention.",
    ),
    PrivacyTemplate(
        "correction",
        "Correction / rectification",
        "Correction",
        "Correct personal information — {case_reference}",
        """Hello {company_name} Privacy Team,

I am {requester_statement}. The record below contains inaccurate personal information. Please correct it as specified.

Subject: {subject_name}
Record URL: {profile_url}
Listing ID: {listing_identifier}

Corrections requested:
{request_actions}

{legal_basis}

Please confirm the corrected fields or explain what additional verification is required. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}""",
        "Corrects an inaccurate listing rather than deleting it.",
    ),
    PrivacyTemplate(
        "access",
        "Access / know request",
        "Access",
        "Personal information access request — {case_reference}",
        """Hello {company_name} Privacy Team,

I am {requester_statement}. Please provide the personal information associated with the subject below, the categories of sources, the purposes of use, and the categories of recipients or buyers, where applicable.

Subject: {subject_name}
Email or identifier: {subject_email_or_identifier}
Record URL: {profile_url}

Requested scope:
{request_actions}

{legal_basis}

Please provide a secure verification and delivery method. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}""",
        "Requests access and provenance before deciding on correction or deletion.",
    ),
    PrivacyTemplate(
        "adult-profile-removal",
        "Adult-industry profile/content delisting",
        "Adult platform",
        "Authorized privacy and delisting request — {case_reference}",
        """Hello {company_name} Trust, Safety or Privacy Team,

I am {requester_statement}. Please remove or de-index the authorized subject's public profile and the specific URLs listed below from services controlled by your organization.

Subject or stage name: {subject_name}
URL: {profile_url}
Listing ID: {listing_identifier}

Requested action:
{request_actions}

Do not require intimate media to be sent by email. Please provide a secure verification channel if identity or authorization must be confirmed. This request does not ask you to destroy records you are legally required to retain. {legal_basis}

Please preserve only the minimum incident and compliance information required and confirm the public-facing removal. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}""",
        "URL-only removal request; the Studio never stores or attaches intimate media.",
    ),
    PrivacyTemplate(
        "adult-ncii-report",
        "Adult non-consensual intimate content report",
        "Adult safety",
        "Urgent non-consensual intimate content report — {case_reference}",
        """Hello {company_name} Trust and Safety Team,

I am {requester_statement}. I am reporting the following URL as containing or facilitating non-consensual intimate content involving the adult subject.

Subject: {subject_name}
URL: {profile_url}
Listing ID: {listing_identifier}

Requested action:
{request_actions}

Please remove access to the reported material, stop further controlled distribution, and preserve only the incident evidence needed for safety, appeals and legal obligations. Do not request intimate media by ordinary email; provide a secure verification channel if needed. {legal_basis}

Please confirm receipt and provide an incident reference. Case reference: {case_reference}.

Regards,
{requester_name}
{requester_email}""",
        "Urgent URL-only report for an adult; pair with StopNCII where appropriate.",
    ),
)


TEMPLATE_BY_KEY = {template.key: template for template in TEMPLATES}

LEGAL_BASIS_PRESETS = {
    "Plain-language request": "I am making this request under applicable privacy and direct-marketing rules.",
    "California CCPA/CPRA (confirm applicability)": (
        "I request applicable deletion, correction, access and/or opt-out rights under the California Consumer Privacy Act, "
        "as amended, subject to lawful exceptions."
    ),
    "EU GDPR (confirm applicability)": (
        "I exercise applicable rights of access, rectification, erasure and/or objection to direct marketing under the GDPR, "
        "subject to lawful exceptions."
    ),
    "UK GDPR (confirm applicability)": (
        "I exercise applicable rights of access, rectification, erasure and/or objection to direct marketing under UK data "
        "protection law, subject to lawful exceptions."
    ),
    "Custom / no legal assertion": "",
}


class _SafeValues(dict[str, str]):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def render_template(template_key: str, values: dict[str, str]) -> tuple[str, str]:
    template = TEMPLATE_BY_KEY[template_key]
    safe = _SafeValues({key: str(value or "").strip() for key, value in values.items()})
    return template.subject.format_map(safe), template.body.format_map(safe)


def build_eml(*, to_address: str, from_address: str, subject: str, body: str) -> bytes:
    message = EmailMessage()
    if to_address.strip():
        message["To"] = to_address.strip()
    if from_address.strip():
        message["From"] = from_address.strip()
    message["Subject"] = subject.strip()
    message.set_content(body.rstrip() + "\n")
    return message.as_bytes()


def mailto_url(*, to_address: str, subject: str, body: str) -> str:
    return f"mailto:{quote(to_address.strip())}?subject={quote(subject)}&body={quote(body)}"
