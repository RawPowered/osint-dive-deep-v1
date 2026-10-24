const crypto = require('crypto');
const { getSessionSecret } = require('../config');

function clean(value, max = 512) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function tokenSecret() {
  const configured = clean(process.env.DIVEDEEP_WORKER_TOKEN_SECRET, 4096);
  const fallback = clean(getSessionSecret(), 4096);
  const secret = configured || fallback;
  if (secret.length < 32) {
    throw Object.assign(new Error('DIVEDEEP_WORKER_TOKEN_SECRET or SESSION_SECRET must contain at least 32 characters'), {
      status: 503,
      code: 'DIVEDEEP_WORKER_TOKEN_SECRET_MISSING',
    });
  }
  return secret;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function unb64url(input) {
  return Buffer.from(String(input || ''), 'base64url');
}

function signSegment(segment, secret = tokenSecret()) {
  return crypto.createHmac('sha256', secret).update(segment).digest('base64url');
}

function hashOpaqueToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function issueOpaqueToken(bytes = 32) {
  return crypto.randomBytes(Math.max(24, Math.min(Number(bytes) || 32, 64))).toString('base64url');
}

function issueWorkerToken(claims, ttlSeconds = 900, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    typ: 'divedeep-worker',
    ver: 1,
    iat: issuedAt,
    exp: issuedAt + Math.max(60, Math.min(Number(ttlSeconds) || 900, 3600)),
    jti: crypto.randomUUID(),
    workerId: clean(claims.workerId, 64),
    jobId: clean(claims.jobId, 64),
    leaseId: clean(claims.leaseId, 64),
    executionId: clean(claims.executionId, 64),
    poolVersionId: clean(claims.poolVersionId, 64),
    scopes: Array.isArray(claims.scopes) ? claims.scopes.map((item) => clean(item, 96)).filter(Boolean).slice(0, 32) : [],
  };
  if (!payload.workerId || !payload.jobId || !payload.leaseId || !payload.executionId) {
    throw Object.assign(new Error('Worker-token claims are incomplete'), { status: 500, code: 'DIVEDEEP_WORKER_TOKEN_CLAIMS' });
  }
  const segment = b64url(JSON.stringify(payload));
  return `${segment}.${signSegment(segment)}`;
}

function verifyWorkerToken(token, options = {}) {
  const raw = clean(token, 8192);
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw Object.assign(new Error('Worker token is malformed'), { status: 401, code: 'DIVEDEEP_WORKER_TOKEN_INVALID' });
  }
  const expected = signSegment(parts[0]);
  const provided = parts[1];
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    throw Object.assign(new Error('Worker token signature is invalid'), { status: 401, code: 'DIVEDEEP_WORKER_TOKEN_INVALID' });
  }
  let payload;
  try { payload = JSON.parse(unb64url(parts[0]).toString('utf8')); }
  catch {
    throw Object.assign(new Error('Worker token payload is invalid'), { status: 401, code: 'DIVEDEEP_WORKER_TOKEN_INVALID' });
  }
  const now = Math.floor((options.now == null ? Date.now() : Number(options.now)) / 1000);
  if (payload.typ !== 'divedeep-worker' || payload.ver !== 1 || !payload.exp || payload.exp <= now) {
    throw Object.assign(new Error('Worker token is expired or invalid'), { status: 401, code: 'DIVEDEEP_WORKER_TOKEN_EXPIRED' });
  }
  if (payload.iat > now + 60) {
    throw Object.assign(new Error('Worker token was issued in the future'), { status: 401, code: 'DIVEDEEP_WORKER_TOKEN_INVALID' });
  }
  return payload;
}

function bearerToken(req) {
  const header = clean(req.get ? req.get('authorization') : req.headers?.authorization, 8192);
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

module.exports = {
  tokenSecret,
  hashOpaqueToken,
  issueOpaqueToken,
  issueWorkerToken,
  verifyWorkerToken,
  bearerToken,
};
