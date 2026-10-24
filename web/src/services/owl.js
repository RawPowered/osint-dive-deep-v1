const { isConfiguredCrmHost } = require('./crmOrigins');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool } = require('../db/pool');
const { listKeys } = require('./apiKeys');
const { listGrantsForApiKey, resolveAccess } = require('./sqlGrants');
const { getDataPool } = require('./sqlConnections');
const { publicIntegration, getAuthorizedIntegration, integrationCredential, LEADCONNECTOR_ORIGIN } = require('./crmIntegrations');
const { BCRYPT_ROUNDS, validPassword } = require('./adminUsers');
const { listDialerPoolPermissions, saveDialerPoolPermissions, normalizeServicePool } = require('./dialerAssignments');
const { getAssignmentPolicy, saveAssignmentPolicy, listUserLanguagePermissions, saveUserLanguagePermissions } = require('./assignmentPolicies');
const { resolveDialerServicePool } = require('./dialerEligibility');
const {
  createImportRun,
  getImportRun,
  executeImportRun,
  classifyDncScreening,
  applyDncScreeningStatus,
  applyMarketingChannelStatus,
  fetchCrmPage,
  safeConfig,
  getPath,
} = require('./crmImporter');
const {
  listPoolRules,
  getPoolRule,
  findRuleForStatus,
  upsertPoolRule,
  assertDncAssignmentAllowed,
} = require('./leadPools');
const {
  listServicePools,
  getServicePool,
  upsertServicePool,
  setServicePoolCalendars,
  classifyLeadRecord,
} = require('./servicePools');
const {
  getScheduleWeek,
  getWeeklySchedule,
  saveWeeklySchedule,
  submitWeeklySchedule,
} = require('./dialerSchedules');
const {
  isDncScrubConfigured,
  getDncScrubConfig,
  extractPhone,
  extractPhoneCandidates,
  scrubPhoneNumbers,
  RESULT_CODES,
} = require('./dncScrub');
const { syncDncResultsToCrm } = require('./dncCrmSync');
const { aggregateFailure, swapPrimaryPhone } = require('./dialerPhoneSelection');

const CORE_TABLES = {
  leads: fullCapabilities(),
  users: fullCapabilities(),
  user_schedules: fullCapabilities(),
  user_schedule_weeks: { select: true, insert: true, update: true, delete: false },
  dialer_work_sessions: { select: true, insert: true, update: true, delete: false },
  dialer_activity_minutes: { select: true, insert: false, update: false, delete: false },
  lead_call_attempts: { select: true, insert: false, update: false, delete: false },
  lead_compliance_checks: { select: true, insert: false, update: false, delete: false },
  dialer_workspaces: { select: true, insert: false, update: true, delete: true },
  api_login_events: { select: true, insert: false, update: false, delete: false },
  appointments: { select: true, insert: true, update: true, delete: false },
  rewards: { select: true, insert: true, update: true, delete: false },
};

function fullCapabilities() {
  return { select: true, insert: true, update: true, delete: true };
}

function publicKey(row) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    lastUsedAt: row.last_used_at || null,
  };
}

async function assertActiveKey(apiKeyId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT id, name, key_prefix, last_used_at FROM api_keys
     WHERE id = ? AND revoked_at IS NULL LIMIT 1`,
    [apiKeyId]
  );
  if (!rows[0]) throw Object.assign(new Error('Active API key not found'), { status: 404 });
  return rows[0];
}

async function listSources(apiKeyId) {
  const key = await assertActiveKey(apiKeyId);
  const grants = await listGrantsForApiKey(apiKeyId);
  return {
    key: publicKey(key),
    sources: [
      {
        slug: 'core',
        name: 'Core database (legacy)',
        type: 'core',
        tables: CORE_TABLES,
      },
      ...grants.map((grant) => ({
        slug: grant.connectionSlug,
        name: grant.connectionName,
        type: 'sql-connection',
        canIntrospect: grant.canIntrospect,
        tables: Object.fromEntries(
          grant.tables.map((table) => [
            table.tableName,
            {
              select: table.allowSelect,
              insert: table.allowInsert,
              update: table.allowUpdate,
              delete: table.allowDelete,
              allowedColumns: table.allowedColumns,
            },
          ])
        ),
      })),
    ],
  };
}

async function bootstrapOwl(apiKeyId = null, admin = null) {
  const principalType = admin?.principalType || 'root';
  let keys = (await listKeys()).filter((key) => !key.revoked_at).map(publicKey);
  if (principalType === 'tenant') keys = keys.filter((key) => String(key.id) === String(admin.apiKeyId));
  const selectedId = apiKeyId || (keys[0] && keys[0].id);
  if (principalType === 'tenant' && selectedId !== admin.apiKeyId) {
    throw Object.assign(new Error('Selected API key is outside this administrator tenant'), { status: 403 });
  }
  const context = selectedId ? await listSources(selectedId) : { key: null, sources: [] };
  return {
    keys, selectedKey: context.key, sources: context.sources,
    dncScrub: { configured: isDncScrubConfigured() },
    access: {
      principalType,
      displayRole: principalType === 'root' ? 'Root Custodian'
        : principalType === 'platform' ? 'System Steward' : 'Workspace Custodian',
      canCreatePlatformAdmin: principalType === 'root',
      canCreateTenantAdmin: ['root', 'platform'].includes(principalType),
      canCreateDialerUser: true,
    },
  };
}

async function resolveContext({ apiKeyId, source = 'core' }) {
  if (!apiKeyId) throw Object.assign(new Error('apiKeyId is required'), { status: 400 });
  const available = await listSources(apiKeyId);
  const selected = available.sources.find((item) => item.slug === source);
  if (!selected) {
    throw Object.assign(new Error('Selected source is not assigned to this API key'), { status: 403 });
  }
  return { apiKeyId, source: selected.slug, sourceInfo: selected, corePool: getPool() };
}

function requireCapability(context, table, operation) {
  const caps = context.sourceInfo.tables[table];
  if (!caps || !caps[operation]) {
    throw Object.assign(
      new Error(`${operation.toUpperCase()} is not granted on ${table} for this key/source`),
      { status: 403 }
    );
  }
  return caps;
}

function requireColumns(context, table, columns) {
  const caps = context.sourceInfo.tables[table];
  if (!caps) throw Object.assign(new Error(`No table grant for ${table}`), { status: 403 });
  if (!caps.allowedColumns) return;
  const missing = columns.filter((column) => !caps.allowedColumns.includes(column));
  if (missing.length) {
    throw Object.assign(new Error(`OWL requires non-granted column(s) on ${table}: ${missing.join(', ')}`), { status: 403 });
  }
}

async function domainPool(context, table, operation) {
  requireCapability(context, table, operation);
  if (context.source === 'core') return context.corePool;
  const { connection } = await resolveAccess({
    apiKeyId: context.apiKeyId,
    connectionSlug: context.source,
    tableName: table,
    op: operation,
  });
  return getDataPool(connection);
}

async function listLocations(context) {
  const values = new Set();
  const candidates = [
    ['leads', 'locationId'],
    ['users', 'locationId'],
    ['user_schedules', 'locationId'],
    ['user_schedule_weeks', 'locationId'],
    ['dialer_work_sessions', 'locationId'],
    ['dialer_workspaces', 'location_id'],
  ];
  for (const [table, column] of candidates) {
    const caps = context.sourceInfo.tables[table];
    if (!caps || !caps.select) continue;
    if (caps.allowedColumns && !caps.allowedColumns.includes(column)) continue;
    const pool = await domainPool(context, table, 'select');
    const [rows] = await pool.query(
      `SELECT DISTINCT \`${column}\` AS locationId FROM \`${table}\`
       WHERE \`${column}\` IS NOT NULL AND \`${column}\` <> '' LIMIT 500`
    );
    for (const row of rows) values.add(String(row.locationId));
  }
  return [...values].sort();
}

function buildLocationContexts(databaseLocations = [], integrationLocations = []) {
  const database = new Set(databaseLocations.map(String));
  const integration = new Set(integrationLocations.map(String));
  return [...new Set([...database, ...integration])].sort().map((locationId) => ({
    locationId,
    databaseDiscovered:database.has(locationId),
    integrationGranted:integration.has(locationId),
    authority:integration.has(locationId) ? 'api_integration' : 'database',
  }));
}

