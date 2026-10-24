const express = require('express');
const {
  extractOperatorToken,
  verifyOperatorSession,
  revokeOperatorSession,
  publicOperatorIdentity,
  clearOperatorSessionCookie,
} = require('../../services/operatorSessions');

function createSystemIdentityRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  router.get('/status', async (req, res) => {
    try {
      const result = await optionalSession(req);
      if (result.invalid) return invalidSession(res);
      if (!result.session) return res.json({ success:true, authenticated:false });
      return res.json({
        success:true,
        authenticated:true,
        user:publicOperatorIdentity(result.session),
        expiresAt:result.session.expiresAt,
      });
    } catch {
      return res.status(500).json({ success:false, error:'Status unavailable' });
    }
  });

  router.get('/has-admin', async (req, res) => {
    try {
      const result = await optionalSession(req);
      if (result.invalid) return invalidSession(res);
      if (!result.session) return res.json({ success:true, authenticated:false, hasAdmin:false });
      return res.json({ success:true, authenticated:true, hasAdmin:result.session.isAdmin });
    } catch {
      return res.status(500).json({ success:false, error:'Authorization status unavailable' });
    }
  });

  router.post('/logout', async (req, res) => {
    try {
      const token = extractOperatorToken(req);
      clearOperatorSessionCookie(res);
      if (!token) return invalidSession(res);
      await revokeOperatorSession(token);
      return res.json({ success:true });
    } catch {
      return res.status(500).json({ success:false, error:'Logout failed' });
    }
  });

  return router;
}

async function optionalSession(req) {
  const token = extractOperatorToken(req);
  if (!token) return { session:null, invalid:false };
  const session = await verifyOperatorSession(token);
  return { session, invalid:!session };
}

function invalidSession(res) {
  return res.status(401).json({ success:false, error:'Operator session invalid or expired' });
}

module.exports = { createSystemIdentityRouter };
