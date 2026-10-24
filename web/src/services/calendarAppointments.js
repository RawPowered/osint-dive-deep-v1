const { isConfiguredCrmHost } = require('./crmOrigins');
const crypto = require('crypto');
const { integrationCredential, parseJson, LEADCONNECTOR_ORIGIN } = require('./crmIntegrations');
const { getPoolRule } = require('./leadPools');

const CALENDAR_VERSION = 'v3';
const CALENDAR_TIMEOUT_MS = 7000;
const CALENDAR_MAX_ATTEMPTS = 4;
const CALENDAR_MAX_BYTES = 2 * 1024 * 1024;
const CALENDAR_CACHE_SECONDS = 15;
const CALENDAR_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const CALENDAR_LOOKAHEAD_MS = 400 * 24 * 60 * 60 * 1000;
const ACTIVE_APPOINTMENT_STATUSES = new Set(['scheduled', 'confirmed', 'new', 'showed', 'noshow']);
const INACTIVE_APPOINTMENT_STATUSES = new Set(['cancelled', 'canceled', 'invalid', 'deleted']);
const SCHEDULED_RESTRICTION = 'APPOINTMENT_ALREADY_SCHEDULED';

function clean(value, limit = 191) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, limit) : null;
}

function record(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

function firstValue(value, paths) {
  for (const path of paths) {
    const candidate = path.split('.').reduce((current, key) => current == null ? undefined : current[key], value);
    if (candidate != null && String(candidate).trim()) return String(candidate).trim();
  }
  return null;
}

function eventDate(value) {
  if (value && typeof value === 'object') {
    value = value.dateTime || value.date || value.$date || value.value || value.iso || null;
  }
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value || ''))) {
    const number = Number(value);
    return new Date(number < 1e12 ? number * 1000 : number);
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(String(value || ''))) {
    value = `${String(value).replace(' ', 'T')}Z`;
  }
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizedEventStatus(event) {
  return String(event?.appointmentStatus || event?.status || 'scheduled')
    .trim().toLowerCase().replace(/[\s-]+/g, '_').slice(0, 64);
}

function isActiveCalendarEvent(event, contactId, now = new Date()) {
  if (!event || clean(event.contactId) !== clean(contactId)) return false;
  const status = normalizedEventStatus(event);
  if (INACTIVE_APPOINTMENT_STATUSES.has(status)) return false;
  const start = eventDate(event.startTime || event.start || event.appointmentDate);
  if (!start || start.getTime() < now.getTime() - CALENDAR_LOOKBACK_MS) return false;
  return ACTIVE_APPOINTMENT_STATUSES.has(status) || !status;
}

function calendarEvents(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.events)) return body.events;
  if (Array.isArray(body?.data?.events)) return body.data.events;
  return [];
}

function calendarPath(integration) {
  const config = parseJson(integration.config_json);
  if (config.calendarEventsPath) return String(config.calendarEventsPath);
  const base = new URL(integration.base_url);
  if (base.origin === LEADCONNECTOR_ORIGIN) return '/calendars/events';
  if (isConfiguredCrmHost(base.hostname)) {
    return '/backend/calendars/events';
  }
  throw calendarUnavailable('CRM integration does not define a calendar-events adapter');
}

