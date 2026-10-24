from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OwnerVerificationSource:
    key: str
    label: str
    url: str
    access_mode: str
    policy_note: str


OWNER_VERIFICATION_SOURCES: tuple[OwnerVerificationSource, ...] = (
    OwnerVerificationSource(
        "florida_residents_directory",
        "Florida Residents Directory",
        "https://www.floridaresidentsdirectory.com/",
        "manual-external-browser",
        "Manual, single-record verification only. Site terms prohibit automated access and significant archiving.",
    ),
    OwnerVerificationSource(
        "national_public_data",
        "National Public Data",
        "https://nationalpublicdata.com/",
        "manual-external-browser",
        "Manual, single-record verification only while source terms and permitted reuse remain unverified.",
    ),
    OwnerVerificationSource(
        "beenverified",
        "BeenVerified",
        "https://www.beenverified.com/people/",
        "manual-external-browser",
        "Reference link only. Paid/background-report content is outside this workflow.",
    ),
)

OWNER_VERIFICATION_RESULTS = (
    "NOT_REVIEWED",
    "NAME_AND_ADDRESS_MATCH",
    "NAME_MATCH_ADDRESS_CONFLICT",
    "NO_CONFIRMED_MATCH",
    "SOURCE_UNAVAILABLE",
    "SUPPRESSED",
)

OWNER_VERIFICATION_STATUSES = (
    "manual-review",
    "verified",
    "conflict",
    "not-found",
    "source-unavailable",
    "suppressed",
)

RESULT_TO_STATUS = {
    "NOT_REVIEWED": "manual-review",
    "NAME_AND_ADDRESS_MATCH": "verified",
    "NAME_MATCH_ADDRESS_CONFLICT": "conflict",
    "NO_CONFIRMED_MATCH": "not-found",
    "SOURCE_UNAVAILABLE": "source-unavailable",
    "SUPPRESSED": "suppressed",
}

# These categories are intentionally excluded from the local schema, UI and
# exports. The lane corroborates an owner-of-record name against a property
# address; it is not a background-report or demographic-profiling system.
EXCLUDED_OWNER_ATTRIBUTES = (
    "date of birth or age",
    "political affiliation or voter status",
    "race, ethnicity, sex or gender",
    "phone numbers or email addresses",
    "relatives, associates or neighbors",
    "bulk social-profile identifiers or content archives",
    "criminal, court, judgment or background-report data",
)


def source_by_key(key: str) -> OwnerVerificationSource:
    return next(source for source in OWNER_VERIFICATION_SOURCES if source.key == key)
