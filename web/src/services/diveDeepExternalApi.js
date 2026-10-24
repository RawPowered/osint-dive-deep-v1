const crypto = require('crypto');
const net = require('net');
const { promises: dns } = require('dns');
const { encryptSecret, decryptSecret } = require('./secretBox');

const API_VERSION = '1';
const IDENTITY_TYPES = new Set(['customer', 'enterprise', 'integration']);
const AUTH_METHODS = new Set(['api_key', 'oauth_client']);
const ALL_SCOPES = new Set([
  'customer:read',
  'jobs:read',
  'reports:read',
  'enterprise:read',
  'coverage:read',
  'customers:read',
  'integrations:events:write',
  'webhooks:read',
  'webhooks:write',
]);
const TYPE_SCOPES = {
  customer: new Set(['customer:read', 'jobs:read', 'reports:read']),
  enterprise: new Set(['enterprise:read', 'coverage:read', 'customers:read', 'jobs:read', 'reports:read']),
  integration: new Set(['integrations:events:write', 'webhooks:read', 'webhooks:write']),
};
const EXTERNAL_EVENT_TYPES = new Set([
  'customer.lifecycle.requested',
  'customer.communication.requested',
  'integration.sync.completed',
  'report.requested',
]);
const WEBHOOK_EVENT_TYPES = new Set([
  ...EXTERNAL_EVENT_TYPES,
  'customer.lifecycle.updated',
  'job.status.updated',
  'removal.report.updated',
  'monitoring.report.updated',
  'webhook.test',
]);
const SENSITIVE_KEYS = /(evidence|artifact|storage|bucket|object|manifest|credential|password|secret|token|authorization|identity.?document|source.?url|destination|review.?note|confidence|image|photo|candidate|raw|attachment)/i;

