const { isConfiguredCrmHost } = require('./crmOrigins');
const crypto = require('crypto');
const { extractPhone } = require('./dncScrub');
const { getPool } = require('../db/pool');
const { parseJson, integrationCredential } = require('./crmIntegrations');
const { listServicePools, classifyLeadRecord } = require('./servicePools');
const { listPoolRules } = require('./leadPools');

const FORBIDDEN_FIELD = /(^|\.)(authorization|cookie|cookies|password|secret|access_?token|refresh_?token|api_?key)$/i;

function getPath(object, path) {
  if (!path) return object;
  return String(path).split('.').reduce((value, part) => {
    if (value == null) return undefined;
    return value[part];
  }, object);
}

function normalizeFieldKey(value) {
  const key = String(value || '').replace(/^\.+|\.+$/g, '');
  if (key.length <= 191) return key;
  return `${key.slice(0, 150)}.${crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

function flattenRecord(value, prefix = '', output = {}, depth = 0) {
  if (depth > 5 || value == null) return output;
  if (Array.isArray(value)) {
    if (prefix && !FORBIDDEN_FIELD.test(prefix)) output[normalizeFieldKey(prefix)] = value;
    return output;
  }
  if (typeof value !== 'object') {
    if (prefix && !FORBIDDEN_FIELD.test(prefix)) output[normalizeFieldKey(prefix)] = value;
    return output;
  }
  for (const [rawKey, child] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${rawKey}` : rawKey;
    if (FORBIDDEN_FIELD.test(key)) continue;
    if (child && typeof child === 'object' && !Array.isArray(child) && depth < 5) {
      flattenRecord(child, key, output, depth + 1);
    } else {
      output[normalizeFieldKey(key)] = child;
    }
  }
  return output;
}

function classifyValue(value) {
  const serialized = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  const result = {
    dataType: 'string',
    valueText: null,
    valueNumber: null,
    valueDatetime: null,
    valueBoolean: null,
    valueJson: null,
    valueHash: crypto.createHash('sha256').update(serialized).digest('hex'),
  };
  if (typeof value === 'boolean') {
    result.dataType = 'boolean';
    result.valueBoolean = value ? 1 : 0;
  } else if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e22) {
    result.dataType = 'number';
    result.valueNumber = value;
  } else if (value && typeof value === 'object') {
    result.dataType = 'json';
    result.valueJson = serialized;
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      result.dataType = 'datetime';
      result.valueDatetime = date.toISOString().slice(0, 19).replace('T', ' ');
    } else {
      result.valueText = value;
    }
  } else {
    result.valueText = value == null ? null : String(value);
  }
  return result;
}

function normalizeExternalId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!id) return '';
  if (id.length <= 191) return id;
  return `sha256:${crypto.createHash('sha256').update(id).digest('hex')}`;
}

function safeConfig(integration) {
  const config = parseJson(integration.config_json);
  const isLeadConnectorPit = integration.provider === 'leadconnector-pit';
  const isDirectLeadConnector = isLeadConnectorHost(integration.base_url);
  const usesCompoundContactCursor = isLeadConnectorPit || integration.provider === 'nova-edge' ||
    isKnownLeadSourceHost(integration.base_url);
  return {
    contactsPath: String(config.contactsPath || '/contacts/'),
    recordsPath: String(config.recordsPath || 'contacts'),
    idPath: String(config.idPath || 'id'),
    locationPath: String(config.locationPath || 'locationId'),
    serviceTypePath: String(config.serviceTypePath || 'serviceType'),
    externalUpdatedPath: String(config.externalUpdatedPath || 'dateUpdated'),
    dateAddedPath: String(config.dateAddedPath || 'dateAdded'),
    locationParam: config.locationParam === false ? null : String(config.locationParam || 'locationId'),
    limitParam: String(config.limitParam || 'limit'),
    cursorParam: String(config.cursorParam || 'startAfterId'),
    nextCursorPath: String(config.nextCursorPath || 'meta.startAfterId'),
    cursorTimeParam: config.cursorTimeParam === false ? null : String(config.cursorTimeParam || (usesCompoundContactCursor ? 'startAfter' : '')),
    nextCursorTimePath: String(config.nextCursorTimePath || 'meta.startAfter'),
    pageParam: config.pageParam ? String(config.pageParam) : null,
    updatedAfterParam: config.updatedAfterParam ? String(config.updatedAfterParam) : null,
    version: config.version ? String(config.version) : usesCompoundContactCursor ? '2021-07-28' : null,
    maxPageSize: Math.min(Math.max(Number(config.maxPageSize) || 100, 1), usesCompoundContactCursor ? 100 : 500),
    pageDelayMs: Math.min(Math.max(Number(config.pageDelayMs) || (usesCompoundContactCursor ? 250 : 0), 0), 5000),
    usesCompoundContactCursor,
    useContactSearch: config.useContactSearch === true || (config.useContactSearch !== false && isDirectLeadConnector),
    contactSearchPath: String(config.contactSearchPath || '/contacts/search'),
    searchAfterPath: String(config.searchAfterPath || 'searchAfter'),
    searchUpdatedField: String(config.searchUpdatedField || 'dateUpdated'),
    incrementalOverlapSeconds: Math.min(Math.max(Number(config.incrementalOverlapSeconds) || 300, 0), 86400),
    customFieldsPath: config.customFieldsPath === false ? null : String(config.customFieldsPath || ((isLeadConnectorPit || isDirectLeadConnector) ? `/locations/${integration.location_id}/customFields` : '')),
    customFieldsRecordsPath: String(config.customFieldsRecordsPath || 'customFields'),
    defaultServiceType: String(config.defaultServiceType || 'Other').slice(0, 128),
  };
}

function makePageUrl(integration, config, cursor, limit, updatedAfter = null) {
  const path = config.contactsPath.startsWith('/') ? config.contactsPath : `/${config.contactsPath}`;
  const url = new URL(path, `${integration.base_url}/`);
  if (url.origin !== new URL(integration.base_url).origin) {
    throw Object.assign(new Error('CRM contactsPath must stay on the configured origin'), { status: 400 });
  }
  if (config.locationParam) url.searchParams.set(config.locationParam, integration.location_id);
  url.searchParams.set(config.limitParam, String(limit));
  if (config.updatedAfterParam && updatedAfter) {
    url.searchParams.set(config.updatedAfterParam, String(updatedAfter));
  }
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (config.pageParam) url.searchParams.set(config.pageParam, String(decoded.page || decoded.id || cursor));
    else {
      if (decoded.id) url.searchParams.set(config.cursorParam, String(decoded.id));
      if (config.cursorTimeParam && decoded.time != null) url.searchParams.set(config.cursorTimeParam, String(decoded.time));
    }
  }
  return url;
}

