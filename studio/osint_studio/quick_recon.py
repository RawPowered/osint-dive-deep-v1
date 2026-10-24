from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass
from urllib.parse import urlparse, urlunparse

import pandas as pd
import streamlit as st

from .case_store import CaseStore
from .research_lanes import lane_matrix
from .ui_shell import ACTIVE_CASE_KEY, remember_active_case, request_workspace


TARGET_TYPES = (
    "address",
    "coordinates",
    "email",
    "domain",
    "ip",
    "url",
    "username",
    "phone",
    "person",
    "organization",
    "parcel",
)

SOURCE_PACKS: dict[str, tuple[str, ...]] = {
    "address": ("Census address normalization", "parcel and appraiser sources", "tax records", "permit routing", "historical weather"),
    "coordinates": ("reverse address", "parcel intersection", "property records", "weather and storm context"),
    "email": ("exact indexed mentions", "domain context", "public profiles", "configured email tools"),
    "domain": ("DNS and RDAP", "certificates", "subdomains", "URL inventories", "technology", "WordPress components", "OWASP 2025 analysis", "public endpoints"),
    "ip": ("RDAP and ASN", "reverse DNS", "certificates", "configured host intelligence tools"),
    "url": ("page validation", "metadata", "links and scripts", "structured extraction", "archive candidates"),
    "username": ("indexed mentions", "public profiles", "configured username tools", "identity candidates"),
    "phone": ("normalization", "exact indexed mentions", "public profiles", "identity candidates"),
    "person": ("names and aliases", "public profiles", "organizations", "locations", "public records"),
    "organization": ("official site", "registries", "leadership", "locations", "domains", "market context"),
    "parcel": ("property appraiser", "tax roll", "permit authority", "official records", "weather context"),
}

LANE_BY_TYPE = {
    "domain": "domain",
    "ip": "infrastructure",
    "username": "username",
    "person": "person",
    "organization": "organization",
    "url": "domain",
}


@dataclass(frozen=True)
class QuickTarget:
    raw: str
    target_type: str
    normalized: str
    derived_domain: str = ""
    latitude: float | None = None
    longitude: float | None = None


def detect_target(value: str) -> str:
    candidate = " ".join(value.strip().split())
    if not candidate:
        return "person"
    coordinate_match = re.fullmatch(r"\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*", value)
    if coordinate_match:
        latitude, longitude = map(float, coordinate_match.groups())
        if -90 <= latitude <= 90 and -180 <= longitude <= 180:
            return "coordinates"
    if re.fullmatch(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,63}", candidate):
        return "email"
    if candidate.startswith(("http://", "https://")):
        return "url"
    try:
        ipaddress.ip_address(candidate)
        return "ip"
    except ValueError:
        pass
    domain = urlparse("//" + candidate).hostname or ""
    if domain.casefold() == candidate.casefold() and re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z]{2,63}", domain, re.I):
        return "domain"
    digits = re.sub(r"\D", "", candidate)
    if 7 <= len(digits) <= 15 and re.fullmatch(r"[+()\d.\s-]+", candidate):
        return "phone"
    if re.match(r"^\d+\s+.+\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|pkwy|parkway)\b", candidate, re.I):
        return "address"
    if candidate.startswith("@") or (" " not in candidate and re.fullmatch(r"[A-Za-z0-9._-]{2,64}", candidate)):
        return "username"
    if re.search(r"\b(?:llc|inc|corp|company|co\.|foundation|association|university|group|holdings)\b", candidate, re.I):
        return "organization"
    return "person"


