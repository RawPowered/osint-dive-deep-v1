const crypto = require('crypto');

function ensureCustomerCsrf(req) {
  if (!req.session) throw new Error('Session middleware is unavailable');
  if (!req.session.diveDeepCsrf) req.session.diveDeepCsrf = crypto.randomBytes(24).toString('base64url');
  return req.session.diveDeepCsrf;
}

function requireCustomerSession(req, res, next) {
  if (req.session?.diveDeepCustomer?.id) return next();
  const wantsJson = req.path.includes('/api/') || (req.headers.accept || '').includes('application/json');
  if (wantsJson) return res.status(401).json({ error: 'Not authenticated', code: 'DIVEDEEP_NOT_AUTHENTICATED' });
  return res.redirect('/divedeep/login');
}

function requireCustomerCsrf(req, res, next) {
  const expected = ensureCustomerCsrf(req);
  const supplied = String(req.get('x-divedeep-csrf') || '');
  if (!supplied || supplied.length !== expected.length) {
    return res.status(403).json({ error: 'Invalid request token', code: 'DIVEDEEP_CSRF_INVALID' });
  }
  const valid = crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return res.status(403).json({ error: 'Invalid request token', code: 'DIVEDEEP_CSRF_INVALID' });
  return next();
}

module.exports = { ensureCustomerCsrf, requireCustomerSession, requireCustomerCsrf };
