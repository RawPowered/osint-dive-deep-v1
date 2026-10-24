const express = require('express');
const path = require('path');
const { ROOT } = require('../config');
const { requireAdminSession, requireAdminRole } = require('../middleware/sessionAuth');
const {
  listIntegrations,
  getIntegrationById,
  publicIntegration,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  upsertGrant,
  listGrants,
} = require('../services/crmIntegrations');
const { testIntegration } = require('../services/crmImporter');

function createAdminCrmRouter() {
  const router = express.Router();
  router.use(requireAdminSession);

  router.get('/crm-integrations', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'crm-integrations.html'));
  });

  router.get('/api/crm/integrations', requireAdminRole, async (req, res) => {
    try {
      res.json({ ok: true, integrations: await listIntegrations() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/crm/integrations', requireAdminRole, async (req, res) => {
    try {
      const integration = await createIntegration({
        ...(req.body || {}),
        createdBy: req.session.admin.id,
      });
      res.status(201).json({ ok: true, integration });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Compatibility guard for cached admin clients that exposed Test before an integration was saved.
  router.post('/api/crm/integrations/test', requireAdminRole, (req, res) => {
    res.status(400).json({ error: 'Save the integration before testing the connection' });
  });

  router.get('/api/crm/integrations/:id', requireAdminRole, async (req, res) => {
    try {
      const row = await getIntegrationById(req.params.id);
      if (!row) return res.status(404).json({ error: 'CRM integration not found' });
      res.json({ ok: true, integration: publicIntegration(row), grants: await listGrants(row.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/api/crm/integrations/:id', requireAdminRole, async (req, res) => {
    try {
      res.json({ ok: true, integration: await updateIntegration(req.params.id, req.body || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/api/crm/integrations/:id', requireAdminRole, async (req, res) => {
    try {
      const deleted = await deleteIntegration(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'CRM integration not found' });
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/crm/integrations/:id/test', requireAdminRole, async (req, res) => {
    try {
      const row = await getIntegrationById(req.params.id);
      if (!row) return res.status(404).json({ error: 'CRM integration not found' });
      res.json({ ok: true, ...(await testIntegration(row)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/api/crm/integrations/:id/grants', requireAdminRole, async (req, res) => {
    try {
      const row = await getIntegrationById(req.params.id);
      if (!row) return res.status(404).json({ error: 'CRM integration not found' });
      res.json({ ok: true, grant: await upsertGrant(row.id, req.body || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

function sendError(res, error) {
  res.status(error.status || 500).json({ error: error.message || 'CRM operation failed' });
}

module.exports = { createAdminCrmRouter };
