from __future__ import annotations

import csv
import html as html_lib
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable
from urllib.parse import unquote, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0 Safari/537.36 OSINTQueryStudio/5.0"
)

EMAIL_RE = re.compile(r"(?<![A-Z0-9._%+-])([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63})(?![A-Z0-9._%+-])", re.I)
PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[\s.()-]*)?(?:\(?\d{3}\)?[\s.()-]*)\d{3}[\s.-]*\d{4}(?!\d)")
SOCIAL_HOSTS = {
    "facebook.com": "facebook_links",
    "instagram.com": "instagram_links",
    "linkedin.com": "linkedin_links",
    "youtube.com": "youtube_links",
    "youtu.be": "youtube_links",
    "x.com": "x_links",
    "twitter.com": "x_links",
    "tiktok.com": "tiktok_links",
}
NON_CONTACT_EMAIL_DOMAINS = ("sentry.io", "sentry-cdn.com")


def email_exclusion_reason(value: str) -> str:
    """Classify machine endpoints that match email syntax but are not contacts."""
    candidate = value.strip().lower()
    if "@" not in candidate:
        return "invalid-email"
    _, domain = candidate.rsplit("@", 1)
    if any(domain == blocked or domain.endswith("." + blocked) for blocked in NON_CONTACT_EMAIL_DOMAINS):
        return "telemetry-endpoint"
    return ""


def expand_contact_markup(value: str) -> str:
    """Decode common HTML/JavaScript escapes used around published contact links."""
    expanded = html_lib.unescape(value or "").replace(r"\/", "/")
    expanded = re.sub(r"\\u([0-9a-fA-F]{4})", lambda match: chr(int(match.group(1), 16)), expanded)
    expanded = re.sub(r"\\x([0-9a-fA-F]{2})", lambda match: chr(int(match.group(1), 16)), expanded)
    return html_lib.unescape(expanded)


def decode_cloudflare_email(value: str) -> str:
    candidate = value.strip().split("#", 1)[-1]
    if not re.fullmatch(r"[0-9a-fA-F]+", candidate) or len(candidate) < 4 or len(candidate) % 2:
        return ""
    try:
        key = int(candidate[:2], 16)
        return "".join(chr(int(candidate[index : index + 2], 16) ^ key) for index in range(2, len(candidate), 2))
    except (TypeError, ValueError):
        return ""


def extract_contact_email_candidates(raw_html: str, soup: BeautifulSoup | None = None) -> list[str]:
    """Extract literal, escaped, attribute-backed and Cloudflare-protected emails."""
    expanded = expand_contact_markup(raw_html)
    parsed = soup or BeautifulSoup(expanded, "html.parser")
    visible_text = element_text(parsed)
    candidates = {match.group(1).lower() for match in EMAIL_RE.finditer(expanded + "\n" + visible_text)}
    for node in parsed.select("a[href], [data-email], [data-mail], [data-contact]"):
        for attribute in ("href", "data-email", "data-mail", "data-contact"):
            value = expand_contact_markup(unquote(str(node.get(attribute) or "")))
            if value.lower().startswith("mailto:"):
                value = value[7:].split("?", 1)[0]
            candidates.update(match.group(1).lower() for match in EMAIL_RE.finditer(value))
    for node in parsed.select("[data-cfemail]"):
        decoded = decode_cloudflare_email(str(node.get("data-cfemail") or ""))
        if EMAIL_RE.fullmatch(decoded):
            candidates.add(decoded.lower())
    for match in re.finditer(r"/cdn-cgi/l/email-protection#([0-9a-fA-F]+)", expanded, re.I):
        decoded = decode_cloudflare_email(match.group(1))
        if EMAIL_RE.fullmatch(decoded):
            candidates.add(decoded.lower())
    return sorted(candidates)

DEFAULT_RESULT_FIELDS = [
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
    "content_type",
    "response_time_ms",
    "content_bytes",
    "fetched_at",
    "title",
    "meta_description",
    "canonical_url",
    "language",
    "h1",
    "h2",
    "header_text",
    "footer_text",
    "script_srcs",
    "footer_script_srcs",
    "inline_script_count",
    "footer_inline_script_count",
    "emails",
    "filtered_email_candidates",
    "phones",
    "social_links",
    "facebook_links",
    "instagram_links",
    "linkedin_links",
    "youtube_links",
    "x_links",
    "robots_meta",
    "generator",
    "technologies",
    "match_passed",
    "match_score",
    "matched_rules",
    "failed_rules",
    "error",
]

