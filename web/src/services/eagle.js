const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getAuthorizedIntegration, publicIntegration } = require('./crmIntegrations');
const { walkCrmContacts, syncCustomFieldDefinitions, getPath, safeConfig } = require('./crmImporter');
const { listServicePools, classifyLeadRecord } = require('./servicePools');
const { censusReferenceStatus, normalizePlaceName } = require('./censusGeography');
const { buildCrmContactUrl } = require('./dncPulse');

const STATE_CODES = new Map(Object.entries({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
}));
const VALID_STATES = new Set([...STATE_CODES.values()]);
const US_STATE_CODES = new Set([...VALID_STATES].filter((code) => code !== 'DC'));
const EAGLE_METRIC_VERSION = '2.0';
const EAGLE_METRIC_DEFINITIONS = [
  metricDefinition('new_leads', 'New leads', 'Distinct CRM contacts added during the selected snapshot-anchored period.', 'count', 'CRM contacts added in period', null, 'crm_date_added'),
  metricDefinition('current_scheduled', 'Currently scheduled', 'Contacts whose current normalized disposition is Scheduled.', 'count', 'Contacts currently Scheduled', null, 'snapshot_current_state'),
  metricDefinition('current_scheduled_rate', 'Current scheduled rate', 'Contacts currently Scheduled divided by all contacts in scope.', 'percent', 'Contacts currently Scheduled', 'Contacts in scope', 'snapshot_current_state'),
  metricDefinition('current_won', 'Currently won', 'Contacts whose current normalized disposition is Closed Won.', 'count', 'Contacts currently Closed Won', null, 'snapshot_current_state'),
  metricDefinition('current_won_rate', 'Current won rate', 'Contacts currently Closed Won divided by all contacts in scope.', 'percent', 'Contacts currently Closed Won', 'Contacts in scope', 'snapshot_current_state'),
  metricDefinition('actionable_unassigned', 'Actionable unassigned', 'Unowned contacts excluding DNC and terminal dispositions.', 'count', 'Unowned non-terminal contacts', null, 'snapshot_current_state'),
  metricDefinition('source_coverage', 'Source attributed', 'Contacts with a governed, non-unknown source divided by contacts in scope.', 'percent', 'Contacts with governed source', 'Contacts in scope', 'snapshot_current_state'),
  metricDefinition('campaign_coverage', 'Campaign attributed', 'Contacts with a governed, non-unknown campaign divided by contacts in scope.', 'percent', 'Contacts with governed campaign', 'Contacts in scope', 'snapshot_current_state'),
  metricDefinition('dnc_blocked', 'DNC blocked', 'Contacts whose DNC screening state is blocked.', 'count', 'DNC-blocked contacts', null, 'snapshot_current_state'),
  metricDefinition('dnc_rate', 'DNC rate', 'DNC-blocked contacts divided by contacts in scope.', 'percent', 'DNC-blocked contacts', 'Contacts in scope', 'snapshot_current_state'),
  metricDefinition('location_completeness', 'Location completeness', 'Contacts with a valid U.S. state divided by contacts in scope.', 'percent', 'Contacts with valid state', 'Contacts in scope', 'snapshot_current_state'),
  metricDefinition('lead_to_appointment_rate', 'Lead-to-appointment', 'Mature cohort contacts with an authoritative appointment booking event divided by mature cohort leads.', 'percent', 'Mature leads ever booked', 'Mature cohort leads', 'lead_cohort_event_history'),
  metricDefinition('lead_to_win_rate', 'Lead-to-win', 'Mature cohort contacts with an authoritative dated won event divided by mature cohort leads.', 'percent', 'Mature leads ever won', 'Mature cohort leads', 'lead_cohort_event_history'),
  metricDefinition('appointment_to_win_rate', 'Appointment-to-win', 'Mature cohort contacts with an authoritative dated won event divided by mature cohort contacts ever booked.', 'percent', 'Mature leads ever won', 'Mature leads ever booked', 'lead_cohort_event_history'),
];
const DEMOGRAPHIC_CATALOG = [
  demographic('firstName', 'First name', 'Profile', 'text', true),
  demographic('lastName', 'Last name', 'Profile', 'text', true),
  demographic('email', 'Email', 'Profile', 'text', true),
  demographic('phone', 'Phone', 'Profile', 'text', true),
  demographic('businessName', 'Business name', 'Profile', 'text', true),
  demographic('address1', 'Street address', 'Profile', 'text', true),
  demographic('city', 'City', 'Profile'), demographic('state', 'State', 'Profile'),
  demographic('postalCode', 'Postal code', 'Profile'), demographic('country', 'Country', 'Profile'),
  demographic('website', 'Website', 'Profile', 'text', true),
  demographic('timeZone', 'Timezone', 'Profile'), demographic('dateOfBirth', 'Date of birth', 'Profile', 'date', true),
  demographic('age', 'Age', 'Profile', 'number'), demographic('contactSource', 'Contact source', 'Profile'),
  demographic('contactType', 'Contact type', 'Profile'), demographic('gender', 'Gender', 'Profile'),
  demographic('language', 'Language', 'Profile'),
  demographic('opportunityOwner', 'Opportunity owner', 'Opportunity'),
  demographic('opportunitySource', 'Opportunity source', 'Opportunity'),
  demographic('lostReason', 'Lost reason', 'Opportunity'),
  demographic('childrenInHousehold', 'Children in household', 'Household'),
  demographic('childrenAged13To18', 'Children aged 13-18', 'Household'),
  demographic('childrenAged10To12', 'Children aged 10-12', 'Household'),
  demographic('childrenAged7To9', 'Children aged 7-9', 'Household'),
  demographic('childrenAged4To6', 'Children aged 4-6', 'Household'),
  demographic('childrenAged0To3', 'Children aged 0-3', 'Household'),
  demographic('numberPeopleHousehold', 'People in household', 'Household', 'number'),
  demographic('numberChildrenHousehold', 'Children in household count', 'Household', 'number'),
  demographic('numberAdultsHousehold', 'Adults in household', 'Household', 'number'),
  demographic('creditScoreRange', 'Credit score range', 'Financial'),
  demographic('creditScoreMedian', 'Credit score median', 'Financial', 'number'),
  demographic('discretionaryIncome', 'Discretionary income', 'Financial', 'number'),
  demographic('medianHouseholdNetWorth', 'Median household net worth', 'Financial', 'number'),
  demographic('householdIncome', 'Household income', 'Financial'),
  demographic('books', 'Books', 'Interests'), demographic('diy', 'DIY', 'Interests'),
  demographic('music', 'Music', 'Interests'), demographic('gardening', 'Gardening', 'Interests'),
  demographic('cooking', 'Cooking', 'Interests'),
  demographic('homeowner', 'Homeowner', 'Property'), demographic('propertyType', 'Property type', 'Property'),
];

function metricDefinition(metricId, label, description, unit, numeratorLabel, denominatorLabel, timeBasis) {
  return { metricId, definitionVersion:EAGLE_METRIC_VERSION, label, description, unit, numeratorLabel, denominatorLabel, timeBasis, businessOwner:'Revenue Operations' };
}
const DEMOGRAPHIC_BY_KEY = new Map(DEMOGRAPHIC_CATALOG.map((item) => [item.key, item]));
const EXECUTIVE_DEMOGRAPHIC_KEYS = new Set([
  'age','gender','language','homeowner','propertyType','householdIncome','creditScoreRange',
  'creditScoreMedian','discretionaryIncome','medianHouseholdNetWorth','numberPeopleHousehold',
  'numberChildrenHousehold','numberAdultsHousehold','childrenInHousehold',
]);
const DEMOGRAPHIC_ALIASES = [
  ['opportunityOwner', /opportunity.*(owner|assigned to)|(^|\W)assigned to(\W|$)/i],
  ['opportunitySource', /opportunity.*source/i], ['lostReason', /lost reason/i],
  ['businessName', /business name|company name|company_name/i], ['address1', /street address|address1/i],
  ['postalCode', /postal code|postal_code|zip code/i], ['timeZone', /time ?zone/i],
  ['dateOfBirth', /(^|\W)(dob|date of birth|birth date)(\W|$)/i], ['gender', /(^|\W)(gender|sex)(\W|$)/i],
  ['contactSource', /contact.*source/i], ['contactType', /contact.*type/i], ['language', /language/i],
  ['childrenAged13To18', /children aged 13.?18/i], ['childrenAged10To12', /children aged 10.?12/i],
  ['childrenAged7To9', /children aged 7.?9/i], ['childrenAged4To6', /children aged 4.?6/i],
  ['childrenAged0To3', /children aged 0.?3/i],
  ['numberPeopleHousehold', /number of people in household|people in household/i],
  ['numberChildrenHousehold', /number of children in household/i],
  ['numberAdultsHousehold', /number of adults in household/i],
  ['childrenInHousehold', /children in household/i], ['creditScoreRange', /credit score range/i],
  ['creditScoreMedian', /credit score median/i], ['discretionaryIncome', /discretionary income/i],
  ['medianHouseholdNetWorth', /median household net worth|household net worth/i],
  ['householdIncome', /household income|annual income|income range/i],
  ['books', /(^|\W)books?(\W|$)/i], ['diy', /(^|\W)diy(\W|$)/i], ['music', /(^|\W)music(\W|$)/i],
  ['gardening', /(^|\W)gardening(\W|$)/i], ['cooking', /(^|\W)cooking(\W|$)/i],
  ['homeowner', /homeowner|home owner|ownership/i], ['propertyType', /property type|dwelling type|home type/i],
];

function demographic(key, label, category, type = 'category', sensitive = false) {
  return { key, label, category, type, sensitive };
}