async function fetchCrmPage(integration, {
  cursor = null, limit = 100, updatedAfter = null, updatedBefore = null,
} = {}) {
  const config = safeConfig(integration);
  const requestLimit = Math.min(Math.max(Number(limit) || 100, 1), config.maxPageSize);
  const url = config.useContactSearch
    ? makeSameOriginUrl(integration, config.contactSearchPath, 'contactSearchPath')
    : makePageUrl(integration, config, cursor, requestLimit, updatedAfter);
  const headers = { Accept: 'application/json' };
  const decodedCursor = decodeCursor(cursor);
  const searchAfter = config.useContactSearch && Array.isArray(decodedCursor.searchAfter)
    ? decodedCursor.searchAfter
    : null;
  const searchPage = config.useContactSearch && !searchAfter
    ? Math.max(Number(decodedCursor.page) || 1, 1)
    : null;
  let requestBody = null;
  if (config.useContactSearch) {
    const body = { locationId: integration.location_id, pageLimit: requestLimit };
    if (searchAfter) body.searchAfter = searchAfter;
    else body.page = searchPage;
    if (updatedAfter) {
      body.filters = [{
        field: config.searchUpdatedField,
        operator: 'range',
        value: {
          gte: new Date(updatedAfter).toISOString(),
          ...(updatedBefore ? { lte: new Date(updatedBefore).toISOString() } : {}),
        },
      }];
      body.sort = [{ field: config.searchUpdatedField, direction: 'asc' }];
    }
    requestBody = JSON.stringify(body);
  }
  if (requestBody) headers['Content-Type'] = 'application/json';
  const credential = integrationCredential(integration);
  if (credential) headers.Authorization = `${integration.auth_scheme || 'Bearer'} ${credential}`.trim();
  if (config.version) headers.Version = config.version;

  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      method: config.useContactSearch ? 'POST' : 'GET', headers, body: requestBody, redirect: 'error',
    });
    if (response.status !== 429 && response.status < 500) break;
    if (attempt === 2) break;
    const retryAfter = Math.min(Number(response.headers.get('retry-after')) || 2 ** attempt, 10);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
  if (!response.ok) {
    let message = `CRM request failed with HTTP ${response.status}`;
    if (integration.provider === 'leadconnector-pit' && response.status === 401) {
      message = 'LeadConnector rejected the Private Integration Token; verify the token and rotate it if needed';
    } else if (integration.provider === 'leadconnector-pit' && response.status === 403) {
      message = 'LeadConnector PIT lacks access; grant contacts.readonly for this sub-account';
    } else if (response.status === 400 || response.status === 422) {
      const detail = await safeUpstreamErrorDetail(response);
      if (detail) message = `${message}: ${detail}`;
    }
    const err = new Error(message);
    err.status = response.status === 401 || response.status === 403 ? 502 : response.status;
    throw err;
  }
  const body = await response.json();
  let records = getPath(body, config.recordsPath);
  if (!Array.isArray(records) && Array.isArray(body)) records = body;
  if (!Array.isArray(records)) {
    throw Object.assign(new Error(`CRM response path "${config.recordsPath}" is not an array`), { status: 502 });
  }
  let nextCursor = getPath(body, config.nextCursorPath);
  const nextCursorTime = getPath(body, config.nextCursorTimePath);
  if (nextCursor == null) {
    nextCursor = getPath(body, 'meta.nextCursor') ?? getPath(body, 'pagination.nextCursor') ?? body.nextCursor;
  }
  const expectedTotal = Number(body.total ?? body.count ?? getPath(body, 'meta.total') ?? getPath(body, 'pagination.total'));
  if (config.useContactSearch) {
    const recordSearchAfter = searchAfterFromLastRecord(records, config);
    const hasMore = searchAfter
      ? records.length === requestLimit
      : Number.isFinite(expectedTotal)
        ? searchPage * requestLimit < expectedTotal
        : records.length === requestLimit;
    if (hasMore && recordSearchAfter) nextCursor = JSON.stringify({ searchAfter: recordSearchAfter });
    else if (hasMore && searchPage != null) nextCursor = JSON.stringify({ page: searchPage + 1 });
    else nextCursor = null;
  } else if (config.usesCompoundContactCursor) {
    // HighLevel documents request cursors, but not response meta cursors. Advance from the
    // last record actually received so echoed/stale meta cannot loop a full sync.
    nextCursor = records.length === requestLimit ? cursorFromLastRecord(records, config) : null;
  } else if (config.pageParam && nextCursor == null && records.length === requestLimit) {
    const currentPage = Number(decodeCursor(cursor).page || cursor) || 1;
    nextCursor = JSON.stringify({ page: currentPage + 1 });
  } else if (!config.pageParam && nextCursor != null && nextCursorTime != null) {
    nextCursor = encodeCursor({ id: nextCursor, time: nextCursorTime });
  } else if (!config.pageParam && nextCursor == null && records.length === requestLimit) {
    const last = records[records.length - 1];
    const lastId = getPath(last, config.idPath);
    const lastDate = getPath(last, config.dateAddedPath) || getPath(last, config.externalUpdatedPath);
    const time = lastDate ? new Date(lastDate).getTime() : null;
    if (lastId) nextCursor = encodeCursor({ id: lastId, time: Number.isFinite(time) ? time : null });
  }
  let checkpointCursor = nextCursor;
  if (config.useContactSearch) {
    const recordSearchAfter = searchAfterFromLastRecord(records, config);
    checkpointCursor = recordSearchAfter
      ? JSON.stringify({ searchAfter: recordSearchAfter })
      : JSON.stringify({ page: searchPage || 1 });
  }
  else if (!config.pageParam && records.length) checkpointCursor = cursorFromLastRecord(records, config) || checkpointCursor;
  return {
    records,
    nextCursor: nextCursor == null ? null : String(nextCursor),
    checkpointCursor: checkpointCursor == null ? null : String(checkpointCursor),
    expectedTotal: Number.isFinite(expectedTotal) ? expectedTotal : null,
    requestLimit,
    body,
  };
}

async function safeUpstreamErrorDetail(response) {
  try {
    const raw = await response.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const candidate = parsed && (parsed.message || parsed.error)
      ? (Array.isArray(parsed.message) ? parsed.message.join('; ') : parsed.message || parsed.error)
      : raw;
    return String(candidate || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(/((?:token|secret|password|api[_ -]?key)\s*[:=]\s*)[^,;\s]+/gi, '$1[redacted]')
      .trim()
      .slice(0, 300);
  } catch {
    return '';
  }
}

function makeSameOriginUrl(integration, pathValue, label) {
  const path = String(pathValue || '').startsWith('/') ? String(pathValue) : `/${pathValue}`;
  const url = new URL(path, `${integration.base_url}/`);
  if (url.origin !== new URL(integration.base_url).origin) {
    throw Object.assign(new Error(`CRM ${label} must stay on the configured origin`), { status: 400 });
  }
  return url;
}

function isLeadConnectorHost(baseUrl) {
  try { return new URL(baseUrl).hostname.toLowerCase() === 'services.leadconnectorhq.com'; }
  catch { return false; }
}

function isKnownLeadSourceHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'services.leadconnectorhq.com' || isConfiguredCrmHost(host);
  } catch {
    return false;
  }
}

