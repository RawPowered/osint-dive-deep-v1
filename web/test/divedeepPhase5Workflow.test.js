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
  sourceSet: { versionId: 'source-set-version-1', version: 1 },
};
const workerPool = { version: { id: 'pool-version-1', providerConfig: { dispatchEnabled: true }, capacity: { maximum: 2, active: 0, available: 2 } } };
const providerIntegration = { config: { dispatchEnabled: true } };
const emptyCounts = {
  candidates: {}, imageItems: {}, artifacts: {}, exposures: {}, cases: {}, deliveries: {}, monitoring: {}, reviewTasks: {}, customerActions: {},
};

const ready = workflow.evaluateDashboard(dashboard, { manifest, workerPool, providerIntegration, counts: emptyCounts });
assert.equal(ready.jobCreatable, true);
assert.equal(ready.currentGate, 'execution_completion');
assert.equal(ready.gates.length, 15);

const completedNoResults = workflow.evaluateDashboard(dashboard, {
  manifest, workerPool, providerIntegration,
  job: { id: 'job-1', status: 'completed', workerPoolVersionId: 'pool-version-1' },
  counts: emptyCounts,
});
assert.equal(completedNoResults.gates.find((gate) => gate.key === 'candidate_review').status, 'waived');
assert.equal(completedNoResults.gates.find((gate) => gate.key === 'evidence_disposition').status, 'waived');
assert.equal(completedNoResults.gates.find((gate) => gate.key === 'removal_approval').status, 'waived');
assert.equal(completedNoResults.gates.find((gate) => gate.key === 'request_delivery').status, 'waived');
assert.equal(completedNoResults.closureReady, true);
assert.equal(workflow.workflowStatusForEvaluation(completedNoResults, {}), 'closure_ready');

const customerValidation = workflow.evaluateDashboard(dashboard, {
  manifest, workerPool, providerIntegration,
  job: { id: 'job-2', status: 'completed', workerPoolVersionId: 'pool-version-1' },
  counts: { ...emptyCounts, imageItems: { total: 1, open: 1, customerValidation: 1 }, customerActions: { pending: 1 } },
});
assert.equal(customerValidation.currentGate, 'candidate_review');
assert.equal(customerValidation.gates.find((gate) => gate.key === 'candidate_review').details.customerValidationRequired, true);
assert.equal(workflow.workflowStatusForEvaluation(customerValidation, {}), 'awaiting_customer_validation');

const completedWithRemoval = workflow.evaluateDashboard(dashboard, {
  manifest, workerPool, providerIntegration,
  job: { id: 'job-3', status: 'completed', workerPoolVersionId: 'pool-version-1' },
  counts: {
    ...emptyCounts,
    candidates: { total: 1, confirmed: 1 },
    artifacts: { total: 1, confirmed: 1 },
    exposures: { total: 1, confirmed: 1, removalEligible: 1 },
    cases: { total: 1, draft: 0, deliverable: 1, monitoringRequired: 1 },
    deliveries: { total: 1, completed: 1 },
    monitoring: { total: 1, completed: 1, active: 0 },
  },
});
for (const key of ['candidate_review','evidence_disposition','removal_approval','request_delivery','monitoring_activation']) {
  assert.equal(completedWithRemoval.gates.find((gate) => gate.key === key).status, 'pass', `${key} must pass`);
}
assert.equal(completedWithRemoval.closureReady, true);

const monitoringClosed = workflow.evaluateDashboard(dashboard, {
  manifest, workerPool, providerIntegration,
  job: { id: 'job-4', status: 'completed', workerPoolVersionId: 'pool-version-1' },
  workflowRun: { id: 'run-4', status: 'monitoring', outcome: 'continuing_monitoring', closedAt: '2026-07-25T00:00:00Z' },
  counts: { ...emptyCounts },
});
assert.equal(monitoringClosed.gates.find((gate) => gate.key === 'closure').status, 'pass');
assert.equal(monitoringClosed.complete, true);

Module._load = originalLoad;
console.log('DiveDeep Phase 5 workflow-gate checks passed');
