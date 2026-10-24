const {
  getDataPool,
  assertIdent,
  quoteIdent,
} = require('./sqlConnections');
const { filterColumns } = require('./sqlGrants');

/**
 * Safe table data operations against a granted connection.
 * No raw SQL from clients — only parameterized, identifier-validated queries.
 */

function clampLimit(requested, maxRows) {
  const max = Math.min(Math.max(Number(maxRows) || 500, 1), 5000);
  let n = Number(requested);
  if (!Number.isFinite(n) || n < 1) n = Math.min(100, max);
  return Math.min(Math.floor(n), max);
}

function clampOffset(requested) {
  let n = Number(requested);
  if (!Number.isFinite(n) || n < 0) n = 0;
  return Math.min(Math.floor(n), 1_000_000);
}

/**
 * Build the server-side SELECT projection for a table grant.
 * A null allowlist preserves the existing explicit "all columns" grant semantics.
 * A configured allowlist is always enforced before data leaves the database.
 */
function selectProjection(tableGrant) {
  const allowed = tableGrant && tableGrant.allowedColumns;
  if (allowed == null) return '*';
  const columns = filterColumns(tableGrant, allowed);
  if (!columns.length) {
    const err = new Error('No readable columns are configured for this table grant');
    err.status = 403;
    throw err;
  }
  return columns.map(quoteIdent).join(', ');
}

/**
 * Parse equality filters from query object.
 * Supports filter[col]=value or where[col]=value or flat ?col= if prefixed f.
 */
function parseFilters(query, tableGrant) {
  const filters = {};
  const sources = [
    query.filter && typeof query.filter === 'object' ? query.filter : null,
    query.where && typeof query.where === 'object' ? query.where : null,
  ].filter(Boolean);

  // Also support filter.col style from Express nested query
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || v === '') continue;
      filters[k] = v;
    }
  }

  // Express may flatten as filter[email]
  for (const [k, v] of Object.entries(query || {})) {
    const m = k.match(/^(?:filter|where)\[([^\]]+)\]$/);
    if (m && v !== undefined && v !== '') filters[m[1]] = v;
  }

  const cols = filterColumns(tableGrant, Object.keys(filters));
  return cols.map((c) => ({ column: c, value: filters[c] }));
}

async function selectRows(connection, tableGrant, { limit, offset, orderBy, orderDir, query }) {
  const table = assertIdent(tableGrant.tableName, 'table');
  const pool = await getDataPool(connection);
  const lim = clampLimit(limit, connection.max_rows);
  const off = clampOffset(offset);
  const filters = parseFilters(query || {}, tableGrant);

  const projection = selectProjection(tableGrant);
  let sql = `SELECT ${projection} FROM ${quoteIdent(table)}`;
  const params = [];
  if (filters.length) {
    sql += ' WHERE ' + filters.map((f) => `${quoteIdent(f.column)} = ?`).join(' AND ');
    params.push(...filters.map((f) => f.value));
  }

  if (orderBy) {
    const col = filterColumns(tableGrant, [orderBy])[0];
    const dir = String(orderDir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    sql += ` ORDER BY ${quoteIdent(col)} ${dir}`;
  }

  sql += ' LIMIT ? OFFSET ?';
  params.push(lim, off);

  const [rows] = await pool.query(sql, params);

  // Count (same filters)
  let countSql = `SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`;
  const countParams = [];
  if (filters.length) {
    countSql += ' WHERE ' + filters.map((f) => `${quoteIdent(f.column)} = ?`).join(' AND ');
    countParams.push(...filters.map((f) => f.value));
  }
  const [countRows] = await pool.query(countSql, countParams);
  const total = Number(countRows[0]?.c) || 0;

  return { rows, total, limit: lim, offset: off };
}

async function selectByPk(connection, tableGrant, pkValue) {
  const table = assertIdent(tableGrant.tableName, 'table');
  const pk = assertIdent(tableGrant.primaryKey, 'primary key');
  const pool = await getDataPool(connection);
  const projection = selectProjection(tableGrant);
  const [rows] = await pool.query(
    `SELECT ${projection} FROM ${quoteIdent(table)} WHERE ${quoteIdent(pk)} = ? LIMIT 1`,
    [pkValue]
  );
  return rows[0] || null;
}

async function insertRow(connection, tableGrant, body) {
  const table = assertIdent(tableGrant.tableName, 'table');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('Body must be a JSON object');
    err.status = 400;
    throw err;
  }
  const keys = Object.keys(body).filter((k) => body[k] !== undefined);
  if (!keys.length) {
    const err = new Error('No fields to insert');
    err.status = 400;
    throw err;
  }
  const cols = filterColumns(tableGrant, keys);
  const pool = await getDataPool(connection);
  const placeholders = cols.map(() => '?').join(', ');
  const colSql = cols.map(quoteIdent).join(', ');
  const values = cols.map((c) => body[c]);
  const [result] = await pool.query(
    `INSERT INTO ${quoteIdent(table)} (${colSql}) VALUES (${placeholders})`,
    values
  );

  // Prefer returning by insertId if numeric PK
  if (result.insertId) {
    const row = await selectByPk(connection, tableGrant, result.insertId);
    if (row) return row;
  }
  const pk = tableGrant.primaryKey;
  if (body[pk] != null) {
    return selectByPk(connection, tableGrant, body[pk]);
  }
  return { success: true, affectedRows: result.affectedRows };
}

async function updateRow(connection, tableGrant, pkValue, body) {
  const table = assertIdent(tableGrant.tableName, 'table');
  const pk = assertIdent(tableGrant.primaryKey, 'primary key');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('Body must be a JSON object');
    err.status = 400;
    throw err;
  }
  const keys = Object.keys(body).filter((k) => k !== pk && body[k] !== undefined);
  if (!keys.length) {
    const err = new Error('No fields to update');
    err.status = 400;
    throw err;
  }
  const cols = filterColumns(tableGrant, keys);
  const pool = await getDataPool(connection);
  const sets = cols.map((c) => `${quoteIdent(c)} = ?`).join(', ');
  const values = [...cols.map((c) => body[c]), pkValue];
  const [result] = await pool.query(
    `UPDATE ${quoteIdent(table)} SET ${sets} WHERE ${quoteIdent(pk)} = ?`,
    values
  );
  if (!result.affectedRows) {
    const err = new Error('Row not found');
    err.status = 404;
    throw err;
  }
  return selectByPk(connection, tableGrant, pkValue);
}

async function deleteRow(connection, tableGrant, pkValue) {
  const table = assertIdent(tableGrant.tableName, 'table');
  const pk = assertIdent(tableGrant.primaryKey, 'primary key');
  const pool = await getDataPool(connection);
  const [result] = await pool.query(
    `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(pk)} = ?`,
    [pkValue]
  );
  return { deleted: result.affectedRows > 0, affectedRows: result.affectedRows };
}

module.exports = {
  selectRows,
  selectByPk,
  insertRow,
  updateRow,
  deleteRow,
  clampLimit,
  parseFilters,
  selectProjection,
};
