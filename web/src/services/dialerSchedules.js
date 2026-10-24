const crypto = require('crypto');

const SCHEDULE_TIME_ZONE = 'America/New_York';
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function dateParts(date, timeZone = SCHEDULE_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addLocalDays(parts, days) {
  const value = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function zonedMidnightUtc(parts, timeZone = SCHEDULE_TIME_ZONE) {
  const target = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = dateParts(new Date(candidate), timeZone);
    const represented = Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day), Number(current.hour));
    candidate -= represented - target;
  }
  return new Date(candidate);
}

function getScheduleWeek(now = new Date()) {
  const current = dateParts(now);
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(current.weekday);
  const mondayOffset = dayIndex === 0 ? -6 : 1 - dayIndex;
  const start = addLocalDays(current, mondayOffset);
  const end = addLocalDays(start, 6);
  const next = addLocalDays(start, 7);
  return {
    timeZone: SCHEDULE_TIME_ZONE,
    weekStart: formatDate(start.year, start.month, start.day),
    weekEnd: formatDate(end.year, end.month, end.day),
    deadlineAt: zonedMidnightUtc(start).toISOString(),
    nextWeekAt: zonedMidnightUtc(next).toISOString(),
  };
}

function parseTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function shiftMinutes(shift) {
  if (!shift || typeof shift !== 'object') return 0;
  if (Number.isFinite(Number(shift.minutes))) return Math.max(0, Math.round(Number(shift.minutes)));
  const start = parseTime(shift.start || shift.startTime);
  const end = parseTime(shift.end || shift.endTime);
  if (start == null || end == null) return 0;
  const elapsed = end >= start ? end - start : (24 * 60 - start) + end;
  return Math.max(0, elapsed - Math.max(0, Number(shift.breakMinutes) || 0));
}

function calculateScheduledMinutes(scheduleData) {
  if (!scheduleData || typeof scheduleData !== 'object') return 0;
  for (const key of ['scheduledMinutes', 'totalMinutes']) {
    if (Number.isFinite(Number(scheduleData[key]))) return Math.max(0, Math.round(Number(scheduleData[key])));
  }
  if (Number.isFinite(Number(scheduleData.totalHours))) return Math.max(0, Math.round(Number(scheduleData.totalHours) * 60));
  const days = scheduleData.days && typeof scheduleData.days === 'object' ? scheduleData.days : scheduleData;
  let total = 0;
  for (const day of DAY_NAMES) {
    const value = days[day] ?? days[day.slice(0, 3)] ?? days[day[0].toUpperCase() + day.slice(1)];
    if (Array.isArray(value)) total += value.reduce((sum, shift) => sum + shiftMinutes(shift), 0);
    else total += shiftMinutes(value);
  }
  return total;
}

function normalizeScheduleData(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw Object.assign(new Error('scheduleData must be valid JSON'), { status: 400 }); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('scheduleData must be a JSON object'), { status: 400 });
  }
  const json = JSON.stringify(parsed);
  if (Buffer.byteLength(json, 'utf8') > 128 * 1024) {
    throw Object.assign(new Error('scheduleData exceeds 128 KB'), { status: 413 });
  }
  return { value: parsed, json, scheduledMinutes: calculateScheduledMinutes(parsed) };
}

async function getWeeklySchedule(pool, locationId, userId, now = new Date()) {
  const week = getScheduleWeek(now);
  const [rows] = await pool.query(
    `SELECT userId, locationId, weekStart, weekEnd, scheduleData, scheduledMinutes,
            submittedAt, createdAt, updatedAt
     FROM user_schedule_weeks WHERE locationId = ? AND userId = ? AND weekStart = ? LIMIT 1`,
    [locationId, userId, week.weekStart]
  );
  const row = rows[0] || null;
  return { week, row: row ? { ...row, scheduleData: parseJson(row.scheduleData) } : null };
}

async function assertUserInLocation(pool, locationId, userId) {
  const [rows] = await pool.query(
    'SELECT id FROM users WHERE id = ? AND locationId = ? LIMIT 1',
    [userId, locationId]
  );
  if (!rows[0]) throw Object.assign(new Error('Dialer user not found in this location'), { status: 404 });
  return rows[0];
}

async function assertWeeklyScheduleSubmitted(pool, { locationId, userId, now = new Date() }) {
  await assertUserInLocation(pool, locationId, userId);
  const result = await getWeeklySchedule(pool, locationId, userId, now);
  if (!result.row || !result.row.submittedAt) {
    const error = Object.assign(new Error('Current-week dialer schedule must be submitted before pulling leads'), {
      status: 409,
      code: 'WEEKLY_SCHEDULE_REQUIRED',
      schedule: {
        ...result.week,
        userId,
        locationId,
        state: result.row ? 'draft' : 'missing',
        submitPath: `/api/users/${encodeURIComponent(userId)}/schedule/submit`,
      },
    });
    throw error;
  }
  return result;
}

