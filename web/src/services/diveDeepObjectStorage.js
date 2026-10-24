const path = require('path');
const crypto = require('crypto');
const { getRuntimeIntegration } = require('./diveDeepIntegrations');

function statusError(message, status = 400, code = 'DIVEDEEP_OBJECT_STORAGE_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function clean(value, max = 2048) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function integer(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function normalizePrefix(value) {
  const text = clean(value || 'divedeep-private/', 512).replace(/^\/+/, '');
  return `${text.replace(/\/+$/, '')}/`;
}

function normalizeConfig(input = {}) {
  const driver = clean(input.driver || 's3', 32).toLowerCase();
  if (driver !== 's3') throw statusError('DiveDeep artifact storage must use a private S3-compatible provider');
  const credentialMode = clean(input.credentialMode || 'default_provider_chain', 64);
  if (!['default_provider_chain', 'assume_role', 'static_keys'].includes(credentialMode)) {
    throw statusError('Credential mode must be default_provider_chain, assume_role, or static_keys');
  }
  const checksumMode = clean(input.checksumMode || 'sha256_header', 32);
  if (!['sha256_header', 'metadata_only'].includes(checksumMode)) {
    throw statusError('Checksum mode must be sha256_header or metadata_only');
  }
  const encryptionMode = clean(input.encryptionMode || 'provider_managed', 32);
  if (!['provider_managed', 'sse_s3', 'sse_kms'].includes(encryptionMode)) {
    throw statusError('Encryption mode must be provider_managed, sse_s3, or sse_kms');
  }
  const endpoint = clean(input.endpoint, 2048);
  if (endpoint) {
    let url;
    try { url = new URL(endpoint); } catch { throw statusError('Storage endpoint must be a valid URL'); }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw statusError('Storage endpoint must use HTTPS');
    if (url.username || url.password || url.search || url.hash) throw statusError('Storage endpoint must not contain credentials, a query, or a fragment');
  }
  const config = {
    driver,
    credentialMode,
    bucket: clean(input.bucket, 255),
    region: clean(input.region || (endpoint ? 'auto' : 'us-east-1'), 64),
    endpoint,
    forcePathStyle: bool(input.forcePathStyle, false),
    privatePrefix: normalizePrefix(input.privatePrefix),
    roleArn: clean(input.roleArn, 512),
    checksumMode,
    encryptionMode,
    kmsKeyId: clean(input.kmsKeyId, 512),
    uploadUrlSeconds: integer(input.uploadUrlSeconds, 600, 60, 3600),
    downloadUrlSeconds: integer(input.downloadUrlSeconds, 120, 30, 900),
    maximumArtifactBytes: integer(input.maximumArtifactBytes, 100 * 1024 * 1024, 1024, 5 * 1024 * 1024 * 1024),
    objectTaggingEnabled: bool(input.objectTaggingEnabled, !endpoint),
    lifecycleSafetyNetEnabled: bool(input.lifecycleSafetyNetEnabled, true),
  };
  if (driver === 's3' && !config.bucket) throw statusError('A private bucket is required for S3-compatible storage');
  if (credentialMode === 'assume_role' && !/^arn:(aws|aws-us-gov|aws-cn):iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]+$/.test(config.roleArn)) {
    throw statusError('A valid IAM role ARN is required for assume-role storage access');
  }
  if (encryptionMode === 'sse_kms' && !config.kmsKeyId) throw statusError('A KMS key ID is required for sse_kms storage');
  return config;
}

function baseCredentials(mode, secrets = {}) {
  if (mode !== 'static_keys') return undefined;
  if (!secrets.accessKeyId || !secrets.secretAccessKey) {
    throw statusError('Static storage access key ID and secret access key are required', 409, 'DIVEDEEP_STORAGE_CREDENTIALS_MISSING');
  }
  return {
    accessKeyId: secrets.accessKeyId,
    secretAccessKey: secrets.secretAccessKey,
    ...(secrets.sessionToken ? { sessionToken: secrets.sessionToken } : {}),
  };
}

async function loadSdk() {
  try {
    const s3 = require('@aws-sdk/client-s3');
    const presigner = require('@aws-sdk/s3-request-presigner');
    const sts = require('@aws-sdk/client-sts');
    return { ...s3, ...presigner, ...sts };
  } catch (error) {
    throw statusError(`S3-compatible storage dependencies are unavailable: ${error.message}`, 503, 'DIVEDEEP_STORAGE_SDK_UNAVAILABLE');
  }
}

async function resolveCredentials(runtime, sdk) {
  const base = baseCredentials(runtime.config.credentialMode, runtime.secrets);
  if (runtime.config.credentialMode !== 'assume_role') return base;
  const sts = new sdk.STSClient({ region: runtime.config.region === 'auto' ? 'us-east-1' : runtime.config.region, ...(base ? { credentials: base } : {}) });
  const response = await sts.send(new sdk.AssumeRoleCommand({
    RoleArn: runtime.config.roleArn,
    RoleSessionName: `divedeep-storage-${Date.now()}`,
    DurationSeconds: 900,
    ...(runtime.secrets.externalId ? { ExternalId: runtime.secrets.externalId } : {}),
  }));
  if (!response.Credentials) throw statusError('AWS did not return temporary storage credentials', 502, 'DIVEDEEP_STORAGE_ASSUME_ROLE_FAILED');
  return {
    accessKeyId: response.Credentials.AccessKeyId,
    secretAccessKey: response.Credentials.SecretAccessKey,
    sessionToken: response.Credentials.SessionToken,
  };
}

