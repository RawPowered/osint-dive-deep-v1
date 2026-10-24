const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'mysql2/promise') return { createPool() { throw new Error('Database access is not part of this integration contract test'); } };
  return originalLoad(request, parent, isMain);
};
const {
  publicIntegration,
  sanitizeConfig,
  PROVIDERS,
} = require('../src/services/diveDeepIntegrations');

assert.deepEqual(Object.keys(PROVIDERS), [
  'stripe', 'transactional_email', 'meta', 'object_storage', 'google_cloud_run', 'aws_rekognition', 'divedeep_export',
]);

const stripe = publicIntegration({
  provider: 'stripe',
  config_json: JSON.stringify({ publishableKey: 'pk_live_public' }),
  secrets_enc: 'this-value-must-never-be-returned',
  secret_hints_json: JSON.stringify({ secretKey: '••••1234', webhookSecret: '••••9876' }),
  is_enabled: 1,
  verification_status: 'configured',
  verification_message: 'Ready',
});

assert.equal(stripe.config.publishableKey, 'pk_live_public');
assert.equal(stripe.secrets[0].configured, true);
assert.equal(stripe.secrets[0].hint, '••••1234');
assert.equal(JSON.stringify(stripe).includes('this-value-must-never-be-returned'), false);

assert.throws(
  () => sanitizeConfig('stripe', { publishableKey: 'pk_test_ok', secretKey: 'sk_test_leak' }),
  /protected secret/
);
assert.throws(
  () => sanitizeConfig('meta', { graphVersion: 'latest' }),
  /Graph version/
);
assert.throws(
  () => sanitizeConfig('meta', { graphVersion: 'v24.0', redirectUri: 'http://example.com/callback' }),
  /HTTPS/
);
assert.throws(
  () => sanitizeConfig('meta', { graphVersion: 'v24.0', redirectUri: 'https://api.example.com/divedeep/connect/facebook/signup' }),
  /callback path/
);
const meta = sanitizeConfig('meta', {
  graphVersion: 'v24.0',
  redirectUri: 'https://api.example.com/divedeep/connect/facebook/callback',
  albumImportEnabled: true,
  postImportEnabled: true,
  instagramMediaImportEnabled: true,
});
assert.equal(meta.albumImportEnabled, true);
assert.equal(meta.postImportEnabled, true);
assert.equal(meta.instagramMediaImportEnabled, true);


const cloudRun = sanitizeConfig('google_cloud_run', {
  credentialMode: 'application_default', projectId: 'divedeep-prod1', region: 'us-east1', jobName: 'divedeep-divedeep', dispatchEnabled: false,
});
assert.equal(cloudRun.projectId, 'divedeep-prod1');
assert.throws(() => sanitizeConfig('google_cloud_run', { projectId: 'bad project', region: 'us-east1', jobName: 'divedeep-divedeep' }), /project ID/i);

Module._load = originalLoad;
console.log('DiveDeep integration security tests passed');
