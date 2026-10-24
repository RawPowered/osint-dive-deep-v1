const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { createBlock, normalizeIp } = require('./sentinelBlocks');

const GROUP_BY = new Set(['ip', 'identity', 'path']);
const SOURCES = new Set(['api', 'login', 'either']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function sanitizeCondition(input = {}) {
  const c = typeof input === 'string' ? parseJson(input, {}) : { ...input };
  const source = SOURCES.has(c.source) ? c.source : 'api';
  const groupBy = GROUP_BY.has(c.groupBy) ? c.groupBy : 'ip';
  let minCount = Number(c.minCount);
  if (!Number.isFinite(minCount) || minCount < 1) minCount = 5;
  minCount = Math.min(Math.floor(minCount), 10000);
  let windowMinutes = Number(c.windowMinutes);
  if (!Number.isFinite(windowMinutes) || windowMinutes < 1) windowMinutes = 60;
  windowMinutes = Math.min(Math.floor(windowMinutes), 10080);

  const out = {
    source,
    groupBy,
    minCount,
    windowMinutes,
  };
  if (c.statusCode != null && c.statusCode !== '') {
    const sc = Number(c.statusCode);
    if (Number.isFinite(sc) && sc >= 100 && sc <= 599) out.statusCode = sc;
  }
  if (c.outcome && ['success', 'failure', 'unknown'].includes(String(c.outcome))) {
    out.outcome = String(c.outcome);
  }
  if (c.errorClass && typeof c.errorClass === 'string') {
    out.errorClass = String(c.errorClass).slice(0, 64);
  }
  if (c.pathPrefix && typeof c.pathPrefix === 'string') {
    out.pathPrefix = String(c.pathPrefix).slice(0, 200);
  }
  if (c.pathContains && typeof c.pathContains === 'string') {
    out.pathContains = String(c.pathContains).slice(0, 200);
  }
  if (c.method && typeof c.method === 'string') {
    out.method = String(c.method).toUpperCase().slice(0, 10);
  }
  return out;
}

function sanitizeActions(input = {}) {
  const a = typeof input === 'string' ? parseJson(input, {}) : { ...input };
  return {
    createCase: a.createCase !== false,
    autoBlock: Boolean(a.autoBlock),
    autoBlockMinSeverity: SEVERITIES.has(a.autoBlockMinSeverity)
      ? a.autoBlockMinSeverity
      : 'critical',
  };
}

function mapRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isEnabled: Boolean(row.is_enabled),
    priority: Number(row.priority) || 100,
    severity: row.severity,
    condition: sanitizeCondition(parseJson(row.condition_json, {})),
    actions: sanitizeActions(parseJson(row.actions_json, {})),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listRules() {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM sentinel_custom_rules ORDER BY priority ASC, name ASC`
  );
  return rows.map(mapRule);
}

async function getRule(id) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM sentinel_custom_rules WHERE id = ? LIMIT 1`,
    [id]
  );
  return mapRule(rows[0]);
}

async function createRule({
  name,
  description = null,
  isEnabled = true,
  priority = 100,
  severity = 'medium',
  condition,
  actions,
  createdBy = null,
} = {}) {
  const n = String(name || '').trim().slice(0, 128);
  if (!n) {
    const err = new Error('Rule name is required');
    err.status = 400;
    throw err;
  }
  const sev = SEVERITIES.has(severity) ? severity : 'medium';
  const cond = sanitizeCondition(condition || {});
  const act = sanitizeActions(actions || {});
  const id = crypto.randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO sentinel_custom_rules
       (id, name, description, is_enabled, priority, severity, condition_json, actions_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      n,
      description ? String(description).slice(0, 512) : null,
      isEnabled ? 1 : 0,
      Number(priority) || 100,
      sev,
      JSON.stringify(cond),
      JSON.stringify(act),
      createdBy || null,
    ]
  );
  return getRule(id);
}

async function updateRule(id, patch = {}) {
  const existing = await getRule(id);
  if (!existing) {
    const err = new Error('Rule not found');
    err.status = 404;
    throw err;
  }
  const name =
    patch.name != null ? String(patch.name).trim().slice(0, 128) : existing.name;
  if (!name) {
    const err = new Error('Rule name is required');
    err.status = 400;
    throw err;
  }
  const description =
    patch.description !== undefined
      ? patch.description
        ? String(patch.description).slice(0, 512)
        : null
      : existing.description;
  const isEnabled =
    patch.isEnabled !== undefined ? Boolean(patch.isEnabled) : existing.isEnabled;
  const priority =
    patch.priority !== undefined ? Number(patch.priority) || 100 : existing.priority;
  const severity = SEVERITIES.has(patch.severity) ? patch.severity : existing.severity;
  const condition =
    patch.condition !== undefined
      ? sanitizeCondition(patch.condition)
      : existing.condition;
  const actions =
    patch.actions !== undefined ? sanitizeActions(patch.actions) : existing.actions;

  const pool = getPool();
  await pool.query(
    `UPDATE sentinel_custom_rules
     SET name = ?, description = ?, is_enabled = ?, priority = ?, severity = ?,
         condition_json = ?, actions_json = ?
     WHERE id = ?`,
    [
      name,
      description,
      isEnabled ? 1 : 0,
      priority,
      severity,
      JSON.stringify(condition),
      JSON.stringify(actions),
      id,
    ]
  );
  return getRule(id);
}

