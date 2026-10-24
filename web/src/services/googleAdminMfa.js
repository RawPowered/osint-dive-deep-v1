const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getGoogleOAuthConfig } = require('../config');

const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const OAUTH_INTENT_TTL_MS = 10 * 60 * 1000;

function createAuthorizationRequest(config = getGoogleOAuthConfig()) {
  assertConfigured(config);
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return {
    url: url.toString(),
    intent: { state, verifier, createdAt: Date.now() },
  };
}

function validateOAuthIntent(intent, returnedState, now = Date.now()) {
  if (!intent || !intent.state || !intent.verifier || !returnedState) return false;
  if (!Number.isFinite(Number(intent.createdAt)) || now - Number(intent.createdAt) > OAUTH_INTENT_TTL_MS) return false;
  const expected = Buffer.from(String(intent.state));
  const actual = Buffer.from(String(returnedState));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function exchangeGoogleCode(code, verifier, config = getGoogleOAuthConfig(), fetchImpl = fetch) {
  assertConfigured(config);
  if (!code || !verifier) throw oauthError('Google authorization response is incomplete');
  const token = await fetchJson(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      code: String(code),
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: String(verifier),
    }).toString(),
  }, fetchImpl);
  if (!token.access_token || String(token.token_type || '').toLowerCase() !== 'bearer') {
    throw oauthError('Google did not return a usable access token');
  }
  const profile = await fetchJson(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
  }, fetchImpl);
  const email = String(profile.email || '').trim().toLowerCase();
  const subject = String(profile.sub || '').trim();
  if (!subject || !email || profile.email_verified !== true) {
    throw oauthError('Google account email is not verified');
  }
  return { provider: 'google', subject, email };
}

async function bindGoogleIdentity(admin, identity, config = getGoogleOAuthConfig(), pool = null) {
  assertConfigured(config);
  if (!admin?.id || !['root', 'platform', 'tenant'].includes(admin.principalType)) {
    throw oauthError('Administrative identity is invalid');
  }
  const email = String(identity?.email || '').trim().toLowerCase();
  const subject = String(identity?.subject || '').trim();
  if (!email || !subject || !config.allowedEmails.includes(email)) {
    throw oauthError('This Google account is not allowed to access the admin area', 403);
  }
  let expectedEmail = String(admin.email || '').trim().toLowerCase();
  const rootBootstrap = !expectedEmail && admin.principalType === 'root' && config.allowedEmails.length === 1;
  if (rootBootstrap) expectedEmail = config.allowedEmails[0];
  if (!expectedEmail || expectedEmail !== email) {
    throw oauthError('Google account does not match the email assigned to this administrator', 403);
  }
  const p = pool || getPool();
  const conn = typeof p.getConnection === 'function' ? await p.getConnection() : p;
  const transactional = typeof conn.beginTransaction === 'function';
  try {
    if (transactional) await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT provider_subject AS providerSubject, email
       FROM admin_mfa_identities WHERE principal_type = ? AND principal_id = ? LIMIT 1`,
      [admin.principalType, admin.id]
    );
    const existing = rows[0];
    if (existing && (String(existing.providerSubject) !== subject || String(existing.email).toLowerCase() !== email)) {
      throw oauthError('A different Google identity is already bound to this administrator', 403);
    }
    if (rootBootstrap) {
      await conn.query('UPDATE admin_users SET email = ? WHERE id = ? AND email IS NULL', [email, admin.id]);
    }
    if (existing) {
      await conn.query(
        `UPDATE admin_mfa_identities SET last_verified_at = CURRENT_TIMESTAMP
         WHERE principal_type = ? AND principal_id = ?`,
        [admin.principalType, admin.id]
      );
    } else {
      await conn.query(
        `INSERT INTO admin_mfa_identities
           (principal_type, principal_id, provider, provider_subject, email, last_verified_at)
         VALUES (?, ?, 'google', ?, ?, CURRENT_TIMESTAMP)`,
        [admin.principalType, admin.id, subject, email]
      );
    }
    if (transactional) await conn.commit();
  } catch (error) {
    if (transactional) await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      throw oauthError('This Google identity is already bound to another administrator', 403);
    }
    throw error;
  } finally {
    if (conn !== p && typeof conn.release === 'function') conn.release();
  }
  return { provider: 'google', subject, email, enrolled: true };
}

async function fetchJson(url, options, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw oauthError('Google authentication service rejected the request', 502);
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw oauthError('Google authentication service timed out', 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertConfigured(config) {
  if (!config?.configured) {
    const detail = config?.errors?.length ? `: ${config.errors.join('; ')}` : '';
    throw oauthError(`Admin Google MFA is not configured${detail}`, 503);
  }
}

function oauthError(message, status = 401) {
  return Object.assign(new Error(message), { status, code: 'ADMIN_MFA_FAILED' });
}

module.exports = {
  GOOGLE_AUTHORIZATION_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  OAUTH_INTENT_TTL_MS,
  createAuthorizationRequest,
  validateOAuthIntent,
  exchangeGoogleCode,
  bindGoogleIdentity,
  oauthError,
};
