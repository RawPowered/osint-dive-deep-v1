from __future__ import annotations

import io
import json
import re
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urljoin, urlparse

import pandas as pd
import streamlit as st
from bs4 import BeautifulSoup

from .case_store import CaseStore
from .evidence_pipeline import ResearchEvidencePipeline
from .paths import CONTACT_ENRICHMENT_DATABASE_PATH, CONTACT_ENRICHMENT_ROOT, ensure_private_directory
from .web_recon import EMAIL_RE, PageRecord, SearchResult, email_exclusion_reason, expand_contact_markup, extract_contact_email_candidates, fetch_and_analyze


CONTACT_HINT_RE = re.compile(r"(?:contact|about|team|staff|support|location|customer[-_ ]?service|connect|reach[-_ ]?us)", re.I)
PHONE_LOOSE_RE = re.compile(r"(?<!\w)\+?\d[\d\s().-]{6,}\d(?!\w)")
ROLE_LOCALS = {"admin", "billing", "careers", "contact", "customerservice", "hello", "help", "hr", "info", "legal", "marketing", "office", "privacy", "sales", "service", "support", "team"}
PUBLIC_MAILBOX_DOMAINS = {"aol.com", "gmail.com", "hotmail.com", "icloud.com", "live.com", "mail.com", "outlook.com", "proton.me", "protonmail.com", "yahoo.com"}
SOCIAL_COLUMNS = {
    "facebook.com": "facebook_url",
    "instagram.com": "instagram_url",
    "linkedin.com": "linkedin_url",
    "youtube.com": "youtube_url",
    "youtu.be": "youtube_url",
    "x.com": "x_url",
    "twitter.com": "x_url",
    "tiktok.com": "tiktok_url",
}
CONTACT_EXTRACTOR_VERSION = "dom-contact-v2"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_domain(value: str) -> str:
    candidate = value.strip().lower()
    if not candidate:
        return ""
    if "@" in candidate and "://" not in candidate:
        candidate = candidate.rsplit("@", 1)[-1]
    if "://" in candidate:
        candidate = urlparse(candidate).hostname or ""
    candidate = candidate.split("/", 1)[0].split(":", 1)[0].strip(".")
    if not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", candidate, re.I):
        return ""
    return candidate.removeprefix("www.")


def normalize_phone(value: str) -> str:
    raw = value.strip()
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 10:
        return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    if raw.startswith("+") and 8 <= len(digits) <= 15:
        return "+" + digits
    return digits if 7 <= len(digits) <= 15 else ""


def split_values(value: Any) -> list[str]:
    if value is None:
        return []
    return [item.strip() for item in str(value).split(" | ") if item.strip()]


def _sanitize_output_emails(output: dict[str, Any]) -> dict[str, Any]:
    """Keep telemetry-shaped tokens out of contact columns without discarding evidence."""
    ignored = set(split_values(output.get("filtered_non_contact_emails")))
    email_fields = ("emails", "domain_emails", "external_published_emails", "role_emails", "other_published_emails")
    for key in email_fields:
        accepted: list[str] = []
        for value in split_values(output.get(key)):
            reason = email_exclusion_reason(value)
            if reason:
                ignored.add(f"{value.lower()} [reason={reason}]")
            else:
                accepted.append(value.lower())
        output[key] = " | ".join(dict.fromkeys(accepted))
    output["filtered_non_contact_emails"] = " | ".join(sorted(ignored))
    output["email_count"] = len(split_values(output.get("emails")))
    return output


