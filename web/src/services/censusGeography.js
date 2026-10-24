const { getPool } = require('../db/pool');

const DEFAULT_YEAR = 2024;
const POPULATION_VARIABLE = 'B01003_001E';
const STATE_BY_FIPS = Object.freeze({
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL',
  '13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME',
  '24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH',
  '34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI',
  '45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY',
});
const STATE_FIPS = Object.keys(STATE_BY_FIPS);
const SOURCE_ROOT = 'https://api.census.gov/data';

async function refreshCensusGeographies(pool = null, options = {}) {
  const p = pool || getPool();
  const apiKey = String(options.apiKey || process.env.CENSUS_API_KEY || '').trim();
  const year = normalizeYear(options.year || process.env.CENSUS_DATA_YEAR || DEFAULT_YEAR);
  if (!apiKey) {
    throw Object.assign(new Error('CENSUS_API_KEY is required to refresh official population data'), { status: 409 });
  }
  const sourceUrl = `${SOURCE_ROOT}/${year}/acs/acs5`;
  const nationRows = await censusRequest(year, apiKey, { get: `NAME,${POPULATION_VARIABLE}`, for: 'us:*' });
  const stateRows = await censusRequest(year, apiKey, { get: `NAME,${POPULATION_VARIABLE}`, for: 'state:*' });
  const records = [];
  const nation = nationRows[0];
  if (!nation) throw Object.assign(new Error('Census nation response was empty'), { status: 502 });
  records.push(referenceRecord(year, 'nation', '', '', null, nation.NAME, 'united states', nation[POPULATION_VARIABLE], sourceUrl));
  for (const row of stateRows) {
    const stateFips = String(row.state || '').padStart(2, '0');
    if (!STATE_BY_FIPS[stateFips]) continue;
    records.push(referenceRecord(
      year, 'state', stateFips, '', STATE_BY_FIPS[stateFips], row.NAME,
      normalizePlaceName(row.NAME), row[POPULATION_VARIABLE], sourceUrl
    ));
  }
  for (const stateFips of STATE_FIPS) {
    const placeRows = await censusRequest(year, apiKey, {
      get: `NAME,${POPULATION_VARIABLE}`, for: 'place:*', in: `state:${stateFips}`,
    });
    for (const row of placeRows) {
      const placeFips = String(row.place || '').padStart(5, '0');
      const placeName = censusPlaceLabel(row.NAME);
      records.push(referenceRecord(
        year, 'place', stateFips, placeFips, STATE_BY_FIPS[stateFips], placeName,
        normalizePlaceName(placeName), row[POPULATION_VARIABLE], sourceUrl
      ));
    }
    if (options.pageDelayMs !== 0) await sleep(Math.max(Number(options.pageDelayMs) || 75, 0));
  }

  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM census_geography_reference WHERE dataset_year = ?', [year]);
    for (let index = 0; index < records.length; index += 500) {
      const batch = records.slice(index, index + 500);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
      const params = batch.flatMap((record) => record);
      await conn.query(
        `INSERT INTO census_geography_reference
           (dataset_year, geography_type, state_fips, place_fips, state_code,
            name, normalized_name, population, source_url)
         VALUES ${placeholders}`,
        params
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return censusReferenceStatus(p, year);
}

async function censusReferenceStatus(pool = null, requestedYear = null) {
  const p = pool || getPool();
  try {
    const [latest] = await p.query(
      `SELECT dataset_year AS datasetYear, MAX(fetched_at) AS fetchedAt,
              SUM(geography_type = 'state' AND state_code <> 'DC') AS states,
              SUM(geography_type = 'state' AND state_code = 'DC') AS districts,
              SUM(geography_type = 'place') AS places
       FROM census_geography_reference
       ${requestedYear ? 'WHERE dataset_year = ?' : ''}
       GROUP BY dataset_year ORDER BY dataset_year DESC LIMIT 1`,
      requestedYear ? [normalizeYear(requestedYear)] : []
    );
    return {
      available: Boolean(latest[0]),
      apiKeyConfigured: Boolean(String(process.env.CENSUS_API_KEY || '').trim()),
      ...(latest[0] || { datasetYear: null, fetchedAt: null, states: 0, places: 0 }),
      source: latest[0] ? `U.S. Census Bureau ${latest[0].datasetYear} ACS 5-year` : null,
    };
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return {
      available: false,
      apiKeyConfigured: Boolean(String(process.env.CENSUS_API_KEY || '').trim()),
      datasetYear: null,
      fetchedAt: null,
      states: 0,
      districts: 0,
      places: 0,
      source: null,
    };
    throw error;
  }
}

async function censusRequest(year, apiKey, query) {
  const url = new URL(`${SOURCE_ROOT}/${year}/acs/acs5`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  url.searchParams.set('key', apiKey);
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error' });
    if (response.ok || (response.status !== 429 && response.status < 500)) break;
    if (attempt < 2) await sleep((attempt + 1) * 1000);
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Census Data API request failed with HTTP ${response.status}`), { status: 502 });
  }
  const body = await response.json();
  if (!Array.isArray(body) || !Array.isArray(body[0])) {
    throw Object.assign(new Error('Census Data API returned an invalid tabular response'), { status: 502 });
  }
  const headers = body[0];
  return body.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
}

function referenceRecord(year, type, stateFips, placeFips, stateCode, name, normalizedName, population, sourceUrl) {
  const count = Number(population);
  return [year, type, stateFips, placeFips, stateCode, String(name || '').slice(0, 255),
    String(normalizedName || '').slice(0, 191) || null, Number.isFinite(count) && count > 0 ? Math.round(count) : 0, sourceUrl];
}

function censusPlaceLabel(value) {
  const first = String(value || '').split(',')[0].trim();
  return first.replace(/\s+(city|town|village|borough|municipality|CDP)$/i, '')
    .replace(/\s+consolidated government.*$/i, '').replace(/\s+\(balance\)$/i, '').trim();
}

function normalizePlaceName(value) {
  return censusPlaceLabel(value).split('/')[0].toLowerCase().replace(/\bst[.]?\b/g, 'saint')
    .replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 191);
}

function normalizeYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2009 || year > new Date().getUTCFullYear()) {
    throw Object.assign(new Error('Census dataset year is invalid'), { status: 400 });
  }
  return year;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = {
  DEFAULT_YEAR,
  STATE_BY_FIPS,
  refreshCensusGeographies,
  censusReferenceStatus,
  normalizePlaceName,
  censusPlaceLabel,
};
