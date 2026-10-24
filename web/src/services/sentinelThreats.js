const { getPool } = require('../db/pool');
const { getSummary, clampHours } = require('./sentinel');
const { getLoginSummary } = require('./loginSecurity');
const { evaluateCustomRules } = require('./sentinelRules');
const { computeFirstAuthFailFindings, countNewAuthFailIps } = require('./sentinelSightings');
const {applyFindingDispositions}=require('./sentinelFindingDispositions');
const {
  syncFindingsToCases,
  attachCaseMetaToFindings,
  countOpenCases,
  getCaseOperationsReport,
} = require('./sentinelCases');

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/**
 * Server-side finding engine + posture score for OpSec console.
 */
async function computeThreats({ sinceHours = 24, syncCases = true } = {}) {
  const pool = getPool();
  const hours = clampHours(sinceHours);
  const findings = [];

  // --- Login fail by IP (1h window for burst) ---
  const [loginFailIps] = await pool.query(
    `SELECT ip, COUNT(*) AS count, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_login_events
     WHERE outcome = 'failure' AND created_at >= (NOW(3) - INTERVAL 1 HOUR)
     GROUP BY ip HAVING count >= 5
     ORDER BY count DESC LIMIT 25`
  );
  for (const r of loginFailIps) {
    if (!r.ip) continue;
    findings.push({
      id: `login_fail_ip:${r.ip}`,
      ruleId: 'login_fail_ip',
      severity: r.count >= 20 ? 'critical' : 'high',
      title: 'Credential failures from IP',
      summary: `${r.count} failed auth events from ${r.ip} in the last hour`,
      entityType: 'ip',
      entity: r.ip,
      count: Number(r.count),
      windowHours: 1,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      recommendedAction:
        'Inspect login timeline for this IP; consider edge block; force password reset if accounts were targeted',
    });
  }

  // --- Login fail by identity ---
  const [loginFailIds] = await pool.query(
    `SELECT COALESCE(username, email, user_id, '(unknown)') AS identity,
            COUNT(*) AS count, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_login_events
     WHERE outcome = 'failure' AND created_at >= (NOW(3) - INTERVAL 1 HOUR)
     GROUP BY identity HAVING count >= 5
     ORDER BY count DESC LIMIT 25`
  );
  for (const r of loginFailIds) {
    findings.push({
      id: `login_fail_identity:${r.identity}`,
      ruleId: 'login_fail_identity',
      severity: r.count >= 15 ? 'critical' : 'high',
      title: 'Credential failures for identity',
      summary: `${r.count} failed attempts against ${r.identity} in the last hour`,
      entityType: 'identity',
      entity: r.identity,
      count: Number(r.count),
      windowHours: 1,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      recommendedAction: 'Reset password; review CRM linkage; check for shared/compromised credentials',
    });
  }

  // --- Password spray: many identities from one IP ---
  const [spray] = await pool.query(
    `SELECT ip,
            COUNT(*) AS fails,
            COUNT(DISTINCT COALESCE(username, email, user_id, '')) AS identities,
            MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_login_events
     WHERE outcome = 'failure' AND created_at >= (NOW(3) - INTERVAL 1 HOUR)
     GROUP BY ip
     HAVING identities >= 3 AND fails >= 6
     ORDER BY identities DESC LIMIT 20`
  );
  for (const r of spray) {
    if (!r.ip) continue;
    findings.push({
      id: `login_spray:${r.ip}`,
      ruleId: 'login_spray',
      severity: 'critical',
      title: 'Password spray pattern',
      summary: `${r.identities} distinct identities failed from ${r.ip} (${r.fails} attempts, 1h)`,
      entityType: 'ip',
      entity: r.ip,
      count: Number(r.fails),
      windowHours: 1,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      recommendedAction: 'Block or rate-limit IP at edge; review all targeted accounts; enable monitoring alerts',
    });
  }

  // --- API key 401 spray ---
  const [api401] = await pool.query(
    `SELECT ip, COUNT(*) AS count, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_sentinel_events
     WHERE status_code = 401 AND created_at >= (NOW(3) - INTERVAL 1 HOUR)
     GROUP BY ip HAVING count >= 10
     ORDER BY count DESC LIMIT 20`
  );
  for (const r of api401) {
    if (!r.ip) continue;
    findings.push({
      id: `api_key_spray:${r.ip}`,
      ruleId: 'api_key_spray',
      severity: r.count >= 50 ? 'critical' : 'high',
      title: 'API key authentication failures',
      summary: `${r.count} HTTP 401 responses to ${r.ip} in the last hour`,
      entityType: 'ip',
      entity: r.ip,
      count: Number(r.count),
      windowHours: 1,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      recommendedAction: 'Verify key leakage; revoke compromised keys; block abusive IP',
    });
  }

  // --- Secret control-plane authorization failures ---
  const [controlDenials] = await pool.query(
    `SELECT ip, surface, COUNT(*) AS count, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_sentinel_events
     WHERE surface IN ('owl','eagle','song','admin') AND outcome = 'denied'
       AND created_at >= (NOW(3) - INTERVAL 1 HOUR)
     GROUP BY ip, surface HAVING count >= 5
     ORDER BY count DESC LIMIT 25`
  );
  for (const r of controlDenials) {
    if (!r.ip) continue;
    findings.push({
      id:`control_denied:${r.surface}:${r.ip}`,
      ruleId:'control_plane_denied',
      severity:Number(r.count) >= 15 ? 'critical' : 'high',
      title:'Control-plane access denied repeatedly',
      summary:`${r.count} denied ${r.surface} requests from ${r.ip} in the last hour`,
      entityType:'ip', entity:r.ip, count:Number(r.count), windowHours:1,
      firstSeen:r.first_seen, lastSeen:r.last_seen,
      recommendedAction:'Review the normalized control-plane path and actor context; block the IP if the activity is not authorized',
    });
  }

  // A successful write without an authenticated admin principal should never occur.
  const [anonymousWrites] = await pool.query(
    `SELECT ip, surface, action, COUNT(*) AS count, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_sentinel_events
     WHERE surface IN ('owl','eagle','song','admin') AND outcome = 'success'
       AND actor_type = 'anonymous' AND method IN ('POST','PUT','PATCH','DELETE')
       AND created_at >= (NOW(3) - INTERVAL ? HOUR)
     GROUP BY ip, surface, action ORDER BY count DESC LIMIT 25`,
    [hours]
  );
  for (const r of anonymousWrites) {
    findings.push({
      id:`anonymous_control_write:${r.surface}:${r.action || 'unknown'}:${r.ip || 'unknown'}`,
      ruleId:'anonymous_control_write', severity:'critical',
      title:'Anonymous control-plane mutation succeeded',
      summary:`${r.count} successful ${r.action || r.surface} mutation(s) lacked an authenticated admin principal`,
      entityType:'ip', entity:r.ip || '(unknown)', count:Number(r.count), windowHours:hours,
      firstSeen:r.first_seen, lastSeen:r.last_seen,
      recommendedAction:'Treat as an authorization bypass: isolate the deployment, inspect the request ID, and rotate affected credentials',
    });
  }

  // EAGLE exports contain broad lead and demographic datasets and merit burst monitoring.
  const [exportBursts] = await pool.query(
    `SELECT COALESCE(actor_id, ip, '(unknown)') AS actor, ip, COUNT(*) AS count,
            MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_sentinel_events
     WHERE action = 'eagle.leads.export' AND outcome = 'success'
       AND created_at >= (NOW(3) - INTERVAL 1 HOUR)
     GROUP BY actor, ip HAVING count >= 3
     ORDER BY count DESC LIMIT 20`
  );
  for (const r of exportBursts) {
    findings.push({
      id:`eagle_export_burst:${r.actor}`,
      ruleId:'eagle_export_burst',
      severity:Number(r.count) >= 10 ? 'high' : 'medium',
      title:'EAGLE lead export burst',
      summary:`${r.count} complete lead exports by ${r.actor} in the last hour`,
      entityType:'identity', entity:r.actor, count:Number(r.count), windowHours:1,
      firstSeen:r.first_seen, lastSeen:r.last_seen,
      recommendedAction:'Confirm the export activity with the administrator and review destination handling for the downloaded data',
    });
  }

  // --- Error rate spike over full window ---
  const [errTot] = await pool.query(
    `SELECT COUNT(*) AS requests,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
     FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)`,
    [hours]
  );
  const reqs = Number(errTot[0]?.requests) || 0;
  const errs = Number(errTot[0]?.errors) || 0;
  const errRate = reqs ? errs / reqs : 0;
  if (reqs >= 20 && errRate >= 0.3) {
    findings.push({
      id: 'api_error_spike',
      ruleId: 'api_error_spike',
      severity: errRate >= 0.5 ? 'high' : 'medium',
      title: 'Elevated API error rate',
      summary: `${Math.round(errRate * 100)}% of ${reqs} requests returned 4xx/5xx in ${hours}h`,
      entityType: 'metric',
      entity: 'error_rate',
      count: errs,
      windowHours: hours,
      firstSeen: null,
      lastSeen: null,
      recommendedAction: 'Review top error paths and upstream dependencies; check deploy regressions',
    });
  }

  // --- Password reset burst ---
  const [resetIp] = await pool.query(
    `SELECT ip, COUNT(*) AS count, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_login_events
     WHERE event_type = 'password_reset' AND created_at >= (NOW(3) - INTERVAL 1 HOUR)
     GROUP BY ip HAVING count >= 5
     ORDER BY count DESC LIMIT 15`
  );
  for (const r of resetIp) {
    if (!r.ip) continue;
    findings.push({
      id: `password_reset_burst:${r.ip}`,
      ruleId: 'password_reset_burst',
      severity: 'medium',
      title: 'Password reset burst',
      summary: `${r.count} password_reset events from ${r.ip} in 1h`,
      entityType: 'ip',
      entity: r.ip,
      count: Number(r.count),
      windowHours: 1,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      recommendedAction: 'Confirm legitimate admin/agent activity; throttle reset endpoint if abusive',
    });
  }

  // --- Noisy error paths ---
  const [badPaths] = await pool.query(
    `SELECT path, method, status_code, api_key_id, key_prefix, ip, COUNT(*) AS count,
            COUNT(*) AS errors,
            MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
     FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR) AND status_code >= 400
     GROUP BY path, method, status_code, api_key_id, key_prefix, ip
     HAVING errors >= 10
     ORDER BY errors DESC LIMIT 15`,
    [hours]
  );
  for (const r of badPaths) {
    findings.push({
      id: `path_errors:${r.method}:${r.path}:${r.status_code}:${r.api_key_id || r.key_prefix || 'anonymous'}:${r.ip || 'unknown'}`,
      ruleId: 'new_path_errors',
      severity: Number(r.errors) >= 50 ? 'medium' : 'low',
      title: 'High-error API path',
      summary: `${r.method} ${r.path} — ${r.errors}/${r.count} errors in ${hours}h`,
      entityType: 'path',
      entity: `${r.method} ${r.path}`,
      fingerprintEntity:`${r.method} ${r.path}|${r.status_code}|${r.api_key_id || r.key_prefix || 'anonymous'}|${r.ip || 'unknown'}`,
      count: Number(r.errors),
      windowHours: hours,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      context:{method:r.method,path:r.path,statusCode:Number(r.status_code),apiKeyId:r.api_key_id||null,keyPrefix:r.key_prefix||null,ip:r.ip||null},
      recommendedAction: 'Inspect client payloads and server logs for this route',
    });
  }

  // --- Slow API ---
  const [slow] = await pool.query(
    `SELECT AVG(duration_ms) AS avg_ms, COUNT(*) AS count,
            MAX(duration_ms) AS max_ms
     FROM api_sentinel_events
     WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
       AND duration_ms IS NOT NULL`,
    [hours]
  );
  const slowCount = Number(slow[0]?.count) || 0;
  const maxMs = Number(slow[0]?.max_ms) || 0;
  if (slowCount >= 10 && maxMs >= 2000) {
    // Use sample of high latency rows
    const [slowPaths] = await pool.query(
      `SELECT path, method, AVG(duration_ms) AS avg_ms, COUNT(*) AS count
       FROM api_sentinel_events
       WHERE created_at >= (NOW(3) - INTERVAL ? HOUR)
         AND duration_ms >= 2000
       GROUP BY path, method
       ORDER BY avg_ms DESC LIMIT 5`,
      [hours]
    );
    if (slowPaths.length) {
      findings.push({
        id: 'slow_api',
        ruleId: 'slow_api',
        severity: 'low',
        title: 'Elevated API latency',
        summary: `${slowPaths.length} path(s) with samples ≥2000ms (max observed ${maxMs}ms)`,
        entityType: 'path',
        entity: `${slowPaths[0].method} ${slowPaths[0].path}`,
        count: slowCount,
        windowHours: hours,
        firstSeen: null,
        lastSeen: null,
        recommendedAction: 'Profile slow routes and database indexes; check shared hosting load',
        evidence: slowPaths,
      });
    }
  }

  // --- First-contact auth-fail IPs ---
  try {
    const firstFail = await computeFirstAuthFailFindings();
    findings.push(...firstFail);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('first auth fail findings:', err.message);
    }
  }

  // --- Custom admin rules ---
  try {
    const custom = await evaluateCustomRules();
    findings.push(...custom);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('custom rules eval:', err.message);
    }
  }

  const dispositionResult=await applyFindingDispositions(findings).catch(()=>({active:findings,suppressed:[],acknowledged:[]}));
  const activeFindings=dispositionResult.active;
  activeFindings.sort((a, b) => {
    const sa = SEV_RANK[a.severity] ?? 9;
    const sb = SEV_RANK[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return (b.count || 0) - (a.count || 0);
  });

  let caseSync = { created: 0, updated: 0 };
  if (syncCases) {
    try {
      caseSync = await syncFindingsToCases(activeFindings);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('case sync:', err.message);
      }
    }
  }

  let withCases = activeFindings;
  try {
    withCases = await attachCaseMetaToFindings(activeFindings);
  } catch {
    withCases = activeFindings;
  }

  return {
    sinceHours: hours,
    findings: withCases,
    counts: countBySeverity(withCases),
    caseSync,
    suppressed:{total:dispositionResult.suppressed.length,findings:dispositionResult.suppressed},
  };
}

