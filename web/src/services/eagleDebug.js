const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getAuthorizedIntegration } = require('./crmIntegrations');
const { getScheduleWeek } = require('./dialerSchedules');

const RESET_MODES = new Set(['submission_only', 'schedule_and_submission']);

async function listScheduleDebug(input = {}, pool = null) {
  const p = pool || getPool();
  const integrationId = required(input.integrationId, 'integrationId');
  const apiKeyId = required(input.apiKeyId, 'apiKeyId');
  const integration = await getAuthorizedIntegration(integrationId, apiKeyId, 'allow_read', p);
  const week = getScheduleWeek(input.now ? new Date(input.now) : new Date());
  const [rows] = await p.query(
    `SELECT u.id AS userId,u.username,u.crmUserName,u.crmUserId,
            s.scheduledMinutes,s.submittedAt,s.updatedAt,
            CASE WHEN s.userId IS NULL THEN 0 ELSE 1 END AS hasSchedule
     FROM users u
     LEFT JOIN user_schedule_weeks s ON s.locationId=u.locationId AND s.userId=u.id AND s.weekStart=?
     WHERE u.locationId=? ORDER BY COALESCE(u.username,u.crmUserName,u.id),u.id`,
    [week.weekStart, integration.location_id]
  );
  const [actions] = await p.query(
    `SELECT id,actor_admin_id AS actorAdminId,actor_username AS actorUsername,action,
            entity_id AS userId,reason,before_json AS beforeJson,after_json AS afterJson,created_at AS createdAt
     FROM eagle_debug_actions
     WHERE integration_id=? AND api_key_id=? AND location_id=? AND entity_type='schedule'
     ORDER BY created_at DESC LIMIT 50`,
    [integrationId, apiKeyId, integration.location_id]
  );
  return {
    locationId:integration.location_id,
    week,
    users:rows.map((row) => ({
      ...row,
      hasSchedule:Boolean(row.hasSchedule),
      scheduledMinutes:Number(row.scheduledMinutes) || 0,
      state:!row.hasSchedule ? 'missing' : row.submittedAt ? 'submitted' : 'draft',
    })),
    actions:actions.map((row) => ({
      ...row,
      before:parseJson(row.beforeJson),
      after:parseJson(row.afterJson),
      beforeJson:undefined,
      afterJson:undefined,
    })),
  };
}

async function resetSchedule(input = {}, admin = null, pool = null) {
  const p = pool || getPool();
  const integrationId = required(input.integrationId, 'integrationId');
  const apiKeyId = required(input.apiKeyId, 'apiKeyId');
  const userId = required(input.userId, 'userId');
  const mode = String(input.mode || 'submission_only');
  if (!RESET_MODES.has(mode)) throw statusError(400, 'mode must be submission_only or schedule_and_submission');
  const reason = required(input.reason, 'reason').slice(0,512);
  if (reason.length < 8) throw statusError(400, 'Debug reason must be at least 8 characters');
  const integration = await getAuthorizedIntegration(integrationId, apiKeyId, 'allow_read', p);
  const week = getScheduleWeek(input.now ? new Date(input.now) : new Date());
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const [users] = await conn.query(
      'SELECT id,username,crmUserName FROM users WHERE id=? AND locationId=? LIMIT 1 FOR UPDATE',
      [userId, integration.location_id]
    );
    if (!users[0]) throw statusError(404, 'Dialer user not found in this EAGLE location');
    const [weeks] = await conn.query(
      `SELECT scheduledMinutes,submittedAt,updatedAt FROM user_schedule_weeks
       WHERE locationId=? AND userId=? AND weekStart=? LIMIT 1 FOR UPDATE`,
      [integration.location_id, userId, week.weekStart]
    );
    const [legacyRows] = await conn.query(
      'SELECT updatedAt FROM user_schedules WHERE locationId=? AND userId=? LIMIT 1 FOR UPDATE',
      [integration.location_id, userId]
    );
    const schedule = weeks[0] || null;
    const hasLegacy = Boolean(legacyRows[0]);
    if (!schedule && !hasLegacy) throw statusError(409, 'No current schedule exists for this user');
    if (mode === 'submission_only' && !schedule) throw statusError(409, 'No current-week schedule exists to reopen');
    if (mode === 'submission_only' && !schedule.submittedAt) throw statusError(409, 'The current-week schedule is already a draft');
    const before = scheduleSummary(week, schedule, hasLegacy);
    if (mode === 'submission_only') {
      await conn.query(
        `UPDATE user_schedule_weeks SET submittedAt=NULL,updatedAt=UTC_TIMESTAMP(3)
         WHERE locationId=? AND userId=? AND weekStart=?`,
        [integration.location_id, userId, week.weekStart]
      );
    } else {
      await conn.query(
        'DELETE FROM user_schedule_weeks WHERE locationId=? AND userId=? AND weekStart=?',
        [integration.location_id, userId, week.weekStart]
      );
      await conn.query(
        'DELETE FROM user_schedules WHERE locationId=? AND userId=?',
        [integration.location_id, userId]
      );
    }
    const after = mode === 'submission_only'
      ? scheduleSummary(week, { ...schedule, submittedAt:null }, hasLegacy)
      : scheduleSummary(week, null, false);
    const auditId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO eagle_debug_actions
       (id,integration_id,api_key_id,location_id,actor_admin_id,actor_username,action,
        entity_type,entity_id,reason,before_json,after_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [auditId, integrationId, apiKeyId, integration.location_id, admin?.id || null,
        clean(admin?.username,128), mode === 'submission_only' ? 'schedule_submission_cleared' : 'schedule_cleared',
        'schedule', userId, reason, JSON.stringify(before), JSON.stringify(after)]
    );
    await conn.commit();
    return { auditId, locationId:integration.location_id, user:{ ...users[0] }, mode, reason, before, after };
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally {
    conn.release();
  }
}

function scheduleSummary(week, row, hasLegacy) {
  return {
    weekStart:week.weekStart,
    weekEnd:week.weekEnd,
    state:!row ? 'missing' : row.submittedAt ? 'submitted' : 'draft',
    hasSchedule:Boolean(row),
    hasLegacySchedule:Boolean(hasLegacy),
    scheduledMinutes:Number(row?.scheduledMinutes) || 0,
    submittedAt:row?.submittedAt || null,
    updatedAt:row?.updatedAt || null,
  };
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) throw statusError(400, `${label} is required`);
  return text;
}

function clean(value, length) {
  const text = String(value || '').trim();
  return text ? text.slice(0,length) : null;
}

function statusError(status, message) { return Object.assign(new Error(message), { status }); }

module.exports = { RESET_MODES, listScheduleDebug, resetSchedule, scheduleSummary };