function cursorFromLastRecord(records, config) {
  const last = records[records.length - 1];
  if (!last) return null;
  const lastId = getPath(last, config.idPath);
  const lastDate = getPath(last, config.dateAddedPath) || getPath(last, config.externalUpdatedPath);
  const time = lastDate ? new Date(lastDate).getTime() : null;
  return lastId ? encodeCursor({ id: lastId, time: Number.isFinite(time) ? time : null }) : null;
}

function searchAfterFromLastRecord(records, config) {
  const value = getPath(records[records.length - 1], config.searchAfterPath);
  return Array.isArray(value) && value.length ? value : null;
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor === 'object') return cursor || {};
  try {
    const parsed = JSON.parse(String(cursor));
    return parsed && typeof parsed === 'object' ? parsed : { id: String(cursor) };
  } catch {
    return { id: String(cursor) };
  }
}

function encodeCursor(value) {
  return JSON.stringify({ id: String(value.id), time: value.time });
}

function parseSyncDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function walkCrmContacts(integration, options = {}) {
  const config = safeConfig(integration);
  const pageSize = Math.min(Math.max(Number(options.pageSize) || 100, 1), config.maxPageSize);
  const requestedDelay = options.pageDelayMs == null ? config.pageDelayMs : Number(options.pageDelayMs);
  const pageDelayMs = Math.min(Math.max(Number.isFinite(requestedDelay) ? requestedDelay : config.pageDelayMs, 0), 5000);
  const pageBudget = Math.min(Math.max(Number(options.pageBudget) || 100000, 1), 100000);
  let cursor = options.cursor || null;
  let pages = 0;
  let records = 0;
  let expectedTotal = null;
  let lastCursor = cursor;
  let completionReason = 'upstream_end';
  const seen = new Set();
  const seenRecordIds = new Set();
  while (pages < pageBudget) {
    const cursorKey = cursor == null ? '__start__' : String(cursor);
    if (seen.has(cursorKey)) throw Object.assign(new Error('CRM pagination cursor repeated before completion'), { status: 502 });
    seen.add(cursorKey);
    let page;
    let pageRecordIds;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      page = await fetchCrmPage(integration, {
        cursor,
        limit: pageSize,
        updatedAfter: options.updatedAfter || null,
        updatedBefore: options.updatedBefore || null,
      });
      pageRecordIds = page.records.map((record) => normalizeExternalId(getPath(record, config.idPath)));
      const hasProgress = page.records.length === 0 || pageRecordIds.some((id) => !id || !seenRecordIds.has(id));
      if (hasProgress) break;
      if (attempt === 2) {
        throw Object.assign(new Error('CRM pagination returned the same contact batch without forward progress'), {
          status: 502, cursor, pages, records, expectedTotal,
        });
      }
      await sleep(Math.max(pageDelayMs, 500) * (attempt + 1));
    }
    const uniqueRecords = page.records.filter((record, index) => {
      const id = pageRecordIds[index];
      if (!id || !seenRecordIds.has(id)) return true;
      return false;
    });
    for (const id of pageRecordIds) if (id) seenRecordIds.add(id);
    const processedPage = uniqueRecords.length === page.records.length ? page : { ...page, records: uniqueRecords };
    pages += 1;
    records += uniqueRecords.length;
    if (page.expectedTotal != null) expectedTotal = page.expectedTotal;
    if (options.onPage) await options.onPage(processedPage, { pages, records, cursor, expectedTotal });
    if (page.checkpointCursor) lastCursor = page.checkpointCursor;
    if (page.records.length === 0) { completionReason = 'empty_page'; cursor = null; break; }
    if (!page.nextCursor) {
      if (expectedTotal != null && records < expectedTotal) {
        throw Object.assign(new Error(
          `CRM pagination ended after ${records} of ${expectedTotal} advertised contacts`
        ), { status: 502, cursor: lastCursor, pages, records, expectedTotal });
      }
      completionReason = page.records.length < page.requestLimit ? 'short_page' : 'upstream_end';
      cursor = null;
      break;
    }
    cursor = page.nextCursor;
    if (pageDelayMs) await sleep(pageDelayMs);
  }
  if (cursor && pages >= pageBudget) {
    throw Object.assign(new Error(`CRM full sync exceeded the ${pageBudget}-page safety ceiling`), {
      status: 502, cursor, pages, records, expectedTotal,
    });
  }
  return { pages, records, expectedTotal, cursor, lastCursor, completionReason };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testIntegration(integration) {
  const page = await fetchCrmPage(integration, { limit: 1 });
  return { ok: true, recordsReceived: page.records.length, hasNextCursor: Boolean(page.nextCursor) };
}

