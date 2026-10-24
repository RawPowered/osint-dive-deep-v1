const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { encryptSecret, decryptSecret } = require('./secretBox');

const PROVIDER_RE = /^[a-z][a-z0-9_-]{1,62}$/;
const PERMISSIONS = new Set(['allow_read', 'allow_import', 'allow_manage_leads']);
const LEADCONNECTOR_PROVIDER = 'leadconnector-pit';
const LEADCONNECTOR_ORIGIN = 'https://services.leadconnectorhq.com';
const PIT_ROTATION_DAYS = 90;

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw Object.assign(new Error('baseUrl must be a valid URL'), { status: 400 });
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw Object.assign(new Error('baseUrl must use http or https'), { status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error('baseUrl must not contain credentials'), { status: 400 });
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeProvider(value) {
  const provider = String(value || 'generic').trim().toLowerCase();
  if (!PROVIDER_RE.test(provider)) {
    throw Object.assign(new Error('Invalid CRM provider'), { status: 400 });
  }
  return provider;
}

function normalizeCredential(value, authScheme = 'Bearer') {
  let credential = String(value == null ? '' : value).trim();
  if (/^bearer$/i.test(authScheme) && /^bearer\s+/i.test(credential)) {
    credential = credential.replace(/^bearer\s+/i, '').trim();
  }
  return credential;
}

function validateProviderBaseUrl(provider, value) {
  const baseUrl = validateBaseUrl(value);
  if (provider === LEADCONNECTOR_PROVIDER) {
    const url = new URL(baseUrl);
    if (url.origin !== LEADCONNECTOR_ORIGIN || (url.pathname !== '/' && url.pathname !== '')) {
      throw Object.assign(new Error(`LeadConnector PIT integrations must use ${LEADCONNECTOR_ORIGIN}`), { status: 400 });
    }
  }
  return baseUrl;
}

function publicIntegration(row) {
  if (!row) return null;
  const credentialUpdatedAt = row.credential_updated_at || null;
  const rotationDueAt = credentialUpdatedAt
    ? new Date(new Date(credentialUpdatedAt).getTime() + PIT_ROTATION_DAYS * 86400000).toISOString()
    : null;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    locationId: row.location_id,
    baseUrl: row.base_url,
    authScheme: row.auth_scheme,
    config: parseJson(row.config_json),
    isEnabled: Boolean(row.is_enabled),
    hasCredential: Boolean(row.credential_enc),
    credentialType: row.provider === LEADCONNECTOR_PROVIDER ? 'private_integration_token' : 'upstream_token',
    credentialUpdatedAt,
    rotationDueAt,
    rotationStatus: rotationDueAt
      ? (new Date(rotationDueAt) <= new Date() ? 'due' : new Date(rotationDueAt).getTime() - Date.now() <= 14 * 86400000 ? 'soon' : 'current')
      : 'unknown',
    lastCursor: row.last_cursor || null,
    lastSyncAt: row.last_sync_at || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function listIntegrations(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT id, name, provider, location_id, base_url, credential_enc, credential_updated_at, auth_scheme,
            config_json, is_enabled, last_cursor, last_sync_at, created_by, created_at, updated_at
     FROM crm_integrations ORDER BY name ASC`
  );
  return rows.map(publicIntegration);
}

async function getIntegrationById(id, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM crm_integrations WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function createIntegration(input, pool = null) {
  const p = pool || getPool();
  const name = String(input.name || '').trim();
  const locationId = String(input.locationId || input.location_id || '').trim();
  if (!name || !locationId) {
    throw Object.assign(new Error('name and locationId are required'), { status: 400 });
  }
  const id = crypto.randomUUID();
  const provider = normalizeProvider(input.provider);
  const baseUrl = validateProviderBaseUrl(provider, input.baseUrl || input.base_url);
  const authScheme = provider === LEADCONNECTOR_PROVIDER
    ? 'Bearer'
    : String(input.authScheme || input.auth_scheme || 'Bearer').trim().slice(0, 32);
  const credential = normalizeCredential(input.credential, authScheme);
  const config = parseJson(input.config || input.config_json);
  if (provider === LEADCONNECTOR_PROVIDER && !credential) {
    throw Object.assign(new Error('Private Integration Token is required'), { status: 400 });
  }

  await p.query(
    `INSERT INTO crm_integrations
       (id, name, provider, location_id, base_url, credential_enc, credential_updated_at,
        auth_scheme, config_json, is_enabled, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      name.slice(0, 128),
      provider,
      locationId.slice(0, 128),
      baseUrl,
      credential ? encryptSecret(credential) : null,
      credential ? new Date() : null,
      authScheme || 'Bearer',
      JSON.stringify(config),
      input.isEnabled === false || input.is_enabled === false ? 0 : 1,
      input.createdBy || null,
    ]
  );
  return publicIntegration(await getIntegrationById(id, p));
}

async function updateIntegration(id, input, pool = null) {
  const p = pool || getPool();
  const existing = await getIntegrationById(id, p);
  if (!existing) throw Object.assign(new Error('CRM integration not found'), { status: 404 });

  const name = input.name == null ? existing.name : String(input.name).trim();
  const provider = input.provider == null ? existing.provider : normalizeProvider(input.provider);
  const locationId =
    input.locationId == null && input.location_id == null
      ? existing.location_id
      : String(input.locationId || input.location_id).trim();
  const baseUrl =
    input.baseUrl == null && input.base_url == null
      ? validateProviderBaseUrl(provider, existing.base_url)
      : validateProviderBaseUrl(provider, input.baseUrl || input.base_url);
  const authScheme =
    provider === LEADCONNECTOR_PROVIDER
      ? 'Bearer'
      : input.authScheme == null && input.auth_scheme == null
      ? existing.auth_scheme
      : String(input.authScheme || input.auth_scheme || 'Bearer').trim().slice(0, 32);
  const config =
    input.config == null && input.config_json == null
      ? existing.config_json
      : JSON.stringify(parseJson(input.config || input.config_json));
  const enabled =
    input.isEnabled == null && input.is_enabled == null
      ? existing.is_enabled
      : input.isEnabled === false || input.is_enabled === false
        ? 0
        : 1;
  let credentialEnc = existing.credential_enc;
  let credentialChanged = false;
  if (input.credential != null && String(input.credential).trim()) {
    credentialEnc = encryptSecret(normalizeCredential(input.credential, authScheme));
    credentialChanged = true;
  }
  if (provider === LEADCONNECTOR_PROVIDER && !credentialEnc) {
    throw Object.assign(new Error('Private Integration Token is required'), { status: 400 });
  }

  if (!name || !locationId) {
    throw Object.assign(new Error('name and locationId are required'), { status: 400 });
  }
  await p.query(
    `UPDATE crm_integrations SET name = ?, provider = ?, location_id = ?, base_url = ?,
       credential_enc = ?, auth_scheme = ?, config_json = ?, is_enabled = ?,
       credential_updated_at = IF(? = 1, CURRENT_TIMESTAMP, credential_updated_at),
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [name.slice(0, 128), provider, locationId.slice(0, 128), baseUrl, credentialEnc,
      authScheme || 'Bearer', config, enabled, credentialChanged ? 1 : 0, id]
  );
  return publicIntegration(await getIntegrationById(id, p));
}

async function deleteIntegration(id, pool = null) {
  const p = pool || getPool();
  const [activeRuns] = await p.query(
    `SELECT id FROM crm_import_runs WHERE integration_id = ? AND status IN ('queued', 'running') LIMIT 1`,
    [id]
  );
  if (activeRuns[0]) {
    throw Object.assign(new Error('Cannot delete an integration with an active import'), { status: 409 });
  }
  const [dependent] = await p.query(
    `SELECT
       (SELECT COUNT(*) FROM lead_source_links WHERE integration_id = ?) AS source_count,
       (SELECT COUNT(*) FROM crm_import_runs WHERE integration_id = ?) AS run_count`,
    [id, id]
  );
  if (Number(dependent[0].source_count) || Number(dependent[0].run_count)) {
    const [result] = await p.query(
      `UPDATE crm_integrations SET is_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );
    return result.affectedRows > 0;
  }
  await p.query('DELETE FROM crm_integration_grants WHERE integration_id = ?', [id]);
  const [result] = await p.query('DELETE FROM crm_integrations WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

async function upsertGrant(integrationId, input, pool = null) {
  const p = pool || getPool();
  const apiKeyId = String(input.apiKeyId || input.api_key_id || '').trim();
  if (!apiKeyId) throw Object.assign(new Error('apiKeyId is required'), { status: 400 });
  const [keys] = await p.query('SELECT id FROM api_keys WHERE id = ? AND revoked_at IS NULL LIMIT 1', [apiKeyId]);
  if (!keys[0]) throw Object.assign(new Error('Active API key not found'), { status: 404 });
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO crm_integration_grants
       (id, integration_id, api_key_id, allow_read, allow_import, allow_manage_leads)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE allow_read = VALUES(allow_read),
       allow_import = VALUES(allow_import), allow_manage_leads = VALUES(allow_manage_leads)`,
    [id, integrationId, apiKeyId, input.allowRead === false ? 0 : 1,
      input.allowImport ? 1 : 0, input.allowManageLeads ? 1 : 0]
  );
  return { integrationId, apiKeyId, allowRead: input.allowRead !== false,
    allowImport: Boolean(input.allowImport), allowManageLeads: Boolean(input.allowManageLeads) };
}

async function listGrants(integrationId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT g.api_key_id, g.allow_read, g.allow_import, g.allow_manage_leads,
            k.name, k.key_prefix
     FROM crm_integration_grants g INNER JOIN api_keys k ON k.id = g.api_key_id
     WHERE g.integration_id = ? ORDER BY k.name`,
    [integrationId]
  );
  return rows.map((row) => ({
    apiKeyId: row.api_key_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    allowRead: Boolean(row.allow_read),
    allowImport: Boolean(row.allow_import),
    allowManageLeads: Boolean(row.allow_manage_leads),
  }));
}

async function getAuthorizedIntegration(id, apiKeyId, permission = 'allow_read', pool = null) {
  if (!PERMISSIONS.has(permission)) throw new Error('Invalid CRM permission');
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT i.* FROM crm_integrations i
     INNER JOIN crm_integration_grants g ON g.integration_id = i.id
     WHERE i.id = ? AND g.api_key_id = ? AND g.${permission} = 1
       AND i.is_enabled = 1 LIMIT 1`,
    [id, apiKeyId]
  );
  if (!rows[0]) throw Object.assign(new Error('CRM integration access denied'), { status: 403 });
  return rows[0];
}

function integrationCredential(row) {
  return row && row.credential_enc ? decryptSecret(row.credential_enc) : '';
}

module.exports = {
  parseJson,
  publicIntegration,
  listIntegrations,
  getIntegrationById,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  upsertGrant,
  listGrants,
  getAuthorizedIntegration,
  integrationCredential,
  normalizeCredential,
  validateProviderBaseUrl,
  LEADCONNECTOR_PROVIDER,
  LEADCONNECTOR_ORIGIN,
};
