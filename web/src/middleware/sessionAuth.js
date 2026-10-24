const crypto = require('crypto');
const { getAdminBasePath, getGoogleOAuthConfig } = require('../config');

function requireAdminSession(req, res, next) {
  if (req.session && isAdminSessionAuthenticated(req.session.admin)) {
    return next();
  }

  const wantsJson =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    (req.path && req.path.includes('/api/'));

  if (wantsJson) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const base = getAdminBasePath();
  const returnTo = encodeURIComponent(req.originalUrl || base);
  return res.redirect(`${base}/login?next=${returnTo}`);
}

function isAdminSessionAuthenticated(admin, config = getGoogleOAuthConfig(), now = Date.now()) {
  if (!admin) return false;
  if (!config.required) return true;
  if (!config.configured || admin.mfa?.provider !== 'google' || !admin.mfa.verifiedAt) return false;
  const verifiedAt = new Date(admin.mfa.verifiedAt).getTime();
  return Number.isFinite(verifiedAt) && now - verifiedAt <= config.sessionHours * 60 * 60 * 1000;
}

function requireAdminRole(req, res, next) {
  const type = principalType(req.session?.admin);
  if (req.session?.admin && ['root', 'platform'].includes(type)) {
    return next();
  }
  return res.status(403).json({ error: 'Admin role required' });
}

function requireRootRole(req, res, next) {
  if (req.session?.admin && principalType(req.session.admin) === 'root') return next();
  return res.status(403).json({ error: 'Root authorization required' });
}

function ensureAdminCsrf(req) {
  if (!req.session) throw new Error('Session middleware is unavailable');
  if (!req.session.adminCsrf) req.session.adminCsrf = crypto.randomBytes(24).toString('base64url');
  return req.session.adminCsrf;
}

function requireAdminCsrf(req, res, next) {
  const expected = ensureAdminCsrf(req);
  const supplied = String(req.get('x-admin-csrf') || '');
  if (!supplied || supplied.length !== expected.length) {
    return res.status(403).json({ error: 'Invalid administrative request token', code: 'ADMIN_CSRF_INVALID' });
  }
  if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Invalid administrative request token', code: 'ADMIN_CSRF_INVALID' });
  }
  return next();
}

function requireOwlAccess(req, res, next) {
  const type = principalType(req.session?.admin);
  if (req.session?.admin && ['root', 'platform', 'tenant'].includes(type)) return next();
  return res.status(403).json({ error: 'OWL access required' });
}

function assertAdminApiKeyScope(admin, apiKeyId) {
  const type = principalType(admin);
  if (type === 'tenant' && (!apiKeyId || String(apiKeyId) !== String(admin.apiKeyId))) {
    throw Object.assign(new Error('Selected API key is outside this administrator tenant'), { status: 403 });
  }
}

function principalType(admin) {
  if (admin?.principalType) return admin.principalType;
  return admin?.role === 'admin' ? 'root' : 'viewer';
}

/**
 * Ensure `next` redirect target stays under admin base path.
 */
function safeAdminNext(nextUrl, fallback) {
  const base = getAdminBasePath();
  const fb = fallback || base;
  if (!nextUrl || typeof nextUrl !== 'string') return fb;
  try {
    // relative only
    if (nextUrl.startsWith('//') || nextUrl.includes('://')) return fb;
    if (!nextUrl.startsWith(base)) return fb;
    return nextUrl;
  } catch {
    return fb;
  }
}

module.exports = {
  requireAdminSession,
  requireAdminRole,
  requireRootRole,
  ensureAdminCsrf,
  requireAdminCsrf,
  requireOwlAccess,
  assertAdminApiKeyScope,
  principalType,
  safeAdminNext,
  isAdminSessionAuthenticated,
};
