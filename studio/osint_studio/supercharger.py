from __future__ import annotations

import csv
import hashlib
import itertools
import string
import json
import os
import re
import sqlite3
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator
from urllib.parse import quote_plus, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .paths import JOB_ROOT


USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0 Safari/537.36 OSINTQueryStudio/4.0"
)

DEFAULT_JOB_ROOT = JOB_ROOT


@dataclass(frozen=True)
class QueryShard:
    query: str
    base: str = ""
    variant: str = ""
    geography: str = ""
    site: str = ""
    title_term: str = ""
    url_term: str = ""
    filetype: str = ""
    template: str = ""


@dataclass
class Candidate:
    url: str
    canonical_url: str = ""
    domain: str = ""
    title: str = ""
    snippet: str = ""
    provider: str = ""
    query: str = ""
    rank: int = 0
    discovered_at: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def finalize(self) -> "Candidate":
        self.canonical_url = canonical_url(self.canonical_url or self.url)
        self.url = normalize_url(self.url)
        self.domain = (urlparse(self.canonical_url or self.url).hostname or "").lower()
        if not self.discovered_at:
            self.discovered_at = utc_now()
        return self


@dataclass
class ProviderRunSummary:
    provider: str
    attempted: int = 0
    completed: int = 0
    failed: int = 0
    discovered: int = 0
    filtered: int = 0
    inserted: int = 0
    errors: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class CandidateFilter:
    excluded_domains: tuple[str, ...] = ()
    excluded_url_terms: tuple[str, ...] = ()
    excluded_title_terms: tuple[str, ...] = ()
    excluded_snippet_terms: tuple[str, ...] = ()
    required_url_terms: tuple[str, ...] = ()

    @classmethod
    def from_values(
        cls,
        *,
        excluded_domains: Iterable[str] = (),
        excluded_url_terms: Iterable[str] = (),
        excluded_title_terms: Iterable[str] = (),
        excluded_snippet_terms: Iterable[str] = (),
        required_url_terms: Iterable[str] = (),
    ) -> "CandidateFilter":
        return cls(
            excluded_domains=tuple(item.lower().removeprefix("www.").removeprefix("*.") for item in split_lines(excluded_domains)),
            excluded_url_terms=tuple(item.lower() for item in split_lines(excluded_url_terms)),
            excluded_title_terms=tuple(item.lower() for item in split_lines(excluded_title_terms)),
            excluded_snippet_terms=tuple(item.lower() for item in split_lines(excluded_snippet_terms)),
            required_url_terms=tuple(item.lower() for item in split_lines(required_url_terms)),
        )


