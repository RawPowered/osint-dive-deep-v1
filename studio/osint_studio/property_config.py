from __future__ import annotations

import os
import re
from pathlib import Path

from .paths import PROPERTY_SECRET_PATH, ensure_private_directory


PROPERTY_SECRET_FIELDS: dict[str, str] = {
    "census_api_key": "OSINT_CENSUS_API_KEY",
    "nws_contact": "OSINT_NWS_CONTACT",
    "arcgis_token": "OSINT_ARCGIS_TOKEN",
    "county_property_api_key": "OSINT_COUNTY_PROPERTY_API_KEY",
    "permit_api_key": "OSINT_PERMIT_API_KEY",
    "clerk_api_key": "OSINT_CLERK_API_KEY",
}


def _quote_env(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{escaped}"'


def _unquote_env(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return value.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")


class PropertySecretStore:
    """Small local-only credential file with environment-variable precedence."""

    def __init__(self, path: str | Path = PROPERTY_SECRET_PATH):
        self.path = Path(path).expanduser()

    def load_file(self) -> dict[str, str]:
        if not self.path.is_file():
            return {}
        values: dict[str, str] = {}
        for line in self.path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            if re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
                values[key] = _unquote_env(value)
        return values

    def effective(self) -> dict[str, str]:
        file_values = self.load_file()
        return {
            logical_name: os.environ.get(env_name, file_values.get(env_name, ""))
            for logical_name, env_name in PROPERTY_SECRET_FIELDS.items()
        }

    def save(self, values: dict[str, str]) -> None:
        existing = self.load_file()
        for logical_name, value in values.items():
            env_name = PROPERTY_SECRET_FIELDS.get(logical_name)
            if not env_name:
                continue
            if value:
                existing[env_name] = value
            else:
                existing.pop(env_name, None)
        ensure_private_directory(self.path.parent)
        content = "# DiveDeep property-source credentials. Local workstation only.\n"
        content += "\n".join(f"{key}={_quote_env(existing[key])}" for key in sorted(existing))
        content += "\n"
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(content, encoding="utf-8")
        os.replace(temporary, self.path)
        if os.name == "posix":
            self.path.chmod(0o600)

    @staticmethod
    def masked(value: str) -> str:
        if not value:
            return "Not configured"
        if len(value) <= 8:
            return "•" * len(value)
        return f"{value[:4]}…{value[-4:]}"
