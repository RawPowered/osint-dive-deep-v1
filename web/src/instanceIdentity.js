const crypto = require('crypto');

const BLOCKED_PUBLIC_SEGMENTS = new Set([
  'admin', 'administrator', 'api', 'css', 'data', 'docs', 'health', 'hooks',
  'install', 'js', 'login', 'p', 'wp-admin',
]);

const DEVELOPMENT_IDENTITY = Object.freeze({
  instanceId: '00000000-0000-4000-8000-000000000000',
  publicApiBasePath: '/api',
  webhookBasePath: '/hooks',
  healthPath: '/health',
  apiKeyPrefix: 'dev_',
  automationNamespace: 'local',
  sessionCookieName: 'sid',
  operatorCookieName: 'operator_session',
  apiDisplayName: 'Private API',
  metadataHeadersEnabled: false,
  metadataHeaderPrefix: 'Instance',
});

let cachedFingerprint = null;
let cachedIdentity = null;

function randomUrlToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomIdentifier(prefix, bytes = 5) {
  return `${prefix}${crypto.randomBytes(bytes).toString('hex')}`;
}

function normalizePublicPath(value, label) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${label} is required`);
  const path = `/${raw.replace(/^\/+|\/+$/g, '')}`;
  if (path.length < 7 || path.length > 96) throw new Error(`${label} must be 7-96 characters`);
  const segments = path.slice(1).split('/');
  if (segments.length > 3 || segments.some((segment) => !/^[A-Za-z0-9_-]{2,48}$/.test(segment))) {
    throw new Error(`${label} must contain 1-3 URL-safe path segments`);
  }
  if (BLOCKED_PUBLIC_SEGMENTS.has(segments[0].toLowerCase())) {
    throw new Error(`${label} begins with a reserved path segment`);
  }
  return path;
}

function normalizeApiKeyPrefix(value) {
  const prefix = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,15}$/.test(prefix)) {
    throw new Error('API key prefix must be 3-16 URL-safe characters');
  }
  return prefix;
}

function normalizeAutomationNamespace(value) {
  const namespace = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,23}$/.test(namespace)) {
    throw new Error('Automation namespace must be 3-24 lowercase letters, numbers, underscores, or hyphens');
  }
  return namespace;
}

function normalizeCookieName(value, label) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,47}$/.test(name)) {
    throw new Error(`${label} must be 6-48 cookie-safe characters`);
  }
  return name;
}

function normalizeInstanceId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new Error('INSTANCE_ID must be a UUID v4');
  }
  return id;
}

function normalizeDisplayName(value) {
  const name = String(value || '').trim().replace(/[\r\n\t]/g, ' ');
  if (!name || name.length > 80) throw new Error('API display name must be 1-80 characters');
  return name;
}

function normalizeHeaderPrefix(value) {
  const prefix = String(value || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{2,39}$/.test(prefix)) {
    throw new Error('Metadata header prefix must be 3-40 letters, numbers, or hyphens');
  }
  return prefix;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function validateIdentity(input) {
  const identity = {
    instanceId: normalizeInstanceId(input.instanceId),
    publicApiBasePath: normalizePublicPath(input.publicApiBasePath, 'Public API base path'),
    webhookBasePath: normalizePublicPath(input.webhookBasePath, 'Webhook base path'),
    healthPath: normalizePublicPath(input.healthPath, 'Health path'),
    apiKeyPrefix: normalizeApiKeyPrefix(input.apiKeyPrefix),
    automationNamespace: normalizeAutomationNamespace(input.automationNamespace),
    sessionCookieName: normalizeCookieName(input.sessionCookieName, 'Session cookie name'),
    operatorCookieName: normalizeCookieName(input.operatorCookieName, 'Operator cookie name'),
    apiDisplayName: normalizeDisplayName(input.apiDisplayName),
    metadataHeadersEnabled: booleanValue(input.metadataHeadersEnabled, false),
    metadataHeaderPrefix: normalizeHeaderPrefix(input.metadataHeaderPrefix),
  };

  const paths = [identity.publicApiBasePath, identity.webhookBasePath, identity.healthPath];
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    throw new Error('Public API, webhook, and health paths must be different');
  }
  if (identity.sessionCookieName === identity.operatorCookieName) {
    throw new Error('Admin and operator cookies must have different names');
  }
  return Object.freeze(identity);
}

function generateInstanceIdentity(overrides = {}) {
  const identity = {
    instanceId: overrides.instanceId || crypto.randomUUID(),
    publicApiBasePath: overrides.publicApiBasePath || `/${randomUrlToken(14)}`,
    webhookBasePath: overrides.webhookBasePath || `/${randomUrlToken(14)}`,
    healthPath: overrides.healthPath || `/${randomUrlToken(14)}`,
    apiKeyPrefix: overrides.apiKeyPrefix || `${randomIdentifier('k', 4)}_`,
    automationNamespace: overrides.automationNamespace || randomIdentifier('a', 4),
    sessionCookieName: overrides.sessionCookieName || randomIdentifier('c', 8),
    operatorCookieName: overrides.operatorCookieName || randomIdentifier('o', 8),
    apiDisplayName: overrides.apiDisplayName || 'Private API',
    metadataHeadersEnabled: overrides.metadataHeadersEnabled ?? false,
    metadataHeaderPrefix: overrides.metadataHeaderPrefix || randomIdentifier('H', 4),
  };
  return validateIdentity(identity);
}

function identityFromEnv(env = process.env, { allowDevelopmentDefaults = true } = {}) {
  const hasIdentity = Boolean(env.INSTANCE_ID || env.PUBLIC_API_BASE_PATH || env.API_KEY_PREFIX);
  if (!hasIdentity) {
    if (!allowDevelopmentDefaults) throw new Error('Instance identity is not configured');
    return DEVELOPMENT_IDENTITY;
  }
  return validateIdentity({
    instanceId: env.INSTANCE_ID,
    publicApiBasePath: env.PUBLIC_API_BASE_PATH,
    webhookBasePath: env.WEBHOOK_BASE_PATH,
    healthPath: env.HEALTH_PATH,
    apiKeyPrefix: env.API_KEY_PREFIX,
    automationNamespace: env.AUTOMATION_NAMESPACE,
    sessionCookieName: env.SESSION_COOKIE_NAME,
    operatorCookieName: env.OPERATOR_COOKIE_NAME,
    apiDisplayName: env.API_DISPLAY_NAME || 'Private API',
    metadataHeadersEnabled: env.API_METADATA_HEADERS_ENABLED,
    metadataHeaderPrefix: env.API_METADATA_HEADER_PREFIX,
  });
}

function identityFingerprint(env) {
  return [
    env.INSTANCE_ID, env.PUBLIC_API_BASE_PATH, env.WEBHOOK_BASE_PATH, env.HEALTH_PATH,
    env.API_KEY_PREFIX, env.AUTOMATION_NAMESPACE, env.SESSION_COOKIE_NAME,
    env.OPERATOR_COOKIE_NAME, env.API_DISPLAY_NAME, env.API_METADATA_HEADERS_ENABLED,
    env.API_METADATA_HEADER_PREFIX,
  ].join('\u0000');
}

function getInstanceIdentity() {
  const fingerprint = identityFingerprint(process.env);
  if (fingerprint !== cachedFingerprint) {
    cachedIdentity = identityFromEnv(process.env);
    cachedFingerprint = fingerprint;
  }
  return cachedIdentity;
}

function identityEnv(identity) {
  const value = validateIdentity(identity);
  return {
    INSTANCE_ID: value.instanceId,
    PUBLIC_API_BASE_PATH: value.publicApiBasePath,
    WEBHOOK_BASE_PATH: value.webhookBasePath,
    HEALTH_PATH: value.healthPath,
    API_KEY_PREFIX: value.apiKeyPrefix,
    AUTOMATION_NAMESPACE: value.automationNamespace,
    SESSION_COOKIE_NAME: value.sessionCookieName,
    OPERATOR_COOKIE_NAME: value.operatorCookieName,
    API_DISPLAY_NAME: value.apiDisplayName,
    API_METADATA_HEADERS_ENABLED: String(value.metadataHeadersEnabled),
    API_METADATA_HEADER_PREFIX: value.metadataHeaderPrefix,
  };
}

function instanceAction(action) {
  const suffix = String(action || '').trim();
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(suffix)) throw new Error('Invalid instance action suffix');
  return `${getInstanceIdentity().automationNamespace}.${suffix}`;
}

function isPathWithin(pathname, basePath) {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

function relativeMountedUrl(url, basePath) {
  const relative = String(url || '').slice(basePath.length) || '/';
  return relative.startsWith('/') ? relative : `/${relative}`;
}

function schemaUrn(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!slug) throw new Error('Schema name is required');
  return `urn:instance:${getInstanceIdentity().instanceId}:schema:${slug}`;
}

function outboundUserAgent(component) {
  const slug = String(component || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!slug || slug.length > 32) throw new Error('Outbound component name must be 1-32 URL-safe characters');
  const instanceToken = crypto.createHash('sha256')
    .update(getInstanceIdentity().instanceId, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${instanceToken}.${slug}/1.0`;
}

module.exports = {
  DEVELOPMENT_IDENTITY,
  generateInstanceIdentity,
  validateIdentity,
  identityFromEnv,
  getInstanceIdentity,
  identityEnv,
  normalizePublicPath,
  normalizeApiKeyPrefix,
  normalizeAutomationNamespace,
  instanceAction,
  isPathWithin,
  relativeMountedUrl,
  schemaUrn,
  outboundUserAgent,
};
