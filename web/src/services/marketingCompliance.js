const { isConfiguredCrmHost } = require('./crmOrigins');
const crypto = require('crypto');
const { outboundUserAgent } = require('../instanceIdentity');
const { normalizeState } = require('./eagle');
const { integrationCredential, parseJson, LEADCONNECTOR_ORIGIN } = require('./crmIntegrations');
const {
  reconcileScheduledAppointment,
  scheduledAppointmentError,
  findActiveScheduledOverride,
  consumeScheduledOverride,
} = require('./calendarAppointments');

const COMPANY_START_HOUR = 8;
const COMPANY_END_HOUR = 19;
const FLORIDA_MAX_ATTEMPTS_24H = 3;
const FLORIDA_TIME_ZONES = new Set(['America/New_York', 'America/Chicago']);
const FLORIDA_CONSERVATIVE_TIME_ZONE = 'America/New_York';
// Florida spans Eastern and Central time. Without a trusted exact zone, 9 AM Eastern is
// 8 AM Central and 7 PM Eastern is 6 PM Central, so this overlap honors the company window
// in either Florida zone.
const FLORIDA_CONSERVATIVE_START_HOUR = COMPANY_START_HOUR + 1;
const TEXAS_TIME_ZONES = new Set(['America/Chicago', 'America/Denver']);
const TEXAS_CONSERVATIVE_TIME_ZONE = 'America/Chicago';
// Texas spans Central and Mountain time. A 9 AM-7 PM Central window is inside the
// configured 8 AM-7 PM company window in either Texas timezone.
const TEXAS_CONSERVATIVE_START_HOUR = COMPANY_START_HOUR + 1;
const CALL_HISTORY_TIMEOUT_MS = 6000;
const TIME_ZONE_API_ORIGIN = 'https://timeapi.io';
const TIME_ZONE_API_PATH = '/api/timezone/coordinate';
const TIME_ZONE_TIMEOUT_MS = 5000;
const TIME_ZONE_MAX_BYTES = 8192;
const TIME_ZONE_CACHE_DAYS = 180;

const TIME_ZONE_ALIASES = new Map(Object.entries({
  EST: 'America/New_York', EDT: 'America/New_York', 'US/Eastern': 'America/New_York',
  CST: 'America/Chicago', CDT: 'America/Chicago', 'US/Central': 'America/Chicago',
  MST: 'America/Denver', MDT: 'America/Denver', 'US/Mountain': 'America/Denver',
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', 'US/Pacific': 'America/Los_Angeles',
  'Eastern Time (US & Canada)': 'America/New_York', 'Central Time (US & Canada)': 'America/Chicago',
  'Mountain Time (US & Canada)': 'America/Denver', 'Pacific Time (US & Canada)': 'America/Los_Angeles',
}));

// Only states with a dependable single-zone fallback are listed. Split-zone states fail closed
// unless the CRM supplies an explicit IANA timezone.
const STATE_TIME_ZONES = new Map(Object.entries({
  AL:'America/Chicago', AR:'America/Chicago', AZ:'America/Phoenix', CA:'America/Los_Angeles',
  CO:'America/Denver', CT:'America/New_York', DC:'America/New_York', DE:'America/New_York',
  GA:'America/New_York', HI:'Pacific/Honolulu', IA:'America/Chicago', IL:'America/Chicago',
  LA:'America/Chicago', MA:'America/New_York', MD:'America/New_York', ME:'America/New_York',
  MN:'America/Chicago', MO:'America/Chicago', MS:'America/Chicago', MT:'America/Denver',
  NC:'America/New_York', NH:'America/New_York', NJ:'America/New_York', NM:'America/Denver',
  NY:'America/New_York', OH:'America/New_York', OK:'America/Chicago', PA:'America/New_York',
  RI:'America/New_York', SC:'America/New_York', UT:'America/Denver', VA:'America/New_York',
  VT:'America/New_York', WA:'America/Los_Angeles', WI:'America/Chicago', WV:'America/New_York',
  WY:'America/Denver',
}));

function parseRecord(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; }
  catch { return {}; }
}

