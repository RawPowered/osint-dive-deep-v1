from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from osint_studio.case_store import CaseStore
from osint_studio.property_config import PropertySecretStore
from osint_studio.property_service import PropertyIntelService
from osint_studio.property_sources import PROPERTY_SOURCES, parse_census_payload, source_links
from osint_studio.property_store import PropertyHuntConfig, PropertyWarehouse


class PropertyIntelTests(unittest.TestCase):
    def test_uploaded_address_to_reviewed_exports(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cases = CaseStore(root / "studio.sqlite", root / "artifacts")
            warehouse = PropertyWarehouse(root / "property-market.duckdb")
            secret_store = PropertySecretStore(root / "property-secrets.env")
            secret_store.save({"arcgis_token": "exact-token-123"})
            service = PropertyIntelService(cases, warehouse, secret_store)
            case_id = cases.create_case("Florida property research")
            hunt_id = service.create_hunt(PropertyHuntConfig(name="Tampa addresses", case_id=case_id, county="Hillsborough", minimum_building_age=20))

            summary = service.import_upload(
                hunt_id,
                "addresses.csv",
                b'address,city,state,zip,year_built,property_type\n"601 E Kennedy Blvd, Tampa, FL 33602",Tampa,FL,33602,1990,commercial\n',
            )
            self.assertEqual(summary["rows_imported"], 1)
            self.assertEqual(secret_store.effective()["arcgis_token"], "exact-token-123")

            record = warehouse.list_properties(hunt_id)[0]
            payload = {
                "result": {
                    "addressMatches": [
                        {
                            "matchedAddress": "601 E KENNEDY BLVD, TAMPA, FL, 33602",
                            "coordinates": {"x": -82.456, "y": 27.951},
                            "geographies": {"Counties": [{"NAME": "Hillsborough County", "GEOID": "12057"}], "States": [{"NAME": "Florida", "STATE": "12"}]},
                        }
                    ]
                }
            }
            route = parse_census_payload(str(record["property_address"]), payload)
            warehouse.apply_address_route(hunt_id, str(record["record_id"]), route.values(), "raw_census")
            warehouse.upsert_events(hunt_id, pd.DataFrame([{"EVENT_ID": "event-1", "EVENT_TYPE": "Hail", "BEGIN_DATE_TIME": "07-JUL-2026 15:00:00", "BEGIN_LAT": "27.952", "BEGIN_LON": "-82.457", "CZ_NAME": "HILLSBOROUGH", "STATE": "FLORIDA", "MAGNITUDE": "1.00"}]), "raw_storm")
            self.assertEqual(warehouse.match_nearest_events(hunt_id), 1)
            warehouse.score(hunt_id)
            scored = warehouse.list_properties(hunt_id)[0]
            self.assertIn("ADDRESS_GEOCODED", scored["reason_codes"])
            self.assertIn("EVENT_WITHIN_DISTANCE", scored["reason_codes"])
            warehouse.review(hunt_id, str(scored["record_id"]), "approved-for-export", "Verified", "consent-gated")

            csv_data = warehouse.csv_bytes(hunt_id)
            geojson = json.loads(warehouse.geojson_bytes(hunt_id))
            parquet = warehouse.parquet_path(hunt_id)
            self.assertIn(b"601 E KENNEDY BLVD", csv_data)
            self.assertEqual(len(geojson["features"]), 1)
            self.assertTrue(parquet.is_file())
            self.assertEqual(len({source.key for source in PROPERTY_SOURCES}), len(PROPERTY_SOURCES))
            self.assertTrue({"county_appraiser", "census_tigerweb", "noaa_storm_events"}.issubset({source.key for source in PROPERTY_SOURCES}))
            self.assertTrue(any(item["url"].startswith("https://www.hcpafl.org") for item in source_links(county="Hillsborough") if item["key"] == "county_appraiser"))


if __name__ == "__main__":
    unittest.main()
