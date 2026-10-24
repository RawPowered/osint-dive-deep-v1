const express = require('express');
const {
  getWorkspace,
  upsertWorkspace,
  deleteWorkspace,
  heartbeatWorkspace,
  resolveCrmUrl,
} = require('../../services/dialerWorkspace');
const { getPool } = require('../../db/pool');
const { requireOperatorSession } = require('../../services/operatorSessions');

/**
 * Session Harbor routes — dialer workspace continuity.
 * Mounted at /api/sessions (already behind apiKeyAuth + Sentinel).
 */
function createSessionsRouter() {
  const router = express.Router();

  /**
   * GET /api/sessions/workspace?locationId=&userId=
   */
  router.get('/workspace', async (req, res) => {
    try {
      const locationId = req.query.locationId;
      const userId = req.query.userId;
      if (!locationId || !userId) {
        return res.status(400).json({
          success: false,
          error: 'Missing locationId or userId',
        });
      }
      const operator = await requireOperatorSession(req, {
        locationId:String(locationId), userId:String(userId),
      });
      const workspace = await getWorkspace(operator.locationId, operator.userId);
      if (!workspace) {
        return res.json({ success: true, workspace: null });
      }
      return res.json({ success: true, workspace });
    } catch (err) {
      return res.status(err.status || 500).json({ success: false, error: err.message, code:err.code });
    }
  });

  /**
   * PUT /api/sessions/workspace
   * Body: { locationId, userId, state, clientTabId?, expectedRevision?, leaseSeconds? }
   */
  router.put('/workspace', async (req, res) => {
    try {
      const {
        locationId,
        userId,
        state,
        clientTabId,
        expectedRevision,
        leaseSeconds,
      } = req.body || {};

      const operator = await requireOperatorSession(req, {
        locationId:String(locationId || ''), userId:String(userId || ''),
      });

      const result = await upsertWorkspace({
        locationId:operator.locationId,
        userId:operator.userId,
        state,
        clientTabId,
        expectedRevision,
        leaseSeconds,
      });

      if (!result.ok) {
        return res.status(result.status || 400).json({
          success: false,
          error: result.error,
          workspace: result.workspace !== undefined ? result.workspace : undefined,
        });
      }
      return res.json({ success: true, workspace: result.workspace });
    } catch (err) {
      return res.status(err.status || 500).json({ success: false, error: err.message, code:err.code });
    }
  });

  /**
   * DELETE /api/sessions/workspace
   * Body or query: locationId, userId
   */
  router.delete('/workspace', async (req, res) => {
    try {
      const locationId = (req.body && req.body.locationId) || req.query.locationId;
      const userId = (req.body && req.body.userId) || req.query.userId;
      const operator = await requireOperatorSession(req, {
        locationId:String(locationId || ''), userId:String(userId || ''),
      });
      const result = await deleteWorkspace(operator.locationId, operator.userId);
      if (!result.ok) {
        return res.status(result.status || 400).json({
          success: false,
          error: result.error,
        });
      }
      return res.json({ success: true, deleted: result.deleted });
    } catch (err) {
      return res.status(err.status || 500).json({ success: false, error: err.message, code:err.code });
    }
  });

  /**
   * POST /api/sessions/workspace/heartbeat
   * Body: { locationId, userId, clientTabId?, leaseSeconds? }
   */
  router.post('/workspace/heartbeat', async (req, res) => {
    try {
      const { locationId, userId, clientTabId, leaseSeconds } = req.body || {};
      const pool = getPool();
      const operator = await requireOperatorSession(req, {
        locationId:String(locationId || ''), userId:String(userId || ''),
      }, pool);
      const result = await heartbeatWorkspace({
        locationId:operator.locationId,
        userId:operator.userId,
        clientTabId,
        leaseSeconds: leaseSeconds != null ? leaseSeconds : 120,
      }, pool);
      if (!result.ok) {
        return res.status(result.status || 400).json({
          success: false,
          error: result.error,
        });
      }
      await pool.query(
        `INSERT INTO dialer_activity_minutes
           (location_id,user_id,activity_minute,heartbeat_count,crm_contact_id,client_tab_id)
         VALUES (?,?,FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(UTC_TIMESTAMP())/60)*60),1,?,?)
         ON DUPLICATE KEY UPDATE heartbeat_count=LEAST(65535,heartbeat_count+1),
           crm_contact_id=COALESCE(VALUES(crm_contact_id),crm_contact_id),
           client_tab_id=COALESCE(VALUES(client_tab_id),client_tab_id),updated_at=UTC_TIMESTAMP(3)`,
        [operator.locationId, operator.userId, result.workspace?.crmContactId || null,
          result.workspace?.clientTabId || null]
      );
      return res.json({ success: true, workspace: result.workspace });
    } catch (err) {
      return res.status(err.status || 500).json({ success: false, error: err.message, code:err.code });
    }
  });

  /**
   * GET /api/sessions/workspace/resolve-url?locationId=&contactId=&path=
   */
  router.get('/workspace/resolve-url', (req, res) => {
    try {
      const { locationId, contactId, path: rawPath } = req.query;
      const result = resolveCrmUrl({
        locationId,
        contactId,
        path: rawPath,
      });
      if (!result.ok) {
        return res.status(400).json({ success: false, error: result.error });
      }
      return res.json({
        success: true,
        origin: result.origin,
        path: result.path,
        url: result.url,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createSessionsRouter };
