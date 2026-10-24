from __future__ import annotations

import os
import secrets
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

from .paths import PROPERTY_BROWSER_ROOT, ensure_private_directory


def _available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as handle:
        handle.bind(("127.0.0.1", 0))
        return int(handle.getsockname()[1])


@dataclass
class PropertyBrowserSession:
    port: int
    token: str
    process: subprocess.Popen[bytes]
    root: Path

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def headers(self) -> dict[str, str]:
        return {"X-OSINT-Browser-Token": self.token}

    @classmethod
    def start(cls, *, headless: bool = False, root: str | Path = PROPERTY_BROWSER_ROOT) -> PropertyBrowserSession:
        browser_root = ensure_private_directory(Path(root).expanduser())
        profile_root = ensure_private_directory(browser_root / "profile")
        capture_root = ensure_private_directory(browser_root / "captures")
        port = _available_port()
        token = secrets.token_urlsafe(32)
        environment = os.environ.copy()
        environment["OSINT_PROPERTY_BROWSER_TOKEN"] = token
        command = [
            sys.executable,
            "-m",
            "osint_studio.property_browser_worker",
            "--port",
            str(port),
            "--profile-root",
            str(profile_root),
            "--capture-root",
            str(capture_root),
        ]
        if headless:
            command.append("--headless")
        process = subprocess.Popen(command, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        session = cls(port=port, token=token, process=process, root=browser_root)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Managed browser exited during startup. Install Chromium with: ./run.sh --install-browser")
            try:
                if session.health().get("status") == "ready":
                    return session
            except requests.RequestException:
                time.sleep(0.25)
        session.stop(force=True)
        raise RuntimeError("Managed browser did not become ready within 25 seconds.")

    def _get(self, path: str) -> dict[str, Any]:
        response = requests.get(self.base_url + path, headers=self.headers, timeout=15)
        response.raise_for_status()
        return response.json()

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = requests.post(self.base_url + path, headers=self.headers, json=payload, timeout=90)
        if not response.ok:
            try:
                message = response.json().get("error", response.text)
            except ValueError:
                message = response.text
            raise RuntimeError(message)
        return response.json()

    def health(self) -> dict[str, Any]:
        return self._get("/health")

    def tabs(self) -> list[dict[str, Any]]:
        return list(self._get("/tabs").get("tabs", []))

    def open(self, url: str, source_key: str) -> dict[str, Any]:
        return dict(self._post("/open", {"url": url, "source_key": source_key})["tab"])

    def capture(self, index: int, *, screenshot: bool = True) -> dict[str, Any]:
        return dict(self._post("/capture", {"index": index, "screenshot": screenshot})["capture"])

    def resolve_florida_appraiser(self, county: str) -> dict[str, Any]:
        return dict(self._post("/resolve-florida-appraiser", {"county": county})["result"])

    def close_tab(self, index: int) -> list[dict[str, Any]]:
        return list(self._post("/close-tab", {"index": index}).get("tabs", []))

    def stop(self, *, force: bool = False) -> None:
        if self.process.poll() is not None:
            return
        if not force:
            try:
                self._post("/shutdown", {})
                self.process.wait(timeout=8)
                return
            except Exception:
                pass
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
