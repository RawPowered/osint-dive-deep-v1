'use strict';
const assert = require('assert/strict');
process.env.DIVEDEEP_WORKER_TOKEN_SECRET = 'phase4-test-secret-that-is-longer-than-thirty-two-characters';
const tokens = require('../src/services/diveDeepWorkerTokens');

const now = Date.UTC(2026, 6, 25, 12, 0, 0);
const claims = {
  workerId: 'worker-1', jobId: 'job-1', leaseId: 'lease-1', executionId: 'execution-1',
  poolVersionId: 'pool-version-1', scopes: ['manifest:read', 'heartbeat:write'],
};
const token = tokens.issueWorkerToken(claims, 600, now);
assert.equal(token.split('.').length, 2);
const verified = tokens.verifyWorkerToken(token, { now: now + 1000 });
assert.equal(verified.workerId, claims.workerId);
assert.equal(verified.jobId, claims.jobId);
assert.deepEqual(verified.scopes, claims.scopes);
assert.throws(() => tokens.verifyWorkerToken(`${token.slice(0, -1)}x`, { now }), /signature|invalid/i);
assert.throws(() => tokens.verifyWorkerToken(token, { now: now + 601000 }), /expired/i);
const opaque = tokens.issueOpaqueToken(40);
assert.ok(opaque.length >= 40);
assert.match(tokens.hashOpaqueToken(opaque), /^[a-f0-9]{64}$/);
console.log('DiveDeep Phase 4 worker-token checks passed');