@dataclass
class SuperchargerPlan:
    query_shards: list[QueryShard]
    providers: list[str]
    ddgs_backend: str = "auto"
    ddgs_results_per_query: int = 50
    brave_results_per_query: int = 100
    brave_api_key: str = ""
    brave_country: str = "US"
    brave_language: str = "en"
    urlscan_queries: list[str] = field(default_factory=list)
    urlscan_api_key: str = ""
    urlscan_max_results: int = 1000
    commoncrawl_patterns: list[str] = field(default_factory=list)
    commoncrawl_index: str = "latest"
    commoncrawl_max_results: int = 5000
    workers: int = 4
    delay_seconds: float = 0.25
    candidate_filter: CandidateFilter = field(default_factory=CandidateFilter)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_url(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if value.startswith("//"):
        value = "https:" + value
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    try:
        parsed = urlparse(value)
    except ValueError:
        return ""
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host or " " in host:
        return ""
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return ""
    if not re.fullmatch(r"[a-z0-9.-]+", host):
        return ""
    port = f":{parsed.port}" if parsed.port else ""
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    return urlunparse((parsed.scheme.lower(), host + port, path, "", parsed.query, ""))


def canonical_url(value: str) -> str:
    normalized = normalize_url(value)
    if not normalized:
        return ""
    parsed = urlparse(normalized)
    host = (parsed.hostname or "").lower().removeprefix("www.")
    port = f":{parsed.port}" if parsed.port else ""
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    if path != "/":
        path = path.rstrip("/")
    query = parsed.query
    # Remove common tracking parameters without destroying identity-bearing query strings.
    if query:
        kept: list[str] = []
        for part in query.split("&"):
            key = part.split("=", 1)[0].lower()
            if key.startswith("utm_") or key in {"fbclid", "gclid", "msclkid", "ref", "source"}:
                continue
            kept.append(part)
        query = "&".join(kept)
    return urlunparse((parsed.scheme, host + port, path, "", query, ""))


def split_lines(value: str | Iterable[str]) -> list[str]:
    if isinstance(value, str):
        values = value.splitlines()
    else:
        values = list(value)
    return [str(item).strip() for item in values if str(item).strip()]


def unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        value = str(value).strip()
        if value and value not in seen:
            seen.add(value)
            output.append(value)
    return output


def _template_fields(template: str) -> set[str]:
    fields: set[str] = set()
    formatter = string.Formatter()
    for _, field_name, _, _ in formatter.parse(template):
        if field_name:
            fields.add(field_name.split(".", 1)[0].split("[", 1)[0])
    return fields


def estimate_query_matrix_size(
    *,
    bases: Iterable[str],
    variants: Iterable[str] = (),
    geographies: Iterable[str] = (),
    sites: Iterable[str] = (),
    title_terms: Iterable[str] = (),
    url_terms: Iterable[str] = (),
    filetypes: Iterable[str] = (),
    templates: Iterable[str] = ("{base} {variant} {geo} {site_op} {title_op} {url_op} {filetype_op}",),
) -> dict[str, int]:
    values = {
        "base": split_lines(bases) or [""],
        "variant": split_lines(variants) or [""],
        "geo": split_lines(geographies) or [""],
        "site": split_lines(sites) or [""],
        "title": split_lines(title_terms) or [""],
        "url": split_lines(url_terms) or [""],
        "filetype": split_lines(filetypes) or [""],
    }
    aliases = {
        "base": {"base"},
        "variant": {"variant"},
        "geo": {"geo"},
        "site": {"site", "site_op"},
        "title": {"title", "title_op"},
        "url": {"url", "url_op"},
        "filetype": {"filetype", "filetype_op"},
    }
    output: dict[str, int] = {}
    for template in split_lines(templates) or ["{base} {variant} {geo} {site_op} {title_op} {url_op} {filetype_op}"]:
        fields = _template_fields(template)
        total = 1
        for name, names in aliases.items():
            if fields.intersection(names):
                total *= max(1, len(values[name]))
        output[template] = total
    return output


def build_query_matrix(
    *,
    bases: Iterable[str],
    variants: Iterable[str] = (),
    geographies: Iterable[str] = (),
    sites: Iterable[str] = (),
    title_terms: Iterable[str] = (),
    url_terms: Iterable[str] = (),
    filetypes: Iterable[str] = (),
    templates: Iterable[str] = ("{base} {variant} {geo} {site_op} {title_op} {url_op} {filetype_op}",),
    exclude_terms: Iterable[str] = (),
    max_queries: int = 5000,
) -> list[QueryShard]:
    values = {
        "base": split_lines(bases) or [""],
        "variant": split_lines(variants) or [""],
        "geo": split_lines(geographies) or [""],
        "site": split_lines(sites) or [""],
        "title": split_lines(title_terms) or [""],
        "url": split_lines(url_terms) or [""],
        "filetype": split_lines(filetypes) or [""],
    }
    aliases = {
        "base": {"base"},
        "variant": {"variant"},
        "geo": {"geo"},
        "site": {"site", "site_op"},
        "title": {"title", "title_op"},
        "url": {"url", "url_op"},
        "filetype": {"filetype", "filetype_op"},
    }
    templates_v = split_lines(templates) or ["{base} {variant} {geo} {site_op} {title_op} {url_op} {filetype_op}"]
    excludes = []
    for item in split_lines(exclude_terms):
        clean = item.lstrip("-").strip()
        if any(character.isspace() for character in clean) and not (clean.startswith('"') and clean.endswith('"')):
            clean = f'"{clean}"'
        excludes.append("-" + clean)

    def iterator_for(template: str) -> Iterator[QueryShard]:
        fields = _template_fields(template)
        unknown = fields.difference({name for group in aliases.values() for name in group})
        if unknown:
            raise ValueError(f"Unknown query-template placeholder(s): {', '.join(sorted(unknown))}")
        active_names = [name for name, names in aliases.items() if fields.intersection(names)]
        active_values = [values[name] for name in active_names]
        if not active_values:
            active_values = [[""]]
            active_names = ["_empty"]
        for combination in itertools.product(*active_values):
            selected = dict(zip(active_names, combination))
            base = selected.get("base", "")
            variant = selected.get("variant", "")
            geo = selected.get("geo", "")
            site = selected.get("site", "")
            title = selected.get("title", "")
            url_term = selected.get("url", "")
            filetype = selected.get("filetype", "")
            mapping = {
                "base": base,
                "variant": variant,
                "geo": geo,
                "site": site,
                "title": title,
                "url": url_term,
                "filetype": filetype,
                "site_op": f"site:{site}" if site else "",
                "title_op": f'intitle:"{title}"' if title else "",
                "url_op": f'inurl:"{url_term}"' if url_term else "",
                "filetype_op": f"filetype:{filetype.lstrip('.')}" if filetype else "",
            }
            query = " ".join(template.format(**mapping).split())
            if excludes:
                query = " ".join([query, *excludes]).strip()
            if query:
                yield QueryShard(
                    query=query,
                    base=base,
                    variant=variant,
                    geography=geo,
                    site=site,
                    title_term=title,
                    url_term=url_term,
                    filetype=filetype,
                    template=template,
                )

    # Interleave templates so one large template cannot consume the entire cap.
    iterators = [iter(iterator_for(template)) for template in templates_v]
    output: list[QueryShard] = []
    seen: set[str] = set()
    while iterators and len(output) < max_queries:
        next_round: list[Iterator[QueryShard]] = []
        for iterator in iterators:
            try:
                shard = next(iterator)
            except StopIteration:
                continue
            next_round.append(iterator)
            if shard.query in seen:
                continue
            seen.add(shard.query)
            output.append(shard)
            if len(output) >= max_queries:
                break
        iterators = next_round
    return output


def candidate_filter_reason(candidate: Candidate, filters: CandidateFilter | None) -> str:
    if not filters:
        return ""
    candidate.finalize()
    domain = candidate.domain.lower().removeprefix("www.")
    url = (candidate.canonical_url or candidate.url).lower()
    title = (candidate.title or "").lower()
    snippet = (candidate.snippet or "").lower()
    for blocked in filters.excluded_domains:
        if domain == blocked or domain.endswith("." + blocked):
            return f"excluded domain: {blocked}"
    for blocked in filters.excluded_url_terms:
        if blocked and blocked in url:
            return f"excluded URL term: {blocked}"
    for blocked in filters.excluded_title_terms:
        if blocked and blocked in title:
            return f"excluded title term: {blocked}"
    for blocked in filters.excluded_snippet_terms:
        if blocked and blocked in snippet:
            return f"excluded snippet term: {blocked}"
    if filters.required_url_terms and not any(term in url for term in filters.required_url_terms):
        return "missing required URL term"
    return ""


def candidate_allowed(candidate: Candidate, filters: CandidateFilter | None) -> bool:
    return not candidate_filter_reason(candidate, filters)


class JobStore:
    """Thread-safe SQLite accumulator for resumable high-volume discovery."""

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._initialize()

    def _connection(self) -> sqlite3.Connection:
        connection = getattr(self._local, "connection", None)
        if connection is None:
            connection = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.execute("PRAGMA busy_timeout=30000")
            self._local.connection = connection
        return connection

    def close(self) -> None:
        connection = getattr(self._local, "connection", None)
        if connection is not None:
            connection.close()
            self._local.connection = None

    def __enter__(self) -> JobStore:
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        self.close()

    def _initialize(self) -> None:
        connection = sqlite3.connect(self.path)
        try:
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS candidates (
                    canonical_url TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    domain TEXT,
                    title TEXT,
                    snippet TEXT,
                    first_provider TEXT,
                    best_rank INTEGER,
                    first_seen TEXT,
                    last_seen TEXT,
                    providers_json TEXT,
                    queries_json TEXT,
                    metadata_json TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_candidates_domain ON candidates(domain);
                CREATE TABLE IF NOT EXISTS query_runs (
                    provider TEXT NOT NULL,
                    query_hash TEXT NOT NULL,
                    query TEXT NOT NULL,
                    status TEXT NOT NULL,
                    result_count INTEGER DEFAULT 0,
                    inserted_count INTEGER DEFAULT 0,
                    error TEXT DEFAULT '',
                    started_at TEXT,
                    completed_at TEXT,
                    PRIMARY KEY(provider, query_hash)
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT,
                    level TEXT,
                    message TEXT
                );
                """
            )
            connection.commit()
        finally:
            connection.close()

    @staticmethod
    def query_hash(query: str) -> str:
        return hashlib.sha256(query.encode("utf-8", errors="replace")).hexdigest()[:24]

    def query_done(self, provider: str, query: str) -> bool:
        row = self._connection().execute(
            "SELECT status FROM query_runs WHERE provider=? AND query_hash=?",
            (provider, self.query_hash(query)),
        ).fetchone()
        return bool(row and row["status"] == "complete")

    def mark_query_started(self, provider: str, query: str) -> None:
        connection = self._connection()
        connection.execute(
            """
            INSERT INTO query_runs(provider, query_hash, query, status, started_at)
            VALUES(?, ?, ?, 'running', ?)
            ON CONFLICT(provider, query_hash) DO UPDATE SET
                status='running', error='', started_at=excluded.started_at
            """,
            (provider, self.query_hash(query), query, utc_now()),
        )
        connection.commit()

    def mark_query_complete(
        self,
        provider: str,
        query: str,
        *,
        result_count: int,
        inserted_count: int,
        error: str = "",
    ) -> None:
        status = "failed" if error else "complete"
        connection = self._connection()
        connection.execute(
            """
            INSERT INTO query_runs(provider, query_hash, query, status, result_count, inserted_count, error, started_at, completed_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, query_hash) DO UPDATE SET
                status=excluded.status,
                result_count=excluded.result_count,
                inserted_count=excluded.inserted_count,
                error=excluded.error,
                completed_at=excluded.completed_at
            """,
            (
                provider,
                self.query_hash(query),
                query,
                status,
                int(result_count),
                int(inserted_count),
                error[:2000],
                utc_now(),
                utc_now(),
            ),
        )
        connection.commit()

    def upsert_candidate(self, candidate: Candidate) -> bool:
        candidate.finalize()
        if not candidate.canonical_url:
            return False
        connection = self._connection()
        existing = connection.execute(
            "SELECT providers_json, queries_json, metadata_json, best_rank, title, snippet FROM candidates WHERE canonical_url=?",
            (candidate.canonical_url,),
        ).fetchone()
        inserted = existing is None
        if existing:
            providers = set(json.loads(existing["providers_json"] or "[]"))
            queries = set(json.loads(existing["queries_json"] or "[]"))
            metadata = json.loads(existing["metadata_json"] or "{}")
            providers.add(candidate.provider)
            if candidate.query:
                queries.add(candidate.query)
            metadata.update(candidate.metadata or {})
            best_rank = min(int(existing["best_rank"] or 999999), int(candidate.rank or 999999))
            title = candidate.title or existing["title"] or ""
            snippet = candidate.snippet or existing["snippet"] or ""
            connection.execute(
                """
                UPDATE candidates SET
                    url=?, domain=?, title=?, snippet=?, best_rank=?, last_seen=?,
                    providers_json=?, queries_json=?, metadata_json=?
                WHERE canonical_url=?
                """,
                (
                    candidate.url,
                    candidate.domain,
                    title,
                    snippet,
                    best_rank,
                    candidate.discovered_at,
                    json.dumps(sorted(providers), ensure_ascii=False),
                    json.dumps(sorted(queries), ensure_ascii=False),
                    json.dumps(metadata, ensure_ascii=False, sort_keys=True),
                    candidate.canonical_url,
                ),
            )
        else:
            connection.execute(
                """
                INSERT INTO candidates(
                    canonical_url, url, domain, title, snippet, first_provider, best_rank,
                    first_seen, last_seen, providers_json, queries_json, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate.canonical_url,
                    candidate.url,
                    candidate.domain,
                    candidate.title,
                    candidate.snippet,
                    candidate.provider,
                    int(candidate.rank or 0),
                    candidate.discovered_at,
                    candidate.discovered_at,
                    json.dumps([candidate.provider] if candidate.provider else [], ensure_ascii=False),
                    json.dumps([candidate.query] if candidate.query else [], ensure_ascii=False),
                    json.dumps(candidate.metadata or {}, ensure_ascii=False, sort_keys=True),
                ),
            )
        connection.commit()
        return inserted

    def log(self, level: str, message: str) -> None:
        connection = self._connection()
        connection.execute(
            "INSERT INTO events(created_at, level, message) VALUES (?, ?, ?)",
            (utc_now(), level, message[:5000]),
        )
        connection.commit()

    def counts(self) -> dict[str, int]:
        connection = self._connection()
        candidates = connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
        domains = connection.execute("SELECT COUNT(DISTINCT domain) FROM candidates").fetchone()[0]
        queries_complete = connection.execute("SELECT COUNT(*) FROM query_runs WHERE status='complete'").fetchone()[0]
        queries_failed = connection.execute("SELECT COUNT(*) FROM query_runs WHERE status='failed'").fetchone()[0]
        return {
            "candidates": int(candidates),
            "domains": int(domains),
            "queries_complete": int(queries_complete),
            "queries_failed": int(queries_failed),
        }

    def candidate_rows(self, limit: int | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM candidates ORDER BY domain, best_rank, canonical_url"
        params: tuple[Any, ...] = ()
        if limit:
            sql += " LIMIT ?"
            params = (int(limit),)
        rows = self._connection().execute(sql, params).fetchall()
        output: list[dict[str, Any]] = []
        for row in rows:
            output.append(
                {
                    "url": row["url"],
                    "canonical_url": row["canonical_url"],
                    "domain": row["domain"],
                    "title": row["title"],
                    "snippet": row["snippet"],
                    "best_rank": row["best_rank"],
                    "first_provider": row["first_provider"],
                    "providers": " | ".join(json.loads(row["providers_json"] or "[]")),
                    "queries": " | ".join(json.loads(row["queries_json"] or "[]")),
                    "first_seen": row["first_seen"],
                    "last_seen": row["last_seen"],
                    "metadata_json": row["metadata_json"],
                }
            )
        return output

    def domains(self, limit: int | None = None) -> list[str]:
        sql = "SELECT domain, COUNT(*) AS n FROM candidates WHERE domain <> '' GROUP BY domain ORDER BY n DESC, domain"
        params: tuple[Any, ...] = ()
        if limit:
            sql += " LIMIT ?"
            params = (int(limit),)
        return [row["domain"] for row in self._connection().execute(sql, params).fetchall()]

    def prune_candidates(self, filters: CandidateFilter) -> int:
        connection = self._connection()
        rows = connection.execute("SELECT canonical_url, url, domain, title, snippet FROM candidates").fetchall()
        remove: list[str] = []
        for row in rows:
            candidate = Candidate(
                url=row["url"],
                canonical_url=row["canonical_url"],
                domain=row["domain"],
                title=row["title"] or "",
                snippet=row["snippet"] or "",
            )
            if not candidate_allowed(candidate, filters):
                remove.append(row["canonical_url"])
        if remove:
            connection.executemany("DELETE FROM candidates WHERE canonical_url=?", [(item,) for item in remove])
            connection.commit()
        return len(remove)

    def clear(self) -> None:
        connection = self._connection()
        connection.executescript("DELETE FROM candidates; DELETE FROM query_runs; DELETE FROM events;")
        connection.commit()


def build_session(timeout: int = 20) -> requests.Session:
    retry = Retry(
        total=3,
        connect=3,
        read=2,
        status=2,
        backoff_factor=0.75,
        status_forcelist=(408, 425, 429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "HEAD"}),
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=30, pool_maxsize=30)
    session = requests.Session()
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
        }
    )
    return session