function countBySeverity(findings) {
  const c = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (c[f.severity] != null) c[f.severity] += 1;
  }
  return c;
}

function computePosture({ apiSummary, loginSummary, threats, openCases, newAuthFailIps, operations = {}, freshness = {} }) {
  let score = 100;
  const factors = [];

  const counts = threats.counts || countBySeverity(threats.findings || []);
  if (counts.critical) {
    score -= counts.critical * 25;
    factors.push({ code: 'critical_findings', impact: -counts.critical * 25, detail: `${counts.critical} critical` });
  }
  if (counts.high) {
    score -= counts.high * 12;
    factors.push({ code: 'high_findings', impact: -counts.high * 12, detail: `${counts.high} high` });
  }
  if (counts.medium) {
    score -= counts.medium * 5;
    factors.push({ code: 'medium_findings', impact: -counts.medium * 5, detail: `${counts.medium} medium` });
  }

  const errRate = Number(apiSummary?.totals?.errorRate) || 0;
  if (errRate >= 0.1) {
    const pen = Math.min(20, Math.round(errRate * 40));
    score -= pen;
    factors.push({ code: 'api_error_rate', impact: -pen, detail: `${Math.round(errRate * 100)}% API errors` });
  }

  const unauthRate = Number(apiSummary?.totals?.unauthorizedRate) || 0;
  if (unauthRate >= 0.05) {
    const pen = Math.min(15, Math.round(unauthRate * 50));
    score -= pen;
    factors.push({ code: 'api_401_rate', impact: -pen, detail: `${Math.round(unauthRate * 100)}% API 401s` });
  }

  const loginFailRate = Number(loginSummary?.totals?.failRate) || 0;
  if (loginFailRate >= 0.2) {
    const pen = Math.min(20, Math.round(loginFailRate * 35));
    score -= pen;
    factors.push({
      code: 'login_fail_rate',
      impact: -pen,
      detail: `${Math.round(loginFailRate * 100)}% login failures`,
    });
  }

  const openCritical = Number(openCases?.openCritical) || 0;
  const openReview = Number(openCases?.openReview) || 0;
  if (openCritical > 0) {
    const pen = Math.min(15, openCritical * 5);
    score -= pen;
    factors.push({
      code: 'unreviewed_critical_cases',
      impact: -pen,
      detail: `${openCritical} unreviewed critical case(s)`,
    });
  } else if (openReview >= 5) {
    const pen = Math.min(10, Math.floor(openReview / 2));
    score -= pen;
    factors.push({
      code: 'review_backlog',
      impact: -pen,
      detail: `${openReview} cases in review queue`,
    });
  }

  const newFails = Number(newAuthFailIps) || 0;
  if (newFails >= 3) {
    const pen = Math.min(10, newFails);
    score -= pen;
    factors.push({
      code: 'new_first_fail_ips',
      impact: -pen,
      detail: `${newFails} new first-fail IP(s)`,
    });
  }

  const slaBreached = Number(operations.slaBreached) || 0;
  if (slaBreached) {
    const pen = Math.min(20, slaBreached * 4);
    score -= pen;
    factors.push({ code:'sla_breaches', impact:-pen, detail:`${slaBreached} case SLA breach(es)`, pivot:{ tab:'review', sla:'breached' } });
  }
  const unassigned = Number(operations.unassigned) || 0;
  if (unassigned >= 3) {
    const pen = Math.min(10, unassigned);
    score -= pen;
    factors.push({ code:'unassigned_cases', impact:-pen, detail:`${unassigned} active cases without owners`, pivot:{ tab:'review', owner:'unassigned' } });
  }
  const closureQuality = Number(operations.closureQualityRate);
  if (Number.isFinite(closureQuality) && closureQuality < 0.9) {
    const pen = Math.min(12, Math.round((1 - closureQuality) * 20));
    score -= pen;
    factors.push({ code:'closure_quality', impact:-pen, detail:`${Math.round(closureQuality * 100)}% documented and validated closures` });
  }
  const eventAge = freshness.apiLastSeen ? Date.now() - new Date(freshness.apiLastSeen).getTime() : Infinity;
  if (eventAge > 15 * 60 * 1000) {
    score -= 10;
    factors.push({ code:'telemetry_freshness', impact:-10, detail:'API security telemetry is older than 15 minutes' });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let grade = 'healthy';
  if (score < 40) grade = 'critical';
  else if (score < 70) grade = 'elevated';
  else if (score < 90) grade = 'watch';

  return { score, grade, factors };
}

async function getPostureBundle({ sinceHours = 24 } = {}) {
  const hours = clampHours(sinceHours);
  const [apiSummary, loginSummary, threats, openCases, newAuthFailIps, operationsReport, comparison, freshness] = await Promise.all([
    getSummary({ sinceHours: hours }),
    getLoginSummary({ sinceHours: hours }),
    computeThreats({ sinceHours: hours, syncCases: true }),
    countOpenCases().catch(() => ({ openReview: 0, openCritical: 0, watching: 0 })),
    countNewAuthFailIps({ sinceHours: hours }).catch(() => 0),
    getCaseOperationsReport({ sinceHours:hours }).catch(() => ({ totals:{} })),
    getPostureComparison(hours).catch(() => ({})),
    getTelemetryFreshness().catch(() => ({})),
  ]);
  const posture = computePosture({
    apiSummary,
    loginSummary,
    threats,
    openCases,
    newAuthFailIps,
    operations:operationsReport.totals,
    freshness,
  });
  return {
    sinceHours: hours,
    posture,
    apiSummary,
    loginSummary,
    threats,
    response: {
      openCases,
      newAuthFailIps,
      operations:operationsReport,
    },
    comparison,
    freshness,
  };
}

async function getPostureComparison(hours) {
  const pool = getPool();
  const [api] = await pool.query(
    `SELECT COUNT(*) AS requests,SUM(status_code>=400) AS errors,SUM(status_code IN (401,403)) AS unauthorized
     FROM api_sentinel_events WHERE created_at>=NOW(3)-INTERVAL ? HOUR AND created_at<NOW(3)-INTERVAL ? HOUR`,
    [hours * 2,hours]
  );
  const [login] = await pool.query(
    `SELECT COUNT(*) AS events,SUM(outcome='failure') AS failures FROM api_login_events
     WHERE created_at>=NOW(3)-INTERVAL ? HOUR AND created_at<NOW(3)-INTERVAL ? HOUR`,
    [hours * 2,hours]
  );
  return { priorWindowHours:hours, api:normalizeCounts(api[0]), login:normalizeCounts(login[0]) };
}

async function getTelemetryFreshness() {
  const pool = getPool();
  const [[api],[login],[cases]] = await Promise.all([
    pool.query(`SELECT MAX(created_at) AS lastSeen FROM api_sentinel_events`),
    pool.query(`SELECT MAX(created_at) AS lastSeen FROM api_login_events`),
    pool.query(`SELECT MAX(updated_at) AS lastSeen FROM sentinel_threat_cases`),
  ]);
  return { apiLastSeen:api[0]?.lastSeen || null, loginLastSeen:login[0]?.lastSeen || null, caseLastUpdated:cases[0]?.lastSeen || null, calculatedAt:new Date().toISOString() };
}

function normalizeCounts(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value)||0]));
}

