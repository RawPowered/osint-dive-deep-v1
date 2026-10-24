const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getDiveDeepConfig } = require('../config');
const { encryptSecret, decryptSecret } = require('./secretBox');

const PROVIDERS = Object.freeze({
  stripe: {
    label: 'Stripe Billing',
    description: 'Hosted checkout, subscriptions, invoices, and billing webhooks.',
    publicFields: ['publishableKey'],
    secretFields: ['secretKey', 'webhookSecret'],
    requiredSecrets: ['secretKey', 'webhookSecret'],
  },
  transactional_email: {
    label: 'Transactional Email',
    description: 'Account verification, service updates, and removal-case notifications.',
    publicFields: ['provider', 'fromEmail', 'replyTo'],
    secretFields: ['apiKey'],
    requiredSecrets: ['apiKey'],
  },
  meta: {
    label: 'Meta / Facebook',
    description: 'Customer-authorized Facebook and Instagram account connections.',
    publicFields: [
      'appId', 'graphVersion', 'redirectUri',
      'albumImportEnabled', 'postImportEnabled', 'instagramMediaImportEnabled',
    ],
    secretFields: ['appSecret'],
    requiredSecrets: ['appSecret'],
  },
  object_storage: {
    label: 'Private Object Storage',
    description: 'Optional S3-compatible encrypted evidence and reference-photo storage.',
    publicFields: [
      'driver', 'credentialMode', 'bucket', 'region', 'endpoint', 'forcePathStyle', 'privatePrefix',
      'roleArn', 'checksumMode', 'encryptionMode', 'kmsKeyId', 'uploadUrlSeconds',
      'downloadUrlSeconds', 'maximumArtifactBytes', 'objectTaggingEnabled', 'lifecycleSafetyNetEnabled',
    ],
    secretFields: ['accessKeyId', 'secretAccessKey', 'sessionToken', 'externalId'],
    requiredSecrets: [],
  },
  google_cloud_run: {
    label: 'Google Cloud Run Jobs',
    description: 'Disposable, one-execution DiveDeep compute launched through Google Cloud Run Jobs.',
    publicFields: [
      'credentialMode', 'projectId', 'region', 'jobName', 'serviceAccountEmail',
      'dispatchEnabled', 'defaultTaskTimeoutSeconds', 'defaultMaxRetries',
    ],
    secretFields: ['serviceAccountJson'],
    requiredSecrets: [],
  },
  aws_rekognition: {
    label: 'Amazon Rekognition',
    description: 'Consent-gated assisted image quality, comparison, moderation, text, and context analysis.',
    publicFields: [
      'credentialMode', 'region', 'roleArn', 'inputMode', 'stagingBucket', 'stagingPrefix',
      'defaultSimilarityThreshold', 'highPriorityThreshold', 'minimumFaceConfidence',
      'minimumModerationConfidence', 'enableFaceDetection', 'enableFaceComparison',
      'enableModeration', 'enableTextDetection', 'enableLabelDetection',
      'maximumReferencesPerCandidate', 'maximumCandidatesPerRun', 'dailyCallBudget', 'monthlyCallBudget',
    ],
    secretFields: ['accessKeyId', 'secretAccessKey', 'sessionToken', 'externalId'],
    requiredSecrets: [],
  },
  divedeep_export: {
    label: 'DiveDeep Export',
    description: 'Manual root-admin handoff settings for the isolated Kali workstation.',
    publicFields: ['defaultFormat', 'includePhotoManifest', 'sensitiveAcknowledgement'],
    secretFields: [],
    requiredSecrets: [],
  },
});

function clean(value, max = 2048) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function statusError(message, status = 400, code = 'DIVEDEEP_INTEGRATION_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function definition(provider) {
  const key = clean(provider, 64).toLowerCase();
  const item = PROVIDERS[key];
  if (!item) throw statusError('Unsupported DiveDeep integration provider');
  return { key, ...item };
}

