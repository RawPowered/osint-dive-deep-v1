const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { assertIdent } = require('./sqlConnections');

function parseAllowedColumns(raw) {
  if (raw == null || raw === '') return null;
  if (Array.isArray(raw)) return raw.map((c) => assertIdent(c, 'column'));
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((c) => assertIdent(String(c), 'column'));
  } catch {
    return null;
  }
}

function tableGrantPublic(row) {
  return {
    id: row.id,
    grantId: row.grant_id,
    tableName: row.table_name,
    allowSelect: Boolean(row.allow_select),
    allowInsert: Boolean(row.allow_insert),
    allowUpdate: Boolean(row.allow_update),
    allowDelete: Boolean(row.allow_delete),
    primaryKey: row.primary_key || 'id',
    allowedColumns: parseAllowedColumns(row.allowed_columns),
    createdAt: row.created_at || null,
  };
}

function grantPublic(row, tables = []) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    apiKeyId: row.api_key_id,
    canIntrospect: Boolean(row.can_introspect),
    createdAt: row.created_at || null,
    apiKeyName: row.api_key_name || null,
    apiKeyPrefix: row.key_prefix || null,
    connectionSlug: row.connection_slug || null,
    connectionName: row.connection_name || null,
    tables: tables.map(tableGrantPublic),
  };
}

async function listGrantsForConnection(connectionId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT g.*, k.name AS api_key_name, k.key_prefix, k.revoked_at,
            c.slug AS connection_slug, c.name AS connection_name
     FROM sql_connection_grants g
     LEFT JOIN api_keys k ON k.id = g.api_key_id
     LEFT JOIN sql_connections c ON c.id = g.connection_id
     WHERE g.connection_id = ?
     ORDER BY g.created_at DESC`,
    [connectionId]
  );
  const out = [];
  for (const row of rows) {
    const tables = await listTableGrants(row.id, p);
    out.push(grantPublic(row, tables));
  }
  return out;
}

async function listGrantsForApiKey(apiKeyId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT g.*, c.slug AS connection_slug, c.name AS connection_name, c.is_enabled
     FROM sql_connection_grants g
     INNER JOIN sql_connections c ON c.id = g.connection_id
     WHERE g.api_key_id = ? AND c.is_enabled = 1
     ORDER BY c.name ASC`,
    [apiKeyId]
  );
  const out = [];
  for (const row of rows) {
    const tables = await listTableGrants(row.id, p);
    out.push(grantPublic(row, tables));
  }
  return out;
}

async function listTableGrants(grantId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT * FROM sql_table_grants WHERE grant_id = ? ORDER BY table_name`,
    [grantId]
  );
  return rows;
}

async function getGrant(connectionId, apiKeyId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT g.*, c.slug AS connection_slug, c.name AS connection_name
     FROM sql_connection_grants g
     LEFT JOIN sql_connections c ON c.id = g.connection_id
     WHERE g.connection_id = ? AND g.api_key_id = ?
     LIMIT 1`,
    [connectionId, apiKeyId]
  );
  if (!rows[0]) return null;
  const tables = await listTableGrants(rows[0].id, p);
  return grantPublic(rows[0], tables);
}

/**
 * Create or replace connection-level grant + table grants.
 * tables: [{ tableName, allowSelect, allowInsert, allowUpdate, allowDelete, primaryKey, allowedColumns }]
 */
