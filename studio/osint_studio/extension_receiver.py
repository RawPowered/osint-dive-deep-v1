from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import threading
import unicodedata
from datetime import datetime, timezone
from difflib import SequenceMatcher
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .paths import PROPERTY_ROOT, ensure_private_directory
from .property_sources import validate_public_url
from .property_store import PropertyWarehouse


RECEIVER_HOST = "127.0.0.1"
DEFAULT_RECEIVER_PORT = 8765
RECEIVER_TOKEN_PATH = PROPERTY_ROOT / "receiver-token"
MAX_REQUEST_BYTES = 256 * 1024
NAME_MATCH_MINIMUM = 0.82
ADDRESS_MATCH_MINIMUM = 0.72

SOURCE_HOSTS = {
    "www.floridaresidentsdirectory.com": "florida_residents_directory",
    "floridaresidentsdirectory.com": "florida_residents_directory",
    "www.nationalpublicdata.com": "national_public_data",
    "nationalpublicdata.com": "national_public_data",
    "www.beenverified.com": "beenverified",
    "beenverified.com": "beenverified",
}
MANUAL_ENTRY_ONLY_SOURCES = {"florida_residents_directory", "national_public_data", "beenverified"}

BUSINESS_MARKERS = {
    "llc", "l l c", "inc", "incorporated", "corp", "corporation", "company", "co",
    "properties", "property management", "realty", "realtor", "realtors", "holdings",
    "association", "partners", "partnership", "lp", "llp", "pllc", "foundation",
}


def ensure_receiver_token(path: Path = RECEIVER_TOKEN_PATH) -> str:
    path = Path(path)
    if path.is_file():
        token = path.read_text(encoding="utf-8").strip()
        if len(token) >= 32:
            return token
    ensure_private_directory(path.parent)
    token = secrets.token_urlsafe(32)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(token + "\n", encoding="utf-8")
    os.replace(temporary, path)
    if os.name == "posix":
        path.chmod(0o600)
    return token


def _clean_text(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(character for character in text if not unicodedata.combining(character))
    text = re.sub(r"[^a-zA-Z0-9]+", " ", text).casefold()
    return " ".join(text.split())


def _tokens(value: Any) -> list[str]:
    return [token for token in _clean_text(value).split() if token]


def name_similarity(expected: str, observed: str) -> float:
    left, right = _tokens(expected), _tokens(observed)
    if not left or not right:
        return 0.0
    left_set, right_set = set(left), set(right)
    shorter, longer = (left_set, right_set) if len(left_set) <= len(right_set) else (right_set, left_set)
    containment = len(shorter & longer) / len(shorter)
    if len(shorter) >= 2 and containment == 1.0:
        containment_score = 0.96
    elif containment >= 0.75:
        containment_score = 0.88
    else:
        containment_score = containment
    sequence = SequenceMatcher(None, " ".join(left), " ".join(right)).ratio()
    sorted_sequence = SequenceMatcher(None, " ".join(sorted(left)), " ".join(sorted(right))).ratio()
    return round(max(containment_score, sequence, sorted_sequence), 4)


def address_similarity(expected: str, observed: str) -> float:
    replacements = {
        "street": "st", "avenue": "ave", "road": "rd", "drive": "dr", "lane": "ln",
        "boulevard": "blvd", "court": "ct", "place": "pl", "circle": "cir", "highway": "hwy",
        "north": "n", "south": "s", "east": "e", "west": "w", "apartment": "apt", "suite": "ste",
    }

    def normalized(value: str) -> str:
        tokens = _tokens(value)
        return " ".join(replacements.get(token, token) for token in tokens)

    left, right = normalized(expected), normalized(observed)
    if not left or not right:
        return 0.0
    left_list, right_list = left.split(), right.split()
    left_tokens, right_tokens = set(left_list), set(right_list)
    overlap = len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))
    sequence = SequenceMatcher(None, left, right).ratio()
    shorter, longer = (left_tokens, right_tokens) if len(left_tokens) <= len(right_tokens) else (right_tokens, left_tokens)
    containment = len(shorter & longer) / max(1, len(shorter))
    containment_score = 0.96 if len(shorter) >= 3 and containment == 1.0 else containment
    left_number = next((token for token in left_list if token.isdigit()), "")
    right_number = next((token for token in right_list if token.isdigit()), "")
    if left_number and right_number and left_number != right_number:
        return round(min(0.35, max(overlap, sequence) * 0.5), 4)
    return round(max(overlap, sequence, containment_score), 4)