async function runtimeConfig(pool = null) {
  const runtime = await getRuntimeIntegration('object_storage', pool);
  if (!runtime) throw statusError('Private object storage is not enabled', 409, 'DIVEDEEP_STORAGE_DISABLED');
  runtime.config = normalizeConfig(runtime.config);
  return runtime;
}

async function createClient(pool = null) {
  const runtime = await runtimeConfig(pool);
  if (runtime.config.driver !== 's3') throw statusError('Direct artifact authorization requires the S3-compatible storage driver', 409, 'DIVEDEEP_STORAGE_DIRECT_UPLOAD_UNAVAILABLE');
  const sdk = await loadSdk();
  const credentials = await resolveCredentials(runtime, sdk);
  const options = {
    region: runtime.config.region,
    forcePathStyle: runtime.config.forcePathStyle,
    ...(runtime.config.endpoint ? { endpoint: runtime.config.endpoint } : {}),
    ...(credentials ? { credentials } : {}),
  };
  return { runtime, sdk, client: new sdk.S3Client(options) };
}

function safeSegment(value, fallback = 'none') {
  const output = clean(value, 160).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return output || fallback;
}

function extensionForMime(mimeType) {
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'application/json': 'json', 'text/html': 'html', 'text/plain': 'txt',
    'application/pdf': 'pdf', 'application/zip': 'zip',
  };
  return map[clean(mimeType, 128).toLowerCase()] || 'bin';
}

function buildObjectKey(config, input = {}) {
  const created = input.createdAt ? new Date(input.createdAt) : new Date();
  const year = String(created.getUTCFullYear());
  const month = String(created.getUTCMonth() + 1).padStart(2, '0');
  const customer = safeSegment(input.customerId, 'unassigned');
  const job = safeSegment(input.reconJobId, 'no-job');
  const artifact = safeSegment(input.artifactId, crypto.randomUUID());
  const ext = extensionForMime(input.contentType);
  return path.posix.join(config.privatePrefix, year, month, customer, job, `${artifact}.${ext}`);
}

function retentionMarker(value, fallback = 'pending-review') {
  return safeSegment(value, fallback).replace(/_/g, '-').toLowerCase();
}

function retentionTags(retentionClass, sensitivity) {
  return new URLSearchParams({
    'divedeep-retention': retentionMarker(retentionClass),
    'divedeep-sensitivity': retentionMarker(sensitivity, 'standard'),
  }).toString();
}

function checksumBase64(hex) {
  if (!/^[a-f0-9]{64}$/i.test(String(hex || ''))) throw statusError('Artifact SHA-256 must contain 64 hexadecimal characters');
  return Buffer.from(hex, 'hex').toString('base64');
}

function putEncryption(config) {
  if (config.encryptionMode === 'sse_s3') return { ServerSideEncryption: 'AES256' };
  if (config.encryptionMode === 'sse_kms') return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyId };
  return {};
}

async function createUploadAuthorization(input, pool = null) {
  const { runtime, sdk, client } = await createClient(pool);
  const config = runtime.config;
  const objectKey = input.objectKey || buildObjectKey(config, input);
  const checksum = checksumBase64(input.sha256);
  const commandInput = {
    Bucket: config.bucket,
    Key: objectKey,
    ContentType: input.contentType,
    ContentLength: input.byteSize,
    CacheControl: 'private, no-store, max-age=0',
    Metadata: { sha256: String(input.sha256).toLowerCase(), artifactid: String(input.artifactId) },
    ...(config.objectTaggingEnabled ? { Tagging: retentionTags(input.retentionClass, input.sensitivity) } : {}),
    ...putEncryption(config),
    ...(config.checksumMode === 'sha256_header' ? { ChecksumSHA256: checksum } : {}),
  };
  const command = new sdk.PutObjectCommand(commandInput);
  const url = await sdk.getSignedUrl(client, command, { expiresIn: config.uploadUrlSeconds });
  const headers = {
    'content-type': input.contentType,
    'cache-control': 'private, no-store, max-age=0',
    'x-amz-meta-sha256': String(input.sha256).toLowerCase(),
    'x-amz-meta-artifactid': String(input.artifactId),
  };
  if (commandInput.Tagging) headers['x-amz-tagging'] = commandInput.Tagging;
  if (config.checksumMode === 'sha256_header') headers['x-amz-checksum-sha256'] = checksum;
  if (config.encryptionMode === 'sse_s3') headers['x-amz-server-side-encryption'] = 'AES256';
  if (config.encryptionMode === 'sse_kms') {
    headers['x-amz-server-side-encryption'] = 'aws:kms';
    headers['x-amz-server-side-encryption-aws-kms-key-id'] = config.kmsKeyId;
  }
  return {
    provider: 's3', bucket: config.bucket, objectKey, url, method: 'PUT', headers,
    expiresAt: new Date(Date.now() + config.uploadUrlSeconds * 1000).toISOString(),
    checksumMode: config.checksumMode,
  };
}

