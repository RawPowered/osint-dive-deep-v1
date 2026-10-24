const express = require('express');
const path = require('path');
const { ROOT } = require('../config');
const { requireAdminSession, requireAdminRole } = require('../middleware/sessionAuth');
const { createKey, listKeys, revokeKey } = require('../services/apiKeys');

function createAdminKeysRouter() {
  const router = express.Router();

  router.use(requireAdminSession);

  router.get('/keys', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'keys.html'));
  });

  router.get('/api/keys', requireAdminRole, async (req, res) => {
    try {
      const keys = await listKeys();
      res.json({ ok: true, keys });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.post('/api/keys', requireAdminRole, async (req, res) => {
    try {
      const { name } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }
      const key = await createKey({
        name: String(name).trim(),
        createdBy: req.session.admin.id,
      });
      res.status(201).json({
        ok: true,
        key: {
          id: key.id,
          name: key.name,
          key_prefix: key.key_prefix,
          secret: key.secret,
          created_at: key.created_at,
        },
        warning: 'Copy this API key now. It will not be shown again.',
      });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.post('/api/keys/:id/revoke', requireAdminRole, async (req, res) => {
    try {
      const ok = await revokeKey(req.params.id);
      if (!ok) {
        return res.status(404).json({ error: 'Key not found or already revoked' });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  return router;
}

module.exports = { createAdminKeysRouter };
