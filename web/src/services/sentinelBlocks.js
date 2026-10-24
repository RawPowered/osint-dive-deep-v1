const crypto = require('crypto');
const { getPool } = require('../db/pool');

/** @type {{ set: Set<string>, loadedAt: number } | null} */
let cache = null;
const CACHE_TTL_MS = 45 * 1000;

function normalizeIp(raw) {
  if (raw == null || raw === '') return null;
  let ip = String(raw).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // Basic IPv4 / IPv6 length guard
  if (ip.length < 3 || ip.length > 45) return null;
  if (/[\s<>"'`;]/.test(ip)) return null;
  return ip;
}

function invalidateBlockCache() {
  cache = null;
}

async function loadActiveBlockSet(force = false) {
  const now = Date.now();
  if (!force && cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.set;
  }
  const pool = getPool();
  // Deactivate expired rows lazily
  await pool.query(
    `UPDATE sentinel_ip_blocks
     SET is_active = 0, revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = COALESCE(revoke_reason, 'expired')
     WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at < NOW(3)`
  ).catch(() => {});

  const [rows] = await pool.query(
    `SELECT ip FROM sentinel_ip_blocks
     WHERE is_active = 1
       AND (expires_at IS NULL OR expires_at > NOW(3))`
  );
  const set = new Set();
  for (const r of rows) {
    const ip = normalizeIp(r.ip);
    if (ip) set.add(ip);
  }
  cache = { set, loadedAt: now };
  return set;
}

async function isIpBlocked(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip) return false;
  try {
    const set = await loadActiveBlockSet();
    return set.has(ip);
  } catch (error) {
    // Preserve enforcement for known blocked IPs during a transient DB outage.
    if (cache && cache.set.has(ip)) return true;
    throw error;
  }
}

function mapBlock(row) {
  if (!row) return null;
  return {
    id: row.id,
    ip: row.ip,
    cidr: row.cidr,
    reason: row.reason,
    source: row.source,
    caseId: row.case_id,
    isActive: Boolean(row.is_active),
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
  };
}

async function listBlocks({ activeOnly = true, limit = 200, offset = 0 } = {}) {
  const pool = getPool();
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const where = activeOnly
    ? 'WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > NOW(3))'
    : '';
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM sentinel_ip_blocks ${where}`
  );
  const [rows] = await pool.query(
    `SELECT * FROM sentinel_ip_blocks ${where}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [lim, off]
  );
  return {
    total: Number(countRows[0]?.total) || 0,
    blocks: rows.map(mapBlock),
  };
}

async function getActiveBlockByIp(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip) return null;
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM sentinel_ip_blocks
     WHERE ip = ? AND is_active = 1
       AND (expires_at IS NULL OR expires_at > NOW(3))
     ORDER BY created_at DESC LIMIT 1`,
    [ip]
  );
  return mapBlock(rows[0]);
}

/**
 * Create or re-activate a block for an IP.
 */
async function createBlock({
  ip: rawIp,
  reason,
  source = 'manual',
  caseId = null,
  expiresAt = null,
  createdBy = null,
  cidr = null,
} = {}) {
  const ip = normalizeIp(rawIp);
  if (!ip) {
    const err = new Error('Invalid IP address');
    err.status = 400;
    throw err;
  }
  const why = String(reason || '').trim().slice(0, 512);
  if (!why) {
    const err = new Error('Reason is required');
    err.status = 400;
    throw err;
  }

  const pool = getPool();
  // Deactivate any existing active blocks for this IP (one active policy)
  await pool.query(
    `UPDATE sentinel_ip_blocks
     SET is_active = 0, revoked_at = CURRENT_TIMESTAMP(3),
         revoked_by = ?, revoke_reason = 'superseded'
     WHERE ip = ? AND is_active = 1`,
    [createdBy || null, ip]
  );

  const id = crypto.randomUUID();
  let exp = null;
  if (expiresAt) {
    const d = new Date(expiresAt);
    if (!Number.isNaN(d.getTime())) exp = d;
  }

  await pool.query(
    `INSERT INTO sentinel_ip_blocks
       (id, ip, cidr, reason, source, case_id, is_active, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      ip,
      cidr ? String(cidr).slice(0, 50) : null,
      why,
      String(source || 'manual').slice(0, 32),
      caseId || null,
      exp,
      createdBy || null,
    ]
  );

  invalidateBlockCache();
  const [rows] = await pool.query(`SELECT * FROM sentinel_ip_blocks WHERE id = ? LIMIT 1`, [id]);
  return mapBlock(rows[0]);
}

async function revokeBlock(id, { revokedBy = null, reason = 'revoked' } = {}) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM sentinel_ip_blocks WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0]) {
    const err = new Error('Block not found');
    err.status = 404;
    throw err;
  }
  await pool.query(
    `UPDATE sentinel_ip_blocks
     SET is_active = 0, revoked_at = CURRENT_TIMESTAMP(3),
         revoked_by = ?, revoke_reason = ?
     WHERE id = ?`,
    [revokedBy || null, String(reason || 'revoked').slice(0, 512), id]
  );
  invalidateBlockCache();
  const [after] = await pool.query(`SELECT * FROM sentinel_ip_blocks WHERE id = ? LIMIT 1`, [id]);
  return mapBlock(after[0]);
}

async function isIpCurrentlyBlockedInDb(rawIp) {
  const row = await getActiveBlockByIp(rawIp);
  return Boolean(row);
}

module.exports = {
  normalizeIp,
  isIpBlocked,
  listBlocks,
  createBlock,
  revokeBlock,
  getActiveBlockByIp,
  isIpCurrentlyBlockedInDb,
  invalidateBlockCache,
  loadActiveBlockSet,
  mapBlock,
};