function uuid() { return crypto.randomUUID(); }
function poolOrDefault(pool) { return pool || require('../db/pool').getPool(); }
function sha256(value) { return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex'); }
function clean(value, max = 255) { return String(value == null ? '' : value).trim().slice(0, max); }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function statusError(message, status = 400, code = 'DIVEDEEP_API_INVALID_REQUEST') {
  return Object.assign(new Error(message), { status, code });
}
function normalizeSlug(value) {
  const slug = clean(value, 96).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw statusError('Organization slug is required');
  return slug;
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}
function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function normalizeScopes(identityType, scopes) {
  if (!IDENTITY_TYPES.has(identityType)) throw statusError('Invalid service identity type');
  const requested = [...new Set((Array.isArray(scopes) ? scopes : []).map((scope) => clean(scope, 96)).filter(Boolean))];
  if (!requested.length) throw statusError('At least one scope is required');
  for (const scope of requested) {
    if (!ALL_SCOPES.has(scope) || !TYPE_SCOPES[identityType].has(scope)) {
      throw statusError(`Scope ${scope} is not permitted for ${identityType} identities`, 400, 'DIVEDEEP_SCOPE_NOT_ALLOWED');
    }
  }
  return requested.sort();
}
function secret(prefix) { return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`; }
function prefixOf(value) { return String(value || '').slice(0, 18); }
function safeEventPayload(value, path = '$') {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'string' && value.length > 2000) throw statusError(`Value at ${path} is too long`, 413, 'DIVEDEEP_EVENT_PAYLOAD_TOO_LARGE');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw statusError(`Array at ${path} is too large`, 413, 'DIVEDEEP_EVENT_PAYLOAD_TOO_LARGE');
    return value.map((item, index) => safeEventPayload(item, `${path}[${index}]`));
  }
  if (typeof value !== 'object') throw statusError(`Unsupported value at ${path}`);
  const output = {};
  const entries = Object.entries(value);
  if (entries.length > 100) throw statusError(`Object at ${path} has too many fields`, 413, 'DIVEDEEP_EVENT_PAYLOAD_TOO_LARGE');
  for (const [key, item] of entries) {
    if (SENSITIVE_KEYS.test(key)) throw statusError(`Sensitive field ${key} is not accepted`, 400, 'DIVEDEEP_SENSITIVE_FIELD_REJECTED');
    const normalizedKey = clean(key, 128);
    if (!normalizedKey || normalizedKey !== key || Object.prototype.hasOwnProperty.call(output, normalizedKey)) {
      throw statusError(`Invalid or duplicate field name at ${path}`, 400, 'DIVEDEEP_EVENT_FIELD_INVALID');
    }
    output[normalizedKey] = safeEventPayload(item, `${path}.${key}`);
  }
  return output;
}

function serializeOrganization(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    externalReference: row.external_reference || null,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function serializeIdentity(row) {
  return {
    id: row.id,
    name: row.name,
    identityType: row.identity_type,
    authMethod: row.auth_method,
    customerId: row.customer_id || null,
    organizationId: row.organization_id || null,
    keyPrefix: row.key_prefix || null,
    oauthClientId: row.oauth_client_id || null,
    scopes: parseJson(row.scopes_json, []),
    rateLimitPerMinute: Number(row.rate_limit_per_minute) || 120,
    status: row.status,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function createOrganization(input = {}, actorId = null, pool = null) {
  const p = poolOrDefault(pool);
  const id = uuid();
  const name = clean(input.name, 191);
  if (!name) throw statusError('Organization name is required');
  const slug = normalizeSlug(input.slug || name);
  await p.query(
    `INSERT INTO divedeep_organizations (id,slug,name,external_reference,status,created_by)
     VALUES (?,?,?,?,?,?)`,
    [id, slug, name, clean(input.externalReference, 191) || null, input.status === 'suspended' ? 'suspended' : 'active', clean(actorId, 128) || null]
  );
  return getOrganization(id, p);
}
async function getOrganization(id, pool = null) {
  const p = poolOrDefault(pool);
  const [rows] = await p.query('SELECT * FROM divedeep_organizations WHERE id=? LIMIT 1', [clean(id, 36)]);
  if (!rows[0]) throw statusError('Organization not found', 404, 'DIVEDEEP_ORGANIZATION_NOT_FOUND');
  return serializeOrganization(rows[0]);
}
async function listOrganizations(filters = {}, pool = null) {
  const p = poolOrDefault(pool);
  const params = [];
  let where = '';
  if (filters.status) { where = 'WHERE status=?'; params.push(clean(filters.status, 32)); }
  params.push(Math.min(Math.max(Number(filters.limit) || 200, 1), 500));
  const [rows] = await p.query(`SELECT * FROM divedeep_organizations ${where} ORDER BY updated_at DESC LIMIT ?`, params);
  return rows.map(serializeOrganization);
}
async function addOrganizationCustomer(organizationId, customerId, input = {}, actorId = null, pool = null) {
  const p = poolOrDefault(pool);
  const [organizations, customers] = await Promise.all([
    p.query('SELECT id,status FROM divedeep_organizations WHERE id=? LIMIT 1', [clean(organizationId, 36)]).then(([rows]) => rows),
    p.query('SELECT id,status FROM divedeep_customers WHERE id=? LIMIT 1', [clean(customerId, 36)]).then(([rows]) => rows),
  ]);
  if (!organizations[0]) throw statusError('Organization not found', 404, 'DIVEDEEP_ORGANIZATION_NOT_FOUND');
  if (!customers[0]) throw statusError('Customer not found', 404, 'DIVEDEEP_CUSTOMER_NOT_FOUND');
  await p.query(
    `INSERT INTO divedeep_organization_customers
      (organization_id,customer_id,external_reference,status,created_by)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE external_reference=VALUES(external_reference),status='active',updated_at=NOW(3)`,
    [clean(organizationId, 36), clean(customerId, 36), clean(input.externalReference, 191) || null, 'active', clean(actorId, 128) || null]
  );
  return { organizationId: clean(organizationId, 36), customerId: clean(customerId, 36), status: 'active', externalReference: clean(input.externalReference, 191) || null };
}
async function assertOrganizationCustomer(organizationId, customerId, pool = null) {
  const p = poolOrDefault(pool);
  const [rows] = await p.query(
    `SELECT organization_id,customer_id,external_reference,status
     FROM divedeep_organization_customers
     WHERE organization_id=? AND customer_id=? AND status='active' LIMIT 1`,
    [clean(organizationId, 36), clean(customerId, 36)]
  );
  if (!rows[0]) throw statusError('Customer is outside this organization', 403, 'DIVEDEEP_ORGANIZATION_SCOPE_DENIED');
  return rows[0];
}

async function createServiceIdentity(input = {}, actorId = null, pool = null) {
  const p = poolOrDefault(pool);
  const identityType = clean(input.identityType, 32);
  const authMethod = clean(input.authMethod || 'api_key', 32);
  if (!IDENTITY_TYPES.has(identityType)) throw statusError('Invalid service identity type');
  if (!AUTH_METHODS.has(authMethod)) throw statusError('Invalid authentication method');
  const customerId = clean(input.customerId, 36) || null;
  const organizationId = clean(input.organizationId, 36) || null;
  if (identityType === 'customer' && !customerId) throw statusError('Customer identities require customerId');
  if (identityType === 'enterprise' && !organizationId) throw statusError('Enterprise identities require organizationId');
  if (identityType === 'integration' && !customerId && !organizationId) throw statusError('Integration identities require customerId or organizationId');
  if (identityType === 'customer' && organizationId) throw statusError('Customer identities cannot carry organization scope');
  if (identityType === 'enterprise' && customerId) throw statusError('Enterprise identities cannot carry direct customer scope');
  if (customerId) {
    const [rows] = await p.query('SELECT id,status FROM divedeep_customers WHERE id=? LIMIT 1', [customerId]);
    if (!rows[0]) throw statusError('Customer not found', 404, 'DIVEDEEP_CUSTOMER_NOT_FOUND');
    if (rows[0].status === 'closed') throw statusError('Customer account is closed', 409, 'DIVEDEEP_CUSTOMER_INACTIVE');
  }
  if (organizationId) {
    const organization = await getOrganization(organizationId, p);
    if (organization.status !== 'active') throw statusError('Organization is not active', 409, 'DIVEDEEP_ORGANIZATION_INACTIVE');
  }
  if (organizationId && customerId) await assertOrganizationCustomer(organizationId, customerId, p);
  const scopes = normalizeScopes(identityType, input.scopes);
  const id = uuid();
  const name = clean(input.name, 191);
  if (!name) throw statusError('Service identity name is required');
  const rate = Math.min(Math.max(Number(input.rateLimitPerMinute) || (identityType === 'enterprise' ? 240 : identityType === 'integration' ? 240 : 120), 10), 300);
  let apiSecret = null;
  let oauthClientId = null;
  let oauthClientSecret = null;
  if (authMethod === 'api_key') apiSecret = secret('fidk');
  else {
    oauthClientId = `fidc_${crypto.randomBytes(18).toString('base64url')}`;
    oauthClientSecret = secret('fids');
  }
  await p.query(
    `INSERT INTO divedeep_service_identities
      (id,name,identity_type,auth_method,customer_id,organization_id,key_prefix,api_key_hash,oauth_client_id,oauth_client_secret_hash,scopes_json,rate_limit_per_minute,status,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active',?)`,
    [id, name, identityType, authMethod, customerId, organizationId,
      apiSecret ? prefixOf(apiSecret) : null, apiSecret ? sha256(apiSecret) : null,
      oauthClientId, oauthClientSecret ? sha256(oauthClientSecret) : null,
      JSON.stringify(scopes), rate, clean(actorId, 128) || null]
  );
  const identity = await getServiceIdentity(id, p);
  return { identity, apiKey: apiSecret, oauthClientId, oauthClientSecret };
}
async function getServiceIdentity(id, pool = null) {
  const p = poolOrDefault(pool);
  const [rows] = await p.query('SELECT * FROM divedeep_service_identities WHERE id=? LIMIT 1', [clean(id, 36)]);
  if (!rows[0]) throw statusError('Service identity not found', 404, 'DIVEDEEP_SERVICE_IDENTITY_NOT_FOUND');
  return serializeIdentity(rows[0]);
}
async function listServiceIdentities(filters = {}, pool = null) {
  const p = poolOrDefault(pool);
  const where = [];
  const params = [];
  if (filters.identityType) { where.push('identity_type=?'); params.push(clean(filters.identityType, 32)); }
  if (filters.customerId) { where.push('customer_id=?'); params.push(clean(filters.customerId, 36)); }
  if (filters.organizationId) { where.push('organization_id=?'); params.push(clean(filters.organizationId, 36)); }
  if (filters.status) { where.push('status=?'); params.push(clean(filters.status, 32)); }
  params.push(Math.min(Math.max(Number(filters.limit) || 200, 1), 500));
  const [rows] = await p.query(`SELECT * FROM divedeep_service_identities ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`, params);
  return rows.map(serializeIdentity);
}
async function revokeServiceIdentity(id, actorId = null, pool = null) {
  const p = poolOrDefault(pool);
  const [result] = await p.query(
    `UPDATE divedeep_service_identities SET status='revoked',revoked_at=NOW(3),revoked_by=?,updated_at=NOW(3)
     WHERE id=? AND status<>'revoked'`,
    [clean(actorId, 128) || null, clean(id, 36)]
  );
  await p.query('UPDATE divedeep_oauth_access_tokens SET revoked_at=NOW(3) WHERE service_identity_id=? AND revoked_at IS NULL', [clean(id, 36)]);
  if (!result.affectedRows) throw statusError('Service identity not found or already revoked', 404, 'DIVEDEEP_SERVICE_IDENTITY_NOT_FOUND');
  return { id: clean(id, 36), status: 'revoked' };
}

function authRow(row, tokenScopes = null) {
  const identity = serializeIdentity(row);
  if (tokenScopes) identity.scopes = tokenScopes.filter((scope) => identity.scopes.includes(scope));
  return identity;
}
async function validateIdentityBoundary(identity, pool = null) {
  const p = poolOrDefault(pool);
  if (identity.organizationId) {
    const [rows] = await p.query(`SELECT status FROM divedeep_organizations WHERE id=? LIMIT 1`, [identity.organizationId]);
    if (!rows[0] || rows[0].status !== 'active') return false;
  }
  if (identity.customerId) {
    const [rows] = await p.query(`SELECT status FROM divedeep_customers WHERE id=? LIMIT 1`, [identity.customerId]);
    if (!rows[0] || rows[0].status === 'closed') return false;
  }
  if (identity.organizationId && identity.customerId) {
    const [rows] = await p.query(`SELECT status FROM divedeep_organization_customers WHERE organization_id=? AND customer_id=? LIMIT 1`, [identity.organizationId, identity.customerId]);
    if (!rows[0] || rows[0].status !== 'active') return false;
  }
  return true;
}
async function verifyBearerCredential(bearer, pool = null) {
  const p = poolOrDefault(pool);
  const value = clean(bearer, 512);
  if (!value) return null;
  const hash = sha256(value);
  const [apiRows] = await p.query(
    `SELECT * FROM divedeep_service_identities
     WHERE api_key_hash=? AND auth_method='api_key' AND status='active' LIMIT 1`,
    [hash]
  );
  if (apiRows[0]) {
    const identity = authRow(apiRows[0]);
    if (!(await validateIdentityBoundary(identity, p))) return null;
    p.query('UPDATE divedeep_service_identities SET last_used_at=NOW(3) WHERE id=?', [apiRows[0].id]).catch(() => {});
    return identity;
  }
  const [tokenRows] = await p.query(
    `SELECT t.scopes_json token_scopes,t.id token_id,s.*
     FROM divedeep_oauth_access_tokens t
     INNER JOIN divedeep_service_identities s ON s.id=t.service_identity_id
     WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>NOW(3) AND s.status='active' LIMIT 1`,
    [hash]
  );
  if (!tokenRows[0]) return null;
  const identity = authRow(tokenRows[0], parseJson(tokenRows[0].token_scopes, []));
  if (!(await validateIdentityBoundary(identity, p))) return null;
  p.query('UPDATE divedeep_oauth_access_tokens SET last_used_at=NOW(3) WHERE id=?', [tokenRows[0].token_id]).catch(() => {});
  p.query('UPDATE divedeep_service_identities SET last_used_at=NOW(3) WHERE id=?', [tokenRows[0].id]).catch(() => {});
  return identity;
}
async function exchangeOAuthClient(input = {}, pool = null) {
  const p = poolOrDefault(pool);
  const clientId = clean(input.clientId, 96);
  const clientSecret = clean(input.clientSecret, 512);
  if (!clientId || !clientSecret) throw statusError('client_id and client_secret are required', 401, 'DIVEDEEP_OAUTH_INVALID_CLIENT');
  const [rows] = await p.query(
    `SELECT * FROM divedeep_service_identities
     WHERE oauth_client_id=? AND oauth_client_secret_hash=? AND auth_method='oauth_client' AND status='active' LIMIT 1`,
    [clientId, sha256(clientSecret)]
  );
  if (!rows[0]) throw statusError('Invalid OAuth client credentials', 401, 'DIVEDEEP_OAUTH_INVALID_CLIENT');
  const identity = authRow(rows[0]);
  if (!(await validateIdentityBoundary(identity, p))) throw statusError('OAuth client scope is inactive', 401, 'DIVEDEEP_OAUTH_INVALID_CLIENT');
  const available = parseJson(rows[0].scopes_json, []);
  const requested = clean(input.scope, 1000).split(/\s+/).filter(Boolean);
  const scopes = requested.length ? requested : available;
  if (scopes.some((scope) => !available.includes(scope))) throw statusError('Requested OAuth scope is not permitted', 400, 'DIVEDEEP_OAUTH_INVALID_SCOPE');
  const token = secret('fido');
  const expiresIn = 3600;
  await p.query(
    `INSERT INTO divedeep_oauth_access_tokens
      (id,service_identity_id,token_prefix,token_hash,scopes_json,expires_at)
     VALUES (?,?,?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND))`,
    [uuid(), rows[0].id, prefixOf(token), sha256(token), JSON.stringify(scopes), expiresIn]
  );
  return { accessToken: token, tokenType: 'Bearer', expiresIn, scope: scopes.join(' ') };
}

async function consumeRateLimit(identity, pool = null) {
  const p = poolOrDefault(pool);
  const limit = Math.min(Math.max(Number(identity.rateLimitPerMinute) || 120, 10), 300);
  const window = new Date();
  window.setUTCSeconds(0, 0);
  await p.query(
    `INSERT INTO divedeep_api_rate_windows (service_identity_id,window_started_at,request_count)
     VALUES (?,?,1)
     ON DUPLICATE KEY UPDATE request_count=request_count+1,updated_at=NOW(3)`,
    [identity.id, window]
  );
  const [rows] = await p.query(
    'SELECT request_count FROM divedeep_api_rate_windows WHERE service_identity_id=? AND window_started_at=? LIMIT 1',
    [identity.id, window]
  );
  const used = Number(rows[0]?.request_count) || 1;
  return { allowed: used <= limit, limit, remaining: Math.max(limit - used, 0), resetAt: new Date(window.getTime() + 60000) };
}

async function beginIdempotency(identityId, requestScope, idempotencyKey, body, pool = null) {
  const p = poolOrDefault(pool);
  const key = clean(idempotencyKey, 191);
  if (!key || key.length < 8) throw statusError('Idempotency-Key of at least 8 characters is required', 400, 'DIVEDEEP_IDEMPOTENCY_KEY_REQUIRED');
  const scope = clean(requestScope, 255);
  const requestHash = sha256(stableStringify(body == null ? null : body));
  const id = uuid();
  try {
    await p.query(
      `INSERT INTO divedeep_api_idempotency
        (id,service_identity_id,request_scope,idempotency_key,request_hash,state,expires_at)
       VALUES (?,?,?,?,?,'processing',DATE_ADD(NOW(3),INTERVAL 24 HOUR))`,
      [id, identityId, scope, key, requestHash]
    );
    return { id, replay: false, requestHash };
  } catch (error) {
    if (!String(error.code || '').includes('DUP')) throw error;
  }
  const [rows] = await p.query(
    `SELECT * FROM divedeep_api_idempotency
     WHERE service_identity_id=? AND request_scope=? AND idempotency_key=? LIMIT 1`,
    [identityId, scope, key]
  );
  const row = rows[0];
  if (!row) throw statusError('Idempotency record could not be resolved', 409, 'DIVEDEEP_IDEMPOTENCY_CONFLICT');
  if (row.request_hash !== requestHash) throw statusError('Idempotency-Key was already used with a different request', 409, 'DIVEDEEP_IDEMPOTENCY_MISMATCH');
  if (row.state === 'completed') return { id: row.id, replay: true, status: Number(row.response_status) || 200, response: parseJson(row.response_json, {}) };
  if (row.state === 'failed') {
    await p.query(`UPDATE divedeep_api_idempotency SET state='processing',response_status=NULL,response_json=NULL,updated_at=NOW(3) WHERE id=?`, [row.id]);
    return { id: row.id, replay: false, requestHash };
  }
  const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : Date.now();
  if (Date.now() - updatedAt > 5 * 60 * 1000) {
    await p.query(`UPDATE divedeep_api_idempotency SET state='processing',response_status=NULL,response_json=NULL,updated_at=NOW(3) WHERE id=?`, [row.id]);
    return { id: row.id, replay: false, requestHash, staleRecovery: true };
  }
  throw statusError('An identical request is already processing', 409, 'DIVEDEEP_IDEMPOTENCY_IN_PROGRESS');
}
function redactIdempotentResponse(value) {
  if (Array.isArray(value)) return value.map(redactIdempotentResponse);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(secret|token|api.?key|client.?secret|password|credential)/i.test(key)) continue;
    output[key] = redactIdempotentResponse(child);
  }
  return output;
}
async function completeIdempotency(id, status, response, pool = null) {
  const p = poolOrDefault(pool);
  const state = Number(status) >= 500 ? 'failed' : 'completed';
  const storedResponse = redactIdempotentResponse(response == null ? null : response);
  await p.query(
    `UPDATE divedeep_api_idempotency SET state=?,response_status=?,response_json=?,updated_at=NOW(3) WHERE id=?`,
    [state, Number(status) || 200, stableStringify(storedResponse).slice(0, 1024 * 1024), clean(id, 36)]
  );
}

