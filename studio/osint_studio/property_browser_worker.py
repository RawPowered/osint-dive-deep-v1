from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


FLORIDA_DOR_OFFICIALS_URL = "https://floridarevenue.com/property/Pages/LocalOfficials.aspx"


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-.")[:80] or "capture"


class BrowserState:
    def __init__(self, context: BrowserContext, capture_root: Path):
        self.context = context
        self.capture_root = capture_root
        self.capture_root.mkdir(parents=True, exist_ok=True)
        self.source_keys: dict[int, str] = {}

    def pages(self) -> list[Page]:
        return list(self.context.pages)

    def tab_values(self) -> list[dict[str, Any]]:
        output = []
        for index, page in enumerate(self.pages()):
            try:
                title = page.title()
            except Exception:
                title = ""
            output.append({"index": index, "url": page.url, "title": title, "source_key": self.source_keys.get(id(page), "")})
        return output

    def open(self, url: str, source_key: str) -> dict[str, Any]:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Only absolute HTTP or HTTPS public-source URLs can be opened.")
        page = self.context.new_page()
        self.source_keys[id(page)] = source_key
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        return self.tab_values()[-1]

    def capture(self, index: int, screenshot: bool) -> dict[str, Any]:
        pages = self.pages()
        if index < 0 or index >= len(pages):
            raise IndexError("Browser tab no longer exists; refresh the tab list.")
        page = pages[index]
        page.wait_for_load_state("domcontentloaded", timeout=30_000)
        captured_at = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        source_key = self.source_keys.get(id(page), "browser")
        stem = f"{captured_at}-{_safe_name(source_key)}-{index}"
        dom_bytes = page.content().encode("utf-8", errors="surrogatepass")
        dom_path = self.capture_root / f"{stem}.html"
        dom_path.write_bytes(dom_bytes)
        screenshot_path = ""
        if screenshot:
            image_path = self.capture_root / f"{stem}.png"
            page.screenshot(path=str(image_path), full_page=True)
            screenshot_path = str(image_path)
        if os.name == "posix":
            dom_path.chmod(0o600)
            if screenshot_path:
                Path(screenshot_path).chmod(0o600)
        return {
            "index": index,
            "url": page.url,
            "title": page.title(),
            "source_key": source_key,
            "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "dom_path": str(dom_path),
            "dom_sha256": hashlib.sha256(dom_bytes).hexdigest(),
            "dom_bytes": len(dom_bytes),
            "screenshot_path": screenshot_path,
        }

    def resolve_florida_appraiser(self, county: str) -> dict[str, Any]:
        county_name = re.sub(r"\s+County$", "", county.strip(), flags=re.IGNORECASE).upper()
        if not county_name:
            raise ValueError("County is required.")
        page = self.context.new_page()
        self.source_keys[id(page)] = "fl_dor_officials"
        page.goto(FLORIDA_DOR_OFFICIALS_URL, wait_until="domcontentloaded", timeout=60_000)
        locator = page.evaluate(
            r"""
            (county) => {
              const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
              const selects = Array.from(document.querySelectorAll('select'));
              let chosen = null;
              for (const select of selects) {
                const options = Array.from(select.options || []);
                const hasCounty = options.some((option) => norm(option.textContent).replace(/ COUNTY$/, '') === county);
                if (!hasCounty) continue;
                let node = select;
                let context = '';
                for (let i = 0; i < 6 && node; i += 1, node = node.parentElement) context += ' ' + norm(node.innerText);
                if (context.includes('PROPERTY APPRAISER')) { chosen = select; break; }
                if (!chosen) chosen = select;
              }
              if (!chosen) return {ok: false, error: 'No county selector found'};
              chosen.setAttribute('data-osint-property-select', '1');
              const option = Array.from(chosen.options).find((item) => norm(item.textContent).replace(/ COUNTY$/, '') === county);
              return option ? {ok: true, value: option.value} : {ok: false, error: 'County option not found'};
            }
            """,
            county_name,
        )
        if not locator.get("ok"):
            raise RuntimeError(locator.get("error", "DOR resolver failed"))
        page.locator('select[data-osint-property-select="1"]').select_option(value=locator["value"])
        page.wait_for_timeout(750)
        target = page.evaluate(
            r"""
            () => {
              const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
              const select = document.querySelector('select[data-osint-property-select="1"]');
              let root = select && select.parentElement;
              for (let i = 0; i < 6 && root; i += 1, root = root.parentElement) {
                const controls = Array.from(root.querySelectorAll('a,button,input[type="button"],input[type="submit"]'));
                const go = controls.find((item) => norm(item.innerText || item.value).includes('GO TO SITE'));
                if (go) {
                  go.setAttribute('data-osint-go-site', '1');
                  return {found: true, href: go.href || go.getAttribute('href') || ''};
                }
              }
              return {found: false, href: ''};
            }
            """
        )
        if str(target.get("href", "")).startswith("http"):
            return {"county": county_name.title(), "url": target["href"], "tab": self.tab_values()[-1]}
        button = page.locator('[data-osint-go-site="1"]')
        if not target.get("found") or button.count() == 0:
            raise RuntimeError("DOR Go To Site control was not found.")
        old_url = page.url
        try:
            with page.expect_popup(timeout=5_000) as popup_info:
                button.click()
            popup = popup_info.value
            popup.wait_for_load_state("domcontentloaded", timeout=30_000)
            self.source_keys[id(popup)] = "county_appraiser"
            resolved_url = popup.url
        except PlaywrightTimeoutError:
            page.wait_for_timeout(1_500)
            if page.url == old_url or not page.url.startswith("http"):
                raise RuntimeError("DOR did not expose a direct appraiser URL.")
            resolved_url = page.url
            self.source_keys[id(page)] = "county_appraiser"
        return {"county": county_name.title(), "url": resolved_url, "tab": self.tab_values()[-1]}