function metaRedirectUri() {
  const apiOrigin = getDiveDeepConfig().apiOrigin;
  return apiOrigin ? `${apiOrigin}/divedeep/connect/facebook/callback` : '';
}

function deriveConfig(provider, input = {}) {
  const output = { ...input };
  const callback = provider === 'meta' ? metaRedirectUri() : '';
  if (callback) output.redirectUri = callback;
  return output;
}

function sanitizeConfig(provider, input = {}) {
  const def = definition(provider);
  const source = parseJson(input, {});
  for (const secretField of def.secretFields) {
    if (Object.prototype.hasOwnProperty.call(source, secretField)) {
      throw statusError(`${secretField} must be submitted as a protected secret, not public configuration`);
    }
  }
  const output = {};
  for (const field of def.publicFields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const value = source[field];
    output[field] = typeof value === 'boolean' ? value : clean(value, field === 'redirectUri' || field === 'endpoint' ? 2048 : 512);
  }
  if (provider === 'meta' && output.graphVersion && !/^v\d+\.\d+$/.test(output.graphVersion)) {
    throw statusError('Meta Graph version must look like vNN.N');
  }
  for (const field of ['redirectUri', 'endpoint']) {
    if (!output[field]) continue;
    let url;
    try { url = new URL(output[field]); } catch { throw statusError(`${field} must be a valid URL`); }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw statusError(`${field} must use HTTPS`);
    if (url.username || url.password) throw statusError(`${field} must not contain credentials`);
    if (url.search || url.hash) throw statusError(`${field} must not contain a query or fragment`);
  }
  if (provider === 'meta' && output.redirectUri) {
    const callback = new URL(output.redirectUri);
    if (callback.pathname.replace(/\/+$/, '') !== '/divedeep/connect/facebook/callback') {
      throw statusError('Meta redirect URI must use the DiveDeep Facebook callback path');
    }
  }
  if (provider === 'transactional_email') {
    for (const field of ['fromEmail', 'replyTo']) {
      if (output[field] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(output[field])) throw statusError(`${field} must be a valid email address`);
    }
  }
  if (provider === 'object_storage') {
    const objectStorage = require('./diveDeepObjectStorage');
    return objectStorage.normalizeConfig(output);
  }
  if (provider === 'divedeep_export' && output.defaultFormat && !['json', 'csv', 'md'].includes(output.defaultFormat)) {
    throw statusError('DiveDeep export format must be json, csv, or md');
  }
  if (provider === 'google_cloud_run') {
    const cloudRun = require('./diveDeepCloudRun');
    return cloudRun.normalizeConfig(output);
  }
  if (provider === 'aws_rekognition') {
    const rekognition = require('./diveDeepRekognition');
    return rekognition.normalizeConfig(output);
  }
  return output;
}

function decryptSecrets(row) {
  if (!row?.secrets_enc) return {};
  return parseJson(decryptSecret(row.secrets_enc), {});
}

function mergeSecrets(provider, existing, incoming = {}, clearSecrets = []) {
  const def = definition(provider);
  const next = { ...existing };
  const clear = new Set(Array.isArray(clearSecrets) ? clearSecrets.map((item) => clean(item, 64)) : []);
  for (const field of def.secretFields) {
    if (clear.has(field)) delete next[field];
    if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
    const value = clean(incoming[field], 8192);
    if (value) next[field] = value;
  }
  return next;
}

function secretSummary(provider, secrets, hints = {}) {
  const def = definition(provider);
  return def.secretFields.map((field) => ({
    field,
    configured: Boolean(secrets[field]) || Boolean(hints[field]),
    hint: hints[field] || (secrets[field] ? `••••${String(secrets[field]).slice(-4)}` : ''),
  }));
}

