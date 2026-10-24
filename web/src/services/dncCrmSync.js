const crypto = require('crypto');
const {
  integrationCredential,
  LEADCONNECTOR_PROVIDER,
  LEADCONNECTOR_ORIGIN,
} = require('./crmIntegrations');

const MANAGED_TAGS = Object.freeze(['dnc-clean', 'dnc-blocked', 'dnc-review', 'dnc-pending']);
const FIELD_VALUE_BY_NAME = Object.freeze({
  dncscrubresult: (result) => result.resultCode || '',
  dncscrubstatus: (result) => result.resultLabel || String(result.dncStatus || '').toUpperCase(),
  dnclastscrubbed: (_result, syncedAt) => syncedAt,
  dncscrubreason: (result) => result.reason || result.resultLabel || '',
  dnclinetype: (result) => result.lineType || '',
});

async function syncDncResultsToCrm(pool, input = {}) {
  const apiKeyId = String(input.apiKeyId || '').trim();
  const locationId = String(input.locationId || '').trim();
  const results = Array.isArray(input.results) ? input.results : [];
  const candidates = results.filter((item) =>
    !item.error && ['clean', 'blocked', 'review'].includes(String(item.dncStatus)) &&
      ['dncscrub_api', 'owl_review_override'].includes(item.source)
  );
  if (!apiKeyId || !locationId || !candidates.length) return summarize(results);

  let sources;
  try {
    const placeholders = candidates.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT sl.lead_id,sl.external_record_id,i.*
       FROM lead_source_links sl
       INNER JOIN crm_integrations i ON i.id=sl.integration_id
       INNER JOIN crm_integration_grants g ON g.integration_id=i.id
       WHERE sl.location_id=? AND i.location_id=? AND g.api_key_id=?
         AND g.allow_manage_leads=1 AND i.is_enabled=1
         AND sl.lead_id IN (${placeholders})
       ORDER BY sl.lead_id,
         CASE WHEN i.provider=? THEN 0 ELSE 1 END,
         sl.last_seen_at DESC`,
      [locationId, locationId, apiKeyId, ...candidates.map((item) => item.leadId), LEADCONNECTOR_PROVIDER]
    );
    sources = rows;
  } catch (error) {
    for (const result of candidates) result.crmSync = failedSync(error);
    return summarize(results);
  }

  const selected = new Map();
  for (const source of sources) {
    if (!isLeadConnector(source)) continue;
    if (!selected.has(String(source.lead_id))) selected.set(String(source.lead_id), source);
  }
  const fieldsByIntegration = new Map();
  for (const integrationId of [...new Set([...selected.values()].map((item) => item.id))]) {
    try {
      const [fields] = await pool.query(
        `SELECT field_id,field_key,field_name FROM crm_object_field_definitions
         WHERE integration_id=? AND location_id=? AND object_model='contact' AND is_current=1`,
        [integrationId, locationId]
      );
      fieldsByIntegration.set(String(integrationId), fields);
    } catch {
      fieldsByIntegration.set(String(integrationId), []);
    }
  }

  for (const result of candidates) {
    const source = selected.get(String(result.leadId));
    if (!source) {
      result.crmSync = { status:'skipped', reason:'no_manageable_ghl_contact' };
      continue;
    }
    try {
      const syncedAt = (input.now instanceof Date ? input.now : new Date(input.now || Date.now())).toISOString();
      const customFields = buildCustomFields(fieldsByIntegration.get(String(source.id)) || [], result, syncedAt);
      const phoneAudit = result.phoneAudit;
      if (phoneAudit?.promoted && phoneAudit.selectedFieldId) {
        customFields.unshift({
          id:phoneAudit.selectedFieldId,
          field_value:String(phoneAudit.previousPrimaryRaw || '').slice(0, 64),
        });
      }
      const desiredTag = `dnc-${result.dncStatus}`;
      const removedTags = MANAGED_TAGS.filter((tag) => tag !== desiredTag);
      const contactUpdate = {};
      if (phoneAudit?.promoted && phoneAudit.selectedRaw) {
        contactUpdate.phone = String(phoneAudit.selectedRaw).slice(0, 64);
      }
      if (customFields.length) contactUpdate.customFields = customFields;
      if (Object.keys(contactUpdate).length) {
        await ghlRequest(source, 'PUT', `/contacts/${encodeURIComponent(source.external_record_id)}`, contactUpdate, input);
      }
      await ghlRequest(source, 'POST', `/contacts/${encodeURIComponent(source.external_record_id)}/tags`, { tags:[desiredTag] }, input);
      await ghlRequest(source, 'DELETE', `/contacts/${encodeURIComponent(source.external_record_id)}/tags`, { tags:removedTags }, input);
      const note = buildPhoneScrubNote(phoneAudit, syncedAt);
      if (note) {
        await ghlRequest(source, 'POST', `/contacts/${encodeURIComponent(source.external_record_id)}/notes`, { body:note }, input);
      }
      result.crmSync = {
        status:'synced', integrationId:source.id, contactId:String(source.external_record_id),
        syncedAt, fieldsUpdated:customFields.length, tagAdded:desiredTag, tagsRemoved:removedTags,
        phonePromoted:Boolean(phoneAudit?.promoted), noteAdded:Boolean(note),
      };
      await recordSyncEvent(pool, input, result, source, `crm_sync_${result.dncStatus}`);
    } catch (error) {
      result.crmSync = failedSync(error);
      await recordSyncEvent(pool, input, result, source, 'crm_sync_failed');
    }
  }
  return summarize(results);
}

function buildPhoneScrubNote(phoneAudit, syncedAt) {
  if (!Array.isArray(phoneAudit?.entries) || !phoneAudit.entries.length) return null;
  const labels = { primary:'Primary Phone', alternative:'Alternative Phone', phone3:'Phone 3' };
  const lines = [`OWL all-phone DNC scrub - ${syncedAt}`];
  for (const entry of phoneAudit.entries) {
    const promoted = phoneAudit.promoted && entry.slot === phoneAudit.selectedSlot
      ? ' - promoted to Primary Phone' : '';
    lines.push(`${labels[entry.slot] || entry.slot}: ${formatPhone(entry.phone)} - ${entry.resultCode} (${entry.resultLabel})${promoted}`);
  }
  if (phoneAudit.promoted) {
    lines.push(`Previous Primary Phone moved to ${labels[phoneAudit.selectedSlot] || phoneAudit.selectedSlot}.`);
  }
  return lines.join('\n').slice(0, 4000);
}

function formatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(-10);
  return /^\d{10}$/.test(digits)
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : '[invalid phone]';
}

function buildCustomFields(definitions, result, syncedAt) {
  const values = [];
  const seen = new Set();
  for (const definition of definitions) {
    const names = [definition.field_name, String(definition.field_key || '').split('.').pop()];
    const resolver = names.map(normalizedName).map((name) => FIELD_VALUE_BY_NAME[name]).find(Boolean);
    const id = String(definition.field_id || '').trim();
    if (!resolver || !id || seen.has(id)) continue;
    const value = resolver(result, syncedAt);
    if (value == null || String(value).trim() === '') continue;
    seen.add(id);
    values.push({ id, field_value:String(value).slice(0, 1000) });
  }
  return values;
}

async function ghlRequest(integration, method, path, body, options) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw syncError('GHL transport is unavailable', 'DNC_CRM_TRANSPORT_UNAVAILABLE');
  const credential = integrationCredential(integration);
  if (!credential) throw syncError('GHL credential is unavailable', 'DNC_CRM_CREDENTIAL_UNAVAILABLE');
  const attempts = Math.min(Math.max(Number(options.maxAttempts) || 3, 1), 4);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(`${LEADCONNECTOR_ORIGIN}${path}`, {
        method,
        headers:{ Accept:'application/json', 'Content-Type':'application/json', Authorization:`Bearer ${credential}`, Version:'v3' },
        body:JSON.stringify(body),
        redirect:'error',
        signal:controller.signal,
      });
      if (response.ok) return;
      lastError = syncError(`GoHighLevel returned HTTP ${response.status}`, 'DNC_CRM_HTTP_ERROR', response.status);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error.name === 'AbortError'
        ? syncError('GoHighLevel DNC write-back timed out', 'DNC_CRM_TIMEOUT') : error;
      if (attempt + 1 >= attempts) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < attempts) await (options.sleep || defaultSleep)(Math.min(250 * (2 ** attempt), 1000));
  }
  throw lastError;
}

async function recordSyncEvent(pool, input, result, source, action) {
  try {
    await pool.query(
      `INSERT INTO dnc_pulse_events
         (id,api_key_id,lead_id,external_contact_id,location_id,action)
       VALUES (?,?,?,?,?,?)`,
      [crypto.randomUUID(), input.apiKeyId, result.leadId, source.external_record_id, input.locationId, action]
    );
  } catch {}
}

function summarize(results) {
  return {
    synced:results.filter((item) => item.crmSync?.status === 'synced').length,
    failed:results.filter((item) => item.crmSync?.status === 'failed').length,
    skipped:results.filter((item) => item.crmSync?.status === 'skipped').length,
  };
}

function isLeadConnector(integration) {
  if (integration.provider === LEADCONNECTOR_PROVIDER) return true;
  try { return new URL(integration.base_url).origin === LEADCONNECTOR_ORIGIN; }
  catch { return false; }
}

function normalizedName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function failedSync(error) {
  return { status:'failed', code:error.code || 'DNC_CRM_SYNC_FAILED', error:String(error.message || 'CRM write-back failed').slice(0, 500) };
}

function syncError(message, code, upstreamStatus = null) {
  return Object.assign(new Error(message), { code, upstreamStatus });
}

function defaultSleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { MANAGED_TAGS, buildCustomFields, buildPhoneScrubNote, syncDncResultsToCrm };
