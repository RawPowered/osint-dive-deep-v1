from __future__ import annotations

import gzip
import io
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from typing import Any, Iterable
from urllib.parse import urlencode, urljoin, urlparse

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .weather_hunt import US_STATES


CENSUS_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress"
CENSUS_ACS5_URL = "https://api.census.gov/data/2024/acs/acs5"
FLORIDA_DOR_OFFICIALS_URL = "https://floridarevenue.com/property/Pages/LocalOfficials.aspx"
FLORIDA_DOR_DATA_URL = "https://floridarevenue.com/property/Pages/DataPortal_RequestAssessmentRollGISData.aspx"
FLORIDA_GEODATA_URL = "https://geodata.floridagio.gov/"
FLORIDA_STATEWIDE_PARCEL_MAP_ID = "75eb8aaee07d4ce69f7e8f538fc1aeb1"
FLORIDA_STATEWIDE_PARCEL_MAP_URL = f"https://geodata.floridagio.gov/maps/{FLORIDA_STATEWIDE_PARCEL_MAP_ID}/explore"
FLORIDA_STATEWIDE_CADASTRAL_LAYER_URL = "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0"
NOAA_STORM_URL = "https://www.ncei.noaa.gov/stormevents/"
NOAA_STORM_BULK_INDEX = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
NWS_API_URL = "https://api.weather.gov"
NWS_DOCS_URL = "https://www.weather.gov/documentation/services-web-api"
NOAA_DATA_VIEWER_URL = "https://coast.noaa.gov/dataviewer/"
SUNBIZ_URL = "https://dos.fl.gov/sunbiz/search/"
FLORIDA_CLERKS_URL = "https://www.flclerks.com/page/FindaClerk"
FLORIDA_RESIDENTS_DIRECTORY_URL = "https://www.floridaresidentsdirectory.com/"
NATIONAL_PUBLIC_DATA_URL = "https://nationalpublicdata.com/"

FLORIDA_DOR_COUNTIES: dict[int, str] = {
    11: "Alachua", 12: "Baker", 13: "Bay", 14: "Bradford", 15: "Brevard", 16: "Broward", 17: "Calhoun",
    18: "Charlotte", 19: "Citrus", 20: "Clay", 21: "Collier", 22: "Columbia", 23: "Miami-Dade", 24: "DeSoto",
    25: "Dixie", 26: "Duval", 27: "Escambia", 28: "Flagler", 29: "Franklin", 30: "Gadsden", 31: "Gilchrist",
    32: "Glades", 33: "Gulf", 34: "Hamilton", 35: "Hardee", 36: "Hendry", 37: "Hernando", 38: "Highlands",
    39: "Hillsborough", 40: "Holmes", 41: "Indian River", 42: "Jackson", 43: "Jefferson", 44: "Lafayette", 45: "Lake",
    46: "Lee", 47: "Leon", 48: "Levy", 49: "Liberty", 50: "Madison", 51: "Manatee", 52: "Marion", 53: "Martin",
    54: "Monroe", 55: "Nassau", 56: "Okaloosa", 57: "Okeechobee", 58: "Orange", 59: "Osceola", 60: "Palm Beach",
    61: "Pasco", 62: "Pinellas", 63: "Polk", 64: "Putnam", 65: "Saint Johns", 66: "Saint Lucie", 67: "Santa Rosa",
    68: "Sarasota", 69: "Seminole", 70: "Sumter", 71: "Suwannee", 72: "Taylor", 73: "Union", 74: "Volusia",
    75: "Wakulla", 76: "Walton", 77: "Washington",
}


# Seeded from the supplied florida_property_router.py. The DOR directory remains
# authoritative and is always retained as the fallback for URL changes.
VERIFIED_FLORIDA_APPRAISERS: dict[str, str] = {
    "Citrus": "https://www.citruspa.org/",
    "Hernando": "https://hernandocountypa-florida.us/",
    "Hillsborough": "https://www.hcpafl.org/",
    "Manatee": "https://www.manateepao.gov/",
    "Pasco": "https://pascopa.gov/",
    "Pinellas": "https://www.pcpao.gov/",
    "Polk": "https://www.polkflpa.gov/",
    "Sarasota": "https://www.sc-pa.com/",
}


