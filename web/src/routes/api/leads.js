const express = require('express');
const { getInstanceIdentity } = require('../../instanceIdentity');
const { getPool } = require('../../db/pool');
const {
  findRuleForStatus,
  getPoolRule,
  listPoolRules,
  assertDncAssignmentAllowed,
} = require('../../services/leadPools');
const crypto = require('crypto');
const {
  buildDncPulseUrl,
  fetchDncPulseUrlFromNotes,
  fetchLeadConnectorContact,
} = require('../../services/dncPulse');
const {
  classifyDncScreening,
  applyDncScreeningStatus,
  applyMarketingChannelStatus,
} = require('../../services/crmImporter');
const { assertWeeklyScheduleSubmitted } = require('../../services/dialerSchedules');
const { authorizeCallAttempt } = require('../../services/marketingCompliance');
const { requireOperatorSession } = require('../../services/operatorSessions');
const { bookingContext } = require('../../services/calendarAppointments');

const STATUS_RE = /^[a-z][a-z0-9_]{1,62}$/;

function createLeadManagementRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  router.get('/', async (req, res) => {
    try {
      const locationId = String(req.query.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_read', null, {
        allowLegacyRead: true,
      });
      const operator = await requireOperatorSession(req, { locationId });

      const where = ['l.locationId = ?', 'l.assignedTo = ?'];
      const params = [locationId, operator.userId];
      for (const [queryKey, column] of [
        ['serviceType', 'l.serviceType'],
        ['status', 'l.status'],
        ['dncStatus', 'l.dncStatus'],
        ['assignedTo', 'l.assignedTo'],
      ]) {
        if (req.query[queryKey] != null && String(req.query[queryKey]) !== '') {
          where.push(`${column} = ?`);
          params.push(String(req.query[queryKey]));
        }
      }
      if (req.query.search) {
        where.push('l.contactData LIKE ?');
        params.push(`%${String(req.query.search).slice(0, 128)}%`);
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT l.id, l.locationId, l.serviceType, l.status, l.contactData, l.assignedTo,
                l.lastContacted, l.dncStatus, l.dncCheckedAt, l.dateAdded
         FROM leads l WHERE ${where.join(' AND ')}
         ORDER BY l.dateAdded DESC, l.id ASC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const [totals] = await pool.query(
        `SELECT COUNT(*) AS total FROM leads l WHERE ${where.join(' AND ')}`,
        params
      );
      const enriched = await attachImportedData(rows, pool, req.apiKey.id);
      res.json({ success: true, leads: enriched, total: Number(totals[0].total), limit, offset });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Must stay before /:id so "assigned" is not interpreted as a lead ID.
  router.get('/assigned', async (req, res) => {
    try {
      const locationId = String(req.query.locationId || '').trim();
      const userId = String(req.query.userId || '').trim();
      if (!locationId || !userId) {
        return res.status(400).json({ error: 'locationId and userId are required' });
      }
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_read', null, {
        allowLegacyRead: true,
      });
      await requireOperatorSession(req, { locationId, userId });

      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT l.id, l.locationId, l.serviceType, l.status, l.contactData, l.assignedTo,
                l.lastContacted, l.dncStatus, l.dncCheckedAt, l.dateAdded
         FROM leads l
         WHERE l.locationId = ? AND l.assignedTo = ? AND l.status = 'assigned'
           AND l.dncStatus = 'clean'
         ORDER BY l.dateAdded ASC, l.id ASC LIMIT ? OFFSET ?`,
        [locationId, userId, limit, offset]
      );
      const [totals] = await pool.query(
        `SELECT COUNT(*) AS total FROM leads
         WHERE locationId = ? AND assignedTo = ? AND status = 'assigned'
           AND dncStatus = 'clean'`,
        [locationId, userId]
      );
      const enriched = await attachImportedData(rows, pool, req.apiKey.id);
      return res.json({
        success: true,
        leads: enriched,
        total: Number(totals[0].total),
        limit,
        offset,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // The preferred Dialer contract accepts only contactId; tenant and user come from its session.
  router.post('/booking-context', async (req, res) => {
    try {
      const pool = getPool();
      const suppliedLocationId = String(req.body?.locationId || '').trim();
      const suppliedUserId = String(req.body?.userId || '').trim();
      const operator = await requireOperatorSession(req, {
        locationId:suppliedLocationId || undefined,
        userId:suppliedUserId || undefined,
      }, pool);
      const contactId = String(req.body?.contactId || '').trim();
      if (!contactId) return res.status(400).json({ success:false, error:'contactId is required', code:'CONTACT_ID_REQUIRED' });
      req.sentinelApi = { action:'dialer.booking_context.read', entityType:'contact', entityId:contactId };
      await requireLocationGrant(req.apiKey.id, operator.locationId, 'allow_read', pool);
      const context = await bookingContext(pool, {
        apiKeyId:req.apiKey.id,
        locationId:String(operator.locationId),
        contactId,
        userId:String(operator.userId),
      });
      return res.json({ success:true, booking:context });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // The preferred Dialer contract accepts only contactId; tenant and user come from its session.
  router.post('/call-attempts/authorize', authorizeDialerCall);

  // Compatibility alias for clients that still put the contact ID in the URL.
  router.post('/:id/call-attempts/authorize', authorizeDialerCall);

  router.post('/:id/dnc-pulse', async (req, res) => {
    try {
      const { locationId, url } = req.body || {};
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads');
      const pool = getPool();
      const [leads] = await pool.query(
        'SELECT id, locationId FROM leads WHERE id = ? AND locationId = ? LIMIT 1',
        [req.params.id, locationId]
      );
      if (!leads[0]) return res.status(404).json({ error: 'Lead not found' });
      const source = await getGrantedLeadSource(pool, req.apiKey.id, req.params.id, locationId);
      const contactId = source?.external_record_id || req.params.id;
      const pulseUrl = url
        ? buildDncPulseUrl({ templateUrl: url, contactId, locationId })
        : await fetchDncPulseUrlFromNotes(source, contactId, String(locationId));
      await pool.query(
        `INSERT INTO dnc_pulse_events
           (id, api_key_id, lead_id, external_contact_id, location_id, action)
         VALUES (?, ?, ?, ?, ?, 'url_issued')`,
        [crypto.randomUUID(), req.apiKey.id, req.params.id, contactId, locationId]
      );
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.json({
        success: true,
        action: 'browser_navigation',
        leadId: req.params.id,
        contactId,
        locationId,
        url: pulseUrl,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/dnc-refresh', async (req, res) => {
    try {
      const { locationId } = req.body || {};
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads');
      const pool = getPool();
      const source = await getGrantedLeadSource(pool, req.apiKey.id, req.params.id, locationId);
      if (!source) return res.status(409).json({ error: 'Granted LeadConnector source link is unavailable for this lead' });
      const contact = await fetchLeadConnectorContact(source, source.external_record_id);
      if (contact.locationId && String(contact.locationId) !== String(locationId)) {
        return res.status(409).json({ error: 'LeadConnector contact location does not match the lead location' });
      }
      const screening = classifyDncScreening(contact);
      const rules = await listPoolRules(pool, 'core', String(locationId));
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await applyDncScreeningStatus(conn, req.params.id, String(locationId), screening, rules);
        await applyMarketingChannelStatus(conn, req.params.id, String(locationId), contact, rules);
        await conn.query(
          `INSERT INTO dnc_pulse_events
             (id, api_key_id, lead_id, external_contact_id, location_id, action)
           VALUES (?, ?, ?, ?, ?, 'status_refreshed')`,
          [crypto.randomUUID(), req.apiKey.id, req.params.id, source.external_record_id, locationId]
        );
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }
      const [rows] = await pool.query(
        'SELECT status, dncStatus, dncCheckedAt FROM leads WHERE id = ? AND locationId = ? LIMIT 1',
        [req.params.id, locationId]
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        success: true,
        leadId: req.params.id,
        contactId: source.external_record_id,
        dncStatus: rows[0]?.dncStatus || screening.state,
        lifecycleStatus: rows[0]?.status || null,
        dncCheckedAt: rows[0]?.dncCheckedAt || null,
        matchedTags: screening.tags.filter((tag) => tag.startsWith('dnc') || tag === 'dnd'),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const locationId = String(req.query.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_read', null, {
        allowLegacyRead: true,
      });
      const operator = await requireOperatorSession(req, { locationId });
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id, locationId, serviceType, status, contactData, assignedTo,
                lastContacted, dncStatus, dncCheckedAt, dateAdded
         FROM leads WHERE id = ? AND locationId = ? AND assignedTo = ? LIMIT 1`,
        [req.params.id, locationId, operator.userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Lead not found' });
      const leads = await attachImportedData(rows, pool, req.apiKey.id);
      res.json({ success: true, lead: leads[0] });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/:id/status', async (req, res) => {
    try {
      const { locationId, status, lastContacted } = req.body || {};
      const normalizedStatus = String(status || '').trim().toLowerCase();
      if (!locationId || !STATUS_RE.test(normalizedStatus)) {
        return res.status(400).json({ error: 'Valid locationId and status are required' });
      }
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_manage_leads');
      const operator = await requireOperatorSession(req, { locationId });
      const pool = getPool();
      const rule = await findRuleForStatus(pool, 'core', locationId, normalizedStatus);
      if (!rule || !rule.isEnabled) {
        return res.status(400).json({ error: 'Status is not routed to an enabled lead pool' });
      }
      const [current] = await pool.query(
        'SELECT id, status, dncStatus FROM leads WHERE id = ? AND locationId = ? AND assignedTo = ? LIMIT 1',
        [req.params.id, locationId, operator.userId]
      );
      if (!current[0]) return res.status(404).json({ error: 'Lead not found' });
      const rules = await listPoolRules(pool, 'core', locationId);
      assertDncAssignmentAllowed(current, rule, rules);
      const assignmentSql = rule && rule.assignmentPolicy === 'clear'
        ? 'assignedTo = NULL'
        : 'assignedTo = COALESCE(?, assignedTo)';
      const params = [normalizedStatus];
      if (!rule || rule.assignmentPolicy !== 'clear') params.push(operator.userId);
      params.push(normalizeDateTime(lastContacted), req.params.id, locationId, operator.userId);
      const [result] = await pool.query(
        `UPDATE leads SET status = ?, ${assignmentSql},
           lastContacted = COALESCE(?, lastContacted)
         WHERE id = ? AND locationId = ? AND assignedTo = ?`,
        params
      );
      if (!result.affectedRows) return res.status(404).json({ error: 'Lead not found' });
      res.json({ success: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/release', async (req, res) => {
    try {
      const { locationId } = req.body || {};
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_manage_leads');
      const operator = await requireOperatorSession(req, { locationId });
      const pool = getPool();
      const availableRule = await getPoolRule(pool, 'core', locationId, 'available');
      const availableStatus = availableRule ? availableRule.destinationStatus : 'uncontacted';
      const [result] = await pool.query(
        `UPDATE leads SET status = ?, assignedTo = NULL
         WHERE id = ? AND locationId = ? AND assignedTo = ?`,
        [availableStatus, req.params.id, locationId, operator.userId]
      );
      if (!result.affectedRows) return res.status(404).json({ error: 'Lead not found' });
      res.json({ success: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

async function authorizeDialerCall(req, res) {
  try {
    const pool = getPool();
    const suppliedLocationId = String(req.body?.locationId || '').trim();
    const suppliedUserId = String(req.body?.userId || '').trim();
    const operator = await requireOperatorSession(req, {
      locationId:suppliedLocationId || undefined,
      userId:suppliedUserId || undefined,
    }, pool);
    const locationId = String(operator.locationId);
    const userId = String(operator.userId);
    const contactId = String(req.body?.contactId || req.params?.id || '').trim();
    if (!contactId) {
      return res.status(400).json({
        success:false, error:'contactId is required', code:'CONTACT_ID_REQUIRED',
      });
    }
    req.sentinelApi = { action:'dialer.call.authorize', entityType:'contact', entityId:contactId };
    await requireLocationGrant(req.apiKey.id, locationId, 'allow_manage_leads', pool);
    await assertWeeklyScheduleSubmitted(pool, { locationId, userId });
    const attempt = await authorizeCallAttempt(pool, {
      apiKeyId:req.apiKey.id, locationId, contactId, userId,
    });
    return res.status(201).json({
      success:true,
      authorizationId:attempt.id,
      allowed:true,
      scheduledReleaseUsed:attempt.scheduledReleaseUsed || undefined,
    });
  } catch (error) {
    const compliance = error.compliance || null;
    if (error.status === 503 && compliance?.nextEligibleAt) {
      const seconds = Math.max(1, Math.ceil((new Date(compliance.nextEligibleAt).getTime() - Date.now()) / 1000));
      if (Number.isFinite(seconds)) res.setHeader('Retry-After', String(seconds));
    }
    return res.status(error.status || 500).json({
      success:false,
      error:error.status === 409 ? 'Call not authorized'
        : error.status === 503 ? 'Calendar verification unavailable'
          : (error.message || 'Call authorization failed'),
      code:error.code || 'CALL_AUTHORIZATION_FAILED',
      reason:compliance?.reason || undefined,
      nextEligibleAt:compliance?.nextEligibleAt || undefined,
      appointment:compliance?.appointment || undefined,
    });
  }
}

async function requireLocationGrant(apiKeyId, locationId, permission, pool = null, options = {}) {
  const p = pool || getPool();
  const allowed = new Set(['allow_read', 'allow_manage_leads']);
  if (!allowed.has(permission)) throw new Error('Invalid lead permission');
  const [rows] = await p.query(
    `SELECT COUNT(DISTINCT i.id) AS integration_count,
            COUNT(DISTINCT CASE
              WHEN i.is_enabled = 1 AND g.api_key_id = ? AND g.${permission} = 1 THEN i.id
              ELSE NULL
            END) AS grant_count
     FROM crm_integrations i
     LEFT JOIN crm_integration_grants g ON g.integration_id = i.id
     WHERE i.location_id = ?`,
    [apiKeyId, locationId]
  );
  const integrationCount = Number(rows[0] && rows[0].integration_count) || 0;
  const grantCount = Number(rows[0] && rows[0].grant_count) || 0;
  if (grantCount > 0) return 'granted';
  if (options.allowLegacyRead && permission === 'allow_read' && integrationCount === 0) {
    return 'legacy';
  }
  throw Object.assign(new Error('Lead location access denied'), { status: 403 });
}

async function attachImportedData(rows, pool, apiKeyId = null) {
  const contactIds = new Map();
  const leadIds = [...new Set(rows.map((row) => cleanText(row?.id)).filter(Boolean))];
  if (apiKeyId && leadIds.length) {
    const placeholders = leadIds.map(() => '?').join(',');
    const [links] = await pool.query(
      `SELECT sl.lead_id, sl.external_record_id
       FROM lead_source_links sl
       INNER JOIN crm_integrations i ON i.id = sl.integration_id AND i.is_enabled = 1
       INNER JOIN crm_integration_grants g ON g.integration_id = i.id
       WHERE g.api_key_id = ? AND (g.allow_read = 1 OR g.allow_manage_leads = 1)
         AND sl.lead_id IN (${placeholders})
       ORDER BY sl.first_seen_at ASC`,
      [apiKeyId, ...leadIds]
    );
    for (const link of links) {
      const leadId = cleanText(link?.lead_id);
      const contactId = cleanText(link?.external_record_id);
      if (leadId && contactId && !contactIds.has(leadId)) contactIds.set(leadId, contactId);
    }
  }
  return rows.map((row) => serializeDialerLead({
    ...row,
    contactId: contactIds.get(cleanText(row?.id)) || cleanText(row?.contactId),
  }));
}

function serializeDialerLead(row) {
  const parsed = safeParse(row?.contactData);
  const contact = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const fullName = cleanText(firstValue(contact, ['name', 'contactName', 'fullName']));
  const nameParts = fullName ? fullName.split(/\s+/) : [];
  return {
    leadId:cleanText(row?.id),
    contactId:cleanText(row?.contactId),
    firstName:cleanText(firstValue(contact, ['firstName', 'first_name'])) || nameParts[0] || null,
    lastName:cleanText(firstValue(contact, ['lastName', 'last_name'])) || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : null),
    phone:cleanText(firstValue(contact, ['phone', 'phoneNumber', 'phone_number', 'primaryPhone'])),
    city:cleanText(firstValue(contact, ['city', 'address.city'])),
    state:cleanText(firstValue(contact, ['state', 'address.state'])),
    latitude:coordinate(firstValue(contact, ['latitude', 'lat', 'geo.latitude', 'location.latitude', 'address.latitude']), -90, 90),
    longitude:coordinate(firstValue(contact, ['longitude', 'lng', 'lon', 'long', 'geo.longitude', 'location.longitude', 'address.longitude']), -180, 180),
  };
}

function firstValue(object, paths) {
  for (const path of paths) {
    const value = String(path).split('.').reduce((current, key) => current == null ? undefined : current[key], object);
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function cleanText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 255) : null;
}

function coordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function safeParse(value) {
  if (value == null || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ');
}

async function getGrantedLeadSource(pool, apiKeyId, leadId, locationId) {
  const [sources] = await pool.query(
    `SELECT sl.external_record_id, i.* FROM lead_source_links sl
     INNER JOIN crm_integrations i ON i.id = sl.integration_id
     INNER JOIN crm_integration_grants g ON g.integration_id = i.id
     WHERE sl.lead_id = ? AND sl.location_id = ?
       AND g.api_key_id = ? AND g.allow_manage_leads = 1 AND i.is_enabled = 1
     ORDER BY CASE WHEN i.provider = 'leadconnector-pit' THEN 0 ELSE 1 END, sl.first_seen_at
     LIMIT 1`,
    [leadId, locationId, apiKeyId]
  );
  return sources[0] || null;
}

function sendError(res, error) {
  const body = {
    error: error.message || 'Lead operation failed',
    code: error.code || undefined,
  };
  if (String(error.code || '').startsWith('OPERATOR_SESSION_')) {
    body.authentication = {
      loginEndpoint:`${getInstanceIdentity().publicApiBasePath}/users/login`,
      headerName:'X-Operator-Token',
      tokenPath:'session.token',
      cookieFallback:'Use credentials: include on login and subsequent API requests',
    };
  }
  res.status(error.status || 500).json(body);
}

module.exports = {
  createLeadManagementRouter,
  requireLocationGrant,
  attachImportedData,
  serializeDialerLead,
  getGrantedLeadSource,
};
