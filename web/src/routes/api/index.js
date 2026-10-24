const express = require('express');
const bcrypt = require('bcryptjs');
const { apiKeyAuth } = require('../../middleware/apiKeyAuth');
const { apiSentinel } = require('../../middleware/apiSentinel');
const { ipBlockGate } = require('../../middleware/ipBlockGate');
const { apiLimiter } = require('../../middleware/rateLimit');
const { getPool } = require('../../db/pool');
const { createCrmRouter } = require('./crm');
const { createLeadManagementRouter, requireLocationGrant, serializeDialerLead } = require('./leads');
const { createApiHelpRouter } = require('./help');
const { createSessionsRouter } = require('./sessions');
const { createSqlDataRouter } = require('./sqlData');
const { createSystemIdentityRouter } = require('./systemIdentity');
const { createSongRuntimeRouter } = require('./songRuntime');
const { createDiveDeepRouter } = require('./divedeep');
const { createDiveDeepWorkersRouter } = require('./diveDeepWorkers');
const { createDiveDeepCustomerV1Router } = require('./diveDeepCustomerV1');
const { createDiveDeepEnterpriseV1Router } = require('./diveDeepEnterpriseV1');
const { createDiveDeepIntegrationsV1Router } = require('./diveDeepIntegrationsV1');
const {
  recordLoginEvent,
  verifyUserCredentials,
  preparePasswordCredential,
} = require('../../services/loginSecurity');
const { resolveTelemetryIdentity } = require('../../services/telemetryIdentity');
const { getAssignmentPolicy } = require('../../services/assignmentPolicies');
const { getAssignableStatuses, getPoolRule, listPoolRules } = require('../../services/leadPools');
const {
  classifyDncScreening,
  dncDestinationStatus,
  applyMarketingChannelStatus,
} = require('../../services/crmImporter');
const {
  listServicePools,
  getServicePool,
  classifyLeadRecord,
  matchServiceType,
  mappingsObject,
  selectServiceCalendar,
} = require('../../services/servicePools');
const {
  getScheduleWeek,
  getWeeklySchedule,
  assertWeeklyScheduleSubmitted,
  saveWeeklySchedule,
  submitWeeklySchedule,
  startWorkSession,
  stopWorkSession,
} = require('../../services/dialerSchedules');
const { screenLeadCandidates } = require('../../services/marketingCompliance');
const {
  createOperatorSession,
  requireOperatorSession,
  setOperatorSessionCookie,
} = require('../../services/operatorSessions');