function calendarRequestUrl(integration, calendarId, now = new Date()) {
  const path = calendarPath(integration);
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${integration.base_url}/`);
  if (url.origin !== new URL(integration.base_url).origin) throw new Error('Calendar path must remain on the configured CRM origin');
  url.searchParams.set('locationId', integration.location_id);
  url.searchParams.set('calendarId', calendarId);
  url.searchParams.set('startTime', String(now.getTime() - CALENDAR_LOOKBACK_MS));
  url.searchParams.set('endTime', String(now.getTime() + CALENDAR_LOOKAHEAD_MS));
  return url;
}

function retryAfterDate(response, now = new Date()) {
  const raw = response.headers.get('retry-after');
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return new Date(now.getTime() + Math.min(Math.max(seconds, 1), 300) * 1000);
  const date = new Date(raw || 0);
  return Number.isFinite(date.getTime()) && date > now ? date : new Date(now.getTime() + 60000);
}

async function waitForCalendarRetry(response, attempt) {
  const raw = String(response.headers.get('retry-after') || '').trim();
  const seconds = raw ? Number(raw) : NaN;
  const dateDelay = raw && !Number.isFinite(seconds) ? Date.parse(raw) - Date.now() : NaN;
  const headerDelay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : dateDelay;
  const fallbackDelay = (2 ** attempt) * 1000;
  const delay = Math.min(Math.max(Number.isFinite(headerDelay) ? headerDelay : fallbackDelay, 100), 10000);
  const jitter = Math.floor(Math.random() * 251);
  await new Promise((resolve) => setTimeout(resolve, delay + jitter));
}

async function fetchCalendarEvents(integration, calendarId, now = new Date(), fetchImpl = fetch,
  waitImpl = waitForCalendarRetry) {
  let credential;
  try { credential = integrationCredential(integration); }
  catch { throw calendarUnavailable('CRM calendar credential could not be decrypted'); }
  if (!credential) throw calendarUnavailable('CRM calendar credential is unavailable');
  const config = parseJson(integration.config_json);
  let response;
  for (let attempt = 1; attempt <= CALENDAR_MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await fetchImpl(calendarRequestUrl(integration, calendarId, now), {
        headers:{
          Accept:'application/json',
          Authorization:`${integration.auth_scheme || 'Bearer'} ${credential}`.trim(),
          Version:String(config.calendarVersion || CALENDAR_VERSION),
        },
        redirect:'error', signal:AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
      });
    } catch (error) {
      if (error?.code === 'CALENDAR_VERIFICATION_UNAVAILABLE') throw error;
      throw calendarUnavailable('CRM calendar request could not be completed');
    }
    if (response.status !== 429) break;
    if (attempt < CALENDAR_MAX_ATTEMPTS) {
      await waitImpl(response, attempt);
      continue;
    }
    const retryAt = retryAfterDate(response, now);
    throw calendarUnavailable('CRM calendar rate limit reached after retrying', retryAt, 'CALENDAR_RATE_LIMITED');
  }
  if (!response.ok) throw calendarUnavailable(`CRM calendar request failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CALENDAR_MAX_BYTES) throw calendarUnavailable('CRM calendar response exceeded its size limit');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > CALENDAR_MAX_BYTES) throw calendarUnavailable('CRM calendar response exceeded its size limit');
  try { return calendarEvents(JSON.parse(text)); }
  catch { throw calendarUnavailable('CRM calendar returned invalid JSON'); }
}

function calendarUnavailable(message, retryAt = null, code = 'CALENDAR_VERIFICATION_UNAVAILABLE') {
  return Object.assign(new Error(message), {
    status:503, code,
    compliance:{ reason:'calendar_verification_unavailable', nextEligibleAt:retryAt?.toISOString() || undefined },
  });
}

async function integrationForLead(pool, apiKeyId, lead) {
  const [rows] = await pool.query(
    `SELECT sl.external_record_id,i.* FROM lead_source_links sl
     INNER JOIN crm_integrations i ON i.id=sl.integration_id AND i.is_enabled=1
     INNER JOIN crm_integration_grants g ON g.integration_id=i.id
     WHERE sl.location_id=? AND sl.lead_id=? AND g.api_key_id=? AND g.allow_read=1
     ORDER BY CASE WHEN i.provider='leadconnector-pit' THEN 0 WHEN i.provider='nova-edge' THEN 1 ELSE 2 END LIMIT 1`,
    [lead.locationId, lead.id, apiKeyId]
  );
  return rows[0] || null;
}