OPTIONAL_LARGE_FIELDS = [
    "head_html_snippet",
    "header_html_snippet",
    "body_text_snippet",
    "footer_html_snippet",
    "scripts_text_snippet",
    "footer_scripts_text_snippet",
]

RULE_SECTIONS = [
    "URL",
    "Search title",
    "Search snippet",
    "Page title",
    "Meta description",
    "Head HTML",
    "Visible header",
    "Body text",
    "Visible footer",
    "All scripts",
    "Footer scripts",
    "Full HTML",
]

RULE_OPERATORS = [
    "contains",
    "does not contain",
    "equals",
    "starts with",
    "ends with",
    "regex",
    "exists",
    "does not exist",
]

EXTRACTOR_SOURCES = [
    "Full HTML",
    "Page text",
    "Head HTML",
    "Visible header",
    "Visible footer",
    "All scripts",
    "Footer scripts",
]

EXTRACTOR_METHODS = ["Regex", "CSS text", "CSS attribute", "JSON-LD key"]


@dataclass(frozen=True)
class SearchResult:
    url: str
    title: str = ""
    snippet: str = ""
    rank: int = 0
    query: str = ""
    source: str = "web-search"


@dataclass
class PageRecord:
    fields: dict[str, Any]
    sections: dict[str, str] = field(default_factory=dict, repr=False)
    soup: BeautifulSoup | None = field(default=None, repr=False)
    json_ld: list[Any] = field(default_factory=list, repr=False)
    raw_bytes: bytes = field(default=b"", repr=False)
    response_headers: dict[str, str] = field(default_factory=dict, repr=False)
    encoding: str = ""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_url(value: str) -> str:
    value = html_lib.unescape((value or "").strip())
    if not value:
        return ""
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    try:
        parsed = urlparse(value)
    except ValueError:
        return ""
    if not parsed.hostname:
        return ""
    host = parsed.hostname.lower().rstrip(".")
    if " " in host or not re.fullmatch(r"[a-z0-9.-]+", host):
        return ""
    if "." not in host and host != "localhost":
        return ""
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return ""
    port = f":{parsed.port}" if parsed.port else ""
    path = parsed.path or "/"
    return urlunparse((parsed.scheme.lower(), host + port, path, "", parsed.query, ""))


def canonical_result_url(value: str) -> str:
    normalized = normalize_url(value)
    if not normalized:
        return ""
    parsed = urlparse(normalized)
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    if path != "/":
        path = path.rstrip("/")
    return urlunparse((parsed.scheme, parsed.netloc.lower(), path, "", parsed.query, ""))


def build_search_query(
    *,
    base_terms: str = "",
    exact_phrases: str = "",
    any_terms: str = "",
    exclude_terms: str = "",
    site: str = "",
    title_terms: str = "",
    url_terms: str = "",
    filetype: str = "",
    custom_syntax: str = "",
) -> str:
    parts: list[str] = []
    if base_terms.strip():
        parts.append(base_terms.strip())
    for phrase in split_lines(exact_phrases):
        parts.append(f'"{phrase}"')
    any_values = split_tokens(any_terms)
    if any_values:
        parts.append("(" + " OR ".join(any_values) + ")")
    for value in split_tokens(exclude_terms):
        clean = value.lstrip("-").strip()
        if any(character.isspace() for character in clean) and not (clean.startswith('"') and clean.endswith('"')):
            clean = f'"{clean}"'
        parts.append("-" + clean)
    if site.strip():
        site_value = site.strip().removeprefix("https://").removeprefix("http://").strip("/")
        parts.append(f"site:{site_value}")
    for value in split_lines(title_terms):
        parts.append(f'intitle:"{value}"')
    for value in split_lines(url_terms):
        parts.append(f'inurl:"{value}"')
    if filetype.strip():
        parts.append(f"filetype:{filetype.strip().lstrip('.')}")
    if custom_syntax.strip():
        parts.append(custom_syntax.strip())
    return " ".join(parts).strip()


