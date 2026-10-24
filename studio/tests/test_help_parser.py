from __future__ import annotations

import unittest

from osint_studio.help_parser import parse_help_options
from osint_studio.option_groups import group_options


class HelpParserTests(unittest.TestCase):
    def test_parse_and_group(self) -> None:
        text = """
usage: demo [options]
  -d, --domain DOMAIN     target domain
  -o, --output FILE       output JSON file
  -t, --timeout SECONDS   request timeout
  --passive               passive sources only
"""
        options = parse_help_options(text)
        self.assertEqual(len(options), 4)
        grouped = group_options(options)
        self.assertIn("Target & Input", grouped)
        self.assertIn("Output", grouped)
        self.assertIn("Performance", grouped)
        self.assertIn("Scope & Filters", grouped)


if __name__ == "__main__":
    unittest.main()