@dataclass(frozen=True)
class PropertySource:
    key: str
    label: str
    category: str
    official_url: str
    capability: str
    access_methods: tuple[str, ...]
    default_method: str
    automation: str
    credential_field: str = ""
    fallback: str = "manual-browser"
    analyst_review: bool = False


PROPERTY_SOURCES: tuple[PropertySource, ...] = (
    PropertySource("census_geocoder", "U.S. Census Geocoder", "address", CENSUS_GEOCODER_URL, "Standardize addresses and return coordinates, county and FIPS.", ("rest", "batch", "browser"), "rest", "automated", fallback="browser"),
    PropertySource("census_acs5", "U.S. Census ACS 5-Year", "market-demographics", CENSUS_ACS5_URL, "County aggregate population, language, race/ethnicity and household-income estimates for market context.", ("json-api",), "json-api", "analyst-triggered", credential_field="census_api_key", fallback="manual-download", analyst_review=True),
    PropertySource("fl_dor_officials", "Florida DOR — Find a County Official", "routing", FLORIDA_DOR_OFFICIALS_URL, "Resolve the authoritative county property appraiser.", ("browser", "playwright"), "playwright", "browser-assisted", analyst_review=True),
    PropertySource("fl_dor_roll_gis", "Florida DOR — Assessment Roll and GIS Data", "parcel", FLORIDA_DOR_DATA_URL, "Download county assessment rolls and parcel GIS packages.", ("bulk-file", "browser"), "bulk-file", "download-assisted", analyst_review=True),
    PropertySource("fl_dor_tax_roll", "Florida DOR — Tax Roll Ingestion", "tax-roll", FLORIDA_DOR_DATA_URL, "Archive and normalize NAL real-property, NAP tangible-personal-property and SDF sale files from CSV or ZIP packages.", ("zip", "bulk-csv", "browser"), "bulk-csv", "local-ingestion", analyst_review=True),
    PropertySource("fl_geospatial", "Florida Geospatial Open Data Portal", "parcel", FLORIDA_GEODATA_URL, "Discover statewide parcels and Florida GIS layers.", ("arcgis-rest", "geojson", "shapefile", "browser"), "arcgis-rest", "endpoint-configured", credential_field="arcgis_token", fallback="browser"),
    PropertySource("noaa_storm_events", "NOAA Storm Events Database", "event", NOAA_STORM_URL, "Historical hail, wind, tornado, tropical storm, rain and other events.", ("bulk-csv", "browser"), "bulk-csv", "automated", fallback="browser"),
    PropertySource("ncei_daily_precip", "NOAA NCEI Daily Precipitation", "weather", "https://www.ncei.noaa.gov/support/access-data-service-api-user-documentation", "Historical station precipitation with coordinates and measured daily totals.", ("json-api", "bbox"), "json-api", "automated", fallback="browser"),
    PropertySource("census_tigerweb", "U.S. Census TIGERweb", "boundary", "https://tigerweb.geo.census.gov/tigerwebmain/TIGERweb_restmapservice.html", "Official state geometry for map scope and clipping.", ("arcgis-rest", "geojson"), "arcgis-rest", "automated"),
    PropertySource("osm_nominatim", "OpenStreetMap Nominatim", "address", "https://operations.osmfoundation.org/policies/nominatim/", "User-triggered reverse address lookup for a clicked coordinate.", ("json-api", "browser"), "json-api", "analyst-triggered", fallback="manual-browser", analyst_review=True),
    PropertySource("nws_api", "NWS API", "event", NWS_DOCS_URL, "Current alerts, warnings, observations and alert geometries.", ("json-api", "geojson", "browser"), "json-api", "automated", credential_field="nws_contact", fallback="browser"),
    PropertySource("noaa_data_viewer", "NOAA Data Access Viewer", "imagery", NOAA_DATA_VIEWER_URL, "Locate aerial imagery, elevation, lidar and land-cover datasets.", ("browser", "interactive-download"), "browser", "manual-assisted", analyst_review=True),
    PropertySource("fl_sunbiz", "Florida Sunbiz", "owner", SUNBIZ_URL, "Check whether an owner name is a registered business entity.", ("browser", "playwright"), "browser", "manual-assisted", analyst_review=True),
    PropertySource("county_appraiser", "County property appraiser", "parcel", FLORIDA_DOR_OFFICIALS_URL, "Parcel, situs, legal, building, ownership-class and sales records.", ("county-adapter", "api", "browser"), "county-adapter", "jurisdiction-specific", credential_field="county_property_api_key", fallback="browser", analyst_review=True),
    PropertySource("permit_portal", "County or municipal permit portal", "permit", "", "Roof replacement, repair, permit and final-inspection records.", ("api", "open-data", "browser"), "browser", "jurisdiction-specific", credential_field="permit_api_key", fallback="manual-browser", analyst_review=True),
    PropertySource("county_clerk", "County clerk official records", "deed", FLORIDA_CLERKS_URL, "Deeds, transfers, legal owner names and recorded instruments.", ("county-adapter", "browser"), "browser", "jurisdiction-specific", credential_field="clerk_api_key", fallback="manual-browser", analyst_review=True),
    PropertySource("florida_residents_directory", "Florida Residents Directory", "owner-verification", FLORIDA_RESIDENTS_DIRECTORY_URL, "Manual single-record owner-name and property-address corroboration only.", ("external-browser",), "external-browser", "automation-prohibited", fallback="manual-only", analyst_review=True),
    PropertySource("national_public_data", "National Public Data", "owner-verification", NATIONAL_PUBLIC_DATA_URL, "Manual single-record owner-name and property-address corroboration only.", ("external-browser",), "external-browser", "manual-only-terms-unverified", fallback="manual-only", analyst_review=True),
)