async function syncCustomFieldDefinitions(integration, pool = null) {
  const config = safeConfig(integration);
  if (!config.customFieldsPath) return { supported: false, total: 0 };
  const usesLeadConnectorFields = integration.provider === 'leadconnector-pit' || isLeadConnectorHost(integration.base_url);
  const p = pool || getPool();
  const path = config.customFieldsPath.startsWith('/') ? config.customFieldsPath : `/${config.customFieldsPath}`;
  const url = new URL(path, `${integration.base_url}/`);
  if (url.origin !== new URL(integration.base_url).origin) {
    throw Object.assign(new Error('CRM customFieldsPath must stay on the configured origin'), { status: 400 });
  }
  if (usesLeadConnectorFields) url.searchParams.set('model', 'all');
  const headers = { Accept: 'application/json' };
  const credential = integrationCredential(integration);
  if (credential) headers.Authorization = `${integration.auth_scheme || 'Bearer'} ${credential}`.trim();
  headers.Version = usesLeadConnectorFields ? 'v3' : (config.version || '2021-07-28');
  const response = await fetch(url, { headers, redirect: 'error' });
  if (!response.ok) {
    const message = usesLeadConnectorFields && response.status === 403
      ? 'CRM token lacks locations/customFields.readonly; grant that scope to resolve custom-field names'
      : `CRM custom field discovery failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), {
      status: response.status === 401 || response.status === 403 ? 502 : response.status,
    });
  }
  const body = await response.json();
  const definitions = getPath(body, config.customFieldsRecordsPath);
  if (!Array.isArray(definitions)) {
    throw Object.assign(new Error(`CRM custom field response path "${config.customFieldsRecordsPath}" is not an array`), { status: 502 });
  }
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE crm_object_field_definitions SET is_current = 0 WHERE integration_id = ?', [integration.id]);
    for (const definition of definitions) {
      const fieldId = normalizeExternalId(definition.id || definition.fieldId || definition.fieldKey);
      if (!fieldId) continue;
      await conn.query(
        `INSERT INTO crm_object_field_definitions
           (integration_id, field_id, location_id, object_model, field_key, field_name,
            data_type, metadata_json, is_current)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE object_model = VALUES(object_model), field_key = VALUES(field_key),
           field_name = VALUES(field_name), data_type = VALUES(data_type),
           metadata_json = VALUES(metadata_json), last_seen_at = CURRENT_TIMESTAMP, is_current = 1`,
        [integration.id, fieldId, integration.location_id,
          String(definition.model || 'contact').slice(0, 64),
          String(definition.fieldKey || '').slice(0, 191) || null,
          String(definition.name || definition.fieldKey || '').slice(0, 255) || null,
          String(definition.dataType || '').slice(0, 64) || null,
          JSON.stringify(definition)]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return { supported: true, total: definitions.length };
}

async function syncObjectDefinitions(integration, pool = null) {
  const usesLeadConnector = integration.provider === 'leadconnector-pit' || isLeadConnectorHost(integration.base_url);
  if (!usesLeadConnector) return { supported: false, total: 0, fields: 0 };
  const p = pool || getPool();
  const base = String(integration.base_url).replace(/\/$/, '');
  const headers = {
    Accept: 'application/json',
    Authorization: `${integration.auth_scheme || 'Bearer'} ${integrationCredential(integration)}`.trim(),
    Version: 'v3',
  };
  const listUrl = new URL('/objects/', `${base}/`);
  listUrl.searchParams.set('locationId', integration.location_id);
  const response = await fetch(listUrl, { headers, redirect: 'error' });
  if (!response.ok) {
    const message = response.status === 403
      ? 'CRM token lacks objects/schema.readonly; grant that scope to ingest custom object schemas'
      : `CRM object discovery failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status === 401 || response.status === 403 ? 502 : response.status });
  }
  const body = await response.json();
  const objects = Array.isArray(body?.objects) ? body.objects.slice(0, 100) : [];
  const schemas = [];
  for (const object of objects) {
    const key = String(object?.key || object?.id || '').trim();
    if (!key) continue;
    const schemaUrl = new URL(`/objects/${encodeURIComponent(key)}`, `${base}/`);
    schemaUrl.searchParams.set('locationId', integration.location_id);
    const schemaResponse = await fetch(schemaUrl, { headers, redirect: 'error' });
    if (!schemaResponse.ok) {
      throw Object.assign(new Error(`CRM object schema discovery failed for ${key} with HTTP ${schemaResponse.status}`), {
        status: schemaResponse.status === 401 || schemaResponse.status === 403 ? 502 : schemaResponse.status,
      });
    }
    schemas.push({ object, schema: await schemaResponse.json() });
  }
  const conn = await p.getConnection();
  let fieldCount = 0;
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE crm_object_definitions SET is_current=0 WHERE integration_id=?', [integration.id]);
    for (const { object, schema } of schemas) {
      const objectId = normalizeExternalId(object.id || object.key);
      const objectKey = String(object.key || object.id || '').slice(0, 191);
      if (!objectId || !objectKey) continue;
      await conn.query(
        `INSERT INTO crm_object_definitions
           (integration_id,object_id,location_id,object_key,singular_label,plural_label,is_standard,
            primary_display_property,metadata_json,is_current)
         VALUES (?,?,?,?,?,?,?,?,?,1)
         ON DUPLICATE KEY UPDATE object_key=VALUES(object_key),singular_label=VALUES(singular_label),
           plural_label=VALUES(plural_label),is_standard=VALUES(is_standard),
           primary_display_property=VALUES(primary_display_property),metadata_json=VALUES(metadata_json),
           last_seen_at=CURRENT_TIMESTAMP,is_current=1`,
        [integration.id, objectId, integration.location_id, objectKey,
          String(object.labels?.singular || object.name || objectKey).slice(0, 255),
          String(object.labels?.plural || object.name || objectKey).slice(0, 255),
          object.standard ? 1 : 0, String(object.primaryDisplayProperty || '').slice(0, 191) || null,
          JSON.stringify(object)]
      );
      for (const definition of objectSchemaFields(schema)) {
        const fieldId = normalizeExternalId(definition.id || definition.fieldId || definition.key || definition.fieldKey);
        if (!fieldId) continue;
        fieldCount += 1;
        await conn.query(
          `INSERT INTO crm_object_field_definitions
             (integration_id,field_id,location_id,object_model,field_key,field_name,data_type,metadata_json,is_current)
           VALUES (?,?,?,?,?,?,?,?,1)
           ON DUPLICATE KEY UPDATE object_model=VALUES(object_model),field_key=VALUES(field_key),
             field_name=VALUES(field_name),data_type=VALUES(data_type),metadata_json=VALUES(metadata_json),
             last_seen_at=CURRENT_TIMESTAMP,is_current=1`,
          [integration.id, fieldId, integration.location_id, objectKey.slice(0, 64),
            String(definition.fieldKey || definition.key || definition.name || '').slice(0, 191) || null,
            String(definition.name || definition.label || definition.fieldKey || definition.key || '').slice(0, 255) || null,
            String(definition.dataType || definition.type || '').slice(0, 64) || null,
            JSON.stringify(definition)]
        );
      }
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return { supported: true, total: schemas.length, fields: fieldCount };
}

function objectSchemaFields(payload) {
  const schema = payload?.object || payload?.schema || payload;
  const candidates = [schema?.fields, schema?.properties, schema?.schema?.fields, schema?.schema?.properties];
  for (const value of candidates) {
    if (Array.isArray(value)) return value.slice(0, 2000);
    if (value && typeof value === 'object') {
      return Object.entries(value).slice(0, 2000).map(([key, field]) => ({ key, ...(field && typeof field === 'object' ? field : {}) }));
    }
  }
  return [];
}

async function createImportRun(integration, apiKeyId, options = {}, pool = null) {
  const p = pool || getPool();
  const [active] = await p.query(
    `SELECT id FROM crm_import_runs WHERE integration_id = ? AND status IN ('queued', 'running') LIMIT 1`,
    [integration.id]
  );
  if (active[0]) throw Object.assign(new Error('An import is already active for this integration'), { status: 409 });
  const id = crypto.randomUUID();
  const config = safeConfig(integration);
  const checkpointAt = new Date();
  const previousSyncAt = parseSyncDate(integration.last_sync_at);
  const hasPreviousSync = Boolean(previousSyncAt);
  const supportsIncremental = config.useContactSearch || Boolean(config.updatedAfterParam);
  const isIncremental = !options.full && supportsIncremental && hasPreviousSync;
  const updatedAfter = isIncremental
    ? new Date(previousSyncAt.getTime() - config.incrementalOverlapSeconds * 1000).toISOString()
    : null;
  const updatedBefore = isIncremental ? checkpointAt.toISOString() : null;
  const startCursor = null;
  const storedOptions = {
    ...options,
    syncMode: options.full ? 'full' : isIncremental ? 'incremental' : 'bootstrap',
    checkpointAt: checkpointAt.toISOString(),
    updatedAfter,
    updatedBefore,
  };
  await p.query(
    `INSERT INTO crm_import_runs
       (id, integration_id, location_id, requested_by_key_id, dry_run, start_cursor,
        current_cursor, options_json, is_full_sync)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, integration.id, integration.location_id, apiKeyId || null, options.dryRun ? 1 : 0,
      startCursor, startCursor, JSON.stringify(storedOptions), options.full ? 1 : 0]
  );
  return id;
}

async function getImportRun(runId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM crm_import_runs WHERE id = ? LIMIT 1', [runId]);
  const row = rows[0];
  if (!row) return null;
  const options = parseJson(row.options_json);
  return {
    id: row.id,
    integrationId: row.integration_id,
    locationId: row.location_id,
    status: row.status,
    dryRun: Boolean(row.dry_run),
    isFullSync: Boolean(row.is_full_sync),
    syncMode: options.syncMode || (row.is_full_sync ? 'full' : 'bootstrap'),
    windowStartedAt: options.updatedAfter || null,
    windowEndedAt: options.updatedBefore || null,
    currentCursor: row.current_cursor || null,
    expectedRecords: row.expected_records == null ? null : Number(row.expected_records),
    recordsFetched: Number(row.records_fetched),
    recordsInserted: Number(row.records_inserted),
    recordsLinked: Number(row.records_linked),
    recordsSkipped: Number(row.records_skipped),
    recordsConflicted: Number(row.records_conflicted),
    recordsFailed: Number(row.records_failed),
    pagesProcessed: Number(row.pages_processed),
    errorSummary: row.error_summary || null,
    completionReason: row.completion_reason || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
  };
}

async function recordConflict(conn, run, externalId, type, candidateLeadId, detail) {
  await conn.query(
    `INSERT INTO lead_import_conflicts
       (id, run_id, integration_id, location_id, external_record_id,
        candidate_lead_id, conflict_type, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), run.id, run.integration_id, run.location_id, externalId,
      candidateLeadId || null, type, JSON.stringify(detail || {})]
  );
}

