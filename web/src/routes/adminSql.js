const express = require('express');
const path = require('path');
const { ROOT } = require('../config');
const { requireAdminSession, requireAdminRole } = require('../middleware/sessionAuth');
const {
  listConnections,
  getConnectionById,
  createConnection,
  updateConnection,
  deleteConnection,
  testSqlConnection,
  listTables,
  describeTable,
  publicConnection,
} = require('../services/sqlConnections');
const {
  listGrantsForConnection,
  upsertGrant,
  deleteGrant,
} = require('../services/sqlGrants');
const { listKeys } = require('../services/apiKeys');

function createAdminSqlRouter() {
  const router = express.Router();

  router.use(requireAdminSession);

  router.get('/connections', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'connections.html'));
  });

  // --- Connections CRUD ---
  router.get('/api/sql/connections', requireAdminRole, async (req, res) => {
    try {
      const connections = await listConnections();
      res.json({ ok: true, connections });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Error' });
    }
  });

  router.get('/api/sql/connections/:id', requireAdminRole, async (req, res) => {
    try {
      const row = await getConnectionById(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true, connection: publicConnection(row) });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Error' });
    }
  });

  router.post('/api/sql/connections', requireAdminRole, async (req, res) => {
    try {
      const connection = await createConnection({
        ...(req.body || {}),
        createdBy: req.session.admin && req.session.admin.id,
      });
      res.status(201).json({ ok: true, connection });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.put('/api/sql/connections/:id', requireAdminRole, async (req, res) => {
    try {
      const connection = await updateConnection(req.params.id, req.body || {});
      res.json({ ok: true, connection });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.delete('/api/sql/connections/:id', requireAdminRole, async (req, res) => {
    try {
      const ok = await deleteConnection(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Error' });
    }
  });

  router.post('/api/sql/connections/test', requireAdminRole, async (req, res) => {
    try {
      const result = await testSqlConnection(req.body || {});
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.status || 400).json({ ok: false, error: err.message || 'Test failed' });
    }
  });

  router.post('/api/sql/connections/:id/test', requireAdminRole, async (req, res) => {
    try {
      const result = await testSqlConnection({
        ...(req.body || {}),
        id: req.params.id,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.status || 400).json({ ok: false, error: err.message || 'Test failed' });
    }
  });

  router.get('/api/sql/connections/:id/tables', requireAdminRole, async (req, res) => {
    try {
      const row = await getConnectionById(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      const tables = await listTables(row);
      res.json({ ok: true, tables });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.get(
    '/api/sql/connections/:id/tables/:table',
    requireAdminRole,
    async (req, res) => {
      try {
        const row = await getConnectionById(req.params.id);
        if (!row) return res.status(404).json({ error: 'Not found' });
        const columns = await describeTable(row, req.params.table);
        res.json({ ok: true, table: req.params.table, columns });
      } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Error' });
      }
    }
  );

  // --- Grants ---
  router.get('/api/sql/connections/:id/grants', requireAdminRole, async (req, res) => {
    try {
      const grants = await listGrantsForConnection(req.params.id);
      res.json({ ok: true, grants });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Error' });
    }
  });

  router.put('/api/sql/connections/:id/grants', requireAdminRole, async (req, res) => {
    try {
      const body = req.body || {};
      const grant = await upsertGrant({
        connectionId: req.params.id,
        apiKeyId: body.apiKeyId || body.api_key_id,
        canIntrospect: body.canIntrospect !== false && body.can_introspect !== false,
        tables: body.tables || [],
      });
      res.json({ ok: true, grant });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.delete('/api/sql/grants/:grantId', requireAdminRole, async (req, res) => {
    try {
      const ok = await deleteGrant(req.params.grantId);
      if (!ok) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Error' });
    }
  });

  router.get('/api/sql/keys-for-grants', requireAdminRole, async (req, res) => {
    try {
      const keys = await listKeys();
      res.json({
        ok: true,
        keys: keys
          .filter((k) => !k.revoked_at)
          .map((k) => ({
            id: k.id,
            name: k.name,
            key_prefix: k.key_prefix,
          })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Error' });
    }
  });

  return router;
}

module.exports = { createAdminSqlRouter };
