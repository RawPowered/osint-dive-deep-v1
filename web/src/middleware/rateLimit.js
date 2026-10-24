const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const skipOptions = (req) => req.method === 'OPTIONS';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // SP-04: strict lockout limit
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
  skip: skipOptions,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    return username ? `user:${username}` : `ip:${ipKeyGenerator(req.ip)}`;
  },
});


const customerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
  skip: skipOptions,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    return email ? `divedeep:${email}` : `divedeep-ip:${ipKeyGenerator(req.ip)}`;
  },
});

/** Per-IP limit for machine API (before/around auth). */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded' },
  skip: skipOptions,
});

const externalOAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OAuth token requests', code: 'DIVEDEEP_OAUTH_RATE_LIMITED' },
  skip: skipOptions,
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    const clientId = String(req.body?.client_id || req.body?.clientId || '').trim();
    return clientId ? `divedeep-oauth:${clientId}` : `divedeep-oauth-ip:${ipKeyGenerator(req.ip)}`;
  },
});

const installLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many install attempts' },
  skip: skipOptions,
});

const customerMetaSyncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Meta data was synchronized recently. Try again in a few minutes.' },
  skip: skipOptions,
  keyGenerator: (req) => {
    const customerId = String(req.session?.diveDeepCustomer?.id || '').trim();
    return customerId ? `divedeep-meta:${customerId}` : `divedeep-meta-ip:${ipKeyGenerator(req.ip)}`;
  },
});

module.exports = {
  loginLimiter,
  apiLimiter,
  externalOAuthLimiter,
  installLimiter,
  customerAuthLimiter,
  customerMetaSyncLimiter,
};