async function listContexts(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT i.*, g.api_key_id, k.name AS api_key_name, k.key_prefix
     FROM crm_integrations i
     INNER JOIN crm_integration_grants g ON g.integration_id = i.id AND g.allow_read = 1
     INNER JOIN api_keys k ON k.id = g.api_key_id AND k.revoked_at IS NULL
     WHERE i.is_enabled = 1
     ORDER BY k.name, i.location_id, i.name`
  );
  return rows.map((row) => ({
    apiKeyId: row.api_key_id,
    apiKeyName: row.api_key_name,
    keyPrefix: row.key_prefix,
    integration: publicIntegration(row),
  }));
}

async function listAttributionMappings(input, pool = null) {
  const p = pool || getPool();
  const integrationId = required(input.integrationId, 'integrationId');
  await getAuthorizedIntegration(integrationId, required(input.apiKeyId, 'apiKeyId'), 'allow_read', p);
  const rows = await loadAttributionMappings(p, integrationId);
  return rows.map(publicAttributionMapping);
}

async function upsertAttributionMapping(input, admin, pool = null) {
  const p = pool || getPool();
  const integrationId = required(input.integrationId, 'integrationId');
  await getAuthorizedIntegration(integrationId, required(input.apiKeyId, 'apiKeyId'), 'allow_read', p);
  const dimension = String(input.dimension || '').toLowerCase();
  if (!['source', 'campaign'].includes(dimension)) throw Object.assign(new Error('dimension must be source or campaign'), { status:400 });
  const rawValue = required(input.rawValue, 'rawValue').slice(0, 255);
  const status = String(input.mappingStatus || 'active').toLowerCase();
  if (!['active', 'ignored'].includes(status)) throw Object.assign(new Error('mappingStatus must be active or ignored'), { status:400 });
  const canonicalValue = cleanText(input.canonicalValue, 255);
  if (status === 'active' && !canonicalValue) throw Object.assign(new Error('canonicalValue is required for an active mapping'), { status:400 });
  const unknownReason = cleanText(input.unknownReason, 32);
  await p.query(
    `INSERT INTO eagle_attribution_mappings
       (integration_id,dimension_type,raw_value,canonical_value,channel,mapping_status,unknown_reason,created_by)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE canonical_value=VALUES(canonical_value),channel=VALUES(channel),
       mapping_status=VALUES(mapping_status),unknown_reason=VALUES(unknown_reason),updated_at=CURRENT_TIMESTAMP`,
    [integrationId, dimension, rawValue, canonicalValue, cleanText(input.channel, 64), status, unknownReason, admin?.id || null]
  );
  const mappings = await loadAttributionMappings(p, integrationId);
  return publicAttributionMapping(mappings.find((row) => row.dimensionType === dimension && normalizeAttributionValue(row.rawValue) === normalizeAttributionValue(rawValue)));
}

async function loadAttributionMappings(pool, integrationId) {
  const [rows] = await pool.query(
    `SELECT id,integration_id AS integrationId,dimension_type AS dimensionType,raw_value AS rawValue,
            canonical_value AS canonicalValue,channel,mapping_status AS mappingStatus,
            unknown_reason AS unknownReason,updated_at AS updatedAt
     FROM eagle_attribution_mappings WHERE integration_id=? ORDER BY dimension_type,canonical_value,raw_value`,
    [integrationId]
  );
  return rows;
}

async function importOpportunitySnapshots(input, admin, pool = null) {
  const p = pool || getPool();
  const snapshot = await getSnapshot(required(input.snapshotId, 'snapshotId'), required(input.apiKeyId, 'apiKeyId'), p);
  if (input.integrationId && String(input.integrationId) !== String(snapshot.integrationId)) {
    throw Object.assign(new Error('Opportunity import integration does not match the snapshot'), { status:403 });
  }
  const records = Array.isArray(input.records) ? input.records : [];
  if (records.length > 10000) throw Object.assign(new Error('Opportunity imports are limited to 10,000 records'), { status:400 });
  const complete = input.isComplete === true;
  const normalized = records.map((record, index) => normalizeOpportunityRecord(record, index, complete));
  const importId = crypto.randomUUID();
  const sourceSystem = required(input.sourceSystem, 'sourceSystem').slice(0, 64);
  const conn = typeof p.getConnection === 'function' ? await p.getConnection() : p;
  try {
    if (typeof conn.beginTransaction === 'function') await conn.beginTransaction();
    if (complete) {
      await conn.query(
        `DELETE FROM eagle_lead_events WHERE integration_id=? AND source_type='opportunity_import'
         AND source_event_id IN (SELECT opportunity_id FROM eagle_opportunity_snapshots WHERE snapshot_id=?)`,
        [snapshot.integrationId, snapshot.id]
      );
      await conn.query('DELETE FROM eagle_opportunity_snapshots WHERE snapshot_id=?', [snapshot.id]);
    }
    await conn.query(
      `INSERT INTO eagle_outcome_imports
         (id,snapshot_id,integration_id,api_key_id,source_system,is_complete,records_received,
          records_with_won_at,imported_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [importId, snapshot.id, snapshot.integrationId, snapshot.apiKeyId, sourceSystem, complete ? 1 : 0,
        normalized.length, normalized.filter((row) => row.wonAt).length, admin?.id || null]
    );
    for (const row of normalized) {
      await conn.query(
        `INSERT INTO eagle_opportunity_snapshots
           (snapshot_id,import_id,integration_id,opportunity_id,external_contact_id,pipeline_id,stage_id,
            stage_name,opportunity_status,monetary_value,opened_at,won_at,lost_at,upstream_updated_at,metadata_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE import_id=VALUES(import_id),external_contact_id=VALUES(external_contact_id),
           pipeline_id=VALUES(pipeline_id),stage_id=VALUES(stage_id),stage_name=VALUES(stage_name),
           opportunity_status=VALUES(opportunity_status),monetary_value=VALUES(monetary_value),
           opened_at=VALUES(opened_at),won_at=VALUES(won_at),lost_at=VALUES(lost_at),
           upstream_updated_at=VALUES(upstream_updated_at),metadata_json=VALUES(metadata_json),captured_at=CURRENT_TIMESTAMP`,
        [snapshot.id, importId, snapshot.integrationId, row.opportunityId, row.contactId, row.pipelineId,
          row.stageId, row.stageName, row.status, row.monetaryValue, row.openedAt, row.wonAt,
          row.lostAt, row.updatedAt, row.metadata ? JSON.stringify(row.metadata) : null]
      );
      const events = [
        ['opportunity_opened', row.openedAt], ['opportunity_won', row.wonAt], ['opportunity_lost', row.lostAt],
      ].filter(([, eventAt]) => eventAt);
      for (const [eventType, eventAt] of events) {
        await conn.query(
          `INSERT INTO eagle_lead_events
             (integration_id,location_id,external_contact_id,event_type,event_at,source_type,
              source_event_id,event_status,metadata_json)
           VALUES (?,?,?,?,?,'opportunity_import',?,?,?)
           ON DUPLICATE KEY UPDATE external_contact_id=VALUES(external_contact_id),event_at=VALUES(event_at),
             event_status=VALUES(event_status),metadata_json=VALUES(metadata_json),last_seen_at=CURRENT_TIMESTAMP`,
          [snapshot.integrationId, snapshot.locationId, row.contactId, eventType, eventAt,
            row.opportunityId, row.status, JSON.stringify({ importId, sourceSystem, stageName:row.stageName })]
        );
      }
    }
    if (typeof conn.commit === 'function') await conn.commit();
  } catch (error) {
    if (typeof conn.rollback === 'function') await conn.rollback();
    throw error;
  } finally {
    if (conn !== p && typeof conn.release === 'function') conn.release();
  }
  return { id:importId, snapshotId:snapshot.id, integrationId:snapshot.integrationId, sourceSystem, isComplete:complete, recordsReceived:normalized.length, recordsWithWonAt:normalized.filter((row) => row.wonAt).length };
}

function normalizeOpportunityRecord(record, index = 0, complete = false) {
  const opportunityId = cleanText(record?.opportunityId || record?.id, 191);
  const contactId = cleanText(record?.contactId || record?.externalContactId, 191);
  if (!opportunityId || !contactId) throw Object.assign(new Error(`Opportunity record ${index + 1} requires opportunityId and contactId`), { status:400 });
  const status = String(record.status || '').trim().toLowerCase();
  if (!['open','won','lost'].includes(status)) throw Object.assign(new Error(`Opportunity record ${index + 1} status must be open, won, or lost`), { status:400 });
  const wonAt = normalizeOptionalDate(record.wonAt, `Opportunity record ${index + 1} wonAt`);
  const lostAt = normalizeOptionalDate(record.lostAt, `Opportunity record ${index + 1} lostAt`);
  if (complete && status === 'won' && !wonAt) throw Object.assign(new Error(`Opportunity record ${index + 1} requires wonAt for a complete import`), { status:400 });
  if (complete && status === 'lost' && !lostAt) throw Object.assign(new Error(`Opportunity record ${index + 1} requires lostAt for a complete import`), { status:400 });
  const monetaryValue = record.monetaryValue == null ? null : Number(record.monetaryValue);
  if (monetaryValue != null && !Number.isFinite(monetaryValue)) throw Object.assign(new Error(`Opportunity record ${index + 1} monetaryValue must be numeric`), { status:400 });
  return {
    opportunityId, contactId, status, wonAt, lostAt,
    openedAt:normalizeOptionalDate(record.openedAt, `Opportunity record ${index + 1} openedAt`),
    updatedAt:normalizeOptionalDate(record.updatedAt, `Opportunity record ${index + 1} updatedAt`),
    pipelineId:cleanText(record.pipelineId, 191), stageId:cleanText(record.stageId, 191),
    stageName:cleanText(record.stageName, 255), monetaryValue, metadata:null,
  };
}

function normalizeOptionalDate(value, label) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error(`${label} must be a valid timestamp`), { status:400 });
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function publicAttributionMapping(row) {
  if (!row) return null;
  return {
    id:row.id, integrationId:row.integrationId, dimension:row.dimensionType, rawValue:row.rawValue,
    canonicalValue:row.canonicalValue, channel:row.channel, mappingStatus:row.mappingStatus,
    unknownReason:row.unknownReason, updatedAt:row.updatedAt,
  };
}

async function createSnapshot(input, admin, pool = null) {
  const p = pool || getPool();
  const apiKeyId = required(input.apiKeyId, 'apiKeyId');
  const integrationId = required(input.integrationId, 'integrationId');
  const integration = await getAuthorizedIntegration(integrationId, apiKeyId, 'allow_read', p);
  const [active] = await p.query(
    `SELECT id FROM eagle_snapshots
     WHERE integration_id = ? AND status IN ('queued', 'running') LIMIT 1`,
    [integrationId]
  );
  if (active[0]) throw Object.assign(new Error('An EAGLE CRM refresh is already running'), { status: 409 });
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO eagle_snapshots
       (id, integration_id, api_key_id, location_id, status, requested_by)
     VALUES (?, ?, ?, ?, 'queued', ?)`,
    [id, integration.id, apiKeyId, integration.location_id, admin?.id || null]
  );
  setImmediate(() => executeSnapshot(integration, id, p).catch((error) => {
    console.error(`EAGLE snapshot ${id} failed:`, error.message);
  }));
  return getSnapshot(id, apiKeyId, p);
}

async function executeSnapshot(integration, snapshotId, pool = null) {
  const p = pool || getPool();
  const config = safeConfig(integration);
  const serviceRules = await listServicePools(p, 'core', integration.location_id);
  let total = 0;
  const pageSize = Math.min(config.maxPageSize, 100);
  await p.query(
    `UPDATE eagle_snapshots SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [snapshotId]
  );
  try {
    const localReady = await hasCompleteLocalContactSet(p, integration.id);
    await syncCustomFieldDefinitions(integration, p);
    const fieldDefinitions = await loadFieldDefinitions(p, integration.id);
    const onPage = async (page, progress) => {
      const externalIds = page.records.map((record) => String(getPath(record, config.idPath) || '').trim()).filter(Boolean);
      const overlays = await loadDialerOverlays(p, integration.id, externalIds);
      const facts = page.records.map((record) => normalizeRecord(
        record, integration, config, overlays, serviceRules, fieldDefinitions
      )).filter(Boolean);
      if (facts.length) await insertFacts(p, snapshotId, integration, facts);
      total += facts.length;
      await p.query(
        `UPDATE eagle_snapshots SET total_contacts = ?, pages_processed = ? WHERE id = ?`,
        [total, progress.pages, snapshotId]
      );
    };
    const walk = localReady
      ? await walkLocalContacts(p, integration.id, pageSize, onPage)
      : await walkCrmContacts(integration, { pageSize, pageBudget: 100000, onPage });
    await syncLeadEventsForSnapshot(integration, snapshotId, p);
    await p.query(
      `UPDATE eagle_snapshots SET status = ?, total_contacts = ?, pages_processed = ?,
         error_summary = ?, events_synced_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ['completed', total, walk.pages, null, snapshotId]
    );
    try {
      await pruneSnapshots(p, integration.id);
    } catch (error) {
      console.error(`EAGLE snapshot retention failed for ${integration.id}:`, error.message);
    }
  } catch (error) {
    await p.query(
      `UPDATE eagle_snapshots SET status = 'failed', error_summary = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [String(error.message || 'CRM refresh failed').slice(0, 1000), snapshotId]
    );
    throw error;
  }
  return getSnapshot(snapshotId, null, p);
}

