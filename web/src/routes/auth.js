const express = require('express');
const path = require('path');
const { ROOT, getAdminBasePath } = require('../config');
const { verifyPassword, findPrincipalById } = require('../services/adminUsers');
const googleMfa = require('../services/googleAdminMfa');
const { getGoogleOAuthConfig } = require('../config');
const { requireAdminSession, safeAdminNext, isAdminSessionAuthenticated, ensureAdminCsrf } = require('../middleware/sessionAuth');
const { loginLimiter } = require('../middleware/rateLimit');

function createAuthRouter(dependencies = {}) {
  const router = express.Router();
  const base = () => getAdminBasePath();
  const verifyPasswordFn = dependencies.verifyPassword || verifyPassword;
  const findPrincipalFn = dependencies.findPrincipalById || findPrincipalById;
  const oauth = dependencies.googleMfa || googleMfa;
  const oauthConfig = dependencies.getGoogleOAuthConfig || getGoogleOAuthConfig;

  router.get('/login', (req, res) => {
    if (req.session && isAdminSessionAuthenticated(req.session.admin, oauthConfig())) {
      return res.redirect(base());
    }
    res.sendFile(path.join(ROOT, 'public', 'admin', 'login.html'));
  });

  router.post('/login', loginLimiter, async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'Invalid credentials' });
      }
      const admin = await verifyPasswordFn(username, password);
      if (!admin) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const next = safeAdminNext(req.body && req.body.next, base());
      const config = oauthConfig();
      if (config.required) {
        if (!config.configured) {
          return res.status(503).json({ error: `Admin MFA configuration is incomplete: ${config.errors.join('; ')}` });
        }
        const adminEmail = String(admin.email || '').trim().toLowerCase();
        const rootBootstrap = admin.principalType === 'root' && !adminEmail && config.allowedEmails.length === 1;
        if ((!adminEmail && !rootBootstrap) || (adminEmail && !config.allowedEmails.includes(adminEmail))) {
          return res.status(403).json({
            error: 'This administrator email is not enrolled in the Google MFA allowlist. Contact the root owner.',
          });
        }
        await regenerateSession(req);
        req.session.pendingAdmin = admin;
        req.session.pendingAdminNext = next;
        req.sentinelControl = {
          action: 'admin.password.verify', entityType: 'administrator', entityId: admin.id,
        };
        return res.json({
          ok: true,
          mfaRequired: true,
          redirect: `${base()}/auth/google`,
          adminBasePath: base(),
        });
      }
      await regenerateSession(req);
      req.session.admin = admin;
      res.json({
        ok: true,
        admin: { id: admin.id, username: admin.username, role: admin.role },
        redirect: next,
        adminBasePath: base(),
      });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  router.get('/auth/google', (req, res) => {
    try {
      if (!req.session?.pendingAdmin) return res.redirect(`${base()}/login?mfaError=session`);
      const request = oauth.createAuthorizationRequest(oauthConfig());
      req.session.adminOAuthIntent = request.intent;
      req.sentinelControl = {
        action: 'admin.mfa.challenge', entityType: 'administrator',
        entityId: req.session.pendingAdmin.id,
      };
      return req.session.save((error) => {
        if (error) return res.redirect(`${base()}/login?mfaError=session`);
        return res.redirect(request.url);
      });
    } catch (error) {
      console.error('Admin MFA start error:', error.message);
      return res.redirect(`${base()}/login?mfaError=configuration`);
    }
  });

  router.get('/auth/google/callback', async (req, res) => {
    const pending = req.session?.pendingAdmin;
    const intent = req.session?.adminOAuthIntent;
    req.sentinelControl = {
      action: 'admin.mfa.verify', entityType: 'administrator', entityId: pending?.id,
    };
    try {
      if (req.query.error || !pending || !oauth.validateOAuthIntent(intent, req.query.state)) {
        throw oauth.oauthError('Google MFA state validation failed');
      }
      req.session.adminOAuthIntent = null;
      await saveSession(req);
      const identity = await oauth.exchangeGoogleCode(
        req.query.code, intent.verifier, oauthConfig()
      );
      const currentAdmin = await findPrincipalFn(pending.id, pending.principalType);
      if (!currentAdmin) throw oauth.oauthError('Administrative account is no longer active', 403);
      const mfa = await oauth.bindGoogleIdentity(currentAdmin, identity, oauthConfig());
      const next = safeAdminNext(req.session.pendingAdminNext, base());
      await regenerateSession(req);
      req.session.admin = {
        ...currentAdmin,
        mfa: { provider: 'google', email: mfa.email, verifiedAt: new Date().toISOString() },
      };
      return req.session.save((error) => {
        if (error) return res.redirect(`${base()}/login?mfaError=session`);
        return res.redirect(next);
      });
    } catch (error) {
      req.sentinelControlDenied = error.code || 'admin_mfa_failed';
      console.warn('Admin MFA verification failed:', error.message);
      return req.session.destroy(() => res.redirect(`${base()}/login?mfaError=verification`));
    }
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('sid');
      res.json({ ok: true, redirect: `${base()}/login` });
    });
  });

  router.get('/me', requireAdminSession, async (req, res) => {
    try {
      const admin = await findPrincipalFn(req.session.admin.id, req.session.admin.principalType);
      if (!admin) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'Not authenticated' });
      }
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.json({ ok: true, admin, adminBasePath: base(), csrfToken: ensureAdminCsrf(req) });
    } catch (err) {
      console.error('Admin identity check error:', err.message);
      res.status(500).json({ error: 'Error' });
    }
  });

  return router;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
  });
}

module.exports = { createAuthRouter, regenerateSession, saveSession };