class ContactEnrichmentStore:
    def __init__(self, path: Path = CONTACT_ENRICHMENT_DATABASE_PATH):
        self.path = path
        ensure_private_directory(CONTACT_ENRICHMENT_ROOT)
        self._initialize()

    def connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self.connection() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    case_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    source_filename TEXT NOT NULL,
                    source_artifact_id TEXT NOT NULL DEFAULT '',
                    domain_column TEXT NOT NULL DEFAULT '',
                    email_column TEXT NOT NULL DEFAULT '',
                    phone_column TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'ready',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    config_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_contact_jobs_case ON jobs(case_id, updated_at);
                CREATE TABLE IF NOT EXISTS rows (
                    job_id TEXT NOT NULL,
                    row_number INTEGER NOT NULL,
                    input_json TEXT NOT NULL,
                    domain TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending',
                    output_json TEXT NOT NULL DEFAULT '{}',
                    error TEXT NOT NULL DEFAULT '',
                    refreshed_at TEXT,
                    refresh_count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(job_id, row_number),
                    FOREIGN KEY(job_id) REFERENCES jobs(id)
                );
                CREATE INDEX IF NOT EXISTS idx_contact_rows_status ON rows(job_id, status, row_number);
                """
            )
        if Path(self.path).exists() and __import__("os").name == "posix":
            Path(self.path).chmod(0o600)

    def create_job(
        self,
        case_id: str,
        name: str,
        filename: str,
        frame: pd.DataFrame,
        *,
        domain_column: str,
        email_column: str,
        phone_column: str,
        source_artifact_id: str,
    ) -> str:
        job_id = f"contact-{uuid.uuid4().hex}"
        now = utc_now()
        records: list[tuple[Any, ...]] = []
        for index, row in frame.fillna("").astype(str).iterrows():
            values = row.to_dict()
            domain_source = values.get(domain_column, "") if domain_column else ""
            if not domain_source and email_column:
                domain_source = values.get(email_column, "")
            domain = normalize_domain(str(domain_source))
            status = "pending" if domain and domain not in PUBLIC_MAILBOX_DOMAINS else ("mailbox-domain-skipped" if domain in PUBLIC_MAILBOX_DOMAINS else "invalid-domain")
            records.append((job_id, int(index), json.dumps(values, ensure_ascii=False), domain, status))
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO jobs(id,case_id,name,source_filename,source_artifact_id,domain_column,email_column,phone_column,status,created_at,updated_at,config_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, case_id, name.strip() or filename, filename, source_artifact_id, domain_column, email_column, phone_column, "ready", now, now, "{}"),
            )
            connection.executemany("INSERT INTO rows(job_id,row_number,input_json,domain,status) VALUES(?,?,?,?,?)", records)
        return job_id

    def list_jobs(self, case_id: str) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """SELECT j.*,
                    (SELECT COUNT(*) FROM rows r WHERE r.job_id=j.id) AS row_count,
                    (SELECT COUNT(*) FROM rows r WHERE r.job_id=j.id AND r.status='complete') AS complete_count,
                    (SELECT COUNT(*) FROM rows r WHERE r.job_id=j.id AND r.status='failed') AS failed_count
                   FROM jobs j WHERE case_id=? ORDER BY j.updated_at DESC""",
                (case_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return dict(row) if row else None

    def list_rows(self, job_id: str, *, mode: str = "all", limit: int | None = 100_000, offset: int = 0) -> list[dict[str, Any]]:
        sql = "SELECT * FROM rows WHERE job_id=?"
        params: list[Any] = [job_id]
        if mode == "missing":
            sql += " AND status IN ('pending','failed')"
        elif mode == "refreshable":
            sql += " AND (status IN ('pending','failed') OR COALESCE(json_extract(output_json,'$.extractor_version'),'') != ? OR COALESCE(json_extract(output_json,'$.browser_dom_status'),'') IN ('','unavailable','failed'))"
            params.append(CONTACT_EXTRACTOR_VERSION)
        elif mode == "complete":
            sql += " AND status='complete'"
        sql += " ORDER BY row_number"
        if limit is not None:
            sql += " LIMIT ? OFFSET ?"
            params.extend([max(1, int(limit)), max(0, int(offset))])
        with self.connection() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def update_row(self, job_id: str, row_number: int, output: dict[str, Any], *, error: str = "") -> None:
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                "UPDATE rows SET status=?,output_json=?,error=?,refreshed_at=?,refresh_count=refresh_count+1 WHERE job_id=? AND row_number=?",
                ("failed" if error else "complete", json.dumps(output, ensure_ascii=False), error, now, job_id, row_number),
            )
            connection.execute("UPDATE jobs SET status='ready',updated_at=? WHERE id=?", (now, job_id))

    def set_job_status(self, job_id: str, status: str, config: dict[str, Any] | None = None) -> None:
        with self.connection() as connection:
            connection.execute("UPDATE jobs SET status=?,updated_at=?,config_json=? WHERE id=?", (status, utc_now(), json.dumps(config or {}, ensure_ascii=False), job_id))

    def export_frame(self, job_id: str) -> pd.DataFrame:
        values: list[dict[str, Any]] = []
        for row in self.list_rows(job_id, limit=None):
            source = json.loads(str(row.get("input_json") or "{}"))
            output = _sanitize_output_emails(json.loads(str(row.get("output_json") or "{}")))
            source.update({f"enriched_{key}": value for key, value in output.items()})
            source["enrichment_status"] = row.get("status")
            source["enrichment_error"] = row.get("error")
            source["enrichment_refreshed_at"] = row.get("refreshed_at")
            source["enrichment_refresh_count"] = row.get("refresh_count")
            values.append(source)
        return pd.DataFrame(values)


def _same_site(url: str, domain: str) -> bool:
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    return host == domain or host.endswith("." + domain)


def _contact_links(record: PageRecord, domain: str, limit: int) -> list[str]:
    if not record.raw_bytes or limit <= 0:
        return []
    base = str(record.fields.get("final_url") or record.fields.get("requested_url") or "")
    soup = BeautifulSoup(record.raw_bytes.decode(record.encoding or "utf-8", errors="replace"), "html.parser")
    candidates: list[tuple[int, str]] = []
    for node in soup.find_all("a", href=True):
        href = str(node.get("href") or "").strip()
        label = node.get_text(" ", strip=True)
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")) or not CONTACT_HINT_RE.search(href + " " + label):
            continue
        absolute = urljoin(base, href).split("#", 1)[0]
        if _same_site(absolute, domain):
            score = 0 if re.search(r"contact|reach[-_ ]?us", href + " " + label, re.I) else 1
            candidates.append((score, absolute))
    output: list[str] = []
    for _, url in sorted(candidates):
        if url not in output and url != base:
            output.append(url)
        if len(output) >= limit:
            break
    return output


def _page_contacts(record: PageRecord) -> dict[str, list[str]]:
    fields = record.fields
    emails = set(split_values(fields.get("emails")))
    ignored_emails = set(split_values(fields.get("filtered_email_candidates")))
    phones = set(split_values(fields.get("phones")))
    socials = set(split_values(fields.get("social_links")))
    addresses: set[str] = set()
    names: set[str] = set()
    forms: set[str] = set()
    if record.raw_bytes:
        text = record.raw_bytes.decode(record.encoding or "utf-8", errors="replace")
        decoded_text = expand_contact_markup(text)
        soup = BeautifulSoup(decoded_text, "html.parser")
        base = str(fields.get("final_url") or fields.get("requested_url") or "")
        for email in extract_contact_email_candidates(decoded_text, soup):
            reason = email_exclusion_reason(email)
            if reason:
                ignored_emails.add(f"{email} [reason={reason}]")
            else:
                emails.add(email)
        for node in soup.select('a[href^="mailto:"]'):
            email = str(node.get("href") or "")[7:].split("?", 1)[0].strip().lower()
            reason = email_exclusion_reason(email)
            if EMAIL_RE.fullmatch(email) and not reason:
                emails.add(email)
            elif reason:
                ignored_emails.add(f"{email} [reason={reason}]")
        for node in soup.select('a[href^="tel:"]'):
            phones.add(str(node.get("href") or "")[4:].strip())
        for match in PHONE_LOOSE_RE.finditer(soup.get_text(" ", strip=True)):
            candidate = match.group(0).strip()
            digits = re.sub(r"\D", "", candidate)
            if normalize_phone(candidate) and (candidate.startswith("+") or "(" in candidate or ")" in candidate or len(digits) >= 10):
                phones.add(candidate)
        for form in soup.find_all("form"):
            action = str(form.get("action") or "").strip()
            forms.add(urljoin(base, action) if action else base)

        def visit_json_ld(value: Any) -> None:
            if isinstance(value, list):
                for item in value:
                    visit_json_ld(item)
                return
            if not isinstance(value, dict):
                return
            kind = str(value.get("@type") or "")
            if kind in {"Organization", "LocalBusiness", "Person", "ProfessionalService"} and value.get("name"):
                names.add(str(value["name"]).strip())
            if value.get("email") and EMAIL_RE.fullmatch(str(value["email"]).replace("mailto:", "").strip()):
                email = str(value["email"]).replace("mailto:", "").strip().lower()
                reason = email_exclusion_reason(email)
                if reason:
                    ignored_emails.add(f"{email} [reason={reason}]")
                else:
                    emails.add(email)
            if value.get("telephone"):
                phones.add(str(value["telephone"]).strip())
            if kind == "PostalAddress":
                address = ", ".join(str(value.get(key) or "").strip() for key in ("streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry") if str(value.get(key) or "").strip())
                if address:
                    addresses.add(address)
            same_as = value.get("sameAs")
            for item in same_as if isinstance(same_as, list) else ([same_as] if same_as else []):
                if str(item).startswith(("http://", "https://")):
                    socials.add(str(item))
            for nested in value.values():
                if isinstance(nested, (dict, list)):
                    visit_json_ld(nested)

        for node in soup.select('script[type="application/ld+json"]'):
            try:
                visit_json_ld(json.loads(node.string or node.get_text(" ", strip=True) or "{}"))
            except (TypeError, json.JSONDecodeError):
                continue
    return {"emails": sorted(emails), "ignored_emails": sorted(ignored_emails), "phones": sorted(phones), "socials": sorted(socials), "addresses": sorted(addresses), "names": sorted(names), "forms": sorted(forms)}


def _capture_browser_dom(
    browser: Any,
    urls: list[str],
    *,
    timeout_ms: int,
    wait_ms: int,
    maximum_bytes: int,
) -> dict[str, Any]:
    """Render bounded pages and inspect the live anchor DOM for contact links."""
    emails: set[str] = set()
    ignored_emails: set[str] = set()
    phones: set[str] = set()
    socials: set[str] = set()
    snapshots: list[dict[str, Any]] = []
    context = browser.new_context()
    page = context.new_page()
    try:
        for requested_url in dict.fromkeys(url for url in urls if url.startswith(("http://", "https://"))):
            snapshot: dict[str, Any] = {"requested_url": requested_url, "final_url": requested_url, "captured_at": utc_now()}
            try:
                page.goto(requested_url, wait_until="domcontentloaded", timeout=max(1_000, int(timeout_ms)))
                if wait_ms:
                    page.wait_for_timeout(max(0, int(wait_ms)))
                anchors = page.eval_on_selector_all(
                    'a[href^="mailto:" i], a[href^="tel:" i], a[href*="facebook.com" i], a[href*="instagram.com" i], a[href*="linkedin.com" i], a[href*="youtube.com" i], a[href*="youtu.be" i], a[href*="twitter.com" i], a[href*="x.com" i], a[href*="tiktok.com" i]',
                    "nodes => nodes.map(node => ({raw_href: node.getAttribute('href') || '', href: node.href || '', text: (node.innerText || node.textContent || '').trim()}))",
                )
                page_emails: set[str] = set()
                page_ignored: set[str] = set()
                page_phones: set[str] = set()
                page_socials: set[str] = set()
                for anchor in anchors:
                    raw_href = unquote(str(anchor.get("raw_href") or "").strip())
                    href = str(anchor.get("href") or raw_href).strip()
                    if raw_href.lower().startswith("mailto:"):
                        address_part = raw_href[7:].split("?", 1)[0]
                        for match in EMAIL_RE.finditer(address_part):
                            email = match.group(1).lower()
                            reason = email_exclusion_reason(email)
                            if reason:
                                page_ignored.add(f"{email} [reason={reason}]")
                            else:
                                page_emails.add(email)
                    elif raw_href.lower().startswith("tel:"):
                        phone = raw_href[4:].split("?", 1)[0].strip()
                        if normalize_phone(phone):
                            page_phones.add(phone)
                    else:
                        host = (urlparse(href).hostname or "").lower().removeprefix("www.")
                        if any(host == social_host or host.endswith("." + social_host) for social_host in SOCIAL_COLUMNS):
                            page_socials.add(href)
                rendered_html = page.content()
                decoded_html = expand_contact_markup(rendered_html)
                rendered_soup = BeautifulSoup(decoded_html, "html.parser")
                for email in extract_contact_email_candidates(decoded_html, rendered_soup):
                    reason = email_exclusion_reason(email)
                    if reason:
                        page_ignored.add(f"{email} [reason={reason}]")
                    else:
                        page_emails.add(email)
                for node in rendered_soup.select('a[href^="tel:" i]'):
                    phone = unquote(str(node.get("href") or ""))[4:].split("?", 1)[0].strip()
                    if normalize_phone(phone):
                        page_phones.add(phone)
                visible_soup = BeautifulSoup(decoded_html, "html.parser")
                for node in visible_soup.select("script, style, noscript, template"):
                    node.decompose()
                for match in PHONE_LOOSE_RE.finditer(visible_soup.get_text(" ", strip=True)):
                    candidate = match.group(0).strip()
                    digits = re.sub(r"\D", "", candidate)
                    if normalize_phone(candidate) and (candidate.startswith("+") or "(" in candidate or ")" in candidate or len(digits) >= 10):
                        page_phones.add(candidate)
                rendered_bytes = rendered_html.encode("utf-8", errors="replace")
                html_bytes = rendered_bytes[: max(1, int(maximum_bytes))]
                snapshot.update(
                    {
                        "final_url": page.url,
                        "html_bytes": html_bytes,
                        "emails": sorted(page_emails),
                        "ignored_emails": sorted(page_ignored),
                        "phones": sorted(page_phones),
                        "socials": sorted(page_socials),
                        "anchor_count": len(anchors),
                        "content_bytes": len(html_bytes),
                        "content_bytes_before_limit": len(rendered_bytes),
                        "content_truncated": len(rendered_bytes) > len(html_bytes),
                        "status": "captured",
                    }
                )
                emails.update(page_emails)
                ignored_emails.update(page_ignored)
                phones.update(page_phones)
                socials.update(page_socials)
            except Exception as exc:
                snapshot.update({"status": "failed", "error": f"{type(exc).__name__}: {exc}"})
            snapshots.append(snapshot)
    finally:
        context.close()
    return {
        "emails": sorted(emails),
        "ignored_emails": sorted(ignored_emails),
        "phones": sorted(phones),
        "socials": sorted(socials),
        "snapshots": snapshots,
    }


def _merge_browser_contacts(output: dict[str, Any], domain: str, capture: dict[str, Any]) -> dict[str, Any]:
    emails = set(split_values(output.get("emails")))
    emails.update(str(value).lower() for value in capture.get("emails", []))
    ignored = set(split_values(output.get("filtered_non_contact_emails")))
    ignored.update(str(value) for value in capture.get("ignored_emails", []))
    accepted_emails: set[str] = set()
    for email in emails:
        reason = email_exclusion_reason(email)
        if reason:
            ignored.add(f"{email.lower()} [reason={reason}]")
        elif EMAIL_RE.fullmatch(email):
            accepted_emails.add(email.lower())

    phones = set(split_values(output.get("phones")))
    phones.update(str(value) for value in capture.get("phones", []))
    normalized_phones = sorted({value for phone in phones if (value := normalize_phone(phone))})
    socials = {value for column in set(SOCIAL_COLUMNS.values()) for value in split_values(output.get(column))}
    socials.update(str(value) for value in capture.get("socials", []))
    social_output = {column: [] for column in set(SOCIAL_COLUMNS.values())}
    for url in sorted(socials):
        host = (urlparse(url).hostname or "").lower().removeprefix("www.")
        for social_host, column in SOCIAL_COLUMNS.items():
            if host == social_host or host.endswith("." + social_host):
                social_output[column].append(url)
                break

    role_emails = sorted(email for email in accepted_emails if email.split("@", 1)[0].replace(".", "").replace("-", "").replace("_", "") in ROLE_LOCALS)
    domain_emails = sorted(email for email in accepted_emails if email.rsplit("@", 1)[-1] == domain or email.rsplit("@", 1)[-1].endswith("." + domain))
    output.update(
        {
            "emails": " | ".join(sorted(accepted_emails)),
            "domain_emails": " | ".join(domain_emails),
            "external_published_emails": " | ".join(sorted(accepted_emails.difference(domain_emails))),
            "filtered_non_contact_emails": " | ".join(sorted(ignored)),
            "role_emails": " | ".join(role_emails),
            "other_published_emails": " | ".join(sorted(accepted_emails.difference(role_emails))),
            "phones": " | ".join(sorted(phones)),
            "normalized_phones": " | ".join(normalized_phones),
            "email_count": len(accepted_emails),
            "phone_count": len(normalized_phones),
            "social_count": len(socials),
        }
    )
    output.update({key: " | ".join(values) for key, values in social_output.items()})
    captured = [item for item in capture.get("snapshots", []) if item.get("status") == "captured"]
    output["browser_dom_status"] = "complete" if captured else "failed"
    output["browser_dom_pages"] = len(captured)
    output["browser_dom_anchor_count"] = sum(int(item.get("anchor_count") or 0) for item in captured)
    output["browser_dom_email_count"] = len(capture.get("emails", []))
    output["browser_dom_phone_count"] = len({value for phone in capture.get("phones", []) if (value := normalize_phone(str(phone)))})
    output["browser_dom_checked_at"] = utc_now()
    failures = [str(item.get("error")) for item in capture.get("snapshots", []) if item.get("error")]
    output["browser_dom_error"] = " | ".join(failures)[:2000]
    return output


def enrich_domain(domain: str, *, maximum_pages: int, timeout: int, maximum_bytes: int) -> tuple[dict[str, Any], list[tuple[SearchResult, PageRecord]]]:
    homepage_target = SearchResult(url=f"https://{domain}/", title=domain, query=domain, source="contact-enrichment")
    homepage = fetch_and_analyze(homepage_target, timeout=timeout, max_bytes=maximum_bytes)
    if not homepage.fields.get("fetch_ok"):
        fallback_target = SearchResult(url=f"http://{domain}/", title=domain, query=domain, source="contact-enrichment")
        fallback = fetch_and_analyze(fallback_target, timeout=timeout, max_bytes=maximum_bytes)
        if fallback.fields.get("fetch_ok"):
            homepage_target, homepage = fallback_target, fallback
    pages: list[tuple[SearchResult, PageRecord]] = [(homepage_target, homepage)]
    if homepage.fields.get("fetch_ok"):
        for url in _contact_links(homepage, domain, max(0, maximum_pages - 1)):
            target = SearchResult(url=url, title="Contact page", query=domain, source="contact-enrichment")
            pages.append((target, fetch_and_analyze(target, timeout=timeout, max_bytes=maximum_bytes)))

    emails: set[str] = set()
    ignored_emails: set[str] = set()
    phones: set[str] = set()
    socials: set[str] = set()
    addresses: set[str] = set()
    names: set[str] = set()
    forms: set[str] = set()
    source_urls: list[str] = []
    footer_text: list[str] = []
    for _, record in pages:
        contacts = _page_contacts(record)
        emails.update(value.lower() for value in contacts["emails"])
        ignored_emails.update(contacts["ignored_emails"])
        phones.update(contacts["phones"])
        socials.update(contacts["socials"])
        addresses.update(contacts["addresses"])
        names.update(contacts["names"])
        forms.update(contacts["forms"])
        final_url = str(record.fields.get("final_url") or record.fields.get("requested_url") or "")
        if final_url:
            source_urls.append(final_url)
        footer = str(record.fields.get("footer_text") or "").strip()
        if footer:
            footer_text.append(footer)

    role_emails = sorted(email for email in emails if email.split("@", 1)[0].replace(".", "").replace("-", "").replace("_", "") in ROLE_LOCALS)
    other_emails = sorted(emails.difference(role_emails))
    domain_emails = sorted(email for email in emails if email.rsplit("@", 1)[-1] == domain or email.rsplit("@", 1)[-1].endswith("." + domain))
    external_emails = sorted(emails.difference(domain_emails))
    normalized_phones = sorted({value for phone in phones if (value := normalize_phone(phone))})
    social_output = {column: [] for column in set(SOCIAL_COLUMNS.values())}
    for url in sorted(socials):
        host = (urlparse(url).hostname or "").lower().removeprefix("www.")
        for social_host, column in SOCIAL_COLUMNS.items():
            if host == social_host or host.endswith("." + social_host):
                social_output[column].append(url)
                break
    fields = homepage.fields
    output: dict[str, Any] = {
        "domain": domain,
        "resolved_url": fields.get("final_url") or fields.get("requested_url") or "",
        "site_title": fields.get("title") or "",
        "published_names": " | ".join(sorted(names)),
        "published_addresses": " | ".join(sorted(addresses)),
        "emails": " | ".join(sorted(emails)),
        "domain_emails": " | ".join(domain_emails),
        "external_published_emails": " | ".join(external_emails),
        "filtered_non_contact_emails": " | ".join(sorted(ignored_emails)),
        "role_emails": " | ".join(role_emails),
        "other_published_emails": " | ".join(other_emails),
        "phones": " | ".join(sorted(phones)),
        "normalized_phones": " | ".join(normalized_phones),
        "contact_pages": " | ".join(dict.fromkeys(source_urls)),
        "contact_form_urls": " | ".join(sorted(forms)),
        "footer_contact_text": " | ".join(dict.fromkeys(footer_text))[:4000],
        "technologies": fields.get("technologies") or "",
        "email_count": len(emails),
        "phone_count": len(normalized_phones),
        "social_count": len(socials),
        "verification_status": "SITE_PUBLISHED_NOT_DELIVERABILITY_VERIFIED",
        "extractor_version": CONTACT_EXTRACTOR_VERSION,
        "checked_at": utc_now(),
        "pages_checked": len(pages),
        "fetch_status": "complete" if any(record.fields.get("fetch_ok") for _, record in pages) else "failed",
    }
    output.update({key: " | ".join(values) for key, values in social_output.items()})
    return output, pages


def run_enrichment_batch(
    store: ContactEnrichmentStore,
    case_store: CaseStore,
    job_id: str,
    rows: list[dict[str, Any]],
    *,
    maximum_pages: int,
    timeout: int,
    maximum_bytes: int,
    workers: int,
    browser_dom: bool,
    browser_wait_ms: int,
) -> dict[str, int]:
    job = store.get_job(job_id)
    if not job:
        raise ValueError("Unknown enrichment job.")
    case_id = str(job["case_id"])
    config = {
        "job_id": job_id,
        "rows": len(rows),
        "maximum_pages": maximum_pages,
        "timeout": timeout,
        "maximum_bytes": maximum_bytes,
        "workers": workers,
        "browser_dom": browser_dom,
        "browser_wait_ms": browser_wait_ms,
    }
    store.set_job_status(job_id, "running", config)
    pipeline = ResearchEvidencePipeline(case_store)
    run_id = pipeline.start_web_recon(case_id, {"workflow": "contact-enrichment", **config})
    completed = failed = pages_captured = 0
    errors: list[str] = []
    playwright_driver = None
    browser = None
    browser_start_error = ""
    try:
        if browser_dom:
            try:
                from playwright.sync_api import sync_playwright

                playwright_driver = sync_playwright().start()
                browser = playwright_driver.chromium.launch(headless=True)
            except Exception as exc:
                browser_start_error = f"{type(exc).__name__}: {exc}"
        with ThreadPoolExecutor(max_workers=max(1, min(20, workers))) as executor:
            future_rows = {
                executor.submit(enrich_domain, str(row["domain"]), maximum_pages=maximum_pages, timeout=timeout, maximum_bytes=maximum_bytes): row
                for row in rows
                if str(row.get("domain") or "")
            }
            for future in as_completed(future_rows):
                row = future_rows[future]
                row_number = int(row["row_number"])
                domain = str(row["domain"])
                try:
                    output, pages = future.result()
                    for target, record in pages:
                        pipeline.ingest_web_page(case_id, run_id, target, record, {"workflow": "contact-enrichment", "job_id": job_id, "row_number": row_number, "domain": domain})
                        pages_captured += 1
                    if browser_dom and browser is not None:
                        browser_urls = split_values(output.get("contact_pages"))[:maximum_pages]
                        if not browser_urls and output.get("resolved_url"):
                            browser_urls = [str(output["resolved_url"])]
                        capture = _capture_browser_dom(
                            browser,
                            browser_urls,
                            timeout_ms=int(timeout) * 1000,
                            wait_ms=browser_wait_ms,
                            maximum_bytes=maximum_bytes,
                        )
                        output = _merge_browser_contacts(output, domain, capture)
                        for snapshot in capture.get("snapshots", []):
                            content = snapshot.get("html_bytes")
                            if not isinstance(content, bytes) or not content:
                                continue
                            source_uri = str(snapshot.get("final_url") or snapshot.get("requested_url") or "")
                            snapshot_summary = {key: value for key, value in snapshot.items() if key != "html_bytes"}
                            artifact_id = case_store.record_artifact_bytes(
                                case_id,
                                content,
                                "browser-rendered-contact-dom",
                                run_id=run_id,
                                media_type="text/html",
                                encoding="utf-8",
                                source_uri=source_uri,
                                suffix=".html",
                                metadata={"workflow": "contact-enrichment", "job_id": job_id, "row_number": row_number, "domain": domain},
                            )
                            observation_id = case_store.record_observation(
                                case_id,
                                "browser-rendered-contact-dom",
                                snapshot_summary,
                                run_id=run_id,
                                normalized_value=domain,
                                source_name="DiveDeep Browser DOM Capture",
                                source_uri=source_uri,
                                confidence=0.95,
                                artifact_id=artifact_id,
                                metadata={"job_id": job_id, "row_number": row_number, "domain": domain},
                            )
                            case_store.add_evidence(
                                case_id,
                                "rendered-contact-anchor-scan",
                                json.dumps(snapshot_summary, ensure_ascii=False, sort_keys=True),
                                observation_id=observation_id,
                                artifact_id=artifact_id,
                                source_uri=source_uri,
                                metadata={"job_id": job_id, "row_number": row_number, "domain": domain},
                            )
                            pages_captured += 1
                    elif browser_dom:
                        output["browser_dom_status"] = "unavailable"
                        output["browser_dom_pages"] = 0
                        output["browser_dom_checked_at"] = utc_now()
                        output["browser_dom_error"] = browser_start_error
                    else:
                        output["browser_dom_status"] = "disabled"
                        output["browser_dom_pages"] = 0
                    output["extractor_version"] = CONTACT_EXTRACTOR_VERSION
                    output = _sanitize_output_emails(output)
                    error = "" if output.get("fetch_status") == "complete" else "No reachable HTML page was captured."
                    store.update_row(job_id, row_number, output, error=error)
                    if error:
                        failed += 1
                    else:
                        completed += 1
                    entity_id = case_store.upsert_entity(case_id, "domain", domain, confidence=1.0)
                    case_store.record_observation(case_id, "contact-enrichment-row", output, run_id=run_id, entity_id=entity_id, normalized_value=domain, source_name="DiveDeep Contact Enrichment", source_uri=str(output.get("resolved_url") or ""), confidence=0.9 if not error else 0.2, metadata={"job_id": job_id, "row_number": row_number})
                except Exception as exc:
                    error = f"{type(exc).__name__}: {exc}"
                    store.update_row(job_id, row_number, {}, error=error)
                    errors.append(f"{domain}: {error}")
                    failed += 1
        pipeline.finish_web_recon(run_id, [{"domain": row.get("domain")} for row in rows], error="" if not errors else f"{len(errors)} rows raised processing errors")
        store.set_job_status(job_id, "ready", config)
    except Exception as exc:
        pipeline.finish_web_recon(run_id, [], error=f"{type(exc).__name__}: {exc}")
        store.set_job_status(job_id, "failed", config)
        raise
    finally:
        if browser is not None:
            browser.close()
        if playwright_driver is not None:
            playwright_driver.stop()
    return {"attempted": len(rows), "completed": completed, "failed": failed, "pages_captured": pages_captured}


def _column_option(columns: list[str], value: str) -> str:
    return "Not mapped" if value == "" else value


def render_contact_enrichment(case_store: CaseStore, case_id: str) -> None:
    st.markdown("### CSV contact enrichment")
    st.caption("Visit supplied business or personal/professional domains, capture site-published email, phone, footer and social links, then merge the results back into the original rows.")
    store = ContactEnrichmentStore()
    upload = st.file_uploader("Source CSV", type=["csv"], key=f"contact_csv_{case_id}")
    if upload is not None:
        try:
            raw = upload.getvalue()
            frame = pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False)
        except Exception as exc:
            st.error(f"CSV could not be read: {type(exc).__name__}: {exc}")
            frame = pd.DataFrame()
        if not frame.empty:
            columns = [str(column) for column in frame.columns]
            options = ["", *columns]
            inferred_domain = next((column for column in columns if column.casefold() in {"domain", "website", "website_url", "url", "host", "hostname"}), "")
            inferred_email = next((column for column in columns if "email" in column.casefold()), "")
            inferred_phone = next((column for column in columns if "phone" in column.casefold() or "telephone" in column.casefold()), "")
            mapping = st.columns(3)
            domain_column = mapping[0].selectbox("Domain/website column", options, index=options.index(inferred_domain), format_func=lambda value: _column_option(columns, value))
            email_column = mapping[1].selectbox("Existing email column", options, index=options.index(inferred_email), format_func=lambda value: _column_option(columns, value))
            phone_column = mapping[2].selectbox("Existing phone column", options, index=options.index(inferred_phone), format_func=lambda value: _column_option(columns, value))
            name = st.text_input("Job name", value=Path(upload.name).stem)
            authorized = st.checkbox("I confirm the supplied domains are authorized for direct public-page collection and that exported contact data will be used lawfully.")
            if st.button("Create enrichment job", type="primary", disabled=not authorized, width="stretch"):
                if not domain_column and not email_column:
                    st.error("Map a domain/website column or an email column from which a business domain can be derived.")
                else:
                    artifact_id = case_store.record_artifact_bytes(case_id, raw, "contact-enrichment-source-csv", media_type="text/csv", encoding="utf-8", source_uri=upload.name, suffix=".csv", metadata={"rows": len(frame), "columns": columns})
                    job_id = store.create_job(case_id, name, upload.name, frame, domain_column=domain_column, email_column=email_column, phone_column=phone_column, source_artifact_id=artifact_id)
                    job_domains = sorted({str(row.get("domain") or "") for row in store.list_rows(job_id, limit=None) if str(row.get("domain") or "") and row.get("status") != "mailbox-domain-skipped"})
                    for domain in job_domains:
                        case_store.add_scope(case_id, "domain", domain, allowed=True, notes=f"Contact enrichment job {job_id}")
                        subject_id = case_store.add_subject(case_id, "domain", domain, primary_value=domain, metadata={"authorized_scope": True, "contact_enrichment_job": job_id})
                        case_store.add_identifier(case_id, "domain", domain, subject_id=subject_id, confidence=1.0, metadata={"authorized_scope": True, "contact_enrichment_job": job_id})
                    existing_targets = [str(value) for value in st.session_state.get(f"domain_security_targets_{case_id}", [])]
                    st.session_state[f"domain_security_targets_{case_id}"] = list(dict.fromkeys([*existing_targets, *job_domains]))
                    st.session_state[f"contact_job_{case_id}"] = job_id
                    st.success(f"Created job with {len(frame):,} rows.")
                    st.rerun()

    jobs = store.list_jobs(case_id)
    if not jobs:
        return
    by_id = {str(job["id"]): job for job in jobs}
    if st.session_state.get(f"contact_job_{case_id}") not in by_id:
        st.session_state[f"contact_job_{case_id}"] = next(iter(by_id))
    job_id = st.selectbox("Enrichment job", list(by_id), format_func=lambda value: f"{by_id[value]['name']} · {by_id[value]['complete_count']}/{by_id[value]['row_count']} complete", key=f"contact_job_{case_id}")
    job = by_id[job_id]
    metrics = st.columns(3)
    metrics[0].metric("Rows", int(job["row_count"]))
    metrics[1].metric("Complete", int(job["complete_count"]))
    metrics[2].metric("Failed", int(job["failed_count"]))
    controls = st.columns(4)
    run_mode = controls[0].selectbox("Refresh mode", ("Incomplete or extractor upgrade", "Refresh all"))
    batch_size = controls[1].number_input("Rows this batch", 1, max(1, int(job["row_count"])), min(100, max(1, int(job["row_count"]))))
    maximum_pages = controls[2].number_input("Pages per domain", 1, 5, 3)
    workers = controls[3].number_input("Concurrent domains", 1, 20, 5)
    advanced = st.columns(2)
    timeout = advanced[0].number_input("Request timeout", 5, 60, 15)
    maximum_mb = advanced[1].selectbox("Maximum page capture", (1, 2, 4), index=1, format_func=lambda value: f"{value} MB")
    browser_controls = st.columns(2)
    browser_dom = browser_controls[0].checkbox("Render browser DOM for dynamic contact links", value=True, help="Loads the selected public pages in local headless Chromium and reads live mailto:, tel: and social anchors.")
    browser_wait_ms = browser_controls[1].number_input("DOM settle time (ms)", 0, 5000, 1500, step=250, disabled=not browser_dom)
    if browser_dom:
        st.caption("Browser capture reuses one local Chromium process per batch. If Chromium is missing, run `./run.sh --install-browser`; static collection still completes.")
    start_row = st.number_input("Start row for Refresh all", 0, max(0, int(job["row_count"]) - 1), 0, disabled=run_mode != "Refresh all")
    acknowledge = st.checkbox("Run or refresh this authorized batch now.")
    if st.button("Run contact enrichment", type="primary", disabled=not acknowledge, width="stretch"):
        mode = "refreshable" if run_mode == "Incomplete or extractor upgrade" else "all"
        rows = [row for row in store.list_rows(job_id, mode=mode, limit=int(batch_size), offset=int(start_row) if mode == "all" else 0) if row.get("status") not in {"invalid-domain", "mailbox-domain-skipped"}]
        if not rows:
            st.info("No eligible rows remain for this refresh mode.")
        else:
            with st.status("Collecting public contact evidence…", expanded=True) as status:
                try:
                    summary = run_enrichment_batch(
                        store,
                        case_store,
                        job_id,
                        rows,
                        maximum_pages=int(maximum_pages),
                        timeout=int(timeout),
                        maximum_bytes=int(maximum_mb) * 1024 * 1024,
                        workers=int(workers),
                        browser_dom=bool(browser_dom),
                        browser_wait_ms=int(browser_wait_ms),
                    )
                    status.update(label=f"Enrichment complete · {summary['completed']} rows", state="complete")
                    st.rerun()
                except Exception as exc:
                    status.update(label="Enrichment failed", state="error")
                    st.error(f"{type(exc).__name__}: {exc}")

    export = store.export_frame(job_id)
    preview_columns = [column for column in ("enriched_domain", "enriched_browser_dom_status", "enriched_browser_dom_email_count", "enriched_site_title", "enriched_domain_emails", "enriched_other_published_emails", "enriched_filtered_non_contact_emails", "enriched_normalized_phones", "enriched_facebook_url", "enriched_instagram_url", "enriched_linkedin_url", "enrichment_status", "enrichment_refreshed_at") if column in export.columns]
    if preview_columns:
        st.dataframe(export[preview_columns], width="stretch", hide_index=True)
    st.download_button("Download enriched CSV", export.to_csv(index=False), file_name=f"{Path(str(job['source_filename'])).stem}-enriched.csv", mime="text/csv", width="stretch")
