const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { getPool } = require('../db/pool');
const { encryptSecret, decryptSecret } = require('./secretBox');

/** @type {Map<string, import('mysql2/promise').Pool>} */
const pools = new Map();

const SLUG_RE = /^[a-z][a-z0-9_-]{1,62}$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function assertSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) {
    const err = new Error(
      'slug must be 2–63 chars: start with a letter, then letters/numbers/_/-'
    );
    err.status = 400;
    throw err;
  }
  return s;
}

function assertIdent(name, label = 'identifier') {
  const s = String(name || '').trim();
  if (!IDENT_RE.test(s)) {
    const err = new Error(`Invalid ${label}`);
    err.status = 400;
    throw err;
  }
  return s;
}

function quoteIdent(name) {
  return `\`${String(name).replace(/`/g, '')}\``;
}

function publicConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    host: row.host,
    port: Number(row.port) || 3306,
    database: row.database_name,
    username: row.username,
    sslEnabled: Boolean(row.ssl_enabled),
    isEnabled: Boolean(row.is_enabled),
    maxRows: Number(row.max_rows) || 500,
    notes: row.notes || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function listConnections(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT id, slug, name, host, port, database_name, username, ssl_enabled,
            is_enabled, max_rows, notes, created_by, created_at, updated_at
     FROM sql_connections
     ORDER BY name ASC`
  );
  return rows.map(publicConnection);
}

async function getConnectionById(id, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT * FROM sql_connections WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function getConnectionBySlug(slug, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT * FROM sql_connections WHERE slug = ? LIMIT 1`,
    [String(slug).toLowerCase()]
  );
  return rows[0] || null;
}

async function createConnection(input, pool = null) {
  const p = pool || getPool();
  const slug = assertSlug(input.slug);
  const name = String(input.name || '').trim();
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const database = String(input.database || input.database_name || '').trim();
  if (!host || !username || !database) {
    const err = new Error('host, username, and database are required');
    err.status = 400;
    throw err;
  }
  if (input.password == null || String(input.password) === '') {
    const err = new Error('password is required');
    err.status = 400;
    throw err;
  }

  const id = crypto.randomUUID();
  const port = Number(input.port) || 3306;
  const maxRows = Math.min(Math.max(Number(input.maxRows || input.max_rows) || 500, 1), 5000);
  const sslEnabled = input.sslEnabled || input.ssl_enabled ? 1 : 0;
  const isEnabled = input.isEnabled === false || input.is_enabled === false ? 0 : 1;

  await p.query(
    `INSERT INTO sql_connections
       (id, slug, name, host, port, database_name, username, password_enc,
        ssl_enabled, is_enabled, max_rows, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      slug,
      name,
      host,
      port,
      database,
      username,
      encryptSecret(input.password),
      sslEnabled,
      isEnabled,
      maxRows,
      input.notes ? String(input.notes).slice(0, 512) : null,
      input.createdBy || null,
    ]
  );

  return publicConnection(await getConnectionById(id, p));
}

async function updateConnection(id, input, pool = null) {
  const p = pool || getPool();
  const existing = await getConnectionById(id, p);
  if (!existing) {
    const err = new Error('Connection not found');
    err.status = 404;
    throw err;
  }

  const slug =
    input.slug != null ? assertSlug(input.slug) : existing.slug;
  const name =
    input.name != null ? String(input.name).trim() : existing.name;
  const host =
    input.host != null ? String(input.host).trim() : existing.host;
  const port =
    input.port != null ? Number(input.port) || 3306 : existing.port;
  const database =
    input.database != null || input.database_name != null
      ? String(input.database || input.database_name).trim()
      : existing.database_name;
  const username =
    input.username != null ? String(input.username).trim() : existing.username;
  const maxRows =
    input.maxRows != null || input.max_rows != null
      ? Math.min(Math.max(Number(input.maxRows ?? input.max_rows) || 500, 1), 5000)
      : existing.max_rows;
  const sslEnabled =
    input.sslEnabled != null || input.ssl_enabled != null
      ? input.sslEnabled || input.ssl_enabled
        ? 1
        : 0
      : existing.ssl_enabled;
  const isEnabled =
    input.isEnabled != null || input.is_enabled != null
      ? input.isEnabled === false || input.is_enabled === false
        ? 0
        : 1
      : existing.is_enabled;
  const notes =
    input.notes !== undefined
      ? input.notes
        ? String(input.notes).slice(0, 512)
        : null
      : existing.notes;

  let passwordEnc = existing.password_enc;
  if (input.password != null && String(input.password) !== '') {
    passwordEnc = encryptSecret(input.password);
  }

  await p.query(
    `UPDATE sql_connections SET
       slug = ?, name = ?, host = ?, port = ?, database_name = ?, username = ?,
       password_enc = ?, ssl_enabled = ?, is_enabled = ?, max_rows = ?, notes = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      slug,
      name,
      host,
      port,
      database,
      username,
      passwordEnc,
      sslEnabled,
      isEnabled,
      maxRows,
      notes,
      id,
    ]
  );

  await invalidatePool(id);
  return publicConnection(await getConnectionById(id, p));
}