def likely_business(owner_name: str, owner_type: str = "") -> bool:
    normalized = _clean_text(f"{owner_name} {owner_type}")
    tokens = set(normalized.split())
    return any(marker in normalized if " " in marker else marker in tokens for marker in BUSINESS_MARKERS)


def source_key_for_url(url: str) -> str:
    return SOURCE_HOSTS.get((urlparse(url).hostname or "").casefold(), "")


def _bounded_strings(values: Any, maximum: int = 30, width: int = 1000) -> list[str]:
    if not isinstance(values, list):
        return []
    result: list[str] = []
    for value in values[:maximum]:
        text = str(value or "").strip()[:width]
        if text and text not in result:
            result.append(text)
    return result


class ExtensionReceiver:
    def __init__(self, warehouse: PropertyWarehouse | None = None):
        self.warehouse = warehouse or PropertyWarehouse()

    def match(self, payload: dict[str, Any]) -> dict[str, Any]:
        page_url = validate_public_url(str(payload.get("page_url") or ""))
        names = _bounded_strings(payload.get("candidate_names"), width=500)
        addresses = _bounded_strings(payload.get("candidate_addresses"), width=1000)
        if not names:
            raise ValueError("No candidate names were found on the active page.")
        source_key = source_key_for_url(page_url)
        tasks = self.warehouse.list_extension_match_candidates(source_key=source_key)
        if not tasks and source_key:
            tasks = self.warehouse.list_extension_match_candidates()
        best: dict[str, Any] | None = None
        for task in tasks:
            scored_names = [(name_similarity(str(task.get("owner_name") or ""), candidate), candidate) for candidate in names]
            name_score, candidate_name = max(scored_names, default=(0.0, ""))
            scored_addresses = [(address_similarity(str(task.get("property_address") or ""), candidate), candidate) for candidate in addresses]
            address_score, candidate_address = max(scored_addresses, default=(0.0, ""))
            total_score = name_score if not addresses else (name_score * 0.76 + address_score * 0.24)
            if best is None or total_score > float(best["overall_similarity"]):
                best = {
                    "verification_id": str(task["verification_id"]),
                    "hunt_id": str(task["hunt_id"]),
                    "record_id": str(task["record_id"]),
                    "source_key": str(task["source_key"]),
                    "expected_owner_name": str(task.get("owner_name") or ""),
                    "expected_property_address": str(task.get("property_address") or ""),
                    "expected_location": ", ".join(part for part in (str(task.get("city") or ""), str(task.get("state") or ""), str(task.get("zip") or "")) if part),
                    "candidate_name": candidate_name,
                    "candidate_address": candidate_address,
                    "name_similarity": name_score,
                    "address_similarity": address_score,
                    "overall_similarity": round(total_score, 4),
                    "verification_result": str(task.get("verification_result") or "NOT_REVIEWED"),
                    "status": str(task.get("status") or "manual-review"),
                    "already_filled": str(task.get("verification_result") or "NOT_REVIEWED") != "NOT_REVIEWED",
                    "language_already_filled": bool(str(task.get("preferred_language") or "").strip()),
                    "preferred_language": str(task.get("preferred_language") or ""),
                    "business_entity_likely": likely_business(str(task.get("owner_name") or ""), str(task.get("owner_type") or "")),
                    "recommended_source": "Florida Sunbiz" if str(task.get("state") or "").upper() == "FL" else "State business registry",
                }
        if best is None or float(best["name_similarity"]) < NAME_MATCH_MINIMUM:
            return {"matched": False, "source_key": source_key, "minimum_name_similarity": NAME_MATCH_MINIMUM}
        best["matched"] = True
        best["source_key_matches_page"] = not source_key or source_key == best["source_key"]
        best["owner_submit_ready"] = bool(addresses) and not best["business_entity_likely"]
        return best

    def submit(self, payload: dict[str, Any]) -> dict[str, Any]:
        page_url = validate_public_url(str(payload.get("page_url") or ""))
        capture_mode = str(payload.get("capture_mode") or "owner-verification")
        if capture_mode not in {"owner-verification", "language-evidence"}:
            raise ValueError("Unsupported capture mode.")
        input_method = str(payload.get("input_method") or "")
        if input_method not in {"manual-entry", "active-tab-structured-scan"}:
            raise ValueError("Unsupported capture input method.")
        page_source_key = source_key_for_url(page_url)
        if page_source_key in MANUAL_ENTRY_ONLY_SOURCES and input_method != "manual-entry":
            raise PermissionError("This source is manual-entry only under the current capture policy.")
        match_payload = {
            "page_url": page_url,
            "candidate_names": [str(payload.get("candidate_name") or "")],
            "candidate_addresses": [str(payload.get("candidate_address") or "")] if str(payload.get("candidate_address") or "").strip() else [],
        }
        match = self.match(match_payload)
        if not match.get("matched") or str(match.get("verification_id")) != str(payload.get("verification_id") or ""):
            raise PermissionError("The submitted page no longer closely matches the selected owner row.")
        if capture_mode == "owner-verification" and (not page_source_key or page_source_key != str(match.get("source_key") or "")):
            raise PermissionError("Owner verification must be submitted from the same configured directory source as the queued row.")
        if match.get("business_entity_likely"):
            raise PermissionError(f"The owner appears to be an organization. Route it to {match['recommended_source']} instead of a people directory.")
        replace_existing = bool(payload.get("replace_existing"))
        if capture_mode == "owner-verification" and match.get("already_filled") and not replace_existing:
            raise FileExistsError("This verification row is already filled. Explicitly enable replacement to update it.")
        if capture_mode == "language-evidence" and match.get("language_already_filled") and not replace_existing:
            raise FileExistsError("Language evidence is already filled. Explicitly enable replacement to update it.")
        observed_language = str(payload.get("observed_language") or "").strip()[:64]
        language_confidence = max(0.0, min(1.0, float(payload.get("language_confidence") or 0)))
        if capture_mode == "owner-verification":
            if not str(match.get("candidate_address") or "").strip():
                raise ValueError("Owner verification requires an address visible on the page.")
            result = "NAME_AND_ADDRESS_MATCH" if float(match["address_similarity"]) >= ADDRESS_MATCH_MINIMUM else "NAME_MATCH_ADDRESS_CONFLICT"
            confidence = round(float(match["name_similarity"]) * 0.7 + float(match["address_similarity"]) * 0.3, 4)
            notes = f"Firefox receiver ({input_method}): name similarity {match['name_similarity']:.2f}; address similarity {match['address_similarity']:.2f}; no page DOM archived."
            self.warehouse.update_owner_verification(
                str(match["hunt_id"]), str(match["verification_id"]), result,
                confidence=confidence, reviewed_source_url=page_url, notes=notes,
            )
        else:
            if not observed_language or language_confidence < 0.5:
                raise ValueError("Language evidence requires a detected or explicit language with at least 0.50 confidence.")
            self.warehouse.update_intel_fields(
                str(match["hunt_id"]), str(match["record_id"]),
                {
                    "preferred_language": observed_language,
                    "preferred_language_basis": "observed-public-profile-language",
                    "preferred_language_source_url": page_url,
                    "preferred_language_confidence": language_confidence,
                    "preferred_language_reviewed_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            result = "LANGUAGE_EVIDENCE_SAVED"
            confidence = language_confidence
        content_sha256 = str(payload.get("content_sha256") or "").casefold()
        if content_sha256 and not re.fullmatch(r"[0-9a-f]{64}", content_sha256):
            raise ValueError("Content hash must be a SHA-256 hexadecimal value.")
        receipt_id = self.warehouse.record_extension_capture_receipt({
            **match,
            "page_url": page_url,
            "page_title": str(payload.get("page_title") or ""),
            "candidate_name": str(match.get("candidate_name") or ""),
            "candidate_address": str(match.get("candidate_address") or ""),
            "content_sha256": content_sha256,
            "observed_language": observed_language if capture_mode == "language-evidence" else "",
            "language_confidence": language_confidence if capture_mode == "language-evidence" else 0,
            "action": f"{capture_mode}:{input_method}",
        })
        return {"accepted": True, "receipt_id": receipt_id, "result": result, "confidence": confidence, "record_id": match["record_id"], "verification_id": match["verification_id"]}


class ReceiverRequestHandler(BaseHTTPRequestHandler):
    server_version = "DiveDeepReceiver/1.0"

    @property
    def receiver(self) -> ExtensionReceiver:
        return self.server.receiver  # type: ignore[attr-defined]

    @property
    def receiver_token(self) -> str:
        return self.server.receiver_token  # type: ignore[attr-defined]

    def _headers(self, status: int = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-OSINT-Receiver-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def _json(self, value: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        self._headers(status)
        self.wfile.write(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))

    def _authorized(self) -> bool:
        return secrets.compare_digest(self.headers.get("X-OSINT-Receiver-Token", ""), self.receiver_token)

    def _payload(self) -> dict[str, Any]:
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid content length.") from exc
        if size <= 0 or size > MAX_REQUEST_BYTES:
            raise ValueError("Request body is empty or too large.")
        value = json.loads(self.rfile.read(size).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("JSON body must be an object.")
        forbidden = {"html", "dom", "body", "body_text", "page_content", "raw_content"} & set(value)
        if forbidden:
            raise ValueError("Raw page content is not accepted by this structured receiver.")
        return value

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._headers(HTTPStatus.NO_CONTENT)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json({"status": "ready", "receiver": "divedeep-firefox", "raw_dom_accepted": False})
            return
        if not self._authorized():
            self._json({"error": "unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return
        if parsed.path == "/api/v1/signal":
            verification_id = parse_qs(parsed.query).get("verification_id", [""])[0]
            if not verification_id:
                self._json({"error": "verification_id is required"}, HTTPStatus.BAD_REQUEST)
                return
            signal = self.receiver.warehouse.consume_extension_capture_signal(verification_id)
            self._json({"signaled": bool(signal), "signal_id": str(signal.get("signal_id")) if signal else ""})
            return
        self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._json({"error": "unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return
        try:
            payload = self._payload()
            if self.path == "/api/v1/match":
                self._json(self.receiver.match(payload))
            elif self.path == "/api/v1/submit":
                self._json(self.receiver.submit(payload), HTTPStatus.CREATED)
            else:
                self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except FileExistsError as exc:
            self._json({"error": str(exc), "code": "already-filled"}, HTTPStatus.CONFLICT)
        except PermissionError as exc:
            self._json({"error": str(exc), "code": "match-rejected"}, HTTPStatus.FORBIDDEN)
        except (ValueError, json.JSONDecodeError) as exc:
            self._json({"error": str(exc), "code": "invalid-request"}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self._json({"error": f"{type(exc).__name__}: {exc}", "code": "receiver-error"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[Firefox Receiver] {self.address_string()} {format % args}")


class ReceiverHTTPServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], receiver: ExtensionReceiver, receiver_token: str):
        super().__init__(address, ReceiverRequestHandler)
        self.receiver = receiver
        self.receiver_token = receiver_token


def serve(port: int = DEFAULT_RECEIVER_PORT) -> None:
    if not 1024 <= int(port) <= 65535:
        raise ValueError("Receiver port must be between 1024 and 65535.")
    token = ensure_receiver_token()
    server = ReceiverHTTPServer((RECEIVER_HOST, int(port)), ExtensionReceiver(), token)
    print(f"[Firefox Receiver] Listening on http://{RECEIVER_HOST}:{int(port)}", flush=True)
    print(f"[Firefox Receiver] Extension token: {token}", flush=True)
    print("[Firefox Receiver] Structured fields only; raw DOM/page content is rejected.", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def start_background_receiver(port: int = DEFAULT_RECEIVER_PORT) -> ReceiverHTTPServer:
    if not 1024 <= int(port) <= 65535:
        raise ValueError("Receiver port must be between 1024 and 65535.")
    token = ensure_receiver_token()
    server = ReceiverHTTPServer((RECEIVER_HOST, int(port)), ExtensionReceiver(), token)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True, name="divedeep-firefox-receiver")
    thread.start()
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Loopback receiver for the DiveDeep Firefox extension.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("OSINT_RECEIVER_PORT", DEFAULT_RECEIVER_PORT)))
    arguments = parser.parse_args()
    serve(arguments.port)


if __name__ == "__main__":
    main()