function serializeJobSummary(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    packageId: row.package_id,
    packageVersion: Number(row.package_version) || 0,
    status: row.status,
    currentStage: row.current_gate || null,
    progressPercent: Number(row.progress_percent) || 0,
    sources: { total: Number(row.source_count) || 0, completed: Number(row.source_completed_count) || 0 },
    results: {
      candidates: Number(row.candidate_count) || 0,
      reviewed: Number(row.review_count) || 0,
      confirmed: Number(row.confirmed_count) || 0,
    },
    failureCode: row.status === 'failed' ? (row.last_error_code || 'JOB_FAILED') : null,
    requestedAt: iso(row.requested_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    updatedAt: iso(row.updated_at),
  };
}
async function listSafeJobs(customerId, filters = {}, pool = null) {
  const p = poolOrDefault(pool);
  const where = ['customer_id=?'];
  const params = [clean(customerId, 36)];
  if (filters.status) { where.push('status=?'); params.push(clean(filters.status, 32)); }
  params.push(Math.min(Math.max(Number(filters.limit) || 100, 1), 250));
  const [rows] = await p.query(
    `SELECT id,customer_id,package_id,package_version,status,current_gate,progress_percent,source_count,source_completed_count,candidate_count,review_count,confirmed_count,last_error_code,requested_at,started_at,completed_at,updated_at
     FROM divedeep_recon_jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    params
  );
  return rows.map(serializeJobSummary);
}
async function getSafeJob(customerId, jobId, pool = null) {
  const p = poolOrDefault(pool);
  const [rows] = await p.query(
    `SELECT id,customer_id,package_id,package_version,status,current_gate,progress_percent,source_count,source_completed_count,candidate_count,review_count,confirmed_count,last_error_code,requested_at,started_at,completed_at,updated_at
     FROM divedeep_recon_jobs WHERE id=? AND customer_id=? LIMIT 1`,
    [clean(jobId, 36), clean(customerId, 36)]
  );
  if (!rows[0]) throw statusError('Job not found', 404, 'DIVEDEEP_JOB_NOT_FOUND');
  return serializeJobSummary(rows[0]);
}
async function customerSummary(customerId, pool = null) {
  const p = poolOrDefault(pool);
  const [rows] = await p.query(
    `SELECT id,plan_tier,status,workflow_status,created_at,updated_at
     FROM divedeep_customers WHERE id=? LIMIT 1`,
    [clean(customerId, 36)]
  );
  if (!rows[0]) throw statusError('Customer not found', 404, 'DIVEDEEP_CUSTOMER_NOT_FOUND');
  const row = rows[0];
  return { id: row.id, tenantId: row.id, planTier: row.plan_tier, status: row.status, workflowStatus: row.workflow_status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
async function removalReport(customerId, pool = null) {
  const p = poolOrDefault(pool);
  const [rows] = await p.query(
    `SELECT id,case_id,delivery_method,provider,status,attempt_count,max_attempts,sent_at,acknowledged_at,completed_at,last_error_code,created_at,updated_at
     FROM divedeep_request_deliveries WHERE customer_id=? ORDER BY updated_at DESC LIMIT 1000`,
    [clean(customerId, 36)]
  );
  const statusCounts = {};
  const deliveries = rows.map((row) => {
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
    return {
      id: row.id,
      caseId: row.case_id,
      method: row.delivery_method,
      provider: row.provider || null,
      status: row.status,
      attempts: Number(row.attempt_count) || 0,
      maxAttempts: Number(row.max_attempts) || 0,
      failureCode: row.last_error_code || null,
      sentAt: iso(row.sent_at),
      acknowledgedAt: iso(row.acknowledged_at),
      completedAt: iso(row.completed_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  });
  return { customerId, generatedAt: new Date().toISOString(), totals: { deliveries: deliveries.length, byStatus: statusCounts }, deliveries };
}
async function monitoringReport(customerId, pool = null) {
  const p = poolOrDefault(pool);
  const [schedules, checks] = await Promise.all([
    p.query(
      `SELECT id,monitor_type,cadence,status,next_run_at,last_run_at,failure_count,created_at,updated_at
       FROM divedeep_monitoring_schedules WHERE customer_id=? ORDER BY updated_at DESC LIMIT 1000`,
      [clean(customerId, 36)]
    ).then(([rows]) => rows),
    p.query(
      `SELECT schedule_id,result,http_status,checked_at
       FROM divedeep_monitoring_checks WHERE customer_id=? ORDER BY checked_at DESC LIMIT 2000`,
      [clean(customerId, 36)]
    ).then(([rows]) => rows),
  ]);
  const latestBySchedule = new Map();
  const resultCounts = {};
  for (const check of checks) {
    resultCounts[check.result] = (resultCounts[check.result] || 0) + 1;
    if (!latestBySchedule.has(check.schedule_id)) latestBySchedule.set(check.schedule_id, check);
  }
  return {
    customerId,
    generatedAt: new Date().toISOString(),
    totals: { schedules: schedules.length, checks: checks.length, byResult: resultCounts },
    schedules: schedules.map((row) => {
      const last = latestBySchedule.get(row.id);
      return {
        id: row.id,
        monitorType: row.monitor_type,
        cadence: row.cadence,
        status: row.status,
        failureCount: Number(row.failure_count) || 0,
        lastResult: last?.result || null,
        lastHttpStatus: last?.http_status == null ? null : Number(last.http_status),
        lastCheckedAt: iso(last?.checked_at),
        nextRunAt: iso(row.next_run_at),
        lastRunAt: iso(row.last_run_at),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
    }),
  };
}

async function listEnterpriseCustomers(organizationId, filters = {}, pool = null) {
  const p = poolOrDefault(pool);
  const params = [clean(organizationId, 36)];
  let statusClause = '';
  if (filters.status) { statusClause = 'AND c.status=?'; params.push(clean(filters.status, 32)); }
  params.push(Math.min(Math.max(Number(filters.limit) || 250, 1), 500));
  const [rows] = await p.query(
    `SELECT c.id,c.plan_tier,c.status,c.workflow_status,c.created_at,c.updated_at,oc.external_reference
     FROM divedeep_organization_customers oc
     INNER JOIN divedeep_customers c ON c.id=oc.customer_id
     WHERE oc.organization_id=? AND oc.status='active' ${statusClause}
     ORDER BY c.updated_at DESC LIMIT ?`,
    params
  );
  return rows.map((row) => ({ customerId: row.id, tenantId: row.id, externalReference: row.external_reference || null, planTier: row.plan_tier, status: row.status, workflowStatus: row.workflow_status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }));
}
async function enterpriseCoverageSummary(organizationId, pool = null) {
  const p = poolOrDefault(pool);
  await getOrganization(organizationId, p);
  const customers = await listEnterpriseCustomers(organizationId, { limit: 500 }, p);
  const ids = customers.map((item) => item.customerId);
  if (!ids.length) return { organizationId, generatedAt: new Date().toISOString(), customers: { total: 0, byStatus: {}, byWorkflow: {} }, jobs: {}, findings: {}, removals: {}, monitoring: {} };
  const marks = ids.map(() => '?').join(',');
  const [jobRows, exposureRows, deliveryRows, monitoringRows] = await Promise.all([
    p.query(`SELECT status,COUNT(*) count FROM divedeep_recon_jobs WHERE customer_id IN (${marks}) GROUP BY status`, ids).then(([rows]) => rows),
    p.query(`SELECT status,COUNT(*) count FROM divedeep_exposures WHERE tenant_id IN (${marks}) GROUP BY status`, ids).then(([rows]) => rows),
    p.query(`SELECT status,COUNT(*) count FROM divedeep_request_deliveries WHERE customer_id IN (${marks}) GROUP BY status`, ids).then(([rows]) => rows),
    p.query(`SELECT status,COUNT(*) count FROM divedeep_monitoring_schedules WHERE customer_id IN (${marks}) GROUP BY status`, ids).then(([rows]) => rows),
  ]);
  const countMap = (rows) => Object.fromEntries(rows.map((row) => [row.status, Number(row.count) || 0]));
  const customerStatus = {};
  const workflowStatus = {};
  for (const customer of customers) {
    customerStatus[customer.status] = (customerStatus[customer.status] || 0) + 1;
    workflowStatus[customer.workflowStatus] = (workflowStatus[customer.workflowStatus] || 0) + 1;
  }
  return {
    organizationId,
    generatedAt: new Date().toISOString(),
    customers: { total: customers.length, byStatus: customerStatus, byWorkflow: workflowStatus },
    jobs: countMap(jobRows),
    findings: countMap(exposureRows),
    removals: countMap(deliveryRows),
    monitoring: countMap(monitoringRows),
  };
}
async function enterpriseRemovalReport(organizationId, pool = null) {
  const customers = await listEnterpriseCustomers(organizationId, { limit: 500 }, pool);
  const reports = [];
  for (const customer of customers) reports.push(await removalReport(customer.customerId, pool));
  return { organizationId, generatedAt: new Date().toISOString(), customers: reports.map((report) => ({ customerId: report.customerId, totals: report.totals })) };
}
async function enterpriseMonitoringReport(organizationId, pool = null) {
  const customers = await listEnterpriseCustomers(organizationId, { limit: 500 }, pool);
  const reports = [];
  for (const customer of customers) reports.push(await monitoringReport(customer.customerId, pool));
  return { organizationId, generatedAt: new Date().toISOString(), customers: reports.map((report) => ({ customerId: report.customerId, totals: report.totals })) };
}

function validateWebhookUrl(value) {
  let url;
  try { url = new URL(clean(value, 2048)); } catch { throw statusError('A valid webhook URL is required'); }
  if (url.protocol !== 'https:') throw statusError('Webhook endpoints must use HTTPS', 400, 'DIVEDEEP_WEBHOOK_HTTPS_REQUIRED');
  if (url.username || url.password) throw statusError('Webhook URLs cannot contain credentials');
  if (!url.hostname) throw statusError('Webhook endpoint hostname is required');
  return url.toString();
}
function isPublicIpAddress(address) {
  const version = net.isIP(String(address || ''));
  if (version === 4) {
    const parts = String(address).split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (version === 6) {
    const normalized = String(address).toLowerCase().split('%')[0];
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIpAddress(mapped[1]);
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
    if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return false;
    return true;
  }
  return false;
}
function blockedWebhookHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return !host
    || host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home')
    || host === 'metadata.google.internal';
}
async function assertPublicWebhookEndpoint(value, resolver = dns.lookup) {
  const endpoint = validateWebhookUrl(value);
  const url = new URL(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (blockedWebhookHostname(hostname)) throw statusError('Webhook endpoint hostname is not publicly routable', 400, 'DIVEDEEP_WEBHOOK_ENDPOINT_BLOCKED');
  if (net.isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw statusError('Webhook endpoint address is not publicly routable', 400, 'DIVEDEEP_WEBHOOK_ENDPOINT_BLOCKED');
    return endpoint;
  }
  let records;
  let timer;
  try {
    records = await Promise.race([
      resolver(hostname, { all: true, verbatim: true }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out')), 3000); }),
    ]);
  } catch {
    throw statusError('Webhook endpoint hostname could not be resolved', 400, 'DIVEDEEP_WEBHOOK_DNS_FAILED');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!Array.isArray(records) || !records.length || records.some((record) => !isPublicIpAddress(record.address))) {
    throw statusError('Webhook endpoint resolved to a non-public address', 400, 'DIVEDEEP_WEBHOOK_ENDPOINT_BLOCKED');
  }
  return endpoint;
}
function normalizeEventTypes(value) {
  const types = [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 96)).filter(Boolean))];
  if (!types.length) throw statusError('At least one webhook event type is required');
  for (const type of types) if (!WEBHOOK_EVENT_TYPES.has(type)) throw statusError(`Unsupported webhook event type ${type}`);
  return types.sort();
}
function serializeWebhook(row) {
  return { id: row.id, organizationId: row.organization_id || null, customerId: row.customer_id || null, name: row.name, endpointUrl: row.endpoint_url, eventTypes: parseJson(row.event_types_json, []), secretHint: row.secret_hint, status: row.status, lastSuccessAt: iso(row.last_success_at), lastFailureAt: iso(row.last_failure_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
async function createWebhookSubscription(input = {}, actorId = null, pool = null) {
  const p = poolOrDefault(pool);
  const organizationId = clean(input.organizationId, 36) || null;
  const customerId = clean(input.customerId, 36) || null;
  if (!organizationId && !customerId) throw statusError('Webhook subscription requires organizationId or customerId');
  if (organizationId && customerId) await assertOrganizationCustomer(organizationId, customerId, p);
  else if (organizationId) await getOrganization(organizationId, p);
  else await customerSummary(customerId, p);
  const endpointUrl = await assertPublicWebhookEndpoint(input.endpointUrl);
  const signingSecret = secret('fidwh');
  const id = uuid();
  await p.query(
    `INSERT INTO divedeep_webhook_subscriptions
      (id,organization_id,customer_id,name,endpoint_url,event_types_json,signing_secret_enc,secret_hint,status,created_by)
     VALUES (?,?,?,?,?,?,?,?, 'active',?)`,
    [id, organizationId, customerId, clean(input.name, 191) || 'DiveDeep webhook', endpointUrl, JSON.stringify(normalizeEventTypes(input.eventTypes)), encryptSecret(signingSecret), signingSecret.slice(-8), clean(actorId, 128) || null]
  );
  const [rows] = await p.query('SELECT * FROM divedeep_webhook_subscriptions WHERE id=? LIMIT 1', [id]);
  return { subscription: serializeWebhook(rows[0]), signingSecret };
}
async function listWebhookSubscriptions(filters = {}, pool = null) {
  const p = poolOrDefault(pool);
  const where = [];
  const params = [];
  if (filters.organizationId) { where.push('organization_id=?'); params.push(clean(filters.organizationId, 36)); }
  if (filters.customerId) { where.push('customer_id=?'); params.push(clean(filters.customerId, 36)); }
  if (filters.status) { where.push('status=?'); params.push(clean(filters.status, 32)); }
  params.push(Math.min(Math.max(Number(filters.limit) || 200, 1), 500));
  const [rows] = await p.query(`SELECT * FROM divedeep_webhook_subscriptions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`, params);
  return rows.map(serializeWebhook);
}
async function enqueueWebhookForSubscription(subscriptionId, input = {}, pool = null) {
  const p = poolOrDefault(pool);
  const eventType = clean(input.eventType, 96);
  if (!WEBHOOK_EVENT_TYPES.has(eventType)) throw statusError('Unsupported webhook event type');
  const [rows] = await p.query(`SELECT * FROM divedeep_webhook_subscriptions WHERE id=? AND status='active' LIMIT 1`, [clean(subscriptionId, 36)]);
  const subscription = rows[0];
  if (!subscription) throw statusError('Webhook subscription not found', 404, 'DIVEDEEP_WEBHOOK_NOT_FOUND');
  const organizationId = subscription.organization_id || null;
  const customerId = subscription.customer_id || null;
  const eventId = clean(input.eventId, 36) || uuid();
  const payload = safeEventPayload(input.payload || {});
  const body = { id: eventId, type: eventType, apiVersion: API_VERSION, createdAt: new Date().toISOString(), organizationId, customerId, data: payload };
  const serialized = stableStringify(body);
  try {
    await p.query(
      `INSERT INTO divedeep_webhook_deliveries
        (id,subscription_id,event_id,event_type,organization_id,customer_id,payload_json,payload_hash,status)
       VALUES (?,?,?,?,?,?,?,?, 'queued')`,
      [uuid(), subscription.id, eventId, eventType, organizationId, customerId, serialized, sha256(serialized)]
    );
  } catch (error) {
    if (!String(error.code || '').includes('DUP')) throw error;
  }
  return { eventId, queued: 1, subscriptionId: subscription.id };
}

async function enqueueWebhookEvent(input = {}, pool = null) {
  const p = poolOrDefault(pool);
  const eventType = clean(input.eventType, 96);
  if (!WEBHOOK_EVENT_TYPES.has(eventType)) throw statusError('Unsupported webhook event type');
  const organizationId = clean(input.organizationId, 36) || null;
  const customerId = clean(input.customerId, 36) || null;
  const payload = safeEventPayload(input.payload || {});
  const eventId = clean(input.eventId, 36) || uuid();
  let subscriptionSql = `SELECT * FROM divedeep_webhook_subscriptions WHERE status='active'`;
  let subscriptionParams = [];
  if (organizationId && customerId) {
    subscriptionSql += ` AND ((organization_id=? AND (customer_id IS NULL OR customer_id=?)) OR (organization_id IS NULL AND customer_id=?))`;
    subscriptionParams = [organizationId, customerId, customerId];
  } else if (organizationId) {
    subscriptionSql += ` AND organization_id=? AND customer_id IS NULL`;
    subscriptionParams = [organizationId];
  } else if (customerId) {
    subscriptionSql += ` AND organization_id IS NULL AND customer_id=?`;
    subscriptionParams = [customerId];
  } else {
    return { eventId, queued: 0 };
  }
  const [rows] = await p.query(subscriptionSql, subscriptionParams);
  let queued = 0;
  for (const subscription of rows) {
    const types = parseJson(subscription.event_types_json, []);
    if (!types.includes(eventType)) continue;
    const body = { id: eventId, type: eventType, apiVersion: API_VERSION, createdAt: new Date().toISOString(), organizationId, customerId, data: payload };
    try {
      await p.query(
        `INSERT INTO divedeep_webhook_deliveries
          (id,subscription_id,event_id,event_type,organization_id,customer_id,payload_json,payload_hash,status)
         VALUES (?,?,?,?,?,?,?,?, 'queued')`,
        [uuid(), subscription.id, eventId, eventType, organizationId, customerId, stableStringify(body), sha256(stableStringify(body))]
      );
      queued += 1;
    } catch (error) {
      if (!String(error.code || '').includes('DUP')) throw error;
    }
  }
  return { eventId, queued };
}
async function acceptExternalEvent(identity, input = {}, pool = null) {
  const p = poolOrDefault(pool);
  const eventType = clean(input.eventType, 96);
  if (!EXTERNAL_EVENT_TYPES.has(eventType)) throw statusError('Unsupported external event type');
  let customerId = clean(input.customerId, 36) || identity.customerId || null;
  const organizationId = identity.organizationId || null;
  if (identity.customerId && customerId !== identity.customerId) throw statusError('Customer is outside this service identity', 403, 'DIVEDEEP_TENANT_SCOPE_DENIED');
  if (organizationId && customerId) await assertOrganizationCustomer(organizationId, customerId, p);
  if (!customerId && !organizationId) throw statusError('Event scope could not be resolved');
  const payload = safeEventPayload(input.data || {});
  const externalEventId = clean(input.externalEventId, 191) || null;
  const id = uuid();
  try {
    await p.query(
      `INSERT INTO divedeep_external_api_events
        (id,service_identity_id,organization_id,customer_id,event_type,external_event_id,payload_json,payload_hash)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, identity.id, organizationId, customerId, eventType, externalEventId, stableStringify(payload), sha256(stableStringify(payload))]
    );
  } catch (error) {
    if (String(error.code || '').includes('DUP')) {
      const [rows] = await p.query('SELECT id FROM divedeep_external_api_events WHERE service_identity_id=? AND external_event_id=? LIMIT 1', [identity.id, externalEventId]);
      return { id: rows[0]?.id || null, accepted: true, duplicate: true, webhookDeliveriesQueued: 0 };
    }
    throw error;
  }
  const webhook = await enqueueWebhookEvent({ eventId: id, eventType, organizationId, customerId, payload }, p);
  return { id, accepted: true, duplicate: false, webhookDeliveriesQueued: webhook.queued };
}