async function currentLocalAppointment(pool, lead, now = new Date()) {
  const cutoff = mysqlUtc(new Date(now.getTime() - CALENDAR_LOOKBACK_MS));
  const [rows] = await pool.query(
    `SELECT id,calendarId,appointmentDate,status,source,externalEventId FROM appointments
     WHERE locationId=? AND leadId=? AND source='divedeep' AND status IN ('scheduled','confirmed','new')
       AND (appointmentDate IS NULL OR appointmentDate>=?)
     ORDER BY appointmentDate ASC,createdAt DESC LIMIT 1`,
    [lead.locationId, lead.id, cutoff]
  );
  return rows[0] ? publicAppointment(rows[0]) : null;
}

function calendarServiceKey(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (/\bkitchen\b/.test(text)) return 'kitchen';
  if (/\bbath(?:room)?\b/.test(text)) return 'bathroom';
  if (/\b(?:roof|roofing|shingle|siding)\b/.test(text)) return 'roofing';
  if (/\b(?:mold|water\s+damage|flood|leak\s+repair)\b/.test(text)) return 'mold';
  if (/\bsolar\b|\bpanel\s+upgrade\b/.test(text)) return 'solar';
  if (/\b(?:home\s+)?addition\b|\bhome\s+(?:remodel|renovat)|\bremodel\b|\brenovat/.test(text)) return 'home_addition';
  if (/\bother\b/.test(text)) return 'other';
  return text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null;
}

function parseCalendarPoolRow(row, requestedServiceType, matchMode) {
  if (!row) return null;
  let calendarIds = [];
  try {
    calendarIds = Array.isArray(row.calendar_ids_json)
      ? row.calendar_ids_json
      : JSON.parse(row.calendar_ids_json || '[]');
  } catch { calendarIds = []; }
  calendarIds = [...new Set(calendarIds.map((item) => clean(item)).filter(Boolean))];
  const defaultCalendarId = clean(row.default_calendar_id);
  // A valid default is authoritative even if an older row failed to mirror it into calendar_ids_json.
  if (defaultCalendarId && !calendarIds.includes(defaultCalendarId)) calendarIds.unshift(defaultCalendarId);
  return {
    calendarIds,
    defaultCalendarId:defaultCalendarId || calendarIds[0] || null,
    configuredServiceType:clean(row.service_type, 128) || clean(requestedServiceType, 128),
    requestedServiceType:clean(requestedServiceType, 128),
    matchMode,
  };
}

async function configuredServicePool(pool, locationId, serviceType) {
  // Preserve the fast exact lookup first.
  const [exactRows] = await pool.query(
    `SELECT service_type,tag_keywords_json,calendar_ids_json,default_calendar_id FROM owl_service_pools
     WHERE source_slug='core' AND location_id=? AND service_type=? AND is_enabled=1 LIMIT 1`,
    [locationId, serviceType]
  );
  const exact = parseCalendarPoolRow(exactRows[0], serviceType, 'exact');
  if (exact?.calendarIds?.length) return exact;

  // OWL service names are editable display values, while HAWK routes with canonical pool keys.
  // Resolve through the complete enabled Core catalog so aliases such as Kitchen Remodel,
  // Home Addition, and Mold / Water Damage use the same calendar record the OWL UI shows.
  const [rows] = await pool.query(
    `SELECT service_type,tag_keywords_json,calendar_ids_json,default_calendar_id FROM owl_service_pools
     WHERE source_slug='core' AND location_id=? AND is_enabled=1
     ORDER BY sort_order,service_type`,
    [locationId]
  );
  const requestedKey = calendarServiceKey(serviceType);
  const byService = rows.find((row) => calendarServiceKey(row.service_type) === requestedKey);
  if (byService) return parseCalendarPoolRow(byService, serviceType, 'canonical_service');

  const byKeyword = rows.find((row) => {
    let keywords = [];
    try { keywords = Array.isArray(row.tag_keywords_json) ? row.tag_keywords_json : JSON.parse(row.tag_keywords_json || '[]'); }
    catch { keywords = []; }
    return keywords.some((keyword) => calendarServiceKey(keyword) === requestedKey);
  });
  if (byKeyword) return parseCalendarPoolRow(byKeyword, serviceType, 'canonical_keyword');
  return exact;
}