def search_ddgs(query: str, *, max_results: int, backend: str, timeout: int = 15) -> list[Candidate]:
    try:
        from ddgs import DDGS
    except ImportError as exc:
        raise RuntimeError("DDGS is unavailable. Install it with: pip install -U ddgs") from exc
    raw = DDGS(timeout=timeout).text(
        query,
        max_results=max_results,
        backend=backend or "auto",
        region="us-en",
        safesearch="moderate",
    )
    output: list[Candidate] = []
    for rank, item in enumerate(raw or [], start=1):
        url = str(item.get("href") or item.get("url") or "")
        candidate = Candidate(
            url=url,
            title=str(item.get("title") or ""),
            snippet=str(item.get("body") or item.get("snippet") or ""),
            provider="ddgs",
            query=query,
            rank=rank,
            metadata={"backend": backend or "auto"},
        ).finalize()
        if candidate.canonical_url:
            output.append(candidate)
    return output


def search_brave(
    query: str,
    *,
    api_key: str,
    max_results: int,
    country: str = "US",
    language: str = "en",
    timeout: int = 20,
) -> list[Candidate]:
    if not api_key:
        raise RuntimeError("Brave Search API key is required")
    session = build_session(timeout)
    output: list[Candidate] = []
    count = min(20, max(1, max_results))
    for offset in range(10):
        if len(output) >= max_results:
            break
        response = session.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={
                "q": query,
                "count": count,
                "offset": offset,
                "country": country,
                "search_lang": language,
                "safesearch": "moderate",
                "text_decorations": "false",
                "result_filter": "web",
            },
            headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()
        results = payload.get("web", {}).get("results", []) or []
        for item in results:
            candidate = Candidate(
                url=str(item.get("url") or ""),
                title=str(item.get("title") or ""),
                snippet=str(item.get("description") or ""),
                provider="brave",
                query=query,
                rank=len(output) + 1,
                metadata={"offset": offset},
            ).finalize()
            if candidate.canonical_url:
                output.append(candidate)
                if len(output) >= max_results:
                    break
        more = bool(payload.get("query", {}).get("more_results_available"))
        if not results or not more:
            break
    return output


