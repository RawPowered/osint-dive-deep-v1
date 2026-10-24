const { isConfiguredCrmHost } = require('./crmOrigins');
const crypto = require('crypto');
const { getAuthorizedIntegration, integrationCredential, LEADCONNECTOR_ORIGIN } = require('./crmIntegrations');
const { resolveAccess } = require('./sqlGrants');
const { getDataPool } = require('./sqlConnections');
const { listServicePools, classifyLeadRecord } = require('./servicePools');
const { listPoolRules } = require('./leadPools');
const {
  safeConfig,
  getPath,
  normalizeExternalId,
  normalizeDateTime,
  storeFields,
  storeCurrentContact,
  classifyDncScreening,
  dncDestinationStatus,
  applyDncScreeningStatus,
  applyMarketingChannelStatus,
} = require('./crmImporter');


const DISCONNECTED_TAG_ALIASES = new Set([
  'cc-disconnected',
  'disconnected',
  'non-working-number',
  'non_working_number',
  'phone-disconnected',
  'phone_disconnected',
  'disconnected-number',
  'disconnected_number',
]);

async function selectAuthorizedContactIntegration(corePool, input = {}) {
  const apiKeyId = required(input.apiKeyId, 'apiKeyId');
  const locationId = required(input.locationId, 'locationId');
  if (input.integration) {
    assertIntegrationScope(input.integration, locationId);
    return input.integration;
  }
  if (input.integrationId) {
    let integration;
    try {
      integration = await getAuthorizedIntegration(String(input.integrationId), apiKeyId, 'allow_manage_leads', corePool);
    } catch (error) {
      integration = await getAuthorizedIntegration(String(input.integrationId), apiKeyId, 'allow_import', corePool);
    }
    assertIntegrationScope(integration, locationId);
    return integration;
  }
  const [rows] = await corePool.query(
    `SELECT i.* FROM crm_integrations i
     INNER JOIN crm_integration_grants g ON g.integration_id=i.id
     WHERE g.api_key_id=? AND i.location_id=? AND i.is_enabled=1
       AND (g.allow_manage_leads=1 OR g.allow_import=1)
     ORDER BY g.allow_manage_leads DESC,g.allow_import DESC,i.updated_at DESC LIMIT 1`,
    [apiKeyId, locationId]
  );
  if (!rows[0]) throw syncError('No authorized CRM integration is available for this location', 'OWL_CONTACT_SYNC_CONNECTION_REQUIRED', 409);
  return rows[0];
}

async function resolveOperationalPool(input = {}) {
  if (input.operationalPool) return input.operationalPool;
  const apiKeyId = required(input.apiKeyId, 'apiKeyId');
  const source = String(input.dataSourceSlug || input.sourceSlug || 'dial').trim().toLowerCase();
  if (source === 'core') return input.corePool;
  const requiredOps = ['select', 'insert', 'update'];
  let access;
  for (const op of requiredOps) {
    access = await resolveAccess({ apiKeyId, connectionSlug:source, tableName:'leads', op });
  }
  return getDataPool(access.connection);
}