async function storeFields(conn, integrationId, leadId, record, runId = null) {
  const fields = flattenRecord(record);
  await conn.query(
    'UPDATE lead_import_values SET is_current = 0 WHERE lead_id = ? AND integration_id = ?',
    [leadId, integrationId]
  );
  for (const [fieldKey, value] of Object.entries(fields)) {
    const typed = classifyValue(value);
    await conn.query(
      `INSERT INTO crm_field_definitions
         (id, integration_id, field_key, field_label, data_type)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP`,
      [crypto.randomUUID(), integrationId, fieldKey, fieldKey.slice(0, 255), typed.dataType]
    );
    await conn.query(
      `INSERT INTO lead_import_values
         (lead_id, integration_id, field_key, data_type, value_text, value_number,
          value_datetime, value_boolean, value_json, value_hash, last_seen_run_id, is_current)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE data_type = VALUES(data_type), value_text = VALUES(value_text),
         value_number = VALUES(value_number), value_datetime = VALUES(value_datetime),
         value_boolean = VALUES(value_boolean), value_json = VALUES(value_json),
         value_hash = VALUES(value_hash), last_seen_at = CURRENT_TIMESTAMP,
         last_seen_run_id = VALUES(last_seen_run_id), is_current = 1`,
      [leadId, integrationId, fieldKey, typed.dataType, typed.valueText, typed.valueNumber,
        typed.valueDatetime, typed.valueBoolean, typed.valueJson, typed.valueHash, runId]
    );
  }
}

async function storeCurrentContact(conn, integration, runId, externalId, leadId, record, payload, payloadHash) {
  const config = safeConfig(integration);
  await conn.query(
    `INSERT INTO crm_contact_records
       (integration_id, external_record_id, location_id, lead_id, payload_hash, payload_json,
        external_updated_at, last_seen_run_id, is_current)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE lead_id = VALUES(lead_id), payload_hash = VALUES(payload_hash),
       payload_json = VALUES(payload_json), external_updated_at = VALUES(external_updated_at),
       last_seen_at = CURRENT_TIMESTAMP, last_seen_run_id = VALUES(last_seen_run_id), is_current = 1`,
    [integration.id, externalId, integration.location_id, leadId, payloadHash, payload,
      normalizeDateTime(getPath(record, config.externalUpdatedPath)), runId]
  );
}