function firstValue(object, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current == null ? undefined : current[key], object);
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function validTimeZone(value) {
  if (!value) return null;
  const candidate = TIME_ZONE_ALIASES.get(String(value).trim()) || String(value).trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date()); return candidate; }
  catch { return null; }
}

function coordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function leadCoordinates(contactData) {
  const record = parseRecord(contactData);
  return {
    latitude:coordinate(firstValue(record, [
      'latitude', 'lat', 'geo.latitude', 'location.latitude', 'address.latitude',
      'contact.latitude', 'contact.geo.latitude',
    ]), -90, 90),
    longitude:coordinate(firstValue(record, [
      'longitude', 'lng', 'lon', 'long', 'geo.longitude', 'location.longitude',
      'address.longitude', 'contact.longitude', 'contact.geo.longitude',
    ]), -180, 180),
  };
}

async function fetchTimeZoneByCoordinates(latitude, longitude, fetchImpl = fetch) {
  const lat = coordinate(latitude, -90, 90);
  const lon = coordinate(longitude, -180, 180);
  if (lat == null || lon == null) throw new Error('Valid lead coordinates are required for timezone resolution');
  const url = new URL(TIME_ZONE_API_PATH, TIME_ZONE_API_ORIGIN);
  url.searchParams.set('latitude', lat.toFixed(6));
  url.searchParams.set('longitude', lon.toFixed(6));
  if (url.origin !== TIME_ZONE_API_ORIGIN || url.pathname !== TIME_ZONE_API_PATH) {
    throw new Error('Timezone resolver URL is invalid');
  }
  const response = await fetchImpl(url, {
    headers:{ Accept:'application/json', 'User-Agent':outboundUserAgent('compliance') },
    redirect:'error', signal:AbortSignal.timeout(TIME_ZONE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Timezone resolver request failed with HTTP ${response.status}`);
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > TIME_ZONE_MAX_BYTES) {
    throw new Error('Timezone resolver response exceeded its size limit');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > TIME_ZONE_MAX_BYTES) {
    throw new Error('Timezone resolver response exceeded its size limit');
  }
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error('Timezone resolver returned invalid JSON'); }
  const timeZone = validTimeZone(body?.timeZone);
  if (!timeZone) throw new Error('Timezone resolver returned an invalid IANA timezone');
  return timeZone;
}

async function resolveCoordinateTimeZone(pool, lead) {
  const coords = leadCoordinates(lead.contactData);
  if (coords.latitude == null || coords.longitude == null) return null;
  try {
    const [rows] = await pool.query(
      `SELECT time_zone FROM lead_timezone_cache
       WHERE location_id=? AND lead_id=? AND expires_at>UTC_TIMESTAMP(3)
         AND ABS(latitude-?)<0.0001 AND ABS(longitude-?)<0.0001
       LIMIT 1`,
      [lead.locationId, lead.id, coords.latitude, coords.longitude]
    );
    const cached = validTimeZone(rows[0]?.time_zone);
    if (cached) return { timeZone:cached, source:'coordinate_cache', ...coords };
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
  }
  let timeZone;
  try { timeZone = await fetchTimeZoneByCoordinates(coords.latitude, coords.longitude); }
  catch { return null; }
  try {
    await pool.query(
      `INSERT INTO lead_timezone_cache
         (location_id,lead_id,latitude,longitude,time_zone,resolver,resolved_at,expires_at)
       VALUES (?,?,?,?,?,'timeapi_coordinate',UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? DAY))
       ON DUPLICATE KEY UPDATE latitude=VALUES(latitude),longitude=VALUES(longitude),
         time_zone=VALUES(time_zone),resolver=VALUES(resolver),resolved_at=VALUES(resolved_at),expires_at=VALUES(expires_at)`,
      [lead.locationId, lead.id, coords.latitude, coords.longitude, timeZone, TIME_ZONE_CACHE_DAYS]
    );
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
  }
  return { timeZone, source:'coordinate_api', ...coords };
}

async function hydrateLeadTimeZone(pool, lead) {
  const jurisdiction = resolveLeadJurisdiction(lead.contactData);
  if (!jurisdiction.stateCode || jurisdiction.timeZone) return lead;
  const resolved = await resolveCoordinateTimeZone(pool, lead);
  if (!resolved) return lead;
  return {
    ...lead,
    contactData:{ ...parseRecord(lead.contactData), timezone:resolved.timeZone, timeZoneSource:resolved.source },
  };
}

function resolveLeadJurisdiction(contactData) {
  const record = parseRecord(contactData);
  const stateCode = normalizeState(firstValue(record, [
    'state', 'stateCode', 'state_code', 'address.state', 'contact.state', 'contact.stateCode',
  ]));
  const suppliedTimeZone = validTimeZone(firstValue(record, [
    'timezone', 'timeZone', 'time_zone', 'address.timezone', 'contact.timezone', 'contact.timeZone',
  ]));
  const stateFallback = STATE_TIME_ZONES.get(stateCode) || null;
  let explicitTimeZone = suppliedTimeZone;
  if (stateCode === 'FL' && explicitTimeZone && !FLORIDA_TIME_ZONES.has(explicitTimeZone)) {
    explicitTimeZone = null;
  } else if (stateCode === 'TX' && explicitTimeZone && !TEXAS_TIME_ZONES.has(explicitTimeZone)) {
    explicitTimeZone = null;
  } else if (stateFallback && explicitTimeZone && explicitTimeZone !== stateFallback) {
    explicitTimeZone = null;
  }
  return {
    stateCode,
    timeZone: explicitTimeZone || stateFallback,
    timeZoneSource: explicitTimeZone ? 'crm' : stateFallback ? 'state_fallback' : null,
  };
}

function localDateParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit',
    second:'2-digit', hourCycle:'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
}

function zonedDateTimeUtc(parts, hour, timeZone) {
  const target = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = localDateParts(new Date(candidate), timeZone);
    const represented = Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day), Number(current.hour), Number(current.minute), Number(current.second));
    candidate -= represented - target;
  }
  return new Date(candidate);
}

function nextMarketingOpen(now, timeZone, parts, startHour = COMPANY_START_HOUR) {
  const hour = Number(parts.hour);
  const start = zonedDateTimeUtc(parts, startHour, timeZone);
  if (hour < startHour) return start;
  const tomorrow = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1));
  return zonedDateTimeUtc({ year:tomorrow.getUTCFullYear(), month:tomorrow.getUTCMonth()+1, day:tomorrow.getUTCDate() }, startHour, timeZone);
}

function evaluateMarketingWindow(contactData, now = new Date()) {
  let jurisdiction = resolveLeadJurisdiction(contactData);
  if (!jurisdiction.stateCode) return { allowed:false, reason:'state_unknown', ...jurisdiction, localTime:null, nextEligibleAt:null };
  let startHour = COMPANY_START_HOUR;
  if (!jurisdiction.timeZone && jurisdiction.stateCode === 'FL') {
    jurisdiction = {
      ...jurisdiction,
      timeZone:FLORIDA_CONSERVATIVE_TIME_ZONE,
      timeZoneSource:'state_conservative_overlap',
    };
    startHour = FLORIDA_CONSERVATIVE_START_HOUR;
  } else if (!jurisdiction.timeZone && jurisdiction.stateCode === 'TX') {
    jurisdiction = {
      ...jurisdiction,
      timeZone:TEXAS_CONSERVATIVE_TIME_ZONE,
      timeZoneSource:'state_conservative_overlap',
    };
    startHour = TEXAS_CONSERVATIVE_START_HOUR;
  }
  if (!jurisdiction.timeZone) return { allowed:false, reason:'timezone_unknown', ...jurisdiction, localTime:null, nextEligibleAt:null };
  const parts = localDateParts(now, jurisdiction.timeZone);
  const hour = Number(parts.hour);
  const localTime = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  if (hour < startHour || hour >= COMPANY_END_HOUR) {
    return {
      allowed:false, reason:'outside_marketing_hours', ...jurisdiction, localTime,
      nextEligibleAt:nextMarketingOpen(now, jurisdiction.timeZone, parts, startHour).toISOString(),
    };
  }
  return { allowed:true, reason:'eligible', ...jurisdiction, localTime, nextEligibleAt:null };
}

async function grantedIntegrationsForLeads(pool, apiKeyId, locationId, leadIds) {
  if (!leadIds.length) return new Map();
  const placeholders = leadIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT sl.lead_id, sl.external_record_id, i.*
     FROM lead_source_links sl
     INNER JOIN crm_integrations i ON i.id = sl.integration_id
     INNER JOIN crm_integration_grants g ON g.integration_id = i.id
     WHERE sl.location_id = ? AND sl.lead_id IN (${placeholders})
       AND g.api_key_id = ? AND g.allow_read = 1 AND i.is_enabled = 1
     ORDER BY CASE WHEN i.provider = 'leadconnector-pit' THEN 0 WHEN i.provider = 'nova-edge' THEN 1 ELSE 2 END`,
    [locationId, ...leadIds, apiKeyId]
  );
  const result = new Map();
  for (const row of rows) if (!result.has(String(row.lead_id))) result.set(String(row.lead_id), row);
  return result;
}

function upstreamUrl(integration, configuredPath, fallbackPath, replacements = {}) {
  const config = parseJson(integration.config_json);
  let path = String(config[configuredPath] || fallbackPath);
  for (const [key, value] of Object.entries(replacements)) path = path.replace(`{${key}}`, encodeURIComponent(value));
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${integration.base_url}/`);
  if (url.origin !== new URL(integration.base_url).origin) throw new Error('CRM compliance path must stay on the configured origin');
  return url;
}

async function crmJson(url, integration) {
  const credential = integrationCredential(integration);
  if (!credential) throw new Error('CRM credential is unavailable');
  const config = parseJson(integration.config_json);
  const response = await fetch(url, {
    headers: {
      Accept:'application/json', Authorization:`${integration.auth_scheme || 'Bearer'} ${credential}`.trim(),
      Version:String(config.complianceVersion || 'v3'),
    },
    redirect:'error', signal:AbortSignal.timeout(CALL_HISTORY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`CRM call-history request failed with HTTP ${response.status}`);
  return response.json();
}

function crmPaths(integration) {
  const direct = new URL(integration.base_url).origin === LEADCONNECTOR_ORIGIN;
  if (direct) return { search:'/conversations/search', messages:'/conversations/{conversationId}/messages' };
  const host = new URL(integration.base_url).hostname.toLowerCase();
  if (isConfiguredCrmHost(host)) {
    return { search:'/backend/conversations/search', messages:'/backend/conversations/{conversationId}/messages' };
  }
  throw new Error('CRM provider does not define a call-history adapter');
}

function outboundCalls(messages, now) {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  return messages.filter((message) => {
    const direction = String(message.direction || '').toLowerCase();
    const type = String(message.messageType || message.type || '').toUpperCase();
    const typeString = String(message.messageTypeString || '').toUpperCase();
    const occurredAt = new Date(message.dateAdded || message.createdAt || message.timestamp || 0);
    const status = crmCallResult(message);
    return direction === 'outbound' && (type === 'CALL' || typeString === 'TYPE_CALL')
      && occurredAt.getTime() >= cutoff && status;
  }).map((message) => ({
    eventId:String(message.messageId || message.id || crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex')).slice(0,191),
    occurredAt:new Date(message.dateAdded || message.createdAt || message.timestamp).toISOString(),
    status:crmCallResult(message),
    externalUserId:crmCallUserId(message),
  }));
}

const FINAL_CALL_RESULTS = new Set([
  'answered', 'blocked', 'busy', 'canceled', 'cancelled', 'completed', 'connected',
  'failed', 'missed', 'no_answer', 'not_answered', 'rejected', 'voicemail',
]);

function crmCallResult(message) {
  const raw = message.callStatus || message.call_status || message.status
    || message.metadata?.callStatus || message.meta?.callStatus || message.call?.status;
  const normalized = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_').slice(0,32);
  return FINAL_CALL_RESULTS.has(normalized) ? normalized : null;
}

function crmCallUserId(message) {
  const value = message.userId || message.user_id || message.senderId || message.sentBy
    || message.metadata?.userId || message.meta?.userId || message.call?.userId;
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0,128) : null;
}

async function fetchCrmCallAttempts(integration, externalContactId, now = new Date()) {
  const paths = crmPaths(integration);
  const search = upstreamUrl(integration, 'complianceConversationSearchPath', paths.search);
  search.searchParams.set('locationId', integration.location_id);
  search.searchParams.set('contactId', externalContactId);
  search.searchParams.set('limit', '20');
  const searchBody = await crmJson(search, integration);
  const conversations = Array.isArray(searchBody.conversations) ? searchBody.conversations
    : Array.isArray(searchBody.data?.conversations) ? searchBody.data.conversations : [];
  const conversation = conversations.find((item) => String(item.contactId || item.contact_id || '') === String(externalContactId)) || conversations[0];
  if (!conversation) return [];
  const conversationId = conversation.id || conversation._id;
  if (!conversationId) throw new Error('CRM conversation response omitted its ID');
  const messagesUrl = upstreamUrl(integration, 'complianceMessagesPath', paths.messages, { conversationId });
  messagesUrl.searchParams.set('limit', '100');
  const messages = [];
  let lastMessageId = null;
  for (let page = 0; page < 10; page += 1) {
    const pageUrl = new URL(messagesUrl);
    if (lastMessageId) pageUrl.searchParams.set('lastMessageId', lastMessageId);
    const messageBody = await crmJson(pageUrl, integration);
    const container = messageBody.messages && !Array.isArray(messageBody.messages) ? messageBody.messages : messageBody;
    const pageMessages = Array.isArray(messageBody.messages) ? messageBody.messages
      : Array.isArray(container.messages) ? container.messages
        : Array.isArray(messageBody.data?.messages) ? messageBody.data.messages : [];
    messages.push(...pageMessages);
    const calls = outboundCalls(messages, now);
    if (calls.length >= FLORIDA_MAX_ATTEMPTS_24H) return calls;
    const oldest = pageMessages.reduce((value, message) => {
      const time = new Date(message.dateAdded || message.createdAt || message.timestamp || 0).getTime();
      return Number.isFinite(time) ? Math.min(value, time) : value;
    }, Infinity);
    if (oldest < now.getTime() - 24 * 60 * 60 * 1000) return calls;
    const hasNext = Boolean(container.nextPage ?? messageBody.meta?.nextPage);
    if (!hasNext || !pageMessages.length) return calls;
    lastMessageId = container.lastMessageId || messageBody.meta?.lastMessageId || pageMessages[pageMessages.length - 1]?.messageId || pageMessages[pageMessages.length - 1]?.id;
    if (!lastMessageId) throw new Error('CRM call-history pagination omitted its cursor');
  }
  throw new Error('CRM call-history pagination exceeded its safety ceiling');
}



async function storeCrmAttempts(pool, lead, integration, attempts) {
  const externalUserIds = [...new Set(attempts.map((attempt) => attempt.externalUserId).filter(Boolean))];
  const localUsers = new Map();
  if (externalUserIds.length) {
    const placeholders = externalUserIds.map(() => '?').join(',');
    const [users] = await pool.query(
      `SELECT id,crmUserId FROM users
       WHERE locationId=? AND crmUserId IN (${placeholders})`,
      [lead.locationId, ...externalUserIds]
    );
    for (const user of users) localUsers.set(String(user.crmUserId), user.id);
  }
  for (const attempt of attempts) {
    const occurredAt = mysqlUtc(attempt.occurredAt);
    const externalUserId = attempt.externalUserId || null;
    const localUserId = externalUserId ? localUsers.get(String(externalUserId)) || null : null;
    await pool.query(
      `INSERT INTO lead_call_attempts
       (id, location_id, lead_id, user_id, external_user_id, integration_id, external_event_id, subject_key, occurred_at, direction, call_status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'outbound', ?, 'crm')
      ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),external_user_id=VALUES(external_user_id),
        occurred_at=VALUES(occurred_at),call_status=VALUES(call_status),synced_at=UTC_TIMESTAMP(3)`,
      [crypto.randomUUID(), lead.locationId, lead.id, localUserId, externalUserId, integration.id, attempt.eventId,
        String(lead.serviceType || 'general').slice(0,128), occurredAt, attempt.status]
    );
  }
}



async function attemptStats(pool, leadId, now = new Date()) {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total, MIN(occurred_at) AS oldest FROM lead_call_attempts
     WHERE lead_id = ? AND direction = 'outbound' AND source = 'crm' AND occurred_at >= ?`,
    [leadId, mysqlUtc(cutoff)]
  );
  return { total:Number(rows[0]?.total) || 0, oldest:rows[0]?.oldest || null };
}