async function cachedCalendarResult(pool, lead, now = new Date()) {
  const [rows] = await pool.query(
    `SELECT result,external_event_id,retry_after_at,last_error_code,last_checked_at
     FROM lead_calendar_sync_state WHERE location_id=? AND lead_id=? LIMIT 1`,
    [lead.locationId, lead.id]
  );
  const state = rows[0];
  if (!state) return null;
  const retryAt = eventDate(state.retry_after_at);
  if (retryAt && retryAt > now) throw calendarUnavailable('CRM calendar retry window is still active', retryAt, state.last_error_code || 'CALENDAR_RATE_LIMITED');
  const checkedAt = eventDate(state.last_checked_at);
  if (!checkedAt || now.getTime() - checkedAt.getTime() >= CALENDAR_CACHE_SECONDS * 1000) return null;
  if (state.result === 'clear') return { checked:true, scheduled:false, cached:true };
  if (state.result !== 'scheduled' || !state.external_event_id) return null;
  const [appointments] = await pool.query(
    `SELECT id,calendarId,appointmentDate,status,source,externalEventId FROM appointments
     WHERE locationId=? AND externalEventId=? LIMIT 1`,
    [lead.locationId, state.external_event_id]
  );
  return appointments[0]
    ? { checked:true, scheduled:true, cached:true, appointment:publicAppointment(appointments[0]) }
    : null;
}

async function saveSyncState(pool, lead, integrationId, result, eventId = null, error = null) {
  const retryAfter = error?.compliance?.nextEligibleAt
    ? mysqlUtc(new Date(error.compliance.nextEligibleAt)) : null;
  await pool.query(
    `INSERT INTO lead_calendar_sync_state
       (location_id,lead_id,integration_id,result,external_event_id,last_checked_at,retry_after_at,last_error_code)
     VALUES (?,?,?,?,?,UTC_TIMESTAMP(3),?,?)
     ON DUPLICATE KEY UPDATE integration_id=VALUES(integration_id),result=VALUES(result),
       external_event_id=VALUES(external_event_id),last_checked_at=VALUES(last_checked_at),
       retry_after_at=VALUES(retry_after_at),last_error_code=VALUES(last_error_code)`,
    [lead.locationId, lead.id, integrationId, result, eventId, retryAfter, error?.code || null]
  );
}