async function deleteConnection(id, pool = null) {
  const p = pool || getPool();
  await invalidatePool(id);
  // cascade grants
  const [grants] = await p.query(
    `SELECT id FROM sql_connection_grants WHERE connection_id = ?`,
    [id]
  );
  for (const g of grants) {
    await p.query(`DELETE FROM sql_table_grants WHERE grant_id = ?`, [g.id]);
  }
  await p.query(`DELETE FROM sql_connection_grants WHERE connection_id = ?`, [id]);
  const [result] = await p.query(`DELETE FROM sql_connections WHERE id = ?`, [id]);
  return result.affectedRows > 0;
}

function decryptRowPassword(row) {
  try {
    return decryptSecret(row.password_enc);
  } catch (e) {
    const err = new Error('Failed to decrypt connection password (SESSION_SECRET mismatch?)');
    err.status = 500;
    throw err;
  }
}

/**
 * Test credentials (optional connection id uses stored password if password omitted).
 */
async function testSqlConnection(input) {
  let host = input.host;
  let port = input.port || 3306;
  let user = input.username;
  let password = input.password;
  let database = input.database || input.database_name;
  let ssl = input.sslEnabled || input.ssl_enabled;

  if (input.id || input.connectionId) {
    const row = await getConnectionById(input.id || input.connectionId);
    if (!row) {
      const err = new Error('Connection not found');
      err.status = 404;
      throw err;
    }
    host = host || row.host;
    port = port || row.port;
    user = user || row.username;
    database = database || row.database_name;
    ssl = ssl != null ? ssl : row.ssl_enabled;
    if (password == null || password === '') {
      password = decryptRowPassword(row);
    }
  }

  if (!host || !user || !database) {
    const err = new Error('host, username, and database are required');
    err.status = 400;
    throw err;
  }

  const conn = await mysql.createConnection({
    host,
    port: Number(port) || 3306,
    user,
    password: password || '',
    database,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 10000,
  });
  try {
    const [rows] = await conn.query('SELECT 1 AS ok, DATABASE() AS db');
    return { ok: true, database: rows[0]?.db || database };
  } finally {
    await conn.end();
  }
}

async function getDataPool(connectionRow) {
  if (!connectionRow || !connectionRow.is_enabled) {
    const err = new Error('Connection disabled or missing');
    err.status = 403;
    throw err;
  }
  const id = connectionRow.id;
  if (pools.has(id)) return pools.get(id);

  const password = decryptRowPassword(connectionRow);
  const pool = mysql.createPool({
    host: connectionRow.host,
    port: Number(connectionRow.port) || 3306,
    user: connectionRow.username,
    password,
    database: connectionRow.database_name,
    waitForConnections: true,
    connectionLimit: 5,
    dateStrings: true,
    ssl: connectionRow.ssl_enabled ? { rejectUnauthorized: false } : undefined,
  });
  pools.set(id, pool);
  return pool;
}

async function invalidatePool(connectionId) {
  const pool = pools.get(connectionId);
  if (pool) {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    pools.delete(connectionId);
  }
}

/**
 * List tables in a data connection (information_schema).
 */
async function listTables(connectionRow) {
  const pool = await getDataPool(connectionRow);
  const [rows] = await pool.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine,
            TABLE_ROWS AS approxRows, TABLE_COMMENT AS comment
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME`,
    [connectionRow.database_name]
  );
  return rows;
}

async function describeTable(connectionRow, tableName) {
  const table = assertIdent(tableName, 'table name');
  const pool = await getDataPool(connectionRow);
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
            IS_NULLABLE AS nullable, COLUMN_KEY AS columnKey, COLUMN_DEFAULT AS defaultValue,
            EXTRA AS extra
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [connectionRow.database_name, table]
  );
  if (!cols.length) {
    const err = new Error('Table not found');
    err.status = 404;
    throw err;
  }
  return cols;
}

module.exports = {
  listConnections,
  getConnectionById,
  getConnectionBySlug,
  createConnection,
  updateConnection,
  deleteConnection,
  testSqlConnection,
  getDataPool,
  invalidatePool,
  listTables,
  describeTable,
  publicConnection,
  assertSlug,
  assertIdent,
  quoteIdent,
  decryptRowPassword,
  SLUG_RE,
  IDENT_RE,
};