async function fetchLiveContact(integration, contactId, fetchImpl = global.fetch) {
  if (typeof fetchImpl !== 'function') throw syncError('CRM transport is unavailable', 'OWL_CONTACT_SYNC_TRANSPORT_UNAVAILABLE', 503);
  const credential = integrationCredential(integration);
  if (!credential) throw syncError('CRM credential is unavailable', 'OWL_CONTACT_SYNC_CREDENTIAL_UNAVAILABLE', 503);
  const base = String(integration.base_url || LEADCONNECTOR_ORIGIN).replace(/\/$/, '');
  const url = new URL(`/contacts/${encodeURIComponent(contactId)}`, `${base}/`);
  if (url.origin !== new URL(`${base}/`).origin) throw syncError('CRM contact URL escaped the configured origin', 'OWL_CONTACT_SYNC_ORIGIN_INVALID', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(url, {
      method:'GET',
      headers:{
        Accept:'application/json',
        Authorization:`${integration.auth_scheme || 'Bearer'} ${credential}`.trim(),
        Version:'v3',
      },
      redirect:'error',
      signal:controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw syncError(`CRM contact lookup returned HTTP ${response.status}`, 'OWL_CONTACT_SYNC_GHL_HTTP_ERROR', response.status === 404 ? 404 : 502);
    }
    const record = payload?.contact && typeof payload.contact === 'object' ? payload.contact : payload;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw syncError('CRM contact lookup returned an invalid record', 'OWL_CONTACT_SYNC_INVALID_RESPONSE', 502);
    }
    return record;
  } catch (error) {
    if (error.name === 'AbortError') throw syncError('CRM contact lookup timed out', 'OWL_CONTACT_SYNC_TIMEOUT', 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function syncContactIntoOwl(input = {}) {
  const corePool = input.corePool;
  if (!corePool) throw syncError('Core database is required', 'OWL_CONTACT_SYNC_CORE_REQUIRED', 500);
  const apiKeyId = required(input.apiKeyId, 'apiKeyId');
  const locationId = required(input.locationId, 'locationId');
  const contactId = required(input.contactId, 'contactId');
  const dataSourceSlug = String(input.dataSourceSlug || input.sourceSlug || 'dial').trim().toLowerCase() || 'dial';
  const integration = await selectAuthorizedContactIntegration(corePool, { ...input, apiKeyId, locationId });
  const operationalPool = await resolveOperationalPool({ ...input, corePool, apiKeyId, dataSourceSlug });
  const record = input.record || await fetchLiveContact(integration, contactId, input.fetchImpl || global.fetch);
  const config = safeConfig(integration);
  const recordId = normalizeExternalId(getPath(record, config.idPath) || contactId);
  const recordLocation = String(getPath(record, config.locationPath) || record.location?.id || locationId).trim();
  if (recordId && recordId !== contactId) throw syncError('CRM contact ID does not match the requested contact', 'OWL_CONTACT_SYNC_ID_MISMATCH', 409);
  if (recordLocation && recordLocation !== locationId) throw syncError('CRM contact is outside the endpoint location', 'OWL_CONTACT_SYNC_LOCATION_MISMATCH', 403);

  const [serviceRules, lifecycleRules] = await Promise.all([
    listServicePools(corePool, 'core', locationId),
    listPoolRules(corePool, 'core', locationId),
  ]);
  const suppliedService = getPath(record, config.serviceTypePath) || config.defaultServiceType;
  const serviceType = String(classifyLeadRecord(record, serviceRules, suppliedService)).slice(0, 128);
  const payload = JSON.stringify(record);
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const screening = classifyDncScreening(record);
  const disconnectedTag = findDisconnectedTag(record);
  let lifecycleReconciliation = null;

  const [links] = await corePool.query(
    `SELECT lead_id FROM lead_source_links WHERE integration_id=? AND external_record_id=? LIMIT 1`,
    [integration.id, contactId]
  );
  let leadId = String(links[0]?.lead_id || contactId).slice(0, 128);
  let outcome = links[0] ? 'updated' : 'inserted';
  const opConn = await connectionFor(operationalPool);
  try {
    await opConn.beginTransaction?.();
    const [existing] = await opConn.query('SELECT id,locationId FROM leads WHERE id=? LIMIT 1 FOR UPDATE', [leadId]);
    if (existing[0] && String(existing[0].locationId || '') !== locationId) {
      if (links[0]) throw syncError('Linked lead belongs to another location', 'OWL_CONTACT_SYNC_LEAD_SCOPE_MISMATCH', 409);
      leadId = crypto.randomUUID();
      outcome = 'inserted_with_collision';
    } else if (existing[0]) {
      outcome = 'updated';
    }

    if (!existing[0] || outcome === 'inserted_with_collision') {
      await opConn.query(
        `INSERT INTO leads
           (id,locationId,serviceType,status,contactData,dncStatus,dncCheckedAt,dncSource,
            dncDecisionCategory,dncReviewRequired,dateAdded)
         VALUES (?,?,?,?,?,?,?,?,?,0,COALESCE(?,CURRENT_TIMESTAMP))`,
        [leadId, locationId, serviceType, dncDestinationStatus(screening, lifecycleRules), payload,
          screening.state, screening.state === 'pending' ? null : new Date(),
          screening.state === 'pending' ? null : 'crm_tags',
          screening.state === 'pending' ? null : 'crm_tag',
          normalizeDateTime(getPath(record, config.dateAddedPath))]
      );
    } else {
      await opConn.query(
        `UPDATE leads SET contactData=?,serviceType=? WHERE id=? AND locationId=?`,
        [payload, serviceType, leadId, locationId]
      );
      await applyDncScreeningStatus(opConn, leadId, locationId, screening, lifecycleRules);
    }
    await applyMarketingChannelStatus(opConn, leadId, locationId, record, lifecycleRules);
    lifecycleReconciliation = await reconcileDisconnectedLifecycle(
      opConn, leadId, locationId, disconnectedTag, lifecycleRules
    );
    await opConn.commit?.();
  } catch (error) {
    await opConn.rollback?.();
    throw error;
  } finally {
    opConn.release?.();
  }

  const coreConn = await connectionFor(corePool);
  try {
    await coreConn.beginTransaction?.();
    await coreConn.query(
      `INSERT INTO lead_source_links
         (id,lead_id,integration_id,location_id,external_record_id,external_updated_at)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE lead_id=VALUES(lead_id),location_id=VALUES(location_id),
         external_updated_at=VALUES(external_updated_at),last_seen_at=CURRENT_TIMESTAMP`,
      [crypto.randomUUID(), leadId, integration.id, locationId, contactId,
        normalizeDateTime(getPath(record, config.externalUpdatedPath))]
    );
    await storeCurrentContact(coreConn, integration, null, contactId, leadId, record, payload, payloadHash);
    await storeFields(coreConn, integration.id, leadId, record, null);
    await coreConn.commit?.();
  } catch (error) {
    await coreConn.rollback?.();
    throw error;
  } finally {
    coreConn.release?.();
  }

  return {
    ready:true,
    contactId,
    leadId,
    outcome,
    serviceType,
    dncStatus:screening.state,
    integrationId:integration.id,
    dataSourceSlug,
    lifecycleReconciliation,
  };
}

function normalizedContactTags(record) {
  const nested = record?.contact && typeof record.contact === 'object' ? record.contact : {};
  const raw = record?.tags ?? record?.contactTags ?? nested.tags ?? nested.contactTags ?? [];
  const tags = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return tags.map((tag) => String(tag || '').trim().toLowerCase()).filter(Boolean);
}

function findDisconnectedTag(record) {
  for (const tag of normalizedContactTags(record)) {
    const normalized = tag.replace(/[\s_]+/g, '-');
    if (DISCONNECTED_TAG_ALIASES.has(tag) || DISCONNECTED_TAG_ALIASES.has(normalized)) return tag;
    if (normalized === 'cc-disconnected') return tag;
  }
  return null;
}

async function reconcileDisconnectedLifecycle(pool, leadId, locationId, matchedTag, lifecycleRules) {
  if (!matchedTag) return null;
  const rule = lifecycleRules.find((item) => item.poolKey === 'disconnected' && item.isEnabled);
  if (!rule) {
    return { matchedTag, applied:false, reason:'disconnected_pool_not_configured' };
  }
  if (rule.assignmentPolicy === 'clear') {
    await pool.query(
      'UPDATE leads SET status=?,assignedTo=NULL WHERE id=? AND locationId=?',
      [rule.destinationStatus, leadId, locationId]
    );
  } else {
    await pool.query(
      'UPDATE leads SET status=? WHERE id=? AND locationId=?',
      [rule.destinationStatus, leadId, locationId]
    );
  }
  return {
    matchedTag,
    applied:true,
    poolKey:rule.poolKey,
    destinationStatus:rule.destinationStatus,
    assignmentPolicy:rule.assignmentPolicy,
  };
}

async function hydrateContactOnMiss(input = {}) {
  return syncContactIntoOwl(input);
}

function assertIntegrationScope(integration, locationId) {
  if (!integration || !integration.is_enabled) throw syncError('CRM integration is unavailable', 'OWL_CONTACT_SYNC_CONNECTION_REQUIRED', 409);
  if (String(integration.location_id) !== String(locationId)) throw syncError('CRM integration is outside the selected location', 'OWL_CONTACT_SYNC_CONNECTION_SCOPE_MISMATCH', 403);
  if (!isSupportedContactIntegration(integration)) {
    throw syncError('OWL contact intake requires a LeadConnector or approved CRM CRM integration', 'OWL_CONTACT_SYNC_PROVIDER_UNSUPPORTED', 409);
  }
}

function isSupportedContactIntegration(integration) {
  try {
    const url = new URL(String(integration.base_url || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'services.leadconnectorhq.com' || isConfiguredCrmHost(host));
  } catch {
    return false;
  }
}

async function connectionFor(pool) {
  if (typeof pool.getConnection === 'function') return pool.getConnection();
  return pool;
}

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw syncError(`${name} is required`, `OWL_CONTACT_SYNC_${name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_REQUIRED`, 400);
  return normalized;
}

function syncError(message, code, status = 500) {
  return Object.assign(new Error(message), { code, status });
}

module.exports = {
  selectAuthorizedContactIntegration,
  resolveOperationalPool,
  fetchLiveContact,
  syncContactIntoOwl,
  hydrateContactOnMiss,
  normalizedContactTags,
  findDisconnectedTag,
  reconcileDisconnectedLifecycle,
};
