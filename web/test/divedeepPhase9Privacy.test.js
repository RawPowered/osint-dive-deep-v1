'use strict';
const assert = require('assert/strict');
const api = require('../src/services/diveDeepExternalApi');

const payload = api.safeEventPayload({
  lifecycleStatus: 'monitoring',
  communicationKey: 'service_update',
  counts: { open: 2, completed: 5 },
});
assert.equal(payload.lifecycleStatus, 'monitoring');
assert.throws(() => api.safeEventPayload({ evidence: { id: 'private' } }), (error) => error.code === 'DIVEDEEP_SENSITIVE_FIELD_REJECTED');
assert.throws(() => api.safeEventPayload({ sourceUrl: 'https://private.invalid' }), (error) => error.code === 'DIVEDEEP_SENSITIVE_FIELD_REJECTED');
assert.throws(() => api.safeEventPayload({ candidateConfidence: 0.99 }), (error) => error.code === 'DIVEDEEP_SENSITIVE_FIELD_REJECTED');
assert.throws(() => api.safeEventPayload({ ' padded': 'invalid' }), (error) => error.code === 'DIVEDEEP_EVENT_FIELD_INVALID');
assert.throws(() => api.safeEventPayload({ ['x'.repeat(129)]: 'invalid' }), (error) => error.code === 'DIVEDEEP_EVENT_FIELD_INVALID');

const job = api.serializeJobSummary({
  id: 'job-1', customer_id: 'customer-1', package_id: 'standard', package_version: 4,
  status: 'running', current_gate: 'research', progress_percent: 40,
  source_count: 10, source_completed_count: 4, candidate_count: 8, review_count: 2,
  confirmed_count: 1, manifest_enc: 'encrypted-private-manifest', external_execution_name: 'projects/private/job',
  authorization_document_sha256: 'private-hash', last_error_message: 'private worker detail',
  requested_at: '2026-07-25T00:00:00Z', updated_at: '2026-07-25T01:00:00Z',
});
const serialized = JSON.stringify(job);
assert.equal(job.progressPercent, 40);
for (const blocked of ['manifest', 'external_execution', 'authorization', 'last_error_message', 'private worker detail']) {
  assert.doesNotMatch(serialized, new RegExp(blocked, 'i'));
}

const replay = api.redactIdempotentResponse({
  ok: true,
  apiKey: 'fidk_secret',
  oauthClientSecret: 'fids_secret',
  signingSecret: 'fidwh_secret',
  nested: { accessToken: 'fido_secret', id: 'safe-id' },
});
assert.deepEqual(replay, { ok: true, nested: { id: 'safe-id' } });
console.log('DiveDeep Phase 9 privacy projection checks passed');
