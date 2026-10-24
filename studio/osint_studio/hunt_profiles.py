from __future__ import annotations

import json
import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from string import Formatter
from typing import Any

from .paths import DRAFT_ROOT, PROFILE_ROOT, ensure_private_directory
from .web_recon import (
    DEFAULT_RESULT_FIELDS,
    EXTRACTOR_METHODS,
    EXTRACTOR_SOURCES,
    OPTIONAL_LARGE_FIELDS,
    RULE_OPERATORS,
    RULE_SECTIONS,
)

PROFILE_SCHEMA_VERSION = "osint-query-studio-template-v2"
LEGACY_PROFILE_SCHEMA_VERSION = "hunt-profile-v1"
APP_TEMPLATE_COMPATIBILITY = "5.x"

BUNDLED_PROFILE_ROOT = Path(__file__).resolve().parent.parent / "templates"
MATRIX_DRAFT_PATH = DRAFT_ROOT / "discovery_matrix.json"

DEFAULT_SELECTED_FIELDS = [
    "input_source",
    "search_query",
    "search_rank",
    "search_title",
    "search_snippet",
    "requested_url",
    "final_url",
    "domain",
    "status_code",
    "fetch_ok",
    "response_time_ms",
    "fetched_at",
    "title",
    "meta_description",
    "canonical_url",
    "h1",
    "footer_text",
    "script_srcs",
    "footer_script_srcs",
    "emails",
    "phones",
    "social_links",
    "technologies",
    "match_passed",
    "match_score",
    "matched_rules",
    "failed_rules",
    "error",
]


def _rule(
    group: str,
    section: str,
    operator: str,
    value: str,
    weight: float,
    *,
    group_logic: str = "OR",
    required: bool = False,
) -> dict[str, Any]:
    return {
        "Group": group,
        "Group logic": group_logic,
        "Section": section,
        "Operator": operator,
        "Value": value,
        "Case sensitive": False,
        "Required": required,
        "Weight": weight,
    }


def _base_profile(name: str, description: str) -> dict[str, Any]:
    return {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "template_id": safe_profile_name(name).lower(),
        "name": name,
        "description": description,
        "metadata": {
            "tags": [],
            "author": "OSINT Query Studio",
            "compatible_app_versions": APP_TEMPLATE_COMPATIBILITY,
        },
        "matrix": {
            "bases": "",
            "variants": "",
            "geographies": "",
            "excludes": "",
            "sites": "",
            "title_terms": "",
            "url_terms": "",
            "filetypes": "",
            "templates": "{base}",
            "max_queries": 2500,
            "candidate_excluded_domains": "",
            "candidate_excluded_url_terms": "",
            "candidate_excluded_title_terms": "",
            "candidate_excluded_snippet_terms": "",
            "candidate_required_url_terms": "",
        },
        "visual": {
            "matching": {
                "within_group": "OR",
                "between_groups": "AND",
                "minimum_score": 0.0,
            },
            "prefilter": {
                "excluded_domains": "",
                "excluded_url_terms": "",
                "excluded_title_terms": "",
                "excluded_snippet_terms": "",
                "required_url_terms": "",
            },
            "rules": [],
            "extractors": [],
            "selected_fields": DEFAULT_SELECTED_FIELDS,
            "fetch": {
                "workers": 4,
                "timeout": 15,
                "verify_tls": True,
                "follow_redirects": True,
                "max_bytes": 2500000,
                "include_nonmatches": True,
            },
        },
    }


def built_in_profiles() -> dict[str, dict[str, Any]]:
    blank = _base_profile("Blank expansive hunt", "Start with your own research scope. No targets or matching rules are supplied.")
    return {blank["name"]: blank}