async function getSummary(context, locationId) {
  requireLocation(locationId);
  const summary = {};
  for (const [name, table, column] of [
    ['leads', 'leads', 'locationId'],
    ['users', 'users', 'locationId'],
    ['dialers', 'dialer_workspaces', 'location_id'],
  ]) {
    const caps = context.sourceInfo.tables[table];
    if (!caps || !caps.select) {
      summary[name] = null;
      continue;
    }
    if (caps.allowedColumns && !caps.allowedColumns.includes(column)) {
      summary[name] = null;
      continue;
    }
    const pool = await domainPool(context, table, 'select');
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total FROM \`${table}\` WHERE \`${column}\` = ?`,
      [locationId]
    );
    summary[name] = Number(rows[0].total) || 0;
  }
  const scheduleCaps = context.sourceInfo.tables.user_schedule_weeks;
  if (!scheduleCaps?.select || (scheduleCaps.allowedColumns && !['locationId', 'weekStart', 'submittedAt'].every((column) => scheduleCaps.allowedColumns.includes(column)))) {
    summary.schedules = null;
  } else {
    const pool = await domainPool(context, 'user_schedule_weeks', 'select');
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total FROM user_schedule_weeks
       WHERE locationId = ? AND weekStart = ? AND submittedAt IS NOT NULL`,
      [locationId, getScheduleWeek().weekStart]
    );
    summary.schedules = Number(rows[0].total) || 0;
  }
  return summary;
}

async function listPools(context, locationId) {
  requireLocation(locationId);
  requireColumns(context, 'leads', ['locationId', 'serviceType', 'status', 'assignedTo', 'dateAdded']);
  const pool = await domainPool(context, 'leads', 'select');
  const [rows] = await pool.query(
    `SELECT COALESCE(serviceType, 'Unspecified') AS serviceType, status,
            COUNT(*) AS total,
            SUM(CASE WHEN assignedTo IS NULL THEN 0 ELSE 1 END) AS assigned,
            SUM(CASE WHEN assignedTo IS NULL THEN 1 ELSE 0 END) AS available,
            MAX(dateAdded) AS newestLead
     FROM leads WHERE locationId = ?
     GROUP BY serviceType, status ORDER BY serviceType, status`,
    [locationId]
  );
  return rows.map((row) => ({ ...row, total: Number(row.total), assigned: Number(row.assigned), available: Number(row.available) }));
}

async function getServicePoolManagement(context, locationId) {
  requireLocation(locationId);
  requireColumns(context, 'leads', ['locationId', 'serviceType', 'status', 'assignedTo', 'dateAdded']);
  const [services, lifecycleRules, dialerMetrics, assignmentPolicy] = await Promise.all([
    listServicePools(context.corePool, 'core', locationId),
    listPoolRules(context.corePool, context.source, locationId),
    listPoolDialerMetrics(context.corePool, locationId),
    getAssignmentPolicy(context.corePool, locationId),
  ]);
  const pool = await domainPool(context, 'leads', 'select');
  const [rows] = await pool.query(
    `SELECT COALESCE(NULLIF(serviceType, ''), 'Other') AS serviceType, status,
            COUNT(*) AS total,
            SUM(CASE WHEN assignedTo IS NULL THEN 0 ELSE 1 END) AS assigned,
            SUM(CASE WHEN assignedTo IS NULL THEN 1 ELSE 0 END) AS unassigned,
            MAX(dateAdded) AS newestLead
     FROM leads WHERE locationId = ? GROUP BY serviceType, status`,
    [locationId]
  );
  const lifecycleByStatus = new Map();
  for (const rule of lifecycleRules) {
    for (const status of rule.statusValues) lifecycleByStatus.set(String(status), rule);
  }
  const byService = new Map();
  for (const row of rows) {
    const name = String(row.serviceType);
    if (!byService.has(name)) byService.set(name, emptyServiceMetrics());
    const metrics = byService.get(name);
    const total = Number(row.total) || 0;
    metrics.total += total;
    metrics.assigned += Number(row.assigned) || 0;
    metrics.unassigned += Number(row.unassigned) || 0;
    metrics.newestLead = latest(metrics.newestLead, row.newestLead);
    metrics.statuses[String(row.status)] = total;
    const lifecycle = lifecycleByStatus.get(String(row.status));
    if (lifecycle?.isAssignable) metrics.available += Number(row.unassigned) || 0;
    else if (lifecycle?.isTerminal) metrics.terminal += total;
    else if (lifecycle?.poolKey === 'scheduled') metrics.scheduled += total;
    else metrics.active += total;
  }
  const configured = new Set(services.map((item) => item.serviceType));
  return {
    services: services.map((item) => ({ ...item, ...(byService.get(item.serviceType) || emptyServiceMetrics()),
      dialers:dialerMetrics.filter((row) => row.servicePool === normalizeServicePool(item.serviceType)) })),
    assignmentPolicy,
    unmappedServices: [...byService.entries()]
      .filter(([name]) => !configured.has(name))
      .map(([serviceType, metrics]) => ({ serviceType, ...metrics })),
  };
}

async function listPoolDialerMetrics(pool, locationId) {
  const [permissions, calls, appointments] = await Promise.all([
    pool.query(`SELECT p.user_id AS userId,p.service_pool AS servicePool,p.assignment_count AS assignmentCount,
      p.last_assigned_at AS lastAssignedAt,u.username,u.crmUserId,u.crmUserName
      FROM owl_user_pool_permissions p INNER JOIN users u ON u.id=p.user_id AND u.locationId=p.location_id
      WHERE p.location_id=? AND p.is_enabled=1 ORDER BY p.service_pool,u.username`, [locationId]).then(([rows]) => rows),
    pool.query(`SELECT a.user_id AS userId,l.serviceType,COUNT(*) AS calls FROM lead_call_attempts a
      LEFT JOIN leads l ON l.id=a.lead_id AND l.locationId=a.location_id
      WHERE a.location_id=? AND a.source='crm' AND a.direction='outbound'
      AND a.occurred_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY) GROUP BY a.user_id,l.serviceType`, [locationId]).then(([rows]) => rows),
    pool.query(`SELECT ap.userId,l.serviceType,COUNT(*) AS appointments FROM appointments ap
      LEFT JOIN leads l ON l.id=ap.leadId AND l.locationId=ap.locationId
      WHERE ap.locationId=? AND ap.createdAt>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)
      GROUP BY ap.userId,l.serviceType`, [locationId]).then(([rows]) => rows),
  ]);
  const map = (rows, field) => new Map(rows.map((row) => [`${row.userId}|${normalizeServicePool(row.serviceType)}`, Number(row[field]) || 0]));
  const callMap = map(calls, 'calls'); const appointmentMap = map(appointments, 'appointments');
  return permissions.map((row) => {
    const key = `${row.userId}|${row.servicePool}`; const callCount = callMap.get(key) || 0; const appointmentCount = appointmentMap.get(key) || 0;
    return { ...row, assignmentCount:Number(row.assignmentCount) || 0, callCount, appointmentCount,
      scheduleRate:callCount ? Math.round(appointmentCount / callCount * 1000) / 10 : null };
  });
}

function emptyServiceMetrics() {
  return { total: 0, assigned: 0, unassigned: 0, available: 0, active: 0, scheduled: 0, terminal: 0, newestLead: null, statuses: {} };
}

function latest(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(left) > new Date(right) ? left : right;
}

async function saveServicePool(context, input) {
  const locationId = requireLocation(input.locationId);
  return upsertServicePool(context.corePool, 'core', locationId, input.serviceType, input);
}

async function saveServiceCalendars(context, serviceType, input) {
  const locationId = requireLocation(input.locationId);
  return setServicePoolCalendars(
    context.corePool, 'core', locationId, String(serviceType || ''), input
  );
}

async function moveLeadsToService(context, input) {
  const locationId = requireLocation(input.locationId);
  requireColumns(context, 'leads', ['id', 'locationId', 'serviceType']);
  const ids = normalizeIds(input.leadIds);
  const service = await getServicePool(context.corePool, 'core', locationId, String(input.serviceType || ''));
  if (!service || !service.isEnabled) throw Object.assign(new Error('Destination service pool not found or disabled'), { status: 404 });
  const readPool = await domainPool(context, 'leads', 'select');
  const writePool = await domainPool(context, 'leads', 'update');
  const placeholders = ids.map(() => '?').join(',');
  const [before] = await readPool.query(
    `SELECT id, serviceType FROM leads WHERE locationId = ? AND id IN (${placeholders})`,
    [locationId, ...ids]
  );
  await writePool.query(
    `UPDATE leads SET serviceType = ? WHERE locationId = ? AND id IN (${placeholders})`,
    [service.serviceType, locationId, ...ids]
  );
  const [after] = await readPool.query(
    `SELECT id, serviceType FROM leads WHERE locationId = ? AND id IN (${placeholders})`,
    [locationId, ...ids]
  );
  return { before, after, affected: after.length, service };
}

async function reclassifyServices(context, input) {
  const locationId = requireLocation(input.locationId);
  requireColumns(context, 'leads', ['id', 'locationId', 'serviceType', 'contactData']);
  const rules = await listServicePools(context.corePool, 'core', locationId);
  const readPool = await domainPool(context, 'leads', 'select');
  const limit = Math.min(Math.max(Number(input.limit) || 5000, 1), 5000);
  const [rows] = await readPool.query(
    `SELECT id, serviceType, contactData FROM leads WHERE locationId = ? ORDER BY id LIMIT ?`,
    [locationId, limit]
  );
  const changes = [];
  const byDestination = {};
  for (const row of rows) {
    const contact = parseJson(row.contactData);
    const next = classifyLeadRecord(contact, rules, row.serviceType);
    if (next === row.serviceType) continue;
    changes.push({ id: row.id, before: row.serviceType, after: next });
    byDestination[next] = (byDestination[next] || 0) + 1;
  }
  const dryRun = input.dryRun !== false;
  let updated = 0;
  if (!dryRun && changes.length) {
    const writePool = await domainPool(context, 'leads', 'update');
    const conn = typeof writePool.getConnection === 'function' ? await writePool.getConnection() : null;
    const executor = conn || writePool;
    try {
      if (conn) await conn.beginTransaction();
      for (const change of changes) {
        const [result] = await executor.query(
          'UPDATE leads SET serviceType = ? WHERE id = ? AND locationId = ? AND serviceType <=> ?',
          [change.after, change.id, locationId, change.before]
        );
        updated += Number(result.affectedRows) || 0;
      }
      if (conn) await conn.commit();
    } catch (error) {
      if (conn) await conn.rollback();
      throw error;
    } finally {
      if (conn) conn.release();
    }
  }
  return {
    dryRun,
    scanned: rows.length,
    changed: changes.length,
    updated,
    byDestination,
    samples: changes.slice(0, 50),
    truncated: rows.length === limit,
  };
}

async function recheckServicePool(context, input, fetchImpl = global.fetch) {
  const locationId = requireLocation(input.locationId);
  const serviceType = String(input.serviceType || '').trim().slice(0, 128);
  if (!serviceType) throw Object.assign(new Error('serviceType is required'), { status:400 });
  const dryRun = input.dryRun !== false;
  if (!dryRun && input.confirm !== true) {
    throw Object.assign(new Error('confirm=true is required to queue CRM rechecks'), { status:400 });
  }
  requireColumns(context, 'leads', ['id', 'locationId', 'serviceType', 'contactData']);
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
  const afterLeadId = String(input.afterLeadId || '').trim().slice(0, 191);
  const readPool = await domainPool(context, 'leads', 'select');
  const [leads] = await readPool.query(
    `SELECT id,serviceType,contactData FROM leads
     WHERE locationId=? AND serviceType=?${afterLeadId ? ' AND id>?' : ''} ORDER BY id LIMIT ?`,
    afterLeadId ? [locationId, serviceType, afterLeadId, limit] : [locationId, serviceType, limit]
  );
  if (!leads.length) return emptyRecheckResult(dryRun, serviceType);

  const integration = await recheckIntegration(context.corePool, context.apiKeyId, locationId);
  const credential = integrationCredential(integration);
  const ids = leads.map((lead) => String(lead.id));
  const placeholders = ids.map(() => '?').join(',');
  const [links] = await context.corePool.query(
    `SELECT lead_id AS leadId,external_record_id AS contactId,last_seen_at AS lastSeenAt
     FROM lead_source_links WHERE location_id=? AND lead_id IN (${placeholders})
     ORDER BY last_seen_at DESC`,
    [locationId, ...ids]
  );
  const contactByLead = new Map();
  for (const link of links) if (!contactByLead.has(String(link.leadId))) contactByLead.set(String(link.leadId), String(link.contactId));

  const result = emptyRecheckResult(dryRun, serviceType);
  result.scanned = leads.length;
  result.truncated = leads.length === limit;
  result.hasMore = result.truncated;
  result.nextCursor = String(leads[leads.length - 1].id);
  for (const lead of leads) {
    const leadId = String(lead.id);
    const contactId = contactByLead.get(leadId) || leadId;
    try {
      const contact = await fetchRecheckContact(integration, credential, contactId, fetchImpl);
      const tags = normalizedContactTags(contact);
      const servicePool = resolveDialerServicePool({ serviceType:lead.serviceType, contactData:contact });
      const poolTag = servicePool ? `cc-pool-${servicePool.replace(/_/g, '-')}` : null;
      const skipReason = recheckSkipReason(tags, poolTag);
      if (skipReason) {
        result.skipped += 1;
        pushSample(result, { leadId, contactId, servicePool, poolTag, status:'skipped', reason:skipReason });
        continue;
      }
      result.candidates += 1;
      if (dryRun) {
        pushSample(result, { leadId, contactId, servicePool, poolTag, status:'would_queue' });
        continue;
      }
      if (tags.includes('cc-recheck')) {
        await mutateRecheckTag(integration, credential, contactId, 'DELETE', fetchImpl);
        result.cleared += 1;
      }
      await mutateRecheckTag(integration, credential, contactId, 'POST', fetchImpl);
      result.queued += 1;
      pushSample(result, { leadId, contactId, servicePool, poolTag, status:'queued' });
    } catch (error) {
      result.failed += 1;
      pushSample(result, { leadId, contactId, status:'failed', reason:String(error.message || error).slice(0, 240) });
    }
  }
  return result;
}

async function recheckIntegration(pool, apiKeyId, locationId) {
  const [rows] = await pool.query(
    `SELECT i.* FROM crm_integrations i
     INNER JOIN crm_integration_grants g ON g.integration_id=i.id
     WHERE g.api_key_id=? AND g.allow_manage_leads=1 AND i.location_id=?
       AND i.is_enabled=1
     ORDER BY CASE WHEN i.provider='leadconnector-pit' THEN 0 ELSE 1 END,i.updated_at DESC`,
    [apiKeyId, locationId]
  );
  const selected = rows.find(isLeadConnectorIntegration) || rows.find(isSupportedLeadIntegration);
  if (!selected) throw Object.assign(new Error('No enabled GoHighLevel connection with lead-management permission is available'), { status:409 });
  return selected;
}

async function fetchRecheckContact(integration, credential, contactId, fetchImpl) {
  const response = await fetchImpl(`${String(integration.base_url || LEADCONNECTOR_ORIGIN).replace(/\/$/, '')}/contacts/${encodeURIComponent(contactId)}`, {
    headers:{ Accept:'application/json', Authorization:`Bearer ${credential}`, Version:'2021-07-28' },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Contact lookup returned HTTP ${response.status}`);
  return body.contact || body;
}

async function mutateRecheckTag(integration, credential, contactId, method, fetchImpl) {
  const response = await fetchImpl(`${String(integration.base_url || LEADCONNECTOR_ORIGIN).replace(/\/$/, '')}/contacts/${encodeURIComponent(contactId)}/tags`, {
    method,
    headers:{ Accept:'application/json', 'Content-Type':'application/json', Authorization:`Bearer ${credential}`, Version:'2021-07-28' },
    body:JSON.stringify({ tags:['cc-recheck'] }),
  });
  if (!response.ok) throw new Error(`cc-recheck ${method === 'POST' ? 'add' : 'remove'} returned HTTP ${response.status}`);
}

function normalizedContactTags(contact) {
  const raw = contact?.tags ?? contact?.contactTags ?? [];
  const tags = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
}

function recheckSkipReason(tags, poolTag) {
  if (!poolTag) return 'unsupported_service_pool';
  if (tags.includes(poolTag)) return 'proper_pool_tag_present';
  if (tags.includes('hawk-dialer-ready') && tags.some((tag) => tag.startsWith('cc-pool-'))) return 'already_queued';
  // Terminal CRM tags (call outcomes + sales Won/Lost/DNQ aliases) — shared with callCenterOutcomes.
  const { terminalSkipReason } = require('./callCenterOutcomes');
  for (const tag of tags) {
    const reason = terminalSkipReason(tag);
    if (reason) return reason;
  }
  return null;
}

function emptyRecheckResult(dryRun, serviceType) {
  return { dryRun, serviceType, scanned:0, candidates:0, cleared:0, queued:0, skipped:0, failed:0, truncated:false, hasMore:false, nextCursor:null, samples:[] };
}

function pushSample(result, sample) { if (result.samples.length < 50) result.samples.push(sample); }

async function getPoolManagement(context, locationId) {
  requireLocation(locationId);
  requireColumns(context, 'leads', ['locationId', 'status', 'assignedTo']);
  const rules = await listPoolRules(context.corePool, context.source, locationId);
  const pool = await domainPool(context, 'leads', 'select');
  const [counts] = await pool.query(
    `SELECT status, COUNT(*) AS total,
            SUM(CASE WHEN assignedTo IS NULL THEN 0 ELSE 1 END) AS assigned,
            SUM(CASE WHEN assignedTo IS NULL THEN 1 ELSE 0 END) AS unassigned
     FROM leads WHERE locationId = ? GROUP BY status`,
    [locationId]
  );
  const byStatus = new Map(counts.map((row) => [String(row.status), {
    total: Number(row.total), assigned: Number(row.assigned), unassigned: Number(row.unassigned),
  }]));
  const routed = new Set();
  const pools = rules.map((rule) => {
    const metrics = { total: 0, assigned: 0, unassigned: 0 };
    for (const status of rule.statusValues) {
      routed.add(status);
      const value = byStatus.get(status);
      if (value) for (const key of Object.keys(metrics)) metrics[key] += value[key];
    }
    return { ...rule, ...metrics };
  });
  const unmapped = counts.filter((row) => !routed.has(String(row.status))).map((row) => ({
    status: row.status, total: Number(row.total), assigned: Number(row.assigned), unassigned: Number(row.unassigned),
  }));
  let channelPools = [];
  if (context.source === 'core') {
    const [channelRows] = await context.corePool.query(
      `SELECT
         SUM(CASE WHEN emailMarketingStatus = 'available' THEN 1 ELSE 0 END) AS emailTotal,
         SUM(CASE WHEN smsMarketingStatus = 'available' THEN 1 ELSE 0 END) AS smsTotal
       FROM leads WHERE locationId = ?`,
      [locationId]
    );
    channelPools = [
      marketingChannelPool('email', 'Email', Number(channelRows[0]?.emailTotal) || 0, '#8b5cf6'),
      marketingChannelPool('sms', 'SMS', Number(channelRows[0]?.smsTotal) || 0, '#06b6d4'),
    ];
  }
  return { pools, unmapped, channelPools };
}

function marketingChannelPool(channel, label, total, color) {
  return { channel, poolKey:`channel_${channel}`, label, total, assigned:0, unassigned:total, color };
}

async function savePoolRule(context, poolKey, input) {
  const locationId = requireLocation(input.locationId);
  return upsertPoolRule(context.corePool, context.source, locationId, poolKey, input);
}