function publicIntegration(row, providerOverride = null) {
  const provider = providerOverride || row.provider;
  const def = definition(provider);
  const hints = parseJson(row?.secret_hints_json, {});
  return {
    provider,
    label: def.label,
    description: def.description,
    configured: Boolean(row),
    enabled: Boolean(row?.is_enabled),
    config: deriveConfig(provider, parseJson(row?.config_json, {})),
    secrets: secretSummary(provider, {}, hints),
    lastVerifiedAt: row?.last_verified_at || null,
    verificationStatus: row?.verification_status || 'not_checked',
    verificationMessage: row?.verification_message || '',
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || null,
  };
}

async function listIntegrations(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_integrations ORDER BY provider');
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return Object.keys(PROVIDERS).map((provider) => publicIntegration(byProvider.get(provider) || null, provider));
}

async function getIntegrationRow(provider, pool = null) {
  const p = pool || getPool();
  const def = definition(provider);
  const [rows] = await p.query('SELECT * FROM divedeep_integrations WHERE provider=? LIMIT 1', [def.key]);
  return rows[0] || null;
}

async function addAudit(connection, provider, eventType, actorId, details = {}) {
  await connection.query(
    `INSERT INTO divedeep_integration_events (id,provider,event_type,actor_id,details_json)
     VALUES (?,?,?,?,?)`,
    [crypto.randomUUID(), provider, eventType, clean(actorId, 128) || null, JSON.stringify(details)]
  );
}