def normalize_target(value: str, target_type: str) -> QuickTarget:
    raw = value.strip()
    if target_type not in TARGET_TYPES:
        raise ValueError(f"Unsupported target type: {target_type}")
    if not raw:
        raise ValueError("Target cannot be empty.")
    normalized = " ".join(raw.split())
    derived_domain = ""
    latitude = longitude = None
    if target_type == "email":
        normalized = normalized.casefold()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,63}", normalized):
            raise ValueError("Enter a complete email address.")
        derived_domain = normalized.rsplit("@", 1)[-1]
    elif target_type == "domain":
        normalized = normalized.casefold().strip(".")
        if normalized.startswith(("http://", "https://")):
            normalized = urlparse(normalized).hostname or ""
        if not re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z]{2,63}", normalized, re.I):
            raise ValueError("Enter a valid domain name.")
        derived_domain = normalized
    elif target_type == "url":
        if not normalized.startswith(("http://", "https://")):
            normalized = "https://" + normalized
        parsed = urlparse(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("Enter a complete HTTP or HTTPS URL.")
        host = (parsed.hostname or "").casefold()
        netloc = host + (f":{parsed.port}" if parsed.port else "")
        normalized = urlunparse((parsed.scheme.casefold(), netloc, parsed.path or "/", parsed.params, parsed.query, ""))
        derived_domain = host
    elif target_type == "ip":
        normalized = ipaddress.ip_address(normalized).compressed
    elif target_type == "username":
        normalized = normalized.removeprefix("@").casefold()
        if not re.fullmatch(r"[A-Za-z0-9._-]{2,64}", normalized):
            raise ValueError("Enter a valid username.")
    elif target_type == "phone":
        digits = re.sub(r"\D", "", normalized)
        if not 7 <= len(digits) <= 15:
            raise ValueError("Enter a phone number with 7 to 15 digits.")
        normalized = ("+" if raw.strip().startswith("+") else "") + digits
    elif target_type == "coordinates":
        latitude, longitude = (float(part.strip()) for part in raw.split(",", 1))
        if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
            raise ValueError("Coordinates are outside valid latitude/longitude bounds.")
        normalized = f"{latitude:.6f},{longitude:.6f}"
    return QuickTarget(raw, target_type, normalized, derived_domain, latitude, longitude)


def _scratch_mode(target_type: str) -> tuple[str, str]:
    if target_type in {"address", "coordinates", "parcel"}:
        return "property-research", "Location & property"
    if target_type == "person":
        return "research", "People & identity"
    if target_type == "organization":
        return "research", "Organization & market"
    if target_type in {"domain", "ip", "url"}:
        return "technical", "Web & technology"
    return "research", "Universal research"


def _select_case(store: CaseStore, target_type: str) -> str | None:
    cases = store.list_cases(500)
    by_id = {str(item["id"]): item for item in cases}
    options = ["__scratch__", *by_id]
    pending = st.session_state.pop("_pending_quick_recon_case", None)
    if pending in by_id:
        st.session_state.quick_recon_case = pending
    active = st.session_state.get(ACTIVE_CASE_KEY)
    default = str(active) if active in by_id else "__scratch__"
    if st.session_state.get("quick_recon_case") not in options:
        st.session_state.quick_recon_case = default
    return st.selectbox(
        "Save to case",
        options,
        format_func=lambda value: "New scratch case" if value == "__scratch__" else str(by_id[value]["name"]),
        key="quick_recon_case",
    )


def _ensure_case(store: CaseStore, selection: str, target: QuickTarget) -> str:
    if selection != "__scratch__" and store.get_case(selection):
        return selection
    mode, hunt_type = _scratch_mode(target.target_type)
    label = target.normalized[:56] + ("…" if len(target.normalized) > 56 else "")
    case_id = store.create_case(
        f"Quick {target.target_type} · {label}",
        mode=mode,
        objective=f"Focused {target.target_type} reconnaissance for {target.normalized}",
        metadata={"hunt_type": hunt_type, "quick_recon_scratch": True},
    )
    st.session_state._pending_quick_recon_case = case_id
    return case_id


def _record_launch(
    store: CaseStore,
    case_id: str,
    target: QuickTarget,
    *,
    depth: str,
    sources: list[str],
    destination: str,
) -> dict[str, object]:
    subject_type = "person" if target.target_type == "person" else target.target_type
    subject_id = store.add_subject(
        case_id,
        subject_type,
        target.raw,
        primary_value=target.normalized,
        metadata={"entrypoint": "quick-recon", "detected_type": target.target_type},
    )
    store.add_identifier(
        case_id,
        target.target_type,
        target.raw,
        subject_id=subject_id,
        confidence=1.0,
        metadata={"normalized": target.normalized, "entrypoint": "quick-recon"},
    )
    if target.derived_domain and target.target_type != "domain":
        store.add_identifier(case_id, "domain", target.derived_domain, subject_id=subject_id, confidence=1.0, metadata={"derived_from": target.target_type})
    plan = {
        "target": target.raw,
        "normalized_target": target.normalized,
        "target_type": target.target_type,
        "derived_domain": target.derived_domain,
        "latitude": target.latitude,
        "longitude": target.longitude,
        "depth": depth,
        "sources": sources,
        "destination": destination,
    }
    run_id = store.create_run(case_id, "quick-recon", adapter="target-router", traffic_class="passive", config=plan)
    store.record_observation(
        case_id,
        "quick-recon-plan",
        plan,
        run_id=run_id,
        subject_id=subject_id,
        normalized_value=target.normalized,
        source_name="DiveDeep Quick Recon",
        confidence=1.0,
    )
    store.complete_run(run_id, summary={"status": "routed", "destination": destination, "source_count": len(sources)})
    return {**plan, "case_id": case_id, "run_id": run_id}


def _prepare_discovery(target: QuickTarget, depth: str) -> None:
    lane = LANE_BY_TYPE.get(target.target_type, "universal")
    seeds = [target.normalized]
    if target.derived_domain and target.derived_domain not in seeds:
        seeds.append(target.derived_domain)
    matrix = lane_matrix(lane, seeds)
    matrix["max_queries"] = {"Fast": 100, "Standard": 1000, "Deep": 5000}[depth]
    for key, value in matrix.items():
        st.session_state[f"super_{key}"] = value
    st.session_state.super_query_shards = []
    st.session_state.research_lane = lane


def _route(plan: dict[str, object], *, promote: bool = False) -> None:
    case_id = str(plan["case_id"])
    target_type = str(plan["target_type"])
    target = normalize_target(str(plan["target"]), target_type)
    destination = str(plan["destination"])
    if promote:
        destination = "Property Explorer" if target_type in {"address", "coordinates", "parcel"} else ("People Command Center" if target_type == "person" else ("Domain Security" if target_type in {"domain", "url"} else "Discovery"))
        plan["depth"] = "Deep"
    if destination == "Automatic":
        destination = "Property Explorer" if target_type in {"address", "coordinates", "parcel"} else ("People Command Center" if target_type == "person" else ("Domain Security" if target_type == "domain" else ("Web Validation" if target_type == "url" else "Discovery")))

    remember_active_case(case_id)
    st.session_state.research_case_id = case_id
    st.session_state.quick_recon_target = target.raw
    st.session_state.quick_recon_target_type = target_type
    st.session_state.quick_recon_sources = list(plan.get("sources") or [])
    st.session_state.quick_recon_last_plan = plan
    if destination == "Property Explorer":
        st.session_state.geo_case_id = case_id
        if target.latitude is not None and target.longitude is not None:
            st.session_state.quick_geo_point = {"lat": target.latitude, "lng": target.longitude, "case_id": case_id}
        else:
            st.session_state.quick_geo_target = {"value": target.normalized, "target_type": target_type, "case_id": case_id}
        request_workspace("Geo Explorer")
    elif destination == "People Command Center":
        st.session_state.research_active_view = "People & Identity"
        st.session_state.person_identity_stage = "Discover" if target_type == "person" else "Scope"
        request_workspace("Research Mode")
    elif destination == "Web Validation":
        url = target.normalized if target_type == "url" else f"https://{target.derived_domain or target.normalized}/"
        st.session_state.recon_targets = [{"url": url, "title": target.raw, "snippet": "Quick Recon target", "rank": 1, "query": target.raw, "source": "quick-recon"}]
        st.session_state.research_active_view = "Web Validation"
        request_workspace("Research Mode")
    elif destination == "Domain Security":
        domain = target.derived_domain or (target.normalized if target_type == "domain" else "")
        st.session_state.domain_security_pending_targets = [domain] if domain else []
        st.session_state.research_active_view = "Domain Security"
        request_workspace("Research Mode")
    elif destination == "Tool Arsenal":
        st.session_state.arsenal_sf_target = target.normalized
        st.session_state.research_active_view = "Tool Arsenal"
        request_workspace("Research Mode")
    else:
        _prepare_discovery(target, str(plan["depth"]))
        st.session_state.research_active_view = "Discovery"
        request_workspace("Research Mode")
    st.rerun()


def render_quick_recon(store: CaseStore) -> None:
    st.title("Quick Recon")
    st.caption("Run focused reconnaissance on one address, email, domain, IP, URL, username, phone, person, organization or parcel.")
    target_value = st.text_input("Target", placeholder="Enter one exact target")
    detected = detect_target(target_value)
    left, middle, right = st.columns(3)
    target_type = left.selectbox("Target type", TARGET_TYPES, index=TARGET_TYPES.index(detected))
    depth = middle.selectbox("Depth", ("Fast", "Standard", "Deep"), index=1)
    destination = right.selectbox(
        "Open in",
        ("Automatic", "Domain Security", "Discovery", "Web Validation", "Tool Arsenal", "People Command Center", "Property Explorer"),
    )
    selection = _select_case(store, target_type)
    available_sources = list(SOURCE_PACKS[target_type])
    sources = st.multiselect("Source pack", available_sources, default=available_sources)
    if target_value.strip():
        try:
            preview = normalize_target(target_value, target_type)
            st.caption(f"Detected {detected} · using {target_type} · normalized as `{preview.normalized}`")
        except ValueError as exc:
            preview = None
            st.error(f"Target normalization failed: {exc}")
    else:
        preview = None

    if st.button("Run Quick Recon", type="primary", use_container_width=True):
        if not preview:
            st.error("Enter a valid target.")
        elif not sources:
            st.error("Select at least one source or workflow step.")
        elif destination == "Web Validation" and target_type not in {"url", "domain", "email"}:
            st.error("Web Validation requires a URL or a target with a domain.")
        elif destination == "Domain Security" and target_type not in {"url", "domain", "email"}:
            st.error("Domain Security requires a domain, URL or email-derived domain.")
        else:
            case_id = _ensure_case(store, str(selection), preview)
            plan = _record_launch(store, case_id, preview, depth=depth, sources=sources, destination=destination)
            _route(plan)

    recent = [item for item in store.list_runs(str(selection), limit=25) if item.get("run_type") == "quick-recon"] if selection and selection != "__scratch__" else []
    if recent:
        st.divider()
        st.subheader("Recent quick runs")
        st.dataframe(
            pd.DataFrame([{"Started": item["started_at"], "Status": item["status"], "Run": item["id"]} for item in recent]),
            width="stretch",
            hide_index=True,
        )
    last_plan = st.session_state.get("quick_recon_last_plan")
    if isinstance(last_plan, dict):
        st.divider()
        st.caption(f"Last target · {last_plan.get('normalized_target')} · {last_plan.get('target_type')}")
        if st.button("Promote last target to Full Hunt", use_container_width=True):
            promoted = dict(last_plan)
            promoted["depth"] = "Deep"
            case_id = str(promoted["case_id"])
            promotion_run_id = store.create_run(
                case_id,
                "quick-recon-promotion",
                adapter="target-router",
                traffic_class="passive",
                config=promoted,
            )
            store.record_observation(
                case_id,
                "quick-recon-promotion",
                promoted,
                run_id=promotion_run_id,
                normalized_value=str(promoted.get("normalized_target") or ""),
                source_name="DiveDeep Quick Recon",
                confidence=1.0,
            )
            store.complete_run(promotion_run_id, summary={"status": "promoted", "depth": "Deep"})
            _route(promoted, promote=True)