async function upsertGrant(
  { connectionId, apiKeyId, canIntrospect = false, tables = [] },
  pool = null
) {
  const p = pool || getPool();
  if (!connectionId || !apiKeyId) {
    const err = new Error('connectionId and apiKeyId are required');
    err.status = 400;
    throw err;
  }

  // Verify key exists and not revoked
  const [keys] = await p.query(
    `SELECT id FROM api_keys WHERE id = ? AND revoked_at IS NULL LIMIT 1`,
    [apiKeyId]
  );
  if (!keys[0]) {
    const err = new Error('API key not found or revoked');
    err.status = 400;
    throw err;
  }

  const [conns] = await p.query(
    `SELECT id FROM sql_connections WHERE id = ? LIMIT 1`,
    [connectionId]
  );
  if (!conns[0]) {
    const err = new Error('Connection not found');
    err.status = 404;
    throw err;
  }

  let grantId;
  const existing = await getGrant(connectionId, apiKeyId, p);
  if (existing) {
    grantId = existing.id;
    await p.query(
      `UPDATE sql_connection_grants SET can_introspect = ? WHERE id = ?`,
      [canIntrospect ? 1 : 0, grantId]
    );
    await p.query(`DELETE FROM sql_table_grants WHERE grant_id = ?`, [grantId]);
  } else {
    grantId = crypto.randomUUID();
    await p.query(
      `INSERT INTO sql_connection_grants (id, connection_id, api_key_id, can_introspect)
       VALUES (?, ?, ?, ?)`,
      [grantId, connectionId, apiKeyId, canIntrospect ? 1 : 0]
    );
  }

  for (const t of tables || []) {
    const tableName = assertIdent(t.tableName || t.table_name, 'table name');
    const pk = assertIdent(t.primaryKey || t.primary_key || 'id', 'primary key');
    let allowedCols = null;
    if (t.allowedColumns != null || t.allowed_columns != null) {
      const raw = t.allowedColumns ?? t.allowed_columns;
      const list = parseAllowedColumns(raw);
      allowedCols = list ? JSON.stringify(list) : null;
    }
    const flag = (v, defaultOn) => {
      if (v === undefined || v === null) return defaultOn ? 1 : 0;
      return v ? 1 : 0;
    };
    await p.query(
      `INSERT INTO sql_table_grants
         (id, grant_id, table_name, allow_select, allow_insert, allow_update, allow_delete,
          primary_key, allowed_columns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        grantId,
        tableName,
        flag(t.allowSelect ?? t.allow_select, true),
        flag(t.allowInsert ?? t.allow_insert, false),
        flag(t.allowUpdate ?? t.allow_update, false),
        flag(t.allowDelete ?? t.allow_delete, false),
        pk,
        allowedCols,
      ]
    );
  }

  return getGrant(connectionId, apiKeyId, p);
}

async function deleteGrant(grantId, pool = null) {
  const p = pool || getPool();
  await p.query(`DELETE FROM sql_table_grants WHERE grant_id = ?`, [grantId]);
  const [result] = await p.query(`DELETE FROM sql_connection_grants WHERE id = ?`, [
    grantId,
  ]);
  return result.affectedRows > 0;
}

/**
 * Resolve ACL for apiKey + connection slug.
 * Returns { connection, grant, tableGrant? } or throws with status.
 */
async function resolveAccess({ apiKeyId, connectionSlug, tableName = null, op = null }) {
  const p = getPool();
  const [connRows] = await p.query(
    `SELECT * FROM sql_connections WHERE slug = ? LIMIT 1`,
    [String(connectionSlug).toLowerCase()]
  );
  const connection = connRows[0];
  if (!connection) {
    const err = new Error('Connection not found');
    err.status = 404;
    throw err;
  }
  if (!connection.is_enabled) {
    const err = new Error('Connection is disabled');
    err.status = 403;
    throw err;
  }

  const [grantRows] = await p.query(
    `SELECT * FROM sql_connection_grants
     WHERE connection_id = ? AND api_key_id = ?
     LIMIT 1`,
    [connection.id, apiKeyId]
  );
  const grant = grantRows[0];
  if (!grant) {
    const err = new Error('API key is not granted access to this SQL connection');
    err.status = 403;
    throw err;
  }

  if (!tableName) {
    return { connection, grant: grantPublic(grant), tableGrant: null };
  }

  const table = assertIdent(tableName, 'table name');
  const [tgRows] = await p.query(
    `SELECT * FROM sql_table_grants WHERE grant_id = ? AND table_name = ? LIMIT 1`,
    [grant.id, table]
  );
  const tg = tgRows[0];
  if (!tg) {
    const err = new Error(`No table grant for "${table}"`);
    err.status = 403;
    throw err;
  }

  if (op) {
    const map = {
      select: tg.allow_select,
      insert: tg.allow_insert,
      update: tg.allow_update,
      delete: tg.allow_delete,
      introspect: grant.can_introspect,
    };
    if (!map[op]) {
      const err = new Error(`Operation "${op}" not allowed on table "${table}"`);
      err.status = 403;
      throw err;
    }
  }

  return {
    connection,
    grant: grantPublic(grant, [tg]),
    tableGrant: tableGrantPublic(tg),
  };
}

/**
 * Ensure column is allowed (if allowlist set) and valid identifier.
 */
function filterColumns(tableGrant, columns) {
  const allow = tableGrant.allowedColumns;
  const out = [];
  for (const col of columns) {
    const c = assertIdent(col, 'column');
    if (allow && !allow.includes(c)) {
      const err = new Error(`Column "${c}" is not allowed`);
      err.status = 403;
      throw err;
    }
    out.push(c);
  }
  return out;
}

module.exports = {
  listGrantsForConnection,
  listGrantsForApiKey,
  listTableGrants,
  getGrant,
  upsertGrant,
  deleteGrant,
  resolveAccess,
  filterColumns,
  tableGrantPublic,
  grantPublic,
  parseAllowedColumns,
};
