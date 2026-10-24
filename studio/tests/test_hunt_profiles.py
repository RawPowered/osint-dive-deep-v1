from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from osint_studio.hunt_profiles import (
    PROFILE_SCHEMA_VERSION,
    TemplateValidationError,
    load_profile_json,
    normalize_profile,
    profile_summary,
    save_custom_profile,
    starter_profile,
)


class HuntProfileTests(unittest.TestCase):
    def test_starter_profile_is_valid_v2(self) -> None:
        profile = starter_profile()
        normalized, warnings = normalize_profile(profile)
        self.assertEqual(normalized["schema_version"], PROFILE_SCHEMA_VERSION)
        self.assertEqual(warnings, [])
        self.assertEqual(normalized["visual"]["rules"], [])
        self.assertEqual(normalized["matrix"]["bases"], "")
        self.assertEqual(normalized["matrix"]["geographies"], "")

    def test_legacy_profile_is_migrated(self) -> None:
        legacy = {
            "schema_version": "hunt-profile-v1",
            "name": "Legacy",
            "matrix": {
                "bases": ["restaurant", "menu"],
                "templates": ["{base} {geo}"],
            },
            "visual": {
                "rules": [
                    {
                        "Group": "Fingerprint",
                        "Section": "Full HTML",
                        "Operator": "contains",
                        "Value": "vendor.example",
                        "Weight": 10,
                    }
                ]
            },
        }
        profile, warnings = load_profile_json(json.dumps(legacy))
        self.assertEqual(profile["schema_version"], PROFILE_SCHEMA_VERSION)
        self.assertIn("Legacy hunt-profile-v1", warnings[0])
        self.assertEqual(profile["matrix"]["bases"], "restaurant\nmenu")

    def test_unknown_query_placeholder_is_rejected(self) -> None:
        profile = starter_profile()
        profile["matrix"]["templates"] = "{base} {unknown_field}"
        with self.assertRaises(TemplateValidationError) as context:
            normalize_profile(profile)
        self.assertTrue(any("unknown placeholder" in item for item in context.exception.errors))

    def test_invalid_rule_section_is_rejected(self) -> None:
        profile = starter_profile()
        profile["visual"]["rules"] = [{"Group": "Test", "Section": "Network requests", "Operator": "contains", "Value": "synthetic", "Weight": 1}]
        with self.assertRaises(TemplateValidationError) as context:
            normalize_profile(profile)
        self.assertTrue(any("unsupported" in item for item in context.exception.errors))

    def test_snake_case_rule_aliases_are_normalized(self) -> None:
        profile = starter_profile()
        profile["visual"]["rules"] = [
            {
                "group": "Fingerprint",
                "group_logic": "OR",
                "section": "All scripts",
                "operator": "contains",
                "value": "vendor.example",
                "case_sensitive": False,
                "required": False,
                "weight": 44,
            }
        ]
        normalized, _warnings = normalize_profile(profile)
        row = normalized["visual"]["rules"][0]
        self.assertEqual(row["Group"], "Fingerprint")
        self.assertEqual(row["Section"], "All scripts")
        self.assertEqual(row["Weight"], 44.0)

    def test_profile_summary(self) -> None:
        summary = profile_summary(starter_profile())
        self.assertEqual(summary["schema_version"], PROFILE_SCHEMA_VERSION)
        self.assertEqual(summary["query_templates"], 1)
        self.assertEqual(summary["rules"], 0)

    def test_save_custom_profile_writes_canonical_json(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch("osint_studio.hunt_profiles.PROFILE_ROOT", Path(temp_dir)):
                path = save_custom_profile(starter_profile(), "Saved Profile")
                payload = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(payload["schema_version"], PROFILE_SCHEMA_VERSION)
                self.assertEqual(payload["name"], "Saved Profile")


if __name__ == "__main__":
    unittest.main()