ACS5_VARIABLES = (
    "NAME", "B01003_001E", "B19013_001E", "B03002_001E", "B03002_003E", "B03002_004E", "B03002_005E",
    "B03002_006E", "B03002_007E", "B03002_008E", "B03002_009E", "B03002_012E", "C16001_001E", "C16001_002E",
    "C16001_003E", "C16001_006E", "C16001_009E", "C16001_012E", "C16001_015E", "C16001_018E", "C16001_021E",
    "C16001_024E", "C16001_027E", "C16001_030E", "C16001_033E", "C16001_036E", "B19001_001E",
    *tuple(f"B19001_{index:03d}E" for index in range(2, 18)),
)


def _acs_number(row: dict[str, str], key: str) -> int:
    try:
        value = int(row.get(key, "0"))
        return max(0, value)
    except (TypeError, ValueError):
        return 0


def collect_acs5_county_profiles(
    session: requests.Session,
    state_code: str,
    api_key: str,
    *,
    year: int = 2024,
) -> tuple[list[dict[str, Any]], bytes, dict[str, str], str]:
    state_code = state_code.strip().upper()
    if state_code not in US_STATES:
        raise ValueError(f"Unsupported state code: {state_code}")
    if not api_key.strip():
        raise ValueError("A free Census Data API key is required for ACS market profiles.")
    state_fips = US_STATES[state_code][1]
    endpoint = f"https://api.census.gov/data/{int(year)}/acs/acs5"
    response = session.get(
        endpoint,
        params={"get": ",".join(ACS5_VARIABLES), "for": "county:*", "in": f"state:{state_fips}", "key": api_key.strip()},
        timeout=90,
    )
    response.raise_for_status()
    payload = response.json()
    if not payload or len(payload) < 2:
        return [], response.content, {str(key): str(value) for key, value in response.headers.items()}, response.url
    headers = [str(value) for value in payload[0]]
    profiles: list[dict[str, Any]] = []
    race_variables = {
        "White alone, not Hispanic or Latino": "B03002_003E",
        "Black or African American alone, not Hispanic or Latino": "B03002_004E",
        "American Indian/Alaska Native alone, not Hispanic or Latino": "B03002_005E",
        "Asian alone, not Hispanic or Latino": "B03002_006E",
        "Native Hawaiian/Pacific Islander alone, not Hispanic or Latino": "B03002_007E",
        "Some other race alone, not Hispanic or Latino": "B03002_008E",
        "Two or more races, not Hispanic or Latino": "B03002_009E",
        "Hispanic or Latino": "B03002_012E",
    }
    language_variables = {
        "English only": "C16001_002E", "Spanish": "C16001_003E", "French, Haitian or Cajun": "C16001_006E",
        "German/West Germanic": "C16001_009E", "Russian/Polish/Slavic": "C16001_012E", "Other Indo-European": "C16001_015E",
        "Korean": "C16001_018E", "Chinese": "C16001_021E", "Vietnamese": "C16001_024E", "Tagalog/Filipino": "C16001_027E",
        "Other Asian/Pacific Island": "C16001_030E", "Arabic": "C16001_033E", "Other/unspecified": "C16001_036E",
    }
    for values in payload[1:]:
        row = dict(zip(headers, (str(value) for value in values), strict=False))
        income_counts = {index: _acs_number(row, f"B19001_{index:03d}E") for index in range(2, 18)}
        profiles.append({
            "geography_type": "county",
            "geography_name": row.get("NAME", ""),
            "state": state_code,
            "state_fips": row.get("state", state_fips),
            "county_fips": row.get("county", ""),
            "vintage": int(year),
            "population": _acs_number(row, "B01003_001E"),
            "median_household_income": _acs_number(row, "B19013_001E"),
            "race_ethnicity_total": _acs_number(row, "B03002_001E"),
            "race_ethnicity": {label: _acs_number(row, variable) for label, variable in race_variables.items()},
            "language_total": _acs_number(row, "C16001_001E"),
            "languages": {label: _acs_number(row, variable) for label, variable in language_variables.items()},
            "household_income_total": _acs_number(row, "B19001_001E"),
            "household_income_bands": {
                "Under $50,000": sum(income_counts[index] for index in range(2, 11)),
                "$50,000–$99,999": sum(income_counts[index] for index in range(11, 14)),
                "$100,000–$149,999": sum(income_counts[index] for index in range(14, 16)),
                "$150,000 or more": sum(income_counts[index] for index in range(16, 18)),
            },
            "source_url": response.url,
        })
    return profiles, response.content, {str(key): str(value) for key, value in response.headers.items()}, response.url