function serializeWebhookDelivery(row) {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    eventType: row.event_type,
    organizationId: row.organization_id || null,
    customerId: row.customer_id || null,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    maxAttempts: Number(row.max_attempts) || 0,
    responseStatus: row.response_status == null ? null : Number(row.response_status),
    lastErrorCode: row.last_error_code || null,
    deliveredAt: iso(row.delivered_at),
    availableAt: iso(row.available_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
async function listWebhookDeliveries(filters = {}, pool = null) {
  const p = poolOrDefault(pool);
  const where = [];
  const params = [];
  if (filters.subscriptionId) { where.push('subscription_id=?'); params.push(clean(filters.subscriptionId, 36)); }
  if (filters.organizationId) { where.push('organization_id=?'); params.push(clean(filters.organizationId, 36)); }
  if (filters.customerId) { where.push('customer_id=?'); params.push(clean(filters.customerId, 36)); }
  if (filters.status) { where.push('status=?'); params.push(clean(filters.status, 32)); }
  params.push(Math.min(Math.max(Number(filters.limit) || 200, 1), 500));
  const [rows] = await p.query(
    `SELECT id,subscription_id,event_id,event_type,organization_id,customer_id,status,attempts,max_attempts,response_status,last_error_code,delivered_at,available_at,created_at,updated_at
     FROM divedeep_webhook_deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT ?`,
    params
  );
  return rows.map(serializeWebhookDelivery);
}
async function replayWebhookDelivery(deliveryId, pool = null) {
  const p = poolOrDefault(pool);
  const [result] = await p.query(
    `UPDATE divedeep_webhook_deliveries
     SET status='retry',attempts=0,available_at=NOW(3),locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=NOW(3)
     WHERE id=? AND status='dead_letter'`,
    [clean(deliveryId, 36)]
  );
  if (!result.affectedRows) throw statusError('Dead-letter webhook delivery not found', 404, 'DIVEDEEP_WEBHOOK_DELIVERY_NOT_FOUND');
  return { id: clean(deliveryId, 36), status: 'retry' };
}
function webhookSignature(signingSecret, timestamp, body) {
  return `v1=${crypto.createHmac('sha256', String(signingSecret || '')).update(`${timestamp}.${body}`).digest('hex')}`;
}
function retryDelay(attempt) { return Math.min(15 * 60, Math.max(15, 15 * (2 ** Math.max(attempt - 1, 0)))); }
async function claimWebhookDeliveries(limit = 50, workerId = null, pool = null) {
  const p = poolOrDefault(pool);
  const id = clean(workerId, 128) || `api-${process.pid}`;
  await p.query(
    `UPDATE divedeep_webhook_deliveries SET status='retry',locked_at=NULL,locked_by=NULL,available_at=NOW(3)
     WHERE status='processing' AND locked_at<DATE_SUB(NOW(3),INTERVAL 10 MINUTE)`
  );
  const [rows] = await p.query(
    `SELECT id FROM divedeep_webhook_deliveries
     WHERE status IN ('queued','retry') AND available_at<=NOW(3)
     ORDER BY created_at ASC LIMIT ?`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  const claimed = [];
  for (const row of rows) {
    const [result] = await p.query(
      `UPDATE divedeep_webhook_deliveries SET status='processing',locked_at=NOW(3),locked_by=?,attempts=attempts+1
       WHERE id=? AND status IN ('queued','retry')`,
      [id, row.id]
    );
    if (result.affectedRows) claimed.push(row.id);
  }
  return claimed;
}
function recordWebhookTelemetry(delivery, outcome, statusCode = 0, errorClass = 'none') {
  try {
    const { recordEvent } = require('./sentinel');
    recordEvent({
      method: 'POST',
      path: '/divedeep/signed-webhook',
      status_code: statusCode,
      surface: 'divedeep',
      actor_type: 'system',
      actor_id: delivery.subscription_id,
      action: 'divedeep.webhook.deliver',
      entity_type: 'divedeep_webhook_delivery',
      entity_id: delivery.id,
      outcome,
      error_class: errorClass,
    });
  } catch { /* telemetry must never block queue progress */ }
}
async function deliverWebhook(id, pool = null) {
  const p = poolOrDefault(pool);
  const [rows] = await p.query(
    `SELECT d.*,s.endpoint_url,s.signing_secret_enc
     FROM divedeep_webhook_deliveries d
     INNER JOIN divedeep_webhook_subscriptions s ON s.id=d.subscription_id
     WHERE d.id=? LIMIT 1`,
    [clean(id, 36)]
  );
  const delivery = rows[0];
  if (!delivery) return { id, status: 'missing' };
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = webhookSignature(decryptSecret(delivery.signing_secret_enc), timestamp, delivery.payload_json);
  try {
    const endpointUrl = await assertPublicWebhookEndpoint(delivery.endpoint_url);
    const response = await fetch(endpointUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'DiveDeep-Webhooks/1.0',
        'x-divedeep-api-version': API_VERSION,
        'x-divedeep-event-id': delivery.event_id,
        'x-divedeep-event-type': delivery.event_type,
        'x-divedeep-timestamp': timestamp,
        'x-divedeep-signature': signature,
      },
      body: delivery.payload_json,
      signal: AbortSignal.timeout(15000),
    });
    const responseFingerprint = [
      String(response.status),
      String(response.headers.get('content-type') || ''),
      String(response.headers.get('content-length') || ''),
    ].join('\n');
    if (response.body && typeof response.body.cancel === 'function') {
      try { await response.body.cancel(); } catch { /* endpoint response bodies are intentionally discarded */ }
    }
    if (!response.ok) throw Object.assign(new Error(`Webhook endpoint returned HTTP ${response.status}`), { code: 'WEBHOOK_HTTP_ERROR', responseStatus: response.status });
    await p.query(
      `UPDATE divedeep_webhook_deliveries SET status='completed',response_status=?,response_hash=?,delivered_at=NOW(3),locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=NOW(3) WHERE id=?`,
      [response.status, sha256(responseFingerprint), delivery.id]
    );
    await p.query(`UPDATE divedeep_webhook_subscriptions SET last_success_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [delivery.subscription_id]);
    recordWebhookTelemetry(delivery, 'success', response.status, 'none');
    return { id: delivery.id, status: 'completed', responseStatus: response.status };
  } catch (error) {
    const dead = Number(delivery.attempts) >= Number(delivery.max_attempts);
    await p.query(
      `UPDATE divedeep_webhook_deliveries SET status=?,available_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),response_status=?,last_error_code=?,last_error_message=?,locked_at=NULL,locked_by=NULL,updated_at=NOW(3) WHERE id=?`,
      [dead ? 'dead_letter' : 'retry', retryDelay(Number(delivery.attempts)), error.responseStatus || null, clean(error.code || error.name || 'WEBHOOK_DELIVERY_FAILED', 96), clean(error.message, 1000), delivery.id]
    );
    await p.query(`UPDATE divedeep_webhook_subscriptions SET last_failure_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [delivery.subscription_id]);
    recordWebhookTelemetry(delivery, 'failure', error.responseStatus || 0, 'server');
    return { id: delivery.id, status: dead ? 'dead_letter' : 'retry', errorCode: error.code || error.name || 'WEBHOOK_DELIVERY_FAILED' };
  }
}
async function runWebhookSweep(options = {}, pool = null) {
  const p = poolOrDefault(pool);
  const ids = await claimWebhookDeliveries(options.limit || 50, options.workerId, p);
  const results = [];
  for (const id of ids) results.push(await deliverWebhook(id, p));
  return { claimed: ids.length, results };
}
async function purgeExternalApiState(pool = null) {
  const p = poolOrDefault(pool);
  const results = await Promise.all([
    p.query(`DELETE FROM divedeep_oauth_access_tokens WHERE expires_at<DATE_SUB(NOW(3),INTERVAL 24 HOUR) OR revoked_at<DATE_SUB(NOW(3),INTERVAL 30 DAY)`),
    p.query(`DELETE FROM divedeep_api_idempotency WHERE expires_at<NOW(3)`),
    p.query(`DELETE FROM divedeep_api_rate_windows WHERE window_started_at<DATE_SUB(NOW(),INTERVAL 2 DAY)`),
  ]);
  return { oauthTokens: results[0][0].affectedRows || 0, idempotency: results[1][0].affectedRows || 0, rateWindows: results[2][0].affectedRows || 0 };
}