def build_handler(state: BrowserState, token: str, server: HTTPServer):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

        def _authorized(self) -> bool:
            return hmac.compare_digest(self.headers.get("X-OSINT-Browser-Token", ""), token)

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def _payload(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0") or 0)
            return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

        def do_GET(self) -> None:  # noqa: N802
            if not self._authorized():
                self._send(403, {"error": "forbidden"})
                return
            if self.path == "/health":
                self._send(200, {"status": "ready", "tabs": len(state.pages())})
            elif self.path == "/tabs":
                self._send(200, {"tabs": state.tab_values()})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if not self._authorized():
                self._send(403, {"error": "forbidden"})
                return
            try:
                payload = self._payload()
                if self.path == "/open":
                    self._send(200, {"tab": state.open(str(payload.get("url", "")), str(payload.get("source_key", "browser")))})
                elif self.path == "/capture":
                    self._send(200, {"capture": state.capture(int(payload.get("index", -1)), bool(payload.get("screenshot", True)))})
                elif self.path == "/resolve-florida-appraiser":
                    self._send(200, {"result": state.resolve_florida_appraiser(str(payload.get("county", "")))})
                elif self.path == "/close-tab":
                    pages = state.pages()
                    index = int(payload.get("index", -1))
                    if index < 0 or index >= len(pages):
                        raise IndexError("Browser tab no longer exists.")
                    pages[index].close()
                    self._send(200, {"tabs": state.tab_values()})
                elif self.path == "/shutdown":
                    self._send(200, {"status": "stopping"})
                    import threading

                    threading.Thread(target=server.shutdown, daemon=True).start()
                else:
                    self._send(404, {"error": "not found"})
            except Exception as exc:
                self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--profile-root", type=Path, required=True)
    parser.add_argument("--capture-root", type=Path, required=True)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()
    token = os.environ.get("OSINT_PROPERTY_BROWSER_TOKEN", "")
    if not token:
        raise SystemExit("OSINT_PROPERTY_BROWSER_TOKEN is required")
    args.profile_root.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(args.profile_root),
            headless=args.headless,
            viewport={"width": 1440, "height": 1000},
        )
        state = BrowserState(context, args.capture_root)
        server = HTTPServer(("127.0.0.1", args.port), BaseHTTPRequestHandler)
        server.RequestHandlerClass = build_handler(state, token, server)
        try:
            server.serve_forever(poll_interval=0.2)
        finally:
            context.close()
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