def split_lines(value: str) -> list[str]:
    return [line.strip() for line in (value or "").splitlines() if line.strip()]


def split_tokens(value: str) -> list[str]:
    return [token.strip() for token in re.split(r"[,\n]+", value or "") if token.strip()]


def discover_urls(
    query: str,
    *,
    max_results: int = 25,
    backend: str = "auto",
    region: str = "us-en",
    safesearch: str = "moderate",
    timelimit: str | None = None,
    timeout: int = 10,
) -> list[SearchResult]:
    if not query.strip():
        return []
    try:
        from ddgs import DDGS
    except ImportError as exc:
        raise RuntimeError("The ddgs package is not installed. Run: pip install -U ddgs") from exc

    client = DDGS(timeout=timeout)
    raw_results = client.text(
        query,
        region=region,
        safesearch=safesearch,
        timelimit=timelimit or None,
        max_results=max_results,
        backend=backend or "auto",
    )
    output: list[SearchResult] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_results or [], start=1):
        raw_url = str(item.get("href") or item.get("url") or "")
        url = canonical_result_url(raw_url)
        if not url or url in seen:
            continue
        seen.add(url)
        output.append(
            SearchResult(
                url=url,
                title=str(item.get("title") or "").strip(),
                snippet=str(item.get("body") or item.get("snippet") or "").strip(),
                rank=index,
                query=query,
                source="ddgs",
            )
        )
    return output


def make_session() -> requests.Session:
    retry = Retry(
        total=2,
        connect=2,
        read=1,
        status=1,
        backoff_factor=0.5,
        status_forcelist=(408, 425, 429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "HEAD"}),
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=20, pool_maxsize=20)
    session = requests.Session()
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7",
            "Accept-Language": "en-US,en;q=0.8",
        }
    )
    return session


def fetch_and_analyze(
    target: SearchResult,
    *,
    timeout: int = 15,
    verify_tls: bool = True,
    follow_redirects: bool = True,
    max_bytes: int = 2_500_000,
) -> PageRecord:
    requested_url = normalize_url(target.url)
    base_fields: dict[str, Any] = {
        "input_source": target.source,
        "search_query": target.query,
        "search_rank": target.rank,
        "search_title": target.title,
        "search_snippet": target.snippet,
        "requested_url": requested_url,
        "final_url": "",
        "domain": urlparse(requested_url).hostname or "",
        "status_code": "",
        "fetch_ok": False,
        "content_type": "",
        "response_time_ms": "",
        "content_bytes": 0,
        "fetched_at": utc_now(),
        "error": "",
    }
    if not requested_url:
        base_fields["error"] = "Invalid URL"
        return PageRecord(fields=base_fields)

    started = time.monotonic()
    try:
        session = make_session()
        with session.get(
            requested_url,
            timeout=timeout,
            allow_redirects=follow_redirects,
            verify=verify_tls,
            stream=True,
        ) as response:
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                remaining = max_bytes - total
                if remaining <= 0:
                    break
                chunks.append(chunk[:remaining])
                total += min(len(chunk), remaining)
                if total >= max_bytes:
                    break
            raw = b"".join(chunks)
            encoding = response.encoding or response.apparent_encoding or "utf-8"
            html_text = raw.decode(encoding, errors="replace")
            content_type = response.headers.get("content-type", "")
            base_fields.update(
                {
                    "final_url": response.url,
                    "domain": urlparse(response.url).hostname or base_fields["domain"],
                    "status_code": response.status_code,
                    "fetch_ok": bool(200 <= response.status_code < 400 and ("html" in content_type.lower() or "<html" in html_text[:1000].lower())),
                    "content_type": content_type,
                    "response_time_ms": round((time.monotonic() - started) * 1000),
                    "content_bytes": len(raw),
                }
            )
            if not base_fields["fetch_ok"]:
                base_fields["error"] = f"Non-HTML or unsuccessful response: HTTP {response.status_code} {content_type}".strip()
            record = analyze_html(html_text, base_fields)
            record.raw_bytes = raw
            record.response_headers = {str(key): str(value) for key, value in response.headers.items()}
            record.encoding = encoding
            return record
    except requests.RequestException as exc:
        base_fields["response_time_ms"] = round((time.monotonic() - started) * 1000)
        base_fields["error"] = f"{type(exc).__name__}: {exc}"
        return PageRecord(fields=base_fields)


