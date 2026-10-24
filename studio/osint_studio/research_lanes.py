from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class ResearchLane:
    key: str
    label: str
    subject_type: str
    description: str
    variants: tuple[str, ...] = ()
    templates: tuple[str, ...] = ("{base}", "{base} {variant}", "{base} {geo}")
    filetypes: tuple[str, ...] = ()


RESEARCH_LANES: tuple[ResearchLane, ...] = (
    ResearchLane("universal", "Universal Search", "unknown", "Broad public-source discovery with verification follow-ups."),
    ResearchLane("person", "People & Identity", "person", "Public identity, affiliations, professional profiles and corroborating sources.", ("official", "profile", "biography", "organization")),
    ResearchLane("organization", "Organizations", "organization", "Official sites, leadership, locations, services and public records.", ("official website", "leadership", "locations", "contact")),
    ResearchLane("market", "Markets", "market", "Businesses, services, geographic coverage and market census signals.", ("business", "company", "directory", "services")),
    ResearchLane("domain", "Domains & Web", "domain", "Indexed pages, subdomains, documents and website evidence.", ("contact", "about", "privacy", "terms")),
    ResearchLane("infrastructure", "Infrastructure", "infrastructure", "Public DNS, certificate, host and service intelligence.", ("dns", "certificate", "subdomain", "hosting")),
    ResearchLane("api", "APIs & Endpoints", "api", "Public API documentation, schemas, developer portals and historical routes.", ("api", "openapi", "swagger", "developer documentation")),
    ResearchLane("document", "Documents & Archives", "document", "Public documents, spreadsheets, reports and archived material.", (), ("{base} {filetype_op}", "{base} {geo} {filetype_op}"), ("pdf", "docx", "xlsx", "csv")),
    ResearchLane("technology", "Technology & Supply Chain", "technology", "Technology fingerprints, vendors, scripts and public implementation evidence.", ("powered by", "built with", "technology", "integration")),
    ResearchLane("username", "Usernames & Profiles", "username", "Public username and profile discovery across indexed services.", ("profile", "user", "account", "social")),
    ResearchLane("exposure", "Secrets & Exposure", "exposure", "Publicly indexed configuration, debug, credential and sensitive-data exposure signals.", ("configuration", "debug", "api key", "credential")),
)

LANES_BY_KEY = {lane.key: lane for lane in RESEARCH_LANES}


def detect_subject_type(value: str) -> str:
    candidate = value.strip()
    if not candidate:
        return "unknown"
    if candidate.startswith(("http://", "https://")):
        return "url"
    if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", candidate):
        return "email"
    try:
        ipaddress.ip_address(candidate)
        return "ip"
    except ValueError:
        pass
    host = urlparse("//" + candidate).hostname or ""
    if host == candidate.lower() and re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z]{2,63}", host, re.I):
        return "domain"
    if re.fullmatch(r"[A-Za-z0-9._-]{2,64}", candidate) and " " not in candidate:
        return "username"
    return "keyword"


def lane_matrix(lane_key: str, subjects: list[str]) -> dict[str, str | int]:
    lane = LANES_BY_KEY[lane_key]
    clean_subjects = list(dict.fromkeys(item.strip() for item in subjects if item.strip()))
    sites = clean_subjects if lane.key == "domain" else []
    return {
        "bases": "\n".join(clean_subjects),
        "variants": "\n".join(lane.variants),
        "sites": "\n".join(sites),
        "filetypes": "\n".join(lane.filetypes),
        "templates": "\n".join(lane.templates),
        "max_queries": min(25000, max(100, len(clean_subjects) * max(1, len(lane.variants)) * max(1, len(lane.templates)))),
    }

