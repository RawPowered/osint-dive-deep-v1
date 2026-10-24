const { getPool } = require('../db/pool');
const { normalizeIp } = require('./sentinelBlocks');
const { clampHours } = require('./sentinel');
const { enqueueTelemetry, registerBatchHandler } = require('./telemetryWriter');

registerBatchHandler('ip_sightings', async (batch) => {
  if (!batch || !batch.length) return;
  const pool = getPool();
  await pool.query(
    `INSERT INTO sentinel_ip_sightings
       (ip, first_seen, last_seen, first_status_code, first_path, first_method,
        first_was_auth_fail, total_requests, auth_fail_count, success_count, last_status_code)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       last_seen = VALUES(last_seen),
       total_requests = total_requests + VALUES(total_requests),
       auth_fail_count = auth_fail_count + VALUES(auth_fail_count),
       success_count = success_count + VALUES(success_count),
       last_status_code = VALUES(last_status_code)`,
    [batch]
  );
});

function isAuthFailStatus(status) {
  const s = Number(status);
  return s === 401 || s === 403;
}

function isSuccessStatus(status) {
  const s = Number(status);
  return s >= 200 && s < 400;
}

/**
 * Fire-and-forget IP first-contact tracking. Never throws to caller.
 */
function touchSighting(event = {}) {
  const ip = normalizeIp(event.ip);
  if (!ip) return Promise.resolve(false);

  const status = Number(event.status_code) || 0;
  const path = event.path ? String(event.path).slice(0, 255) : null;
  const method = event.method ? String(event.method).slice(0, 10) : null;
  const isFail = isAuthFailStatus(status) || event.error_class === 'blocked';
  const firstAuth = isFail ? 1 : 0;
  const successInc = isSuccessStatus(status) ? 1 : 0;
  const failInc = isFail ? 1 : 0;
  const now = new Date();

  return enqueueTelemetry('ip_sightings', [
    ip,
    now,
    now,
    status || null,
    path,
    method,
    firstAuth,
    1,
    failInc,
    successInc,
    status || null
  ]);
}

async function listNewAuthFailIps({ sinceHours = 24, limit = 100 } = {}) {
  const pool = getPool();
  const hours = clampHours(sinceHours);
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);

  const [rows] = await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*) FROM sentinel_ip_blocks b
              WHERE b.ip = s.ip AND b.is_active = 1
                AND (b.expires_at IS NULL OR b.expires_at > NOW(3))) AS block_count,
            (SELECT COUNT(*) FROM sentinel_threat_cases c
              WHERE c.entity_type = 'ip' AND c.entity = s.ip
                AND c.status IN ('open','under_review','watching')) AS open_cases
     FROM sentinel_ip_sightings s
     WHERE s.first_was_auth_fail = 1
       AND s.first_seen >= (NOW(3) - INTERVAL ? HOUR)
     ORDER BY s.first_seen DESC
     LIMIT ?`,
    [hours, lim]
  );

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM sentinel_ip_sightings
     WHERE first_was_auth_fail = 1
       AND first_seen >= (NOW(3) - INTERVAL ? HOUR)`,
    [hours]
  );

  return {
    sinceHours: hours,
    total: Number(countRows[0]?.total) || 0,
    ips: rows.map((r) => ({
      ip: r.ip,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      firstStatusCode: r.first_status_code,
      firstPath: r.first_path,
      firstMethod: r.first_method,
      firstWasAuthFail: Boolean(r.first_was_auth_fail),
      totalRequests: Number(r.total_requests) || 0,
      authFailCount: Number(r.auth_fail_count) || 0,
      successCount: Number(r.success_count) || 0,
      lastStatusCode: r.last_status_code,
      isBlocked: Number(r.block_count) > 0,
      openCases: Number(r.open_cases) || 0,
    })),
  };
}

async function countNewAuthFailIps({ sinceHours = 24 } = {}) {
  const pool = getPool();
  const hours = clampHours(sinceHours);
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total FROM sentinel_ip_sightings
     WHERE first_was_auth_fail = 1
       AND first_seen >= (NOW(3) - INTERVAL ? HOUR)`,
    [hours]
  );
  return Number(rows[0]?.total) || 0;
}

/**
 * Built-in style findings for first-auth-fail IPs (recent, no successes yet).
 */
async function computeFirstAuthFailFindings() {
  const pool = getPool();
  const findings = [];
  const [rows] = await pool.query(
    `SELECT ip, first_seen, last_seen, auth_fail_count, success_count, total_requests,
            first_path, first_status_code
     FROM sentinel_ip_sightings
     WHERE first_was_auth_fail = 1
       AND first_seen >= (NOW(3) - INTERVAL 24 HOUR)
       AND success_count = 0
       AND auth_fail_count >= 1
     ORDER BY auth_fail_count DESC
     LIMIT 25`
  );
  for (const r of rows) {
    if (!r.ip) continue;
    const fails = Number(r.auth_fail_count) || 0;
    findings.push({
      id: `first_auth_fail_ip:${r.ip}`,
      ruleId: 'first_auth_fail_ip',
      severity: fails >= 5 ? 'high' : 'medium',
      title: 'New IP failed authentication on first contact',
      summary: `${r.ip} first seen failing auth (${fails} fail(s), 0 success) — first path ${r.first_path || 'n/a'}`,
      entityType: 'ip',
      entity: r.ip,
      count: fails,
      windowHours: 24,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      recommendedAction:
        'Review New IPs radar; WHOIS the source; investigate timeline; block if clearly hostile',
    });
  }
  return findings;
}

module.exports = {
  touchSighting,
  listNewAuthFailIps,
  countNewAuthFailIps,
  computeFirstAuthFailFindings,
  isAuthFailStatus,
};