def analyze_html(raw_html: str, base_fields: dict[str, Any] | None = None) -> PageRecord:
    fields = dict(base_fields or {})
    soup = BeautifulSoup(raw_html or "", "html.parser")
    html_node = soup.find("html")
    head = soup.find("head")
    header = soup.find("header")
    footer = soup.find("footer")
    body = soup.find("body")

    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    meta_description = first_meta_content(soup, (("name", "description"), ("property", "og:description")))
    canonical = ""
    canonical_node = soup.select_one("link[rel~='canonical'][href]")
    if canonical_node:
        canonical = urljoin(str(fields.get("final_url") or fields.get("requested_url") or ""), canonical_node.get("href", "").strip())
    language = html_node.get("lang", "").strip() if html_node else ""
    h1_values = unique_text(node.get_text(" ", strip=True) for node in soup.find_all("h1"))
    h2_values = unique_text(node.get_text(" ", strip=True) for node in soup.find_all("h2"))

    visible_header = element_text(header)
    visible_footer = element_text(footer)
    body_text = element_text(body)
    head_html = str(head or "")
    header_html = str(header or "")
    footer_html = str(footer or "")

    all_scripts = soup.find_all("script")
    footer_scripts = footer.find_all("script") if footer else []
    script_srcs = absolute_script_sources(all_scripts, str(fields.get("final_url") or fields.get("requested_url") or ""))
    footer_script_srcs = absolute_script_sources(footer_scripts, str(fields.get("final_url") or fields.get("requested_url") or ""))
    inline_scripts = [script_text(script) for script in all_scripts if not script.get("src") and script_text(script)]
    footer_inline_scripts = [script_text(script) for script in footer_scripts if not script.get("src") and script_text(script)]
    scripts_text = "\n".join([*script_srcs, *inline_scripts])
    footer_scripts_text = "\n".join([*footer_script_srcs, *footer_inline_scripts])

    link_sets = extract_links(soup, str(fields.get("final_url") or fields.get("requested_url") or ""))
    page_text = element_text(soup)
    email_candidates = extract_contact_email_candidates(raw_html, soup)
    emails = [value for value in email_candidates if not email_exclusion_reason(value)]
    filtered_emails = [f"{value} [reason={email_exclusion_reason(value)}]" for value in email_candidates if email_exclusion_reason(value)]
    phones = sorted({normalize_space(match.group(0)) for match in PHONE_RE.finditer(page_text)})

    json_ld: list[Any] = []
    for node in soup.select("script[type='application/ld+json']"):
        raw = node.string or node.get_text(" ", strip=True)
        if not raw:
            continue
        try:
            json_ld.append(json.loads(raw))
        except (TypeError, ValueError):
            continue

    generator = first_meta_content(soup, (("name", "generator"),))
    technologies = detect_technologies(raw_html, generator, script_srcs)
    robots_meta = first_meta_content(soup, (("name", "robots"), ("name", "googlebot")))

    fields.update(
        {
            "title": title,
            "meta_description": meta_description,
            "canonical_url": canonical,
            "language": language,
            "h1": join_values(h1_values),
            "h2": join_values(h2_values),
            "header_text": truncate(visible_header, 4000),
            "footer_text": truncate(visible_footer, 4000),
            "script_srcs": join_values(script_srcs),
            "footer_script_srcs": join_values(footer_script_srcs),
            "inline_script_count": len(inline_scripts),
            "footer_inline_script_count": len(footer_inline_scripts),
            "emails": join_values(emails),
            "filtered_email_candidates": join_values(filtered_emails),
            "phones": join_values(phones),
            "social_links": join_values(link_sets["social_links"]),
            "facebook_links": join_values(link_sets["facebook_links"]),
            "instagram_links": join_values(link_sets["instagram_links"]),
            "linkedin_links": join_values(link_sets["linkedin_links"]),
            "youtube_links": join_values(link_sets["youtube_links"]),
            "x_links": join_values(link_sets["x_links"]),
            "tiktok_links": join_values(link_sets["tiktok_links"]),
            "robots_meta": robots_meta,
            "generator": generator,
            "technologies": join_values(technologies),
            "head_html_snippet": truncate(head_html, 12000),
            "header_html_snippet": truncate(header_html, 12000),
            "body_text_snippet": truncate(body_text, 12000),
            "footer_html_snippet": truncate(footer_html, 12000),
            "scripts_text_snippet": truncate(scripts_text, 12000),
            "footer_scripts_text_snippet": truncate(footer_scripts_text, 12000),
        }
    )

    sections = {
        "URL": str(fields.get("final_url") or fields.get("requested_url") or ""),
        "Search title": str(fields.get("search_title") or ""),
        "Search snippet": str(fields.get("search_snippet") or ""),
        "Page title": title,
        "Meta description": meta_description,
        "Head HTML": head_html,
        "Visible header": visible_header,
        "Body text": body_text,
        "Visible footer": visible_footer,
        "All scripts": scripts_text,
        "Footer scripts": footer_scripts_text,
        "Full HTML": raw_html,
        "Page text": page_text,
    }
    return PageRecord(fields=fields, sections=sections, soup=soup, json_ld=json_ld)


