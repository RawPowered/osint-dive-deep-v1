from __future__ import annotations

import io
import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Iterator

import pandas as pd

from .property_sources import FLORIDA_DOR_COUNTIES


FLORIDA_DOR_2025_NAL_URL = "https://floridarevenue.com/property/dataportal/Pages/default.aspx?path=/property/dataportal/Documents/PTO%20Data%20Portal/Tax%20Roll%20Data%20Files/NAL/2025F"
FLORIDA_DOR_2025_NAP_URL = "https://floridarevenue.com/property/dataportal/Pages/default.aspx?path=/property/dataportal/Documents/PTO%20Data%20Portal/Tax%20Roll%20Data%20Files/NAP/2025F"

ROLL_NAMES = {"R": "NAL", "P": "NAP", "S": "SDF"}
PERMIT_RESULT_STATUSES = (
    "NOT_SEARCHED",
    "MATCH_FOUND",
    "NO_ACCESSIBLE_MATCH",
    "ACCESS_BLOCKED",
    "ERROR",
    "MANUAL_REVIEW",
)


@dataclass(frozen=True)
class TaxRollChunk:
    member_name: str
    roll_type: str
    rows_seen: int
    frame: pd.DataFrame


def _text(frame: pd.DataFrame, *names: str) -> pd.Series:
    for name in names:
        if name in frame.columns:
            return frame[name].fillna("").astype(str).str.strip()
    return pd.Series("", index=frame.index, dtype="object")


def _joined(frame: pd.DataFrame, *names: str) -> pd.Series:
    values = [_text(frame, name) for name in names if name in frame.columns]
    if not values:
        return pd.Series("", index=frame.index, dtype="object")
    result = values[0]
    for value in values[1:]:
        result = (result + " " + value).str.replace(r"\s+", " ", regex=True).str.strip()
    return result


def detect_roll_type(frame: pd.DataFrame) -> str:
    columns = {str(column).strip().upper() for column in frame.columns}
    file_types = _text(frame.rename(columns=lambda value: str(value).strip().upper()), "FILE_T")
    observed = next((value.upper() for value in file_types if value.strip()), "")
    if observed in ROLL_NAMES:
        return ROLL_NAMES[observed]
    if "PARCEL_ID" in columns and ("SALE_PRC" in columns or "QUAL_CD" in columns):
        return "SDF"
    if "PARCEL_ID" in columns:
        return "NAL"
    if "ACCT_ID" in columns:
        return "NAP"
    raise ValueError("Unrecognized tax-roll schema: expected Florida DOR NAL, NAP or SDF fields.")


