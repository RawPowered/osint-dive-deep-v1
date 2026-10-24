const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getInstanceIdentity } = require('../instanceIdentity');

const DEFAULT_TTL_MINUTES = 30;

function operatorCookieName() {
  return getInstanceIdentity().operatorCookieName;
}

function sessionTtlMinutes() {
  const value = Number(process.env.OPERATOR_SESSION_MINUTES) || DEFAULT_TTL_MINUTES;
  return Math.min(Math.max(Math.round(value), 5), 480);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function validToken(token) {
  return /^[A-Za-z0-9_-]{40,128}$/.test(String(token || ''));
}

function isAdministratorRole(role) {
  return new Set(['admin', 'administrator', 'super_admin', 'superadmin']).has(String(role || '').trim().toLowerCase());
}

async function createOperatorSession({ apiKeyId, user }, pool = null) {
  const p = pool || getPool();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionTtlMinutes() * 60 * 1000);
  await p.query(
    `INSERT INTO api_operator_sessions
       (token_hash,api_key_id,user_id,location_id,is_admin,expires_at,created_at,last_used_at)
     VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
    [tokenHash(token), apiKeyId || null, user.id, user.locationId,
      isAdministratorRole(user.role) ? 1 : 0, mysqlUtc(expiresAt)]
  );
  return {
    token,
    scheme:'Operator',
    headerName:'X-Operator-Token',
    expiresAt:expiresAt.toISOString(),
  };
}

async function verifyOperatorSession(token, pool = null) {
  if (!validToken(token)) return null;
  const p = pool || getPool();
  const hash = tokenHash(token);
  const [rows] = await p.query(
    `SELECT s.api_key_id AS apiKeyId,s.user_id AS userId,s.location_id AS locationId,
            s.is_admin AS isAdmin,s.expires_at AS expiresAt,u.username,u.crmUserName
     FROM api_operator_sessions s
     INNER JOIN users u ON u.id=s.user_id AND u.locationId=s.location_id
     WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP(3)
     LIMIT 1`,
    [hash]
  );
  if (!rows[0]) return null;
  await p.query('UPDATE api_operator_sessions SET last_used_at=UTC_TIMESTAMP(3) WHERE token_hash=?', [hash]);
  return {
    apiKeyId:rows[0].apiKeyId,
    userId:rows[0].userId,
    locationId:rows[0].locationId,
    username:rows[0].username,
    displayName:rows[0].crmUserName || rows[0].username,
    isAdmin:Boolean(rows[0].isAdmin),
    expiresAt:utcIso(rows[0].expiresAt),
  };
}

async function revokeOperatorSession(token, pool = null) {
  if (!validToken(token)) return false;
  const p = pool || getPool();
  const [result] = await p.query(
    `UPDATE api_operator_sessions SET revoked_at=UTC_TIMESTAMP(3)
     WHERE token_hash=? AND revoked_at IS NULL`,
    [tokenHash(token)]
  );
  return result.affectedRows > 0;
}

function extractOperatorToken(req) {
  const direct = String(req.get('x-operator-token') || '').trim();
  if (direct) return direct;
  const match = String(req.get('authorization') || '').match(/^Operator\s+(.+)$/i);
  if (match) return match[1].trim();
  const cookieName = operatorCookieName();
  return String(req.cookies?.[cookieName] || cookieValue(req, cookieName) || '').trim();
}

function setOperatorSessionCookie(res, token, expiresAt) {
  const expires = new Date(expiresAt);
  res.cookie(operatorCookieName(), token, {
    httpOnly:true,
    secure:true,
    sameSite:'none',
    path:getInstanceIdentity().publicApiBasePath,
    expires:Number.isNaN(expires.getTime()) ? undefined : expires,
  });
}

function clearOperatorSessionCookie(res) {
  res.clearCookie(operatorCookieName(), {
    httpOnly:true,
    secure:true,
    sameSite:'none',
    path:getInstanceIdentity().publicApiBasePath,
  });
}

function cookieValue(req, name) {
  const header = String(req.get?.('cookie') || '');
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(item.slice(separator + 1).trim()); }
    catch { return ''; }
  }
  return '';
}

function publicOperatorIdentity(session) {
  if (!session) return null;
  return {
    id:session.userId,
    locationId:session.locationId,
    username:session.username,
    displayName:session.displayName,
  };
}

async function requireOperatorSession(req, options = {}, pool = null) {
  const token = extractOperatorToken(req);
  if (!token) {
    throw Object.assign(new Error('Operator session required'), {
      status:401, code:'OPERATOR_SESSION_REQUIRED',
    });
  }
  const session = await verifyOperatorSession(token, pool);
  if (!session) {
    throw Object.assign(new Error('Operator session invalid or expired'), {
      status:401, code:'OPERATOR_SESSION_INVALID',
    });
  }
  if (req.apiKey?.id && String(session.apiKeyId) !== String(req.apiKey.id)) {
    throw Object.assign(new Error('Operator session is not valid for this API key'), {
      status:403, code:'OPERATOR_API_KEY_MISMATCH',
    });
  }
  if (options.locationId && String(session.locationId) !== String(options.locationId)) {
    throw Object.assign(new Error('Operator session is not valid for this location'), {
      status:403, code:'OPERATOR_LOCATION_MISMATCH',
    });
  }
  if (options.userId && String(session.userId) !== String(options.userId)) {
    throw Object.assign(new Error('Operator session is not valid for this user'), {
      status:403, code:'OPERATOR_USER_MISMATCH',
    });
  }
  req.operatorSession = session;
  return session;
}

function mysqlUtc(date) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function utcIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = {
  sessionTtlMinutes,
  tokenHash,
  validToken,
  isAdministratorRole,
  get OPERATOR_COOKIE_NAME() { return operatorCookieName(); },
  operatorCookieName,
  createOperatorSession,
  verifyOperatorSession,
  revokeOperatorSession,
  extractOperatorToken,
  setOperatorSessionCookie,
  clearOperatorSessionCookie,
  publicOperatorIdentity,
  requireOperatorSession,
};