async function recordCheck(pool, input) {
  await pool.query(
    `INSERT INTO lead_compliance_checks
     (id, location_id, lead_id, user_id, state_code, time_zone, local_time,
      attempts_24h, decision, reason, next_eligible_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [crypto.randomUUID(), input.locationId, input.leadId, input.userId || null,
      input.stateCode || null, input.timeZone || null, input.localTime || null,
      Number(input.attempts24h) || 0, input.allowed ? 'allowed' : 'blocked', input.reason,
      input.nextEligibleAt ? mysqlUtc(input.nextEligibleAt) : null]
  );
}

function marketingWindowPolicy(contactData, now, enforceMarketingHours = true) {
  const window = evaluateMarketingWindow(contactData, now);
  if (enforceMarketingHours || window.allowed) return window;
  return {
    ...window,
    allowed:true,
    reason:'marketing_hours_not_enforced_for_queue',
    nextEligibleAt:null,
  };
}

async function evaluateLead(pool, { lead, integration, userId, now = new Date(), refreshCrm = true,
  enforceMarketingHours = true }) {
  const window = marketingWindowPolicy(lead.contactData, now, enforceMarketingHours);
  let result = { ...window, attempts24h:0 };
  if (window.allowed && window.stateCode === 'FL') {
    if (!integration) result = { ...result, allowed:false, reason:'crm_call_history_unavailable' };
    else {
      try {
        if (refreshCrm) {
          const attempts = await fetchCrmCallAttempts(integration, integration.external_record_id, now);
          await storeCrmAttempts(pool, lead, integration, attempts);
        }
        const stats = await attemptStats(pool, lead.id, now);
        result.attempts24h = stats.total;
        if (result.attempts24h >= FLORIDA_MAX_ATTEMPTS_24H) {
          result.allowed = false;
          result.reason = 'florida_attempt_limit';
          result.nextEligibleAt = stats.oldest ? new Date(`${String(stats.oldest).replace(' ', 'T')}Z`).getTime() + 24 * 60 * 60 * 1000 : null;
          if (result.nextEligibleAt) result.nextEligibleAt = new Date(result.nextEligibleAt).toISOString();
        }
      } catch (error) {
        result = { ...result, allowed:false, reason:'crm_call_history_unavailable', detail:error.message };
      }
    }
  }
  await recordCheck(pool, { ...result, locationId:lead.locationId, leadId:lead.id, userId });
  return result;
}

async function screenLeadCandidates(pool, { apiKeyId, locationId, userId, leads, now = new Date(),
  enforceMarketingHours = true }) {
  const hydrated = await mapLimit(leads, 4, (lead) => hydrateLeadTimeZone(pool, lead));
  const preliminary = hydrated.map((lead) => ({
    lead,
    window:marketingWindowPolicy(lead.contactData, now, enforceMarketingHours),
  }));
  const floridaIds = preliminary.filter((item) => item.window.allowed && item.window.stateCode === 'FL').map((item) => item.lead.id);
  const integrations = await grantedIntegrationsForLeads(pool, apiKeyId, locationId, floridaIds);
  const decisions = await mapLimit(preliminary, 4, async ({ lead, window }) => {
    if (!window.allowed) {
      const result = { ...window, attempts24h:0 };
      await recordCheck(pool, { ...result, locationId, leadId:lead.id, userId });
      return { lead, compliance:result };
    }
    return { lead, compliance:await evaluateLead(pool, {
      lead, integration:integrations.get(String(lead.id)), userId, now, enforceMarketingHours,
    }) };
  });
  return {
    eligible:decisions.filter((item) => item.compliance.allowed).map((item) => item.lead),
    blocked:decisions.filter((item) => !item.compliance.allowed),
  };
}

async function resolveComplianceLead(pool, { locationId, contactId, operationalPool = pool }) {
  const normalizedContactId = String(contactId || '').trim();
  if (!normalizedContactId) {
    throw Object.assign(new Error('contactId is required'), { status:400, code:'CONTACT_ID_REQUIRED' });
  }
  const [links] = await pool.query(
    `SELECT lead_id FROM lead_source_links
     WHERE location_id=? AND external_record_id=?
     ORDER BY last_seen_at DESC LIMIT 1`,
    [locationId, normalizedContactId]
  );
  const leadId = links[0]?.lead_id || normalizedContactId;
  const [rows] = await operationalPool.query(
    `SELECT id,locationId,serviceType,status,contactData,assignedTo,dncStatus,dncResultCode,dncSource,phoneMarketingStatus
     FROM leads WHERE id=? AND locationId=? LIMIT 1`,
    [leadId, locationId]
  );
  const lead = rows[0];
  if (!lead) throw Object.assign(new Error('Contact is not available in the Dialer'), { status:404, code:'CONTACT_NOT_FOUND' });
  lead.contactData = await complianceContactData(pool, lead, normalizedContactId);
  return lead;
}

async function complianceContactData(pool, lead, contactId) {
  const base = parseRecord(lead.contactData);
  const [records] = await pool.query(
    `SELECT payload_json FROM crm_contact_records
     WHERE location_id=? AND (lead_id=? OR external_record_id=?) AND is_current=1
     ORDER BY CASE WHEN external_record_id=? THEN 0 ELSE 1 END,last_seen_at DESC LIMIT 1`,
    [lead.locationId, lead.id, contactId, contactId]
  );
  const crm = parseRecord(records[0]?.payload_json);
  const merged = mergeComplianceRecord(base, crm);
  let jurisdiction = resolveLeadJurisdiction(merged);
  if (!jurisdiction.stateCode || !jurisdiction.timeZone) {
    const imported = await importedComplianceFields(pool, lead.id);
    Object.assign(merged, Object.fromEntries(
      Object.entries(imported).filter(([, value]) => value != null && String(value).trim())
    ));
    jurisdiction = resolveLeadJurisdiction(merged);
  }
  if (!jurisdiction.stateCode) {
    const [facts] = await pool.query(
      `SELECT state_code FROM eagle_lead_facts
       WHERE location_id=? AND (lead_id=? OR external_contact_id=?) AND state_code IS NOT NULL
       ORDER BY captured_at DESC LIMIT 1`,
      [lead.locationId, lead.id, contactId]
    );
    if (facts[0]?.state_code) merged.state = facts[0].state_code;
  }
  jurisdiction = resolveLeadJurisdiction(merged);
  if (jurisdiction.stateCode && !jurisdiction.timeZone) {
    const resolved = await resolveCoordinateTimeZone(pool, { ...lead, contactData:merged });
    if (resolved) {
      merged.timezone = resolved.timeZone;
      merged.timeZoneSource = resolved.source;
    }
  }
  return merged;
}

function mergeComplianceRecord(base, crm) {
  return {
    ...base,
    ...crm,
    address:{ ...parseRecord(base.address), ...parseRecord(crm.address) },
    contact:{ ...parseRecord(base.contact), ...parseRecord(crm.contact) },
  };
}

async function importedComplianceFields(pool, leadId) {
  const [rows] = await pool.query(
    `SELECT field_key,data_type,value_text,value_number,value_datetime,value_boolean,value_json
     FROM lead_import_values WHERE lead_id=? AND is_current=1`,
    [leadId]
  );
  const result = {};
  for (const row of rows) {
    const key = String(row.field_key || '').toLowerCase().split('.').pop().replace(/[^a-z0-9]/g, '');
    const value = importedValue(row);
    if (!result.state && (key === 'state' || key === 'statecode')) result.state = value;
    if (!result.timezone && (key === 'timezone' || key === 'timezoneid')) result.timezone = value;
    if (!result.city && key === 'city') result.city = value;
    if (result.latitude == null && (key === 'latitude' || key === 'lat')) result.latitude = value;
    if (result.longitude == null && ['longitude','lng','lon','long'].includes(key)) result.longitude = value;
  }
  return result;
}

function importedValue(row) {
  if (row.data_type === 'number') return Number(row.value_number);
  if (row.data_type === 'boolean') return Boolean(row.value_boolean);
  if (row.data_type === 'datetime') return row.value_datetime;
  if (row.data_type === 'json') return parseJson(row.value_json);
  return row.value_text;
}

async function authorizeCallAttempt(pool, { apiKeyId, locationId, leadId, contactId, userId, occurredAt = new Date() }) {
  const lead = await resolveComplianceLead(pool, { locationId, contactId:contactId || leadId });
  if (String(lead.assignedTo || '') !== String(userId || '')) {
    throw Object.assign(new Error('Lead is not assigned to this dialer user'), { status:403 });
  }
  const calendar = await reconcileScheduledAppointment(pool, {
    apiKeyId, lead, now:new Date(occurredAt),
  });
  let scheduledOverride = null;
  if (calendar.scheduled) {
    scheduledOverride = await findActiveScheduledOverride(pool, locationId, lead.id);
    if (!scheduledOverride) throw scheduledAppointmentError(calendar.appointment);
  }
  if (lead.dncStatus !== 'clean') {
    throw Object.assign(new Error('Lead does not have a clean DNC result'), { status:409, code:'DNC_CLEARANCE_REQUIRED' });
  }
  const integrations = await grantedIntegrationsForLeads(pool, apiKeyId, locationId, [lead.id]);
  const decision = await evaluateLead(pool, { lead, integration:integrations.get(String(lead.id)), userId, now:new Date(occurredAt) });
  if (!decision.allowed) throw complianceError(decision);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM leads WHERE id=? AND locationId=? FOR UPDATE', [lead.id, locationId]);
    let consumedOverride = null;
    if (calendar.scheduled) {
      consumedOverride = await consumeScheduledOverride(conn, locationId, lead.id);
      if (!consumedOverride) {
        await conn.rollback();
        throw scheduledAppointmentError(calendar.appointment);
      }
    }
    if (decision.stateCode === 'FL') {
      const stats = await attemptStats(conn, lead.id, new Date(occurredAt));
      if (stats.total >= FLORIDA_MAX_ATTEMPTS_24H) {
        await conn.rollback();
        const nextEligibleAt = stats.oldest
          ? new Date(new Date(`${String(stats.oldest).replace(' ', 'T')}Z`).getTime() + 24 * 60 * 60 * 1000).toISOString()
          : null;
        throw complianceError({ ...decision, allowed:false, reason:'florida_attempt_limit', attempts24h:stats.total, nextEligibleAt });
      }
    }
    const id = crypto.randomUUID();
    await conn.query(
      `INSERT INTO lead_call_attempts
       (id,location_id,lead_id,user_id,integration_id,external_event_id,subject_key,occurred_at,direction,call_status,source)
       VALUES (?,?,?,?,?,?,?,?,?,?,'dialer')`,
      [id, locationId, lead.id, userId, null, `dialer:${id}`, String(lead.serviceType || 'general').slice(0,128),
        mysqlUtc(occurredAt), 'outbound', 'authorized']
    );
    await conn.commit();
    return {
      id, allowed:true, stateCode:decision.stateCode, timeZone:decision.timeZone,
      occurredAt:new Date(occurredAt).toISOString(),
      scheduledReleaseUsed:Boolean(consumedOverride),
    };
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally { conn.release(); }
}

function complianceError(decision) {
  return Object.assign(new Error('Lead is not eligible for an outbound marketing call'), {
    status:409, code:'MARKETING_COMPLIANCE_BLOCK', compliance:decision,
  });
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length); let cursor = 0;
  async function run() { while (cursor < values.length) { const index = cursor++; results[index] = await worker(values[index], index); } }
  await Promise.all(Array.from({ length:Math.min(limit, values.length) }, () => run()));
  return results;
}

function mysqlUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0,23).replace('T',' ');
}

module.exports = {
  COMPANY_START_HOUR,
  COMPANY_END_HOUR,
  FLORIDA_MAX_ATTEMPTS_24H,
  resolveLeadJurisdiction,
  evaluateMarketingWindow,
  outboundCalls,
  crmCallResult,
  crmCallUserId,
  fetchCrmCallAttempts,
  storeCrmAttempts,
  attemptStats,
  fetchTimeZoneByCoordinates,
  leadCoordinates,
  resolveCoordinateTimeZone,
  screenLeadCandidates,
  resolveComplianceLead,
  authorizeCallAttempt,
};
