from __future__ import annotations

import unittest

from osint_studio.web_recon import (
    SearchResult,
    analyze_html,
    apply_custom_extractors,
    build_search_query,
    evaluate_rules,
    filter_targets,
    match_value,
    targets_from_urls,
)


HTML = """
<!doctype html>
<html lang="en">
<head>
  <title>Harbor Grill | Order Online | Tampa</title>
  <meta name="description" content="Seafood restaurant in Tampa, Florida">
  <meta name="generator" content="WordPress 6.8">
  <link rel="canonical" href="https://harborgrill.example/">
  <script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script>
  <script type="application/ld+json">{"@type":"Restaurant","name":"Harbor Grill","sameAs":["https://facebook.com/harborgrill"]}</script>
</head>
<body>
<header><h1>Harbor Grill</h1><p>Tampa, FL</p></header>
<main><a class="cta" href="/order-online">Order Online</a><p>Email hello@harborgrill.example or call (813) 555-1212.</p></main>
<footer>
  <p class="copyright">Copyright 2026 Harbor Grill</p>
  <p>Powered by ExampleVendor</p>
  <a href="https://instagram.com/harborgrill">Instagram</a>
  <script src="https://cdn.vendor.example/loader.js"></script>
  <script>window.footerConfig = {siteId: "abc-123"};</script>
</footer>
</body>
</html>
"""


class WebReconTests(unittest.TestCase):
    def test_query_builder(self) -> None:
        query = build_search_query(
            base_terms="restaurant Florida",
            exact_phrases="order online\nprivate dining",
            any_terms="seafood, steakhouse",
            exclude_terms="jobs, careers",
            site="example.org",
            title_terms="restaurant",
            url_terms="menu",
            filetype="pdf",
        )
        self.assertIn('"order online"', query)
        self.assertIn("(seafood OR steakhouse)", query)
        self.assertIn("-jobs", query)
        self.assertIn("site:example.org", query)
        self.assertIn('intitle:"restaurant"', query)
        self.assertIn('inurl:"menu"', query)
        self.assertIn("filetype:pdf", query)

    def test_html_regions_and_fields(self) -> None:
        record = analyze_html(
            HTML,
            {
                "requested_url": "https://harborgrill.example/",
                "final_url": "https://harborgrill.example/",
                "search_title": "",
                "search_snippet": "",
            },
        )
        self.assertEqual(record.fields["title"], "Harbor Grill | Order Online | Tampa")
        self.assertIn("vendor.example", record.sections["Footer scripts"])
        self.assertIn("siteId", record.sections["Footer scripts"])
        self.assertIn("hello@harborgrill.example", record.fields["emails"])
        self.assertIn("instagram.com/harborgrill", record.fields["instagram_links"])
        self.assertIn("WordPress", record.fields["technologies"])
        self.assertIn("Google Tag Manager", record.fields["technologies"])

    def test_group_specific_logic(self) -> None:
        record = analyze_html(HTML, {"final_url": "https://harborgrill.example/"})
        rules = [
            {"Group": "Fingerprint", "Group logic": "OR", "Section": "Visible footer", "Operator": "contains", "Value": "Powered by ExampleVendor", "Weight": 5},
            {"Group": "Fingerprint", "Group logic": "OR", "Section": "Footer scripts", "Operator": "contains", "Value": "missing.example", "Weight": 5},
            {"Group": "Identity", "Group logic": "OR", "Section": "Page title", "Operator": "contains", "Value": "Order Online", "Weight": 2},
            {"Group": "Exclusions", "Group logic": "AND", "Section": "URL", "Operator": "does not contain", "Value": "/case-studies", "Weight": 1, "Required": True},
        ]
        result = evaluate_rules(record, rules, within_group="AND", between_groups="AND")
        self.assertTrue(result["match_passed"])

    def test_custom_extractors(self) -> None:
        record = analyze_html(HTML, {"final_url": "https://harborgrill.example/"})
        output = apply_custom_extractors(
            record,
            [
                {"Column name": "cta_links", "Method": "CSS attribute", "Pattern or selector": "a.cta", "Attribute": "href", "Multiple": True},
                {"Column name": "footer_id", "Method": "Regex", "Source": "Footer scripts", "Pattern or selector": r'siteId:\s*"([^"]+)"', "Multiple": False},
                {"Column name": "org_name", "Method": "JSON-LD key", "Pattern or selector": "name", "Multiple": False},
            ],
        )
        self.assertEqual(output["cta_links"], "/order-online")
        self.assertEqual(output["footer_id"], "abc-123")
        self.assertEqual(output["org_name"], "Harbor Grill")

    def test_match_operators(self) -> None:
        self.assertTrue(match_value("Hello World", "contains", "world"))
        self.assertTrue(match_value("Hello World", "does not contain", "directory"))
        self.assertTrue(match_value("GTM-ABC123", "regex", r"GTM-[A-Z0-9]+"))
        self.assertFalse(match_value("", "exists", ""))

    def test_target_normalization(self) -> None:
        targets = targets_from_urls(["example.org", "https://example.com/path", "not a url"])
        self.assertEqual(len(targets), 2)
        self.assertIsInstance(targets[0], SearchResult)

    def test_prefilter_targets(self) -> None:
        targets = [
            SearchResult(url="https://yelp.com/biz/example", title="Example"),
            SearchResult(url="https://restaurant.example/menu", title="Order Online"),
            SearchResult(url="https://vendor.example/case-studies/a", title="Case Study"),
        ]
        kept, skipped = filter_targets(
            targets,
            excluded_domains=["yelp.com"],
            excluded_url_terms=["/case-studies"],
        )
        self.assertEqual(len(kept), 1)
        self.assertEqual(len(skipped), 2)


if __name__ == "__main__":
    unittest.main()