def first_meta_content(soup: BeautifulSoup, candidates: Iterable[tuple[str, str]]) -> str:
    for attribute, value in candidates:
        node = soup.find("meta", attrs={attribute: re.compile(rf"^{re.escape(value)}$", re.I)})
        if node and node.get("content"):
            return normalize_space(str(node.get("content")))
    return ""


def element_text(element: Any) -> str:
    if element is None:
        return ""
    clone = BeautifulSoup(str(element), "html.parser")
    for node in clone(["script", "style", "noscript", "svg", "template"]):
        node.extract()
    return normalize_space(clone.get_text(" ", strip=True))


def script_text(script: Any) -> str:
    return normalize_space(script.string or script.get_text(" ", strip=True) or "")


def absolute_script_sources(scripts: Iterable[Any], base_url: str) -> list[str]:
    values: list[str] = []
    for script in scripts:
        src = str(script.get("src") or "").strip()
        if src:
            values.append(urljoin(base_url, src))
    return unique(values)


def extract_links(soup: BeautifulSoup, base_url: str) -> dict[str, list[str]]:
    output = {"social_links": [], **{value: [] for value in SOCIAL_HOSTS.values()}}
    for node in soup.find_all("a", href=True):
        href = str(node.get("href") or "").strip()
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        absolute = canonical_result_url(urljoin(base_url, href))
        if not absolute:
            continue
        host = (urlparse(absolute).hostname or "").lower().removeprefix("www.").removeprefix("m.")
        for social_host, field_name in SOCIAL_HOSTS.items():
            if host == social_host or host.endswith("." + social_host):
                output[field_name].append(absolute)
                output["social_links"].append(absolute)
                break
    return {key: unique(values) for key, values in output.items()}


def detect_technologies(raw_html: str, generator: str, script_srcs: Iterable[str]) -> list[str]:
    haystack = (raw_html + "\n" + generator + "\n" + "\n".join(script_srcs)).lower()
    signatures = {
        "WordPress": ("wp-content", "wp-includes", "wordpress"),
        "Wix": ("wixstatic.com", "wix.com"),
        "Squarespace": ("static1.squarespace.com", "squarespace"),
        "Webflow": ("webflow.js", "data-wf-page"),
        "Shopify": ("cdn.shopify.com", "shopify.theme"),
        "Next.js": ("/_next/", "__next_data__"),
        "React": ("react", "data-reactroot"),
        "Vue": ("vue.js", "vue.min.js", "data-v-"),
        "Angular": ("ng-version", "angular.min.js"),
        "Google Tag Manager": ("googletagmanager.com", "gtm.js"),
        "Google Analytics": ("google-analytics.com", "gtag("),
        "Cloudflare": ("cdn-cgi", "cloudflare"),
        "GoHighLevel": ("leadconnectorhq.com", "msgsndr.com", "gohighlevel"),
        "Jotform": ("jotform.com", "form.jotform"),
    }
    return [name for name, markers in signatures.items() if any(marker in haystack for marker in markers)]