async function deleteRule(id) {
  const pool = getPool();
  const [res] = await pool.query(`DELETE FROM sentinel_custom_rules WHERE id = ?`, [id]);
  if (!res.affectedRows) {
    const err = new Error('Rule not found');
    err.status = 404;
    throw err;
  }
  return { ok: true };
}

function entityExpr(groupBy, source) {
  if (groupBy === 'path') {
    return source === 'login'
      ? `CONCAT(event_type, ':', COALESCE(detail, ''))`
      : `CONCAT(method, ' ', path)`;
  }
  if (groupBy === 'identity') {
    return source === 'api'
      ? `COALESCE(key_prefix, ip, '(unknown)')`
      : `COALESCE(username, email, user_id, '(unknown)')`;
  }
  return 'ip';
}

/**
 * Evaluate enabled custom rules → findings-shaped objects.
 * Optionally auto-block IPs when configured.
 */
async function evaluateCustomRules() {
  const pool = getPool();
  const rules = (await listRules()).filter((r) => r.isEnabled);
  const findings = [];
  const autoBlocks = [];

  for (const rule of rules) {
    const c = rule.condition;
    const sources =
      c.source === 'either' ? ['api', 'login'] : [c.source === 'login' ? 'login' : 'api'];

    for (const src of sources) {
      const groupExpr = entityExpr(c.groupBy, src);
      const where = ['created_at >= (NOW(3) - INTERVAL ? MINUTE)'];
      const params = [c.windowMinutes];

      if (src === 'api') {
        if (c.statusCode != null) {
          where.push('status_code = ?');
          params.push(c.statusCode);
        }
        if (c.errorClass) {
          where.push('error_class = ?');
          params.push(c.errorClass);
        }
        if (c.pathPrefix) {
          where.push('path LIKE ?');
          params.push(`${c.pathPrefix}%`);
        }
        if (c.pathContains) {
          where.push('path LIKE ?');
          params.push(`%${c.pathContains}%`);
        }
        if (c.method) {
          where.push('method = ?');
          params.push(c.method);
        }
        const sql = `
          SELECT ${groupExpr} AS entity, COUNT(*) AS count,
                 MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
          FROM api_sentinel_events
          WHERE ${where.join(' AND ')}
          GROUP BY entity
          HAVING count >= ?
          ORDER BY count DESC
          LIMIT 25`;
        params.push(c.minCount);
        const [rows] = await pool.query(sql, params);
        for (const r of rows) {
          if (!r.entity) continue;
          findings.push(findingFromRule(rule, r, src, c));
          if (shouldAutoBlock(rule, c, r)) {
            autoBlocks.push({
              ip: normalizeIp(r.entity),
              rule,
              count: Number(r.count),
            });
          }
        }
      } else {
        if (c.outcome) {
          where.push('outcome = ?');
          params.push(c.outcome);
        }
        // login table has no status_code/path the same way
        const sql = `
          SELECT ${groupExpr} AS entity, COUNT(*) AS count,
                 MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
          FROM api_login_events
          WHERE ${where.join(' AND ')}
          GROUP BY entity
          HAVING count >= ?
          ORDER BY count DESC
          LIMIT 25`;
        params.push(c.minCount);
        const [rows] = await pool.query(sql, params);
        for (const r of rows) {
          if (!r.entity) continue;
          findings.push(findingFromRule(rule, r, src, c));
          if (shouldAutoBlock(rule, c, r)) {
            autoBlocks.push({
              ip: normalizeIp(r.entity),
              rule,
              count: Number(r.count),
            });
          }
        }
      }
    }
  }

  // Apply auto-blocks (best-effort)
  for (const ab of autoBlocks) {
    if (!ab.ip) continue;
    try {
      await createBlock({
        ip: ab.ip,
        reason: `Auto-block from custom rule "${ab.rule.name}" (${ab.count} hits)`,
        source: 'auto_rule',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdBy: 'system:auto_rule',
      });
    } catch {
      /* ignore duplicates / errors */
    }
  }

  return findings;
}

function shouldAutoBlock(rule, condition, row) {
  if (!rule.actions?.autoBlock) return false;
  if (condition.groupBy !== 'ip') return false;
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const min = rule.actions.autoBlockMinSeverity || 'critical';
  return (sevRank[rule.severity] ?? 9) <= (sevRank[min] ?? 0);
}

function findingFromRule(rule, row, src, condition) {
  const entityType =
    condition.groupBy === 'path'
      ? 'path'
      : condition.groupBy === 'identity'
        ? 'identity'
        : 'ip';
  return {
    id: `custom:${rule.id}:${row.entity}`,
    ruleId: `custom:${rule.id}`,
    severity: rule.severity,
    title: rule.name,
    summary: `Custom rule matched on ${src}: ${row.entity} ×${row.count} in ${condition.windowMinutes}m`,
    entityType,
    entity: String(row.entity).slice(0, 255),
    count: Number(row.count) || 0,
    windowHours: Math.max(1, Math.ceil(condition.windowMinutes / 60)),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    recommendedAction:
      rule.description ||
      'Review Investigate timeline; decide block or dismiss in Review queue',
    customRuleId: rule.id,
  };
}

module.exports = {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  evaluateCustomRules,
  sanitizeCondition,
  sanitizeActions,
  mapRule,
};
