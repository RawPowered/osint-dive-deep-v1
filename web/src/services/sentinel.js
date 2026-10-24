const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getSentinelRetentionDays } = require('../config');
const { enqueueTelemetry, registerBatchHandler } = require('./telemetryWriter');

registerBatchHandler('api_events', async (batch) => {
  if (!batch || !batch.length) return;
  const pool = getPool();
  await pool.query(
    `INSERT INTO api_sentinel_events
      (api_key_id, key_prefix, method, path, status_code, duration_ms, ip, user_agent,
       location_id, error_class, request_id, surface, actor_type, actor_id, actor_username,
       action, entity_type, entity_id, outcome)
     VALUES ?`,
    [batch]
  );
});

function newRequestId() {
  return crypto.randomUUID();
}

function clampHours(h) {
  const n = Number(h) || 24;
  if (n <= 0) return 24;
  return Math.min(n, 168);
}

/**
 * Fire-and-forget insert. Never throws to caller.
 */
function recordEvent(event) {
  return enqueueTelemetry('api_events', [
    event.api_key_id || null,
    event.key_prefix || null,
    String(event.method || '').slice(0, 10),
    String(event.path || '').slice(0, 255),
    Number(event.status_code) || 0,
    event.duration_ms != null ? Number(event.duration_ms) : null,
    event.ip ? String(event.ip).slice(0, 45) : null,
    event.user_agent ? String(event.user_agent).slice(0, 512) : null,
    event.location_id ? String(event.location_id).slice(0, 128) : null,
    event.error_class || null,
    event.request_id || newRequestId(),
    safeText(event.surface || 'api', 32),
    safeText(event.actor_type, 32),
    safeText(event.actor_id, 128),
    safeText(event.actor_username, 128),
    safeText(event.action, 128),
    safeText(event.entity_type, 64),
    safeText(event.entity_id, 191),
    safeText(event.outcome, 16),
  ]);
}

