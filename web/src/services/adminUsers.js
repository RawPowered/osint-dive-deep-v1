const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool } = require('../db/pool');
const { getGoogleOAuthConfig } = require('../config');

const BCRYPT_ROUNDS = 12;

async function createAdmin({ username, password, email = null, role = 'admin' }, pool = null) {
  const p = pool || getPool();
  username = validUsername(username);
  password = validPassword(password);
  const [existing] = await p.query('SELECT COUNT(*) AS total FROM admin_users');
  if (Number(existing[0]?.total) > 0) {
    throw Object.assign(new Error('Root owner already exists; delegated administrators must be created through OWL'), { status: 409 });
  }
  const id = crypto.randomUUID();
  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await p.query(
    `INSERT INTO admin_users (id, username, email, password_hash, role)
     VALUES (?, ?, ?, ?, ?)`,
    [id, username, email, password_hash, 'admin']
  );
  return { id, username, email, role: 'root_owner', principalType: 'root' };
}

async function findByUsername(username, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT id, username, email, password_hash, role, created_at FROM admin_users WHERE username = ? LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

async function findById(id, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT id, username, email, role, created_at FROM admin_users WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function findDelegatedByUsername(username, pool = null) {
  const p = pool || getPool();
  const [platform] = await p.query(
    `SELECT id, username, email, password_hash, is_enabled, created_at
     FROM platform_administrators WHERE username = ? LIMIT 1`, [username]
  );
  if (platform[0]) return { ...platform[0], principalType: 'platform', role: 'platform_operator', apiKeyId: null };
  const [tenant] = await p.query(
    `SELECT id, api_key_id AS apiKeyId, username, email, password_hash, is_enabled, created_at
     FROM tenant_administrators WHERE username = ? LIMIT 1`, [username]
  );
  return tenant[0] ? { ...tenant[0], principalType: 'tenant', role: 'tenant_operator' } : null;
}

async function findPrincipalById(id, principalType = 'root', pool = null) {
  if (!principalType || principalType === 'root') {
    const root = await findById(id, pool);
    if (!root) return null;
    const type = root.role === 'admin' ? 'root' : 'viewer';
    return { ...root, principalType: type, role: type === 'root' ? 'root_owner' : 'legacy_viewer', apiKeyId: null };
  }
  const p = pool || getPool();
  const table = principalType === 'platform' ? 'platform_administrators'
    : principalType === 'tenant' ? 'tenant_administrators' : null;
  if (!table) return null;
  const columns = principalType === 'tenant' ? 'api_key_id AS apiKeyId,' : '';
  const [rows] = await p.query(
    `SELECT id, ${columns} username, email, is_enabled AS isEnabled, created_at AS createdAt
     FROM ${table} WHERE id = ? LIMIT 1`, [id]
  );
  if (!rows[0] || !rows[0].isEnabled) return null;
  return {
    ...rows[0], principalType,
    role: principalType === 'platform' ? 'platform_operator' : 'tenant_operator',
    apiKeyId: rows[0].apiKeyId || null,
  };
}

async function verifyPassword(username, password, pool = null) {
  const user = await findByUsername(username, pool);
  const principal = user
    ? { ...user, principalType: user.role === 'admin' ? 'root' : 'viewer',
      role: user.role === 'admin' ? 'root_owner' : 'legacy_viewer', apiKeyId: null, is_enabled: 1 }
    : await findDelegatedByUsername(username, pool);
  if (!principal || !principal.is_enabled) return null;
  const ok = await bcrypt.compare(password, principal.password_hash);
  if (!ok) return null;
  return {
    id: principal.id,
    username: principal.username,
    email: principal.email,
    role: principal.role,
    principalType: principal.principalType,
    apiKeyId: principal.apiKeyId || null,
  };
}

async function listDelegatedAdmins(actor, pool = null) {
  if (!actor || !['root', 'platform'].includes(actor.principalType || 'root')) return [];
  const p = pool || getPool();
  const output = [];
  if ((actor.principalType || 'root') === 'root') {
    const [platform] = await p.query(
      `SELECT a.id, a.username, a.email, a.is_enabled AS isEnabled, a.created_at AS createdAt,
              (m.principal_id IS NOT NULL) AS mfaEnrolled, m.last_verified_at AS mfaLastVerifiedAt
       FROM platform_administrators a
       LEFT JOIN admin_mfa_identities m ON m.principal_type = 'platform' AND m.principal_id = a.id
       ORDER BY a.username`
    );
    output.push(...platform.map((row) => ({
      ...row, isEnabled: Boolean(row.isEnabled), mfaEnrolled: Boolean(row.mfaEnrolled),
      accountType: 'platform', displayRole: 'System Steward',
    })));
  }
  const [tenant] = await p.query(
    `SELECT t.id, t.api_key_id AS apiKeyId, t.username, t.email, t.is_enabled AS isEnabled,
            t.created_at AS createdAt, k.name AS apiKeyName, k.key_prefix AS keyPrefix,
            (m.principal_id IS NOT NULL) AS mfaEnrolled, m.last_verified_at AS mfaLastVerifiedAt
     FROM tenant_administrators t INNER JOIN api_keys k ON k.id = t.api_key_id
     LEFT JOIN admin_mfa_identities m ON m.principal_type = 'tenant' AND m.principal_id = t.id
     ORDER BY k.name, t.username`
  );
  output.push(...tenant.map((row) => ({
    ...row, isEnabled: Boolean(row.isEnabled), mfaEnrolled: Boolean(row.mfaEnrolled),
    accountType: 'tenant', displayRole: 'Workspace Custodian',
  })));
  return output;
}

async function createDelegatedAdmin(input, actor, pool = null) {
  const actorType = actor?.principalType || 'root';
  const accountType = String(input.accountType || 'tenant');
  if (accountType === 'platform' && actorType !== 'root') throw forbidden('Only the root owner may create System Stewards');
  if (accountType === 'tenant' && !['root', 'platform'].includes(actorType)) throw forbidden('Tenant administrators cannot create administrative accounts');
  if (!['platform', 'tenant'].includes(accountType)) throw badRequest('Invalid administrative account type');
  const username = validUsername(input.username);
  const password = validPassword(input.password);
  const email = input.email ? String(input.email).trim().toLowerCase().slice(0, 255) : null;
  const mfaConfig = getGoogleOAuthConfig();
  if (mfaConfig.required && !email) throw badRequest('Email is required for Google MFA enrollment');
  if (mfaConfig.required && !mfaConfig.allowedEmails.includes(email)) {
    throw badRequest('Add this email to GOOGLE_OAUTH_ALLOWED_EMAILS before creating the administrator');
  }
  const apiKeyId = accountType === 'tenant' ? String(input.apiKeyId || '').trim() : null;
  if (accountType === 'tenant' && !apiKeyId) throw badRequest('apiKeyId is required for a tenant administrator');
  const p = pool || getPool();
  const checks = await Promise.all([
    p.query('SELECT id FROM admin_users WHERE username = ? LIMIT 1', [username]),
    p.query('SELECT id FROM platform_administrators WHERE username = ? LIMIT 1', [username]),
    p.query('SELECT id FROM tenant_administrators WHERE username = ? LIMIT 1', [username]),
    ...(email ? [
      p.query('SELECT id FROM admin_users WHERE email = ? LIMIT 1', [email]),
      p.query('SELECT id FROM platform_administrators WHERE email = ? LIMIT 1', [email]),
      p.query('SELECT id FROM tenant_administrators WHERE email = ? LIMIT 1', [email]),
    ] : []),
  ]);
  if (checks.some(([rows]) => rows[0])) throw Object.assign(new Error('Username or administrator email is already in use'), { status: 409 });
  if (apiKeyId) {
    const [keys] = await p.query('SELECT id FROM api_keys WHERE id = ? AND revoked_at IS NULL LIMIT 1', [apiKeyId]);
    if (!keys[0]) throw badRequest('Active API key not found');
  }
  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'INSERT INTO admin_login_names (username, principal_type, principal_id) VALUES (?, ?, ?)',
      [username, accountType, id]
    );
    if (accountType === 'platform') {
      await conn.query(
        `INSERT INTO platform_administrators (id, username, email, password_hash, created_by)
         VALUES (?, ?, ?, ?, ?)`, [id, username, email, passwordHash, actor.id]
      );
    } else {
      await conn.query(
        `INSERT INTO tenant_administrators (id, api_key_id, username, email, password_hash, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`, [id, apiKeyId, username, email, passwordHash, actor.id]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('Username is already in use'), { status: 409 });
    throw error;
  } finally {
    conn.release();
  }
  return {
    id, username, email, apiKeyId, accountType, mfaEnrolled: false,
    displayRole: accountType === 'platform' ? 'System Steward' : 'Workspace Custodian',
  };
}

async function listTenantLocationIds(apiKeyId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT DISTINCT i.location_id AS locationId
     FROM crm_integration_grants g
     INNER JOIN crm_integrations i ON i.id = g.integration_id AND i.is_enabled = 1
     WHERE g.api_key_id = ? AND (g.allow_read = 1 OR g.allow_import = 1 OR g.allow_manage_leads = 1)
     ORDER BY i.location_id`, [apiKeyId]
  );
  return rows.map((row) => String(row.locationId));
}

function validUsername(value) {
  const username = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) throw badRequest('Username must be 3-64 letters, numbers, dots, underscores, or hyphens');
  return username;
}

function validPassword(value) {
  const password = String(value || '');
  if (password.length < 12 || password.length > 128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw badRequest('Password must be 12-128 characters with upper, lower, and numeric characters');
  }
  return password;
}

function forbidden(message) { return Object.assign(new Error(message), { status: 403 }); }
function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }

async function countAdmins(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT COUNT(*) AS c FROM admin_users`);
  return Number(rows[0].c);
}

module.exports = {
  createAdmin,
  findByUsername,
  findById,
  findPrincipalById,
  verifyPassword,
  listDelegatedAdmins,
  createDelegatedAdmin,
  listTenantLocationIds,
  validPassword,
  countAdmins,
  BCRYPT_ROUNDS,
};
