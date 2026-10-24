const express = require('express');
const { resolveAccess } = require('../../services/sqlGrants');
const { listTables, describeTable } = require('../../services/sqlConnections');
const {
  selectRows,
  selectByPk,
  insertRow,
  updateRow,
  deleteRow,
} = require('../../services/sqlTableRouter');

/**
 * Machine SQL data API — only via granted connections/tables.
 * Mounted at /api/sql
 */
function createSqlDataRouter() {
  const router = express.Router();

  function apiKeyId(req) {
    return req.apiKey && req.apiKey.id;
  }

  /** List connections + table grants visible to this API key */
  router.get('/connections', async (req, res) => {
    try {
      const { listGrantsForApiKey } = require('../../services/sqlGrants');
      const grants = await listGrantsForApiKey(apiKeyId(req));
      res.json({
        success: true,
        connections: grants.map((g) => ({
          slug: g.connectionSlug,
          name: g.connectionName,
          canIntrospect: g.canIntrospect,
          tables: g.tables.map((t) => ({
            tableName: t.tableName,
            allowSelect: t.allowSelect,
            allowInsert: t.allowInsert,
            allowUpdate: t.allowUpdate,
            allowDelete: t.allowDelete,
            primaryKey: t.primaryKey,
            allowedColumns: t.allowedColumns,
          })),
        })),
      });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message });
    }
  });

  /** Introspect tables (requires can_introspect on grant) */
  router.get('/:slug/tables', async (req, res) => {
    try {
      const { connection, grant } = await resolveAccess({
        apiKeyId: apiKeyId(req),
        connectionSlug: req.params.slug,
      });
      if (!grant.canIntrospect) {
        return res.status(403).json({
          success: false,
          error: 'Introspection not allowed for this key on this connection',
        });
      }
      const all = await listTables(connection);
      const { getGrant } = require('../../services/sqlGrants');
      const full = await getGrant(connection.id, apiKeyId(req));
      const allowedNames = new Set((full.tables || []).map((t) => t.tableName));
      const tables = all.filter((t) => allowedNames.has(t.name));
      res.json({
        success: true,
        slug: connection.slug,
        database: connection.database_name,
        tables,
        grants: full.tables,
      });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message });
    }
  });

  router.get('/:slug/tables/:table/columns', async (req, res) => {
    try {
      const { connection, grant, tableGrant } = await resolveAccess({
        apiKeyId: apiKeyId(req),
        connectionSlug: req.params.slug,
        tableName: req.params.table,
      });
      if (!grant.canIntrospect) {
        return res.status(403).json({ success: false, error: 'Introspection not allowed' });
      }
      let columns = await describeTable(connection, req.params.table);
      if (tableGrant.allowedColumns) {
        const allow = new Set(tableGrant.allowedColumns);
        columns = columns.filter((c) => allow.has(c.name));
      }
      res.json({
        success: true,
        table: tableGrant.tableName,
        primaryKey: tableGrant.primaryKey,
        columns,
      });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message });
    }
  });

  /** List rows */
  router.get('/:slug/:table', async (req, res) => {
    try {
      const { connection, tableGrant } = await resolveAccess({
        apiKeyId: apiKeyId(req),
        connectionSlug: req.params.slug,
        tableName: req.params.table,
        op: 'select',
      });
      const result = await selectRows(connection, tableGrant, {
        limit: req.query.limit,
        offset: req.query.offset,
        orderBy: req.query.orderBy || req.query.order_by,
        orderDir: req.query.orderDir || req.query.order_dir,
        query: req.query,
      });
      res.json({
        success: true,
        slug: connection.slug,
        table: tableGrant.tableName,
        ...result,
      });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message });
    }
  });

  /** Get by primary key */
  router.get('/:slug/:table/:pk', async (req, res) => {
    try {
      const { connection, tableGrant } = await resolveAccess({
        apiKeyId: apiKeyId(req),
        connectionSlug: req.params.slug,
        tableName: req.params.table,
        op: 'select',
      });
      const row = await selectByPk(connection, tableGrant, req.params.pk);
      if (!row) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }
      res.json({ success: true, row });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message });
    }
  });

  /** Insert */
  router.post('/:slug/:table', async (req, res) => {
    try {
      const { connection, tableGrant } = await resolveAccess({
        apiKeyId: apiKeyId(req),
        connectionSlug: req.params.slug,
        tableName: req.params.table,
        op: 'insert',
      });
      const row = await insertRow(connection, tableGrant, req.body || {});
      res.status(201).json({ success: true, row });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message });
    }
  });

  /** Update */
  router.put('/:slug/:table/:pk', async (req, res) => {
    try {
      const { connection, tableGrant } = await resolveAccess({
        apiKeyId: apiKeyId(req),
        connectionSlug: req.params.slug,
        tableName: req.params.table,
        op: 'update',
      });
      const row = await updateRow(connection, tableGrant, req.params.pk, req.body || {});
      res.json({ success: true, row });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message });
    }
  });

  router.patch('/:slug/:table/:pk', async (req, res) => {
    try {
      const { connection, tableGrant } = await resolveAccess({
        apiKeyId: apiKeyId(req),
        connectionSlug: req.params.slug,
        tableName: req.params.table,
        op: 'update',
      });
      const row = await updateRow(connection, tableGrant, req.params.pk, req.body || {});
      res.json({ success: true, row });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message });
    }
  });

  /** Delete */
  router.delete('/:slug/:table/:pk', async (req, res) => {
    try {
      const { connection, tableGrant } = await resolveAccess({
        apiKeyId: apiKeyId(req),
        connectionSlug: req.params.slug,
        tableName: req.params.table,
        op: 'delete',
      });
      const result = await deleteRow(connection, tableGrant, req.params.pk);
      if (!result.deleted) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createSqlDataRouter };
