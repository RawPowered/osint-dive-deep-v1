from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from osint_studio.supercharger import (
    Candidate,
    CandidateFilter,
    JobStore,
    build_query_matrix,
    candidate_allowed,
    canonical_url,
    estimate_query_matrix_size,
    extract_sitemap_urls,
)


class SuperchargerTests(unittest.TestCase):
    def test_query_matrix_cartesian_and_dedupe(self) -> None:
        shards = build_query_matrix(
            bases=["restaurant"],
            variants=["Mexican", "Pizza"],
            geographies=["Tampa FL", "Orlando FL"],
            sites=[""],
            templates=["{base} {variant} {geo}"],
            max_queries=100,
        )
        self.assertEqual(len(shards), 4)
        self.assertIn("restaurant Mexican Tampa FL", {item.query for item in shards})

    def test_unused_dimensions_do_not_multiply_template(self) -> None:
        shards = build_query_matrix(
            bases=["restaurant"],
            variants=["Mexican", "Pizza"],
            geographies=["Tampa FL"],
            title_terms=["Order Online", "Menu", "Reservations"],
            url_terms=["about", "contact"],
            templates=["{base} {variant} {geo}"],
            max_queries=100,
        )
        self.assertEqual(len(shards), 2)
        estimates = estimate_query_matrix_size(
            bases=["restaurant"],
            variants=["Mexican", "Pizza"],
            geographies=["Tampa FL"],
            title_terms=["Order Online", "Menu", "Reservations"],
            url_terms=["about", "contact"],
            templates=["{base} {variant} {geo}"],
        )
        self.assertEqual(sum(estimates.values()), 2)

    def test_candidate_filter(self) -> None:
        filters = CandidateFilter.from_values(
            excluded_domains=["yelp.com"],
            excluded_url_terms=["/case-studies"],
            excluded_title_terms=["Directory"],
        )
        self.assertFalse(candidate_allowed(Candidate(url="https://www.yelp.com/biz/example"), filters))
        self.assertFalse(candidate_allowed(Candidate(url="https://vendor.example/case-studies/example"), filters))
        self.assertFalse(candidate_allowed(Candidate(url="https://example.com", title="Restaurant Directory"), filters))
        self.assertTrue(candidate_allowed(Candidate(url="https://restaurant.example/menu", title="Order Online"), filters))

    def test_canonical_url_removes_tracking(self) -> None:
        value = canonical_url("https://www.Example.com/path/?utm_source=x&keep=1")
        self.assertEqual(value, "https://example.com/path?keep=1")

    def test_store_deduplicates_and_merges_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with JobStore(Path(temp_dir) / "job.sqlite") as store:
                self.assertTrue(store.upsert_candidate(Candidate(url="https://www.example.com/", provider="ddgs", query="a", rank=2)))
                self.assertFalse(store.upsert_candidate(Candidate(url="https://example.com", provider="brave", query="b", rank=1)))
                rows = store.candidate_rows()
                self.assertEqual(len(rows), 1)
                self.assertIn("ddgs", rows[0]["providers"])
                self.assertIn("brave", rows[0]["providers"])
                self.assertEqual(rows[0]["best_rank"], 1)

    def test_store_prunes_existing_noise(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with JobStore(Path(temp_dir) / "job.sqlite") as store:
                store.upsert_candidate(Candidate(url="https://yelp.com/biz/example", title="Example"))
                store.upsert_candidate(Candidate(url="https://example.com/menu", title="Example Restaurant"))
                removed = store.prune_candidates(CandidateFilter.from_values(excluded_domains=["yelp.com"]))
                self.assertEqual(removed, 1)
                self.assertEqual(len(store.candidate_rows()), 1)

    def test_sitemap_parsing(self) -> None:
        xml = """<?xml version='1.0'?><urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>
        <url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>"""
        pages, nested = extract_sitemap_urls(xml)
        self.assertEqual(pages, ["https://example.com/a", "https://example.com/b"])
        self.assertEqual(nested, [])


if __name__ == "__main__":
    unittest.main()