module.exports = {
  API_VERSION,
  ALL_SCOPES,
  TYPE_SCOPES,
  EXTERNAL_EVENT_TYPES,
  WEBHOOK_EVENT_TYPES,
  SENSITIVE_KEYS,
  stableStringify,
  safeEventPayload,
  validateWebhookUrl,
  isPublicIpAddress,
  blockedWebhookHostname,
  assertPublicWebhookEndpoint,
  normalizeScopes,
  createOrganization,
  getOrganization,
  listOrganizations,
  addOrganizationCustomer,
  assertOrganizationCustomer,
  createServiceIdentity,
  getServiceIdentity,
  listServiceIdentities,
  revokeServiceIdentity,
  verifyBearerCredential,
  validateIdentityBoundary,
  exchangeOAuthClient,
  consumeRateLimit,
  beginIdempotency,
  completeIdempotency,
  redactIdempotentResponse,
  serializeJobSummary,
  listSafeJobs,
  getSafeJob,
  customerSummary,
  removalReport,
  monitoringReport,
  listEnterpriseCustomers,
  enterpriseCoverageSummary,
  enterpriseRemovalReport,
  enterpriseMonitoringReport,
  createWebhookSubscription,
  listWebhookSubscriptions,
  enqueueWebhookForSubscription,
  listWebhookDeliveries,
  replayWebhookDelivery,
  enqueueWebhookEvent,
  acceptExternalEvent,
  webhookSignature,
  claimWebhookDeliveries,
  deliverWebhook,
  runWebhookSweep,
  purgeExternalApiState,
};