async function saveIntegration(providerInput, input, actorId, pool = null) {
  const p = pool || getPool();
  const def = definition(providerInput);
  const existing = await getIntegrationRow(def.key, p);
  const existingSecrets = decryptSecrets(existing);
  const config = deriveConfig(def.key, sanitizeConfig(def.key, input.config || {}));
  const secrets = mergeSecrets(def.key, existingSecrets, parseJson(input.secrets, {}), input.clearSecrets);
  const missing = def.requiredSecrets.filter((field) => !secrets[field]);
  const enabled = Boolean(input.enabled);
  if (enabled && missing.length) throw statusError(`Configure ${missing.join(', ')} before enabling ${def.label}`);
  if (def.key === 'meta' && enabled && (!config.appId || !config.graphVersion || !config.redirectUri)) {
    throw statusError('Meta app ID, Graph version, and redirect URI are required before enabling Meta');
  }
  if (def.key === 'transactional_email' && enabled && (!config.provider || !config.fromEmail)) {
    throw statusError('Email provider and from address are required before enabling transactional email');
  }
  if (def.key === 'stripe' && enabled && !config.publishableKey) {
    throw statusError('Stripe publishable key is required before enabling billing');
  }
  if (def.key === 'object_storage' && enabled && config.driver === 's3') {
    if (!config.bucket) throw statusError('A private bucket is required before enabling object storage');
    if (config.credentialMode === 'static_keys' && (!secrets.accessKeyId || !secrets.secretAccessKey)) {
      throw statusError('Static storage access key ID and secret access key are required for the selected credential mode');
    }
    if (config.credentialMode === 'assume_role' && !config.roleArn) {
      throw statusError('An IAM role ARN is required for assume-role object storage access');
    }
  }
  if (def.key === 'google_cloud_run' && enabled) {
    if (!config.projectId || !config.region || !config.jobName) {
      throw statusError('Google Cloud project ID, region, and Cloud Run Job name are required before enabling dispatch');
    }
    if (config.credentialMode === 'service_account_json' && !secrets.serviceAccountJson) {
      throw statusError('Google service account JSON is required for the selected credential mode');
    }
    if (secrets.serviceAccountJson) require('./diveDeepCloudRun').parseServiceAccountJson(secrets.serviceAccountJson);
  }
  if (def.key === 'aws_rekognition' && enabled) {
    if (config.credentialMode === 'static_keys' && (!secrets.accessKeyId || !secrets.secretAccessKey)) {
      throw statusError('Static AWS access key ID and secret access key are required before enabling Rekognition');
    }
    if (config.credentialMode === 'assume_role' && !config.roleArn) {
      throw statusError('An IAM role ARN is required before enabling assume-role Rekognition access');
    }
  }
  const hints = {};
  for (const field of def.secretFields) if (secrets[field]) hints[field] = `••••${String(secrets[field]).slice(-4)}`;
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO divedeep_integrations
        (provider,config_json,secrets_enc,secret_hints_json,is_enabled,verification_status,verification_message,updated_by)
       VALUES (?,?,?,?,?,'not_checked','Configuration changed; verification required',?)
       ON DUPLICATE KEY UPDATE config_json=VALUES(config_json),secrets_enc=VALUES(secrets_enc),
         secret_hints_json=VALUES(secret_hints_json),is_enabled=VALUES(is_enabled),
         verification_status='not_checked',verification_message='Configuration changed; verification required',
         updated_by=VALUES(updated_by),updated_at=CURRENT_TIMESTAMP(3)`,
      [def.key, JSON.stringify(config), Object.keys(secrets).length ? encryptSecret(JSON.stringify(secrets)) : null,
        JSON.stringify(hints), enabled ? 1 : 0, clean(actorId, 128) || null]
    );
    await addAudit(connection, def.key, existing ? 'integration.updated' : 'integration.created', actorId, {
      enabled, configuredFields: Object.keys(config), secretFieldsChanged: def.secretFields.filter((field) => Boolean(input.secrets?.[field]) || (input.clearSecrets || []).includes(field)),
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return publicIntegration(await getIntegrationRow(def.key, p));
}

async function verifyIntegration(providerInput, actorId, pool = null) {
  const p = pool || getPool();
  const def = definition(providerInput);
  const row = await getIntegrationRow(def.key, p);
  if (!row) throw statusError('Integration has not been configured', 404, 'DIVEDEEP_INTEGRATION_NOT_FOUND');
  const secrets = decryptSecrets(row);
  const config = deriveConfig(def.key, sanitizeConfig(def.key, parseJson(row.config_json, {})));
  const missing = def.requiredSecrets.filter((field) => !secrets[field]);
  let status = missing.length ? 'invalid' : 'configured';
  let message = missing.length ? `Missing protected values: ${missing.join(', ')}` : 'Required configuration is present and encrypted.';
  if (def.key === 'stripe' && !config.publishableKey) { status = 'invalid'; message = 'Stripe publishable key is missing.'; }
  if (def.key === 'meta' && (!config.appId || !config.graphVersion || !config.redirectUri)) { status = 'invalid'; message = 'Meta public application settings are incomplete.'; }
  if (def.key === 'transactional_email' && (!config.provider || !config.fromEmail)) { status = 'invalid'; message = 'Email provider settings are incomplete.'; }
  if (def.key === 'object_storage' && config.driver === 's3') {
    if (!config.bucket) { status = 'invalid'; message = 'The private storage bucket is missing.'; }
    else if (config.credentialMode === 'static_keys' && (!secrets.accessKeyId || !secrets.secretAccessKey)) { status = 'invalid'; message = 'Static storage credentials are incomplete.'; }
    else if (config.credentialMode === 'assume_role' && !config.roleArn) { status = 'invalid'; message = 'Assume-role storage configuration is incomplete.'; }
    else { status = 'configured'; message = 'Object-storage configuration is structurally valid. Use Verify storage access for a live bucket check.'; }
  }
  if (def.key === 'google_cloud_run') {
    if (!config.projectId || !config.region || !config.jobName) {
      status = 'invalid';
      message = 'Google Cloud project, region, or Cloud Run Job name is missing.';
    } else if (config.credentialMode === 'service_account_json' && !secrets.serviceAccountJson) {
      status = 'invalid';
      message = 'Google service account JSON is missing.';
    } else {
      status = 'configured';
      message = 'Cloud Run configuration is structurally valid. Use Verify Cloud Run Job for a live IAM and resource check.';
    }
  }
  if (def.key === 'aws_rekognition') {
    if (config.credentialMode === 'static_keys' && (!secrets.accessKeyId || !secrets.secretAccessKey)) {
      status = 'invalid';
      message = 'Static AWS credentials are incomplete.';
    } else if (config.credentialMode === 'assume_role' && !config.roleArn) {
      status = 'invalid';
      message = 'Assume-role configuration is incomplete.';
    } else {
      status = 'configured';
      message = 'Rekognition configuration is structurally valid. Use Verify AWS identity and Verify Rekognition access for live checks.';
    }
  }
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE divedeep_integrations SET verification_status=?,verification_message=?,last_verified_at=CURRENT_TIMESTAMP(3),
       updated_by=?,updated_at=CURRENT_TIMESTAMP(3) WHERE provider=?`,
      [status, message, clean(actorId, 128) || null, def.key]
    );
    await addAudit(connection, def.key, 'integration.verified', actorId, { status });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  return publicIntegration(await getIntegrationRow(def.key, p));
}