def evaluate_rules(
    record: PageRecord,
    rules: list[dict[str, Any]],
    *,
    within_group: str = "AND",
    between_groups: str = "AND",
    minimum_score: float = 0.0,
) -> dict[str, Any]:
    active_rules = [rule for rule in rules if str(rule.get("Value", "")).strip() or str(rule.get("Operator", "")) in {"exists", "does not exist"}]
    if not active_rules:
        return {
            "match_passed": True,
            "match_score": 100.0,
            "matched_rules": "",
            "failed_rules": "",
        }

    group_results: dict[str, list[bool]] = {}
    group_logic: dict[str, str] = {}
    matched: list[str] = []
    failed: list[str] = []
    total_weight = 0.0
    matched_weight = 0.0
    required_failed = False

    for index, rule in enumerate(active_rules, start=1):
        group = str(rule.get("Group") or "A").strip() or "A"
        section = str(rule.get("Section") or "Body text")
        operator = str(rule.get("Operator") or "contains").lower()
        value = str(rule.get("Value") or "")
        case_sensitive = bool(rule.get("Case sensitive", False))
        required = bool(rule.get("Required", False))
        row_logic = str(rule.get("Group logic") or "").upper().strip()
        if row_logic in {"AND", "OR"}:
            group_logic[group] = row_logic
        try:
            weight = max(float(rule.get("Weight", 1) or 1), 0.0)
        except (TypeError, ValueError):
            weight = 1.0
        corpus = record.sections.get(section, "")
        result = match_value(corpus, operator, value, case_sensitive=case_sensitive)
        group_results.setdefault(group, []).append(result)
        label = f"{group}.{index} {section} {operator} {value!r}"
        if result:
            matched.append(label)
            matched_weight += weight
        else:
            failed.append(label)
            if required:
                required_failed = True
        total_weight += weight

    group_passes: list[bool] = []
    for group, values in group_results.items():
        logic = group_logic.get(group, within_group.upper())
        group_passes.append(all(values) if logic == "AND" else any(values))
    overall = all(group_passes) if between_groups.upper() == "AND" else any(group_passes)
    score = round((matched_weight / total_weight * 100.0) if total_weight else 100.0, 2)
    overall = bool(overall and not required_failed and score >= float(minimum_score))
    return {
        "match_passed": overall,
        "match_score": score,
        "matched_rules": " | ".join(matched),
        "failed_rules": " | ".join(failed),
    }


def match_value(corpus: str, operator: str, value: str, *, case_sensitive: bool = False) -> bool:
    corpus = corpus or ""
    value = value or ""
    left = corpus if case_sensitive else corpus.lower()
    right = value if case_sensitive else value.lower()
    if operator == "contains":
        return right in left
    if operator == "does not contain":
        return right not in left
    if operator == "equals":
        return left.strip() == right.strip()
    if operator == "starts with":
        return left.strip().startswith(right.strip())
    if operator == "ends with":
        return left.strip().endswith(right.strip())
    if operator == "regex":
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            return re.search(value, corpus, flags=flags) is not None
        except re.error:
            return False
    if operator == "exists":
        return bool(corpus.strip())
    if operator == "does not exist":
        return not bool(corpus.strip())
    return False