def normalize_florida_dor_chunk(frame: pd.DataFrame, member_name: str) -> TaxRollChunk:
    source = frame.copy()
    source.columns = [str(column).strip().upper() for column in source.columns]
    roll_type = detect_roll_type(source)
    county_number = _text(source, "CO_NO")
    county = county_number.map(
        lambda value: FLORIDA_DOR_COUNTIES.get(int(float(value)), "") if re.fullmatch(r"\d+(?:\.0+)?", value or "") else ""
    )
    parcel_id = _text(source, "PARCEL_ID") if roll_type in {"NAL", "SDF"} else pd.Series("", index=source.index)
    account_id = _text(source, "ACCT_ID") if roll_type == "NAP" else pd.Series("", index=source.index)
    source_identifier = parcel_id.where(parcel_id.ne(""), account_id)
    if roll_type == "NAL":
        site_address = _joined(source, "PHY_ADDR1", "PHY_ADDR2")
        if site_address.eq("").all():
            site_address = _text(source, "PHY_ADDR")
        use_code = _text(source, "DOR_UC", "PA_UC")
        year_built = _text(source, "ACT_YR_BLT", "EFF_YR_BLT", "YR_BLT", "YEAR_BUILT")
    elif roll_type == "NAP":
        site_address = _text(source, "PHY_ADDR", "PHY_ADDR1")
        use_code = _text(source, "NAICS_CD")
        year_built = pd.Series("", index=source.index)
    else:
        site_address = _joined(source, "PHY_ADDR1", "PHY_ADDR2")
        use_code = _text(source, "DOR_UC")
        year_built = pd.Series("", index=source.index)

    rows = source.to_dict("records")
    normalized = pd.DataFrame({
        "state": "FL",
        "county_no": county_number,
        "county": county,
        "assessment_year": _text(source, "ASMNT_YR", "SALE_YR"),
        "roll_type": roll_type,
        "source_identifier": source_identifier,
        "parcel_id": parcel_id,
        "account_id": account_id,
        "tax_authority_code": _text(source, "TAX_AUTH_CD"),
        "owner_name": _text(source, "OWN_NAME", "OWN_NAM"),
        "owner_mailing_address": _joined(source, "OWN_ADDR1", "OWN_ADDR2") if "OWN_ADDR1" in source.columns else _text(source, "OWN_ADDR"),
        "owner_city": _text(source, "OWN_CITY"),
        "owner_state": _text(source, "OWN_STATE"),
        "owner_zip": _text(source, "OWN_ZIPCD", "OWN_ZIP"),
        "site_address": site_address,
        "site_city": _text(source, "PHY_CITY"),
        "site_zip": _text(source, "PHY_ZIPCD", "PHY_ZIP"),
        "property_use_code": use_code,
        "year_built": year_built,
        "source_member": member_name,
        "source_row_number": [int(index) + 2 for index in source.index],
        "source_row_json": [json.dumps({key: value for key, value in row.items() if value not in (None, "")}, ensure_ascii=False, sort_keys=True, default=str) for row in rows],
    })
    normalized = normalized.loc[normalized["source_identifier"].astype(str).str.strip().ne("")].copy()
    return TaxRollChunk(member_name=member_name, roll_type=roll_type, rows_seen=len(source), frame=normalized)


def iter_tax_roll_chunks(filename: str, content: bytes, *, chunk_size: int = 5_000) -> Iterator[TaxRollChunk]:
    lower = filename.lower()
    if lower.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            members = [item for item in archive.infolist() if not item.is_dir() and PurePosixPath(item.filename).suffix.lower() in {".csv", ".txt"}]
            if not members:
                raise ValueError("The ZIP archive contains no CSV tax-roll members.")
            if len(members) > 200:
                raise ValueError("The ZIP archive contains more than 200 tabular members.")
            total_size = sum(item.file_size for item in members)
            if total_size > 4_000_000_000:
                raise ValueError("The ZIP archive expands beyond the 4 GB local ingestion ceiling.")
            for item in members:
                if item.flag_bits & 0x1:
                    raise ValueError(f"Encrypted ZIP member is not supported: {item.filename}")
                with archive.open(item, "r") as raw:
                    text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
                    for frame in pd.read_csv(text, dtype=str, keep_default_na=False, chunksize=chunk_size, low_memory=False):
                        yield normalize_florida_dor_chunk(frame, item.filename)
        return
    if not lower.endswith((".csv", ".txt")):
        raise ValueError("Tax-roll ingestion accepts Florida DOR CSV/TXT files or ZIP archives containing them.")
    for frame in pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False, chunksize=chunk_size, low_memory=False, encoding="utf-8-sig", encoding_errors="replace"):
        yield normalize_florida_dor_chunk(frame, filename)


def identifier_variants(value: str) -> list[str]:
    exact = str(value or "").strip()
    compact = re.sub(r"[^A-Za-z0-9]", "", exact).upper()
    digits = re.sub(r"\D", "", exact)
    return list(dict.fromkeys(item for item in (exact, compact, digits) if item))


def hillsborough_parcel_components(value: str) -> dict[str, str] | None:
    """Parse the 22-character HCPA compact form without guessing shorter formats."""
    compact = re.sub(r"[^A-Za-z0-9]", "", str(value or "")).upper()
    match = re.fullmatch(
        r"(?P<range>\d{2})(?P<township>\d{2})(?P<section>\d{2})(?P<subdivision>[A-Z0-9]{3})(?P<block>\d{6})(?P<lot>\d{6})(?P<municipality>[A-Z])",
        compact,
    )
    return match.groupdict() if match else None


