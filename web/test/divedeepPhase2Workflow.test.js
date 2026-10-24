'use strict';
const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === '../db/pool' && parent?.filename?.endsWith('diveDeepWorkflow.js')) return { getPool() { throw new Error('Database not expected'); } };
  return originalLoad(request, parent, isMain);
};
const workflow = require('../src/services/diveDeepWorkflow');

const dashboard = {
  customer: { id: 'customer-1', status: 'active', planTier: 'standard' },
  profile: { id: 'profile-1', identifiers: [{ type: 'name', value: 'Authorized Person' }] },
  authorization: { id: 'auth-1', status: 'active', expiresAt: '2099-01-01T00:00:00Z' },
  photos: [],
};
const manifest = {
  package: { id: 'package-version-1', packageId: 'standard', version: 1, imageAnalysisRequired: false },
  sourceSet: { id: 'standard-coverage', versionId: 'source-set-version-1', version: 1 },
};
const workerPool = { pool: { id: 'pool-1' }, version: { id: 'pool-version-1', providerConfig: { dispatchEnabled: true }, capacity: { maximum: 2, active: 0, available: 2 } } };
const providerIntegration = { config: { dispatchEnabled: true } };
const ready = workflow.evaluateDashboard(dashboard, { manifest, workerPool, providerIntegration, counts: {} });
assert.equal(ready.ready, true);
assert.equal(ready.jobCreatable, true);
assert.equal(ready.currentGate, 'execution_completion');
assert.equal(ready.gates.find((gate) => gate.key === 'capacity_assignment').status, 'pass');

const disabled = workflow.evaluateDashboard(dashboard, { manifest, providerIntegration, counts: {}, workerPool: { ...workerPool, version: { ...workerPool.version, providerConfig: { dispatchEnabled: false } } } });
assert.equal(disabled.ready, false);
assert.equal(disabled.gates.find((gate) => gate.key === 'capacity_assignment').status, 'blocked');

const fullPool = workflow.evaluateDashboard(dashboard, { manifest, providerIntegration, counts: {}, workerPool: { ...workerPool, version: { ...workerPool.version, capacity: { maximum: 2, active: 2, available: 0 } } } });
assert.equal(fullPool.ready, false);
assert.equal(fullPool.jobCreatable, true);
assert.equal(fullPool.currentGate, 'capacity_assignment');
assert.equal(fullPool.gates.find((gate) => gate.key === 'capacity_assignment').status, 'pending');

const restricted = workflow.evaluateDashboard({ ...dashboard, customer: { ...dashboard.customer, planTier: 'image' } }, {
  manifest: { ...manifest, package: { ...manifest.package, packageId: 'image', imageAnalysisRequired: true }, imageAnalysis: { required: true } },
  workerPool, providerIntegration, counts: {},
});
assert.equal(restricted.ready, false);
assert.equal(restricted.gates.find((gate) => gate.key === 'sensitive_consent').status, 'blocked');
assert.equal(restricted.gates.find((gate) => gate.key === 'reference_images').status, 'blocked');

Module._load = originalLoad;
console.log('DiveDeep Phase 2 workflow and capacity checks passed');