function buildEventWhere({
  apiKeyId,
  statusCode,
  pathContains,
  sinceHours,
  ip,
  errorClass,
  method,
  locationId,
  keyPrefix,
  surface,
  action,
  actorId,
  outcome,
  q,
}) {
  const where = [];
  const params = [];
  const hours = clampHours(sinceHours);

  where.push('created_at >= (NOW(3) - INTERVAL ? HOUR)');
  params.push(hours);

  if (apiKeyId) {
    where.push('api_key_id = ?');
    params.push(apiKeyId);
  }
  if (statusCode != null && statusCode !== '') {
    where.push('status_code = ?');
    params.push(Number(statusCode));
  }
  if (pathContains) {
    where.push('path LIKE ?');
    params.push(`%${pathContains}%`);
  }
  if (ip) {
    where.push('ip = ?');
    params.push(ip);
  }
  if (errorClass) {
    where.push('error_class = ?');
    params.push(errorClass);
  }
  if (method) {
    where.push('method = ?');
    params.push(String(method).toUpperCase());
  }
  if (locationId) {
    where.push('location_id = ?');
    params.push(locationId);
  }
  if (keyPrefix) {
    where.push('key_prefix LIKE ?');
    params.push(`${keyPrefix}%`);
  }
  if (surface) {
    where.push('surface = ?');
    params.push(String(surface).slice(0, 32));
  }
  if (action) {
    where.push('action = ?');
    params.push(String(action).slice(0, 128));
  }
  if (actorId) {
    where.push('actor_id = ?');
    params.push(String(actorId).slice(0, 128));
  }
  if (outcome) {
    where.push('outcome = ?');
    params.push(String(outcome).slice(0, 16));
  }
  if (q) {
    where.push(`(path LIKE ? OR ip LIKE ? OR key_prefix LIKE ? OR request_id LIKE ? OR location_id LIKE ?
      OR surface LIKE ? OR action LIKE ? OR actor_id LIKE ? OR actor_username LIKE ? OR entity_id LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like, like, like, like);
  }

  return { where, params, hours };
}

async function listEvents(opts = {}) {
  const pool = getPool();
  const { where, params } = buildEventWhere(opts);
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const off = Math.max(Number(opts.offset) || 0, 0);

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM api_sentinel_events ${sqlWhere}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT id, created_at, api_key_id, key_prefix, method, path, status_code, duration_ms,
            ip, user_agent, location_id, error_class, request_id, surface, actor_type,
            actor_id, actor_username, action, entity_type, entity_id, outcome,
            EXISTS(SELECT 1 FROM sentinel_http_envelopes h
              WHERE h.request_id = api_sentinel_events.request_id AND h.expires_at >= NOW(3)) AS has_evidence
     FROM api_sentinel_events
     ${sqlWhere}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, lim, off]
  );
  return { events: rows, total: Number(countRows[0].total) || 0 };
}

async function getSummary({ sinceHours = 24 } = {}) {
  const pool = getPool();
  const hours = clampHours(sinceHours);

  const [byKey] = await pool.query(
    `SELECT api_key_id, key_prefix,
            COUNT(*) AS requests,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN status_code = 401 THEN 1 ELSE 0 END) AS unauthorized,
            MAX(created_at) AS last_seen,
            AVG(duration_ms) AS avg_ms
     FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
     GROUP BY api_key_id, key_prefix
     ORDER BY requests DESC
     LIMIT 50`,
    [hours]
  );

  const [totals] = await pool.query(
    `SELECT COUNT(*) AS requests,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN status_code = 401 THEN 1 ELSE 0 END) AS unauthorized,
            SUM(CASE WHEN api_key_id IS NULL THEN 1 ELSE 0 END) AS unauthenticated,
            AVG(duration_ms) AS avg_ms,
            MIN(duration_ms) AS min_ms,
            MAX(duration_ms) AS max_ms
     FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)`,
    [hours]
  );

  const [topPaths] = await pool.query(
    `SELECT path, method, COUNT(*) AS requests,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN status_code = 401 THEN 1 ELSE 0 END) AS unauthorized,
            AVG(duration_ms) AS avg_ms
     FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
     GROUP BY path, method
     ORDER BY requests DESC
     LIMIT 25`,
    [hours]
  );

  const [topErrorPaths] = await pool.query(
    `SELECT path, method, COUNT(*) AS requests,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
     FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
       AND status_code >= 400
     GROUP BY path, method
     ORDER BY errors DESC
     LIMIT 15`,
    [hours]
  );

  const [statusHistogram] = await pool.query(
    `SELECT status_code, COUNT(*) AS count
     FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
     GROUP BY status_code
     ORDER BY count DESC
     LIMIT 20`,
    [hours]
  );

  const [bySurface] = await pool.query(
    `SELECT surface, COUNT(*) AS requests,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN outcome = 'denied' THEN 1 ELSE 0 END) AS denied
     FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
     GROUP BY surface ORDER BY requests DESC`,
    [hours]
  );

  const [authBursts] = await pool.query(
    `SELECT ip, COUNT(*) AS fails, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_sentinel_events
     WHERE status_code = 401
       AND created_at >= (NOW(3) - INTERVAL 1 HOUR)
     GROUP BY ip
     HAVING fails >= 10
     ORDER BY fails DESC
     LIMIT 20`
  );

  // Hourly buckets for charting
  const [hourly] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') AS bucket,
            COUNT(*) AS requests,
            SUM(CASE WHEN status_code = 401 THEN 1 ELSE 0 END) AS unauthorized,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
     FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [hours]
  );

  // Approximate p50/p95 via ordered sample (MySQL-friendly without PERCENTILE_CONT on all versions)
  const [durationRows] = await pool.query(
    `SELECT duration_ms FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
       AND duration_ms IS NOT NULL
     ORDER BY duration_ms ASC
     LIMIT 5000`,
    [hours]
  );
  const durations = durationRows.map((r) => Number(r.duration_ms)).filter((n) => !Number.isNaN(n));
  const latency = percentileStats(durations);

  const t = totals[0] || {};
  const requests = Number(t.requests) || 0;
  const errors = Number(t.errors) || 0;
  const unauthorized = Number(t.unauthorized) || 0;

  return {
    sinceHours: hours,
    totals: {
      ...t,
      requests,
      errors,
      unauthorized,
      unauthenticated: Number(t.unauthenticated) || 0,
      errorRate: requests ? errors / requests : 0,
      unauthorizedRate: requests ? unauthorized / requests : 0,
      avg_ms: t.avg_ms != null ? Number(t.avg_ms) : null,
    },
    latency,
    byKey,
    topPaths,
    topErrorPaths,
    statusHistogram,
    bySurface,
    hourly,
    anomalies: {
      authBurstIps: authBursts,
    },
  };
}

function safeText(value, length) {
  if (value == null || value === '') return null;
  return String(value).slice(0, length);
}

function percentileStats(sortedValues) {
  if (!sortedValues.length) {
    return { count: 0, p50: null, p95: null, p99: null };
  }
  const pick = (p) => {
    const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
    return sortedValues[idx];
  };
  return {
    count: sortedValues.length,
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
  };
}

async function purgeOldEvents() {
  const days = getSentinelRetentionDays();
  try {
    const pool = getPool();
    await pool.query(
      `DELETE FROM api_sentinel_events WHERE created_at < (NOW(3) - INTERVAL ? DAY)`,
      [days]
    );
  } catch {
    /* ignore */
  }
}

module.exports = {
  newRequestId,
  recordEvent,
  listEvents,
  getSummary,
  purgeOldEvents,
  clampHours,
  buildEventWhere,
};
