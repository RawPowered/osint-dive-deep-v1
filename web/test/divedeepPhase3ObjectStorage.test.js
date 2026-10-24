'use strict';
const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === './diveDeepIntegrations' && parent?.filename?.endsWith('diveDeepObjectStorage.js')) {
    return { getRuntimeIntegration() { throw new Error('Runtime integration not expected in static test'); } };
  }
  return originalLoad(request, parent, isMain);
};
const storage = require('../src/services/diveDeepObjectStorage');

const config = storage.normalizeConfig({
  driver: 's3', credentialMode: 'static_keys', bucket: 'divedeep-private', region: 'us-east-1',
  privatePrefix: '/protected/evidence', checksumMode: 'sha256_header', encryptionMode: 'sse_kms',
  kmsKeyId: 'alias/divedeep-evidence', uploadUrlSeconds: 300, downloadUrlSeconds: 60,
});
assert.equal(config.privatePrefix, 'protected/evidence/');
assert.equal(config.checksumMode, 'sha256_header');
assert.equal(config.encryptionMode, 'sse_kms');
const key = storage.buildObjectKey(config, {
  customerId: 'customer/unsafe', reconJobId: 'job:1', artifactId: 'artifact-1', contentType: 'image/jpeg',
  createdAt: '2026-07-25T00:00:00Z',
});
assert.equal(key, 'protected/evidence/2026/07/customer-unsafe/job-1/artifact-1.jpg');
const hex = 'a'.repeat(64);
assert.equal(Buffer.from(storage.checksumBase64(hex), 'base64').toString('hex'), hex);
assert.match(storage.retentionTags('pending_review', 'sensitive'), /divedeep-retention=pending-review/);
assert.equal(storage.retentionMarker('failed_upload'), 'failed-upload');
const lifecycle = storage.lifecyclePolicyTemplate({ bucket: 'divedeep-private', region: 'us-east-1' });
assert.equal(lifecycle.rules.length, 3);
assert.equal(lifecycle.rules[0].Expiration.Days, 1);
assert.equal(lifecycle.rules[2].Expiration.Days, 30);
const r2Config = storage.normalizeConfig({ driver: 's3', bucket: 'private', region: 'auto', endpoint: 'https://example.r2.cloudflarestorage.com' });
assert.equal(r2Config.objectTaggingEnabled, false);
assert.equal(storage.lifecyclePolicyTemplate(r2Config).rules.length, 0);
assert.throws(() => storage.normalizeConfig({ driver: 'local' }), /S3-compatible/i);
assert.throws(() => storage.normalizeConfig({ driver: 's3', bucket: '', region: 'us-east-1' }), /private bucket/i);
assert.throws(() => storage.normalizeConfig({ driver: 's3', bucket: 'x', encryptionMode: 'sse_kms' }), /KMS key/i);
Module._load = originalLoad;
console.log('DiveDeep Phase 3 object-storage contract checks passed');