def safe_profile_name(name: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", (name or "custom_profile").strip()).strip("._")
    return value or "custom_profile"



class TemplateValidationError(ValueError):
    """Raised when a JSON hunt template cannot be safely normalized."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


MATRIX_TEXT_KEYS = {
    "bases",
    "variants",
    "geographies",
    "excludes",
    "sites",
    "title_terms",
    "url_terms",
    "filetypes",
    "templates",
    "candidate_excluded_domains",
    "candidate_excluded_url_terms",
    "candidate_excluded_title_terms",
    "candidate_excluded_snippet_terms",
    "candidate_required_url_terms",
}
MATRIX_KEYS = [*sorted(MATRIX_TEXT_KEYS), "max_queries"]
PREFILTER_KEYS = {
    "excluded_domains",
    "excluded_url_terms",
    "excluded_title_terms",
    "excluded_snippet_terms",
    "required_url_terms",
}
ALLOWED_TEMPLATE_FIELDS = {
    "base", "variant", "geo", "site", "title", "url", "filetype",
    "site_op", "title_op", "url_op", "filetype_op",
}
RULE_KEY_ALIASES = {
    "group": "Group",
    "group_logic": "Group logic",
    "section": "Section",
    "operator": "Operator",
    "value": "Value",
    "case_sensitive": "Case sensitive",
    "required": "Required",
    "weight": "Weight",
}
EXTRACTOR_KEY_ALIASES = {
    "column_name": "Column name",
    "method": "Method",
    "source": "Source",
    "pattern": "Pattern or selector",
    "pattern_or_selector": "Pattern or selector",
    "selector": "Pattern or selector",
    "attribute": "Attribute",
    "multiple": "Multiple",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _multiline(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple, set)):
        return "\n".join(str(item).strip() for item in value if str(item).strip())
    return str(value)


def _canonical_row(row: dict[str, Any], aliases: dict[str, str]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in row.items():
        canonical = aliases.get(str(key), str(key))
        output[canonical] = value
    return output


def _validate_query_templates(value: str, errors: list[str]) -> None:
    for index, template in enumerate([line.strip() for line in value.splitlines() if line.strip()], start=1):
        try:
            fields = {field for _, field, _, _ in Formatter().parse(template) if field}
        except ValueError as exc:
            errors.append(f"matrix.templates line {index} is malformed: {exc}")
            continue
        unknown = sorted(fields - ALLOWED_TEMPLATE_FIELDS)
        if unknown:
            errors.append(
                f"matrix.templates line {index} uses unknown placeholder(s): {', '.join(unknown)}"
            )


def normalize_profile(payload: dict[str, Any], *, strict: bool = True) -> tuple[dict[str, Any], list[str]]:
    """Normalize legacy and AI-authored JSON into the canonical v2 template schema."""
    if not isinstance(payload, dict):
        raise TemplateValidationError(["Template root must be a JSON object."])

    source = deepcopy(payload)
    errors: list[str] = []
    warnings: list[str] = []
    schema = str(source.get("schema_version") or LEGACY_PROFILE_SCHEMA_VERSION)
    if schema not in {PROFILE_SCHEMA_VERSION, LEGACY_PROFILE_SCHEMA_VERSION}:
        errors.append(
            f"Unsupported schema_version {schema!r}; expected {PROFILE_SCHEMA_VERSION!r} or legacy {LEGACY_PROFILE_SCHEMA_VERSION!r}."
        )
    elif schema == LEGACY_PROFILE_SCHEMA_VERSION:
        warnings.append("Legacy hunt-profile-v1 template migrated to v2.")

    name = str(source.get("name") or "").strip()
    if not name:
        errors.append("Template name is required.")
        name = "Imported template"

    profile = _base_profile(name, str(source.get("description") or "").strip())
    profile["schema_version"] = PROFILE_SCHEMA_VERSION
    profile["template_id"] = safe_profile_name(str(source.get("template_id") or name)).lower()

    metadata = source.get("metadata") if isinstance(source.get("metadata"), dict) else {}
    tags = metadata.get("tags", source.get("tags", []))
    if isinstance(tags, str):
        tags = [part.strip() for part in re.split(r"[,\n]", tags) if part.strip()]
    if not isinstance(tags, list):
        errors.append("metadata.tags must be a string or array of strings.")
        tags = []
    profile["metadata"] = {
        "tags": [str(item).strip() for item in tags if str(item).strip()],
        "author": str(metadata.get("author") or source.get("author") or "").strip(),
        "compatible_app_versions": str(
            metadata.get("compatible_app_versions") or APP_TEMPLATE_COMPATIBILITY
        ).strip(),
        "created_at": str(metadata.get("created_at") or _utc_now()),
        "updated_at": _utc_now(),
    }
    for optional_key in ("objective", "notes", "source", "license"):
        if optional_key in metadata:
            profile["metadata"][optional_key] = metadata[optional_key]

    matrix = source.get("matrix")
    if matrix is None:
        matrix = {}
    if not isinstance(matrix, dict):
        errors.append("matrix must be a JSON object.")
        matrix = {}
    for key in MATRIX_TEXT_KEYS:
        if key in matrix:
            profile["matrix"][key] = _multiline(matrix.get(key))
    max_queries = matrix.get("max_queries", profile["matrix"]["max_queries"])
    try:
        max_queries = int(max_queries)
    except (TypeError, ValueError):
        errors.append("matrix.max_queries must be an integer.")
        max_queries = 2500
    if not 1 <= max_queries <= 25000:
        errors.append("matrix.max_queries must be between 1 and 25000.")
        max_queries = min(25000, max(1, max_queries))
    profile["matrix"]["max_queries"] = max_queries
    _validate_query_templates(profile["matrix"].get("templates", ""), errors)

    visual = source.get("visual")
    if visual is None:
        visual = {}
    if not isinstance(visual, dict):
        errors.append("visual must be a JSON object.")
        visual = {}

    matching = visual.get("matching") if isinstance(visual.get("matching"), dict) else {}
    within = str(matching.get("within_group") or "OR").upper()
    between = str(matching.get("between_groups") or "AND").upper()
    if within not in {"AND", "OR"}:
        errors.append("visual.matching.within_group must be AND or OR.")
        within = "OR"
    if between not in {"AND", "OR"}:
        errors.append("visual.matching.between_groups must be AND or OR.")
        between = "AND"
    try:
        minimum_score = float(matching.get("minimum_score", 0.0))
    except (TypeError, ValueError):
        errors.append("visual.matching.minimum_score must be numeric.")
        minimum_score = 0.0
    if not 0 <= minimum_score <= 100:
        errors.append("visual.matching.minimum_score must be between 0 and 100.")
        minimum_score = min(100.0, max(0.0, minimum_score))
    profile["visual"]["matching"] = {
        "within_group": within,
        "between_groups": between,
        "minimum_score": minimum_score,
    }

    prefilter = visual.get("prefilter") if isinstance(visual.get("prefilter"), dict) else {}
    profile["visual"]["prefilter"] = {key: _multiline(prefilter.get(key, "")) for key in PREFILTER_KEYS}

    rule_rows = visual.get("rules", [])
    if not isinstance(rule_rows, list):
        errors.append("visual.rules must be an array.")
        rule_rows = []
    normalized_rules: list[dict[str, Any]] = []
    for index, raw in enumerate(rule_rows, start=1):
        if not isinstance(raw, dict):
            errors.append(f"visual.rules[{index}] must be an object.")
            continue
        row = _canonical_row(raw, RULE_KEY_ALIASES)
        group = str(row.get("Group") or "Fingerprint").strip() or "Fingerprint"
        group_logic = str(row.get("Group logic") or "").upper()
        if group_logic not in {"", "AND", "OR"}:
            errors.append(f"visual.rules[{index}].Group logic must be blank, AND, or OR.")
            group_logic = ""
        section = str(row.get("Section") or "").strip()
        operator = str(row.get("Operator") or "").strip().lower()
        value = str(row.get("Value") or "")
        if section not in RULE_SECTIONS:
            errors.append(f"visual.rules[{index}].Section {section!r} is unsupported.")
        if operator not in RULE_OPERATORS:
            errors.append(f"visual.rules[{index}].Operator {operator!r} is unsupported.")
        try:
            weight = float(row.get("Weight", 1.0))
        except (TypeError, ValueError):
            errors.append(f"visual.rules[{index}].Weight must be numeric.")
            weight = 1.0
        if weight < 0 or weight > 100:
            errors.append(f"visual.rules[{index}].Weight must be between 0 and 100.")
            weight = min(100.0, max(0.0, weight))
        if operator not in {"exists", "does not exist"} and not value.strip():
            warnings.append(f"visual.rules[{index}] has an empty Value and will rarely be useful.")
        normalized_rules.append({
            "Group": group,
            "Group logic": group_logic,
            "Section": section,
            "Operator": operator,
            "Value": value,
            "Case sensitive": bool(row.get("Case sensitive", False)),
            "Required": bool(row.get("Required", False)),
            "Weight": weight,
        })
    profile["visual"]["rules"] = normalized_rules

    extractor_rows = visual.get("extractors", [])
    if not isinstance(extractor_rows, list):
        errors.append("visual.extractors must be an array.")
        extractor_rows = []
    normalized_extractors: list[dict[str, Any]] = []
    for index, raw in enumerate(extractor_rows, start=1):
        if not isinstance(raw, dict):
            errors.append(f"visual.extractors[{index}] must be an object.")
            continue
        row = _canonical_row(raw, EXTRACTOR_KEY_ALIASES)
        column_name = str(row.get("Column name") or "").strip()
        method = str(row.get("Method") or "").strip()
        source_name = str(row.get("Source") or "Full HTML").strip()
        pattern = str(row.get("Pattern or selector") or "")
        if not column_name:
            errors.append(f"visual.extractors[{index}].Column name is required.")
        if method not in EXTRACTOR_METHODS:
            errors.append(f"visual.extractors[{index}].Method {method!r} is unsupported.")
        if source_name not in EXTRACTOR_SOURCES:
            errors.append(f"visual.extractors[{index}].Source {source_name!r} is unsupported.")
        if not pattern.strip():
            errors.append(f"visual.extractors[{index}].Pattern or selector is required.")
        normalized_extractors.append({
            "Column name": column_name,
            "Method": method,
            "Source": source_name,
            "Pattern or selector": pattern,
            "Attribute": str(row.get("Attribute") or ""),
            "Multiple": bool(row.get("Multiple", True)),
        })
    profile["visual"]["extractors"] = normalized_extractors

    selected_fields = visual.get("selected_fields", DEFAULT_SELECTED_FIELDS)
    if isinstance(selected_fields, str):
        selected_fields = [part.strip() for part in re.split(r"[,\n]", selected_fields) if part.strip()]
    if not isinstance(selected_fields, list):
        errors.append("visual.selected_fields must be an array or newline-delimited string.")
        selected_fields = DEFAULT_SELECTED_FIELDS.copy()
    allowed_fields = {*DEFAULT_RESULT_FIELDS, *OPTIONAL_LARGE_FIELDS, "tiktok_links"}
    normalized_fields: list[str] = []
    for field in selected_fields:
        field_name = str(field).strip()
        if not field_name:
            continue
        if field_name not in allowed_fields:
            warnings.append(f"Unknown selected field preserved for forward compatibility: {field_name}")
        if field_name not in normalized_fields:
            normalized_fields.append(field_name)
    profile["visual"]["selected_fields"] = normalized_fields

    fetch = visual.get("fetch") if isinstance(visual.get("fetch"), dict) else {}
    fetch_defaults = profile["visual"]["fetch"]
    normalized_fetch = dict(fetch_defaults)
    for key in fetch_defaults:
        if key in fetch:
            normalized_fetch[key] = fetch[key]
    try:
        normalized_fetch["workers"] = min(16, max(1, int(normalized_fetch["workers"])))
        normalized_fetch["timeout"] = min(120, max(3, int(normalized_fetch["timeout"])))
        normalized_fetch["max_bytes"] = min(10000000, max(250000, int(normalized_fetch["max_bytes"])))
    except (TypeError, ValueError):
        errors.append("visual.fetch workers, timeout, and max_bytes must be integers.")
        normalized_fetch = fetch_defaults
    normalized_fetch["verify_tls"] = bool(normalized_fetch.get("verify_tls", True))
    normalized_fetch["follow_redirects"] = bool(normalized_fetch.get("follow_redirects", True))
    normalized_fetch["include_nonmatches"] = bool(normalized_fetch.get("include_nonmatches", True))
    profile["visual"]["fetch"] = normalized_fetch

    if strict and errors:
        raise TemplateValidationError(errors)
    return profile, [*errors, *warnings]


def load_profile_json(data: bytes | str) -> tuple[dict[str, Any], list[str]]:
    try:
        text = data.decode("utf-8-sig") if isinstance(data, bytes) else str(data)
        payload = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TemplateValidationError([f"Invalid JSON: {exc}"]) from exc
    return normalize_profile(payload, strict=True)


def profile_summary(profile: dict[str, Any]) -> dict[str, Any]:
    normalized, warnings = normalize_profile(profile, strict=True)
    matrix = normalized["matrix"]
    visual = normalized["visual"]
    return {
        "name": normalized["name"],
        "template_id": normalized["template_id"],
        "schema_version": normalized["schema_version"],
        "base_intents": len([x for x in matrix["bases"].splitlines() if x.strip()]),
        "geographies": len([x for x in matrix["geographies"].splitlines() if x.strip()]),
        "query_templates": len([x for x in matrix["templates"].splitlines() if x.strip()]),
        "rules": len(visual["rules"]),
        "extractors": len(visual["extractors"]),
        "warnings": len(warnings),
    }


def starter_profile() -> dict[str, Any]:
    return _base_profile("New reusable hunt template", "An empty template for your own research scope.")


def load_bundled_profiles() -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    if not BUNDLED_PROFILE_ROOT.exists():
        return output
    for path in sorted(BUNDLED_PROFILE_ROOT.glob("*.json")):
        if path.name.endswith(".schema.json") or path.name == "template.schema.json":
            continue
        try:
            profile, _warnings = load_profile_json(path.read_bytes())
        except (OSError, TemplateValidationError):
            continue
        output[profile["name"]] = profile
    return output

def load_custom_profiles() -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for path in sorted(PROFILE_ROOT.glob("*.json")):
        try:
            profile, _warnings = load_profile_json(path.read_bytes())
        except (OSError, TemplateValidationError):
            continue
        output[profile["name"]] = profile
    return output


def all_profiles() -> dict[str, dict[str, Any]]:
    output = built_in_profiles()
    output.update(load_bundled_profiles())
    output.update(load_custom_profiles())
    return output


def save_custom_profile(payload: dict[str, Any], name: str | None = None) -> Path:
    source = deepcopy(payload)
    if name is not None:
        source["name"] = name.strip() or "Custom template"
    profile, _warnings = normalize_profile(source, strict=True)
    path = ensure_private_directory(PROFILE_ROOT) / f"{safe_profile_name(profile['name'])}.json"
    path.write_text(json.dumps(profile, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def delete_custom_profile(name: str) -> bool:
    path = PROFILE_ROOT / f"{safe_profile_name(name)}.json"
    if path.exists():
        path.unlink()
        return True
    return False


def save_matrix_draft(matrix: dict[str, Any]) -> None:
    try:
        ensure_private_directory(DRAFT_ROOT)
        MATRIX_DRAFT_PATH.write_text(json.dumps(matrix, indent=2, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def load_matrix_draft() -> dict[str, Any]:
    try:
        payload = json.loads(MATRIX_DRAFT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}
