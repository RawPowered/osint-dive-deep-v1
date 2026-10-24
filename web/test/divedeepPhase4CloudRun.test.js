'use strict';
const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === './diveDeepIntegrations' && parent?.filename?.endsWith('diveDeepCloudRun.js')) return { getRuntimeIntegration: async () => null };
  if (request === '../config' && parent?.filename?.endsWith('diveDeepCloudRun.js')) return { getDiveDeepConfig: () => ({ apiOrigin: 'https://api.divedeep.example' }) };
  return originalLoad(request, parent, isMain);
};
const cloudRun = require('../src/services/diveDeepCloudRun');
const config = cloudRun.normalizeConfig({ projectId: 'divedeep-prod1', region: 'us-east1', jobName: 'divedeep-worker' });
const overrides = cloudRun.executionOverrides(config, {
  jobId: 'job-123', executionId: 'execution-123', poolVersionId: 'pool-version-123',
  bootstrapToken: 'one-time-job-bootstrap', taskCount: 1,
});
const env = Object.fromEntries(overrides.containerOverrides[0].env.map((item) => [item.name, item.value]));
assert.equal(overrides.taskCount, 1);
assert.equal(config.defaultMaxRetries, 0);
assert.equal(env.DIVEDEEP_RECON_JOB_ID, 'job-123');
assert.equal(env.DIVEDEEP_RECON_EXECUTION_ID, 'execution-123');
assert.equal(env.DIVEDEEP_WORKER_POOL_VERSION_ID, 'pool-version-123');
assert.equal(env.DIVEDEEP_WORKER_BOOTSTRAP_TOKEN, 'one-time-job-bootstrap');
assert.equal(env.DIVEDEEP_API_ORIGIN, 'https://api.divedeep.example');
for (const prohibited of ['CUSTOMER_NAME', 'CUSTOMER_EMAIL', 'AWS_ACCESS_KEY_ID', 'DIVEDEEP_API_KEY', 'REFERENCE_IMAGE']) {
  assert.equal(Object.prototype.hasOwnProperty.call(env, prohibited), false);
}
assert.throws(() => cloudRun.executionOverrides(config, { jobId: 'job-123', taskCount: 2 }), /single Cloud Run task/i);
assert.throws(() => cloudRun.normalizeConfig({ projectId: 'divedeep-prod1', region: 'us-east1', jobName: 'divedeep-worker', defaultMaxRetries: 1 }), /zero Cloud Run task retries/i);
Module._load = originalLoad;
console.log('DiveDeep Phase 4 Cloud Run override checks passed');