async function moveLeadsToPool(context, input) {
  const locationId = requireLocation(input.locationId);
  requireColumns(context, 'leads', ['id', 'locationId', 'status', 'assignedTo', 'dncStatus']);
  const ids = normalizeIds(input.leadIds);
  const rule = await getPoolRule(context.corePool, context.source, locationId, String(input.poolKey || ''));
  if (!rule || !rule.isEnabled) throw Object.assign(new Error('Destination pool not found or disabled'), { status: 404 });
  const readPool = await domainPool(context, 'leads', 'select');
  const writePool = await domainPool(context, 'leads', 'update');
  let user = null;
  if (rule.assignmentPolicy === 'require_user') {
    if (!input.userId) throw Object.assign(new Error(`${rule.label} requires an assigned user`), { status: 400 });
    requireColumns(context, 'users', ['id', 'locationId', 'username']);
    const usersPool = await domainPool(context, 'users', 'select');
    user = await one(usersPool, 'SELECT id, username FROM users WHERE id = ? AND locationId = ? LIMIT 1', [input.userId, locationId]);
    if (!user) throw Object.assign(new Error('User not found in selected location/source'), { status: 404 });
  }
  const placeholders = ids.map(() => '?').join(',');
  const [before] = await readPool.query(
    `SELECT id, status, assignedTo, dncStatus FROM leads WHERE locationId = ? AND id IN (${placeholders})`,
    [locationId, ...ids]
  );
  const lifecycleRules = await listPoolRules(context.corePool, context.source, locationId);
  assertDncAssignmentAllowed(before, rule, lifecycleRules);
  if (rule.assignmentPolicy === 'clear') {
    await writePool.query(
      `UPDATE leads SET status = ?, assignedTo = NULL WHERE locationId = ? AND id IN (${placeholders})`,
      [rule.destinationStatus, locationId, ...ids]
    );
  } else if (rule.assignmentPolicy === 'require_user') {
    await writePool.query(
      `UPDATE leads SET status = ?, assignedTo = ? WHERE locationId = ? AND id IN (${placeholders})`,
      [rule.destinationStatus, user.id, locationId, ...ids]
    );
  } else {
    await writePool.query(
      `UPDATE leads SET status = ? WHERE locationId = ? AND id IN (${placeholders})`,
      [rule.destinationStatus, locationId, ...ids]
    );
  }
  const [after] = await readPool.query(
    `SELECT id, status, assignedTo, dncStatus FROM leads WHERE locationId = ? AND id IN (${placeholders})`,
    [locationId, ...ids]
  );
  return { before, after, affected: after.length, pool: rule };
}