async function processRecord(pool, integration, run, record, options = {}) {
  const config = safeConfig(integration);
  const externalId = normalizeExternalId(options.forcedExternalId || getPath(record, config.idPath));
  if (!externalId) return { outcome: 'failed', error: `Missing external ID at ${config.idPath}` };
  const payloadLocation = getPath(record, config.locationPath);
  const payload = JSON.stringify(record);
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [stageResult] = await conn.query(
      `INSERT IGNORE INTO crm_import_staging
         (run_id, integration_id, location_id, external_record_id, payload_hash, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [run.id, integration.id, integration.location_id, externalId, payloadHash, payload]
    );
    if (!stageResult.affectedRows) {
      await conn.commit();
      return { outcome: 'skipped', externalId };
    }
    if (payloadLocation && String(payloadLocation) !== String(integration.location_id)) {
      await recordConflict(conn, run, externalId, 'location_mismatch', null, {
        configuredLocationId: integration.location_id,
        payloadLocationId: String(payloadLocation),
      });
      await conn.query(
        `UPDATE crm_import_staging SET processing_status = 'conflict', processed_at = CURRENT_TIMESTAMP
         WHERE run_id = ? AND external_record_id = ?`,
        [run.id, externalId]
      );
      await conn.commit();
      return { outcome: 'conflicted', externalId };
    }

    const [links] = await conn.query(
      `SELECT lead_id FROM lead_source_links WHERE integration_id = ? AND external_record_id = ? LIMIT 1`,
      [integration.id, externalId]
    );
    if (links[0]) {
      if (options.forcedLeadId && String(options.forcedLeadId) !== String(links[0].lead_id)) {
        await recordConflict(conn, run, externalId, 'source_link_mismatch', options.forcedLeadId, {
          linkedLeadId: links[0].lead_id,
        });
        await conn.query(
          `UPDATE crm_import_staging SET processing_status = 'conflict', lead_id = ?, processed_at = CURRENT_TIMESTAMP
           WHERE run_id = ? AND external_record_id = ?`,
          [links[0].lead_id, run.id, externalId]
        );
        await conn.commit();
        return { outcome: 'conflicted', leadId: links[0].lead_id, externalId };
      }
      await conn.query(
        `UPDATE lead_source_links SET last_seen_at = CURRENT_TIMESTAMP
         WHERE integration_id = ? AND external_record_id = ?`,
        [integration.id, externalId]
      );
      await applyDncScreeningStatus(
        conn, links[0].lead_id, integration.location_id,
        classifyDncScreening(record), options.lifecyclePoolRules || []
      );
      await applyMarketingChannelStatus(
        conn, links[0].lead_id, integration.location_id, record, options.lifecyclePoolRules || []
      );
      await storeCurrentContact(
        conn, integration, run.id, externalId, links[0].lead_id, record, payload, payloadHash
      );
      await storeFields(conn, integration.id, links[0].lead_id, record, run.id);
      await conn.query(
        `UPDATE crm_import_staging SET processing_status = 'skipped', lead_id = ?, processed_at = CURRENT_TIMESTAMP
         WHERE run_id = ? AND external_record_id = ?`,
        [links[0].lead_id, run.id, externalId]
      );
      await conn.commit();
      return { outcome: 'skipped', leadId: links[0].lead_id, externalId };
    }

    const preferredLeadId = String(options.forcedLeadId || externalId).slice(0, 128);
    const [existing] = await conn.query('SELECT id, locationId FROM leads WHERE id = ? LIMIT 1 FOR UPDATE', [preferredLeadId]);
    let leadId = preferredLeadId;
    let outcome = 'inserted';
    let collision = false;
    if (existing[0] && String(existing[0].locationId) === String(integration.location_id)) {
      outcome = 'linked';
    } else if (existing[0]) {
      leadId = crypto.randomUUID();
      collision = true;
    }

    if (run.dry_run) {
      if (collision) {
        await recordConflict(conn, run, externalId, 'lead_id_collision', existing[0].id, {
          generatedLeadId: leadId,
          existingLocationId: existing[0].locationId,
          dryRun: true,
        });
      }
      await conn.query(
        `UPDATE crm_import_staging SET processing_status = ?, lead_id = ?, processed_at = CURRENT_TIMESTAMP
         WHERE run_id = ? AND external_record_id = ?`,
        [collision ? 'dry_run_conflicted_insert' : `dry_run_${outcome}`, leadId, run.id, externalId]
      );
      await conn.commit();
      return { outcome: collision ? 'conflicted_insert' : outcome, leadId, externalId, dryRun: true };
    }

    if (outcome === 'inserted') {
      const suppliedService = getPath(record, config.serviceTypePath) || options.defaultServiceType || config.defaultServiceType;
      const serviceType = String(classifyLeadRecord(record, options.servicePoolRules || [], suppliedService)).slice(0, 128);
      const screening = classifyDncScreening(record);
      await conn.query(
        `INSERT INTO leads
           (id, locationId, serviceType, status, contactData, dncStatus, dncCheckedAt,
            dncSource, dncResultCode, dncReason, dncDecisionCategory, dncReviewRequired, dateAdded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, COALESCE(?, CURRENT_TIMESTAMP))`,
        [leadId, integration.location_id, serviceType,
          dncDestinationStatus(screening, options.lifecyclePoolRules || []), payload, screening.state,
          screening.state === 'pending' ? null : new Date(),
          screening.state === 'pending' ? null : 'crm_tags',
          screening.state === 'pending' ? null : 'crm_tag',
          normalizeDateTime(getPath(record, config.dateAddedPath))]
      );
      await applyMarketingChannelStatus(
        conn, leadId, integration.location_id, record, options.lifecyclePoolRules || []
      );
    } else {
      await applyDncScreeningStatus(
        conn, leadId, integration.location_id,
        classifyDncScreening(record), options.lifecyclePoolRules || []
      );
      await applyMarketingChannelStatus(
        conn, leadId, integration.location_id, record, options.lifecyclePoolRules || []
      );
    }
    await conn.query(
      `INSERT INTO lead_source_links
         (id, lead_id, integration_id, location_id, external_record_id, external_updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), leadId, integration.id, integration.location_id, externalId,
        normalizeDateTime(getPath(record, config.externalUpdatedPath))]
    );
    await storeCurrentContact(conn, integration, run.id, externalId, leadId, record, payload, payloadHash);
    await storeFields(conn, integration.id, leadId, record, run.id);
    if (collision) {
      await recordConflict(conn, run, externalId, 'lead_id_collision', existing[0].id, {
        generatedLeadId: leadId,
        existingLocationId: existing[0].locationId,
      });
    }
    await conn.query(
      `UPDATE crm_import_staging SET processing_status = ?, lead_id = ?, processed_at = CURRENT_TIMESTAMP
       WHERE run_id = ? AND external_record_id = ?`,
      [collision ? 'inserted_with_conflict' : outcome, leadId, run.id, externalId]
    );
    await conn.commit();
    return { outcome: collision ? 'conflicted_insert' : outcome, leadId, externalId };
  } catch (error) {
    await conn.rollback();
    try {
      await pool.query(
        `UPDATE crm_import_staging SET processing_status = 'failed', error_message = ?, processed_at = CURRENT_TIMESTAMP
         WHERE run_id = ? AND external_record_id = ?`,
        [String(error.message || 'Processing failed').slice(0, 1000), run.id, externalId]
      );
    } catch {
      // Preserve the original processing error.
    }
    return { outcome: 'failed', externalId, error: error.message };
  } finally {
    conn.release();
  }
}

function normalizeDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ');
}

function addOutcome(counts, result) {
  if (result.outcome === 'inserted') counts.inserted += 1;
  else if (result.outcome === 'linked') counts.linked += 1;
  else if (result.outcome === 'skipped') counts.skipped += 1;
  else if (result.outcome === 'conflicted_insert') {
    counts.inserted += 1;
    counts.conflicted += 1;
  }
  else if (result.outcome === 'conflicted') counts.conflicted += 1;
  else counts.failed += 1;
}

async function executeImportRun(integration, runId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM crm_import_runs WHERE id = ? LIMIT 1', [runId]);
  const run = rows[0];
  if (!run) throw Object.assign(new Error('Import run not found'), { status: 404 });
  const options = parseJson(run.options_json);
  options.servicePoolRules = await listServicePools(p, 'core', integration.location_id);
  options.lifecyclePoolRules = await listPoolRules(p, 'core', integration.location_id);
  const pageSize = Math.min(Math.max(Number(options.pageSize) || 100, 1), safeConfig(integration).maxPageSize);
  const pageBudget = options.full
    ? 100000
    : Math.min(Math.max(Number(options.maxPages) || 1000, 1), 100000);
  const syncStartedAt = normalizeDateTime(options.checkpointAt) || normalizeDateTime(new Date());
  const counts = { fetched: 0, inserted: 0, linked: 0, skipped: 0, conflicted: 0, failed: 0, pages: 0 };
  await p.query(
    `UPDATE crm_import_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`,
    [syncStartedAt, runId]
  );
  try {
    if (!run.dry_run) {
      await syncCustomFieldDefinitions(integration, p);
    }
    const walk = await walkCrmContacts(integration, {
      cursor: run.current_cursor || null,
      pageSize,
      pageBudget,
      updatedAfter: options.updatedAfter || null,
      updatedBefore: options.updatedBefore || null,
      onPage: async (page, progress) => {
        counts.pages = progress.pages;
        counts.fetched = progress.records;
        for (const record of page.records) {
          const result = await processRecord(p, integration, run, record, options);
          addOutcome(counts, result);
        }
        await p.query(
          `UPDATE crm_import_runs SET current_cursor = ?, expected_records = ?, records_fetched = ?,
             records_inserted = ?, records_linked = ?, records_skipped = ?, records_conflicted = ?,
             records_failed = ?, pages_processed = ? WHERE id = ?`,
          [page.nextCursor, progress.expectedTotal, counts.fetched, counts.inserted, counts.linked,
            counts.skipped, counts.conflicted, counts.failed, counts.pages, runId]
        );
      },
    });
    const status = counts.failed || counts.conflicted ? 'partial' : 'completed';
    if (options.full && !run.dry_run && status === 'completed') {
      await p.query(
        `UPDATE crm_contact_records SET is_current = 0
         WHERE integration_id = ? AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?)`,
        [integration.id, runId]
      );
    }
    await p.query(
      `UPDATE crm_import_runs SET status = ?, current_cursor = ?, error_summary = ?,
         expected_records = ?, completion_reason = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, null, null, walk.expectedTotal, walk.completionReason, runId]
    );
    if (!run.dry_run && status === 'completed') {
      await p.query(
        `UPDATE crm_integrations SET last_cursor = ?, last_sync_at = ? WHERE id = ?`,
        [walk.lastCursor, syncStartedAt, integration.id]
      );
    }
  } catch (error) {
    await p.query(
      `UPDATE crm_import_runs SET status = 'failed', current_cursor = COALESCE(?, current_cursor),
         expected_records = COALESCE(?, expected_records), error_summary = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [error.cursor || null, error.expectedTotal ?? null,
        String(error.message || 'Import failed').slice(0, 1000), runId]
    );
    throw error;
  }
  return getImportRun(runId, p);
}