async function persistCalendarMatch(pool, lead, integration, event, contactId) {
  const eventId = clean(event.id || event.eventId);
  if (!eventId) throw calendarUnavailable('CRM calendar event is missing its event ID');
  const start = eventDate(event.startTime || event.start || event.appointmentDate);
  if (!start) throw calendarUnavailable('CRM calendar event is missing a valid start time');
  const status = normalizedEventStatus(event) || 'scheduled';
  const calendarId = clean(event.calendarId);
  const userId = clean(lead.assignedTo || event.assignedUserId, 128);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO appointments
         (locationId,leadId,userId,calendarId,externalEventId,externalContactId,source,appointmentDate,status,syncedAt)
       VALUES (?,?,?,?,?,?,'crm_calendar',?,?,UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE leadId=VALUES(leadId),userId=VALUES(userId),calendarId=VALUES(calendarId),
         externalContactId=VALUES(externalContactId),appointmentDate=VALUES(appointmentDate),
         status=VALUES(status),source='crm_calendar',syncedAt=UTC_TIMESTAMP()`,
      [lead.locationId, lead.id, userId, calendarId, eventId, contactId, mysqlUtc(start), status]
    );
    const scheduled = await getPoolRule(conn, 'core', lead.locationId, 'scheduled');
    const destination = scheduled?.destinationStatus || 'appointment';
    if (scheduled?.assignmentPolicy === 'clear') {
      await conn.query('UPDATE leads SET status=?,assignedTo=NULL WHERE id=? AND locationId=?', [destination, lead.id, lead.locationId]);
    } else if (scheduled?.assignmentPolicy === 'require_user' && userId) {
      await conn.query('UPDATE leads SET status=?,assignedTo=? WHERE id=? AND locationId=?', [destination, userId, lead.id, lead.locationId]);
    } else {
      await conn.query('UPDATE leads SET status=? WHERE id=? AND locationId=?', [destination, lead.id, lead.locationId]);
    }
    await saveSyncState(conn, lead, integration.id, 'scheduled', eventId);
    await conn.commit();
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally { conn.release(); }
  return publicAppointment({ calendarId, appointmentDate:start, status, source:'crm_calendar', externalEventId:eventId });
}

async function reconcileScheduledAppointment(pool, { apiKeyId, lead, now = new Date(), force = false, fetchImpl = fetch }) {
  const local = await currentLocalAppointment(pool, lead, now);
  if (local) return { checked:true, scheduled:true, source:'divedeep', appointment:local };
  const service = await configuredServicePool(pool, lead.locationId, lead.serviceType);
  if (!service?.calendarIds?.length) return { checked:false, scheduled:false, reason:'calendar_not_configured', serviceLookup:service || { requestedServiceType:clean(lead.serviceType, 128) } };
  if (!force) {
    const cached = await cachedCalendarResult(pool, lead, now);
    if (cached) return cached;
  }
  const integration = await integrationForLead(pool, apiKeyId, lead);
  if (!integration) throw calendarUnavailable('No granted CRM integration can verify this service calendar');
  const contactId = clean(integration.external_record_id);
  if (!contactId) throw calendarUnavailable('Lead does not have a CRM contact ID for calendar verification');
  try {
    const orderedCalendars = [service.defaultCalendarId, ...service.calendarIds]
      .filter((value, index, values) => value && values.indexOf(value) === index);
    const primaryEvents = await fetchCalendarEvents(integration, orderedCalendars[0], now, fetchImpl);
    let match = primaryEvents.find((event) => isActiveCalendarEvent(event, contactId, now));
    if (!match && orderedCalendars.length > 1) {
      const secondary = await mapLimit(orderedCalendars.slice(1), 3, async (calendarId) => {
        try { return { events:await fetchCalendarEvents(integration, calendarId, now, fetchImpl) }; }
        catch (error) { return { error }; }
      });
      match = secondary.flatMap((item) => item.events || [])
        .find((event) => isActiveCalendarEvent(event, contactId, now));
      if (!match) {
        const failed = secondary.find((item) => item.error);
        if (failed) throw failed.error;
      }
    }
    if (match) {
      const appointment = await persistCalendarMatch(pool, lead, integration, match, contactId);
      return { checked:true, scheduled:true, source:'crm_calendar', appointment };
    }
    const [cleared] = await pool.query(
      `UPDATE appointments SET status='not_found',syncedAt=UTC_TIMESTAMP()
       WHERE locationId=? AND leadId=? AND source='crm_calendar'
         AND status IN ('scheduled','confirmed','new') AND appointmentDate>=?`,
      [lead.locationId, lead.id, mysqlUtc(new Date(now.getTime() - CALENDAR_LOOKBACK_MS))]
    );
    if (Number(cleared?.affectedRows) > 0) await routeClearedAppointment(pool, lead);
    await saveSyncState(pool, lead, integration.id, 'clear');
    return { checked:true, scheduled:false, source:'crm_calendar' };
  } catch (error) {
    await saveSyncState(pool, lead, integration.id, 'error', null, error).catch(() => {});
    throw error;
  }
}

function publicAppointment(row) {
  const start = eventDate(row.appointmentDate);
  return {
    calendarId:clean(row.calendarId),
    startTime:start?.toISOString() || null,
    status:normalizedEventStatus(row),
    source:clean(row.source, 32) || 'divedeep',
  };
}

function scheduledAppointmentError(appointment) {
  return Object.assign(new Error('Contact already has a scheduled appointment'), {
    status:409, code:SCHEDULED_RESTRICTION,
    compliance:{ reason:'appointment_scheduled', appointment },
  });
}

async function findActiveScheduledOverride(pool, locationId, leadId, lock = false) {
  const [rows] = await pool.query(
    `SELECT id,remaining_uses,expires_at,reason FROM lead_call_restriction_overrides
     WHERE location_id=? AND lead_id=? AND restriction_code=? AND revoked_at IS NULL
       AND expires_at>UTC_TIMESTAMP(3) AND remaining_uses>0
     ORDER BY created_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [locationId, leadId, SCHEDULED_RESTRICTION]
  );
  return rows[0] || null;
}