async function getTimeline({
  sinceHours = 24,
  limit = 150,
  ip,
  locationId,
  q,
  pathContains,
  username,
  cursor,
} = {}) {
  const pool = getPool();
  const hours = clampHours(sinceHours);
  const lim = Math.min(Math.max(Number(limit) || 150, 1), 300);
  const before = cursor && !Number.isNaN(new Date(cursor).getTime()) ? new Date(cursor) : null;

  const loginWhere = ['created_at >= (NOW(3) - INTERVAL ? HOUR)'];
  const loginParams = [hours];
  if (before) { loginWhere.push('created_at < ?'); loginParams.push(before); }
  if (ip) {
    loginWhere.push('ip = ?');
    loginParams.push(ip);
  }
  if (locationId) {
    loginWhere.push('location_id = ?');
    loginParams.push(locationId);
  }
  if (username) {
    loginWhere.push('(username = ? OR email = ? OR user_id = ?)');
    loginParams.push(username, username, username);
  }
  if (q) {
    loginWhere.push('(username LIKE ? OR email LIKE ? OR ip LIKE ? OR detail LIKE ?)');
    const like = `%${q}%`;
    loginParams.push(like, like, like, like);
  }

  const apiWhere = ['created_at >= (NOW(3) - INTERVAL ? HOUR)'];
  const apiParams = [hours];
  if (before) { apiWhere.push('created_at < ?'); apiParams.push(before); }
  if (ip) {
    apiWhere.push('ip = ?');
    apiParams.push(ip);
  }
  if (locationId) {
    apiWhere.push('location_id = ?');
    apiParams.push(locationId);
  }
  if (pathContains) {
    apiWhere.push('path LIKE ?');
    apiParams.push(`%${pathContains}%`);
  }
  if (q) {
    apiWhere.push(`(path LIKE ? OR ip LIKE ? OR key_prefix LIKE ? OR action LIKE ?
      OR actor_id LIKE ? OR actor_username LIKE ? OR entity_id LIKE ?)`);
    const like = `%${q}%`;
    apiParams.push(like, like, like, like, like, like, like);
  }

  const [logins] = await pool.query(
    `SELECT id, created_at, event_type, outcome, username, email, user_id, location_id, ip, detail, request_id
     FROM api_login_events
     WHERE ${loginWhere.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ?`,
    [...loginParams, lim + 1]
  );
  const [apis] = await pool.query(
    `SELECT id, created_at, method, path, status_code, duration_ms, ip, location_id,
            error_class, key_prefix, request_id, surface, actor_type, actor_id,
            actor_username, action, entity_type, entity_id, outcome
     FROM api_sentinel_events
     WHERE ${apiWhere.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ?`,
    [...apiParams, lim + 1]
  );

  const items = [];
  for (const e of logins) {
    items.push({
      source: 'login',
      created_at: e.created_at,
      severity: e.outcome === 'failure' ? 'high' : e.outcome === 'success' ? 'info' : 'low',
      title: `${e.event_type} · ${e.outcome}`,
      summary: [e.username || e.email || e.user_id, e.detail].filter(Boolean).join(' — '),
      ip: e.ip,
      location_id: e.location_id,
      raw: e,
    });
  }
  for (const e of apis) {
    const sev =
      e.status_code === 401 || e.status_code === 403
        ? 'high'
        : e.status_code >= 500
          ? 'medium'
          : e.status_code >= 400
            ? 'low'
            : 'info';
    items.push({
      source: e.surface && e.surface !== 'api' ? `control:${e.surface}` : 'api',
      created_at: e.created_at,
      severity: sev,
      title: `${e.method} ${e.path} · ${e.status_code}`,
      summary: [e.key_prefix ? `key ${e.key_prefix}…` : null, e.error_class, e.duration_ms != null ? `${e.duration_ms}ms` : null]
        .filter(Boolean)
        .join(' · '),
      ip: e.ip,
      location_id: e.location_id,
      raw: e,
    });
  }

  items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const selected = items.slice(0, lim);
  return {
    sinceHours:hours,
    items:selected,
    nextCursor:items.length > lim && selected.length
      ? new Date(selected[selected.length - 1].created_at).toISOString()
      : null,
  };
}