async function syncLeadEventsForSnapshot(integration, snapshotId, pool = null) {
  const p = pool || getPool();
  await p.query(
    `INSERT INTO eagle_lead_events
       (integration_id,location_id,external_contact_id,lead_id,event_type,event_at,
        source_type,source_event_id,event_status,metadata_json)
     SELECT f.integration_id,f.location_id,f.external_contact_id,f.lead_id,'lead_created',f.crm_date_added,
            'crm_contact',f.external_contact_id,'recorded',NULL
     FROM eagle_lead_facts f
     WHERE f.snapshot_id=? AND f.crm_date_added IS NOT NULL
     ON DUPLICATE KEY UPDATE event_at=VALUES(event_at),lead_id=VALUES(lead_id),last_seen_at=CURRENT_TIMESTAMP`,
    [snapshotId]
  );
  await p.query(
    `INSERT INTO eagle_lead_events
       (integration_id,location_id,external_contact_id,lead_id,event_type,event_at,
        source_type,source_event_id,event_status,metadata_json)
     SELECT f.integration_id,f.location_id,f.external_contact_id,f.lead_id,'appointment_booked',
            COALESCE(a.createdAt,a.appointmentDate),'divedeep_appointment',CAST(a.id AS CHAR),a.status,
            JSON_OBJECT('appointmentDate',a.appointmentDate,'calendarId',a.calendarId,'userId',a.userId)
     FROM eagle_lead_facts f
     INNER JOIN appointments a ON a.leadId=f.lead_id AND a.locationId=f.location_id
     WHERE f.snapshot_id=? AND f.lead_id IS NOT NULL AND COALESCE(a.createdAt,a.appointmentDate) IS NOT NULL
     ON DUPLICATE KEY UPDATE external_contact_id=VALUES(external_contact_id),lead_id=VALUES(lead_id),
       event_at=VALUES(event_at),event_status=VALUES(event_status),metadata_json=VALUES(metadata_json),
       last_seen_at=CURRENT_TIMESTAMP`,
    [snapshotId]
  );
  const [counts] = await p.query(
    `SELECT event_type,COUNT(*) AS total FROM eagle_lead_events
     WHERE integration_id=? AND event_type IN ('lead_created','appointment_booked') GROUP BY event_type`,
    [integration.id]
  );
  return Object.fromEntries(counts.map((row) => [row.event_type, Number(row.total) || 0]));
}

async function hasCompleteLocalContactSet(pool, integrationId) {
  const [rows] = await pool.query(
    `SELECT r.id FROM crm_import_runs r
     WHERE r.integration_id = ? AND r.is_full_sync = 1 AND r.status = 'completed'
     ORDER BY r.completed_at DESC LIMIT 1`,
    [integrationId]
  );
  return Boolean(rows[0]);
}

async function walkLocalContacts(pool, integrationId, pageSize, onPage) {
  let afterId = '';
  let pages = 0;
  let records = 0;
  while (true) {
    const [rows] = await pool.query(
      `SELECT external_record_id, payload_json
       FROM crm_contact_records
       WHERE integration_id = ? AND is_current = 1 AND external_record_id > ?
       ORDER BY external_record_id ASC LIMIT ?`,
      [integrationId, afterId, pageSize]
    );
    if (!rows.length) break;
    const pageRecords = rows.map((row) => parseJsonValue(row.payload_json)).filter((record) => record && typeof record === 'object');
    pages += 1;
    records += pageRecords.length;
    afterId = String(rows[rows.length - 1].external_record_id);
    await onPage({ records: pageRecords }, { pages, records, cursor: afterId, expectedTotal: null });
    if (rows.length < pageSize) break;
  }
  return { pages, records, expectedTotal: records, cursor: null, lastCursor: afterId || null, completionReason: 'local_full_sync' };
}

async function pruneSnapshots(pool, integrationId, keep = 12) {
  const [rows] = await pool.query(
    `SELECT id FROM eagle_snapshots
     WHERE integration_id = ? AND status NOT IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1000 OFFSET ?`,
    [integrationId, keep]
  );
  if (!rows.length) return 0;
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  await pool.query(`DELETE FROM eagle_lead_facts WHERE snapshot_id IN (${placeholders})`, ids);
  const [result] = await pool.query(`DELETE FROM eagle_snapshots WHERE id IN (${placeholders})`, ids);
  return Number(result.affectedRows) || 0;
}