function createApiRouter() {
  const router = express.Router();

  // Blocklist → observe (incl. auth failures) → rate-limit → auth
  router.use(ipBlockGate);
  router.use(apiSentinel);
  router.use(apiLimiter);
  router.use('/system', createSystemIdentityRouter());

  // Job-scoped, short-lived identity for disposable DiveDeep workers.
  // This route intentionally sits before the general API-key middleware.
  router.use('/workers/v1', createDiveDeepWorkersRouter());

  // Stable Phase 9 external API surfaces. These service identities are isolated
  // from the legacy platform API key, hidden administration, worker, and storage routes.
  router.use('/customer/v1', createDiveDeepCustomerV1Router());
  router.use('/enterprise/v1', createDiveDeepEnterpriseV1Router());
  router.use('/integrations/v1', createDiveDeepIntegrationsV1Router());

  router.use(apiKeyAuth);

  // User identity and session responses must never be stored by browsers or proxies.
  router.use('/users', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  // Machine-readable command catalog and request validator for Vibe/AI agents.
  router.use('/help', createApiHelpRouter());

  // CRM CRM proxy (browser → us → crm.example.invalid)

  // CRM ingestion, discovery, and import history.
  router.use('/crm', createCrmRouter());

  // Search and controlled lead management; legacy bulk/pull routes remain below.
  router.use('/leads', createLeadManagementRouter());

  // Session Harbor — dialer workspace continuity (not CRM cookies)
  router.use('/sessions', createSessionsRouter());

  // SQL Connection Hub — multi-DB table routing (grant-gated)
  router.use('/sql', createSqlDataRouter());

  // Published SONG script runtime and append-only flow telemetry.
  router.use('/song', createSongRuntimeRouter());

  // DiveDeep privacy SaaS domain: protected profiles, exposure cases, and scan jobs.
  router.use('/divedeep', createDiveDeepRouter());

  // --- Location blob sync ---
  router.post('/db/sync', async (req, res) => {
    try {
      const { locationId, payload } = req.body || {};
      if (!locationId || payload === undefined) {
        return res.status(400).json({ error: 'Missing locationId or payload' });
      }
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads');
      const pool = getPool();
      await pool.query(
        `INSERT INTO location_data (locationId, payload, updatedAt)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload), updatedAt = CURRENT_TIMESTAMP`,
        [locationId, typeof payload === 'string' ? payload : JSON.stringify(payload)]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, code:err.code });
    }
  });

  router.get('/db/sync', async (req, res) => {
    try {
      const { locationId } = req.query;
      if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_read');
      const pool = getPool();
      const [rows] = await pool.query(
        'SELECT payload FROM location_data WHERE locationId = ? LIMIT 1',
        [locationId]
      );
      if (!rows[0]) return res.json({ payload: null });
      res.json({ payload: rows[0].payload });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, code:err.code });
    }
  });

  // Dialer helper (from Vibe update) — first location config snapshot
  router.get('/system/config', async (req, res) => {
    try {
      const locationId = String(req.query.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_read');
      const pool = getPool();
      const [rows] = await pool.query(
        'SELECT locationId, payload FROM location_data WHERE locationId = ? LIMIT 1',
        [locationId]
      );
      if (!rows[0]) return res.json({ success: true, config: null });
      res.json({
        success: true,
        locationId: rows[0].locationId,
        payload: rows[0].payload,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Leads ---
  router.get('/service-pools', async (req, res) => {
    try {
      const locationId = String(req.query.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_read', null, { allowLegacyRead: true });
      const pools = await listServicePools(getPool(), 'core', locationId);
      res.json({
        success: true,
        locationId,
        pools,
        mappings: mappingsObject(pools),
        fallback: pools.find((item) => item.isEnabled && item.isFallback)?.serviceType || 'Other',
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.get('/calendars', async (req, res) => {
    try {
      const locationId = String(req.query.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_read', null, { allowLegacyRead: true });
      const pools = (await listServicePools(getPool(), 'core', locationId)).filter((item) => item.isEnabled);
      const calendars = pools.map(calendarServicePayload);
      res.json({
        success: true,
        locationId,
        calendars,
        byService: Object.fromEntries(calendars.map((item) => [item.serviceType, item])),
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.get('/calendars/resolve', async (req, res) => {
    try {
      const locationId = String(req.query.locationId || '').trim();
      const leadId = String(req.query.leadId || '').trim();
      let serviceType = String(req.query.serviceType || '').trim();
      if (!locationId || (!serviceType && !leadId)) {
        return res.status(400).json({ error: 'locationId and either serviceType or leadId are required' });
      }
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_read', null, { allowLegacyRead: true });
      if (leadId) {
        const [leads] = await getPool().query(
          'SELECT serviceType FROM leads WHERE id = ? AND locationId = ? LIMIT 1',
          [leadId, locationId]
        );
        if (!leads[0]) return res.status(404).json({ error: 'Lead not found in location' });
        serviceType = String(leads[0].serviceType || 'Other');
      }
      const service = await getServicePool(getPool(), 'core', locationId, serviceType);
      if (!service || !service.isEnabled) return res.status(404).json({ error: 'Enabled service pool not found' });
      res.json({ success: true, locationId, leadId: leadId || null, ...calendarServicePayload(service) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/service-pools/classify', async (req, res) => {
    try {
      const { locationId, tags } = req.body || {};
      if (!locationId || tags == null) return res.status(400).json({ error: 'Missing locationId or tags' });
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_read', null, { allowLegacyRead: true });
      const pools = await listServicePools(getPool(), 'core', String(locationId));
      const serviceType = matchServiceType(tags, pools);
      const service = pools.find((item) => item.serviceType === serviceType);
      res.json({ success: true, serviceType, calendar: service ? calendarServicePayload(service) : null });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/leads/bulk', async (req, res) => {
    const { locationId, leads } = req.body || {};
    if (!locationId || !leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    try {
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads');
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const serviceRules = await listServicePools(conn, 'core', locationId);
      const lifecycleRules = await listPoolRules(conn, 'core', locationId);
      let inserted = 0;
      for (const lead of leads) {
        let contactData = lead.contactData;
        if (typeof contactData === 'string') {
          try { contactData = JSON.parse(contactData); } catch { /* preserve raw contactData */ }
        }
        const record = contactData && typeof contactData === 'object' ? { ...contactData, ...lead } : lead;
        const serviceType = classifyLeadRecord(record, serviceRules, lead.serviceType || null);
        const screening = classifyDncScreening(record);
        const [result] = await conn.query(
          `INSERT IGNORE INTO leads
             (id, locationId, serviceType, status, contactData, dncStatus, dncCheckedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            lead.id,
            locationId,
            serviceType,
            dncDestinationStatus(screening, lifecycleRules),
            typeof lead.contactData === 'string'
              ? lead.contactData
              : JSON.stringify(lead.contactData),
            screening.state,
            screening.state === 'pending' ? null : new Date(),
          ]
        );
        if (result.affectedRows) {
          await applyMarketingChannelStatus(conn, lead.id, locationId, record, lifecycleRules);
        }
        inserted += result.affectedRows;
      }
      await conn.commit();
      res.json({ success: true, count: inserted, skipped: leads.length - inserted });
    } catch (err) {
      await conn.rollback();
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  });

  router.post('/leads/pull', async (req, res) => {
    const { locationId, userId, serviceType, count = 10 } = req.body || {};
    if (!locationId || !userId || !serviceType) {
      return res.status(400).json({ error: 'Missing parameters' });
    }
    try {
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads');
      await requireOperatorSession(req, { locationId:String(locationId), userId:String(userId) });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message, code:error.code });
    }
    const pool = getPool();
    try {
      const assignmentPolicy = await getAssignmentPolicy(pool, String(locationId));
      if (assignmentPolicy.requireSubmittedSchedule) await assertWeeklyScheduleSubmitted(pool, {
        locationId: String(locationId), userId: String(userId),
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.message,
        code: error.code || 'SCHEDULE_CHECK_FAILED',
        schedule: error.schedule || undefined,
      });
    }
    const pullCount = Math.min(Math.max(Number(count) || 10, 1), 100);
    try {
      const availableStatuses = await getAssignableStatuses(pool, 'core', locationId);
      if (!availableStatuses.length) {
        return res.json({ success: true, leads: [] });
      }
      const assignedRule = await getPoolRule(pool, 'core', locationId, 'assigned');
      const assignedStatus = assignedRule ? assignedRule.destinationStatus : 'assigned';
      const statusPlaceholders = availableStatuses.map(() => '?').join(',');
      const scanCount = Math.min(Math.max(pullCount * 5, 50), 500);
      const [candidates] = await pool.query(
        `SELECT id, locationId, serviceType, contactData FROM leads
         WHERE locationId = ? AND serviceType = ? AND status IN (${statusPlaceholders})
           AND dncStatus = 'clean' AND assignedTo IS NULL
         ORDER BY dateAdded DESC, id ASC LIMIT ?`,
        [locationId, serviceType, ...availableStatuses, scanCount]
      );
      if (!candidates.length) return res.json({ success: true, leads: [] });
      const screened = await screenLeadCandidates(pool, {
        apiKeyId:req.apiKey.id, locationId:String(locationId), userId:String(userId), leads:candidates,
      });
      const eligibleIds = screened.eligible.slice(0, pullCount).map((lead) => lead.id);
      if (!eligibleIds.length) {
        return res.json({
          success:true, leads:[],
          compliance:{ screened:candidates.length, eligible:0, blocked:screened.blocked.length, reasons:countReasons(screened.blocked) },
        });
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const idPlaceholders = eligibleIds.map(() => '?').join(',');
        const [rows] = await conn.query(
          `SELECT l.id, l.contactData, (
             SELECT sl.external_record_id
             FROM lead_source_links sl
             INNER JOIN crm_integrations i ON i.id = sl.integration_id AND i.is_enabled = 1
             INNER JOIN crm_integration_grants g ON g.integration_id = i.id
             WHERE sl.lead_id = l.id AND g.api_key_id = ?
               AND (g.allow_read = 1 OR g.allow_manage_leads = 1)
             ORDER BY sl.first_seen_at ASC LIMIT 1
           ) AS contactId FROM leads l
           WHERE locationId = ? AND serviceType = ? AND status IN (${statusPlaceholders})
             AND dncStatus = 'clean' AND assignedTo IS NULL AND id IN (${idPlaceholders})
           ORDER BY dateAdded DESC, id ASC LIMIT ? FOR UPDATE`,
          [req.apiKey.id, locationId, serviceType, ...availableStatuses, ...eligibleIds, pullCount]
        );
        if (!rows.length) {
          await conn.commit();
          return res.json({ success:true, leads:[], compliance:{ screened:candidates.length, eligible:eligibleIds.length, blocked:screened.blocked.length, reasons:countReasons(screened.blocked) } });
        }
        const ids = rows.map((row) => row.id);
        const placeholders = ids.map(() => '?').join(',');
        await conn.query(`UPDATE leads SET assignedTo = ?, status = ? WHERE id IN (${placeholders})`, [userId, assignedStatus, ...ids]);
        await conn.commit();
        const assignedLeads = rows.map(serializeDialerLead);
        return res.json({
          success:true, leads:assignedLeads,
          compliance:{ screened:candidates.length, eligible:screened.eligible.length, blocked:screened.blocked.length, reasons:countReasons(screened.blocked) },
        });
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally { conn.release(); }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Appointments & stats ---
  router.post('/appointments', async (req, res) => {
    const pool = getPool();
    let conn;
    try {
      const { locationId, leadId, userId, appointmentDate } = req.body || {};
      if (!locationId || !leadId || !userId || !appointmentDate) {
        return res.status(400).json({ error: 'locationId, leadId, userId, and appointmentDate are required' });
      }
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads', pool);
      const operator = await requireOperatorSession(req, {
        locationId:String(locationId), userId:String(userId),
      }, pool);
      conn = await pool.getConnection();
      let selectedCalendarId = req.body?.calendarId ? String(req.body.calendarId).trim() : null;
      let appointmentServiceType = req.body?.serviceType ? String(req.body.serviceType).trim() : null;
      await conn.beginTransaction();
      if (locationId && leadId) {
        const [leadRows] = await conn.query(
          'SELECT dncStatus, serviceType FROM leads WHERE id = ? AND locationId = ? LIMIT 1 FOR UPDATE',
          [leadId, locationId]
        );
        if (leadRows[0] && leadRows[0].dncStatus !== 'clean') {
          throw Object.assign(new Error('Lead requires a clean DNC result before scheduling'), { status: 409 });
        }
        if (leadRows[0]) appointmentServiceType = String(leadRows[0].serviceType || 'Other');
      }
      let calendarService = null;
      if (locationId && appointmentServiceType) {
        calendarService = await getServicePool(conn, 'core', String(locationId), appointmentServiceType);
      }
      selectedCalendarId = selectServiceCalendar(calendarService, selectedCalendarId);
      const [result] = await conn.query(
        `INSERT INTO appointments (locationId, leadId, userId, calendarId, appointmentDate)
         VALUES (?, ?, ?, ?, ?)`,
        [operator.locationId, leadId, operator.userId, selectedCalendarId, appointmentDate]
      );
      if (locationId && leadId) {
        const scheduled = await getPoolRule(conn, 'core', locationId, 'scheduled');
        const status = scheduled ? scheduled.destinationStatus : 'appointment';
        if (scheduled?.assignmentPolicy === 'require_user' && !userId) {
          throw Object.assign(new Error('Scheduled pool requires userId'), { status: 400 });
        }
        if (scheduled?.assignmentPolicy === 'clear') {
          await conn.query(
            'UPDATE leads SET status = ?, assignedTo = NULL WHERE id = ? AND locationId = ?',
            [status, leadId, locationId]
          );
        } else if (scheduled?.assignmentPolicy === 'require_user' && userId) {
          await conn.query(
            'UPDATE leads SET status = ?, assignedTo = ? WHERE id = ? AND locationId = ?',
            [status, userId, leadId, locationId]
          );
        } else {
          await conn.query(
            'UPDATE leads SET status = ? WHERE id = ? AND locationId = ?',
            [status, leadId, locationId]
          );
        }
      }
      await conn.commit();
      res.json({
        success: true,
        appointmentId: result.insertId,
        serviceType: appointmentServiceType,
        calendarId: selectedCalendarId,
      });
    } catch (err) {
      if (conn) await conn.rollback();
      res.status(err.status || 500).json({ error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  router.get('/users/:userId/stats', async (req, res) => {
    try {
      const { userId } = req.params;
      const { locationId } = req.query;
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_read', null, {
        allowLegacyRead: true,
      });
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT status, COUNT(*) AS count FROM appointments
         WHERE locationId = ? AND userId = ? GROUP BY status`,
        [locationId, userId]
      );
      const [rewardRows] = await pool.query(
        `SELECT SUM(amount) AS totalRewards FROM rewards WHERE locationId = ? AND userId = ?`,
        [locationId, userId]
      );
      res.json({
        success: true,
        appointments: rows,
        totalRewards: rewardRows[0]?.totalRewards || 0,
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // --- Rewards ---
  router.post('/rewards', async (req, res) => {
    try {
      const { locationId, userId, leadId, amount, type } = req.body || {};
      if (!locationId || !userId) {
        return res.status(400).json({ error: 'locationId and userId are required' });
      }
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads');
      await requireOperatorSession(req, { locationId:String(locationId), userId:String(userId) });
      const pool = getPool();
      const [result] = await pool.query(
        `INSERT INTO rewards (locationId, userId, leadId, amount, type)
         VALUES (?, ?, ?, ?, ?)`,
        [locationId, userId, leadId, amount, type]
      );
      res.json({ success: true, rewardId: result.insertId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Users (Dialer operator profiles) ---
  // Note: table existed; create/list/get were missing (password UPDATE only works if row exists).

  function mapUserRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      locationId: row.locationId,
      username: row.username,
      displayName: row.crmUserName || row.username,
    };
  }

  async function upsertUser(pool, user) {
    const id = user.id;
    const locationId = user.locationId;
    if (!id || !locationId) {
      throw Object.assign(new Error('Missing id or locationId'), { status: 400 });
    }
    let passwordHash = null;
    if (user.password != null || user.passwordHash != null) {
      passwordHash = (await preparePasswordCredential({
        password: user.password,
        passwordHash: user.passwordHash,
      })).value;
    }
    await pool.query(
      `INSERT INTO users
        (id, locationId, username, passwordHash, role, crmUserId, crmUserName, email, phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         username = IF(locationId = VALUES(locationId), COALESCE(VALUES(username), username), username),
         passwordHash = IF(locationId = VALUES(locationId), COALESCE(VALUES(passwordHash), passwordHash), passwordHash),
         role = IF(locationId = VALUES(locationId), COALESCE(VALUES(role), role), role),
         crmUserId = IF(locationId = VALUES(locationId), COALESCE(VALUES(crmUserId), crmUserId), crmUserId),
         crmUserName = IF(locationId = VALUES(locationId), COALESCE(VALUES(crmUserName), crmUserName), crmUserName),
         email = IF(locationId = VALUES(locationId), COALESCE(VALUES(email), email), email),
         phone = IF(locationId = VALUES(locationId), COALESCE(VALUES(phone), phone), phone)`,
      [
        id,
        locationId,
        user.username != null ? user.username : null,
        passwordHash,
        user.role != null ? user.role : null,
        user.crmUserId != null ? user.crmUserId : null,
        user.crmUserName != null ? user.crmUserName : null,
        user.email != null ? user.email : null,
        user.phone != null ? user.phone : null,
      ]
    );

    // A user ID is tenant-bound once created. Never let an upsert move or mutate
    // an existing operator that belongs to a different location.
    const [ownershipRows] = await pool.query(
      `SELECT locationId FROM users WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!ownershipRows[0] || String(ownershipRows[0].locationId) !== String(locationId)) {
      throw Object.assign(new Error('User ID is already assigned to another location'), {
        status: 409,
        code: 'USER_LOCATION_CONFLICT',
      });
    }
    return id;
  }

  // List users for a location
  router.get('/users', async (req, res) => {
    try {
      const { locationId } = req.query;
      if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_read', null, { allowLegacyRead:true });
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id, locationId, username, crmUserName
         FROM users WHERE locationId = ? ORDER BY username ASC`,
        [locationId]
      );
      res.json({ success: true, users: rows.map(mapUserRow) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create / upsert single user
  router.post('/users', async (req, res) => {
    try {
      const body = req.body || {};
      await requireLocationGrant(req.apiKey.id, String(body.locationId || ''), 'allow_manage_leads');
      const pool = getPool();
      const id = await upsertUser(pool, body);
      const [rows] = await pool.query(
        `SELECT id, locationId, username, crmUserName
         FROM users WHERE id = ? AND locationId = ? LIMIT 1`,
        [id, body.locationId]
      );
      res.status(201).json({ success: true, user: mapUserRow(rows[0]) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Bulk upsert users (Dialer sync)
  router.post('/users/bulk', async (req, res) => {
    const { locationId, users } = req.body || {};
    if (!locationId || !users || !Array.isArray(users)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    try {
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads');
    } catch (error) {
      return res.status(error.status || 500).json({ error:error.message });
    }
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const u of users) {
        if (u && u.locationId != null && String(u.locationId) !== String(locationId)) {
          throw Object.assign(new Error('Bulk user locationId must match the authorized locationId'), {
            status: 400,
            code: 'BULK_USER_LOCATION_MISMATCH',
          });
        }
        await upsertUser(conn, { ...u, locationId });
      }
      await conn.commit();
      res.json({ success: true, count: users.length });
    } catch (err) {
      await conn.rollback();
      res.status(err.status || 500).json({ error: err.message });
    } finally {
      conn.release();
    }
  });

  /**
   * Dialer operator login (observed by Sentinel).
   * POST /api/users/login
   *
   * Body: locationId, userId|username|email, password and/or passwordHash
   * Never returns passwordHash. Always records success/failure for security posture.
   */
  router.post('/users/login', async (req, res) => {
    const {
      locationId,
      userId,
      username,
      email,
      password,
      passwordHash,
    } = req.body || {};

    const baseLog = {
      event_type: 'login',
      location_id: locationId || null,
      user_id: userId || null,
      username: username || null,
      email: email ? String(email).trim().toLowerCase() : null,
      ip: req.ip,
      user_agent: req.get('user-agent'),
      api_key_id: req.apiKey && req.apiKey.id,
      key_prefix: req.apiKey && req.apiKey.key_prefix,
      request_id: req.sentinelRequestId,
    };

    try {
      if (!locationId || (!userId && !username && !email)) {
        await recordLoginEvent({
          ...baseLog,
          outcome: 'failure',
          detail: 'missing_identity',
        });
        return res.status(400).json({ success: false, error: 'Missing credentials' });
      }
      if (
        (password == null || String(password) === '') &&
        (passwordHash == null || String(passwordHash) === '')
      ) {
        await recordLoginEvent({
          ...baseLog,
          outcome: 'failure',
          detail: 'missing_password',
        });
        return res.status(400).json({ success: false, error: 'Missing password' });
      }

      const legacyPool = getPool();
      let result;
      try {
        result = await verifyLegacyUserLogin(req.apiKey.id, {
          locationId,
          userId,
          username,
          email,
          password,
          passwordHash,
        }, legacyPool);
      } catch (error) {
        if (error.status !== 403) throw error;
        await recordLoginEvent({ ...baseLog, outcome:'failure', detail:'location_access_denied' });
        return res.status(401).json({
          success:false,
          error:'Invalid credentials',
          requestId:req.sentinelRequestId,
        });
      }

      if (!result.ok) {
        await recordLoginEvent({
          ...baseLog,
          outcome: 'failure',
          detail: result.reason || 'invalid_credentials',
        });
        // Uniform failure response (no user enumeration)
        return res.status(401).json({
          success:false,
          error:'Invalid credentials',
          requestId:req.sentinelRequestId,
        });
      }

      await recordLoginEvent({
        ...baseLog,
        outcome: 'success',
        user_id: result.user.id,
        username: result.user.username,
        email: result.user.email,
        location_id: result.user.locationId || locationId,
        detail: `login_ok_${result.passwordScheme || 'unknown'}`,
      });

      const operatorSession = await createOperatorSession({
        apiKeyId:req.apiKey.id,
        user:result.user,
      }, legacyPool);
      setOperatorSessionCookie(res, operatorSession.token, operatorSession.expiresAt);
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.json({
        success: true,
        requestId:req.sentinelRequestId,
        user: mapUserRow(result.user),
        session: operatorSession,
      });
    } catch (err) {
      await recordLoginEvent({
        ...baseLog,
        outcome: 'failure',
        detail: 'server_error',
      });
      res.status(500).json({ success: false, error: 'Login failed' });
    }
  });

  /**
   * Reset dialer user password.
   * POST /api/users/reset-password
   *
   * Body (JSON):
   *   locationId   (required)
   *   email        (accepted always; used for lookup and stored on the user)
   *   userId       (optional) and/or username — also used to find the user
   *   passwordHash (Dialer-style pre-hashed secret) OR
   *   password     (plain text — hashed server-side with bcrypt)
   *
   * Lookup order: userId → username → email (case-insensitive for email).
   * If no match and userId is provided, creates a shell user with email.
   */
  router.post('/users/reset-password', async (req, res) => {
    try {
      const {
        locationId,
        userId,
        username,
        email: rawEmail,
        passwordHash: rawHash,
        password,
      } = req.body || {};

      const email =
        rawEmail != null && String(rawEmail).trim() !== ''
          ? String(rawEmail).trim().toLowerCase()
          : null;

      if (!locationId) {
        return res.status(400).json({ error: 'Missing locationId' });
      }
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads');
      if (!userId && !username && !email) {
        return res.status(400).json({
          error: 'Provide userId, username, or email to identify the user',
        });
      }

      const credential = await preparePasswordCredential({ password, passwordHash: rawHash });
      const passwordHash = credential.value;

      const pool = getPool();
      let row = null;

      if (userId) {
        const [rows] = await pool.query(
          `SELECT id, locationId, username, email FROM users WHERE id = ? AND locationId = ? LIMIT 1`,
          [userId, locationId]
        );
        row = rows[0] || null;
      }
      if (!row && username) {
        const [rows] = await pool.query(
          `SELECT id, locationId, username, email FROM users
           WHERE username = ? AND locationId = ? LIMIT 1`,
          [username, locationId]
        );
        row = rows[0] || null;
      }
      if (!row && email) {
        const [rows] = await pool.query(
          `SELECT id, locationId, username, email FROM users
           WHERE LOWER(email) = ? AND locationId = ? LIMIT 1`,
          [email, locationId]
        );
        row = rows[0] || null;
      }

      if (!row) {
        if (!userId) {
          await recordLoginEvent({
            event_type: 'password_reset',
            outcome: 'failure',
            username: username || null,
            email,
            location_id: locationId,
            ip: req.ip,
            user_agent: req.get('user-agent'),
            api_key_id: req.apiKey && req.apiKey.id,
            key_prefix: req.apiKey && req.apiKey.key_prefix,
            detail: 'user_not_found',
            request_id: req.sentinelRequestId,
          });
          return res.status(404).json({
            error: 'User not found',
            message:
              'No user matched email/username; pass userId to create a shell account on reset',
          });
        }
        await pool.query(
          `INSERT INTO users (id, locationId, username, email, passwordHash)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             passwordHash = VALUES(passwordHash),
             locationId = VALUES(locationId),
             username = COALESCE(VALUES(username), username),
             email = COALESCE(VALUES(email), email)`,
          [userId, locationId, username || null, email, passwordHash]
        );
        await recordLoginEvent({
          event_type: 'password_reset',
          outcome: 'success',
          user_id: userId,
          username: username || null,
          email,
          location_id: locationId,
          ip: req.ip,
          user_agent: req.get('user-agent'),
          api_key_id: req.apiKey && req.apiKey.id,
          key_prefix: req.apiKey && req.apiKey.key_prefix,
          detail: `created_shell_user_${credential.scheme}`,
          request_id: req.sentinelRequestId,
        });
        return res.json({
          success: true,
          created: true,
          userId,
          locationId,
          email,
          credentialScheme: credential.scheme,
          requestId: req.sentinelRequestId,
        });
      }

      // Update password; store email when provided (keeps CRM/dialer identity linked)
      const [result] = await pool.query(
        `UPDATE users
         SET passwordHash = ?,
             email = COALESCE(?, email),
             username = COALESCE(?, username)
         WHERE id = ? AND locationId = ?`,
        [passwordHash, email, username || null, row.id, locationId]
      );

      await recordLoginEvent({
        event_type: 'password_reset',
        outcome: 'success',
        user_id: row.id,
        username: username || row.username,
        email: email || row.email,
        location_id: locationId,
        ip: req.ip,
        user_agent: req.get('user-agent'),
        api_key_id: req.apiKey && req.apiKey.id,
        key_prefix: req.apiKey && req.apiKey.key_prefix,
        detail: `password_updated_${credential.scheme}`,
        request_id: req.sentinelRequestId,
      });

      res.json({
        success: true,
        created: false,
        changes: result.affectedRows,
        userId: row.id,
        locationId,
        email: email || row.email || null,
        credentialScheme: credential.scheme,
        requestId: req.sentinelRequestId,
      });
    } catch (err) {
      await recordLoginEvent({
        event_type: 'password_reset',
        outcome: 'failure',
        location_id: (req.body && req.body.locationId) || null,
        user_id: (req.body && req.body.userId) || null,
        email: (req.body && req.body.email) || null,
        ip: req.ip,
        user_agent: req.get('user-agent'),
        api_key_id: req.apiKey && req.apiKey.id,
        key_prefix: req.apiKey && req.apiKey.key_prefix,
        detail: err.status === 403
          ? 'location_access_denied'
          : String(err.code || 'password_reset_failed').slice(0, 255),
        request_id: req.sentinelRequestId,
      });
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Get one user (must stay after /users/:userId/stats and /schedule if those use same pattern —
  // Express matches in registration order; specific subpaths are registered below after this block's password)

  router.put('/users/:userId/password', async (req, res) => {
    try {
      const { userId } = req.params;
      const { locationId, password, passwordHash: rawHash } = req.body || {};
      if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads');
      const credential = await preparePasswordCredential({ password, passwordHash: rawHash });
      const passwordHash = credential.value;
      const pool = getPool();
      // Upsert-friendly: create shell user if missing so Dialer password set never no-ops silently
      const [existing] = await pool.query(
        `SELECT id FROM users WHERE id = ? AND locationId = ? LIMIT 1`,
        [userId, locationId]
      );
      if (!existing[0]) {
        await pool.query(
          `INSERT INTO users (id, locationId, passwordHash) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE passwordHash = VALUES(passwordHash), locationId = VALUES(locationId)`,
          [userId, locationId, passwordHash]
        );
        await recordLoginEvent({
          event_type:'password_change',outcome:'success',user_id:userId,location_id:locationId,
          ip:req.ip,user_agent:req.get('user-agent'),api_key_id:req.apiKey?.id,
          key_prefix:req.apiKey?.key_prefix,detail:`created_shell_user_${credential.scheme}`,
          request_id:req.sentinelRequestId,
        });
        return res.json({
          success:true,changes:1,created:true,credentialScheme:credential.scheme,
          requestId:req.sentinelRequestId,
        });
      }
      const [result] = await pool.query(
        `UPDATE users SET passwordHash = ? WHERE id = ? AND locationId = ?`,
        [passwordHash, userId, locationId]
      );
      await recordLoginEvent({
        event_type:'password_change',outcome:'success',user_id:userId,location_id:locationId,
        ip:req.ip,user_agent:req.get('user-agent'),api_key_id:req.apiKey?.id,
        key_prefix:req.apiKey?.key_prefix,detail:`password_updated_${credential.scheme}`,
        request_id:req.sentinelRequestId,
      });
      res.json({
        success:true,changes:result.affectedRows,credentialScheme:credential.scheme,
        requestId:req.sentinelRequestId,
      });
    } catch (err) {
      await recordLoginEvent({
        event_type:'password_change',outcome:'failure',user_id:req.params.userId,
        location_id:req.body?.locationId||null,ip:req.ip,user_agent:req.get('user-agent'),
        api_key_id:req.apiKey?.id,key_prefix:req.apiKey?.key_prefix,
        detail:String(err.code||'password_change_failed').slice(0,255),request_id:req.sentinelRequestId,
      });
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.get('/users/:userId/schedule', async (req, res) => {
    try {
      const { userId } = req.params;
      const locationId = String(req.query.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_read', null, { allowLegacyRead: true });
      const pool = getPool();
      const result = await getWeeklySchedule(pool, locationId, userId);
      res.json({
        success: true,
        schedule: result.row?.scheduleData || null,
        week: result.week,
        state: !result.row ? 'missing' : result.row.submittedAt ? 'submitted' : 'draft',
        submittedAt: result.row?.submittedAt || null,
        scheduledMinutes: Number(result.row?.scheduledMinutes) || 0,
        updatedAt: result.row?.updatedAt || null,
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.put('/users/:userId/schedule', async (req, res) => {
    try {
      const { userId } = req.params;
      const { locationId, scheduleData, submit = false } = req.body || {};
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_manage_leads');
      const pool = getPool();
      const result = await saveWeeklySchedule(pool, {
        locationId: String(locationId), userId, scheduleData, submit: submit === true,
      });
      res.json({
        success: true,
        schedule: result.row.scheduleData,
        week: result.week,
        state: result.row.submittedAt ? 'submitted' : 'draft',
        submittedAt: result.row.submittedAt,
        scheduledMinutes: Number(result.row.scheduledMinutes) || 0,
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/users/:userId/schedule/submit', async (req, res) => {
    try {
      const { userId } = req.params;
      const locationId = String(req.body?.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_manage_leads');
      const result = await submitWeeklySchedule(getPool(), { locationId, userId });
      res.json({ success: true, week: result.week, state: 'submitted', submittedAt: result.row.submittedAt });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.get('/users/:userId/work-sessions', async (req, res) => {
    try {
      const { userId } = req.params;
      const locationId = String(req.query.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_read', null, { allowLegacyRead: true });
      const week = getScheduleWeek();
      const [rows] = await getPool().query(
        `SELECT id, locationId, userId, weekStart, startedAt, endedAt,
                COALESCE(durationSeconds, GREATEST(0, TIMESTAMPDIFF(SECOND, startedAt, UTC_TIMESTAMP(3)))) AS durationSeconds,
                status, source
         FROM dialer_work_sessions WHERE locationId = ? AND userId = ? AND weekStart = ?
         ORDER BY startedAt DESC LIMIT 100`,
        [locationId, userId, week.weekStart]
      );
      res.json({ success: true, week, sessions: rows });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/users/:userId/work-sessions/start', async (req, res) => {
    try {
      const { userId } = req.params;
      const locationId = String(req.body?.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_manage_leads');
      const session = await startWorkSession(getPool(), { locationId, userId, source: req.body?.source });
      res.status(201).json({ success: true, session });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, session: err.session || undefined });
    }
  });

  router.post('/users/:userId/work-sessions/:sessionId/stop', async (req, res) => {
    try {
      const { userId, sessionId } = req.params;
      const locationId = String(req.body?.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_manage_leads');
      const session = await stopWorkSession(getPool(), { locationId, userId, sessionId });
      res.json({ success: true, session });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Get single user
  router.get('/users/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const { locationId } = req.query;
      if (!locationId) return res.status(400).json({ error:'locationId is required' });
      const pool = getPool();
      await requireLocationGrant(req.apiKey.id, String(locationId), 'allow_read', null, { allowLegacyRead:true });
      let rows;
      [rows] = await pool.query(
        `SELECT id, locationId, username, crmUserName
         FROM users WHERE id = ? AND locationId = ? LIMIT 1`,
        [userId, locationId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true, user: mapUserRow(rows[0]) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Update / upsert user by id
  router.put('/users/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const body = req.body || {};
      await requireLocationGrant(req.apiKey.id, String(body.locationId || ''), 'allow_manage_leads');
      const pool = getPool();
      await upsertUser(pool, { ...body, id: userId, locationId: body.locationId });
      const [rows] = await pool.query(
        `SELECT id, locationId, username, crmUserName
         FROM users WHERE id = ? AND locationId = ? LIMIT 1`,
        [userId, body.locationId]
      );
      res.json({ success: true, user: mapUserRow(rows[0]) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.get('/schedules', async (req, res) => {
    try {
      const locationId = String(req.query.locationId || '').trim();
      if (!locationId) return res.status(400).json({ error: 'locationId is required' });
      await requireLocationGrant(req.apiKey.id, locationId, 'allow_read', null, { allowLegacyRead: true });
      const pool = getPool();
      const week = getScheduleWeek();
      const [rows] = await pool.query(
        `SELECT u.id AS userId, u.username, u.crmUserName, s.scheduleData, s.scheduledMinutes,
                s.submittedAt, s.updatedAt
         FROM users u LEFT JOIN user_schedule_weeks s
           ON s.userId = u.id AND s.locationId = u.locationId AND s.weekStart = ?
         WHERE u.locationId = ? ORDER BY u.username, u.id`,
        [week.weekStart, locationId]
      );
      const schedules = rows.map((r) => {
        let schedule;
        try {
          schedule = JSON.parse(r.scheduleData);
        } catch {
          schedule = r.scheduleData;
        }
        return {
          userId: r.userId,
          username: r.username,
          crmUserName: r.crmUserName,
          schedule,
          scheduledMinutes: Number(r.scheduledMinutes) || 0,
          submittedAt: r.submittedAt || null,
          updatedAt: r.updatedAt || null,
          state: !r.scheduleData ? 'missing' : r.submittedAt ? 'submitted' : 'draft',
        };
      });
      res.json({ success: true, week, schedules });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Errors & logs ---
  router.post('/errors', async (req, res) => {
    try {
      const { id, locationId, userId, username, email, type, message, details, url } =
        req.body || {};
      if (!locationId || !id) return res.status(400).json({ error: 'Missing parameters' });
      const pool = getPool();
      await requireOperatorSession(req, { locationId:String(locationId) }, pool);
      const identity = await resolveTelemetryIdentity(pool, {
        locationId,
        userId,
        username,
        email,
      });
      await pool.query(
        `INSERT INTO system_errors
           (id, locationId, userId, username, type, message, details, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          locationId,
          identity.userId,
          identity.username,
          type,
          message,
          typeof details === 'string' ? details : JSON.stringify(details ?? null),
          url,
        ]
      );
      res.json({ success: true, identity });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, code:err.code });
    }
  });

  router.get('/errors', async (req, res) => {
    try {
      const { locationId } = req.query;
      if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
      const pool = getPool();
      const operator = await requireOperatorSession(req, { locationId:String(locationId) }, pool);
      if (!operator.isAdmin) return res.status(403).json({ error: 'Operator administrator required' });
      const [rows] = await pool.query(
        `SELECT * FROM system_errors WHERE locationId = ? ORDER BY timestamp DESC LIMIT 100`,
        [locationId]
      );
      res.json({ success: true, errors: rows });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, code:err.code });
    }
  });

  router.delete('/errors', async (req, res) => {
    try {
      const { locationId } = req.query;
      if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
      const pool = getPool();
      const operator = await requireOperatorSession(req, { locationId:String(locationId) }, pool);
      if (!operator.isAdmin) return res.status(403).json({ error: 'Operator administrator required' });
      await pool.query(`DELETE FROM system_errors WHERE locationId = ?`, [locationId]);
      res.json({ success: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, code:err.code });
    }
  });

  router.post('/logs', async (req, res) => {
    try {
      const { id, locationId, username, status, userAgent, email, userId } = req.body || {};
      if (!locationId || !id) return res.status(400).json({ error: 'Missing parameters' });
      const pool = getPool();
      await requireOperatorSession(req, { locationId:String(locationId) }, pool);
      const identity = await resolveTelemetryIdentity(pool, {
        locationId,
        userId,
        username,
        email,
      });
      await pool.query(
        `INSERT INTO auth_logs (id, locationId, userId, username, email, status, userAgent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          locationId,
          identity.userId,
          identity.username,
          identity.email,
          status,
          userAgent,
        ]
      );

      // Mirror into Sentinel login posture (Dialer client-reported auth events)
      const statusStr = String(status || '').toLowerCase();
      const outcome =
        statusStr.includes('success') || statusStr === 'ok' || statusStr === 'authenticated'
          ? 'success'
          : statusStr.includes('fail') ||
              statusStr.includes('error') ||
              statusStr.includes('denied') ||
              statusStr.includes('invalid')
            ? 'failure'
            : 'unknown';

      await recordLoginEvent({
        event_type: 'auth_log',
        outcome,
        username: identity.username,
        email: identity.email,
        user_id: identity.userId,
        location_id: locationId,
        ip: req.ip,
        user_agent: userAgent || req.get('user-agent'),
        api_key_id: req.apiKey && req.apiKey.id,
        key_prefix: req.apiKey && req.apiKey.key_prefix,
        detail: status ? String(status).slice(0, 255) : null,
        request_id: req.sentinelRequestId || id,
      });

      res.json({ success: true, identity });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, code:err.code });
    }
  });

  router.get('/logs', async (req, res) => {
    try {
      const { locationId } = req.query;
      if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
      const pool = getPool();
      const operator = await requireOperatorSession(req, { locationId:String(locationId) }, pool);
      if (!operator.isAdmin) return res.status(403).json({ error: 'Operator administrator required' });
      const [rows] = await pool.query(
        `SELECT * FROM auth_logs WHERE locationId = ? ORDER BY timestamp DESC LIMIT 100`,
        [locationId]
      );
      res.json({ success: true, logs: rows });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, code:err.code });
    }
  });

  return router;
}

/**
 * Authenticate against the installed core (Legacy) database. Core is the
 * default source assigned to every active API key; when a location has no CRM
 * integration, allowLegacyRead ensures the users-table lookup is still reached.
 */
async function verifyLegacyUserLogin(apiKeyId, credentials, pool = null) {
  const legacyPool = pool || getPool();
  await requireLocationGrant(
    apiKeyId,
    String(credentials.locationId),
    'allow_read',
    legacyPool,
    { allowLegacyRead: true }
  );
  return verifyUserCredentials(credentials, legacyPool);
}

function calendarServicePayload(service) {
  return {
    serviceType: service.serviceType,
    calendarIds: service.calendarIds,
    defaultCalendarId: service.defaultCalendarId,
    configured: service.calendarIds.length > 0,
  };
}

function countReasons(blocked) {
  return blocked.reduce((result, item) => {
    const reason = item.compliance?.reason || 'unknown';
    result[reason] = (result[reason] || 0) + 1;
    return result;
  }, {});
}

module.exports = { createApiRouter, verifyLegacyUserLogin };