function classifyDncScreening(record) {
  const tags = normalizeRecordTags(record);
  const blockedTags = new Set([
    'dnc-blocked', 'dnc', 'do not call', 'do-not-call', 'do_not_call',
    'dnd phone', 'dnd-phone', 'dnd_phone',
  ]);
  const cleanTags = new Set(['dnc-clean', 'dnc-wireless']);
  if (tags.some((tag) => blockedTags.has(tag))) return { state: 'blocked', tags };
  if (tags.some((tag) => cleanTags.has(tag))) return { state: 'clean', tags };
  if (tags.includes('dnc-review')) return { state: 'review', tags };
  return { state: 'pending', tags };
}

function findDncRuleForRecord(record, lifecycleRules) {
  if (classifyDncScreening(record).state !== 'blocked') return null;
  return lifecycleRules.find((item) => item.isEnabled && item.poolKey === 'dnc') || null;
}

function dncDestinationStatus(screening, lifecycleRules) {
  if (!lifecycleRules.length) return 'uncontacted';
  const poolKey = screening.state === 'blocked' ? 'dnc' : screening.state === 'clean' ? 'available' : 'dnc_pending';
  return lifecycleRules.find((item) => item.isEnabled && item.poolKey === poolKey)?.destinationStatus ||
    (screening.state === 'blocked' ? 'do_not_call' : screening.state === 'clean' ? 'uncontacted' : 'dnc_pending');
}

async function applyDncScreeningStatus(conn, leadId, locationId, screening, lifecycleRules, evidence = {}) {
  if (!lifecycleRules.length) return;
  const source = evidence.source || (screening.state === 'pending' ? null : 'crm_tags');
  const resultCode = evidence.resultCode ? String(evidence.resultCode).slice(0, 8) : null;
  const reason = evidence.reason ? String(evidence.reason).slice(0, 255) : null;
  const decisionCategory = evidence.decisionCategory
    ? String(evidence.decisionCategory).slice(0, 48)
    : source ? 'crm_tag' : null;
  const reviewRequired = evidence.reviewRequired ? 1 : 0;
  const [updated] = await conn.query(
    `UPDATE leads SET dncStatus = ?,
       dncCheckedAt = CASE WHEN ? = 'pending' THEN NULL ELSE CURRENT_TIMESTAMP END,
       dncSource = ?, dncResultCode = ?, dncReason = ?,
       dncDecisionCategory = ?, dncReviewRequired = ?,
       phoneMarketingStatus = CASE
         WHEN ? = 'clean' THEN 'available'
         WHEN ? IN ('blocked', 'review') THEN 'blocked'
         WHEN phoneMarketingStatus = 'unavailable' THEN 'unavailable'
         ELSE 'pending' END
     WHERE id = ? AND locationId = ?
       AND (? = 'dncscrub_api'
         OR COALESCE(dncSource, '') NOT IN ('dncscrub_api','owl_review_override')
         OR ? = 'blocked')
       AND (? IS NULL OR dncStatus = ?)`,
    [screening.state, screening.state, source, resultCode, reason, decisionCategory, reviewRequired,
      screening.state, screening.state,
      leadId, locationId,
      source, screening.state,
      evidence.expectedDncStatus || null, evidence.expectedDncStatus || null]
  );
  if (!updated?.affectedRows) return false;
  const dncRule = lifecycleRules.find((item) => item.isEnabled && item.poolKey === 'dnc');
  const pendingRule = lifecycleRules.find((item) => item.isEnabled && item.poolKey === 'dnc_pending');
  const availableRules = lifecycleRules.filter((item) => item.isEnabled && item.isAssignable);
  const assignedRule = lifecycleRules.find((item) => item.isEnabled && item.poolKey === 'assigned');
  let destination;
  let sourceStatuses;
  if (screening.state === 'blocked') {
    destination = dncRule;
    sourceStatuses = null;
  } else if (screening.state === 'clean') {
    destination = availableRules[0];
    sourceStatuses = (pendingRule?.statusValues || []).concat(
      evidence.allowBlockedRelease ? (dncRule?.statusValues || []) : []
    );
  } else {
    destination = pendingRule;
    sourceStatuses = availableRules.flatMap((item) => item.statusValues)
      .concat(assignedRule?.statusValues || [])
      .concat(screening.state === 'review' && evidence.allowBlockedRelease
        ? (dncRule?.statusValues || []) : []);
  }
  if (!destination) return;
  const params = [destination.destinationStatus, leadId, locationId, destination.destinationStatus];
  let statusFilter = '';
  if (sourceStatuses) {
    if (!sourceStatuses.length) return;
    statusFilter = ` AND status IN (${sourceStatuses.map(() => '?').join(',')})`;
    params.push(...sourceStatuses);
  }
  await conn.query(
    `UPDATE leads SET status = ?, assignedTo = NULL
     WHERE id = ? AND locationId = ? AND status <> ?${statusFilter}`,
    params
  );
  return true;
}

function normalizeRecordTags(record) {
  if (!record || typeof record !== 'object') return [];
  const tags = record.tags ?? record.tag ?? record.contactTags;
  const values = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
  return values.map((value) => String(value).trim().toLowerCase()).filter(Boolean);
}

const CHANNEL_DND_TAGS = Object.freeze({
  phone:new Set(['dnd phone', 'do not disturb phone', 'do not call phone']),
  email:new Set(['dnd email', 'do not disturb email', 'do not email']),
  sms:new Set(['dnd sms', 'dnd text', 'do not disturb sms', 'do not disturb text', 'do not text']),
});

function canonicalMarketingTag(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\-/]+/g, ' ').replace(/\s+/g, ' ');
}

function recordEmail(record) {
  if (!record || typeof record !== 'object') return null;
  const candidates = [
    record.email, record.emailAddress, record.contact?.email, record.contact?.emailAddress,
    record.primaryEmail, record.address?.email,
  ];
  for (const value of candidates) {
    const email = String(value || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254) return email;
  }
  return null;
}