async function listLeads(context, input) {
  const locationId = requireLocation(input.locationId);
  requireColumns(context, 'leads', ['id', 'locationId', 'serviceType', 'status', 'contactData', 'assignedTo', 'lastContacted', 'dncStatus', 'dncCheckedAt', 'dateAdded']);
  const pool = await domainPool(context, 'leads', 'select');
  const where = ['locationId = ?'];
  const params = [locationId];
  for (const [key, column] of [['status', 'status'], ['dncStatus', 'dncStatus'], ['serviceType', 'serviceType'], ['assignedTo', 'assignedTo']]) {
    if (!input[key]) continue;
    if (key === 'status' && String(input.status).startsWith('pool:')) {
      const rule = await getPoolRule(context.corePool, context.source, locationId, String(input.status).slice(5));
      if (!rule) throw Object.assign(new Error('Lead pool filter not found'), { status: 404 });
      where.push(`\`status\` IN (${rule.statusValues.map(() => '?').join(',')})`);
      params.push(...rule.statusValues);
    } else {
      where.push(`\`${column}\` = ?`); params.push(String(input[key]));
    }
  }
  if (input.dncReviewRequired !== undefined && input.dncReviewRequired !== '') {
    if (context.source !== 'core') {
      throw Object.assign(new Error('DNC review filtering is available only for the core lead store'), { status:409 });
    }
    where.push('dncReviewRequired = ?');
    params.push(String(input.dncReviewRequired) === '1' ? 1 : 0);
  }
  if (input.marketingChannel) {
    if (context.source !== 'core') {
      throw Object.assign(new Error('Marketing channel filtering is available only for the core lead store'), { status:409 });
    }
    const channelColumns = {
      phone:'phoneMarketingStatus', email:'emailMarketingStatus', sms:'smsMarketingStatus',
    };
    const channelColumn = channelColumns[String(input.marketingChannel).toLowerCase()];
    if (!channelColumn) throw Object.assign(new Error('Unsupported marketing channel filter'), { status:400 });
    where.push(`${channelColumn} = 'available'`);
  }
  if (input.search) { where.push('contactData LIKE ?'); params.push(`%${String(input.search).slice(0, 128)}%`); }
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
  const offset = Math.max(Number(input.offset) || 0, 0);
  const dncEvidenceColumns = context.source === 'core'
    ? `, dncSource, dncResultCode, dncReason, dncDecisionCategory, dncReviewRequired,
       phoneMarketingStatus, emailMarketingStatus, smsMarketingStatus,
       marketingChannelSource, marketingChannelTags, marketingChannelsCheckedAt`
    : '';
  const [rows] = await pool.query(
    `SELECT id, locationId, serviceType, status, contactData, assignedTo, lastContacted,
            dncStatus, dncCheckedAt${dncEvidenceColumns}, dateAdded
     FROM leads WHERE ${where.join(' AND ')} ORDER BY dateAdded DESC, id LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [counts] = await pool.query(`SELECT COUNT(*) AS total FROM leads WHERE ${where.join(' AND ')}`, params);
  return { rows: rows.map(publicLead), total: Number(counts[0].total), limit, offset };
}

async function listDncScreening(context, input) {
  requireCoreSource(context, 'DNC screening');
  const locationId = requireLocation(input.locationId);
  requireColumns(context, 'leads', [
    'id', 'serviceType', 'contactData', 'dncStatus', 'dateAdded',
  ]);
  const rule = await getPoolRule(context.corePool, context.source, locationId, 'dnc_pending');
  const statuses = rule?.statusValues?.length ? rule.statusValues : ['dnc_pending'];
  const dncStates = normalizeDncQueueStates(input.dncStates);
  // This endpoint renders a review table; it must not return the complete CRM
  // contact document or create oversized Sentinel evidence records.
  const limit = Math.min(Math.max(Number(input.limit) || 40, 1), 40);
  const offset = Math.max(Number(input.offset) || 0, 0);
  const statusPlaceholders = statuses.map(() => '?').join(',');
  const statePlaceholders = dncStates.map(() => '?').join(',');
  const params = [locationId, ...dncStates, ...statuses];
  const [rows] = await context.corePool.query(
    `SELECT id, serviceType, contactData, dncStatus, dncResultCode, dncReason,
            dncDecisionCategory, dncReviewRequired, dateAdded
     FROM leads
     WHERE locationId = ? AND dncStatus IN (${statePlaceholders}) AND status IN (${statusPlaceholders})
     ORDER BY CASE dncStatus WHEN 'pending' THEN 0 ELSE 1 END, dateAdded DESC, id LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [counts] = await context.corePool.query(
    `SELECT COUNT(*) AS total,
            SUM(dncStatus = 'pending') AS pending,
            SUM(dncStatus = 'review') AS review,
            SUM(dncStatus = 'review' AND dncResultCode = 'B'
                AND dncDecisionCategory = 'configuration_or_coverage') AS releasable
     FROM leads
     WHERE locationId = ? AND dncStatus IN (${statePlaceholders}) AND status IN (${statusPlaceholders})`,
    params
  );
  return {
    rows:rows.map(publicDncScreeningLead),
    total:Number(counts[0]?.total) || 0,
    counts:{
      pending:Number(counts[0]?.pending) || 0,
      review:Number(counts[0]?.review) || 0,
      releasable:Number(counts[0]?.releasable) || 0,
    },
    limit,
    offset,
    nextOffset:offset + rows.length < (Number(counts[0]?.total) || 0) ? offset + rows.length : null,
  };
}

function publicDncScreeningLead(row) {
  const contact = parseJson(row.contactData);
  const record = contact && typeof contact === 'object' && !Array.isArray(contact) ? contact : {};
  const contactName = compactDncQueueText(
    record.name || [record.firstName, record.lastName].filter(Boolean).join(' ') || row.id,
    80
  );
  return {
    id:String(row.id),
    contactName:contactName || String(row.id),
    serviceType:compactDncQueueText(row.serviceType, 40),
    dateAdded:row.dateAdded || null,
    dncStatus:String(row.dncStatus || 'pending'),
    dncResultCode:row.dncResultCode || null,
    dncReason:compactDncQueueText(row.dncReason, 96),
    dncDecisionCategory:compactDncQueueText(row.dncDecisionCategory, 64),
    dncReviewRequired:Number(row.dncReviewRequired) === 1,
  };
}

function compactDncQueueText(value, maxBytes) {
  if (value == null || value === '') return null;
  const text = String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let output = '';
  for (const character of text) {
    if (Buffer.byteLength(output + character) > maxBytes) break;
    output += character;
  }
  return output || null;
}

function normalizeDncQueueStates(value) {
  const supplied = Array.isArray(value) ? value.map(String) : [];
  const states = [...new Set(supplied.filter((state) => ['pending', 'review'].includes(state)))];
  return states.length ? states : ['pending', 'review'];
}

async function requirePendingDncLead(context, leadId, locationId) {
  const lead = await one(
    context.corePool,
    `SELECT id, locationId, status, dncStatus FROM leads
     WHERE id = ? AND locationId = ? LIMIT 1`,
    [leadId, locationId]
  );
  if (!lead) throw Object.assign(new Error('Lead not found'), { status: 404 });
  if (!['pending', 'review'].includes(String(lead.dncStatus || 'pending'))) {
    throw Object.assign(new Error('Lead no longer requires DNC screening'), { status: 409 });
  }
  return lead;
}

async function refreshDncScreeningLead(context, input) {
  requireCoreSource(context, 'DNC screening');
  const locationId = requireLocation(input.locationId);
  const leadId = String(input.leadId || '').trim();
  if (!leadId) throw Object.assign(new Error('leadId is required'), { status: 400 });
  await requirePendingDncLead(context, leadId, locationId);
  const result = await checkDncTags(context, locationId, [leadId]);
  const selected = result.results.find((item) => item.leadId === leadId);
  if (!selected || selected.error) {
    throw Object.assign(new Error(selected?.error || 'CRM tag check did not return this lead'), { status: 409 });
  }
  return selected;
}

async function refreshDncScreening(context, input) {
  requireCoreSource(context, 'DNC screening');
  const locationId = requireLocation(input.locationId);
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
  const queue = await listDncScreening(context, { locationId, limit, dncStates:['pending'] });
  const summary = await checkDncTags(context, locationId, queue.rows.map((lead) => lead.id));
  const remaining = await listDncScreening(context, { locationId, limit: 1, dncStates:['pending'] });
  return { ...summary, remaining: remaining.counts.pending };
}

async function scrubDncScreeningLead(context, input) {
  requireCoreSource(context, 'DNC screening');
  const locationId = requireLocation(input.locationId);
  const leadId = String(input.leadId || '').trim();
  if (!leadId) throw Object.assign(new Error('leadId is required'), { status: 400 });
  await requirePendingDncLead(context, leadId, locationId);
  const result = await scrubDncLeads(context, locationId, [leadId], {
    expectedStates:['pending', 'review'],
  });
  const selected = result.results.find((item) => item.leadId === leadId);
  if (!selected || selected.error) {
    throw Object.assign(new Error(selected?.error || 'DNCScrub did not return this lead'), {
      status: selected?.code === 'DNC_PHONE_REQUIRED' ? 409 : 502,
      code: selected?.code || 'DNC_SCRUB_RESULT_MISSING',
    });
  }
  return selected;
}

async function scrubDncScreening(context, input) {
  requireCoreSource(context, 'DNC screening');
  const locationId = requireLocation(input.locationId);
  const providerConfig = getDncScrubConfig();
  const requestedLimit = Math.min(Math.max(Number(input.limit) || providerConfig.batchSize, 1), 500);
  const limit = Math.min(requestedLimit, providerConfig.batchSize);
  const rule = await getPoolRule(context.corePool, context.source, locationId, 'dnc_pending');
  const statuses = rule?.statusValues?.length ? rule.statusValues : ['dnc_pending'];
  let cutoff = normalizeRescrubCutoff(input.cutoff);
  if (!cutoff) {
    const [clockRows] = await context.corePool.query(
      `SELECT DATE_FORMAT(CURRENT_TIMESTAMP, '%Y-%m-%d %H:%i:%s') AS cutoff`
    );
    cutoff = normalizeRescrubCutoff(clockRows[0]?.cutoff);
    if (!cutoff) throw Object.assign(new Error('Unable to start the DNC pending scrub run'), { status:503 });
  }
  // The cutoff ledger guarantees that B reviews and unresolved pending results
  // are each attempted once, so neither can starve the rest of the queue.
  const statusPlaceholders = statuses.map(() => '?').join(',');
  const baseWhere = `locationId = ? AND dncStatus = 'pending'
    AND status IN (${statusPlaceholders})
    AND (dncLastRescrubAt IS NULL OR dncLastRescrubAt < ?)`;
  const params = [locationId, ...statuses, cutoff];
  const [candidates] = await context.corePool.query(
    `SELECT id FROM leads WHERE ${baseWhere}
     ORDER BY COALESCE(dncLastRescrubAt, '1970-01-01 00:00:00'), dateAdded, id LIMIT ?`,
    [...params, limit]
  );
  const summary = await scrubDncLeads(
    context,
    locationId,
    candidates.map((lead) => String(lead.id)),
    { expectedState:'pending', markAttempt:true }
  );
  const [remainingRows] = await context.corePool.query(
    `SELECT COUNT(*) AS total FROM leads WHERE ${baseWhere}`,
    params
  );
  const queueTotals = await listDncScreening(context, { locationId, limit:1 });
  return {
    ...summary,
    cutoff,
    remaining:Number(remainingRows[0]?.total) || 0,
    pendingTotal:queueTotals.counts.pending,
    reviewRemaining:queueTotals.counts.review,
    providerBatchSize:candidates.length,
    providerBatchLimit:providerConfig.batchSize,
    providerRequestsPerMinute:providerConfig.requestsPerMinute,
  };
}

async function rescrubDncReviews(context, input) {
  requireCoreSource(context, 'DNC review re-scrubbing');
  if (input.confirm !== 'RESCRUB_DNC_REVIEWS') {
    throw Object.assign(new Error('Explicit DNC review re-scrub confirmation is required'), { status:400 });
  }
  const locationId = requireLocation(input.locationId);
  const providerConfig = getDncScrubConfig();
  const requestedLimit = Math.min(Math.max(Number(input.limit) || providerConfig.batchSize, 1), 500);
  const limit = Math.min(requestedLimit, providerConfig.batchSize);
  const rule = await getPoolRule(context.corePool, context.source, locationId, 'dnc_pending');
  const statuses = rule?.statusValues?.length ? rule.statusValues : ['dnc_pending'];
  let cutoff = normalizeRescrubCutoff(input.cutoff);
  if (!cutoff) {
    const [clockRows] = await context.corePool.query(
      `SELECT DATE_FORMAT(CURRENT_TIMESTAMP, '%Y-%m-%d %H:%i:%s') AS cutoff`
    );
    cutoff = normalizeRescrubCutoff(clockRows[0]?.cutoff);
    if (!cutoff) throw Object.assign(new Error('Unable to start the DNC review re-scrub run'), { status:503 });
  }
  const statusPlaceholders = statuses.map(() => '?').join(',');
  const baseWhere = `locationId = ? AND dncStatus = 'review'
    AND status IN (${statusPlaceholders})
    AND (dncLastRescrubAt IS NULL OR dncLastRescrubAt < ?)`;
  const params = [locationId, ...statuses, cutoff];
  const [candidates] = await context.corePool.query(
    `SELECT id FROM leads WHERE ${baseWhere}
     ORDER BY COALESCE(dncLastRescrubAt, '1970-01-01 00:00:00'), dncCheckedAt, id LIMIT ?`,
    [...params, limit]
  );
  const summary = await scrubDncLeads(
    context,
    locationId,
    candidates.map((lead) => String(lead.id)),
    { expectedState:'review', rescrub:true }
  );
  const [remainingRows] = await context.corePool.query(
    `SELECT COUNT(*) AS total FROM leads WHERE ${baseWhere}`,
    params
  );
  return {
    ...summary,
    cutoff,
    remaining:Number(remainingRows[0]?.total) || 0,
    released:summary.results.filter((item) => !item.error && item.dncStatus === 'clean').length,
    movedToDnc:summary.results.filter((item) => !item.error && item.dncStatus === 'blocked').length,
    stillReview:summary.results.filter((item) => !item.error && item.dncStatus === 'review').length,
    changed:summary.results.filter((item) => item.changed).length,
    providerBatchSize:candidates.length,
    providerBatchLimit:providerConfig.batchSize,
    providerRequestsPerMinute:providerConfig.requestsPerMinute,
  };
}

async function releaseDncReviews(context, input) {
  requireCoreSource(context, 'DNC review release');
  if (input.confirm !== 'RELEASE_DNC_B_REVIEWS') {
    throw Object.assign(new Error('Explicit DNC B-review release confirmation is required'), { status:400 });
  }
  const locationId = requireLocation(input.locationId);
  const releaseReason = String(input.releaseReason || '').replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 255);
  if (releaseReason.length < 10) {
    throw Object.assign(new Error('A release reason of at least 10 characters is required'), { status:400 });
  }
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 50);
  const rules = await listPoolRules(context.corePool, context.source, locationId);
  const pendingRule = rules.find((item) => item.isEnabled && item.poolKey === 'dnc_pending');
  const destination = rules.find((item) => item.isEnabled && item.isAssignable);
  if (!pendingRule?.statusValues?.length || !destination) {
    throw Object.assign(new Error('DNC Screening or an assignable destination pool is not configured'), { status:409 });
  }
  const statusPlaceholders = pendingRule.statusValues.map(() => '?').join(',');
  const conn = await context.corePool.getConnection();
  let candidates = [];
  try {
    await conn.beginTransaction();
    [candidates] = await conn.query(
      `SELECT id,dncResultCode,dncReason,dncDecisionCategory,dncReviewRequired
       FROM leads
       WHERE locationId = ? AND dncStatus = 'review' AND dncResultCode = 'B'
         AND dncDecisionCategory = 'configuration_or_coverage'
         AND status IN (${statusPlaceholders})
       ORDER BY dncCheckedAt,id LIMIT ? FOR UPDATE`,
      [locationId, ...pendingRule.statusValues, limit]
    );
    if (candidates.length) {
      const ids = candidates.map((lead) => String(lead.id));
      const idPlaceholders = ids.map(() => '?').join(',');
      await conn.query(
        `UPDATE leads SET dncStatus = 'clean', dncCheckedAt = CURRENT_TIMESTAMP,
           dncSource = 'owl_review_override',
           dncDecisionCategory = 'manual_configuration_override', dncReviewRequired = 0,
           phoneMarketingStatus = 'available', status = ?, assignedTo = NULL
         WHERE locationId = ? AND dncStatus = 'review' AND dncResultCode = 'B'
           AND dncDecisionCategory = 'configuration_or_coverage'
           AND id IN (${idPlaceholders})`,
        [destination.destinationStatus, locationId, ...ids]
      );
      const values = ids.map(() => '(?,?,?,?,?,?)').join(',');
      const eventParams = ids.flatMap((leadId) => [
        crypto.randomUUID(), context.apiKeyId, leadId, leadId, locationId, 'manual_review_release',
      ]);
      await conn.query(
        `INSERT INTO dnc_pulse_events
           (id,api_key_id,lead_id,external_contact_id,location_id,action)
         VALUES ${values}`,
        eventParams
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  const [remainingRows] = await context.corePool.query(
    `SELECT COUNT(*) AS total FROM leads
     WHERE locationId = ? AND dncStatus = 'review' AND dncResultCode = 'B'
       AND dncDecisionCategory = 'configuration_or_coverage'
       AND status IN (${statusPlaceholders})`,
    [locationId, ...pendingRule.statusValues]
  );
  const results = candidates.map((lead) => ({
    leadId:String(lead.id),
    dncStatus:'clean',
    source:'owl_review_override',
    resultCode:'B',
    resultLabel:'Administrative B-review release',
    reason:lead.dncReason || 'Provider configuration / coverage hold',
    decisionCategory:'manual_configuration_override',
    reviewRequired:false,
  }));
  const crmSync = await syncDncResultsToCrm(context.corePool, {
    apiKeyId:context.apiKeyId,
    locationId,
    results,
    fetchImpl:context.fetchImpl,
  });
  return {
    released:results.length,
    remaining:Number(remainingRows[0]?.total) || 0,
    destinationPool:destination.poolKey,
    destinationStatus:destination.destinationStatus,
    releaseReason,
    eligibleResultCode:'B',
    eligibleCategory:'configuration_or_coverage',
    crmSync,
  };
}

async function getDncRescrubStatus(context, input) {
  requireCoreSource(context, 'DNC pool re-scrubbing');
  const locationId = requireLocation(input.locationId);
  const rule = await getPoolRule(context.corePool, context.source, locationId, 'dnc');
  if (!rule?.statusValues?.length) {
    throw Object.assign(new Error('The DNC pool is not configured'), { status:409 });
  }
  const placeholders = rule.statusValues.map(() => '?').join(',');
  const [rows] = await context.corePool.query(
    `SELECT COUNT(*) AS total, MAX(dncLastRescrubAt) AS lastRescrubAt
     FROM leads WHERE locationId = ? AND dncStatus = 'blocked'
       AND status IN (${placeholders})`,
    [locationId, ...rule.statusValues]
  );
  return {
    total:Number(rows[0]?.total) || 0,
    lastRescrubAt:rows[0]?.lastRescrubAt || null,
  };
}

async function rescrubDncPool(context, input) {
  requireCoreSource(context, 'DNC pool re-scrubbing');
  if (input.confirm !== 'RESCRUB_DNC_POOL') {
    throw Object.assign(new Error('Explicit DNC pool re-scrub confirmation is required'), { status:400 });
  }
  const locationId = requireLocation(input.locationId);
  const providerConfig = getDncScrubConfig();
  const requestedLimit = Math.min(Math.max(Number(input.limit) || providerConfig.batchSize, 1), 500);
  const limit = Math.min(requestedLimit, providerConfig.batchSize);
  const rule = await getPoolRule(context.corePool, context.source, locationId, 'dnc');
  if (!rule?.statusValues?.length) {
    throw Object.assign(new Error('The DNC pool is not configured'), { status:409 });
  }
  let cutoff = normalizeRescrubCutoff(input.cutoff);
  if (!cutoff) {
    const [clockRows] = await context.corePool.query(
      `SELECT DATE_FORMAT(CURRENT_TIMESTAMP, '%Y-%m-%d %H:%i:%s') AS cutoff`
    );
    cutoff = normalizeRescrubCutoff(clockRows[0]?.cutoff);
    if (!cutoff) throw Object.assign(new Error('Unable to start the DNC re-scrub run'), { status:503 });
  }
  const statusPlaceholders = rule.statusValues.map(() => '?').join(',');
  const baseWhere = `locationId = ? AND dncStatus = 'blocked'
    AND status IN (${statusPlaceholders})
    AND (dncLastRescrubAt IS NULL OR dncLastRescrubAt < ?)`;
  const params = [locationId, ...rule.statusValues, cutoff];
  const [candidates] = await context.corePool.query(
    `SELECT id FROM leads WHERE ${baseWhere}
     ORDER BY COALESCE(dncLastRescrubAt, '1970-01-01 00:00:00'), dncCheckedAt, id LIMIT ?`,
    [...params, limit]
  );
  const summary = await scrubDncLeads(
    context,
    locationId,
    candidates.map((lead) => String(lead.id)),
    { expectedState:'blocked', rescrub:true }
  );
  const [remainingRows] = await context.corePool.query(
    `SELECT COUNT(*) AS total FROM leads WHERE ${baseWhere}`,
    params
  );
  const remaining = Number(remainingRows[0]?.total) || 0;
  return {
    ...summary,
    cutoff,
    remaining,
    released:summary.results.filter((item) => !item.error && item.dncStatus === 'clean').length,
    stillBlocked:summary.results.filter((item) => !item.error && item.dncStatus === 'blocked').length,
    heldForReview:summary.results.filter((item) => !item.error && item.dncStatus === 'review').length,
    changed:summary.results.filter((item) => item.changed).length,
    providerBatchSize:candidates.length,
    providerBatchLimit:providerConfig.batchSize,
    providerRequestsPerMinute:providerConfig.requestsPerMinute,
  };
}

async function syncDncCrmBacklog(context, input) {
  requireCoreSource(context, 'DNC CRM synchronization');
  const locationId = requireLocation(input.locationId);
  const limit = Math.min(Math.max(Number(input.limit) || 500, 1), 500);
  const pendingWhere = `l.locationId=? AND l.dncSource IN ('dncscrub_api','owl_review_override')
    AND l.dncStatus IN ('clean','blocked','review')
    AND NOT EXISTS (
      SELECT 1 FROM dnc_pulse_events e
      WHERE e.location_id=l.locationId AND e.lead_id=l.id
        AND e.action IN ('crm_sync_clean','crm_sync_blocked')
        AND e.created_at>=l.dncCheckedAt
    )`;
  const [leads] = await context.corePool.query(
    `SELECT l.id,l.dncStatus,l.dncCheckedAt,l.dncSource,l.dncResultCode,l.dncReason,
            l.dncDecisionCategory,l.dncReviewRequired
     FROM leads l WHERE ${pendingWhere}
     ORDER BY l.dncCheckedAt,l.id LIMIT ?`,
    [locationId, limit]
  );
  const results = leads.map((lead) => ({
    leadId:String(lead.id),
    dncStatus:String(lead.dncStatus),
    resultCode:lead.dncResultCode || null,
    resultLabel:RESULT_CODES[String(lead.dncResultCode || '').toUpperCase()]?.label || String(lead.dncStatus),
    reason:lead.dncReason || null,
    decisionCategory:lead.dncDecisionCategory || null,
    reviewRequired:Number(lead.dncReviewRequired) === 1,
    source:lead.dncSource || 'dncscrub_api',
  }));
  const crmSync = await syncDncResultsToCrm(context.corePool, {
    apiKeyId:context.apiKeyId,
    locationId,
    results,
    fetchImpl:context.fetchImpl,
  });
  const [remainingRows] = await context.corePool.query(
    `SELECT COUNT(*) AS total FROM leads l WHERE ${pendingWhere}`,
    [locationId]
  );
  return { processed:results.length, crmSync, remaining:Number(remainingRows[0]?.total) || 0, results };
}

function normalizeRescrubCutoff(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text : null;
}

async function scrubDncLeads(context, locationId, leadIds, options = {}) {
  if (!leadIds.length) return emptyDncSummary();
  const expectedStates = Array.isArray(options.expectedStates) && options.expectedStates.length
    ? options.expectedStates.map(String) : [String(options.expectedState || 'pending')];
  const placeholders = leadIds.map(() => '?').join(',');
  const [leads] = await context.corePool.query(
    `SELECT id, contactData, dncStatus, dncCheckedAt, dncSource, dncResultCode,
            dncReason, dncDecisionCategory, dncReviewRequired
     FROM leads
     WHERE locationId = ? AND id IN (${placeholders})`,
    [locationId, ...leadIds]
  );
  const byId = new Map(leads.map((lead) => [String(lead.id), lead]));
  const prepared = [];
  const ready = [];
  const results = [];
  const attemptedIds = [];
  for (const leadId of leadIds) {
    const lead = byId.get(String(leadId));
    if (!lead) {
      results.push({ leadId, error:'Lead not found', code:'DNC_LEAD_NOT_FOUND' });
      continue;
    }
    const currentState = String(lead.dncStatus || 'pending');
    if (!expectedStates.includes(currentState)) {
      results.push({ leadId, error:`Lead is no longer ${expectedStates.join(' or ')}`, code:'DNC_STATE_CHANGED' });
      continue;
    }
    attemptedIds.push(String(leadId));
    const record = parseJson(lead.contactData);
    const phoneCandidates = extractPhoneCandidates(record);
    if (!phoneCandidates.length) {
      ready.push({
        leadId:String(leadId),
        provider:{
          state:'pending', resultCode:'PHONE', resultLabel:'Phone required',
          decisionCategory:'invalid_contact_data', reviewRequired:true,
          reason:'Lead has no valid 10-digit phone number; lead remains pending',
          localError:true, errorCode:'DNC_PHONE_REQUIRED',
        },
      });
      continue;
    }
    prepared.push({ leadId:String(leadId), record, phoneCandidates });
  }
  if (prepared.length) {
    const providerConfig = getDncScrubConfig();
    const phones = [...new Set(prepared.flatMap((item) => item.phoneCandidates.map((candidate) => candidate.phone)))];
    const providerResults = [];
    for (let offset = 0; offset < phones.length; offset += providerConfig.batchSize) {
      providerResults.push(...await scrubPhoneNumbers(
        phones.slice(offset, offset + providerConfig.batchSize),
        { config:providerConfig, fetchImpl:context.fetchImpl }
      ));
    }
    const byPhone = new Map(providerResults.map((item) => [item.phone, item]));
    for (const item of prepared) {
      const checked = item.phoneCandidates.map((candidate) => ({
        candidate,
        provider:byPhone.get(candidate.phone) || null,
      }));
      const selected = checked.find((entry) => entry.provider?.state === 'clean') || null;
      const provider = selected?.provider || aggregateFailure(checked);
      const promoted = Boolean(selected && selected.candidate.slot !== 'primary');
      const phoneAudit = buildDncPhoneAudit(checked, selected);
      if (!options.rescrub && provider.state === 'pending' && provider.resultCode === 'MISSING') {
        results.push({
          leadId:item.leadId,
          error:'DNCScrub omitted one or more phone results; lead remains pending',
          code:'DNC_SCRUB_RESULT_MISSING',
        });
        continue;
      }
      if (provider.state === 'pending') {
        provider.warning = options.rescrub
          ? 'One or more phone results were unresolved; the prior block remains in force'
          : 'One or more phone results were unresolved; lead remains pending';
        provider.errorCode = provider.resultCode === 'MISSING'
          ? 'DNC_SCRUB_RESULT_MISSING' : 'DNC_SCRUB_RESULT_UNKNOWN';
      }
      ready.push({
        ...item,
        provider,
        promoted,
        selectedSlot:selected?.candidate.slot || null,
        contactData:promoted ? swapPrimaryPhone(item.record, selected.candidate) : null,
        phoneAudit,
      });
    }
  }
  // A cutoff-bound pending run must advance even when DNCScrub omits every
  // requested phone. Persist the attempt ledger before returning those errors;
  // otherwise the same omitted batch is selected forever and later leads starve.
  if (!ready.length && !(options.markAttempt && attemptedIds.length)) {
    return summarizeDncResults(results);
  }

  const [sourceLinks] = await context.corePool.query(
    `SELECT lead_id, external_record_id FROM lead_source_links
     WHERE location_id = ? AND lead_id IN (${placeholders}) ORDER BY first_seen_at`,
    [locationId, ...leadIds]
  );
  const externalByLead = new Map();
  for (const link of sourceLinks) {
    if (!externalByLead.has(String(link.lead_id))) {
      externalByLead.set(String(link.lead_id), String(link.external_record_id));
    }
  }
  const rules = await listPoolRules(context.corePool, context.source, locationId);
  const conn = await context.corePool.getConnection();
  try {
    await conn.beginTransaction();
    if ((options.rescrub || options.markAttempt) && attemptedIds.length) {
      await conn.query(
        `UPDATE leads SET dncLastRescrubAt = CURRENT_TIMESTAMP
         WHERE locationId = ? AND id IN (${attemptedIds.map(() => '?').join(',')})`,
        [locationId, ...attemptedIds]
      );
    }
    for (const item of ready) {
      const lead = byId.get(String(item.leadId));
      const previous = dncEvidenceSnapshot(lead);
      const preservePriorBlock = options.rescrub && item.provider.state === 'pending';
      if (item.contactData) {
        await conn.query(
          'UPDATE leads SET contactData = ? WHERE id = ? AND locationId = ?',
          [JSON.stringify(item.contactData), item.leadId, locationId]
        );
      }
      let applied = true;
      if (!preservePriorBlock) {
        applied = await applyDncScreeningStatus(
          conn,
          item.leadId,
          locationId,
          { state:item.provider.state, tags:[] },
          rules,
          {
            source:item.provider.localError ? 'owl_validation' : 'dncscrub_api',
            resultCode:item.provider.resultCode,
            reason:item.provider.reason,
            decisionCategory:item.provider.decisionCategory,
            reviewRequired:item.provider.reviewRequired,
            allowBlockedRelease:Boolean(options.rescrub),
            expectedDncStatus:String(lead.dncStatus || 'pending'),
          }
        );
      }
      if (applied === false) {
        results.push({
          leadId:item.leadId,
          dncStatus:previous.dncStatus,
          previous,
          error:'Lead DNC state changed during the provider request; no re-scrub result was applied',
          code:'DNC_STATE_CHANGED',
        });
        continue;
      }
      let routedNoPhone = false;
      if (item.provider.localError) {
        const channels = await applyMarketingChannelStatus(
          conn, item.leadId, locationId, parseJson(lead?.contactData), rules
        );
        routedNoPhone = !channels.hasPhone;
      }
      await conn.query(
        `INSERT INTO dnc_pulse_events
           (id, api_key_id, lead_id, external_contact_id, location_id, action)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), context.apiKeyId, item.leadId,
          externalByLead.get(item.leadId) || item.leadId, locationId,
          options.rescrub
            ? preservePriorBlock ? 'api_rescrub_unresolved'
              : item.provider.state === 'blocked' ? 'api_rescrub_blocked'
                : item.provider.state === 'review' ? 'api_rescrub_review' : 'api_rescrub_released'
            : item.provider.localError ? 'validation_no_phone'
              : item.provider.state === 'blocked' ? 'api_scrub_blocked'
                : item.provider.state === 'review' ? 'api_scrub_review'
                : item.provider.state === 'clean' ? 'api_scrub_clean' : 'api_scrub_pending']
      );
      const result = {
        leadId:item.leadId,
        dncStatus:routedNoPhone ? 'pending' : preservePriorBlock ? previous.dncStatus : item.provider.state,
        resultCode:item.provider.resultCode,
        resultLabel:item.provider.resultLabel,
        reason:item.provider.reason,
        decisionCategory:item.provider.decisionCategory,
        reviewRequired:Boolean(item.provider.reviewRequired),
        lineType:item.provider.lineType,
        region:item.provider.region,
        ebrType:item.provider.ebrType,
        callingWindow:item.provider.callingWindow,
        doNotCallToday:item.provider.doNotCallToday,
        isWirelessOrVoip:item.provider.isWirelessOrVoip,
        source:item.provider.localError ? 'owl_validation' : 'dncscrub_api',
        previous,
        phonePromoted:Boolean(item.promoted),
        selectedPhoneSlot:item.selectedSlot || null,
      };
      if (item.phoneAudit) {
        Object.defineProperty(result, 'phoneAudit', {
          value:item.phoneAudit,
          enumerable:false,
        });
      }
      result.changed = !preservePriorBlock && dncEvidenceChanged(previous, result);
      if (item.provider.localError || item.provider.warning) {
        result.error = item.provider.warning || item.provider.reason;
        result.code = item.provider.errorCode;
      }
      results.push(result);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  const summary = summarizeDncResults(results);
  summary.crmSync = await syncDncResultsToCrm(context.corePool, {
    apiKeyId:context.apiKeyId,
    locationId,
    results:summary.results,
    fetchImpl:context.fetchImpl,
  });
  return summary;
}

function buildDncPhoneAudit(checked, selected) {
  const primary = checked.find((item) => item.candidate.slot === 'primary')?.candidate || null;
  return {
    promoted:Boolean(selected && selected.candidate.slot !== 'primary'),
    selectedSlot:selected?.candidate.slot || null,
    selectedFieldId:selected?.candidate.fieldId || null,
    selectedRaw:selected?.candidate.raw || null,
    previousPrimaryRaw:primary?.raw || null,
    entries:checked.map(({ candidate, provider }) => ({
      slot:candidate.slot,
      phone:candidate.phone,
      resultCode:provider?.resultCode || 'MISSING',
      resultLabel:provider?.resultLabel || 'No provider result',
      state:provider?.state || 'pending',
    })),
  };
}

function dncEvidenceSnapshot(lead) {
  return {
    dncStatus:String(lead?.dncStatus || 'pending'),
    dncCheckedAt:lead?.dncCheckedAt || null,
    source:lead?.dncSource || null,
    resultCode:lead?.dncResultCode || null,
    reason:lead?.dncReason || null,
    decisionCategory:lead?.dncDecisionCategory || null,
    reviewRequired:Number(lead?.dncReviewRequired) === 1,
  };
}

function dncEvidenceChanged(previous, result) {
  return previous.dncStatus !== result.dncStatus ||
    previous.resultCode !== (result.resultCode || null) ||
    previous.reason !== (result.reason || null) ||
    previous.decisionCategory !== (result.decisionCategory || null) ||
    previous.reviewRequired !== Boolean(result.reviewRequired);
}

function emptyDncSummary() {
  return { processed:0, clean:0, blocked:0, review:0, pending:0, failed:0, results:[] };
}

function summarizeDncResults(results) {
  const summary = { ...emptyDncSummary(), results };
  for (const result of results) {
    if (result.error) {
      summary.failed += 1;
      if (result.dncStatus === 'pending') summary.pending += 1;
      continue;
    }
    summary.processed += 1;
    summary[result.dncStatus] += 1;
  }
  const reasons = new Map();
  for (const result of results) {
    if (!result.reason && !result.error) continue;
    const key = [result.resultCode || result.code || 'UNRESOLVED', result.decisionCategory || '', result.reason || result.error].join('|');
    if (!reasons.has(key)) {
      reasons.set(key, {
        resultCode:result.resultCode || result.code || 'UNRESOLVED',
        decisionCategory:result.decisionCategory || null,
        reason:result.reason || result.error,
        reviewRequired:Boolean(result.reviewRequired),
        count:0,
      });
    }
    reasons.get(key).count += 1;
  }
  summary.reasonSummary = [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 50);
  return summary;
}

async function checkDncTags(context, locationId, leadIds) {
  if (!leadIds.length) return { processed: 0, clean: 0, blocked: 0, pending: 0, failed: 0, results: [] };
  const placeholders = leadIds.map(() => '?').join(',');
  const [sources] = await context.corePool.query(
    `SELECT sl.lead_id, sl.external_record_id, i.*
     FROM lead_source_links sl
     INNER JOIN crm_integrations i ON i.id = sl.integration_id
     INNER JOIN crm_integration_grants g ON g.integration_id = i.id
     WHERE sl.location_id = ? AND i.location_id = ? AND g.api_key_id = ?
       AND g.allow_read = 1 AND i.is_enabled = 1 AND sl.lead_id IN (${placeholders})
     ORDER BY sl.lead_id,
       CASE WHEN i.base_url LIKE 'https://services.leadconnectorhq.com%' THEN 0
            WHEN i.provider = 'leadconnector-pit' THEN 1 ELSE 2 END,
       sl.first_seen_at`,
    [locationId, locationId, context.apiKeyId, ...leadIds]
  );
  const selected = new Map();
  for (const source of sources) if (!selected.has(String(source.lead_id))) selected.set(String(source.lead_id), source);
  const records = new Map();
  const sourceErrors = new Map();
  const groups = new Map();
  for (const [leadId, source] of selected) {
    if (!groups.has(source.id)) groups.set(source.id, { integration: source, links: [] });
    groups.get(source.id).links.push({ leadId, externalId: String(source.external_record_id) });
  }
  for (const group of groups.values()) {
    try {
      const found = await fetchCrmTagRecords(group.integration, group.links);
      for (const [leadId, record] of found) records.set(leadId, record);
    } catch (error) {
      for (const link of group.links) sourceErrors.set(link.leadId, error.message);
    }
  }

  const rules = await listPoolRules(context.corePool, context.source, locationId);
  const results = [];
  const conn = await context.corePool.getConnection();
  try {
    await conn.beginTransaction();
    for (const leadId of leadIds) {
      const source = selected.get(String(leadId));
      const record = records.get(String(leadId));
      if (!source) {
        results.push({ leadId, error: 'No CRM source with read access is linked to this lead' });
        continue;
      }
      if (!record) {
        results.push({ leadId, error: sourceErrors.get(String(leadId)) || 'CRM contact was not returned by the contact feed' });
        continue;
      }
      const screening = classifyDncScreening(record);
      await applyDncScreeningStatus(conn, leadId, locationId, screening, rules);
      const channels = await applyMarketingChannelStatus(conn, leadId, locationId, record, rules);
      await conn.query(
        `INSERT INTO dnc_pulse_events
           (id, api_key_id, lead_id, external_contact_id, location_id, action)
         VALUES (?, ?, ?, ?, ?, 'tags_checked_admin')`,
        [crypto.randomUUID(), context.apiKeyId, leadId, source.external_record_id, locationId]
      );
      results.push({
        leadId,
        contactId: source.external_record_id,
        integrationId: source.id,
        dncStatus: screening.state,
        tags: screening.tags,
        matchedTags: matchedDncTags(screening.tags),
        channels,
      });
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  const successfulIds = results.filter((item) => !item.error).map((item) => item.leadId);
  if (successfulIds.length) {
    const statePlaceholders = successfulIds.map(() => '?').join(',');
    const [states] = await context.corePool.query(
      `SELECT id, status, dncStatus, dncCheckedAt,
              phoneMarketingStatus, emailMarketingStatus, smsMarketingStatus
       FROM leads
       WHERE locationId = ? AND id IN (${statePlaceholders})`,
      [locationId, ...successfulIds]
    );
    const byId = new Map(states.map((row) => [String(row.id), row]));
    for (const result of results) if (!result.error) Object.assign(result, byId.get(String(result.leadId)) || {});
  }
  const summary = { processed: 0, clean: 0, blocked: 0, pending: 0, failed: 0, results };
  for (const result of results) {
    if (result.error) summary.failed += 1;
    else { summary.processed += 1; summary[result.dncStatus] += 1; }
  }
  return summary;
}

async function fetchCrmTagRecords(integration, links) {
  const config = safeConfig(integration);
  const targets = new Map();
  for (const link of links) {
    if (!targets.has(link.externalId)) targets.set(link.externalId, []);
    targets.get(link.externalId).push(link.leadId);
  }
  const found = new Map();
  let cursor = null;
  let pages = 0;
  while (pages < 250 && found.size < links.length) {
    const page = await fetchCrmPage(integration, { cursor, limit: Math.min(config.maxPageSize, 100) });
    pages += 1;
    for (const record of page.records) {
      const recordLocation = getPath(record, config.locationPath);
      if (recordLocation && String(recordLocation) !== String(integration.location_id)) continue;
      const externalId = String(getPath(record, config.idPath) || '').trim();
      for (const leadId of targets.get(externalId) || []) found.set(String(leadId), record);
    }
    const next = page.nextCursor;
    if (!next || next === cursor || page.records.length === 0) break;
    cursor = next;
  }
  return found;
}

function matchedDncTags(tags) {
  const recognized = new Set([
    'dnc-blocked', 'dnc', 'do not call', 'do-not-call', 'do_not_call', 'dnc-clean', 'dnc-wireless',
    'dnd phone', 'dnd-phone', 'dnd_phone', 'dnd email', 'dnd-email', 'dnd_email',
    'dnd sms', 'dnd-sms', 'dnd_sms',
  ]);
  return tags.filter((tag) => recognized.has(tag));
}

async function refreshNoPhonePool(context, input) {
  requireCoreSource(context, 'No Phone refresh');
  const locationId = requireLocation(input.locationId);
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  const rule = await getPoolRule(context.corePool, context.source, locationId, 'no_phone');
  if (!rule?.statusValues?.length) {
    throw Object.assign(new Error('No Phone pool is not configured'), { status:409 });
  }
  const placeholders = rule.statusValues.map(() => '?').join(',');
  const [rows] = await context.corePool.query(
    `SELECT id FROM leads WHERE locationId = ? AND status IN (${placeholders})
     ORDER BY marketingChannelsCheckedAt, dateAdded, id LIMIT ?`,
    [locationId, ...rule.statusValues, limit]
  );
  const result = await checkDncTags(context, locationId, rows.map((row) => String(row.id)));
  const [remainingRows] = await context.corePool.query(
    `SELECT COUNT(*) AS total FROM leads WHERE locationId = ? AND status IN (${placeholders})`,
    [locationId, ...rule.statusValues]
  );
  return { ...result, remaining:Number(remainingRows[0]?.total) || 0 };
}

function publicLead(row) {
  return { ...row, contactData: parseJson(row.contactData) };
}

async function updateLead(context, leadId, input) {
  const locationId = requireLocation(input.locationId);
  let destinationRule = null;
  if (Object.prototype.hasOwnProperty.call(input, 'status')) {
    destinationRule = await findRuleForStatus(context.corePool, context.source, locationId, input.status);
    if (!destinationRule || !destinationRule.isEnabled) {
      throw Object.assign(new Error('Lead status is not routed to an enabled pool'), { status: 400 });
    }
    if (destinationRule.assignmentPolicy === 'clear') input = { ...input, assignedTo: null };
    if (destinationRule.assignmentPolicy === 'require_user' && !input.assignedTo) {
      throw Object.assign(new Error(`${destinationRule.label} requires an assigned user`), { status: 400 });
    }
  }
  const readColumns = ['id', 'locationId', 'serviceType', 'status', 'contactData', 'assignedTo', 'lastContacted', 'dncStatus', 'dncCheckedAt', 'dateAdded'];
  requireColumns(context, 'leads', readColumns);
  const readPool = await domainPool(context, 'leads', 'select');
  const writePool = await domainPool(context, 'leads', 'update');
  const selectLead = `SELECT ${readColumns.map((column) => `\`${column}\``).join(', ')}
                      FROM leads WHERE id = ? AND locationId = ? LIMIT 1`;
  const before = await one(readPool, selectLead, [leadId, locationId]);
  if (!before) throw Object.assign(new Error('Lead not found'), { status: 404 });
  if (destinationRule) {
    const lifecycleRules = await listPoolRules(context.corePool, context.source, locationId);
    assertDncAssignmentAllowed([before], destinationRule, lifecycleRules);
  }
  const map = { serviceType: 'serviceType', status: 'status', assignedTo: 'assignedTo', lastContacted: 'lastContacted', contactData: 'contactData' };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(map)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    sets.push(`\`${column}\` = ?`);
    params.push(key === 'contactData' && typeof input[key] !== 'string' ? JSON.stringify(input[key]) : input[key]);
  }
  if (!sets.length) throw Object.assign(new Error('No editable lead fields supplied'), { status: 400 });
  await writePool.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = ? AND locationId = ?`, [...params, leadId, locationId]);
  return { before: publicLead(before), after: publicLead(await one(readPool, selectLead, [leadId, locationId])) };
}

async function assignLeads(context, input, assigned) {
  const locationId = requireLocation(input.locationId);
  requireColumns(context, 'leads', ['id', 'locationId', 'status', 'assignedTo', 'dncStatus']);
  const ids = normalizeIds(input.leadIds);
  const readPool = await domainPool(context, 'leads', 'select');
  const writePool = await domainPool(context, 'leads', 'update');
  if (assigned) {
    if (!input.userId) throw Object.assign(new Error('userId is required'), { status: 400 });
    const usersPool = context.source === 'core'
      ? await domainPool(context, 'users', 'select')
      : context.corePool;
    if (context.source === 'core') requireColumns(context, 'users', ['id', 'locationId', 'username']);
    const user = await one(usersPool, 'SELECT id, username FROM users WHERE id = ? AND locationId = ? LIMIT 1', [input.userId, locationId]);
    if (!user) throw Object.assign(new Error('User not found in the location identity directory'), { status: 404 });
  }
  const placeholders = ids.map(() => '?').join(',');
  const destination = await getPoolRule(
    context.corePool, context.source, locationId, assigned ? 'assigned' : 'available'
  );
  const destinationStatus = destination
    ? destination.destinationStatus
    : (assigned ? 'assigned' : 'uncontacted');
  const [before] = await readPool.query(`SELECT id, status, assignedTo, dncStatus FROM leads WHERE locationId = ? AND id IN (${placeholders})`, [locationId, ...ids]);
  const lifecycleRules = await listPoolRules(context.corePool, context.source, locationId);
  assertDncAssignmentAllowed(before, destination, lifecycleRules);
  if (assigned) {
    await writePool.query(`UPDATE leads SET assignedTo = ?, status = ? WHERE locationId = ? AND id IN (${placeholders})`, [input.userId, destinationStatus, locationId, ...ids]);
  } else {
    await writePool.query(`UPDATE leads SET assignedTo = NULL, status = ? WHERE locationId = ? AND id IN (${placeholders})`, [destinationStatus, locationId, ...ids]);
  }
  const [after] = await readPool.query(`SELECT id, status, assignedTo, dncStatus FROM leads WHERE locationId = ? AND id IN (${placeholders})`, [locationId, ...ids]);
  return { before, after, affected: after.length };
}

async function listUsers(context, locationId) {
  requireLocation(locationId);
  const pool = context.source === 'core'
    ? await domainPool(context, 'users', 'select')
    : context.corePool;
  if (context.source === 'core') {
    requireColumns(context, 'users', ['id', 'locationId', 'username', 'passwordHash', 'role', 'crmUserId', 'crmUserName', 'email', 'phone', 'createdAt']);
  }
  const [rows] = await pool.query(
    `SELECT id, locationId, username, role, crmUserId, crmUserName, email, phone, createdAt,
            CASE
              WHEN passwordHash IS NULL OR passwordHash = '' THEN 'missing'
              WHEN passwordHash LIKE '$2%' THEN 'bcrypt'
              ELSE 'legacy'
            END AS credentialScheme
     FROM users WHERE locationId = ? ORDER BY username, id`, [locationId]
  );
  const [permissions, languagePermissions] = await Promise.all([
    listDialerPoolPermissions(context.corePool, locationId),
    listUserLanguagePermissions(context.corePool, locationId),
  ]);
  const byUser = new Map();
  for (const permission of permissions.filter((item) => item.isEnabled)) {
    if (!byUser.has(permission.userId)) byUser.set(permission.userId, []);
    byUser.get(permission.userId).push(permission.servicePool);
  }
  const languagesByUser = new Map();
  for (const permission of languagePermissions.filter((item) => item.isEnabled)) {
    if (!languagesByUser.has(permission.userId)) languagesByUser.set(permission.userId, []);
    languagesByUser.get(permission.userId).push(permission.languageCode);
  }
  return rows.map((row) => ({ ...row, poolPermissions:byUser.get(String(row.id)) || [],
    languagePermissions:languagesByUser.get(String(row.id)) || [] }));
}

async function createUser(context, input) {
  const locationId = requireLocation(input.locationId);
  requireColumns(context, 'users', ['id', 'locationId', 'username', 'passwordHash', 'role', 'crmUserId', 'crmUserName', 'email', 'phone', 'createdAt']);
  const id = input.id ? String(input.id).trim().slice(0, 128) : crypto.randomUUID();
  if (!id) throw Object.assign(new Error('Valid user ID is required'), { status: 400 });
  const username = normalizeDialerUsername(input.username);
  const role = normalizeDialerRole(input.role);
  const passwordHash = await bcrypt.hash(validPassword(input.password), BCRYPT_ROUNDS);
  const readPool = await domainPool(context, 'users', 'select');
  const writePool = await domainPool(context, 'users', 'insert');
  const email = input.email ? String(input.email).trim().toLowerCase().slice(0, 255) : null;
  const duplicate = await one(readPool,
    `SELECT id FROM users WHERE locationId = ?
     AND (id = ? OR username = ? OR (? IS NOT NULL AND LOWER(email) = ?)) LIMIT 1`,
    [locationId, id, username, email, email]
  );
  if (duplicate) throw Object.assign(new Error('User ID, username, or email is already in use for this location'), { status: 409 });
  await writePool.query(
    `INSERT INTO users (id, locationId, username, passwordHash, role, crmUserId, crmUserName, email, phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, locationId, username, passwordHash, role, input.crmUserId || null,
      input.crmUserName || null, email, input.phone || null]
  );
  await saveDialerPoolPermissions(context.corePool, {
    locationId,
    userId:id,
    servicePools:Array.isArray(input.poolPermissions) ? input.poolPermissions : [],
  });
  await saveUserLanguagePermissions(context.corePool, {
    locationId, userId:id,
    languageCodes:Array.isArray(input.languagePermissions) ? input.languagePermissions : [],
  });
  const user = await one(readPool, `SELECT id, locationId, username, role, crmUserId, crmUserName, email, phone, createdAt FROM users WHERE id = ?`, [id]);
  user.poolPermissions = Array.isArray(input.poolPermissions) ? input.poolPermissions : [];
  user.languagePermissions = Array.isArray(input.languagePermissions) ? input.languagePermissions : [];
  return user;
}

async function updateUser(context, userId, input) {
  const locationId = requireLocation(input.locationId);
  if (Object.hasOwn(input, 'password') || Object.hasOwn(input, 'passwordHash')) {
    throw Object.assign(new Error('Use the dedicated password change operation for credentials'), { status: 400 });
  }
  requireColumns(context, 'users', ['id', 'locationId', 'username', 'passwordHash', 'role', 'crmUserId', 'crmUserName', 'email', 'phone']);
  const readPool = await domainPool(context, 'users', 'select');
  const writePool = await domainPool(context, 'users', 'update');
  const before = await one(readPool, `SELECT id, locationId, username, role, crmUserId, crmUserName, email, phone FROM users WHERE id = ? AND locationId = ?`, [userId, locationId]);
  if (!before) throw Object.assign(new Error('User not found'), { status: 404 });
  if (Object.hasOwn(input, 'username') || Object.hasOwn(input, 'email')) {
    const username = Object.hasOwn(input, 'username') ? normalizeDialerUsername(input.username) : before.username;
    const email = Object.hasOwn(input, 'email') && input.email
      ? String(input.email).trim().toLowerCase().slice(0, 255) : (Object.hasOwn(input, 'email') ? null : before.email);
    const duplicate = await one(readPool,
      `SELECT id FROM users WHERE locationId = ? AND id <> ?
       AND (username = ? OR (? IS NOT NULL AND LOWER(email) = ?)) LIMIT 1`,
      [locationId, userId, username, email, email]
    );
    if (duplicate) throw Object.assign(new Error('Username or email is already in use for this location'), { status: 409 });
  }
  const fields = ['username', 'role', 'crmUserId', 'crmUserName', 'email', 'phone'];
  const sets = []; const params = [];
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(input, field)) {
    sets.push(`\`${field}\` = ?`);
    params.push(field === 'username' ? normalizeDialerUsername(input[field])
      : field === 'role' ? normalizeDialerRole(input[field])
        : field === 'email' && input[field] ? String(input[field]).trim().toLowerCase().slice(0, 255) : input[field]);
  }
  if (!sets.length && !Object.hasOwn(input, 'poolPermissions') && !Object.hasOwn(input, 'languagePermissions')) {
    throw Object.assign(new Error('No editable user fields supplied'), { status: 400 });
  }
  if (sets.length) {
    await writePool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND locationId = ?`, [...params, userId, locationId]);
  }
  if (Object.hasOwn(input, 'languagePermissions')) {
    before.languagePermissions = (await listUserLanguagePermissions(context.corePool, locationId))
      .filter((item) => item.userId === userId && item.isEnabled).map((item) => item.languageCode);
  }
  let permissionChange = null;
  if (Object.hasOwn(input, 'poolPermissions')) {
    permissionChange = await saveDialerPoolPermissions(context.corePool, {
      locationId,
      userId,
      servicePools:input.poolPermissions,
    });
  }
  if (Object.hasOwn(input, 'languagePermissions')) {
    await saveUserLanguagePermissions(context.corePool, {
      locationId, userId, languageCodes:input.languagePermissions,
    });
  }
  const after = await one(readPool, `SELECT id, locationId, username, role, crmUserId, crmUserName, email, phone FROM users WHERE id = ?`, [userId]);
  if (permissionChange) {
    before.poolPermissions = permissionChange.before;
    after.poolPermissions = permissionChange.after;
  }
  if (Object.hasOwn(input, 'languagePermissions')) after.languagePermissions = input.languagePermissions;
  return { before, after };
}

async function changeUserPassword(context, userId, input) {
  const locationId = requireLocation(input.locationId);
  requireColumns(context, 'users', ['id', 'locationId', 'username', 'passwordHash']);
  const password = validPassword(input.password);
  const readPool = await domainPool(context, 'users', 'select');
  const writePool = await domainPool(context, 'users', 'update');
  const user = await one(
    readPool,
    `SELECT id, locationId, username FROM users WHERE id = ? AND locationId = ? LIMIT 1`,
    [userId, locationId]
  );
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const [updated] = await writePool.query(
    `UPDATE users SET passwordHash = ? WHERE id = ? AND locationId = ?`,
    [passwordHash, userId, locationId]
  );
  if (!updated.affectedRows) throw Object.assign(new Error('User password was not updated'), { status: 409 });

  const persisted = await one(
    readPool,
    `SELECT passwordHash FROM users WHERE id = ? AND locationId = ? LIMIT 1`,
    [userId, locationId]
  );
  if (!persisted?.passwordHash || !(await bcrypt.compare(password, String(persisted.passwordHash)))) {
    throw Object.assign(new Error('Password persistence verification failed'), {
      status: 500,
      code: 'OWL_CREDENTIAL_PERSISTENCE_FAILED',
    });
  }

  // A password rotation is also a session boundary. Existing bearer sessions must
  // not outlive the credential that authorized them.
  const [revoked] = await context.corePool.query(
    `UPDATE api_operator_sessions SET revoked_at = UTC_TIMESTAMP(3)
     WHERE user_id = ? AND location_id = ? AND revoked_at IS NULL`,
    [userId, locationId]
  );
  return {
    user,
    credentialVerified: true,
    sessionsRevoked: Number(revoked.affectedRows) || 0,
  };
}

function normalizeDialerUsername(value) {
  const username = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) {
    throw Object.assign(new Error('Username must be 3-64 letters, numbers, dots, underscores, or hyphens'), { status: 400 });
  }
  return username;
}

function normalizeDialerRole(value) {
  const role = String(value || 'agent').trim().toLowerCase();
  if (!['agent', 'supervisor'].includes(role)) throw Object.assign(new Error('Invalid dialer role'), { status: 400 });
  return role;
}

async function listDialers(context, locationId) {
  requireLocation(locationId);
  const users = await listUsers(context, locationId);
  const workspaceMap = new Map();
  if (context.sourceInfo.tables.dialer_workspaces?.select) {
    requireColumns(context, 'dialer_workspaces', ['user_id', 'location_id', 'revision', 'crm_contact_id', 'crm_path', 'client_tab_id', 'lease_until', 'updated_at']);
    const pool = await domainPool(context, 'dialer_workspaces', 'select');
    const [rows] = await pool.query(
      `SELECT user_id, revision, crm_contact_id, crm_path, client_tab_id, lease_until, updated_at
       FROM dialer_workspaces WHERE location_id = ?`, [locationId]
    );
    for (const row of rows) workspaceMap.set(String(row.user_id), row);
  }
  const loginMap = new Map();
  if (context.sourceInfo.tables.api_login_events?.select) {
    requireColumns(context, 'api_login_events', ['user_id', 'location_id', 'outcome', 'ip', 'detail', 'created_at']);
    const pool = await domainPool(context, 'api_login_events', 'select');
    const [rows] = await pool.query(
      `SELECT user_id, outcome, ip, detail, created_at FROM api_login_events
       WHERE location_id = ? AND user_id IS NOT NULL ORDER BY created_at DESC LIMIT 500`, [locationId]
    );
    for (const row of rows) if (!loginMap.has(String(row.user_id))) loginMap.set(String(row.user_id), row);
  }
  return users.map((user) => ({ ...user, workspace: workspaceMap.get(String(user.id)) || null, lastLogin: loginMap.get(String(user.id)) || null }));
}

async function listSchedules(context, locationId) {
  requireLocation(locationId);
  requireCapability(context, 'users', 'select');
  requireColumns(context, 'user_schedule_weeks', ['userId', 'locationId', 'weekStart', 'weekEnd', 'scheduleData', 'scheduledMinutes', 'submittedAt', 'updatedAt']);
  requireColumns(context, 'dialer_work_sessions', ['id', 'userId', 'locationId', 'weekStart', 'startedAt', 'endedAt', 'durationSeconds', 'status', 'source']);
  requireColumns(context, 'dialer_activity_minutes', ['location_id', 'user_id', 'activity_minute', 'heartbeat_count', 'crm_contact_id']);
  requireColumns(context, 'lead_call_attempts', ['location_id', 'lead_id', 'user_id', 'occurred_at', 'direction', 'source']);
  requireColumns(context, 'users', ['id', 'locationId', 'username', 'crmUserName']);
  const pool = await domainPool(context, 'user_schedule_weeks', 'select');
  await domainPool(context, 'dialer_work_sessions', 'select');
  await domainPool(context, 'dialer_activity_minutes', 'select');
  const week = getScheduleWeek();
  const weekStartUtc = new Date(week.deadlineAt).toISOString().slice(0, 23).replace('T', ' ');
  const [rows] = await pool.query(
    `SELECT u.id AS userId, u.locationId, u.username, u.crmUserName,
            s.weekStart, s.weekEnd, s.scheduleData, s.scheduledMinutes, s.submittedAt, s.updatedAt,
            COALESCE(w.actualSeconds, 0) AS actualSeconds,
            COALESCE(w.sessionCount, 0) AS sessionCount,
            COALESCE(w.activeSessions, 0) AS activeSessions,
            w.firstClockIn, w.lastClockOut,
            COALESCE(a.verifiedMinutes, 0) AS verifiedMinutes,
            COALESCE(a.engagedMinutes, 0) AS engagedMinutes,
            COALESCE(a.contactsWorked, 0) AS contactsWorked,
            a.lastHeartbeat,
            COALESCE(l.loginCount, 0) AS loginCount,
            l.lastLogin,
            COALESCE(c.dialActions, 0) AS dialActions,
            COALESCE(c.allowedActions, 0) AS allowedActions,
            COALESCE(r.confirmedDialResults, 0) AS confirmedDialResults,
            COALESCE(r.pendingDialEvidence, 0) AS pendingDialEvidence,
            COALESCE(p.appointments, 0) AS appointments
     FROM users u
     LEFT JOIN user_schedule_weeks s
       ON s.userId = u.id AND s.locationId = u.locationId AND s.weekStart = ?
     LEFT JOIN (
       SELECT locationId, userId, weekStart,
              SUM(COALESCE(durationSeconds, GREATEST(0, TIMESTAMPDIFF(SECOND, startedAt, UTC_TIMESTAMP(3))))) AS actualSeconds,
              COUNT(*) AS sessionCount,
              SUM(CASE WHEN endedAt IS NULL THEN 1 ELSE 0 END) AS activeSessions,
              MIN(startedAt) AS firstClockIn, MAX(endedAt) AS lastClockOut
       FROM dialer_work_sessions WHERE locationId = ? AND weekStart = ?
       GROUP BY locationId, userId, weekStart
     ) w ON w.userId = u.id AND w.locationId = u.locationId AND w.weekStart = ?
     LEFT JOIN (
       SELECT location_id,user_id,COUNT(*) AS verifiedMinutes,
              SUM(crm_contact_id IS NOT NULL) AS engagedMinutes,
              COUNT(DISTINCT crm_contact_id) AS contactsWorked,MAX(activity_minute) AS lastHeartbeat
       FROM dialer_activity_minutes WHERE location_id=? AND activity_minute>=?
       GROUP BY location_id,user_id
     ) a ON a.user_id=u.id AND a.location_id=u.locationId
     LEFT JOIN (
       SELECT location_id,user_id,COUNT(*) AS loginCount,MAX(created_at) AS lastLogin
       FROM api_login_events WHERE location_id=? AND outcome='success' AND created_at>=?
       GROUP BY location_id,user_id
     ) l ON l.user_id=u.id AND l.location_id=u.locationId
     LEFT JOIN (
       SELECT location_id,user_id,COUNT(*) AS dialActions,SUM(decision='allowed') AS allowedActions
       FROM lead_compliance_checks WHERE location_id=? AND checked_at>=?
       GROUP BY location_id,user_id
     ) c ON c.user_id=u.id AND c.location_id=u.locationId
     LEFT JOIN (
       SELECT location_id,user_id,
              SUM(source='crm') AS confirmedDialResults,
              SUM(source='dialer') AS pendingDialEvidence
       FROM lead_call_attempts WHERE direction='outbound' AND occurred_at>=?
       GROUP BY location_id,user_id
     ) r ON r.user_id=u.id AND r.location_id=u.locationId
     LEFT JOIN (
       SELECT locationId,userId,COUNT(*) AS appointments FROM appointments
       WHERE locationId=? AND createdAt>=? GROUP BY locationId,userId
     ) p ON p.userId=u.id AND p.locationId=u.locationId
     WHERE u.locationId = ? ORDER BY u.username, u.id`,
    [week.weekStart, locationId, week.weekStart, week.weekStart,
      locationId, weekStartUtc, locationId, weekStartUtc,
      locationId, weekStartUtc, weekStartUtc, locationId, weekStartUtc, locationId]
  );
  const schedules = rows.map((row) => {
    const scheduleData = parseJson(row.scheduleData);
    const expectedMinutes = scheduledMinutesElapsed(scheduleData);
    const verifiedMinutes = Number(row.verifiedMinutes) || 0;
    return ({
    ...row,
    scheduleData,
    scheduledMinutes: Number(row.scheduledMinutes) || 0,
    actualSeconds: Number(row.actualSeconds) || 0,
    sessionCount: Number(row.sessionCount) || 0,
    activeSessions: Number(row.activeSessions) || 0,
    verifiedMinutes,
    expectedMinutes,
    missedScheduledMinutes: Math.max(0, expectedMinutes - verifiedMinutes),
    engagedMinutes: Number(row.engagedMinutes) || 0,
    contactsWorked: Number(row.contactsWorked) || 0,
    loginCount: Number(row.loginCount) || 0,
    dialActions: Number(row.dialActions) || 0,
    allowedActions: Number(row.allowedActions) || 0,
    confirmedDialResults: Number(row.confirmedDialResults) || 0,
    pendingDialEvidence: Number(row.pendingDialEvidence) || 0,
    appointments: Number(row.appointments) || 0,
    isWorkingNow: Boolean(row.lastHeartbeat && Date.now() - new Date(row.lastHeartbeat).getTime() <= 180000),
    state: !row.scheduleData ? 'missing' : row.submittedAt ? 'submitted' : 'draft',
  }); });
  const [sessions] = await pool.query(
    `SELECT w.id, w.userId, u.username, u.crmUserName, w.startedAt, w.endedAt,
            COALESCE(w.durationSeconds, GREATEST(0, TIMESTAMPDIFF(SECOND, w.startedAt, UTC_TIMESTAMP(3)))) AS durationSeconds,
            w.status, w.source
     FROM dialer_work_sessions w LEFT JOIN users u ON u.id = w.userId AND u.locationId = w.locationId
     WHERE w.locationId = ? AND w.weekStart = ? ORDER BY w.startedAt DESC LIMIT 200`,
    [locationId, week.weekStart]
  );
  const summary = schedules.reduce((result, row) => {
    result.users += 1;
    result[row.state] += 1;
    result.scheduledMinutes += row.scheduledMinutes;
    result.actualSeconds += row.verifiedMinutes * 60;
    result.activeSessions += row.isWorkingNow ? 1 : 0;
    return result;
  }, { users: 0, submitted: 0, draft: 0, missing: 0, scheduledMinutes: 0, actualSeconds: 0, activeSessions: 0 });
  return { week, summary, schedules, sessions: sessions.map((row) => ({ ...row, durationSeconds: Number(row.durationSeconds) || 0 })) };
}

function scheduledMinutesElapsed(scheduleData, now = new Date()) {
  if (!scheduleData || typeof scheduleData !== 'object') return 0;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone:'America/New_York', weekday:'long', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const names = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const today = names.indexOf(String(parts.weekday || '').toLowerCase());
  if (today < 0) return 0;
  const currentMinute = Number(parts.hour) * 60 + Number(parts.minute);
  const days = scheduleData.days && typeof scheduleData.days === 'object' ? scheduleData.days : scheduleData;
  let elapsed = 0;
  for (let index = 0; index <= today; index += 1) {
    const name = names[index];
    const value = days[name] ?? days[name.slice(0, 3)] ?? days[name[0].toUpperCase() + name.slice(1)];
    const shifts = Array.isArray(value) ? value : value ? [value] : [];
    for (const shift of shifts) {
      if (!shift || typeof shift !== 'object') continue;
      if (Number.isFinite(Number(shift.minutes))) {
        if (index < today) elapsed += Math.max(0, Math.round(Number(shift.minutes)));
        continue;
      }
      const start = scheduleClockMinute(shift.start || shift.startTime);
      const end = scheduleClockMinute(shift.end || shift.endTime);
      if (start == null || end == null) continue;
      const normalizedEnd = end >= start ? end : end + 1440;
      const effectiveNow = index < today ? normalizedEnd : Math.min(Math.max(currentMinute, start), normalizedEnd);
      const raw = Math.max(0, effectiveNow - start);
      const total = Math.max(1, normalizedEnd - start);
      const breakShare = Math.round((Math.max(0, Number(shift.breakMinutes) || 0) * raw) / total);
      elapsed += Math.max(0, raw - breakShare);
    }
  }
  return elapsed;
}

function scheduleClockMinute(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

async function getComplianceReport(context, locationId) {
  requireLocation(locationId);
  requireCoreSource(context, 'Compliance reports');
  requireColumns(context, 'lead_compliance_checks', [
    'location_id', 'lead_id', 'user_id', 'state_code', 'time_zone', 'local_time',
    'attempts_24h', 'decision', 'reason', 'next_eligible_at', 'checked_at',
  ]);
  requireColumns(context, 'lead_call_attempts', ['location_id', 'lead_id', 'user_id', 'external_user_id', 'occurred_at', 'direction', 'call_status', 'source', 'synced_at']);
  const pool = await domainPool(context, 'lead_compliance_checks', 'select');
  const [summaryRows] = await pool.query(
    `SELECT COUNT(*) AS screened,
            SUM(decision='allowed') AS allowed,
            SUM(decision='blocked') AS blocked,
            COUNT(DISTINCT CASE WHEN decision='blocked' THEN lead_id END) AS blockedLeads
     FROM lead_compliance_checks WHERE location_id=? AND checked_at >= UTC_TIMESTAMP(3)-INTERVAL 24 HOUR`,
    [locationId]
  );
  const [attemptRows] = await pool.query(
    `SELECT COUNT(*) AS attempts,
            SUM(source='dialer') AS authorizedAttempts,
            SUM(source='crm') AS confirmedAttempts,
            SUM(source='crm' AND user_id IS NOT NULL) AS attributedConfirmedAttempts
     FROM lead_call_attempts
     WHERE location_id=? AND direction='outbound' AND occurred_at >= UTC_TIMESTAMP(3)-INTERVAL 24 HOUR`,
    [locationId]
  );
  const [reasons] = await pool.query(
    `SELECT reason,COUNT(*) AS total FROM lead_compliance_checks
     WHERE location_id=? AND decision='blocked' AND checked_at >= UTC_TIMESTAMP(3)-INTERVAL 24 HOUR
     GROUP BY reason ORDER BY total DESC`, [locationId]
  );
  const [checks] = await pool.query(
    `SELECT c.id,c.lead_id AS leadId,c.user_id AS userId,c.state_code AS stateCode,
            c.time_zone AS timeZone,c.local_time AS leadLocalTime,c.attempts_24h AS attempts24h,
            c.decision,c.reason,c.next_eligible_at AS nextEligibleAt,c.checked_at AS checkedAt,
            l.serviceType,l.contactData,u.username
     FROM lead_compliance_checks c LEFT JOIN leads l ON l.id=c.lead_id AND l.locationId=c.location_id
     LEFT JOIN users u ON u.id=c.user_id AND u.locationId=c.location_id
     WHERE c.location_id=? ORDER BY c.checked_at DESC LIMIT 250`, [locationId]
  );
  const [attempts] = await pool.query(
    `SELECT a.lead_id AS leadId,a.user_id AS userId,a.external_user_id AS externalUserId,a.occurred_at AS occurredAt,
            a.call_status AS callStatus,a.source,a.synced_at AS syncedAt,
            l.serviceType,l.contactData,u.username
     FROM lead_call_attempts a
     LEFT JOIN leads l ON l.id=a.lead_id AND l.locationId=a.location_id
     LEFT JOIN users u ON u.id=a.user_id AND u.locationId=a.location_id
     WHERE a.location_id=? AND a.direction='outbound'
     ORDER BY a.occurred_at DESC LIMIT 250`, [locationId]
  );
  const summary = summaryRows[0] || {};
  return {
    summary:{
      screened:Number(summary.screened)||0, allowed:Number(summary.allowed)||0,
      blocked:Number(summary.blocked)||0, blockedLeads:Number(summary.blockedLeads)||0,
      attempts:Number(attemptRows[0]?.attempts)||0,
      authorizedAttempts:Number(attemptRows[0]?.authorizedAttempts)||0,
      confirmedAttempts:Number(attemptRows[0]?.confirmedAttempts)||0,
      attributedConfirmedAttempts:Number(attemptRows[0]?.attributedConfirmedAttempts)||0,
    },
    reasons:reasons.map((row) => ({ reason:row.reason, total:Number(row.total)||0 })),
    checks:checks.map(({ leadLocalTime, ...row }) => ({
      ...row,
      localTime:leadLocalTime || null,
      attempts24h:Number(row.attempts24h)||0,
      contactData:parseJson(row.contactData),
    })),
    attempts:attempts.map((row) => {
      const contact = parseJson(row.contactData) || {};
      return { ...row, contactData:undefined, leadName:contact.name || [contact.firstName,contact.lastName].filter(Boolean).join(' ') || null };
    }),
  };
}

async function putSchedule(context, userId, input) {
  const locationId = requireLocation(input.locationId);
  requireColumns(context, 'user_schedules', ['userId', 'locationId', 'scheduleData', 'updatedAt']);
  requireColumns(context, 'user_schedule_weeks', ['userId', 'locationId', 'weekStart', 'weekEnd', 'scheduleData', 'scheduledMinutes', 'submittedAt', 'updatedAt']);
  const pool = await domainPool(context, 'user_schedule_weeks', 'select');
  await domainPool(context, 'user_schedule_weeks', 'update');
  await domainPool(context, 'user_schedule_weeks', 'insert');
  await domainPool(context, 'user_schedules', 'update');
  await domainPool(context, 'user_schedules', 'insert');
  const beforeResult = await getWeeklySchedule(pool, locationId, userId);
  const result = await saveWeeklySchedule(pool, {
    locationId, userId, scheduleData: input.scheduleData, submit: input.submit === true,
  });
  return { before: beforeResult.row, after: result.row, week: result.week };
}

async function submitSchedule(context, userId, input) {
  const locationId = requireLocation(input.locationId);
  requireColumns(context, 'user_schedule_weeks', ['userId', 'locationId', 'weekStart', 'submittedAt', 'updatedAt']);
  const pool = await domainPool(context, 'user_schedule_weeks', 'update');
  const beforeResult = await getWeeklySchedule(pool, locationId, userId);
  const result = await submitWeeklySchedule(pool, { locationId, userId });
  return { before: beforeResult.row, after: result.row, week: result.week };
}

function isConfiguredCrmIntegration(integration) {
  try {
    const url = new URL(integration.base_url);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' &&
      (isConfiguredCrmHost(hostname));
  } catch {
    return false;
  }
}

function isLeadConnectorIntegration(integration) {
  try {
    const url = new URL(integration.base_url);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'services.leadconnectorhq.com';
  } catch {
    return false;
  }
}

function isSupportedLeadIntegration(integration) {
  return isLeadConnectorIntegration(integration) || isConfiguredCrmIntegration(integration);
}

async function listLeadSources(context, locationId) {
  requireLocation(locationId);
  const [rows] = await context.corePool.query(
    `SELECT i.* FROM crm_integrations i
     INNER JOIN crm_integration_grants g ON g.integration_id = i.id
     WHERE g.api_key_id = ? AND g.allow_import = 1
       AND i.location_id = ? AND i.is_enabled = 1
     ORDER BY i.name`,
    [context.apiKeyId, locationId]
  );
  return rows.filter(isSupportedLeadIntegration).map((row) => ({
    ...publicIntegration(row),
    ready: Boolean(row.credential_enc),
  }));
}

async function pullLeadSource(context, input) {
  const locationId = requireLocation(input.locationId);
  if (!input.integrationId) {
    throw Object.assign(new Error('integrationId is required'), { status: 400 });
  }
  const integration = await getAuthorizedIntegration(
    String(input.integrationId), context.apiKeyId, 'allow_import', context.corePool
  );
  if (String(integration.location_id) !== locationId) {
    throw Object.assign(new Error('CRM integration is not assigned to the selected location'), { status: 403 });
  }
  if (!isSupportedLeadIntegration(integration)) {
    throw Object.assign(new Error('OWL lead pulls require a LeadConnector PIT or configured CRM integration'), { status: 400 });
  }
  if (!integration.credential_enc) {
    throw Object.assign(new Error('CRM integration has no stored credential'), { status: 409 });
  }
  const options = {
    dryRun: Boolean(input.dryRun),
    full: input.full === true,
    pageSize: Math.min(Math.max(Number(input.pageSize) || 100, 1), 500),
    maxPages: Math.min(Math.max(Number(input.maxPages) || 1000, 1), 100000),
    defaultServiceType: input.defaultServiceType
      ? String(input.defaultServiceType).slice(0, 128)
      : undefined,
  };
  const runId = await createImportRun(integration, context.apiKeyId, options, context.corePool);
  setImmediate(() => {
    executeImportRun(integration, runId, context.corePool).catch((error) => {
      console.error(`OWL CRM import ${runId} failed:`, error.message);
    });
  });
  return { runId, status: 'queued', integration: publicIntegration(integration), options };
}

async function getLeadPull(context, runId, locationId) {
  const selectedLocation = requireLocation(locationId);
  const run = await getImportRun(runId, context.corePool);
  if (!run) throw Object.assign(new Error('Lead pull not found'), { status: 404 });
  if (String(run.locationId) !== selectedLocation) {
    throw Object.assign(new Error('Lead pull is not assigned to the selected location'), { status: 403 });
  }
  await getAuthorizedIntegration(run.integrationId, context.apiKeyId, 'allow_import', context.corePool);
  return run;
}

async function listCrmUsers(context, input = {}) {
  const locationId = requireLocation(input.locationId);
  let integrationId = String(input.integrationId || '').trim();
  if (!integrationId) integrationId = (await listLeadSources(context, locationId))[0]?.id || '';
  if (!integrationId) return { integrationId:null, users:[] };
  const integration = await getAuthorizedIntegration(integrationId, context.apiKeyId, 'allow_read', context.corePool);
  if (String(integration.location_id) !== locationId) throw Object.assign(new Error('CRM integration is outside the selected location'), { status:403 });
  const response = await fetch(`${String(integration.base_url || LEADCONNECTOR_ORIGIN).replace(/\/$/, '')}/users/?locationId=${encodeURIComponent(locationId)}`, {
    headers:{ Accept:'application/json', Authorization:`Bearer ${integrationCredential(integration)}`, Version:'2021-07-28' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`CRM user lookup returned HTTP ${response.status}`), { status:502 });
  const records = Array.isArray(payload.users) ? payload.users : Array.isArray(payload) ? payload : [];
  return { integrationId, users:records.map((user) => ({
    id:String(user.id || user._id || '').trim(),
    name:String(user.name || [user.firstName,user.lastName].filter(Boolean).join(' ') || user.email || user.id || '').trim(),
    email:user.email || null,
  })).filter((user) => user.id) };
}

async function getAssignmentPolicyManagement(context, locationId) {
  return getAssignmentPolicy(context.corePool, requireLocation(locationId));
}

async function putAssignmentPolicy(context, input) {
  return saveAssignmentPolicy(context.corePool, { ...input, locationId:requireLocation(input.locationId) });
}

function requireCoreSource(context, operation) {
  if (context.source !== 'core') {
    throw Object.assign(new Error(`${operation} target the core lead store; select Core database (legacy)`), { status: 409 });
  }
}

async function recordAudit({ admin, context, locationId, action, entityType, entityId, before, after, detail }) {
  await getPool().query(
    `INSERT INTO owl_audit_events
       (id, admin_id, admin_username, api_key_id, source_slug, location_id, action,
        entity_type, entity_id, before_json, after_json, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), admin?.id || null, admin?.username || null, context.apiKeyId,
      context.source, locationId || null, action, entityType, entityId || null,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
      detail ? String(detail).slice(0, 512) : null]
  );
}

