const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  generateInstanceIdentity,
  identityFromEnv,
  identityEnv,
  getInstanceIdentity,
} = require('./instanceIdentity');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

function loadEnv() {
  require('dotenv').config({ path: ENV_PATH });
}

function getDbConfig(overrides = {}) {
  return {
    host: overrides.host || process.env.DB_HOST || '127.0.0.1',
    port: Number(overrides.port || process.env.DB_PORT || 3306),
    user: overrides.user || process.env.DB_USER || '',
    password: overrides.password !== undefined ? overrides.password : (process.env.DB_PASSWORD || ''),
    database: overrides.database || process.env.DB_NAME || '',
  };
}

function hasDbEnv() {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
}

function generateAdminBasePath() {
  const token = crypto.randomBytes(24).toString('base64url');
  return `/p/${token}`;
}

/** Normalize to form /p/xxx with no trailing slash (except root which we never use). */
function normalizeAdminBasePath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/+$/, '');
  if (p.length < 8) return null;
  // prevent mounting at public well-known paths
  const blocked = ['', '/', '/admin', '/api', '/install', '/docs', '/health', '/css', '/js'];
  if (blocked.includes(p.toLowerCase())) return null;
  return p;
}

/**
 * Secret control-plane base path. Prefer env; if missing, derive stable path from SESSION_SECRET
 * so existing installs keep working after upgrade without reinstall.
 */
function getAdminBasePath() {
  const fromEnv = normalizeAdminBasePath(process.env.ADMIN_BASE_PATH);
  if (fromEnv) return fromEnv;
  const secret = process.env.SESSION_SECRET || 'dev-only-change-me';
  const digest = crypto.createHash('sha256').update(`admin-path:${secret}`).digest('base64url').slice(0, 32);
  return `/p/${digest}`;
}

function getCorsOrigins() {
  const raw = process.env.CORS_ORIGINS || '';
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * Normalizes an origin used by the separately hosted DiveDeep customer site.
 * Production deployments require HTTPS; plain HTTP is deliberately limited to
 * local test hosts so a copied installer cannot quietly create an insecure site.
 */
function normalizeWebOrigin(value, label = 'Origin') {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error(`${label} is required`);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a complete URL`); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`${label} must use HTTPS outside local testing`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an origin without a path, credentials, query, or fragment`);
  }
  return url.origin;
}