@dataclass
class AddressRoute:
    input_address: str
    geocode_status: str = "NO_MATCH"
    matched_address: str = ""
    latitude: float | None = None
    longitude: float | None = None
    state_name: str = ""
    state_abbreviation: str = ""
    state_fips: str = ""
    county: str = ""
    county_fips: str = ""
    property_appraiser_office: str = ""
    property_appraiser_url: str = ""
    property_appraiser_directory_url: str = FLORIDA_DOR_OFFICIALS_URL
    appraiser_url_status: str = ""
    filter_status: str = ""
    error: str = ""
    raw_payload: dict[str, Any] = field(default_factory=dict, repr=False)

    def values(self, *, include_raw: bool = False) -> dict[str, Any]:
        values = asdict(self)
        if not include_raw:
            values.pop("raw_payload", None)
        return values


def build_public_session(contact: str = "") -> requests.Session:
    retry = Retry(
        total=4,
        connect=4,
        read=4,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "POST"}),
        respect_retry_after_header=True,
    )
    session = requests.Session()
    identity = contact.strip() or "local-property-research"
    session.headers.update({"User-Agent": f"OSINT-Studio/5.11 ({identity})", "Accept": "application/json, text/csv;q=0.9, */*;q=0.5"})
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def normalize_county_name(value: str) -> str:
    value = re.sub(r"\s+County$", "", value.strip(), flags=re.IGNORECASE)
    return " ".join(part.capitalize() for part in value.split())


def _first_geography(geographies: dict[str, Any], key: str) -> dict[str, Any]:
    values = geographies.get(key) or []
    return values[0] if values else {}