async function loadDialerOverlays(pool, integrationId, externalIds) {
  if (!externalIds.length) return new Map();
  const unique = [...new Set(externalIds)].slice(0, 500);
  const placeholders = unique.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT sl.external_record_id, l.id AS lead_id, l.serviceType, l.status, l.assignedTo,
            l.dncStatus, u.username
     FROM lead_source_links sl
     INNER JOIN leads l ON l.id = sl.lead_id
     LEFT JOIN users u ON u.id = l.assignedTo
     WHERE sl.integration_id = ? AND sl.external_record_id IN (${placeholders})`,
    [integrationId, ...unique]
  );
  return new Map(rows.map((row) => [String(row.external_record_id), row]));
}

async function loadFieldDefinitions(pool, integrationId) {
  const [rows] = await pool.query(
    `SELECT field_id, field_key, field_name, data_type
     FROM crm_object_field_definitions
     WHERE integration_id = ? AND is_current = 1`,
    [integrationId]
  );
  const definitions = new Map();
  for (const row of rows) {
    for (const candidate of [row.field_id, row.field_key, stripFieldModel(row.field_key)]) {
      const key = fieldDefinitionLookupKey(candidate);
      if (key) definitions.set(key, row);
    }
  }
  return definitions;
}

function normalizeRecord(record, integration, config, overlays, serviceRules, fieldDefinitions = new Map()) {
  const externalId = cleanText(getPath(record, config.idPath), 191);
  if (!externalId) return null;
  const overlay = overlays.get(externalId) || {};
  const firstName = value(record, ['firstName', 'first_name']);
  const lastName = value(record, ['lastName', 'last_name']);
  const fullName = value(record, ['name', 'fullName']) || [firstName, lastName].filter(Boolean).join(' ');
  const city = value(record, ['city', 'address.city', 'contact.city']);
  const stateCode = normalizeState(value(record, ['state', 'stateCode', 'address.state', 'contact.state']));
  const tags = normalizeTags(record.tags ?? record.tag ?? record.contactTags);
  const demographics = extractDemographics(record, fieldDefinitions);
  return {
    externalId,
    leadId: overlay.lead_id || null,
    fullName: cleanText(fullName, 255),
    email: cleanText(value(record, ['email', 'emailAddress']), 255),
    phone: cleanText(value(record, ['phone', 'phoneNumber', 'mobilePhone']), 64),
    city: cleanText(city, 128),
    stateCode,
    postalCode: cleanText(value(record, ['postalCode', 'zip', 'zipCode', 'address.postalCode']), 24),
    country: cleanText(value(record, ['country', 'countryCode', 'address.country']) || 'US', 64),
    source: cleanAttributionText(value(record, ['source', 'contactSource', 'attributionSource', 'attribution.source', 'lastAttributionSource']) || 'Unattributed', 191),
    campaign: cleanAttributionText(value(record, ['campaign', 'campaignName', 'attribution.campaign', 'lastAttributionCampaign']) || 'Unattributed', 191),
    medium: cleanAttributionText(value(record, ['medium', 'utmMedium', 'attribution.medium', 'lastAttributionMedium']), 128),
    serviceType: cleanText(classifyLeadRecord(record, serviceRules, overlay.serviceType || getPath(record, config.serviceTypePath)), 128),
    disposition: deriveDisposition(record, tags, overlay.status),
    crmAssignedTo: cleanText(value(record, ['assignedToName', 'assignedUserName', 'assignedTo', 'userId']), 191),
    dialStatus: cleanText(overlay.status, 64),
    dialAssignedTo: cleanText(overlay.username || overlay.assignedTo, 128),
    dncStatus: cleanText(overlay.dncStatus || deriveDnc(tags), 16),
    tags,
    dateAdded: normalizeDate(value(record, [config.dateAddedPath, 'dateAdded', 'createdAt'])),
    updatedAt: normalizeDate(value(record, [config.externalUpdatedPath, 'dateUpdated', 'updatedAt'])),
    demographics,
  };
}

function extractDemographics(record, fieldDefinitions) {
  const result = {
    firstName: value(record, ['firstName', 'first_name']), lastName: value(record, ['lastName', 'last_name']),
    email: value(record, ['email', 'emailAddress']), phone: value(record, ['phone', 'phoneNumber', 'mobilePhone']),
    businessName: value(record, ['companyName', 'company_name', 'businessName']),
    address1: value(record, ['address1', 'address.street', 'address.address1']),
    city: value(record, ['city', 'address.city']), state: value(record, ['state', 'stateCode', 'address.state']),
    postalCode: value(record, ['postalCode', 'postal_code', 'zip', 'zipCode', 'address.postalCode']),
    country: value(record, ['country', 'countryCode', 'address.country']), website: value(record, ['website']),
    timeZone: value(record, ['timezone', 'timeZone']), dateOfBirth: value(record, ['dateOfBirth', 'date_of_birth', 'dob']),
    contactSource: value(record, ['source', 'contactSource']), contactType: value(record, ['type', 'contactType']),
    opportunityOwner: value(record, ['opportunity.assignedTo', 'opportunity.assigned_to', 'assignedTo']),
    opportunitySource: value(record, ['opportunity.source', 'opportunitySource']),
    lostReason: value(record, ['opportunity.lostReason', 'opportunity.lost_reason', 'lostReason']),
    customFields: {},
  };
  const customFields = Array.isArray(record.customFields) ? record.customFields : [];
  for (const item of customFields) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || item.fieldId || item.key || '');
    const definition = resolveFieldDefinition(fieldDefinitions, [item.id, item.fieldId, item.key]) || {};
    const label = [definition.field_name, definition.field_key, item.key, item.name].filter(Boolean).join(' ');
    const displayLabel = String(definition.field_name || item.name || definition.field_key || item.key || id || 'Custom field');
    const fieldValue = item.value ?? item.fieldValue ?? item.values ?? null;
    if (!isPopulated(fieldValue)) continue;
    const knownKey = demographicKeyFor(label);
    if (knownKey && !isPopulated(result[knownKey])) result[knownKey] = fieldValue;
    const dynamicKey = normalizeDemographicKey(definition.field_key || item.key || displayLabel || id);
    if (dynamicKey) {
      result.customFields[dynamicKey] = {
        label: displayLabel.slice(0, 255), value: fieldValue,
        dataType: definition.data_type || null,
      };
    }
  }
  for (const [key, pattern] of DEMOGRAPHIC_ALIASES) {
    if (isPopulated(result[key])) continue;
    for (const [recordKey, fieldValue] of Object.entries(record)) {
      if (pattern.test(recordKey) && isPopulated(fieldValue)) { result[key] = fieldValue; break; }
    }
  }
  if (!isPopulated(result.age) && isPopulated(result.dateOfBirth)) result.age = ageFromDate(result.dateOfBirth);
  for (const key of Object.keys(result)) {
    if (key !== 'customFields' && !isPopulated(result[key])) delete result[key];
  }
  return result;
}

function demographicKeyFor(label) {
  return DEMOGRAPHIC_ALIASES.find(([, pattern]) => pattern.test(String(label || '')))?.[0] || null;
}

function normalizeDemographicKey(value) {
  return String(value || '').trim().toLowerCase().replace(/^contact\./, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 128);
}

function fieldDefinitionLookupKey(value) {
  const key = String(value || '').trim();
  return key ? key.toLowerCase() : '';
}

function stripFieldModel(value) {
  return String(value || '').replace(/^(contact|opportunity)\./i, '');
}

function resolveFieldDefinition(definitions, candidates) {
  for (const candidate of candidates) {
    const key = fieldDefinitionLookupKey(candidate);
    if (key && definitions.has(key)) return definitions.get(key);
    const stripped = fieldDefinitionLookupKey(stripFieldModel(candidate));
    if (stripped && definitions.has(stripped)) return definitions.get(stripped);
  }
  return null;
}

function resolveStoredDemographics(profile, fieldDefinitions) {
  if (!profile || typeof profile !== 'object' || !fieldDefinitions?.size) return profile;
  const resolved = { ...profile, customFields: {} };
  const customFields = profile.customFields && typeof profile.customFields === 'object'
    ? profile.customFields : {};
  for (const [rawKey, rawEntry] of Object.entries(customFields)) {
    const entry = rawEntry && typeof rawEntry === 'object' && Object.hasOwn(rawEntry, 'value')
      ? rawEntry : { value: rawEntry };
    const definition = resolveFieldDefinition(fieldDefinitions, [rawKey, entry.label]);
    if (!definition) {
      resolved.customFields[rawKey] = rawEntry;
      continue;
    }
    const label = String(definition.field_name || definition.field_key || entry.label || rawKey);
    const definitionText = [definition.field_name, definition.field_key].filter(Boolean).join(' ');
    const knownKey = demographicKeyFor(definitionText);
    if (knownKey && !isPopulated(resolved[knownKey])) resolved[knownKey] = entry.value;
    const dynamicKey = normalizeDemographicKey(definition.field_key || label || rawKey);
    resolved.customFields[dynamicKey || rawKey] = {
      ...entry,
      label: label.slice(0, 255),
      dataType: definition.data_type || entry.dataType || null,
    };
  }
  return resolved;
}

function ageFromDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - date.getUTCFullYear();
  if (now.getUTCMonth() < date.getUTCMonth() ||
      (now.getUTCMonth() === date.getUTCMonth() && now.getUTCDate() < date.getUTCDate())) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

async function insertFacts(pool, snapshotId, integration, facts) {
  const columns = [
    'snapshot_id', 'integration_id', 'location_id', 'external_contact_id', 'lead_id',
    'full_name', 'email', 'phone', 'city', 'state_code', 'postal_code', 'country',
    'marketing_source', 'campaign', 'medium', 'service_type', 'crm_disposition',
    'crm_assigned_to', 'dial_status', 'dial_assigned_to', 'dnc_status', 'tags_json',
    'crm_date_added', 'crm_updated_at', 'demographics_json',
  ];
  const placeholders = facts.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
  const params = [];
  for (const fact of facts) params.push(
    snapshotId, integration.id, integration.location_id, fact.externalId, fact.leadId,
    fact.fullName, fact.email, fact.phone, fact.city, fact.stateCode, fact.postalCode, fact.country,
    fact.source, fact.campaign, fact.medium, fact.serviceType, fact.disposition,
    fact.crmAssignedTo, fact.dialStatus, fact.dialAssignedTo, fact.dncStatus, JSON.stringify(fact.tags),
    fact.dateAdded, fact.updatedAt, JSON.stringify(fact.demographics)
  );
  await pool.query(
    `INSERT INTO eagle_lead_facts (${columns.join(',')}) VALUES ${placeholders}`,
    params
  );
}

async function getSnapshot(snapshotId, apiKeyId = null, pool = null) {
  const p = pool || getPool();
  const params = [snapshotId];
  let keyFilter = '';
  if (apiKeyId) { keyFilter = ' AND api_key_id = ?'; params.push(apiKeyId); }
  const [rows] = await p.query(
    `SELECT id, integration_id AS integrationId, api_key_id AS apiKeyId,
            location_id AS locationId, status, total_contacts AS totalContacts,
            pages_processed AS pagesProcessed, error_summary AS errorSummary,
            started_at AS startedAt, completed_at AS completedAt, events_synced_at AS eventsSyncedAt,
            created_at AS createdAt
     FROM eagle_snapshots WHERE id = ?${keyFilter} LIMIT 1`, params
  );
  if (!rows[0]) throw Object.assign(new Error('EAGLE snapshot not found'), { status: 404 });
  return rows[0];
}

async function latestSnapshot(integrationId, apiKeyId, pool = null) {
  const p = pool || getPool();
  await getAuthorizedIntegration(integrationId, apiKeyId, 'allow_read', p);
  const [rows] = await p.query(
    `SELECT id FROM eagle_snapshots
     WHERE integration_id = ? AND api_key_id = ? AND status IN ('completed', 'partial')
     ORDER BY completed_at DESC, created_at DESC LIMIT 1`,
    [integrationId, apiKeyId]
  );
  return rows[0] ? getSnapshot(rows[0].id, apiKeyId, p) : null;
}

function factFilters(input, alias = '', options = {}) {
  const prefix = alias ? `${alias}.` : '';
  const where = [`${prefix}snapshot_id = ?`];
  const params = [required(input.snapshotId, 'snapshotId')];
  const fields = [
    ['state', 'state_code', 2], ['city', 'city', 128], ['service', 'service_type', 128],
    ['disposition', 'crm_disposition', 64], ['source', 'marketing_source', 191],
    ['campaign', 'campaign', 191],
  ];
  for (const [key, column, max] of fields) {
    if (!input[key]) continue;
    if (['source', 'campaign'].includes(key) && input.integrationId) {
      const selected = String(input[key]).slice(0, max);
      if (selected === 'Unattributed') {
        where.push(`(LOWER(TRIM(COALESCE(${prefix}${column}, ''))) IN ('', 'unattributed', 'unknown', 'n/a', 'na', 'none', 'not set', '(not set)') OR EXISTS (
          SELECT 1 FROM eagle_attribution_mappings am
          WHERE am.integration_id = ? AND am.dimension_type = ? AND am.mapping_status = 'ignored'
            AND am.raw_value = ${prefix}${column}
        ))`);
        params.push(String(input.integrationId), key);
        continue;
      }
      if (selected === 'Unmapped identifier') {
        where.push(`(${prefix}${column} REGEXP '(campaign|source|form|ad)[[:space:]]*id' OR ${prefix}${column} REGEXP '^[0-9]{6,}$')`);
        continue;
      }
      where.push(`(${prefix}${column} = ? OR EXISTS (
        SELECT 1 FROM eagle_attribution_mappings am
        WHERE am.integration_id = ? AND am.dimension_type = ? AND am.mapping_status = 'active'
          AND am.canonical_value = ? AND am.raw_value = ${prefix}${column}
      ))`);
      params.push(selected, String(input.integrationId), key, selected);
      continue;
    }
    where.push(`${prefix}${column} = ?`);
    params.push(String(input[key]).slice(0, max));
  }
  const days = Number(input.days);
  if ([7, 30, 90, 365].includes(days)) {
    const asOf = options.asOf || new Date();
    const shift = Math.max(Number(options.periodShift) || 0, 0);
    const startDays = days * (shift + 1);
    const endDays = days * shift;
    where.push(`${prefix}crm_date_added > DATE_SUB(?, INTERVAL ? DAY)`);
    params.push(asOf, startDays);
    if (endDays) {
      where.push(`${prefix}crm_date_added <= DATE_SUB(?, INTERVAL ? DAY)`);
      params.push(asOf, endDays);
    } else {
      where.push(`${prefix}crm_date_added <= ?`);
      params.push(asOf);
    }
  }
  if (input.search) {
    where.push(`(${prefix}full_name LIKE ? OR ${prefix}email LIKE ? OR ${prefix}phone LIKE ? OR ${prefix}external_contact_id LIKE ?)`);
    const term = `%${String(input.search).slice(0, 100)}%`;
    params.push(term, term, term, term);
  }
  return { where: where.join(' AND '), params };
}

async function getDashboard(input, pool = null) {
  const p = pool || getPool();
  const snapshot = await getSnapshot(required(input.snapshotId, 'snapshotId'), input.apiKeyId || null, p);
  const asOf = snapshot.completedAt || snapshot.createdAt || new Date();
  const scopedInput = { ...input, integrationId:snapshot.integrationId };
  const filter = factFilters(scopedInput, '', { asOf });
  const days = [7, 30, 90, 365].includes(Number(input.days)) ? Number(input.days) : null;
  const previousFilter = days ? factFilters(scopedInput, '', { asOf, periodShift: 1 }) : null;
  const query = (sql, selectedFilter = filter) => p.query(sql, selectedFilter.params).then(([rows]) => rows);
  const summarySql = (selectedFilter) => `SELECT COUNT(*) AS total,
          SUM(state_code IS NOT NULL) AS geocoded,
          COUNT(DISTINCT state_code) AS states,
          COUNT(DISTINCT CASE WHEN city IS NOT NULL THEN CONCAT(state_code, ':', city) END) AS cities,
          SUM(dnc_status = 'blocked') AS dncBlocked,
          SUM(dial_assigned_to IS NOT NULL OR crm_assigned_to IS NOT NULL) AS assigned,
          SUM(dial_assigned_to IS NULL AND crm_assigned_to IS NULL
            AND COALESCE(dnc_status, '') <> 'blocked'
            AND crm_disposition NOT IN ('DNC', 'Not Interested', 'Closed DNQ', 'Closed Lost', 'Closed Won')) AS actionableUnassigned,
          SUM(crm_disposition = 'Scheduled') AS scheduled,
          SUM(crm_disposition = 'Closed Won') AS won
       FROM eagle_lead_facts WHERE ${selectedFilter.where}`;
  const sourceSql = (selectedFilter) => `SELECT COALESCE(marketing_source, 'Unattributed') AS label, COUNT(*) AS total,
          SUM(crm_disposition = 'Scheduled') AS scheduled, SUM(crm_disposition = 'Closed Won') AS won
       FROM eagle_lead_facts WHERE ${selectedFilter.where} GROUP BY marketing_source ORDER BY total DESC`;
  const campaignSql = (selectedFilter) => `SELECT COALESCE(campaign, 'Unattributed') AS label, COUNT(*) AS total,
          SUM(crm_disposition = 'Scheduled') AS scheduled, SUM(crm_disposition = 'Closed Won') AS won
       FROM eagle_lead_facts WHERE ${selectedFilter.where} GROUP BY campaign ORDER BY total DESC`;
  const [summaryRows, states, cities, dispositions, services, sourceRows, campaignRows, trend,
    previousSummaryRows, previousTrend, mappings, previousSourceRows, previousCampaignRows] = await Promise.all([
    query(summarySql(filter)),
    query(`SELECT COALESCE(state_code, 'NA') AS label, COUNT(*) AS total
       FROM eagle_lead_facts WHERE ${filter.where} GROUP BY state_code ORDER BY total DESC`),
    query(`SELECT COALESCE(city, 'Unknown') AS city, COALESCE(state_code, 'NA') AS state, COUNT(*) AS total,
          SUM(crm_disposition = 'Scheduled') AS scheduled, SUM(crm_disposition = 'Closed Won') AS won
       FROM eagle_lead_facts WHERE ${filter.where} GROUP BY city, state_code ORDER BY total DESC`),
    query(`SELECT crm_disposition AS label, COUNT(*) AS total
       FROM eagle_lead_facts WHERE ${filter.where} GROUP BY crm_disposition ORDER BY total DESC`),
    query(`SELECT COALESCE(service_type, 'Other') AS label, COUNT(*) AS total,
          SUM(crm_disposition = 'Scheduled') AS scheduled, SUM(crm_disposition = 'Closed Won') AS won
       FROM eagle_lead_facts WHERE ${filter.where} GROUP BY service_type ORDER BY total DESC`),
    query(sourceSql(filter)),
    query(campaignSql(filter)),
    query(`SELECT DATE(crm_date_added) AS date, COUNT(*) AS total,
          SUM(crm_disposition = 'Scheduled') AS scheduled, SUM(crm_disposition = 'Closed Won') AS won
       FROM eagle_lead_facts WHERE ${filter.where} AND crm_date_added IS NOT NULL
       GROUP BY DATE(crm_date_added) ORDER BY date ASC`),
    previousFilter ? query(summarySql(previousFilter), previousFilter) : Promise.resolve([]),
    previousFilter ? query(`SELECT DATE(crm_date_added) AS date, COUNT(*) AS total
       FROM eagle_lead_facts WHERE ${previousFilter.where} AND crm_date_added IS NOT NULL
       GROUP BY DATE(crm_date_added) ORDER BY date ASC`, previousFilter) : Promise.resolve([]),
    loadAttributionMappings(p, snapshot.integrationId),
    previousFilter ? query(sourceSql(previousFilter), previousFilter) : Promise.resolve([]),
    previousFilter ? query(campaignSql(previousFilter), previousFilter) : Promise.resolve([]),
  ]);
  const summary = numeric(summaryRows[0] || {});
  const previous = numeric(previousSummaryRows[0] || {});
  const governedSources = governAttributionRows(rowsNumeric(sourceRows), 'source', mappings);
  const governedCampaigns = governAttributionRows(rowsNumeric(campaignRows), 'campaign', mappings);
  const governedPreviousSources = governAttributionRows(rowsNumeric(previousSourceRows), 'source', mappings);
  const governedPreviousCampaigns = governAttributionRows(rowsNumeric(previousCampaignRows), 'campaign', mappings);
  summary.attributedSource = governedSources.filter((row) => !row.unknownReason).reduce((sum, row) => sum + row.total, 0);
  summary.attributedCampaign = governedCampaigns.filter((row) => !row.unknownReason).reduce((sum, row) => sum + row.total, 0);
  previous.attributedSource = governedPreviousSources.filter((row) => !row.unknownReason).reduce((sum, row) => sum + row.total, 0);
  previous.attributedCampaign = governedPreviousCampaigns.filter((row) => !row.unknownReason).reduce((sum, row) => sum + row.total, 0);
  summary.geoCoverage = summary.total ? Math.round(summary.geocoded / summary.total * 1000) / 10 : 0;
  summary.currentScheduledRate = percentOrNull(summary.scheduled, summary.total);
  summary.currentWonRate = percentOrNull(summary.won, summary.total);
  summary.dncRate = percentOrNull(summary.dncBlocked, summary.total);
  summary.sourceCoverage = percentOrNull(summary.attributedSource, summary.total);
  summary.campaignCoverage = percentOrNull(summary.attributedCampaign, summary.total);
  summary.previous = days ? {
    ...previous,
    geoCoverage:percentOrNull(previous.geocoded, previous.total),
    currentScheduledRate: percentOrNull(previous.scheduled, previous.total),
    currentWonRate: percentOrNull(previous.won, previous.total),
    dncRate:percentOrNull(previous.dncBlocked, previous.total),
    sourceCoverage: percentOrNull(previous.attributedSource, previous.total),
    campaignCoverage: percentOrNull(previous.attributedCampaign, previous.total),
  } : null;
  summary.totalDelta = summary.previous ? percentChange(summary.total, summary.previous.total) : null;
  summary.scheduledRateDelta = rateDelta(summary.currentScheduledRate, summary.previous?.currentScheduledRate) ;
  summary.wonRateDelta = rateDelta(summary.currentWonRate, summary.previous?.currentWonRate);
  const geography = await buildGeographicMetrics(p, summary, rowsNumeric(states), rowsNumeric(cities));
  const period = buildPeriodMetadata(asOf, days);
  const historicalFunnel = await getHistoricalFunnel(scopedInput, snapshot, asOf, summary.total, p);
  const breakdowns = {
    dispositions:buildBreakdown(rowsNumeric(dispositions), summary.total, { limit:50 }),
    services:buildBreakdown(rowsNumeric(services), summary.total),
    sources:buildBreakdown(governedSources, summary.total),
    campaigns:buildBreakdown(governedCampaigns, summary.total),
    cities:buildBreakdown(geography.cities.map((row) => ({ ...row, label:`${row.city}, ${row.state}` })), summary.total),
  };
  const metrics = { ...buildMetricContracts(summary, geography, period), ...historicalFunnel.metrics };
  return {
    contractVersion:EAGLE_METRIC_VERSION,
    summary,
    metrics,
    period,
    geography,
    reconciliation:{
      filteredTotal:summary.total,
      currentDisposition:breakdowns.dispositions.reconciliation,
      services:breakdowns.services.reconciliation,
      sources:breakdowns.sources.reconciliation,
      campaigns:breakdowns.campaigns.reconciliation,
      cities:breakdowns.cities.reconciliation,
    },
    historicalFunnel,
    breakdowns,
    states:geography.states, cities:breakdowns.cities.rows, dispositions:breakdowns.dispositions.rows,
    services:breakdowns.services.rows, sources:breakdowns.sources.rows, campaigns:breakdowns.campaigns.rows,
    trend: rowsNumeric(trend),
    previousTrend: rowsNumeric(previousTrend),
  };
}

function percentOrNull(value, total) {
  return Number(total) > 0 ? Math.round(Number(value || 0) / Number(total) * 1000) / 10 : null;
}

function percentChange(value, previous) {
  return Number(previous) > 0 ? Math.round((Number(value || 0) - Number(previous)) / Number(previous) * 1000) / 10 : null;
}

function rateDelta(value, previous) {
  return value == null || previous == null ? null : Math.round((Number(value) - Number(previous)) * 10) / 10;
}

function buildPeriodMetadata(asOfValue, days) {
  const asOf = new Date(asOfValue);
  const valid = !Number.isNaN(asOf.getTime());
  const end = valid ? asOf.toISOString() : String(asOfValue || '');
  const start = valid && days ? new Date(asOf.getTime() - days * 86400000).toISOString() : null;
  const previousStart = valid && days ? new Date(asOf.getTime() - days * 2 * 86400000).toISOString() : null;
  return { asOf: end, periodStart: start, periodEnd: end, previousPeriodStart: previousStart, previousPeriodEnd: start, days };
}

function normalizeAttributionValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function governAttributionRows(rows, dimension, mappings = []) {
  const mappingIndex = new Map(mappings.filter((row) => row.dimensionType === dimension)
    .map((row) => [normalizeAttributionValue(row.rawValue), row]));
  const governed = new Map();
  for (const input of rows) {
    const rawValue = cleanAttributionText(input.label, 255) || '';
    const normalized = normalizeAttributionValue(rawValue);
    const mapping = mappingIndex.get(normalized);
    let canonicalValue = rawValue;
    let mappingStatus = 'raw_unmapped';
    let unknownReason = null;
    let channel = null;
    if (mapping) {
      mappingStatus = mapping.mappingStatus;
      channel = mapping.channel || null;
      if (mapping.mappingStatus === 'ignored') {
        canonicalValue = mapping.canonicalValue || 'Unattributed';
        unknownReason = mapping.unknownReason || 'ignored';
      } else {
        canonicalValue = mapping.canonicalValue || rawValue;
        unknownReason = mapping.unknownReason || null;
      }
    } else if (!normalized) {
      canonicalValue = 'Unattributed'; unknownReason = 'missing'; mappingStatus = 'unknown';
    } else if (['unattributed','unknown','n/a','na','none','not set','(not set)'].includes(normalized)) {
      canonicalValue = 'Unattributed'; unknownReason = 'placeholder'; mappingStatus = 'unknown';
    } else if (/\b(campaign|source|form|ad)\s*id\b/i.test(rawValue) || /^\d{6,}$/.test(normalized)) {
      canonicalValue = 'Unmapped identifier'; unknownReason = 'identifier_only'; mappingStatus = 'unknown';
    }
    const key = `${normalizeAttributionValue(canonicalValue)}|${unknownReason || ''}`;
    const existing = governed.get(key) || {
      label:canonicalValue || 'Unattributed', total:0, scheduled:0, won:0,
      mappingStatus, unknownReason, channel, rawValues:[],
    };
    existing.total += Number(input.total) || 0;
    existing.scheduled += Number(input.scheduled) || 0;
    existing.won += Number(input.won) || 0;
    if (rawValue && !existing.rawValues.includes(rawValue) && existing.rawValues.length < 10) existing.rawValues.push(rawValue);
    if (mappingStatus === 'active') existing.mappingStatus = 'active';
    governed.set(key, existing);
  }
  return [...governed.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

function buildBreakdown(rows, filteredTotal, options = {}) {
  const limit = Math.max(Number(options.limit) || 20, 2);
  const decorated = rows.map((row) => decorateBreakdownRow(row, filteredTotal))
    .sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label)));
  const isUnknown = (row) => Boolean(row.unknownReason) || ['unknown','unattributed','na','unknown, na'].includes(normalizeAttributionValue(row.label));
  const mandatory = decorated.filter(isUnknown);
  const known = decorated.filter((row) => !isUnknown(row));
  let result = decorated;
  let omitted = [];
  if (decorated.length > limit) {
    const keepKnown = Math.max(limit - mandatory.length - 1, 0);
    result = [...known.slice(0, keepKnown), ...mandatory];
    omitted = known.slice(keepKnown);
    if (omitted.length) {
      result.push(decorateBreakdownRow({
        label:'Other (remaining)', total:sumField(omitted, 'total'), scheduled:sumField(omitted, 'scheduled'),
        won:sumField(omitted, 'won'), isOther:true,
      }, filteredTotal));
    }
  }
  const sourceTotal = sumField(decorated, 'total');
  const returnedTotal = sumField(result, 'total');
  const difference = Number(filteredTotal || 0) - sourceTotal;
  return {
    rows:result,
    reconciliation:{
      filteredTotal:Number(filteredTotal) || 0, sourceTotal, returnedTotal, difference,
      unknownTotal:sumField(mandatory, 'total'), otherTotal:sumField(omitted, 'total'),
      truncated:omitted.length > 0, rowCount:decorated.length, returnedRowCount:result.length,
      reconciled:difference === 0 && returnedTotal === sourceTotal,
    },
  };
}

function decorateBreakdownRow(row, filteredTotal) {
  const total = Number(row.total) || 0;
  return {
    ...row, total, scheduled:Number(row.scheduled) || 0, won:Number(row.won) || 0,
    share:percentOrNull(total, filteredTotal),
    scheduledRate:percentOrNull(row.scheduled, total), wonRate:percentOrNull(row.won, total),
    sample:sampleConfidence(total),
  };
}

function sampleConfidence(total) {
  if (Number(total) < 10) return { code:'small', label:'Small sample' };
  if (Number(total) < 30) return { code:'directional', label:'Directional' };
  return { code:'established', label:'Established volume' };
}

function sumField(rows, field) { return rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0); }

function buildMetricContracts(summary, geography, period) {
  const previous = summary.previous;
  return Object.fromEntries([
    semanticMetric('new_leads', summary.total, period, { previousValue:previous?.total, comparisonValue:summary.totalDelta, comparisonKind:'percent_change' }),
    semanticMetric('current_scheduled', summary.scheduled, period, { previousValue:previous?.scheduled, comparisonValue:previous ? percentChange(summary.scheduled, previous.scheduled) : null, comparisonKind:'percent_change' }),
    semanticMetric('current_scheduled_rate', summary.currentScheduledRate, period, { numerator:summary.scheduled, denominator:summary.total, previousValue:previous?.currentScheduledRate, comparisonValue:summary.scheduledRateDelta, comparisonKind:'percentage_points' }),
    semanticMetric('current_won', summary.won, period, { previousValue:previous?.won, comparisonValue:previous ? percentChange(summary.won, previous.won) : null, comparisonKind:'percent_change' }),
    semanticMetric('current_won_rate', summary.currentWonRate, period, { numerator:summary.won, denominator:summary.total, previousValue:previous?.currentWonRate, comparisonValue:summary.wonRateDelta, comparisonKind:'percentage_points' }),
    semanticMetric('actionable_unassigned', summary.actionableUnassigned, period, { previousValue:previous?.actionableUnassigned, comparisonValue:previous ? percentChange(summary.actionableUnassigned, previous.actionableUnassigned) : null, comparisonKind:'percent_change' }),
    semanticMetric('source_coverage', summary.sourceCoverage, period, { numerator:summary.attributedSource, denominator:summary.total, previousValue:previous?.sourceCoverage, comparisonValue:previous ? rateDelta(summary.sourceCoverage, previous.sourceCoverage) : null, comparisonKind:'percentage_points' }),
    semanticMetric('campaign_coverage', summary.campaignCoverage, period, { numerator:summary.attributedCampaign, denominator:summary.total, previousValue:previous?.campaignCoverage, comparisonValue:previous ? rateDelta(summary.campaignCoverage, previous.campaignCoverage) : null, comparisonKind:'percentage_points' }),
    semanticMetric('dnc_blocked', summary.dncBlocked, period, { previousValue:previous?.dncBlocked, comparisonValue:previous ? percentChange(summary.dncBlocked, previous.dncBlocked) : null, comparisonKind:'percent_change' }),
    semanticMetric('dnc_rate', summary.dncRate, period, { numerator:summary.dncBlocked, denominator:summary.total, previousValue:previous?.dncRate, comparisonValue:previous ? rateDelta(summary.dncRate, previous.dncRate) : null, comparisonKind:'percentage_points' }),
    semanticMetric('location_completeness', geography.dataCompleteness, period, { numerator:summary.geocoded, denominator:summary.total, previousValue:previous?.geoCoverage, comparisonValue:previous ? rateDelta(geography.dataCompleteness, previous.geoCoverage) : null, comparisonKind:'percentage_points' }),
  ].map((metric) => [metric.metricId, metric]));
}

function semanticMetric(metricId, value, period, options = {}) {
  const definition = EAGLE_METRIC_DEFINITIONS.find((item) => item.metricId === metricId);
  const available = value != null && Number.isFinite(Number(value));
  const status = options.status || (available ? 'available' : 'unavailable');
  return {
    ...definition, status, statusReason:options.statusReason || null, value:available ? Number(value) : null,
    numerator:options.numerator == null ? null : Number(options.numerator),
    denominator:options.denominator == null ? null : Number(options.denominator),
    previousValue:options.previousValue == null ? null : Number(options.previousValue),
    comparison:options.comparisonValue == null ? null : { kind:options.comparisonKind, value:Number(options.comparisonValue) },
    asOf:period.asOf, periodStart:period.periodStart, periodEnd:period.periodEnd,
  };
}

async function getHistoricalFunnel(input, snapshot, asOfValue, scopedTotal, pool = null) {
  const p = pool || getPool();
  const maturityDays = Math.min(Math.max(Number(process.env.EAGLE_COHORT_MATURITY_DAYS) || 14, 1), 90);
  const period = buildPeriodMetadata(asOfValue, [7,30,90,365].includes(Number(input.days)) ? Number(input.days) : null);
  const current = matureFactFilter(factFilters(input, 'f', { asOf:asOfValue }), asOfValue, maturityDays, 'f');
  const previousBase = period.days ? factFilters(input, 'f', { asOf:asOfValue, periodShift:1 }) : null;
  const previous = previousBase ? matureFactFilter(previousBase, asOfValue, maturityDays, 'f') : null;
  const cohortSql = (filter) => `SELECT COUNT(*) AS eligible,
      COUNT(DISTINCT CASE WHEN EXISTS (
        SELECT 1 FROM eagle_lead_events e WHERE e.integration_id=f.integration_id
          AND e.external_contact_id=f.external_contact_id AND e.event_type='appointment_booked'
          AND e.event_at>=f.crm_date_added
      ) THEN f.external_contact_id END) AS appointed,
      COUNT(DISTINCT CASE WHEN EXISTS (
        SELECT 1 FROM eagle_lead_events e WHERE e.integration_id=f.integration_id
          AND e.external_contact_id=f.external_contact_id AND e.event_type='opportunity_won'
          AND e.event_at>=f.crm_date_added
      ) THEN f.external_contact_id END) AS won
    FROM eagle_lead_facts f WHERE ${filter.where}`;
  const [currentRows, previousRows, importRows] = await Promise.all([
    p.query(cohortSql(current), current.params).then(([rows]) => rows),
    previous ? p.query(cohortSql(previous), previous.params).then(([rows]) => rows) : Promise.resolve([]),
    p.query(
      `SELECT id,source_system AS sourceSystem,is_complete AS isComplete,records_received AS recordsReceived,
              records_with_won_at AS recordsWithWonAt,created_at AS createdAt
       FROM eagle_outcome_imports WHERE snapshot_id=? ORDER BY created_at DESC LIMIT 1`,
      [snapshot.id]
    ).then(([rows]) => rows),
  ]);
  const cohort = numeric(currentRows[0] || {});
  const prior = numeric(previousRows[0] || {});
  const latestImport = importRows[0] ? numeric(importRows[0]) : null;
  const appointmentSource = snapshot.eventsSyncedAt
    ? { status:'available', source:'DiveDeep appointments', syncedAt:snapshot.eventsSyncedAt }
    : { status:'unavailable', source:'DiveDeep appointments', reason:'Refresh this EAGLE snapshot to synchronize appointment events.' };
  const opportunitySource = !latestImport
    ? { status:'unavailable', reason:'No opportunity extract has been imported for this snapshot.' }
    : latestImport.isComplete
      ? { status:'available', ...latestImport }
      : { status:'partial', reason:'The latest opportunity import is not marked complete.', ...latestImport };
  const appointmentReady = appointmentSource.status === 'available';
  const winReady = opportunitySource.status === 'available';
  const appointmentRate = appointmentReady ? percentOrNull(cohort.appointed, cohort.eligible) : null;
  const winRate = winReady ? percentOrNull(cohort.won, cohort.eligible) : null;
  const appointmentToWinRate = appointmentReady && winReady ? percentOrNull(cohort.won, cohort.appointed) : null;
  const priorAppointmentRate = appointmentReady && previous ? percentOrNull(prior.appointed, prior.eligible) : null;
  const priorWinRate = winReady && previous ? percentOrNull(prior.won, prior.eligible) : null;
  const priorAppointmentToWinRate = appointmentReady && winReady && previous ? percentOrNull(prior.won, prior.appointed) : null;
  const unavailableAppointmentReason = appointmentSource.reason || (Number(cohort.eligible) ? null : 'No mature leads are available in this cohort.');
  const unavailableWinReason = opportunitySource.reason || (Number(cohort.eligible) ? null : 'No mature leads are available in this cohort.');
  const metrics = {
    lead_to_appointment_rate:semanticMetric('lead_to_appointment_rate', appointmentRate, period, {
      numerator:cohort.appointed, denominator:cohort.eligible, previousValue:priorAppointmentRate,
      comparisonValue:rateDelta(appointmentRate, priorAppointmentRate), comparisonKind:'percentage_points',
      status:appointmentRate == null ? 'unavailable' : 'available', statusReason:appointmentRate == null ? unavailableAppointmentReason : null,
    }),
    lead_to_win_rate:semanticMetric('lead_to_win_rate', winRate, period, {
      numerator:cohort.won, denominator:cohort.eligible, previousValue:priorWinRate,
      comparisonValue:rateDelta(winRate, priorWinRate), comparisonKind:'percentage_points',
      status:winRate == null ? opportunitySource.status : 'available', statusReason:winRate == null ? unavailableWinReason : null,
    }),
    appointment_to_win_rate:semanticMetric('appointment_to_win_rate', appointmentToWinRate, period, {
      numerator:cohort.won, denominator:cohort.appointed, previousValue:priorAppointmentToWinRate,
      comparisonValue:rateDelta(appointmentToWinRate, priorAppointmentToWinRate), comparisonKind:'percentage_points',
      status:appointmentToWinRate == null ? (winReady ? 'unavailable' : opportunitySource.status) : 'available',
      statusReason:appointmentToWinRate == null ? (opportunitySource.reason || 'No authoritative appointment denominator is available.') : null,
    }),
  };
  const trend = await getOutcomeTrend(input, snapshot, period, winReady, p);
  const cutoff = new Date(new Date(asOfValue).getTime() - maturityDays * 86400000).toISOString();
  return {
    maturityDays, maturityCutoff:cutoff, scopedLeads:Number(scopedTotal) || 0,
    matureLeads:Number(cohort.eligible) || 0, immatureLeads:Math.max((Number(scopedTotal) || 0) - (Number(cohort.eligible) || 0), 0),
    appointedLeads:Number(cohort.appointed) || 0, wonLeads:winReady ? Number(cohort.won) || 0 : null,
    sources:{ appointments:appointmentSource, opportunities:opportunitySource },
    metrics, trend,
  };
}

function matureFactFilter(filter, asOf, maturityDays, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return {
    where:`${filter.where} AND ${prefix}crm_date_added IS NOT NULL AND ${prefix}crm_date_added <= DATE_SUB(?, INTERVAL ? DAY)`,
    params:[...filter.params, asOf, maturityDays],
  };
}

async function getOutcomeTrend(input, snapshot, period, winReady, pool) {
  const scopedInput = { ...input, days:'', integrationId:snapshot.integrationId };
  const filter = factFilters(scopedInput, 'f');
  const periodWhere = period.periodStart
    ? ' AND e.event_at > ? AND e.event_at <= ?'
    : '';
  const params = [snapshot.integrationId, ...filter.params, ...(period.periodStart ? [period.periodStart, period.periodEnd] : [])];
  const [rows] = await pool.query(
    `SELECT DATE(e.event_at) AS date,
            COUNT(DISTINCT CASE WHEN e.event_type='appointment_booked' THEN e.external_contact_id END) AS appointments,
            COUNT(DISTINCT CASE WHEN e.event_type='opportunity_won' THEN e.external_contact_id END) AS wins
     FROM eagle_lead_events e
     INNER JOIN eagle_lead_facts f ON f.integration_id=e.integration_id
       AND f.external_contact_id=e.external_contact_id
     WHERE e.integration_id=? AND ${filter.where}${periodWhere}
       AND e.event_type IN ('appointment_booked','opportunity_won')
     GROUP BY DATE(e.event_at) ORDER BY date`,
    params
  );
  return rowsNumeric(rows).map((row) => ({ ...row, wins:winReady ? row.wins : null }));
}

async function buildGeographicMetrics(pool, summary, stateRows, cityRows) {
  const status = await censusReferenceStatus(pool);
  const empty = {
    referenceAvailable: false, referenceYear: null, referenceFetchedAt: null,
    dataCompleteness: summary.geoCoverage || 0,
    statesPresent: stateRows.filter((row) => US_STATE_CODES.has(row.label)).length,
    statePresencePercent: percent(stateRows.filter((row) => US_STATE_CODES.has(row.label)).length, 50),
    reportedCities: cityRows.filter((row) => row.city !== 'Unknown').length,
    matchedCensusPlaces: 0, placeMatchRate: 0, statePopulationFootprint: null,
    placePopulationFootprint: null, representedPopulation: null, leadsPer100k: null,
    states: stateRows.map((row) => ({ ...row, population: null, leadsPer100k: null })),
    cities: cityRows.map((row) => ({ ...row, censusMatched: false, population: null, leadsPer100k: null })),
  };
  if (!status.available) return empty;
  const year = Number(status.datasetYear);
  const representedStateCodes = [...new Set(cityRows.map((row) => row.state)
    .filter((code) => VALID_STATES.has(code)))];
  const placeClause = representedStateCodes.length
    ? ` OR (geography_type = 'place' AND state_code IN (${representedStateCodes.map(() => '?').join(',')}))`
    : '';
  const [referenceRows] = await pool.query(
    `SELECT geography_type, state_code, place_fips, name, normalized_name, population
     FROM census_geography_reference
     WHERE dataset_year = ? AND (geography_type IN ('nation', 'state')${placeClause})`,
    [year, ...representedStateCodes]
  );
  const nationPopulation = Number(referenceRows.find((row) => row.geography_type === 'nation')?.population) || 0;
  const statePopulation = new Map(referenceRows.filter((row) => row.geography_type === 'state')
    .map((row) => [String(row.state_code), Number(row.population) || 0]));
  const placePopulation = new Map();
  for (const row of referenceRows.filter((item) => item.geography_type === 'place')) {
    const key = `${row.state_code}|${row.normalized_name}`;
    const existing = placePopulation.get(key);
    if (!existing || Number(row.population) > existing.population) {
      placePopulation.set(key, {
        key: `${row.state_code}|${row.place_fips}`, name: row.name,
        population: Number(row.population) || 0,
      });
    }
  }
  const states = stateRows.map((row) => {
    const population = statePopulation.get(row.label) || null;
    return { ...row, population, leadsPer100k: ratePer100k(row.total, population) };
  });
  const representedPlaces = new Map();
  let matchedLeadCount = 0;
  const cities = cityRows.map((row) => {
    const match = row.city === 'Unknown' ? null : placePopulation.get(`${row.state}|${normalizePlaceName(row.city)}`);
    if (match) {
      matchedLeadCount += Number(row.total) || 0;
      representedPlaces.set(match.key, match.population);
    }
    return {
      ...row, censusMatched: Boolean(match), censusName: match?.name || null,
      population: match?.population || null, leadsPer100k: ratePer100k(row.total, match?.population),
    };
  });
  const representedStates = new Set(states.filter((row) => statePopulation.has(row.label)).map((row) => row.label));
  const stateFootprintPopulation = [...representedStates].reduce((sum, code) => sum + (statePopulation.get(code) || 0), 0);
  const representedPopulation = [...representedPlaces.values()].reduce((sum, population) => sum + population, 0);
  const statesPresent = states.filter((row) => US_STATE_CODES.has(row.label)).length;
  return {
    ...empty,
    referenceAvailable: true, referenceYear: year, referenceFetchedAt: status.fetchedAt,
    statesPresent, statePresencePercent: percent(statesPresent, 50),
    reportedCities: cityRows.filter((row) => row.city !== 'Unknown').length,
    matchedCensusPlaces: representedPlaces.size,
    placeMatchRate: percent(matchedLeadCount, summary.total),
    statePopulationFootprint: percent(stateFootprintPopulation, nationPopulation),
    placePopulationFootprint: percent(representedPopulation, nationPopulation),
    representedPopulation,
    leadsPer100k: ratePer100k(matchedLeadCount, representedPopulation),
    states, cities,
  };
}

function ratePer100k(leads, population) {
  const denominator = Number(population);
  return denominator > 0 ? Math.round(Number(leads || 0) / denominator * 100000 * 100) / 100 : null;
}

async function getDemographics(input, pool = null) {
  const p = pool || getPool();
  const snapshot = await getSnapshot(required(input.snapshotId, 'snapshotId'), input.apiKeyId || null, p);
  const fieldDefinitions = await loadFieldDefinitions(p, snapshot.integrationId);
  const filter = factFilters({ ...input, integrationId:snapshot.integrationId }, '', { asOf: snapshot.completedAt || snapshot.createdAt || new Date() });
  const [rows] = await p.query(
    `SELECT demographics_json AS demographics
     FROM eagle_lead_facts WHERE ${filter.where}`,
    filter.params
  );
  return buildDemographicAnalytics(rows.map((row) => resolveStoredDemographics(
    parseJsonValue(row.demographics) || {}, fieldDefinitions
  )));
}

async function listDemographicContacts(input, pool = null) {
  const p = pool || getPool();
  const fieldKey = String(input.field || '').slice(0, 180);
  const segment = String(input.segment || '').slice(0, 120);
  if (!fieldKey || !segment) throw Object.assign(new Error('field and segment are required'), { status: 400 });
  const snapshot = await getSnapshot(required(input.snapshotId, 'snapshotId'), input.apiKeyId || null, p);
  const fieldDefinitions = await loadFieldDefinitions(p, snapshot.integrationId);
  const filter = factFilters({ ...input, integrationId:snapshot.integrationId }, '', { asOf: snapshot.completedAt || snapshot.createdAt || new Date() });
  const [rows] = await p.query(
    `SELECT external_contact_id AS contactId, lead_id AS leadId, full_name AS name, email, phone,
            city, state_code AS state, postal_code AS postalCode, marketing_source AS source,
            campaign, service_type AS service, crm_disposition AS disposition,
            crm_assigned_to AS crmOwner, dial_assigned_to AS dialOwner, dnc_status AS dncStatus,
            crm_date_added AS dateAdded, demographics_json AS demographics
     FROM eagle_lead_facts WHERE ${filter.where}
     ORDER BY COALESCE(crm_date_added, captured_at) DESC, external_contact_id LIMIT 10000`,
    filter.params
  );
  const profiles = rows.map((row) => resolveStoredDemographics(parseJsonValue(row.demographics) || {}, fieldDefinitions));
  const field = buildDemographicAnalytics(profiles).fields.find((item) => item.key === fieldKey);
  if (!field) throw Object.assign(new Error('Demographic field is not available in this scope'), { status: 404 });
  if (field.sensitive) throw Object.assign(new Error('Individual drill-through is unavailable for protected demographic fields'), { status: 403 });
  if (field.numeric) throw Object.assign(new Error('Select a categorical segment to view matching contacts'), { status: 400 });
  const matches = rows.map((row, index) => {
    const profile = profiles[index];
    const rawValue = fieldKey.startsWith('custom.')
      ? profile.customFields?.[fieldKey.slice(7)]?.value
      : profile[fieldKey];
    const values = (Array.isArray(rawValue) ? rawValue : [rawValue]).map(displayDemographicValue).filter(Boolean);
    if (!values.includes(segment)) return null;
    return {
      contactId: row.contactId, leadId: row.leadId, name: row.name, email: row.email, phone: row.phone,
      city: row.city, state: row.state, postalCode: row.postalCode, source: row.source, campaign: row.campaign,
      service: row.service, disposition: row.disposition, crmOwner: row.crmOwner, dialOwner: row.dialOwner,
      dncStatus: row.dncStatus, dateAdded: row.dateAdded, demographicValue: segment,
      crmUrl: safeCrmContactUrl(row.contactId, snapshot.locationId),
    };
  }).filter(Boolean);
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
  const offset = Math.max(Number(input.offset) || 0, 0);
  return { field:{ key:field.key, label:field.label, category:field.category }, segment, total:matches.length, limit, offset, rows:matches.slice(offset, offset + limit) };
}

function buildDemographicAnalytics(profiles) {
  const stats = new Map(DEMOGRAPHIC_CATALOG.map((field) => [field.key, newFieldStats(field)]));
  const categoryProfiles = new Map();
  let profilesWithData = 0;
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    const populatedCategories = new Set();
    let hasData = false;
    for (const field of DEMOGRAPHIC_CATALOG) {
      const fieldValue = profile[field.key];
      if (!isPopulated(fieldValue)) continue;
      hasData = true; populatedCategories.add(field.category);
      addFieldValue(stats.get(field.key), fieldValue);
    }
    const customFields = profile.customFields && typeof profile.customFields === 'object'
      ? profile.customFields : {};
    for (const [rawKey, entry] of Object.entries(customFields)) {
      const valueData = entry && typeof entry === 'object' && Object.hasOwn(entry, 'value') ? entry : { value: entry };
      if (!isPopulated(valueData.value)) continue;
      const key = `custom.${normalizeDemographicKey(rawKey)}`;
      const label = String(valueData.label || rawKey).slice(0, 255);
      const knownKey = demographicKeyFor(label);
      if (knownKey && isPopulated(profile[knownKey])) continue;
      const category = demographicCategory(label);
      if (!stats.has(key)) stats.set(key, newFieldStats({
        key, label, category, type: inferFieldType(label, valueData.dataType), sensitive: isSensitiveLabel(label), dynamic: true,
      }));
      hasData = true; populatedCategories.add(category);
      addFieldValue(stats.get(key), valueData.value);
    }
    if (hasData) profilesWithData += 1;
    for (const category of populatedCategories) {
      categoryProfiles.set(category, (categoryProfiles.get(category) || 0) + 1);
    }
  }
  const total = profiles.length;
  const fields = [...stats.values()].map((field) => finalizeFieldStats(field, total));
  const categories = [...new Set(fields.map((field) => field.category))].map((category) => ({
    category,
    populatedProfiles: categoryProfiles.get(category) || 0,
    coverage: percent(categoryProfiles.get(category) || 0, total),
    fields: fields.filter((field) => field.category === category)
      .sort((a, b) => b.populated - a.populated || a.label.localeCompare(b.label)),
  })).sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category));
  const summary = {
      totalProfiles: total,
      profilesWithData,
      profileCoverage: percent(profilesWithData, total),
      fieldsAvailable: fields.length,
      fieldsWithData: fields.filter((field) => field.populated > 0).length,
      customFields: fields.filter((field) => field.dynamic).length,
      populatedValues: fields.reduce((sum, field) => sum + field.populated, 0),
    };
  return {
    summary,
    executive:buildDemographicExecutiveSummary(profiles,fields,categories,summary),
    categories,
    fields,
  };
}

function buildDemographicExecutiveSummary(profiles,fields,categories,summary) {
  const highSignalProfiles=(profiles||[]).filter(profileHasExecutiveInsight).length;
  const insightCoverage=percent(highSignalProfiles,summary.totalProfiles);
  const candidates=[];const used=new Set();
  const add=(field)=>{if(field&&field.populated>0&&!field.sensitive&&!used.has(field.key)){used.add(field.key);candidates.push(field);}};
  const byKey=new Map(fields.map((field)=>[field.key,field]));
  ['homeowner','householdIncome','creditScoreRange','creditScoreMedian','propertyType','numberPeopleHousehold','age','gender','language','numberChildrenHousehold','discretionaryIncome','medianHouseholdNetWorth'].forEach((key)=>add(byKey.get(key)));
  fields.filter((field)=>field.dynamic&&/generation|marital status|life stage/i.test(field.label)).forEach(add);
  const spotlights=candidates.map(buildDemographicSpotlight).filter(Boolean).slice(0,8);
  const fragments=spotlights.map((item)=>item.narrativeFragment).filter(Boolean).slice(0,3);
  const headline=fragments.length
    ? `${capitalize(fragments[0])}${fragments.slice(1).map((item)=>`; ${item}`).join('')}.`
    : highSignalProfiles
      ? `${formatCount(highSignalProfiles)} profiles contain decision-useful audience signals.`
      : 'Decision-useful household, financial, and property signals are not yet available.';
  const domainReadiness=(categories||[]).filter((item)=>!['Profile'].includes(item.category)).map((item)=>({
    category:item.category==='Custom fields'?'Enrichment':item.category,
    coverage:item.coverage,populatedProfiles:item.populatedProfiles,
    status:item.coverage>=70?'strong':item.coverage>=30?'partial':item.coverage>0?'limited':'missing',
  }));
  return {
    contractVersion:'1.0',headline,
    confidence:highSignalProfiles>=30?'established':highSignalProfiles>=10?'directional':'limited',
    confidenceLabel:highSignalProfiles>=30?'Established audience sample':highSignalProfiles>=10?'Directional audience sample':'Limited audience sample',
    profilesWithInsight:highSignalProfiles,insightCoverage,
    spotlights,
    composition:spotlights.filter((item)=>item.kind==='category'&&item.distribution?.length>1).slice(0,4),
    domainReadiness,
    coverageGaps:domainReadiness.filter((item)=>item.coverage<50).sort((a,b)=>a.coverage-b.coverage).slice(0,3),
  };
}

function profileHasExecutiveInsight(profile) {
  if(!profile||typeof profile!=='object')return false;
  if([...EXECUTIVE_DEMOGRAPHIC_KEYS].some((key)=>isPopulated(profile[key])))return true;
  return Object.values(profile.customFields||{}).some((entry)=>{
    const value=entry&&typeof entry==='object'&&Object.hasOwn(entry,'value')?entry.value:entry;
    const label=entry&&typeof entry==='object'?entry.label:'';
    return /generation|marital status|life stage/i.test(String(label||''))&&isPopulated(value);
  });
}

function buildDemographicSpotlight(field) {
  const dominant=field.topValues?.[0]||null;
  const numeric=field.numeric;
  if(!dominant&&!numeric)return null;
  const currency=/income|worth/i.test(field.key);
  let title=field.label,displayValue,supportingText,narrativeFragment=null;
  if(numeric){
    displayValue=numeric.median;
    supportingText=`Median across ${formatCount(numeric.count)} profiled contacts`;
    if(field.key==='creditScoreMedian')narrativeFragment=`median credit score is ${formatCount(numeric.median)}`;
    else if(field.key==='age')narrativeFragment=`median age is ${formatCount(numeric.median)}`;
    else if(field.key==='numberPeopleHousehold')narrativeFragment=`median household size is ${formatCount(numeric.median)}`;
  } else {
    displayValue=dominant.label;
    supportingText=`${dominant.share}% of ${formatCount(field.populated)} profiled contacts`;
    if(field.key==='homeowner'&&/^(yes|true|homeowner|owner)$/i.test(dominant.label)){title='Homeowners';displayValue=`${dominant.share}%`;narrativeFragment=`${dominant.share}% are homeowners`;}
    else if(field.key==='householdIncome')narrativeFragment=`the leading income band is ${dominant.label} (${dominant.share}%)`;
    else if(field.key==='propertyType')narrativeFragment=`${dominant.label} is the leading property type (${dominant.share}%)`;
    else if(/generation/i.test(field.label))narrativeFragment=`${dominant.label} is the largest generation segment (${dominant.share}%)`;
  }
  return {
    key:field.key,title,category:field.category,kind:numeric?'numeric':'category',format:currency?'currency':'plain',
    displayValue,supportingText,coverage:field.coverage,sampleSize:field.populated,confidence:field.populated>=30?'established':field.populated>=10?'directional':'limited',
    distribution:(field.topValues||[]).slice(0,6),numeric,narrativeFragment,
  };
}

function capitalize(value){const text=String(value||'');return text?text[0].toUpperCase()+text.slice(1):text;}
function formatCount(value){return Number(value||0).toLocaleString('en-US',{maximumFractionDigits:1});}

function newFieldStats(field) {
  return { ...field, populated: 0, values: new Map(), numbers: [] };
}

function addFieldValue(field, valueData) {
  field.populated += 1;
  const values = Array.isArray(valueData) ? valueData : [valueData];
  for (const valueItem of values) {
    const label = displayDemographicValue(valueItem);
    if (label && !field.sensitive) field.values.set(label, (field.values.get(label) || 0) + 1);
  }
  if (field.type === 'number') {
    const number = parseDemographicNumber(valueData);
    if (number != null) field.numbers.push(number);
  }
}

function finalizeFieldStats(field, total) {
  const values = [...field.values.entries()].map(([label, count]) => ({ label, count, share: percent(count, field.populated) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 12);
  const numbers = field.numbers.sort((a, b) => a - b);
  const numeric = numbers.length ? {
    count: numbers.length,
    minimum: numbers[0], maximum: numbers[numbers.length - 1],
    average: Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length * 100) / 100,
    median: median(numbers),
  } : null;
  return {
    key: field.key, label: field.label, category: field.category, type: field.type,
    sensitive: Boolean(field.sensitive), dynamic: Boolean(field.dynamic), populated: field.populated,
    coverage: percent(field.populated, total), uniqueValues: field.values.size, topValues: values, numeric,
  };
}

function demographicCategory(label) {
  const text = String(label || '').toLowerCase();
  if (/child|household|people in|adults? in/.test(text)) return 'Household';
  if (/credit|income|net worth|financial|wealth/.test(text)) return 'Financial';
  if (/book|music|garden|cook|hobby|interest|(^|\W)diy(\W|$)/.test(text)) return 'Interests';
  if (/homeowner|property|dwelling|home type/.test(text)) return 'Property';
  if (/opportunity|lost reason|assigned to/.test(text)) return 'Opportunity';
  if (/name|email|phone|address|city|state|postal|country|website|timezone|birth|contact/.test(text)) return 'Profile';
  return 'Custom fields';
}

function inferFieldType(label, dataType) {
  const text = `${label || ''} ${dataType || ''}`.toLowerCase();
  return /number|numeric|score median|people|adults|children count|income|net worth/.test(text) ? 'number' : 'category';
}

function isSensitiveLabel(label) {
  return /first name|last name|full name|email|phone|street address|address1|website|date of birth|\bdob\b/i.test(String(label || ''));
}

function isPopulated(valueData) {
  if (valueData == null) return false;
  if (Array.isArray(valueData)) return valueData.some(isPopulated);
  if (typeof valueData === 'object') return Object.keys(valueData).length > 0;
  return String(valueData).trim() !== '';
}

function displayDemographicValue(valueData) {
  if (valueData == null || typeof valueData === 'object') return null;
  const text = String(valueData).trim();
  return text ? text.slice(0, 120) : null;
}

function parseDemographicNumber(valueData) {
  const value = Array.isArray(valueData) ? valueData[0] : valueData;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = String(value == null ? '' : value).replace(/[$,%\s,]/g, '');
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function median(numbers) {
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : Math.round((numbers[middle - 1] + numbers[middle]) / 2 * 100) / 100;
}

function percent(value, total) {
  return total ? Math.round(value / total * 1000) / 10 : 0;
}

function categoryOrder(category) {
  return ['Profile', 'Household', 'Financial', 'Interests', 'Property', 'Opportunity', 'Custom fields'].indexOf(category) + 1 || 99;
}

async function listFacts(input, pool = null) {
  const p = pool || getPool();
  const snapshot = await getSnapshot(required(input.snapshotId, 'snapshotId'), input.apiKeyId || null, p);
  const filter = factFilters({ ...input, integrationId:snapshot.integrationId }, '', { asOf: snapshot.completedAt || snapshot.createdAt || new Date() });
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), input.export ? 10000 : 200);
  const offset = input.export ? 0 : Math.max(Number(input.offset) || 0, 0);
  const [rows] = await p.query(
    `SELECT external_contact_id AS contactId, lead_id AS leadId, full_name AS name, email, phone,
            city, state_code AS state, postal_code AS postalCode, marketing_source AS source,
            campaign, medium, service_type AS service, crm_disposition AS disposition,
            crm_assigned_to AS crmOwner, dial_status AS dialStatus,
            dial_assigned_to AS dialOwner, dnc_status AS dncStatus,
            crm_date_added AS dateAdded, crm_updated_at AS updatedAt,
            demographics_json AS demographics
     FROM eagle_lead_facts WHERE ${filter.where}
     ORDER BY COALESCE(crm_date_added, captured_at) DESC, external_contact_id LIMIT ? OFFSET ?`,
    [...filter.params, limit, offset]
  );
  const [counts] = await p.query(
    `SELECT COUNT(*) AS total FROM eagle_lead_facts WHERE ${filter.where}`, filter.params
  );
  const normalizedRows = rows.map((row) => {
    const demographics = parseJsonValue(row.demographics) || {};
    return {
      ...row,
      crmUrl: safeCrmContactUrl(row.contactId, snapshot.locationId),
      demographics,
      ...demographics,
    };
  });
  return { rows: normalizedRows, total: Number(counts[0]?.total) || 0, limit, offset };
}

function safeCrmContactUrl(contactId, locationId) {
  try { return buildCrmContactUrl({ contactId, locationId }); }
  catch { return null; }
}

function parseJsonValue(value) {
  if (value == null || typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function value(record, paths) {
  for (const path of paths) {
    if (!path) continue;
    const found = getPath(record, path);
    if (found != null && String(found).trim()) return found;
  }
  const wanted = new Set(paths.map((path) => String(path).split('.').pop().toLowerCase()));
  for (const field of Array.isArray(record?.customFields) ? record.customFields : []) {
    const key = String(field.key || field.name || field.id || '').toLowerCase();
    if (wanted.has(key)) return field.value;
  }
  return null;
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 100);
}

function deriveDisposition(record, tags, dialStatus) {
  const text = `${value(record, ['disposition', 'leadStatus', 'opportunityStatus', 'pipelineStage', 'status']) || ''} ${tags.join(' ')}`.toLowerCase();
  const rules = [
    ['Closed Won', /closed[-_ ]?won|\bwon\b|customer/],
    ['Scheduled', /appointment|scheduled|booked/],
    ['DNC', /dnc-blocked|do[-_ ]?not[-_ ]?call|\bdnc\b/],
    ['Not Interested', /not[-_ ]?interested/],
    ['Closed DNQ', /closed[-_ ]?dnq|disqualif|\bdnq\b/],
    ['Closed Lost', /closed[-_ ]?lost|\blost\b/],
    ['Working', /contacted|working|follow[-_ ]?up|attempt/],
  ];
  for (const [label, pattern] of rules) if (pattern.test(text)) return label;
  if (String(dialStatus || '').toLowerCase() === 'assigned') return 'Assigned';
  return 'New / Unworked';
}

function deriveDnc(tags) {
  if (tags.some((tag) => ['dnc-blocked', 'dnc', 'do not call', 'do-not-call', 'do_not_call'].includes(tag))) return 'blocked';
  if (tags.some((tag) => ['dnc-clean', 'dnc-wireless'].includes(tag))) return 'clean';
  return 'pending';
}

function normalizeState(value) {
  const state = String(value || '').trim();
  if (!state) return null;
  const upper = state.toUpperCase();
  if (VALID_STATES.has(upper)) return upper;
  return STATE_CODES.get(state.toLowerCase()) || null;
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ');
}

function cleanText(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function cleanAttributionText(value, max) {
  if(value&&typeof value==='object') {
    if(Array.isArray(value)) value=value.find((item)=>item!=null&&String(item).trim()) ?? null;
    else value=value.name ?? value.label ?? value.title ?? value.value ?? value.source ?? value.campaign ?? value.id ?? null;
  }
  const text=cleanText(value,max);
  return text==='[object Object]'?null:text;
}

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error(`${label} is required`), { status: 400 });
  return text;
}

function numeric(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key, typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value ?? '')) ? Number(value) : value,
  ]));
}

function rowsNumeric(rows) { return rows.map(numeric); }

module.exports = {
  EAGLE_METRIC_VERSION,
  EAGLE_METRIC_DEFINITIONS,
  listContexts,
  listAttributionMappings,
  upsertAttributionMapping,
  importOpportunitySnapshots,
  createSnapshot,
  executeSnapshot,
  getSnapshot,
  latestSnapshot,
  getDashboard,
  getDemographics,
  listDemographicContacts,
  listFacts,
  normalizeRecord,
  normalizeState,
  deriveDisposition,
  extractDemographics,
  resolveStoredDemographics,
  buildDemographicAnalytics,
  buildDemographicExecutiveSummary,
  buildGeographicMetrics,
  factFilters,
  buildPeriodMetadata,
  governAttributionRows,
  buildBreakdown,
  buildMetricContracts,
  syncLeadEventsForSnapshot,
  normalizeOpportunityRecord,
  getHistoricalFunnel,
  pruneSnapshots,
};