async function saveWeeklySchedule(pool, { locationId, userId, scheduleData, submit = false, now = new Date() }) {
  await assertUserInLocation(pool, locationId, userId);
  const week = getScheduleWeek(now);
  const normalized = normalizeScheduleData(scheduleData);
  await pool.query(
    `INSERT INTO user_schedule_weeks
       (locationId, userId, weekStart, weekEnd, scheduleData, scheduledMinutes, submittedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ${submit ? 'UTC_TIMESTAMP(3)' : 'NULL'}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE weekEnd = VALUES(weekEnd), scheduleData = VALUES(scheduleData),
       scheduledMinutes = VALUES(scheduledMinutes), submittedAt = ${submit ? 'UTC_TIMESTAMP(3)' : 'NULL'},
       updatedAt = UTC_TIMESTAMP(3)`,
    [locationId, userId, week.weekStart, week.weekEnd, normalized.json, normalized.scheduledMinutes]
  );
  await pool.query(
    `INSERT INTO user_schedules (userId, locationId, scheduleData, updatedAt)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE locationId = VALUES(locationId), scheduleData = VALUES(scheduleData), updatedAt = CURRENT_TIMESTAMP`,
    [userId, locationId, normalized.json]
  );
  return getWeeklySchedule(pool, locationId, userId, now);
}

async function submitWeeklySchedule(pool, { locationId, userId, now = new Date() }) {
  await assertUserInLocation(pool, locationId, userId);
  const week = getScheduleWeek(now);
  const [result] = await pool.query(
    `UPDATE user_schedule_weeks SET submittedAt = UTC_TIMESTAMP(3), updatedAt = UTC_TIMESTAMP(3)
     WHERE locationId = ? AND userId = ? AND weekStart = ? AND scheduleData IS NOT NULL`,
    [locationId, userId, week.weekStart]
  );
  if (!result.affectedRows) throw Object.assign(new Error('Save a current-week schedule before submitting it'), { status: 409 });
  return getWeeklySchedule(pool, locationId, userId, now);
}

async function startWorkSession(pool, { locationId, userId, source = 'dialer', now = new Date() }) {
  await assertUserInLocation(pool, locationId, userId);
  const week = getScheduleWeek(now);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [active] = await conn.query(
      `SELECT id, startedAt FROM dialer_work_sessions
       WHERE locationId = ? AND userId = ? AND endedAt IS NULL FOR UPDATE`,
      [locationId, userId]
    );
    if (active[0]) {
      await conn.rollback();
      throw Object.assign(new Error('An active work session already exists'), { status: 409, session: active[0] });
    }
    const id = crypto.randomUUID();
    await conn.query(
      `INSERT INTO dialer_work_sessions
       (id, locationId, userId, weekStart, startedAt, status, source, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), 'active', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      [id, locationId, userId, week.weekStart, String(source || 'dialer').slice(0, 32)]
    );
    await conn.commit();
    return { id, locationId, userId, weekStart: week.weekStart, status: 'active' };
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally {
    conn.release();
  }
}

async function stopWorkSession(pool, { locationId, userId, sessionId }) {
  const [result] = await pool.query(
    `UPDATE dialer_work_sessions
     SET endedAt = UTC_TIMESTAMP(3), durationSeconds = GREATEST(0, TIMESTAMPDIFF(SECOND, startedAt, UTC_TIMESTAMP(3))),
         status = 'completed', updatedAt = UTC_TIMESTAMP(3)
     WHERE id = ? AND locationId = ? AND userId = ? AND endedAt IS NULL`,
    [sessionId, locationId, userId]
  );
  if (!result.affectedRows) throw Object.assign(new Error('Active work session not found'), { status: 404 });
  const [rows] = await pool.query(
    `SELECT id, locationId, userId, weekStart, startedAt, endedAt, durationSeconds, status, source
     FROM dialer_work_sessions WHERE id = ? LIMIT 1`, [sessionId]
  );
  return rows[0];
}

function parseJson(value) {
  if (value == null || typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

module.exports = {
  SCHEDULE_TIME_ZONE,
  getScheduleWeek,
  calculateScheduledMinutes,
  normalizeScheduleData,
  getWeeklySchedule,
  assertUserInLocation,
  assertWeeklyScheduleSubmitted,
  saveWeeklySchedule,
  submitWeeklySchedule,
  startWorkSession,
  stopWorkSession,
};