async function consumeScheduledOverride(conn, locationId, leadId) {
  const override = await findActiveScheduledOverride(conn, locationId, leadId, true);
  if (!override) return null;
  await conn.query(
    `UPDATE lead_call_restriction_overrides SET remaining_uses=remaining_uses-1,
       consumed_at=IF(remaining_uses=1,UTC_TIMESTAMP(3),consumed_at) WHERE id=?`,
    [override.id]
  );
  return override;
}

async function createScheduledCallRelease(pool, input) {
  const locationId = clean(input.locationId, 128);
  const leadId = clean(input.leadId, 128);
  const reason = clean(input.reason, 255);
  const minutes = Math.trunc(Math.min(Math.max(Number(input.minutes) || 30, 1), 1440));
  const uses = Math.trunc(Math.min(Math.max(Number(input.uses) || 1, 1), 5));
  if (!locationId || !leadId) throw Object.assign(new Error('locationId and leadId are required'), { status:400 });
  if (!reason || reason.length < 10) throw Object.assign(new Error('Release reason must be at least 10 characters'), { status:400 });
  const [leads] = await pool.query('SELECT id FROM leads WHERE locationId=? AND id=? LIMIT 1', [locationId, leadId]);
  if (!leads[0]) throw Object.assign(new Error('Lead not found'), { status:404 });
  const [appointments] = await pool.query(
    `SELECT id FROM appointments WHERE locationId=? AND leadId=?
       AND status IN ('scheduled','confirmed','new') AND (appointmentDate IS NULL OR appointmentDate>=UTC_TIMESTAMP()-INTERVAL 2 HOUR)
     LIMIT 1`,
    [locationId, leadId]
  );
  if (!appointments[0]) {
    throw Object.assign(new Error('Lead does not have an active scheduled appointment restriction'), { status:409 });
  }
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO lead_call_restriction_overrides
       (id,location_id,lead_id,restriction_code,reason,remaining_uses,expires_at,created_by_admin_id,created_by_username)
     VALUES (?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? MINUTE),?,?)`,
    [id, locationId, leadId, SCHEDULED_RESTRICTION, reason, uses, minutes,
      clean(input.adminId, 64), clean(input.adminUsername, 128)]
  );
  return { id, locationId, leadId, restrictionCode:SCHEDULED_RESTRICTION, minutes, remainingUses:uses };
}

async function routeClearedAppointment(pool, lead) {
  const scheduled = await getPoolRule(pool, 'core', lead.locationId, 'scheduled');
  const available = await getPoolRule(pool, 'core', lead.locationId, 'available');
  const scheduledStatus = scheduled?.destinationStatus || 'appointment';
  const availableStatus = available?.destinationStatus || 'uncontacted';
  if (available?.assignmentPolicy === 'clear' || !available) {
    await pool.query(
      'UPDATE leads SET status=?,assignedTo=NULL WHERE id=? AND locationId=? AND status=?',
      [availableStatus, lead.id, lead.locationId, scheduledStatus]
    );
  } else {
    await pool.query(
      'UPDATE leads SET status=? WHERE id=? AND locationId=? AND status=?',
      [availableStatus, lead.id, lead.locationId, scheduledStatus]
    );
  }
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function run() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length:Math.min(limit, values.length) }, () => run()));
  return results;
}

async function bookingContext(pool, { apiKeyId, locationId, contactId, userId }) {
  const [links] = await pool.query(
    `SELECT sl.lead_id,sl.external_record_id FROM lead_source_links sl
     INNER JOIN crm_integrations i ON i.id=sl.integration_id AND i.is_enabled=1
     INNER JOIN crm_integration_grants g ON g.integration_id=i.id
     WHERE sl.location_id=? AND (sl.external_record_id=? OR sl.lead_id=?) AND g.api_key_id=? AND g.allow_read=1
     ORDER BY sl.last_seen_at DESC LIMIT 1`,
    [locationId, contactId, contactId, apiKeyId]
  );
  const leadId = links[0]?.lead_id || contactId;
  const [leads] = await pool.query(
    'SELECT id,locationId,serviceType,contactData,assignedTo FROM leads WHERE id=? AND locationId=? LIMIT 1',
    [leadId, locationId]
  );
  const lead = leads[0];
  if (!lead) throw Object.assign(new Error('Contact is not available in the Dialer'), { status:404 });
  if (String(lead.assignedTo || '') !== String(userId || '')) {
    throw Object.assign(new Error('Lead is not assigned to this dialer user'), { status:403 });
  }
  const [crmRows] = await pool.query(
    `SELECT payload_json FROM crm_contact_records WHERE location_id=? AND (lead_id=? OR external_record_id=?)
     AND is_current=1 ORDER BY last_seen_at DESC LIMIT 1`,
    [locationId, lead.id, links[0]?.external_record_id || contactId]
  );
  const localData = record(lead.contactData);
  const crmData = record(crmRows[0]?.payload_json);
  const data = { ...localData, ...crmData, contact:{ ...record(localData.contact), ...record(crmData.contact) } };
  const service = await configuredServicePool(pool, locationId, lead.serviceType);
  const fields = {
    firstName:firstValue(data, ['firstName','first_name','contact.firstName','contact.first_name']),
    lastName:firstValue(data, ['lastName','last_name','contact.lastName','contact.last_name']),
    name:firstValue(data, ['name','fullName','contact.name']),
    email:firstValue(data, ['email','contact.email']),
    phone:firstValue(data, ['phone','phoneNumber','mobile','contact.phone','contact.mobile']),
  };
  if (!fields.name) fields.name = [fields.firstName, fields.lastName].filter(Boolean).join(' ') || null;
  return {
    leadId:lead.id,
    contactId:links[0]?.external_record_id || contactId,
    locationId,
    serviceType:lead.serviceType,
    calendarIds:service?.calendarIds || [],
    defaultCalendarId:service?.defaultCalendarId || null,
    fields,
    queryParams:{
      first_name:fields.firstName, last_name:fields.lastName, name:fields.name,
      email:fields.email, phone:fields.phone, contactId:links[0]?.external_record_id || contactId,
    },
  };
}

function mysqlUtc(value) {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  CALENDAR_VERSION,
  SCHEDULED_RESTRICTION,
  eventDate,
  normalizedEventStatus,
  isActiveCalendarEvent,
  calendarRequestUrl,
  fetchCalendarEvents,
  reconcileScheduledAppointment,
  scheduledAppointmentError,
  findActiveScheduledOverride,
  consumeScheduledOverride,
  createScheduledCallRelease,
  bookingContext,
};