def parse_census_payload(address: str, payload: dict[str, Any]) -> AddressRoute:
    result = AddressRoute(input_address=address, raw_payload=payload)
    matches = payload.get("result", {}).get("addressMatches", [])
    if not matches:
        return result
    match = matches[0]
    geographies = match.get("geographies", {})
    county_geo = _first_geography(geographies, "Counties")
    state_geo = _first_geography(geographies, "States")
    coordinates = match.get("coordinates", {})
    county_full = str(county_geo.get("NAME", ""))
    result.geocode_status = "MATCHED"
    result.matched_address = str(match.get("matchedAddress", ""))
    result.latitude = coordinates.get("y")
    result.longitude = coordinates.get("x")
    result.county = normalize_county_name(county_full) if county_full else ""
    result.county_fips = str(county_geo.get("GEOID", ""))
    result.state_fips = str(state_geo.get("STATE", "")) or result.county_fips[:2]
    result.state_name = str(state_geo.get("NAME", "")) or ("Florida" if result.state_fips == "12" else "")
    result.state_abbreviation = str(state_geo.get("STUSAB", "")) or next((code for code, (_, fips) in US_STATES.items() if fips == result.state_fips), "")
    if not result.county:
        result.geocode_status = "MATCHED_WITHOUT_COUNTY"
        result.error = "Census matched the address but returned no county."
        return result
    if result.state_fips == "12":
        result.property_appraiser_office = f"{result.county} County Property Appraiser"
        result.property_appraiser_url = VERIFIED_FLORIDA_APPRAISERS.get(result.county, "")
        result.appraiser_url_status = "VERIFIED_SEED_URL" if result.property_appraiser_url else "USE_OFFICIAL_DOR_DIRECTORY"
    else:
        result.appraiser_url_status = "JURISDICTION_SOURCE_REQUIRED"
    result.filter_status = "IN_SCOPE"
    return result


def census_geocode(session: requests.Session, address: str, timeout: int = 45) -> tuple[AddressRoute, bytes, dict[str, str], str]:
    response = session.get(
        CENSUS_GEOCODER_URL,
        params={"address": address, "benchmark": "Public_AR_Current", "vintage": "Current_Current", "format": "json"},
        timeout=timeout,
    )
    raw = response.content
    headers = {str(key): str(value) for key, value in response.headers.items()}
    response.raise_for_status()
    return parse_census_payload(address, response.json()), raw, headers, response.url


def source_by_key(key: str) -> PropertySource:
    for source in PROPERTY_SOURCES:
        if source.key == key:
            return source
    raise KeyError(key)


def source_links(
    *,
    address: str = "",
    county: str = "",
    owner_name: str = "",
    state: str = "FL",
    custom_urls: dict[str, str] | None = None,
) -> list[dict[str, str]]:
    custom = custom_urls or {}
    state_code = state.strip().upper() or "FL"
    appraiser_url = custom.get("county_appraiser") or (VERIFIED_FLORIDA_APPRAISERS.get(normalize_county_name(county), "") if state_code == "FL" else "")
    values: list[dict[str, str]] = []
    for source in PROPERTY_SOURCES:
        url = custom.get(source.key, source.official_url)
        if state_code != "FL" and source.key in {"fl_dor_officials", "fl_dor_roll_gis", "fl_geospatial", "fl_sunbiz", "county_clerk"} and source.key not in custom:
            url = ""
        if source.key == "census_geocoder" and address:
            url = f"https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?{urlencode({'address': address, 'benchmark': 'Public_AR_Current', 'vintage': 'Current_Current', 'format': 'html'})}"
        elif source.key == "nws_api":
            url = f"{NWS_API_URL}/alerts/active?area={state_code}"
        elif source.key == "county_appraiser":
            url = appraiser_url
        values.append({"key": source.key, "label": source.label, "url": url, "method": source.default_method, "capability": source.capability})
    return values


def validate_public_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Source URL must be an absolute HTTP or HTTPS URL.")
    return value.strip()


def florida_parcel_map_url(latitude: float, longitude: float, zoom: int = 18) -> str:
    latitude = float(latitude)
    longitude = float(longitude)
    zoom = int(zoom)
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError("Property coordinates are outside valid latitude/longitude bounds.")
    if not 3 <= zoom <= 23:
        raise ValueError("Florida parcel-map zoom must be between 3 and 23.")
    location = f"{latitude:.6f},{longitude:.6f},{zoom}"
    return f"{FLORIDA_STATEWIDE_PARCEL_MAP_URL}?{urlencode({'location': location})}"