async function getInvestigationProfile({ entityType, entity, sinceHours = 24, cursor, limit = 100 } = {}) {
  const pool = getPool();
  const type = String(entityType || '').trim().toLowerCase();
  const value = String(entity || '').trim();
  if (!['ip','identity','path','location','api_key'].includes(type) || !value) {
    throw Object.assign(new Error('Valid entityType and entity are required'), { status:400 });
  }
  const hours = clampHours(sinceHours);
  const filters = {};
  if (type === 'ip') filters.ip = value;
  if (type === 'identity') filters.username = value;
  if (type === 'path') filters.pathContains = value;
  if (type === 'location') filters.locationId = value;
  const apiWhere = ['created_at >= (NOW(3) - INTERVAL ? HOUR)'];
  const apiParams = [hours];
  const loginWhere = ['created_at >= (NOW(3) - INTERVAL ? HOUR)'];
  const loginParams = [hours];
  if (type === 'ip') { apiWhere.push('ip=?'); apiParams.push(value); loginWhere.push('ip=?'); loginParams.push(value); }
  if (type === 'identity') {
    apiWhere.push('(actor_id=? OR actor_username=?)'); apiParams.push(value,value);
    loginWhere.push('(user_id=? OR username=? OR email=?)'); loginParams.push(value,value,value);
  }
  if (type === 'path') { apiWhere.push('path LIKE ?'); apiParams.push(`%${value}%`); loginWhere.push('1=0'); }
  if (type === 'location') { apiWhere.push('location_id=?'); apiParams.push(value); loginWhere.push('location_id=?'); loginParams.push(value); }
  if (type === 'api_key') { apiWhere.push('key_prefix=?'); apiParams.push(value); loginWhere.push('1=0'); }
  const [apiTotals] = await pool.query(
    `SELECT COUNT(*) AS requests,SUM(status_code>=400) AS errors,SUM(status_code IN (401,403)) AS unauthorized,
      COUNT(DISTINCT path) AS uniquePaths,COUNT(DISTINCT ip) AS uniqueIps,
      MIN(created_at) AS firstSeen,MAX(created_at) AS lastSeen,AVG(duration_ms) AS avgDurationMs
     FROM api_sentinel_events WHERE ${apiWhere.join(' AND ')}`, apiParams
  );
  const [loginTotals] = await pool.query(
    `SELECT COUNT(*) AS events,SUM(outcome='success') AS successes,SUM(outcome='failure') AS failures,
      COUNT(DISTINCT COALESCE(user_id,username,email)) AS identities,
      MIN(created_at) AS firstSeen,MAX(created_at) AS lastSeen
     FROM api_login_events WHERE ${loginWhere.join(' AND ')}`, loginParams
  );
  const [paths] = await pool.query(
    `SELECT path,method,COUNT(*) AS requests,SUM(status_code>=400) AS errors,MAX(created_at) AS lastSeen
     FROM api_sentinel_events WHERE ${apiWhere.join(' AND ')} GROUP BY path,method ORDER BY requests DESC,lastSeen DESC LIMIT 20`, apiParams
  );
  const [statuses] = await pool.query(
    `SELECT status_code AS statusCode,COUNT(*) AS total FROM api_sentinel_events
     WHERE ${apiWhere.join(' AND ')} GROUP BY status_code ORDER BY total DESC LIMIT 20`, apiParams
  );
  const [relatedCases] = await pool.query(
    `SELECT * FROM sentinel_threat_cases WHERE entity_type=? AND entity=?
     ORDER BY last_seen DESC LIMIT 25`, [type === 'api_key' ? 'apiKey' : type,value]
  );
  let containment = null;
  if (type === 'ip') {
    const [blocks] = await pool.query(
      `SELECT id,ip,reason,source,is_active,expires_at,created_at FROM sentinel_ip_blocks
       WHERE ip=? ORDER BY created_at DESC LIMIT 10`, [value]
    );
    containment = { blocks };
  }
  const timeline = await getTimeline({ sinceHours:hours, limit, cursor, ...filters });
  const api = apiTotals[0] || {};
  const login = loginTotals[0] || {};
  return {
    entity:{ type,value }, windowHours:hours,
    profile:{
      firstSeen:[api.firstSeen,login.firstSeen].filter(Boolean).sort((a,b)=>new Date(a)-new Date(b))[0] || null,
      lastSeen:[api.lastSeen,login.lastSeen].filter(Boolean).sort((a,b)=>new Date(b)-new Date(a))[0] || null,
      requests:Number(api.requests)||0,errors:Number(api.errors)||0,unauthorized:Number(api.unauthorized)||0,
      uniquePaths:Number(api.uniquePaths)||0,uniqueIps:Number(api.uniqueIps)||0,
      avgDurationMs:Math.round(Number(api.avgDurationMs)||0),loginEvents:Number(login.events)||0,
      loginSuccesses:Number(login.successes)||0,loginFailures:Number(login.failures)||0,
      identities:Number(login.identities)||0,
    },
    paths:paths.map((row)=>({...row,requests:Number(row.requests)||0,errors:Number(row.errors)||0})),
    statuses:statuses.map((row)=>({ statusCode:row.statusCode,total:Number(row.total)||0 })),
    relatedCases:relatedCases.map((row)=>({ id:row.id,severity:row.severity,status:row.status,title:row.title,lastSeen:row.last_seen,disposition:row.disposition })),
    containment,
    timeline,
  };
}

module.exports = {
  computeThreats,
  computePosture,
  getPostureBundle,
  getTimeline,
  getInvestigationProfile,
  SEV_RANK,
};
