const crypto = require('crypto');

const ASSIGNMENT_POLICIES = new Set(['clear', 'preserve', 'require_user']);
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const KEY_RE = /^[a-z][a-z0-9_]{1,62}$/;
const MANDATORY_POOL_KEYS = new Set([
  'dnc_pending', 'no_phone', 'available', 'assigned', 'dnc', 'not_interested', 'scheduled',
  'closed_won', 'closed_lost', 'closed_dnq',
]);

const DEFAULT_POOL_RULES = [
  rule('dnc_pending', 'DNC Screening', ['dnc_pending', 'pending_dnc', 'dnd'], 'dnc_pending', 'clear', false, false, '#f59e0b', 5),
  rule('no_phone', 'No Phone', ['no_phone'], 'no_phone', 'clear', false, false, '#64748b', 7),
  rule('available', 'Available', ['uncontacted'], 'uncontacted', 'clear', true, false, '#22c55e', 10),
  rule('assigned', 'Assigned', ['assigned'], 'assigned', 'require_user', false, false, '#3b82f6', 20),
  rule('working', 'Working', ['contacted'], 'contacted', 'preserve', false, false, '#f59e0b', 30),
  rule('scheduled', 'Scheduled', ['appointment', 'scheduled'], 'appointment', 'preserve', false, false, '#06b6d4', 40),
  rule('dnc', 'DNC', ['do_not_call', 'dnc'], 'do_not_call', 'clear', false, true, '#ef4444', 50),
  rule('not_interested', 'Not Interested', ['not_interested'], 'not_interested', 'clear', false, true, '#f97316', 60),
  rule('closed_won', 'Closed Won', ['closed_won'], 'closed_won', 'preserve', false, true, '#10b981', 70),
  rule('closed_lost', 'Closed Lost', ['closed_lost'], 'closed_lost', 'clear', false, true, '#64748b', 80),
  rule('closed_dnq', 'Closed DNQ', ['closed_dnq', 'dnq'], 'closed_dnq', 'clear', false, true, '#a855f7', 90),
  rule('invalid', 'Invalid', ['invalid'], 'invalid', 'clear', false, true, '#ec4899', 100),
];

function rule(poolKey, label, statusValues, destinationStatus, assignmentPolicy, isAssignable, isTerminal, color, sortOrder) {
  return { poolKey, label, statusValues, destinationStatus, assignmentPolicy, isAssignable, isTerminal, color, sortOrder, isEnabled: true };
}

