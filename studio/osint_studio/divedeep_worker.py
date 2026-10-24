from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import socket
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup


USER_AGENT = "DiveDeep-DiveDeep/5.21 (+local authorized privacy research)"
MAX_BODY_BYTES = 2_000_000


def _emit(record: dict[str, Any]) -> None:
    print(json.dumps(record, ensure_ascii=False, sort_keys=True), flush=True)


def _public_host(hostname: str) -> None:
    if not hostname:
        raise ValueError("URL hostname is missing")
    try:
        records = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"DNS resolution failed for {hostname}: {exc}") from exc
    addresses = {record[4][0] for record in records}
    if not addresses:
        raise ValueError(f"No IP addresses resolved for {hostname}")
    for value in addresses:
        address = ipaddress.ip_address(value)
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            raise ValueError(f"Refusing non-public target address for {hostname}")


def _validate_public_url(value: str) -> str:
    url = value.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Expected one public HTTP or HTTPS URL")
    _public_host(parsed.hostname)
    return url


def search_text(query: str, max_results: int) -> int:
    from ddgs import DDGS

    results = DDGS().text(query, max_results=max(1, min(max_results, 100)))
    count = 0
    for item in results or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("href") or item.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        _emit(
            {
                "kind": "search-result",
                "query": query,
                "url": url,
                "title": str(item.get("title") or ""),
                "snippet": str(item.get("body") or item.get("snippet") or ""),
                "source": str(item.get("source") or urlparse(url).hostname or "web"),
            }
        )
        count += 1
    return count


def search_images(query: str, max_results: int) -> int:
    from ddgs import DDGS

    results = DDGS().images(query, max_results=max(1, min(max_results, 100)))
    count = 0
    for item in results or []:
        if not isinstance(item, dict):
            continue
        page_url = str(item.get("url") or item.get("source") or "").strip()
        image_url = str(item.get("image") or item.get("thumbnail") or "").strip()
        if not page_url.startswith(("http://", "https://")) and not image_url.startswith(("http://", "https://")):
            continue
        _emit(
            {
                "kind": "image-result",
                "query": query,
                "url": page_url or image_url,
                "imageUrl": image_url,
                "thumbnail": str(item.get("thumbnail") or ""),
                "title": str(item.get("title") or ""),
                "source": str(item.get("source") or urlparse(page_url or image_url).hostname or "image-search"),
                "width": item.get("width"),
                "height": item.get("height"),
            }
        )
        count += 1
    return count


def probe_url(url: str, timeout_seconds: int) -> int:
    current = _validate_public_url(url)
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5"})
    response = None
    for _ in range(4):
        response = session.get(current, timeout=max(5, min(timeout_seconds, 60)), allow_redirects=False, stream=True)
        if response.is_redirect or response.is_permanent_redirect:
            destination = urljoin(current, response.headers.get("location", ""))
            current = _validate_public_url(destination)
            continue
        break
    if response is None:
        raise RuntimeError("No HTTP response")
    body = bytearray()
    for chunk in response.iter_content(64 * 1024):
        body.extend(chunk)
        if len(body) >= MAX_BODY_BYTES:
            break
    raw = bytes(body[:MAX_BODY_BYTES])
    content_type = str(response.headers.get("content-type") or "")
    title = ""
    description = ""
    canonical = ""
    visible_text = ""
    if "html" in content_type.lower() or raw.lstrip().startswith(b"<"):
        soup = BeautifulSoup(raw, "html.parser")
        title = soup.title.get_text(" ", strip=True) if soup.title else ""
        description_node = soup.find("meta", attrs={"name": lambda value: str(value or "").lower() == "description"})
        description = str(description_node.get("content") or "").strip() if description_node else ""
        canonical_node = soup.find("link", attrs={"rel": lambda value: value and "canonical" in [str(v).lower() for v in (value if isinstance(value, list) else [value])]})
        canonical = urljoin(current, str(canonical_node.get("href") or "")) if canonical_node else ""
        for node in soup.select("script,style,noscript,template"):
            node.decompose()
        visible_text = soup.get_text(" ", strip=True)[:4000]
    _emit(
        {
            "kind": "page-probe",
            "requestedUrl": url,
            "url": current,
            "statusCode": response.status_code,
            "contentType": content_type,
            "title": title,
            "description": description,
            "canonicalUrl": canonical,
            "bodySha256": hashlib.sha256(raw).hexdigest(),
            "bytesCaptured": len(raw),
            "textPreview": visible_text,
        }
    )
    return 1


def fingerprint_photo(path_value: str) -> int:
    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"Photo file does not exist: {path}")
    raw = path.read_bytes()
    _emit(
        {
            "kind": "photo-fingerprint",
            "path": str(path),
            "name": path.name,
            "byteSize": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "suffix": path.suffix.lower(),
        }
    )
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bounded local workers for the DiveDeep DiveDeep workflow")
    sub = parser.add_subparsers(dest="command", required=True)

    text_parser = sub.add_parser("search-text")
    text_parser.add_argument("--query", required=True)
    text_parser.add_argument("--max-results", type=int, default=25)

    image_parser = sub.add_parser("search-images")
    image_parser.add_argument("--query", required=True)
    image_parser.add_argument("--max-results", type=int, default=20)

    probe_parser = sub.add_parser("probe-url")
    probe_parser.add_argument("--url", required=True)
    probe_parser.add_argument("--timeout", type=int, default=20)

    photo_parser = sub.add_parser("fingerprint-photo")
    photo_parser.add_argument("--path", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "search-text":
            search_text(args.query, args.max_results)
        elif args.command == "search-images":
            search_images(args.query, args.max_results)
        elif args.command == "probe-url":
            probe_url(args.url, args.timeout)
        else:
            fingerprint_photo(args.path)
        return 0
    except Exception as exc:  # CLI boundary: return a concise error to the local operator.
        print(json.dumps({"kind": "error", "error": f"{type(exc).__name__}: {exc}"}), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
