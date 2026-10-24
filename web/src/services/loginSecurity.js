const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool } = require('../db/pool');
const { getSentinelRetentionDays } = require('../config');
const { enqueueTelemetry } = require('./telemetryWriter');

function newRequestId() {
  return crypto.randomUUID();
}

/**
 * Queue and confirm a login/auth security event write. Never stores passwords.
 * Callers handling security-sensitive mutations await the returned promise.
 * event_type: login | logout | password_reset | password_change | auth_log
 * outcome: success | failure | locked | unknown
 */
function recordLoginEvent(event) {
  return enqueueTelemetry('login_events', async () => {
      const pool = getPool();
      await pool.query(
        `INSERT INTO api_login_events
          (event_type, outcome, username, email, user_id, location_id, ip, user_agent,
           api_key_id, key_prefix, detail, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(event.event_type || 'login').slice(0, 32),
          String(event.outcome || 'unknown').slice(0, 32),
          event.username ? String(event.username).slice(0, 128) : null,
          event.email ? String(event.email).slice(0, 255).toLowerCase() : null,
          event.user_id ? String(event.user_id).slice(0, 128) : null,
          event.location_id ? String(event.location_id).slice(0, 128) : null,
          event.ip ? String(event.ip).slice(0, 45) : null,
          event.user_agent ? String(event.user_agent).slice(0, 512) : null,
          event.api_key_id || null,
          event.key_prefix || null,
          event.detail ? String(event.detail).slice(0, 255) : null,
          event.request_id || newRequestId(),
        ]
      );
  });
}

/**
 * Verify dialer credentials against a bcrypt value in users.passwordHash.
 * The API login route supplies the installed core (Legacy) pool explicitly so the
 * lookup, password verification, and operator session all use the same database.
 * Accepts bcrypt-backed plaintext verification only. Client-supplied hashes are never credentials.
 */
async function verifyUserCredentials(
  { locationId, userId, username, email, password, passwordHash },
  pool = null
) {
  const p = pool || getPool();
  let row = null;
  const normalizedLocationId = locationId == null ? '' : String(locationId).trim();
  const normalizedUserId = userId == null ? '' : String(userId).trim();
  const normalizedUsername = username == null ? '' : String(username).trim();
  const normalizedEmail = email == null ? '' : String(email).trim().toLowerCase();

  if (normalizedUserId && normalizedLocationId) {
    const [rows] = await p.query(
      `SELECT id, locationId, username, email, passwordHash, role, crmUserId, crmUserName
       FROM users WHERE id = ? AND locationId = ? LIMIT 1`,
      [normalizedUserId, normalizedLocationId]
    );
    row = rows[0] || null;
  }
  if (!row && normalizedUsername && normalizedLocationId) {
    const [rows] = await p.query(
      `SELECT id, locationId, username, email, passwordHash, role, crmUserId, crmUserName
       FROM users WHERE username = ? AND locationId = ? LIMIT 1`,
      [normalizedUsername, normalizedLocationId]
    );
    row = rows[0] || null;
  }
  if (!row && normalizedEmail && normalizedLocationId) {
    const [rows] = await p.query(
      `SELECT id, locationId, username, email, passwordHash, role, crmUserId, crmUserName
       FROM users WHERE LOWER(email) = ? AND locationId = ? LIMIT 1`,
      [normalizedEmail, normalizedLocationId]
    );
    row = rows[0] || null;
  }
  // Fallback: username/email without location (single-tenant convenience)
  if (!row && normalizedUsername && !normalizedLocationId) {
    const [rows] = await p.query(
      `SELECT id, locationId, username, email, passwordHash, role, crmUserId, crmUserName
       FROM users WHERE username = ? LIMIT 1`,
      [normalizedUsername]
    );
    row = rows[0] || null;
  }
  if (!row && normalizedEmail && !normalizedLocationId) {
    const [rows] = await p.query(
      `SELECT id, locationId, username, email, passwordHash, role, crmUserId, crmUserName
       FROM users WHERE LOWER(email) = ? LIMIT 1`,
      [normalizedEmail]
    );
    row = rows[0] || null;
  }

  // These reasons are written only to protected login telemetry. The public
  // route deliberately keeps returning the same non-enumerating 401 response.
  if (!row) return failedCredential('identity_not_found');
  if (!row.passwordHash) return failedCredential('credential_not_configured');

  let match = false;
  const stored = String(row.passwordHash);
  const hasPassword = password != null && String(password).length > 0;
  const storedIsBcrypt = /^\$2[aby]\$/.test(stored);
  const passwordScheme = storedIsBcrypt ? 'bcrypt' : 'unsupported';

  if (hasPassword && storedIsBcrypt) {
    match = await bcrypt.compare(String(password), stored);
  }

  if (!match) {
    if (!storedIsBcrypt) return failedCredential('legacy_credential_disabled');
    if (!hasPassword && passwordHash) return failedCredential('bcrypt_plaintext_required');
    return failedCredential('password_mismatch');
  }

  return {
    ok: true,
    reason: 'ok',
    passwordScheme,
    user: {
      id: row.id,
      locationId: row.locationId,
      username: row.username,
      email: row.email,
      role: row.role,
      crmUserId: row.crmUserId,
      crmUserName: row.crmUserName,
    },
  };
}

function failedCredential(reason) {
  return { ok: false, reason, user: null };
}

/**
 * Convert password-write input into the only value that may be persisted.
 * Plaintext always takes precedence and is bcrypt-hashed on the API host.
 * Client-supplied opaque hashes are rejected because a stolen hash must not be reusable.
 */
async function preparePasswordCredential({ password, passwordHash, minLength = 6 } = {}) {
  const plaintext = password == null ? '' : String(password);
  if (plaintext.length > 0) {
    if (plaintext.length < minLength) {
      throw Object.assign(new Error(`Password must be at least ${minLength} characters`), {
        status: 400,
        code: 'PASSWORD_TOO_SHORT',
      });
    }
    return {
      value: await bcrypt.hash(plaintext, 12),
      scheme: 'bcrypt',
    };
  }

  const legacyHash = passwordHash == null ? '' : String(passwordHash);
  if (legacyHash.length > 0) {
    throw Object.assign(new Error('Client-supplied password hashes are not accepted'), {
      status: 400,
      code: 'PASSWORD_HASH_UNSUPPORTED',
    });
  }

  throw Object.assign(new Error('Provide password'), {
    status: 400,
    code: 'PASSWORD_REQUIRED',
  });
}

function clampHours(h) {
  const n = Number(h) || 24;
  if (n <= 0) return 24;
  return Math.min(n, 168);
}

function buildLoginWhere({
  outcome,
  eventType,
  locationId,
  username,
  sinceHours = 24,
  ip,
  email,
  detail,
  q,
  userId,
}) {
  const where = [];
  const params = [];
  const hours = clampHours(sinceHours);
  where.push('created_at >= (NOW(3) - INTERVAL ? HOUR)');
  params.push(hours);

  if (outcome) {
    where.push('outcome = ?');
    params.push(outcome);
  }
  if (eventType) {
    where.push('event_type = ?');
    params.push(eventType);
  }
  if (locationId) {
    where.push('location_id = ?');
    params.push(locationId);
  }
  if (username) {
    where.push('(username = ? OR email = ? OR user_id = ?)');
    params.push(username, username, username);
  }
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  if (ip) {
    where.push('ip = ?');
    params.push(ip);
  }
  if (email) {
    where.push('LOWER(email) = ?');
    params.push(String(email).toLowerCase());
  }
  if (detail) {
    where.push('detail LIKE ?');
    params.push(`%${detail}%`);
  }
  if (q) {
    where.push(
      '(username LIKE ? OR email LIKE ? OR user_id LIKE ? OR ip LIKE ? OR detail LIKE ? OR location_id LIKE ?)'
    );
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  return { where, params, hours };
}

async function listLoginEvents(opts = {}) {
  const pool = getPool();
  const { where, params } = buildLoginWhere(opts);
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const off = Math.max(Number(opts.offset) || 0, 0);

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM api_login_events ${sqlWhere}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT id, created_at, event_type, outcome, username, email, user_id, location_id,
            ip, user_agent, api_key_id, key_prefix, detail, request_id
     FROM api_login_events
     ${sqlWhere}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, lim, off]
  );
  return { logins: rows, total: Number(countRows[0].total) || 0 };
}

async function getLoginSummary({ sinceHours = 24 } = {}) {
  const pool = getPool();
  const hours = clampHours(sinceHours);

  const [totals] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes,
            SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures,
            SUM(CASE WHEN event_type = 'login' THEN 1 ELSE 0 END) AS logins,
            SUM(CASE WHEN event_type = 'password_reset' THEN 1 ELSE 0 END) AS password_resets
     FROM api_login_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)`,
    [hours]
  );

  const t = totals[0] || {};
  const total = Number(t.total) || 0;
  const successes = Number(t.successes) || 0;
  const failures = Number(t.failures) || 0;

  const [failByIp] = await pool.query(
    `SELECT ip, COUNT(*) AS fails, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_login_events
     WHERE outcome = 'failure'
       AND created_at >= (NOW(3) - INTERVAL 1 HOUR)
     GROUP BY ip
     HAVING fails >= 5
     ORDER BY fails DESC
     LIMIT 20`
  );

  const [failByUser] = await pool.query(
    `SELECT COALESCE(username, email, user_id, '(unknown)') AS identity, COUNT(*) AS fails,
            MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_login_events
     WHERE outcome = 'failure'
       AND created_at >= (NOW(3) - INTERVAL 1 HOUR)
     GROUP BY identity
     HAVING fails >= 5
     ORDER BY fails DESC
     LIMIT 20`
  );

  const [recentFails] = await pool.query(
    `SELECT created_at, event_type, username, email, user_id, location_id, ip, detail
     FROM api_login_events
     WHERE outcome = 'failure'
       AND created_at >= (NOW(3) - INTERVAL ? HOUR)
     ORDER BY created_at DESC
     LIMIT 25`,
    [hours]
  );

  const [byLocation] = await pool.query(
    `SELECT location_id,
            COUNT(*) AS total,
            SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes,
            SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures
     FROM api_login_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
     GROUP BY location_id
     ORDER BY total DESC
     LIMIT 20`,
    [hours]
  );

  const [hourly] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') AS bucket,
            COUNT(*) AS total,
            SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes,
            SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures
     FROM api_login_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [hours]
  );

  return {
    sinceHours: hours,
    totals: {
      ...t,
      total,
      successes,
      failures,
      failRate: total ? failures / total : 0,
      successRate: total ? successes / total : 0,
    },
    anomalies: {
      failBurstIps: failByIp,
      failBurstIdentities: failByUser,
    },
    recentFailures: recentFails,
    byLocation,
    hourly,
  };
}

async function purgeOldLoginEvents() {
  const days = getSentinelRetentionDays();
  try {
    const pool = getPool();
    await pool.query(
      `DELETE FROM api_login_events WHERE created_at < (NOW(3) - INTERVAL ? DAY)`,
      [days]
    );
  } catch {
    /* ignore */
  }
}

module.exports = {
  recordLoginEvent,
  verifyUserCredentials,
  preparePasswordCredential,
  listLoginEvents,
  getLoginSummary,
  purgeOldLoginEvents,
  newRequestId,
  clampHours,
  buildLoginWhere,
};
