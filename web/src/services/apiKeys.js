const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getInstanceIdentity } = require('../instanceIdentity');

function hashKey(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function generateSecret() {
  const random = crypto.randomBytes(32).toString('base64url');
  return `${getInstanceIdentity().apiKeyPrefix}${random}`;
}

function prefixOf(secret) {
  return secret.slice(0, 12);
}

/**
 * Create a key. Returns { id, name, key_prefix, secret, created_at }.
 * `secret` is shown only this once.
 */
async function createKey({ name, createdBy = null }, pool = null) {
  const p = pool || getPool();
  const id = crypto.randomUUID();
  const secret = generateSecret();
  const key_prefix = prefixOf(secret);
  const key_hash = hashKey(secret);

  await p.query(
    `INSERT INTO api_keys (id, name, key_prefix, key_hash, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, key_prefix, key_hash, createdBy]
  );

  return {
    id,
    name,
    key_prefix,
    secret,
    created_at: new Date().toISOString(),
  };
}

async function listKeys(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT id, name, key_prefix, created_by, last_used_at, revoked_at, created_at
     FROM api_keys
     ORDER BY created_at DESC`
  );
  return rows;
}

async function revokeKey(id, pool = null) {
  const p = pool || getPool();
  const [result] = await p.query(
    `UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP
     WHERE id = ? AND revoked_at IS NULL`,
    [id]
  );
  return result.affectedRows > 0;
}

/**
 * Validate Bearer secret. Returns key row or null.
 */
async function verifyKey(secret, pool = null) {
  if (!secret || typeof secret !== 'string') return null;
  const p = pool || getPool();
  const key_hash = hashKey(secret);
  const [rows] = await p.query(
    `SELECT id, name, key_prefix, created_by, last_used_at, revoked_at, created_at
     FROM api_keys
     WHERE key_hash = ? AND revoked_at IS NULL
     LIMIT 1`,
    [key_hash]
  );
  if (!rows[0]) return null;

  // Fire-and-forget last_used touch
  p.query(`UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`, [rows[0].id]).catch(
    () => {}
  );

  return rows[0];
}

module.exports = {
  createKey,
  listKeys,
  revokeKey,
  verifyKey,
  hashKey,
  generateSecret,
};