async function listAudit(input) {
  const where = ['1=1']; const params = [];
  for (const [key, column] of [['apiKeyId', 'api_key_id'], ['source', 'source_slug'], ['locationId', 'location_id'], ['action', 'action']]) {
    if (input[key]) { where.push(`${column} = ?`); params.push(input[key]); }
  }
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  const [rows] = await getPool().query(
    `SELECT id, admin_username, api_key_id, source_slug, location_id, action, entity_type,
            entity_id, detail, created_at FROM owl_audit_events
     WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, [...params, limit]
  );
  return rows;
}

function requireLocation(value) {
  const locationId = String(value || '').trim();
  if (!locationId) throw Object.assign(new Error('locationId is required'), { status: 400 });
  return locationId.slice(0, 128);
}

function normalizeIds(value) {
  if (!Array.isArray(value) || !value.length) throw Object.assign(new Error('leadIds must be a non-empty array'), { status: 400 });
  const ids = [...new Set(value.map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length || ids.length > 500) throw Object.assign(new Error('leadIds must contain 1-500 IDs'), { status: 400 });
  return ids;
}

async function one(pool, sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}

function parseJson(value) {
  if (value == null || typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

module.exports = {
  CORE_TABLES,
  bootstrapOwl,
  listSources,
  resolveContext,
  requireCapability,
  requireColumns,
  domainPool,
  listLocations,
  buildLocationContexts,
  getSummary,
  listPools,
  getServicePoolManagement,
  saveServicePool,
  saveServiceCalendars,
  moveLeadsToService,
  reclassifyServices,
  recheckServicePool,
  getPoolManagement,
  savePoolRule,
  moveLeadsToPool,
  listLeads,
  listDncScreening,
  scrubDncScreeningLead,
  scrubDncScreening,
  rescrubDncReviews,
  releaseDncReviews,
  getDncRescrubStatus,
  rescrubDncPool,
  syncDncCrmBacklog,
  refreshNoPhonePool,
  refreshDncScreeningLead,
  refreshDncScreening,
  fetchCrmTagRecords,
  updateLead,
  assignLeads,
  listUsers,
  createUser,
  updateUser,
  changeUserPassword,
  listDialers,
  listSchedules,
  getComplianceReport,
  putSchedule,
  submitSchedule,
  isConfiguredCrmIntegration,
  isLeadConnectorIntegration,
  isSupportedLeadIntegration,
  listLeadSources,
  listCrmUsers,
  getAssignmentPolicyManagement,
  putAssignmentPolicy,
  pullLeadSource,
  getLeadPull,
  recordAudit,
  listAudit,
};