def permit_query_variants(value: str, county: str, jurisdiction: str) -> list[str]:
    variants = identifier_variants(value)
    if county.casefold() == "hillsborough" and "temple terrace" in jurisdiction.casefold():
        components = hillsborough_parcel_components(value)
        if components:
            variants.append("COMPONENTS " + "; ".join(f"{key}={item}" for key, item in components.items()))
        else:
            variants.append("COMPONENTS require manual HCPA format review")
    return variants


DEFAULT_VERIFIED_PERMIT_ROUTES: tuple[dict[str, Any], ...] = (
    {"state": "FL", "county": "Hillsborough", "jurisdiction": "City of Temple Terrace", "coverage_scope": "Incorporated City of Temple Terrace", "portal_name": "Temple Terrace Click2Gov Building Permits", "direct_search_url": "https://temp-egov.aspgov.com/Click2GovBP/index.html", "platform": "Click2Gov BP", "verification_status": "VERIFIED_PARCEL", "parcel_lookup_label": "Parcel Number / parcel components", "query_method": "browser_session", "supports_direct_url_parameter": False, "parcel_format_notes": "Preserve the HCPA parcel ID; component parsing remains adapter-specific and must be verified in the visible portal.", "municipal_override_required": True, "routing_rule": "Use only after parcel geometry or analyst review confirms Temple Terrace; apply before Hillsborough County fallback.", "priority": 1},
    {"state": "FL", "county": "Hillsborough", "jurisdiction": "Hillsborough County", "coverage_scope": "County permitting authority / generally unincorporated", "portal_name": "HillsGovHub", "direct_search_url": "https://aca-prod.accela.com/HCFL/Default.aspx", "platform": "Accela Citizen Access", "verification_status": "VERIFIED_PARCEL", "parcel_lookup_label": "Parcel", "query_method": "browser_form", "supports_direct_url_parameter": False, "parcel_format_notes": "Try the exact HCPA parcel/folio and then a punctuation-stripped variant.", "municipal_override_required": True, "routing_rule": "Use only after municipal-boundary resolution excludes separate city authorities.", "priority": 100},
    {"state": "FL", "county": "Clay", "jurisdiction": "Clay County", "coverage_scope": "County permit search", "portal_name": "Clay County Permit Search", "direct_search_url": "https://public.claycountygov.com/PermitSearch/", "platform": "Custom", "verification_status": "VERIFIED_PARCEL", "parcel_lookup_label": "Parcel Number", "query_method": "browser_form", "supports_direct_url_parameter": False, "parcel_format_notes": "Preserve leading zeroes; try separator removal only after the exact value.", "municipal_override_required": True, "routing_rule": "Resolve incorporated municipality before county fallback.", "priority": 100},
    {"state": "FL", "county": "Lee", "jurisdiction": "Lee County", "coverage_scope": "County permitting authority", "portal_name": "Lee County Citizen Access", "direct_search_url": "https://aca-prod.accela.com/LEECO/Default.aspx", "platform": "Accela Citizen Access", "verification_status": "VERIFIED_PARCEL", "parcel_lookup_label": "STRAP Number", "query_method": "browser_form", "supports_direct_url_parameter": False, "parcel_format_notes": "Use the STRAP number without special characters.", "municipal_override_required": True, "routing_rule": "Resolve incorporated municipality before county fallback.", "priority": 100},
    {"state": "FL", "county": "Martin", "jurisdiction": "Martin County", "coverage_scope": "County permitting authority", "portal_name": "Martin County Citizen Access", "direct_search_url": "https://aca-prod.accela.com/MARTINCO/Cap/CapHome.aspx?TabName=Building&module=Building", "platform": "Accela Citizen Access", "verification_status": "VERIFIED_PARCEL", "parcel_lookup_label": "18-digit Parcel Number / PCN", "query_method": "browser_form", "supports_direct_url_parameter": False, "parcel_format_notes": "Use the 18-digit PCN and preserve the exact matched value.", "municipal_override_required": True, "routing_rule": "Resolve municipal jurisdiction before county fallback.", "priority": 100},
    {"state": "FL", "county": "Pasco", "jurisdiction": "Pasco County", "coverage_scope": "County permitting authority", "portal_name": "Pasco County Permits Search", "direct_search_url": "https://aca-prod.accela.com/PASCO/Cap/CapHome.aspx?module=Permits", "platform": "Accela Citizen Access", "verification_status": "VERIFIED_PARCEL", "parcel_lookup_label": "Parcel Number", "query_method": "browser_form", "supports_direct_url_parameter": False, "parcel_format_notes": "Try the exact parcel number and then a digits-only county display variant.", "municipal_override_required": True, "routing_rule": "Resolve incorporated municipality before county fallback.", "priority": 100},
    {"state": "FL", "county": "Polk", "jurisdiction": "Polk County", "coverage_scope": "County permitting authority", "portal_name": "Polk County Citizen Access", "direct_search_url": "https://aca-prod.accela.com/POLKCO/Cap/CapHome.aspx?module=Building", "platform": "Accela Citizen Access", "verification_status": "VERIFIED_PARCEL", "parcel_lookup_label": "Parcel Number", "query_method": "browser_form", "supports_direct_url_parameter": False, "parcel_format_notes": "Preserve the assessor parcel value and record the variant that matched.", "municipal_override_required": True, "routing_rule": "Resolve incorporated municipality before county fallback, including Lakeland.", "priority": 100},
)