def apply_custom_extractors(record: PageRecord, extractors: list[dict[str, Any]]) -> dict[str, str]:
    output: dict[str, str] = {}
    for extractor in extractors:
        name = clean_column_name(str(extractor.get("Column name") or ""))
        if not name:
            continue
        method = str(extractor.get("Method") or "Regex")
        source = str(extractor.get("Source") or "Full HTML")
        pattern = str(extractor.get("Pattern or selector") or "")
        attribute = str(extractor.get("Attribute") or "")
        multiple = bool(extractor.get("Multiple", True))
        values: list[str] = []
        try:
            if method == "Regex":
                corpus = record.sections.get(source, record.sections.get("Full HTML", ""))
                matches = re.findall(pattern, corpus, flags=re.I | re.S) if pattern else []
                for match in matches:
                    if isinstance(match, tuple):
                        values.append(" ".join(str(part) for part in match if part))
                    else:
                        values.append(str(match))
            elif method in {"CSS text", "CSS attribute"} and record.soup is not None and pattern:
                nodes = record.soup.select(pattern)
                for node in nodes:
                    if method == "CSS text":
                        values.append(normalize_space(node.get_text(" ", strip=True)))
                    elif attribute:
                        raw_value = node.get(attribute)
                        if isinstance(raw_value, list):
                            values.append(" ".join(str(item) for item in raw_value))
                        elif raw_value is not None:
                            values.append(str(raw_value))
            elif method == "JSON-LD key" and pattern:
                for document in record.json_ld:
                    values.extend(str(value) for value in find_json_key(document, pattern) if value is not None)
        except (re.error, ValueError, TypeError) as exc:
            output[name] = f"EXTRACTOR_ERROR: {exc}"
            continue
        values = unique(normalize_space(value) for value in values if normalize_space(value))
        output[name] = join_values(values if multiple else values[:1])
    return output


def find_json_key(value: Any, path: str) -> list[Any]:
    parts = [part for part in path.split(".") if part]
    if not parts:
        return []
    current = [value]
    for part in parts:
        next_values: list[Any] = []
        for item in current:
            if isinstance(item, dict):
                if part == "*":
                    next_values.extend(item.values())
                elif part in item:
                    next_values.append(item[part])
            elif isinstance(item, list):
                if part == "*":
                    next_values.extend(item)
                elif part.isdigit() and int(part) < len(item):
                    next_values.append(item[int(part)])
                else:
                    for child in item:
                        if isinstance(child, dict) and part in child:
                            next_values.append(child[part])
        current = next_values
    flattened: list[Any] = []
    for item in current:
        if isinstance(item, list):
            flattened.extend(item)
        elif isinstance(item, dict):
            flattened.append(json.dumps(item, ensure_ascii=False, sort_keys=True))
        else:
            flattened.append(item)
    return flattened