async function ensureDefaultPoolRules(pool, source, locationId) {
  for (const item of DEFAULT_POOL_RULES) {
    await pool.query(
      `INSERT IGNORE INTO owl_lead_pool_rules
         (id, source_slug, location_id, pool_key, label, status_values_json,
          destination_status, assignment_policy, is_assignable, is_terminal,
          color, sort_order, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [crypto.randomUUID(), source, locationId, item.poolKey, item.label,
        JSON.stringify(item.statusValues), item.destinationStatus, item.assignmentPolicy,
        item.isAssignable ? 1 : 0, item.isTerminal ? 1 : 0, item.color, item.sortOrder]
    );
  }
}

async function listPoolRules(pool, source, locationId, options = {}) {
  if (options.ensureDefaults !== false) await ensureDefaultPoolRules(pool, source, locationId);
  const [rows] = await pool.query(
    `SELECT id, source_slug, location_id, pool_key, label, status_values_json,
            destination_status, assignment_policy, is_assignable, is_terminal,
            color, sort_order, is_enabled, created_at, updated_at
     FROM owl_lead_pool_rules WHERE source_slug = ? AND location_id = ?
     ORDER BY sort_order, label`,
    [source, locationId]
  );
  return rows.map(publicRule);
}

async function getPoolRule(pool, source, locationId, poolKey) {
  const rules = await listPoolRules(pool, source, locationId);
  return rules.find((item) => item.poolKey === poolKey) || null;
}

async function findRuleForStatus(pool, source, locationId, status) {
  const rules = await listPoolRules(pool, source, locationId);
  return rules.find((item) => item.isEnabled && item.statusValues.includes(String(status))) || null;
}

async function getAssignableStatuses(pool, source, locationId) {
  const rules = await listPoolRules(pool, source, locationId);
  const statuses = rules.filter((item) => item.isEnabled && item.isAssignable)
    .flatMap((item) => item.statusValues);
  return [...new Set(statuses)];
}

async function upsertPoolRule(pool, source, locationId, poolKey, input) {
  const normalized = normalizeRule(poolKey, input);
  const rules = await listPoolRules(pool, source, locationId);
  const before = rules.find((item) => item.poolKey === normalized.poolKey) || null;
  const conflicts = rules.filter((item) => item.poolKey !== normalized.poolKey)
    .flatMap((item) => item.statusValues.filter((status) => normalized.statusValues.includes(status))
      .map((status) => `${status} (${item.label})`));
  if (conflicts.length) {
    throw Object.assign(new Error(`Status aliases already routed: ${conflicts.join(', ')}`), { status: 409 });
  }
  const projected = rules.filter((item) => item.poolKey !== normalized.poolKey).concat(normalized);
  if (!projected.some((item) => item.isEnabled && item.isAssignable)) {
    throw Object.assign(new Error('At least one enabled pool must remain Dialer assignable'), { status: 409 });
  }
  await pool.query(
    `INSERT INTO owl_lead_pool_rules
       (id, source_slug, location_id, pool_key, label, status_values_json,
        destination_status, assignment_policy, is_assignable, is_terminal,
        color, sort_order, is_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE label = VALUES(label), status_values_json = VALUES(status_values_json),
       destination_status = VALUES(destination_status), assignment_policy = VALUES(assignment_policy),
       is_assignable = VALUES(is_assignable), is_terminal = VALUES(is_terminal),
       color = VALUES(color), sort_order = VALUES(sort_order), is_enabled = VALUES(is_enabled)`,
    [crypto.randomUUID(), source, locationId, normalized.poolKey, normalized.label,
      JSON.stringify(normalized.statusValues), normalized.destinationStatus,
      normalized.assignmentPolicy, normalized.isAssignable ? 1 : 0,
      normalized.isTerminal ? 1 : 0, normalized.color, normalized.sortOrder,
      normalized.isEnabled ? 1 : 0]
  );
  return { before, after: await getPoolRule(pool, source, locationId, poolKey) };
}

function normalizeRule(poolKey, input) {
  const key = String(poolKey || '').trim().toLowerCase();
  if (!KEY_RE.test(key)) throw Object.assign(new Error('Invalid pool key'), { status: 400 });
  const label = String(input.label || '').trim().slice(0, 128);
  if (!label) throw Object.assign(new Error('Pool label is required'), { status: 400 });
  const statusValues = [...new Set((Array.isArray(input.statusValues) ? input.statusValues : [])
    .map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  const destinationStatus = String(input.destinationStatus || '').trim().toLowerCase().slice(0, 64);
  if (!statusValues.length || !destinationStatus) {
    throw Object.assign(new Error('At least one status alias and a destination status are required'), { status: 400 });
  }
  if (!statusValues.includes(destinationStatus)) statusValues.unshift(destinationStatus);
  const assignmentPolicy = String(input.assignmentPolicy || 'clear');
  if (!ASSIGNMENT_POLICIES.has(assignmentPolicy)) {
    throw Object.assign(new Error('Invalid assignment policy'), { status: 400 });
  }
  const color = COLOR_RE.test(String(input.color || '')) ? String(input.color).toLowerCase() : '#64748b';
  if (MANDATORY_POOL_KEYS.has(key) && input.isEnabled === false) {
    throw Object.assign(new Error('Required lifecycle pools cannot be disabled'), { status: 409 });
  }
  return {
    poolKey: key, label, statusValues, destinationStatus, assignmentPolicy, color,
    isAssignable: Boolean(input.isAssignable), isTerminal: Boolean(input.isTerminal),
    isEnabled: input.isEnabled !== false,
    sortOrder: Math.min(Math.max(Number(input.sortOrder) || 100, 0), 10000),
  };
}

function publicRule(row) {
  return {
    id: row.id,
    source: row.source_slug,
    locationId: row.location_id,
    poolKey: row.pool_key,
    label: row.label,
    statusValues: parseArray(row.status_values_json),
    destinationStatus: row.destination_status,
    assignmentPolicy: row.assignment_policy,
    isAssignable: Boolean(row.is_assignable),
    isTerminal: Boolean(row.is_terminal),
    color: row.color,
    sortOrder: Number(row.sort_order),
    isEnabled: Boolean(row.is_enabled),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function assertDncAssignmentAllowed(leads, destinationRule, rules) {
  if (!destinationRule) return;
  const isAssignmentDestination = destinationRule.isAssignable ||
    destinationRule.poolKey === 'assigned' || destinationRule.assignmentPolicy === 'require_user';
  if (!isAssignmentDestination) return;
  const protectedStatuses = new Set(rules
    .filter((rule) => rule.poolKey === 'dnc' || rule.poolKey === 'dnc_pending' || rule.poolKey === 'no_phone')
    .flatMap((rule) => rule.statusValues));
  const blocked = leads.filter((lead) =>
    String(lead.dncStatus || 'pending') !== 'clean' || protectedStatuses.has(String(lead.status)));
  if (blocked.length) {
    throw Object.assign(
      new Error(`${blocked.length} lead(s) require a clean DNC result before assignment`),
      { status: 409 }
    );
  }
}

function parseArray(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

module.exports = {
  DEFAULT_POOL_RULES,
  ASSIGNMENT_POLICIES,
  MANDATORY_POOL_KEYS,
  ensureDefaultPoolRules,
  listPoolRules,
  getPoolRule,
  findRuleForStatus,
  getAssignableStatuses,
  upsertPoolRule,
  normalizeRule,
  assertDncAssignmentAllowed,
};