def parse_permit_registry(filename: str, content: bytes) -> list[dict[str, Any]]:
    if filename.lower().endswith(".json"):
        payload = json.loads(content.decode("utf-8-sig"))
        if isinstance(payload, list):
            rows = payload
        elif isinstance(payload, dict):
            rows = []
            for key in ("parcel_search_endpoints", "county_routing", "municipal_overrides"):
                rows.extend(payload.get(key) or [])
        else:
            raise ValueError("Permit registry JSON must contain an object or list.")
    elif filename.lower().endswith(".csv"):
        rows = pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False, encoding="utf-8-sig").to_dict("records")
    else:
        raise ValueError("Permit registry must be JSON or CSV.")
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(rows):
        row = {str(key): value for key, value in dict(raw).items()}
        url = str(row.get("direct_search_url") or "").strip()
        jurisdiction = str(row.get("jurisdiction") or (f"{row.get('county')} County" if row.get("county") else row.get("municipality") or "")).strip()
        if row.get("municipality") and not row.get("jurisdiction"):
            jurisdiction = f"City of {row['municipality']}"
        if not row.get("county") or not jurisdiction:
            continue
        normalized.append({
            "state": str(row.get("state") or "FL").upper(),
            "county": str(row.get("county") or "").strip(),
            "jurisdiction": jurisdiction,
            "coverage_scope": str(row.get("coverage_scope") or "").strip(),
            "portal_name": str(row.get("portal_name") or jurisdiction).strip(),
            "direct_search_url": url,
            "platform": str(row.get("platform") or "").strip(),
            "verification_status": str(row.get("verification_status") or row.get("parcel_status") or "UNVERIFIED").strip().upper(),
            "parcel_lookup_label": str(row.get("parcel_lookup_label") or "").strip(),
            "query_method": str(row.get("query_method") or "browser_form").strip(),
            "supports_direct_url_parameter": str(row.get("supports_direct_url_parameter") or "NO").strip().upper() in {"YES", "TRUE", "1"},
            "parcel_format_notes": str(row.get("parcel_format_notes") or "").strip(),
            "municipal_override_required": str(row.get("municipal_override_required") or "YES").strip().upper() in {"YES", "TRUE", "1"},
            "routing_rule": str(row.get("routing_rule") or row.get("routing_note") or row.get("notes") or "").strip(),
            "priority": int(row.get("priority") or (index + 1)),
            "source_url": str(row.get("source_url") or url).strip(),
            "last_reviewed": str(row.get("last_reviewed") or "").strip(),
        })
    return normalized