function classifyMarketingChannels(record) {
  const tags = normalizeRecordTags(record);
  const canonical = tags.map(canonicalMarketingTag);
  const dndPhone = canonical.some((tag) => CHANNEL_DND_TAGS.phone.has(tag));
  const dndEmail = canonical.some((tag) => CHANNEL_DND_TAGS.email.has(tag));
  const dndSms = canonical.some((tag) => CHANNEL_DND_TAGS.sms.has(tag));
  const hasPhone = Boolean(extractPhone(record));
  const hasEmail = Boolean(recordEmail(record));
  return {
    hasPhone,
    hasEmail,
    dndPhone,
    dndEmail,
    dndSms,
    phoneStatus:!hasPhone ? 'unavailable' : dndPhone ? 'blocked' : 'pending',
    emailStatus:!hasEmail ? 'unavailable' : dndEmail ? 'blocked' : 'available',
    smsStatus:!hasPhone ? 'unavailable' : dndSms ? 'blocked' : 'available',
    matchedTags:tags.filter((tag, index) =>
      CHANNEL_DND_TAGS.phone.has(canonical[index]) ||
      CHANNEL_DND_TAGS.email.has(canonical[index]) ||
      CHANNEL_DND_TAGS.sms.has(canonical[index])
    ),
  };
}

async function applyMarketingChannelStatus(conn, leadId, locationId, record, lifecycleRules) {
  if (!lifecycleRules.length) return classifyMarketingChannels(record);
  const channels = classifyMarketingChannels(record);
  const evidenceTags = JSON.stringify(channels.matchedTags).slice(0, 255);
  await conn.query(
    `UPDATE leads SET
       phoneMarketingStatus = CASE
         WHEN ? = 'pending' AND dncStatus = 'clean' THEN 'available'
         WHEN ? = 'pending' AND dncStatus = 'blocked' THEN 'blocked'
         ELSE ? END,
       emailMarketingStatus = ?, smsMarketingStatus = ?,
       marketingChannelSource = 'crm_tags', marketingChannelTags = ?,
       marketingChannelsCheckedAt = CURRENT_TIMESTAMP
     WHERE id = ? AND locationId = ?`,
    [channels.phoneStatus, channels.phoneStatus, channels.phoneStatus,
      channels.emailStatus, channels.smsStatus, evidenceTags, leadId, locationId]
  );
  const noPhoneRule = lifecycleRules.find((item) => item.isEnabled && item.poolKey === 'no_phone');
  const pendingRule = lifecycleRules.find((item) => item.isEnabled && item.poolKey === 'dnc_pending');
  const dncRule = lifecycleRules.find((item) => item.isEnabled && item.poolKey === 'dnc');
  if (!channels.hasPhone && noPhoneRule) {
    await conn.query(
      `UPDATE leads SET status = ?, assignedTo = NULL, dncStatus = 'pending', dncCheckedAt = NULL,
         dncSource = 'crm_contact', dncResultCode = 'PHONE',
         dncReason = 'No valid phone number; held outside phone systems',
         dncDecisionCategory = 'missing_contact_data', dncReviewRequired = 0
       WHERE id = ? AND locationId = ?`,
      [noPhoneRule.destinationStatus, leadId, locationId]
    );
  } else if (channels.dndPhone && dncRule) {
    await conn.query(
      `UPDATE leads SET status = ?, assignedTo = NULL, dncStatus = 'blocked',
         dncCheckedAt = CURRENT_TIMESTAMP, dncSource = 'crm_tags', dncResultCode = 'DND_PH',
         dncReason = 'CRM DND Phone tag', dncDecisionCategory = 'channel_preference',
         dncReviewRequired = 0, phoneMarketingStatus = 'blocked'
       WHERE id = ? AND locationId = ?`,
      [dncRule.destinationStatus, leadId, locationId]
    );
  } else if (channels.hasPhone && pendingRule && noPhoneRule?.statusValues?.length) {
    await conn.query(
      `UPDATE leads SET status = ?, assignedTo = NULL, dncStatus = 'pending', dncCheckedAt = NULL,
         dncSource = 'crm_contact', dncResultCode = NULL,
         dncReason = 'Phone added or restored; DNC scrub required',
         dncDecisionCategory = 'phone_restored', dncReviewRequired = 0,
         phoneMarketingStatus = 'pending'
       WHERE id = ? AND locationId = ?
         AND status IN (${noPhoneRule.statusValues.map(() => '?').join(',')})`,
      [pendingRule.destinationStatus, leadId, locationId, ...noPhoneRule.statusValues]
    );
  }
  return channels;
}

async function backfillExistingLeads(integration, apiKeyId, pool = null) {
  const p = pool || getPool();
  const runId = await createImportRun(integration, apiKeyId, { source: 'existing_leads_backfill' }, p);
  const [runRows] = await p.query('SELECT * FROM crm_import_runs WHERE id = ?', [runId]);
  const run = runRows[0];
  await p.query(`UPDATE crm_import_runs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?`, [runId]);
  const counts = { fetched: 0, inserted: 0, linked: 0, skipped: 0, conflicted: 0, failed: 0 };
  const [servicePoolRules, lifecyclePoolRules] = await Promise.all([
    listServicePools(p, 'core', integration.location_id),
    listPoolRules(p, 'core', integration.location_id),
  ]);
  let afterId = '';
  while (true) {
    const [leads] = await p.query(
      `SELECT id, contactData FROM leads WHERE locationId = ? AND id > ? ORDER BY id ASC LIMIT 250`,
      [integration.location_id, afterId]
    );
    if (!leads.length) break;
    for (const lead of leads) {
      afterId = lead.id;
      counts.fetched += 1;
      let record;
      try {
        record = typeof lead.contactData === 'string' ? JSON.parse(lead.contactData) : lead.contactData;
        if (!record || typeof record !== 'object') throw new Error('contactData is not an object');
      } catch (error) {
        counts.failed += 1;
        await recordConflict(p, run, normalizeExternalId(lead.id), 'invalid_contact_data', lead.id, {
          error: error.message,
        });
        continue;
      }
      const result = await processRecord(p, integration, run, record, {
        forcedExternalId: getPath(record, safeConfig(integration).idPath) || lead.id,
        forcedLeadId: lead.id,
        servicePoolRules,
        lifecyclePoolRules,
      });
      addOutcome(counts, result);
    }
  }
  const status = counts.failed || counts.conflicted ? 'partial' : 'completed';
  await p.query(
    `UPDATE crm_import_runs SET status = ?, records_fetched = ?, records_inserted = ?,
       records_linked = ?, records_skipped = ?, records_conflicted = ?, records_failed = ?,
       completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, counts.fetched, counts.inserted, counts.linked, counts.skipped,
      counts.conflicted, counts.failed, runId]
  );
  return getImportRun(runId, p);
}

module.exports = {
  getPath,
  flattenRecord,
  classifyValue,
  normalizeExternalId,
  normalizeDateTime,
  storeFields,
  storeCurrentContact,
  safeConfig,
  fetchCrmPage,
  walkCrmContacts,
  syncCustomFieldDefinitions,
  syncObjectDefinitions,
  objectSchemaFields,
  testIntegration,
  createImportRun,
  getImportRun,
  executeImportRun,
  backfillExistingLeads,
  findDncRuleForRecord,
  classifyDncScreening,
  classifyMarketingChannels,
  applyMarketingChannelStatus,
  dncDestinationStatus,
  applyDncScreeningStatus,
};