def run_recon(
    targets: list[SearchResult],
    *,
    rules: list[dict[str, Any]],
    extractors: list[dict[str, Any]],
    selected_fields: list[str],
    workers: int = 4,
    timeout: int = 15,
    verify_tls: bool = True,
    follow_redirects: bool = True,
    max_bytes: int = 2_500_000,
    within_group: str = "AND",
    between_groups: str = "AND",
    minimum_score: float = 0.0,
    include_nonmatches: bool = True,
    progress_callback: Callable[[int, int, str], None] | None = None,
    result_callback: Callable[[SearchResult, PageRecord, dict[str, Any]], None] | None = None,
) -> list[dict[str, Any]]:
    unique_targets: list[SearchResult] = []
    seen: set[str] = set()
    for target in targets:
        key = canonical_result_url(target.url)
        if key and key not in seen:
            seen.add(key)
            unique_targets.append(target)

    total = len(unique_targets)
    completed = 0
    records: list[tuple[int, dict[str, Any]]] = []

    def process(index: int, target: SearchResult) -> tuple[int, dict[str, Any]]:
        record = fetch_and_analyze(
            target,
            timeout=timeout,
            verify_tls=verify_tls,
            follow_redirects=follow_redirects,
            max_bytes=max_bytes,
        )
        rule_result = evaluate_rules(
            record,
            rules,
            within_group=within_group,
            between_groups=between_groups,
            minimum_score=minimum_score,
        )
        record.fields.update(rule_result)
        record.fields.update(apply_custom_extractors(record, extractors))
        chosen = list(dict.fromkeys([*selected_fields, *[clean_column_name(str(item.get("Column name") or "")) for item in extractors]]))
        output = {field: record.fields.get(field, "") for field in chosen if field}
        if result_callback:
            try:
                result_callback(target, record, output)
            except Exception as exc:
                output["evidence_ingest_error"] = f"{type(exc).__name__}: {exc}"
        return index, output

    max_workers = max(1, min(int(workers), 16))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(process, index, target): (index, target) for index, target in enumerate(unique_targets)}
        for future in as_completed(futures):
            index, target = futures[future]
            try:
                item_index, row = future.result()
            except Exception as exc:  # defensive boundary for individual pages
                item_index = index
                row = {field: "" for field in selected_fields}
                row.update(
                    {
                        "requested_url": target.url,
                        "search_query": target.query,
                        "search_rank": target.rank,
                        "search_title": target.title,
                        "search_snippet": target.snippet,
                        "fetch_ok": False,
                        "match_passed": False,
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
            completed += 1
            if include_nonmatches or bool(row.get("match_passed")):
                records.append((item_index, row))
            if progress_callback:
                progress_callback(completed, total, target.url)

    return [row for _, row in sorted(records, key=lambda item: item[0])]


def targets_from_urls(values: Iterable[str], source: str = "url-list") -> list[SearchResult]:
    output: list[SearchResult] = []
    for index, value in enumerate(values, start=1):
        url = normalize_url(str(value))
        if url:
            output.append(SearchResult(url=url, rank=index, source=source))
    return output


def filter_targets(
    targets: Iterable[SearchResult],
    *,
    excluded_domains: Iterable[str] = (),
    excluded_url_terms: Iterable[str] = (),
    excluded_title_terms: Iterable[str] = (),
    excluded_snippet_terms: Iterable[str] = (),
    required_url_terms: Iterable[str] = (),
) -> tuple[list[SearchResult], list[dict[str, str]]]:
    def lines(value: Iterable[str] | str) -> list[str]:
        if isinstance(value, str):
            return split_lines(value)
        return [str(item).strip() for item in value if str(item).strip()]

    blocked_domains = [item.lower().removeprefix("www.").removeprefix("*.") for item in lines(excluded_domains)]
    blocked_urls = [item.lower() for item in lines(excluded_url_terms)]
    blocked_titles = [item.lower() for item in lines(excluded_title_terms)]
    blocked_snippets = [item.lower() for item in lines(excluded_snippet_terms)]
    required_urls = [item.lower() for item in lines(required_url_terms)]
    kept: list[SearchResult] = []
    skipped: list[dict[str, str]] = []
    for target in targets:
        normalized = normalize_url(target.url)
        parsed = urlparse(normalized) if normalized else None
        domain = ((parsed.hostname if parsed else "") or "").lower().removeprefix("www.")
        url_text = normalized.lower()
        title = (target.title or "").lower()
        snippet = (target.snippet or "").lower()
        reason = ""
        for blocked in blocked_domains:
            if domain == blocked or domain.endswith("." + blocked):
                reason = f"excluded domain: {blocked}"
                break
        if not reason:
            for blocked in blocked_urls:
                if blocked and blocked in url_text:
                    reason = f"excluded URL term: {blocked}"
                    break
        if not reason:
            for blocked in blocked_titles:
                if blocked and blocked in title:
                    reason = f"excluded title term: {blocked}"
                    break
        if not reason:
            for blocked in blocked_snippets:
                if blocked and blocked in snippet:
                    reason = f"excluded snippet term: {blocked}"
                    break
        if not reason and required_urls and not any(term in url_text for term in required_urls):
            reason = "missing required URL term"
        if reason:
            skipped.append({"url": target.url, "title": target.title, "reason": reason})
        else:
            kept.append(target)
    return kept, skipped


def dataframe_to_csv_bytes(rows: list[dict[str, Any]]) -> bytes:
    if not rows:
        return b""
    columns: list[str] = []
    for row in rows:
        for key in row:
            if key not in columns:
                columns.append(key)
    from io import StringIO

    buffer = StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8-sig")


def normalize_space(value: str) -> str:
    return " ".join((value or "").split())


def truncate(value: str, length: int) -> str:
    value = value or ""
    return value if len(value) <= length else value[: max(0, length - 3)] + "..."


def unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        value = str(value).strip()
        if value and value not in seen:
            seen.add(value)
            output.append(value)
    return output


def unique_text(values: Iterable[str]) -> list[str]:
    return unique(normalize_space(value) for value in values if normalize_space(value))


def join_values(values: Iterable[str]) -> str:
    return " | ".join(unique(values))


def clean_column_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_]+", "_", value.strip()).strip("_")
    return value[:80]