def search_urlscan(
    query: str,
    *,
    api_key: str = "",
    max_results: int = 1000,
    page_size: int = 1000,
    timeout: int = 30,
) -> list[Candidate]:
    session = build_session(timeout)
    headers = {"Accept": "application/json"}
    if api_key:
        headers["API-Key"] = api_key
    output: list[Candidate] = []
    search_after = ""
    while len(output) < max_results:
        size = min(page_size, max_results - len(output))
        params: dict[str, Any] = {"q": query, "size": size}
        if search_after:
            params["search_after"] = search_after
        response = session.get(
            "https://urlscan.io/api/v1/search/",
            params=params,
            headers=headers,
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()
        results = payload.get("results", []) or []
        if not results:
            break
        for item in results:
            page = item.get("page", {}) or {}
            task = item.get("task", {}) or {}
            url = str(page.get("url") or task.get("url") or "")
            candidate = Candidate(
                url=url,
                title=str(page.get("title") or ""),
                snippet=str(page.get("domain") or task.get("domain") or ""),
                provider="urlscan",
                query=query,
                rank=len(output) + 1,
                metadata={
                    "scan_id": item.get("_id") or task.get("uuid"),
                    "scan_date": task.get("time"),
                    "ip": page.get("ip"),
                    "country": page.get("country"),
                    "status": page.get("status"),
                },
            ).finalize()
            if candidate.canonical_url:
                output.append(candidate)
                if len(output) >= max_results:
                    break
        search_after_value = results[-1].get("sort")
        if isinstance(search_after_value, list):
            search_after = ",".join(str(item) for item in search_after_value)
        else:
            search_after = str(search_after_value or "")
        if not payload.get("has_more") or not search_after:
            break
    return output


def latest_commoncrawl_index(timeout: int = 15) -> str:
    response = build_session(timeout).get("https://index.commoncrawl.org/collinfo.json", timeout=timeout)
    response.raise_for_status()
    payload = response.json()
    if not payload:
        raise RuntimeError("Common Crawl returned no index collections")
    return str(payload[0]["id"])


def search_commoncrawl(
    pattern: str,
    *,
    index_name: str = "latest",
    max_results: int = 5000,
    timeout: int = 30,
) -> list[Candidate]:
    index_name = latest_commoncrawl_index(timeout) if index_name in {"", "latest", "auto"} else index_name
    endpoint = f"https://index.commoncrawl.org/{index_name}-index"
    normalized_pattern = pattern.strip()
    if not normalized_pattern:
        return []
    params: dict[str, Any] = {
        "url": normalized_pattern,
        "output": "json",
        "filter": "status:200",
        "collapse": "urlkey",
        "limit": max_results,
    }
    if normalized_pattern.startswith("*."):
        params["matchType"] = "domain"
        params["url"] = normalized_pattern[2:]
    elif normalized_pattern.endswith("/*"):
        params["matchType"] = "prefix"
        params["url"] = normalized_pattern[:-1]
    response = build_session(timeout).get(endpoint, params=params, timeout=timeout)
    response.raise_for_status()
    output: list[Candidate] = []
    for rank, line in enumerate(response.text.splitlines(), start=1):
        if rank > max_results:
            break
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        candidate = Candidate(
            url=str(item.get("url") or ""),
            title="",
            snippet="",
            provider="commoncrawl",
            query=pattern,
            rank=rank,
            metadata={
                "crawl": index_name,
                "timestamp": item.get("timestamp"),
                "mime": item.get("mime"),
                "digest": item.get("digest"),
                "filename": item.get("filename"),
                "offset": item.get("offset"),
                "length": item.get("length"),
            },
        ).finalize()
        if candidate.canonical_url:
            output.append(candidate)
    return output


def extract_sitemap_urls(xml_text: str) -> tuple[list[str], list[str]]:
    """Return (page URLs, nested sitemap URLs)."""
    pages: list[str] = []
    sitemaps: list[str] = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return pages, sitemaps
    root_name = root.tag.rsplit("}", 1)[-1].lower()
    locations = [
        (node.text or "").strip()
        for node in root.iter()
        if node.tag.rsplit("}", 1)[-1].lower() == "loc" and (node.text or "").strip()
    ]
    if root_name == "sitemapindex":
        sitemaps.extend(locations)
    else:
        pages.extend(locations)
    return unique(pages), unique(sitemaps)


def discover_sitemaps(domain: str, *, timeout: int = 15) -> list[str]:
    domain = domain.strip().lower().removeprefix("www.")
    if not domain:
        return []
    session = build_session(timeout)
    base = f"https://{domain}/"
    candidates = [urljoin(base, "sitemap.xml"), urljoin(base, "sitemap_index.xml")]
    try:
        robots = session.get(urljoin(base, "robots.txt"), timeout=timeout)
        if robots.ok:
            for line in robots.text.splitlines():
                if line.lower().startswith("sitemap:"):
                    candidates.append(line.split(":", 1)[1].strip())
    except requests.RequestException:
        pass
    return unique(normalize_url(item) for item in candidates if normalize_url(item))


def expand_sitemaps(
    domains: Iterable[str],
    *,
    max_urls_per_domain: int = 1000,
    max_sitemaps_per_domain: int = 25,
    timeout: int = 20,
) -> list[Candidate]:
    session = build_session(timeout)
    output: list[Candidate] = []
    for domain in unique(domains):
        queue = discover_sitemaps(domain, timeout=timeout)
        seen_sitemaps: set[str] = set()
        page_urls: list[str] = []
        while queue and len(seen_sitemaps) < max_sitemaps_per_domain and len(page_urls) < max_urls_per_domain:
            sitemap_url = queue.pop(0)
            if sitemap_url in seen_sitemaps:
                continue
            seen_sitemaps.add(sitemap_url)
            try:
                response = session.get(sitemap_url, timeout=timeout)
                response.raise_for_status()
            except requests.RequestException:
                continue
            pages, nested = extract_sitemap_urls(response.text)
            for page_url in pages:
                normalized = normalize_url(page_url)
                if normalized and (urlparse(normalized).hostname or "").lower().removeprefix("www.") == domain.removeprefix("www."):
                    page_urls.append(normalized)
                    if len(page_urls) >= max_urls_per_domain:
                        break
            queue.extend(item for item in nested if item not in seen_sitemaps)
        for rank, url in enumerate(unique(page_urls)[:max_urls_per_domain], start=1):
            output.append(
                Candidate(
                    url=url,
                    provider="sitemap",
                    query=domain,
                    rank=rank,
                    metadata={"sitemaps_checked": len(seen_sitemaps)},
                ).finalize()
            )
    return output


def bounded_crawl(
    start_urls: Iterable[str],
    *,
    max_pages_per_domain: int = 100,
    depth: int = 1,
    timeout: int = 15,
) -> list[Candidate]:
    session = build_session(timeout)
    output: list[Candidate] = []
    per_domain_seen: dict[str, set[str]] = {}
    queue: list[tuple[str, int]] = [(normalize_url(item), 0) for item in start_urls if normalize_url(item)]
    while queue:
        current, current_depth = queue.pop(0)
        host = (urlparse(current).hostname or "").lower().removeprefix("www.")
        if not host:
            continue
        seen = per_domain_seen.setdefault(host, set())
        key = canonical_url(current)
        if not key or key in seen or len(seen) >= max_pages_per_domain:
            continue
        seen.add(key)
        output.append(
            Candidate(
                url=current,
                provider="bounded-crawl",
                query=host,
                rank=len(seen),
                metadata={"depth": current_depth},
            ).finalize()
        )
        if current_depth >= depth:
            continue
        try:
            response = session.get(current, timeout=timeout, allow_redirects=True)
            content_type = response.headers.get("content-type", "").lower()
            if not response.ok or "html" not in content_type:
                continue
        except requests.RequestException:
            continue
        soup = BeautifulSoup(response.text, "html.parser")
        for anchor in soup.find_all("a", href=True):
            href = str(anchor.get("href") or "").strip()
            if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
                continue
            absolute = normalize_url(urljoin(response.url, href))
            target_host = (urlparse(absolute).hostname or "").lower().removeprefix("www.")
            if absolute and target_host == host and canonical_url(absolute) not in seen:
                queue.append((absolute, current_depth + 1))
    return output


def _run_provider_query(
    provider: str,
    query: str,
    plan: SuperchargerPlan,
) -> list[Candidate]:
    if provider == "ddgs":
        return search_ddgs(
            query,
            max_results=plan.ddgs_results_per_query,
            backend=plan.ddgs_backend,
        )
    if provider == "brave":
        return search_brave(
            query,
            api_key=plan.brave_api_key,
            max_results=plan.brave_results_per_query,
            country=plan.brave_country,
            language=plan.brave_language,
        )
    if provider == "urlscan":
        return search_urlscan(
            query,
            api_key=plan.urlscan_api_key,
            max_results=plan.urlscan_max_results,
        )
    if provider == "commoncrawl":
        return search_commoncrawl(
            query,
            index_name=plan.commoncrawl_index,
            max_results=plan.commoncrawl_max_results,
        )
    raise ValueError(f"Unknown provider: {provider}")


def run_discovery_plan(
    plan: SuperchargerPlan,
    store: JobStore,
    *,
    resume: bool = True,
    progress_callback: Callable[[int, int, str, ProviderRunSummary], None] | None = None,
) -> dict[str, ProviderRunSummary]:
    tasks: list[tuple[str, str]] = []
    semantic_queries = [shard.query for shard in plan.query_shards]
    for provider in plan.providers:
        if provider in {"ddgs", "brave"}:
            provider_queries = semantic_queries
        elif provider == "urlscan":
            provider_queries = plan.urlscan_queries
        elif provider == "commoncrawl":
            provider_queries = plan.commoncrawl_patterns
        else:
            provider_queries = []
        for query in unique(provider_queries):
            if resume and store.query_done(provider, query):
                continue
            tasks.append((provider, query))

    summaries = {provider: ProviderRunSummary(provider=provider) for provider in plan.providers}
    for provider, _ in tasks:
        summaries[provider].attempted += 1
    total = len(tasks)
    completed = 0

    def process(provider: str, query: str) -> tuple[str, str, int, int, int, str]:
        store.mark_query_started(provider, query)
        try:
            candidates = _run_provider_query(provider, query, plan)
            accepted = [candidate for candidate in candidates if candidate_allowed(candidate, plan.candidate_filter)]
            filtered = len(candidates) - len(accepted)
            inserted = sum(1 for candidate in accepted if store.upsert_candidate(candidate))
            store.mark_query_complete(
                provider,
                query,
                result_count=len(candidates),
                inserted_count=inserted,
            )
            if plan.delay_seconds:
                time.sleep(max(0.0, float(plan.delay_seconds)))
            return provider, query, len(candidates), filtered, inserted, ""
        except Exception as exc:  # providers can fail independently
            error = f"{type(exc).__name__}: {exc}"
            store.mark_query_complete(provider, query, result_count=0, inserted_count=0, error=error)
            store.log("error", f"{provider} {query}: {error}")
            return provider, query, 0, 0, 0, error

    with ThreadPoolExecutor(max_workers=max(1, int(plan.workers))) as executor:
        future_map = {
            executor.submit(process, provider, query): (provider, query)
            for provider, query in tasks
        }
        for future in as_completed(future_map):
            provider, query, discovered, filtered, inserted, error = future.result()
            summary = summaries[provider]
            summary.completed += 1
            summary.discovered += discovered
            summary.filtered += filtered
            summary.inserted += inserted
            if error:
                summary.failed += 1
                if len(summary.errors) < 20:
                    summary.errors.append(f"{query}: {error}")
            completed += 1
            if progress_callback:
                progress_callback(completed, total, f"{provider}: {query}", summary)
    return summaries


def run_expansion(
    store: JobStore,
    *,
    sitemap_enabled: bool,
    sitemap_domain_limit: int,
    sitemap_urls_per_domain: int,
    crawl_enabled: bool,
    crawl_seed_limit: int,
    crawl_pages_per_domain: int,
    crawl_depth: int,
    workers: int = 4,
    candidate_filter: CandidateFilter | None = None,
    progress_callback: Callable[[int, int, str], None] | None = None,
) -> dict[str, int]:
    inserted_sitemap = 0
    inserted_crawl = 0
    jobs: list[tuple[str, Any]] = []
    if sitemap_enabled:
        for domain in store.domains(limit=sitemap_domain_limit):
            jobs.append(("sitemap", domain))
    if crawl_enabled:
        for row in store.candidate_rows(limit=crawl_seed_limit):
            jobs.append(("crawl", row["url"]))
    total = len(jobs)
    completed = 0

    def process(kind: str, value: str) -> tuple[str, int]:
        if kind == "sitemap":
            candidates = expand_sitemaps(
                [value],
                max_urls_per_domain=sitemap_urls_per_domain,
            )
        else:
            candidates = bounded_crawl(
                [value],
                max_pages_per_domain=crawl_pages_per_domain,
                depth=crawl_depth,
            )
        accepted = [candidate for candidate in candidates if candidate_allowed(candidate, candidate_filter)]
        inserted = sum(1 for candidate in accepted if store.upsert_candidate(candidate))
        return kind, inserted

    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        future_map = {executor.submit(process, kind, value): (kind, value) for kind, value in jobs}
        for future in as_completed(future_map):
            kind, value = future_map[future]
            try:
                result_kind, inserted = future.result()
                if result_kind == "sitemap":
                    inserted_sitemap += inserted
                else:
                    inserted_crawl += inserted
            except Exception as exc:
                store.log("error", f"Expansion {kind} {value}: {type(exc).__name__}: {exc}")
            completed += 1
            if progress_callback:
                progress_callback(completed, total, f"{kind}: {value}")
    return {"sitemap_inserted": inserted_sitemap, "crawl_inserted": inserted_crawl}


def rows_to_csv_bytes(rows: list[dict[str, Any]]) -> bytes:
    if not rows:
        return b""
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    from io import StringIO

    stream = StringIO()
    writer = csv.DictWriter(stream, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return ("\ufeff" + stream.getvalue()).encode("utf-8")


def job_path(job_name: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", (job_name or "discovery_job").strip()).strip("._")
    safe = safe or "discovery_job"
    return DEFAULT_JOB_ROOT / f"{safe}.sqlite"