class ArcGISFeatureCollector:
    def __init__(self, session: requests.Session):
        self.session = session

    def collect(
        self,
        feature_layer_url: str,
        *,
        where: str = "1=1",
        token: str = "",
        out_fields: str = "*",
        geometry: str | dict[str, Any] = "",
        geometry_type: str = "esriGeometryEnvelope",
        page_size: int = 2000,
        maximum: int = 10_000,
    ) -> tuple[list[dict[str, Any]], list[tuple[str, bytes, dict[str, str]]]]:
        endpoint = validate_public_url(feature_layer_url).rstrip("/") + "/query"
        features: list[dict[str, Any]] = []
        raw_pages: list[tuple[str, bytes, dict[str, str]]] = []
        offset = 0
        while len(features) < maximum:
            params: dict[str, Any] = {
                "f": "geojson",
                "where": where or "1=1",
                "outFields": out_fields or "*",
                "returnGeometry": "true",
                "outSR": 4326,
                "resultOffset": offset,
                "resultRecordCount": min(page_size, maximum - len(features)),
            }
            if geometry:
                params.update({
                    "geometry": json.dumps(geometry, ensure_ascii=False, separators=(",", ":")) if isinstance(geometry, dict) else geometry,
                    "geometryType": geometry_type,
                    "inSR": 4326,
                    "spatialRel": "esriSpatialRelIntersects",
                })
            if token:
                params["token"] = token
            response = self.session.get(endpoint, params=params, timeout=90)
            raw_pages.append((response.url, response.content, {str(k): str(v) for k, v in response.headers.items()}))
            response.raise_for_status()
            payload = response.json()
            if payload.get("error"):
                raise RuntimeError(json.dumps(payload["error"], ensure_ascii=False))
            page_features = payload.get("features", [])
            features.extend(page_features)
            if not page_features or len(page_features) < params["resultRecordCount"]:
                break
            offset += len(page_features)
        return features[:maximum], raw_pages


class NWSAlertsCollector:
    def __init__(self, session: requests.Session):
        self.session = session

    def collect(self, *, area: str = "FL", status: str = "actual") -> tuple[list[dict[str, Any]], bytes, str, dict[str, str]]:
        response = self.session.get(
            f"{NWS_API_URL}/alerts/active",
            params={"area": area, "status": status},
            headers={"Accept": "application/geo+json"},
            timeout=60,
        )
        raw = response.content
        response.raise_for_status()
        payload = response.json()
        return list(payload.get("features", [])), raw, response.url, {str(k): str(v) for k, v in response.headers.items()}


def discover_storm_bulk_url(session: requests.Session, year: int) -> str:
    response = session.get(NOAA_STORM_BULK_INDEX, timeout=60)
    response.raise_for_status()
    pattern = re.compile(rf'href="(StormEvents_details-ftp_v1\.0_d{int(year)}_c\d+\.csv\.gz)"', re.IGNORECASE)
    matches = sorted(set(pattern.findall(response.text)))
    if not matches:
        raise RuntimeError(f"NOAA bulk index has no Storm Events details file for {year}.")
    return urljoin(NOAA_STORM_BULK_INDEX, matches[-1])


def collect_storm_events(
    session: requests.Session,
    years: Iterable[int],
    *,
    state: str = "FLORIDA",
    event_types: Iterable[str] = (),
    begin: date | None = None,
    end: date | None = None,
    maximum: int = 100_000,
) -> tuple[pd.DataFrame, list[tuple[str, bytes, dict[str, str]]]]:
    frames: list[pd.DataFrame] = []
    raw_assets: list[tuple[str, bytes, dict[str, str]]] = []
    wanted = {item.strip().upper() for item in event_types if item.strip()}
    for year in sorted(set(int(item) for item in years)):
        url = discover_storm_bulk_url(session, year)
        response = session.get(url, timeout=180)
        raw_assets.append((url, response.content, {str(k): str(v) for k, v in response.headers.items()}))
        response.raise_for_status()
        with gzip.GzipFile(fileobj=io.BytesIO(response.content)) as compressed:
            frame = pd.read_csv(compressed, dtype=str, low_memory=False)
        if "STATE" in frame:
            frame = frame.loc[frame["STATE"].str.upper() == state.upper()]
        if wanted and "EVENT_TYPE" in frame:
            frame = frame.loc[frame["EVENT_TYPE"].str.upper().isin(wanted)]
        if "BEGIN_DATE_TIME" in frame and (begin or end):
            dates = pd.to_datetime(frame["BEGIN_DATE_TIME"], errors="coerce")
            if begin:
                frame = frame.loc[dates.dt.date >= begin]
                dates = dates.loc[frame.index]
            if end:
                frame = frame.loc[dates.dt.date <= end]
        frames.append(frame)
        if sum(len(item) for item in frames) >= maximum:
            break
    return (pd.concat(frames, ignore_index=True).head(maximum) if frames else pd.DataFrame()), raw_assets