function getAdminIpAllowlist() {
  const raw = process.env.ADMIN_IP_ALLOWLIST || '';
  if (!raw.trim()) return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function getGoogleOAuthConfig() {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  const allowedEmails = [...new Set(String(process.env.GOOGLE_OAUTH_ALLOWED_EMAILS || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const hasAnyConfiguration = Boolean(clientId || clientSecret || redirectUri || allowedEmails.length);
  // MFA is mandatory for admin if configured (SP-03 hardening)
  const required = hasAnyConfiguration;
  const requestedSessionHours = Number(process.env.ADMIN_MFA_SESSION_HOURS || 12);
  const sessionHours = Number.isFinite(requestedSessionHours)
    ? Math.min(Math.max(requestedSessionHours, 1), 168)
    : 12;
  const errors = [];
  if (hasAnyConfiguration) {
    if (!clientId) errors.push('GOOGLE_OAUTH_CLIENT_ID is missing');
    if (!clientSecret) errors.push('GOOGLE_OAUTH_CLIENT_SECRET is missing');
    if (!redirectUri) errors.push('GOOGLE_OAUTH_REDIRECT_URI is missing');
    if (!allowedEmails.length) errors.push('GOOGLE_OAUTH_ALLOWED_EMAILS is empty');
  }
  if (redirectUri) {
    try {
      const url = new URL(redirectUri);
      const local = ['localhost', '127.0.0.1'].includes(url.hostname);
      if (url.protocol !== 'https:' && !local) errors.push('GOOGLE_OAUTH_REDIRECT_URI must use HTTPS');
      if (url.search || url.hash) errors.push('GOOGLE_OAUTH_REDIRECT_URI cannot contain a query or fragment');
      if (url.pathname !== `${getAdminBasePath()}/auth/google/callback`) {
        errors.push('GOOGLE_OAUTH_REDIRECT_URI path does not match ADMIN_BASE_PATH');
      }
    } catch {
      errors.push('GOOGLE_OAUTH_REDIRECT_URI is invalid');
    }
  }
  return {
    clientId,
    clientSecret,
    redirectUri,
    allowedEmails,
    hasAnyConfiguration,
    required,
    sessionHours,
    configured: hasAnyConfiguration && errors.length === 0,
    errors,
  };
}


function getDiveDeepConfig() {
  const inviteCode = String(process.env.DIVEDEEP_INVITE_CODE || '').trim();
  const signupsEnabled = String(process.env.DIVEDEEP_SIGNUPS_ENABLED || 'true').toLowerCase() !== 'false';
  const autoApprove = String(process.env.DIVEDEEP_AUTO_APPROVE || 'false').toLowerCase() === 'true';
  const privateStorageDir = String(process.env.DIVEDEEP_PRIVATE_STORAGE_DIR || '').trim();
  return {
    signupsEnabled,
    autoApprove,
    inviteCode,
    inviteRequired: Boolean(inviteCode),
    privateStorageDir,
    importBatchExpiryDays: Math.min(Math.max(Number(process.env.DIVEDEEP_IMPORT_BATCH_EXPIRY_DAYS || 7), 1), 30),
    stagedEvidenceRetentionDays: Math.min(Math.max(Number(process.env.DIVEDEEP_STAGED_EVIDENCE_RETENTION_DAYS || 30), 1), 365),
    publicOrigin: String(process.env.DIVEDEEP_PUBLIC_ORIGIN || '').trim().replace(/\/$/, ''),
    apiOrigin: String(process.env.DIVEDEEP_API_ORIGIN || '').trim().replace(/\/$/, ''),
    termsVersion: String(process.env.DIVEDEEP_TERMS_VERSION || 'divedeep-terms-v2').trim(),
    privacyVersion: String(process.env.DIVEDEEP_PRIVACY_VERSION || 'divedeep-privacy-v2').trim(),
    noticeVersion: String(process.env.DIVEDEEP_NOTICE_VERSION || 'divedeep-notice-at-collection-v1').trim(),
    responsibleDataVersion: String(process.env.DIVEDEEP_RESPONSIBLE_DATA_VERSION || 'divedeep-responsible-data-v1').trim(),
    electronicRecordsVersion: String(process.env.DIVEDEEP_ELECTRONIC_RECORDS_VERSION || 'divedeep-electronic-records-v1').trim(),
    authorizationVersion: String(process.env.DIVEDEEP_AUTHORIZATION_VERSION || 'divedeep-limited-authorization-v1').trim(),
    authorizationValidityDays: Math.min(Math.max(Number(process.env.DIVEDEEP_AUTHORIZATION_VALIDITY_DAYS || 365), 30), 730),
    legalEntityName: String(process.env.DIVEDEEP_LEGAL_ENTITY_NAME || '').trim(),
    privacyContactEmail: String(process.env.DIVEDEEP_PRIVACY_CONTACT_EMAIL || '').trim(),
    legalPostalAddress: String(process.env.DIVEDEEP_LEGAL_POSTAL_ADDRESS || '').trim(),
  };
}

function getDiveDeepMetaConfig() {
  const appId = String(process.env.DIVEDEEP_META_APP_ID || '').trim();
  const appSecret = String(process.env.DIVEDEEP_META_APP_SECRET || '').trim();
  const redirectUri = String(process.env.DIVEDEEP_META_REDIRECT_URI || '').trim();
  const graphVersion = String(process.env.DIVEDEEP_META_GRAPH_VERSION || '').trim();
  const albumImportEnabled = String(process.env.DIVEDEEP_META_ALBUM_IMPORT || '').toLowerCase() === 'true';
  const postImportEnabled = String(process.env.DIVEDEEP_META_POST_IMPORT || '').toLowerCase() === 'true';
  const instagramMediaImportEnabled = String(process.env.DIVEDEEP_META_INSTAGRAM_MEDIA_IMPORT || '').toLowerCase() === 'true';
  const errors = [];
  if (appId || appSecret || redirectUri || graphVersion) {
    if (!appId) errors.push('DIVEDEEP_META_APP_ID is missing');
    if (!appSecret) errors.push('DIVEDEEP_META_APP_SECRET is missing');
    if (!redirectUri) errors.push('DIVEDEEP_META_REDIRECT_URI is missing');
    if (!/^v\d+\.\d+$/.test(graphVersion)) errors.push('DIVEDEEP_META_GRAPH_VERSION must look like vNN.N');
    if (redirectUri) {
      try {
        const url = new URL(redirectUri);
        const local = ['localhost', '127.0.0.1'].includes(url.hostname);
        if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) errors.push('DIVEDEEP_META_REDIRECT_URI must use HTTPS');
        if (url.search || url.hash) errors.push('DIVEDEEP_META_REDIRECT_URI cannot contain a query or fragment');
      } catch { errors.push('DIVEDEEP_META_REDIRECT_URI is invalid'); }
    }
  }
  return {
    appId, appSecret, redirectUri, graphVersion,
    scopes: [
      'public_profile', 'email',
      ...(albumImportEnabled ? ['user_photos'] : []),
      ...(postImportEnabled ? ['user_posts'] : []),
      ...(instagramMediaImportEnabled ? ['instagram_basic', 'pages_show_list', 'pages_read_engagement'] : []),
    ],
    albumImportEnabled,
    postImportEnabled,
    instagramMediaImportEnabled,
    enabled: Boolean(appId && appSecret && redirectUri && graphVersion && errors.length === 0),
    errors,
  };
}

function getSentinelRetentionDays() {
  const n = Number(process.env.SENTINEL_RETENTION_DAYS || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function getSentinelForensicConfig() {
  const retention = Number(process.env.SENTINEL_FORENSIC_RETENTION_DAYS || 7);
  const bodyBytes = Number(process.env.SENTINEL_FORENSIC_MAX_BODY_BYTES || 24576);
  return {
    enabled: String(process.env.SENTINEL_FORENSICS_ENABLED || 'true').toLowerCase() !== 'false',
    retentionDays: Number.isFinite(retention) && retention > 0 ? Math.min(retention, 30) : 7,
    maxBodyBytes: Number.isFinite(bodyBytes) && bodyBytes >= 1024
      ? Math.min(bodyBytes, 65536)
      : 24576,
  };
}

function healthEnabled() {
  return String(process.env.HEALTH_PUBLIC || 'true').toLowerCase() !== 'false';
}

/**
 * White-label CRM app origin for Session Harbor contact URL building.
 */
function getCrmAppOrigin() {
  const raw =
    process.env.CRM_APP_ORIGIN || '';
  return String(raw).trim().replace(/\/$/, '');
}

/** Max JSON size for dialer workspace state (bytes of stringified JSON). */
function getWorkspaceMaxBytes() {
  const n = Number(process.env.WORKSPACE_MAX_BYTES || 262144);
  return Number.isFinite(n) && n > 1024 ? n : 262144;
}

function getParrotConfig() {
  const raw = String(process.env.PARROT_BASE_URL || '').trim().replace(/\/$/, '');
  const token = String(process.env.PARROT_SERVICE_TOKEN || '').trim();
  const requested = Number(process.env.PARROT_TIMEOUT_MS || 15000);
  const timeoutMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 100), 30000) : 15000;
  if (!raw) return { enabled:false, baseUrl:'', token, timeoutMs, error:'base_url_missing' };
  let url;
  try { url = new URL(raw); } catch { return { enabled:false, baseUrl:'', token, timeoutMs, error:'invalid_url' }; }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { enabled:false, baseUrl:'', token, timeoutMs, error:'https_required' };
  }
  if (!token) return { enabled:false, baseUrl:url.toString().replace(/\/$/, ''), token:'', timeoutMs, error:'token_missing' };
  return { enabled:true, baseUrl:url.toString().replace(/\/$/, ''), token, timeoutMs, error:null };
}

function writeEnvFile(values) {
  const combinedEnv = { ...process.env, ...values };
  const identity = combinedEnv.INSTANCE_ID
    ? identityFromEnv(combinedEnv, { allowDevelopmentDefaults: false })
    : generateInstanceIdentity();
  const instance = identityEnv(identity);
  const deploymentEnvironment = String(values.DEPLOYMENT_ENV || process.env.DEPLOYMENT_ENV || (values.NODE_ENV === 'development' ? 'development' : 'production')).trim().toLowerCase();
  const deploymentSuffix = deploymentEnvironment === 'production' ? 'prod' : deploymentEnvironment;
  const deploymentId = String(values.DIVEDEEP_DEPLOYMENT_ID || process.env.DIVEDEEP_DEPLOYMENT_ID || `divedeep-${deploymentSuffix}-${identity.instanceId.slice(0, 8)}`).trim();
  const storageNamespace = String(values.DIVEDEEP_STORAGE_NAMESPACE || process.env.DIVEDEEP_STORAGE_NAMESPACE || deploymentId).trim();
  const primaryComputeProvider = String(values.DIVEDEEP_PRIMARY_COMPUTE_PROVIDER || process.env.DIVEDEEP_PRIMARY_COMPUTE_PROVIDER || 'google_cloud_run_jobs').trim();
  const lines = [
    '# Private runtime configuration. Do not copy into logs, tickets, or source control.',
    `PORT=${values.PORT || process.env.PORT || 3000}`,
    `NODE_ENV=${values.NODE_ENV || 'production'}`,
    `DEPLOYMENT_ENV=${deploymentEnvironment}`,
    `DIVEDEEP_DEPLOYMENT_ID=${deploymentId}`,
    `DIVEDEEP_STORAGE_NAMESPACE=${storageNamespace}`,
    `DIVEDEEP_PRIMARY_COMPUTE_PROVIDER=${primaryComputeProvider}`,
    `DIVEDEEP_SECONDARY_COMPUTE_PROVIDER=${values.DIVEDEEP_SECONDARY_COMPUTE_PROVIDER || process.env.DIVEDEEP_SECONDARY_COMPUTE_PROVIDER || ''}`,
    `DIVEDEEP_PRODUCTION_ACK=${deploymentEnvironment === 'production' ? 'DIVEDEEP_PRODUCTION' : ''}`,
    `INSTANCE_ID=${instance.INSTANCE_ID}`,
    `PUBLIC_API_BASE_PATH=${instance.PUBLIC_API_BASE_PATH}`,
    `WEBHOOK_BASE_PATH=${instance.WEBHOOK_BASE_PATH}`,
    `HEALTH_PATH=${instance.HEALTH_PATH}`,
    `API_KEY_PREFIX=${instance.API_KEY_PREFIX}`,
    `AUTOMATION_NAMESPACE=${instance.AUTOMATION_NAMESPACE}`,
    `SESSION_COOKIE_NAME=${instance.SESSION_COOKIE_NAME}`,
    `OPERATOR_COOKIE_NAME=${instance.OPERATOR_COOKIE_NAME}`,
    `API_DISPLAY_NAME=${instance.API_DISPLAY_NAME}`,
    `API_METADATA_HEADERS_ENABLED=${instance.API_METADATA_HEADERS_ENABLED}`,
    `API_METADATA_HEADER_PREFIX=${instance.API_METADATA_HEADER_PREFIX}`,
    `DB_HOST=${values.DB_HOST}`,
    `DB_PORT=${values.DB_PORT || 3306}`,
    `DB_USER=${values.DB_USER}`,
    `DB_PASSWORD=${values.DB_PASSWORD}`,
    `DB_NAME=${values.DB_NAME}`,
    `SESSION_SECRET=${values.SESSION_SECRET}`,
    `SECRET_BOX_KEY=${values.SECRET_BOX_KEY || process.env.SECRET_BOX_KEY || ''}`,
    `FORENSIC_KEY=${values.FORENSIC_KEY || process.env.FORENSIC_KEY || ''}`,
    `ADMIN_BASE_PATH=${values.ADMIN_BASE_PATH || getAdminBasePath()}`,
    `ALLOW_REINSTALL=${values.ALLOW_REINSTALL || 'false'}`,
    `COOKIE_SECURE=${values.COOKIE_SECURE || process.env.COOKIE_SECURE || 'true'}`,
    `TRUST_PROXY=${values.TRUST_PROXY || process.env.TRUST_PROXY || '1'}`,
    `CORS_ORIGINS=${values.CORS_ORIGINS || process.env.CORS_ORIGINS || ''}`,
    `HEALTH_PUBLIC=${values.HEALTH_PUBLIC || process.env.HEALTH_PUBLIC || 'true'}`,
    `SENTINEL_RETENTION_DAYS=${values.SENTINEL_RETENTION_DAYS || process.env.SENTINEL_RETENTION_DAYS || '30'}`,
    `SENTINEL_FORENSICS_ENABLED=${values.SENTINEL_FORENSICS_ENABLED || process.env.SENTINEL_FORENSICS_ENABLED || 'true'}`,
    `SENTINEL_FORENSIC_RETENTION_DAYS=${values.SENTINEL_FORENSIC_RETENTION_DAYS || process.env.SENTINEL_FORENSIC_RETENTION_DAYS || '7'}`,
    `SENTINEL_FORENSIC_MAX_BODY_BYTES=${values.SENTINEL_FORENSIC_MAX_BODY_BYTES || process.env.SENTINEL_FORENSIC_MAX_BODY_BYTES || '24576'}`,
    `SENTINEL_WRITER_MAX_QUEUE=${values.SENTINEL_WRITER_MAX_QUEUE || process.env.SENTINEL_WRITER_MAX_QUEUE || '5000'}`,
    `SENTINEL_WRITER_MAX_ATTEMPTS=${values.SENTINEL_WRITER_MAX_ATTEMPTS || process.env.SENTINEL_WRITER_MAX_ATTEMPTS || '4'}`,
    `SENTINEL_WRITER_RETRY_BASE_MS=${values.SENTINEL_WRITER_RETRY_BASE_MS || process.env.SENTINEL_WRITER_RETRY_BASE_MS || '50'}`,
    `DNC_SCRUB_KEY=${values.DNC_SCRUB_KEY || process.env.DNC_SCRUB_KEY || values.DNC_SCRUB__KEY || process.env.DNC_SCRUB__KEY || ''}`,
    `DNC_SCRUB_TIMEOUT_MS=${values.DNC_SCRUB_TIMEOUT_MS || process.env.DNC_SCRUB_TIMEOUT_MS || '30000'}`,
    `DNC_SCRUB_BATCH_SIZE=${values.DNC_SCRUB_BATCH_SIZE || process.env.DNC_SCRUB_BATCH_SIZE || '50'}`,
    `DNC_SCRUB_MAX_RETRIES=${values.DNC_SCRUB_MAX_RETRIES || process.env.DNC_SCRUB_MAX_RETRIES || '2'}`,
    `DNC_SCRUB_REQUESTS_PER_MINUTE=${values.DNC_SCRUB_REQUESTS_PER_MINUTE || process.env.DNC_SCRUB_REQUESTS_PER_MINUTE || '30'}`,
    `PARROT_BASE_URL=${values.PARROT_BASE_URL || process.env.PARROT_BASE_URL || ''}`,
    `PARROT_SERVICE_TOKEN=${values.PARROT_SERVICE_TOKEN || process.env.PARROT_SERVICE_TOKEN || ''}`,
    `PARROT_TIMEOUT_MS=${values.PARROT_TIMEOUT_MS || process.env.PARROT_TIMEOUT_MS || '15000'}`,
    `DIVEDEEP_SIGNUPS_ENABLED=${values.DIVEDEEP_SIGNUPS_ENABLED || process.env.DIVEDEEP_SIGNUPS_ENABLED || 'true'}`,
    `DIVEDEEP_AUTO_APPROVE=${values.DIVEDEEP_AUTO_APPROVE || process.env.DIVEDEEP_AUTO_APPROVE || 'false'}`,
    `DIVEDEEP_INVITE_CODE=${values.DIVEDEEP_INVITE_CODE || process.env.DIVEDEEP_INVITE_CODE || ''}`,
    `DIVEDEEP_PRIVATE_STORAGE_DIR=${values.DIVEDEEP_PRIVATE_STORAGE_DIR || process.env.DIVEDEEP_PRIVATE_STORAGE_DIR || ''}`,
    `DIVEDEEP_PUBLIC_ORIGIN=${values.DIVEDEEP_PUBLIC_ORIGIN || process.env.DIVEDEEP_PUBLIC_ORIGIN || ''}`,
    `DIVEDEEP_API_ORIGIN=${values.DIVEDEEP_API_ORIGIN || process.env.DIVEDEEP_API_ORIGIN || ''}`,
    `DIVEDEEP_TERMS_VERSION=${values.DIVEDEEP_TERMS_VERSION || process.env.DIVEDEEP_TERMS_VERSION || 'divedeep-terms-v1'}`,
    `DIVEDEEP_PRIVACY_VERSION=${values.DIVEDEEP_PRIVACY_VERSION || process.env.DIVEDEEP_PRIVACY_VERSION || 'divedeep-privacy-v1'}`,
    `DIVEDEEP_AUTHORIZATION_VERSION=${values.DIVEDEEP_AUTHORIZATION_VERSION || process.env.DIVEDEEP_AUTHORIZATION_VERSION || 'divedeep-authorization-v1'}`,
    `DIVEDEEP_META_APP_ID=${values.DIVEDEEP_META_APP_ID || process.env.DIVEDEEP_META_APP_ID || ''}`,
    `DIVEDEEP_META_APP_SECRET=${values.DIVEDEEP_META_APP_SECRET || process.env.DIVEDEEP_META_APP_SECRET || ''}`,
    `DIVEDEEP_META_REDIRECT_URI=${values.DIVEDEEP_META_REDIRECT_URI || process.env.DIVEDEEP_META_REDIRECT_URI || ''}`,
    `DIVEDEEP_META_GRAPH_VERSION=${values.DIVEDEEP_META_GRAPH_VERSION || process.env.DIVEDEEP_META_GRAPH_VERSION || ''}`,
    `DIVEDEEP_META_ALBUM_IMPORT=${values.DIVEDEEP_META_ALBUM_IMPORT || process.env.DIVEDEEP_META_ALBUM_IMPORT || 'false'}`,
    `DIVEDEEP_META_POST_IMPORT=${values.DIVEDEEP_META_POST_IMPORT || process.env.DIVEDEEP_META_POST_IMPORT || 'false'}`,
    `DIVEDEEP_META_INSTAGRAM_MEDIA_IMPORT=${values.DIVEDEEP_META_INSTAGRAM_MEDIA_IMPORT || process.env.DIVEDEEP_META_INSTAGRAM_MEDIA_IMPORT || 'false'}`,
    '',
  ];
  fs.writeFileSync(ENV_PATH, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* platform may enforce permissions externally */ }
  for (const [key, val] of Object.entries(instance)) process.env[key] = String(val);
  process.env.DEPLOYMENT_ENV = deploymentEnvironment;
  process.env.DIVEDEEP_DEPLOYMENT_ID = deploymentId;
  process.env.DIVEDEEP_STORAGE_NAMESPACE = storageNamespace;
  process.env.DIVEDEEP_PRIMARY_COMPUTE_PROVIDER = primaryComputeProvider;
  if (deploymentEnvironment === 'production') process.env.DIVEDEEP_PRODUCTION_ACK = 'DIVEDEEP_PRODUCTION';
  for (const [key, val] of Object.entries(values)) {
    if (val !== undefined && val !== null) process.env[key] = String(val);
  }
}

function getSessionSecret() {
  return process.env.SESSION_SECRET || 'dev-only-change-me';
}

function getSecretBoxKey() {
  return String(process.env.SECRET_BOX_KEY || '').trim();
}

function getForensicKey() {
  return String(process.env.FORENSIC_KEY || '').trim();
}

function assertRuntimeSecurity({ installed = false, configured = false } = {}) {
  if (process.env.NODE_ENV !== 'production' || !installed || !configured) return;
  const sessionSecret = String(process.env.SESSION_SECRET || '');
  if (sessionSecret.length < 32 || sessionSecret === 'dev-only-change-me') {
    throw new Error('Production SESSION_SECRET must be configured with at least 32 characters');
  }
  identityFromEnv(process.env, { allowDevelopmentDefaults: false });
  require('./services/diveDeepProductionReadiness').assertEnvironmentSeparation(process.env);
}

function allowReinstall() {
  // SP-03: Hardened to false to close reinstall bypass vector
  return false;
}

function trustProxyHops() {
  const v = process.env.TRUST_PROXY;
  if (v === undefined || v === '') return 1;
  if (String(v).toLowerCase() === 'false' || v === '0') return false;
  const n = Number(v);
  return Number.isFinite(n) ? n : 1;
}

module.exports = {
  ROOT,
  ENV_PATH,
  loadEnv,
  getDbConfig,
  hasDbEnv,
  writeEnvFile,
  getSessionSecret,
  getSecretBoxKey,
  getForensicKey,
  assertRuntimeSecurity,
  allowReinstall,
  generateAdminBasePath,
  normalizeAdminBasePath,
  getAdminBasePath,
  getCorsOrigins,
  normalizeWebOrigin,
  getAdminIpAllowlist,
  getGoogleOAuthConfig,
  getSentinelRetentionDays,
  getSentinelForensicConfig,
  healthEnabled,
  trustProxyHops,
  getCrmAppOrigin,
  getWorkspaceMaxBytes,
  getParrotConfig,
  getDiveDeepConfig,
  getDiveDeepMetaConfig,
  getInstanceIdentity,
  SCHEMA_VERSION: '64',
};