async function recordVerification(providerInput, result = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const def = definition(providerInput);
  const status = result.ok ? 'configured' : 'invalid';
  const message = clean(result.message || (result.ok ? 'Provider verification succeeded.' : 'Provider verification failed.'), 1000);
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE divedeep_integrations SET verification_status=?,verification_message=?,last_verified_at=CURRENT_TIMESTAMP(3),updated_by=?,updated_at=CURRENT_TIMESTAMP(3) WHERE provider=?`,
      [status, message, clean(actorId, 128) || null, def.key]
    );
    await addAudit(connection, def.key, result.eventType || 'integration.provider_verified', actorId, {
      status,
      operation: clean(result.operation, 96) || null,
      region: clean(result.region, 64) || null,
      latencyMs: Number(result.latencyMs) || null,
      requestId: clean(result.requestId, 160) || null,
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  return publicIntegration(await getIntegrationRow(def.key, p), def.key);
}

async function disableIntegration(providerInput, actorId, pool = null) {
  const p = pool || getPool();
  const def = definition(providerInput);
  const row = await getIntegrationRow(def.key, p);
  if (!row) throw statusError('Integration has not been configured', 404, 'DIVEDEEP_INTEGRATION_NOT_FOUND');
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE divedeep_integrations SET secrets_enc=NULL,secret_hints_json='{}',is_enabled=0,
       verification_status='disconnected',verification_message='Credentials removed by root owner',
       updated_by=?,updated_at=CURRENT_TIMESTAMP(3) WHERE provider=?`,
      [clean(actorId, 128) || null, def.key]
    );
    await addAudit(connection, def.key, 'integration.disconnected', actorId, { credentialsRemoved: true });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  return publicIntegration(await getIntegrationRow(def.key, p));
}

async function listIntegrationEvents(limit = 100, pool = null) {
  const p = pool || getPool();
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 250);
  const [rows] = await p.query(
    `SELECT id,provider,event_type,actor_id,details_json,created_at
     FROM divedeep_integration_events ORDER BY created_at DESC LIMIT ?`, [bounded]
  );
  return rows.map((row) => ({
    id: row.id, provider: row.provider, eventType: row.event_type, actorId: row.actor_id,
    details: parseJson(row.details_json, {}), createdAt: row.created_at,
  }));
}

async function getRuntimeIntegration(providerInput, pool = null) {
  const row = await getIntegrationRow(providerInput, pool);
  if (!row || !row.is_enabled) return null;
  return { provider: row.provider, config: deriveConfig(row.provider, parseJson(row.config_json, {})), secrets: decryptSecrets(row) };
}

module.exports = {
  PROVIDERS,
  listIntegrations,
  saveIntegration,
  verifyIntegration,
  disableIntegration,
  listIntegrationEvents,
  getRuntimeIntegration,
  recordVerification,
  publicIntegration,
  sanitizeConfig,
  metaRedirectUri,
};