async function headObject(input, pool = null) {
  const { runtime, sdk, client } = await createClient(pool);
  const response = await client.send(new sdk.HeadObjectCommand({ Bucket: input.bucket || runtime.config.bucket, Key: input.objectKey, ChecksumMode: 'ENABLED' }));
  return {
    byteSize: Number(response.ContentLength) || 0,
    contentType: response.ContentType || '',
    etag: clean(response.ETag, 255).replace(/^"|"$/g, ''),
    checksumSha256: response.ChecksumSHA256 || null,
    metadata: response.Metadata || {},
    versionId: response.VersionId || null,
    lastModified: response.LastModified || null,
  };
}

async function createDownloadAuthorization(input, pool = null) {
  const { runtime, sdk, client } = await createClient(pool);
  const command = new sdk.GetObjectCommand({
    Bucket: input.bucket || runtime.config.bucket,
    Key: input.objectKey,
    ...(input.versionId ? { VersionId: input.versionId } : {}),
    ResponseCacheControl: 'private, no-store, max-age=0',
    ResponseContentDisposition: input.contentDisposition || 'inline',
  });
  const url = await sdk.getSignedUrl(client, command, { expiresIn: runtime.config.downloadUrlSeconds });
  return { url, expiresAt: new Date(Date.now() + runtime.config.downloadUrlSeconds * 1000).toISOString() };
}


async function updateRetentionTags(input, pool = null) {
  const { runtime, sdk, client } = await createClient(pool);
  if (!runtime.config.objectTaggingEnabled) {
    return { updated: false, reason: 'object_tagging_disabled' };
  }
  const response = await client.send(new sdk.PutObjectTaggingCommand({
    Bucket: input.bucket || runtime.config.bucket,
    Key: input.objectKey,
    ...(input.versionId ? { VersionId: input.versionId } : {}),
    Tagging: {
      TagSet: [
        { Key: 'divedeep-retention', Value: retentionMarker(input.retentionMarker || input.retentionClass) },
        { Key: 'divedeep-sensitivity', Value: retentionMarker(input.sensitivity, 'standard') },
      ],
    },
  }));
  return { updated: true, versionId: response.VersionId || input.versionId || null };
}

async function deleteObject(input, pool = null) {
  const { runtime, sdk, client } = await createClient(pool);
  const response = await client.send(new sdk.DeleteObjectCommand({
    Bucket: input.bucket || runtime.config.bucket,
    Key: input.objectKey,
    ...(input.versionId ? { VersionId: input.versionId } : {}),
  }));
  return { deleted: true, versionId: response.VersionId || input.versionId || null, deleteMarker: Boolean(response.DeleteMarker) };
}

async function verifyAccess(pool = null) {
  const started = Date.now();
  const { runtime, sdk, client } = await createClient(pool);
  const response = await client.send(new sdk.HeadBucketCommand({ Bucket: runtime.config.bucket }));
  return {
    ok: true,
    bucket: runtime.config.bucket,
    region: runtime.config.region,
    endpoint: runtime.config.endpoint || null,
    requestId: response.$metadata?.requestId || null,
    latencyMs: Date.now() - started,
    checkedAt: new Date().toISOString(),
  };
}

function lifecyclePolicyTemplate(configInput = {}) {
  const config = normalizeConfig({ driver: 's3', bucket: configInput.bucket || 'PRIVATE_BUCKET', ...configInput });
  const rules = config.objectTaggingEnabled ? [
    { ID: 'divedeep-transient-nonmatch', Status: 'Enabled', Filter: { Tag: { Key: 'divedeep-retention', Value: 'transient-nonmatch' } }, Expiration: { Days: 1 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
    { ID: 'divedeep-failed-upload', Status: 'Enabled', Filter: { Tag: { Key: 'divedeep-retention', Value: 'failed-upload' } }, Expiration: { Days: 1 } },
    { ID: 'divedeep-pending-review', Status: 'Enabled', Filter: { Tag: { Key: 'divedeep-retention', Value: 'pending-review' } }, Expiration: { Days: 30 } },
  ] : [];
  return {
    note: config.objectTaggingEnabled
      ? 'Application deletion remains authoritative. Tag-based lifecycle rules are a provider safety net. Holds and extensions replace the lifecycle tag before the original deadline.'
      : 'Object tagging is disabled for this provider. Do not install class-based lifecycle rules; the DiveDeep deletion scheduler remains authoritative.',
    bucket: config.bucket,
    objectTaggingEnabled: config.objectTaggingEnabled,
    rules,
  };
}

module.exports = {
  normalizeConfig,
  buildObjectKey,
  checksumBase64,
  retentionTags,
  retentionMarker,
  createUploadAuthorization,
  createDownloadAuthorization,
  headObject,
  updateRetentionTags,
  deleteObject,
  verifyAccess,
  lifecyclePolicyTemplate,
};
