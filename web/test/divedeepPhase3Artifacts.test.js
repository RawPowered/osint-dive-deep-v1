'use strict';
const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === '../db/pool' && parent?.filename?.endsWith('diveDeepArtifacts.js')) return { getPool() { throw new Error('Database not expected'); } };
  if (request === './divedeepPii' && parent?.filename?.endsWith('diveDeepArtifacts.js')) return { encryptJson: JSON.stringify, decryptJson: (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } } };
  if (request === './diveDeepObjectStorage' && parent?.filename?.endsWith('diveDeepArtifacts.js')) return { normalizeConfig: (v) => v };
  return originalLoad(request, parent, isMain);
};
const artifacts = require('../src/services/diveDeepArtifacts');
const now = new Date('2026-07-25T00:00:00Z');
assert.equal(artifacts.expiryForRetention('transient_nonmatch', now).toISOString(), '2026-07-26T00:00:00.000Z');
assert.equal(artifacts.expiryForRetention('pending_review', now).toISOString(), '2026-08-24T00:00:00.000Z');
assert.equal(artifacts.expiryForRetention('confirmed_relevant', now), null);
const normalized = artifacts.normalizeReservation({
  customerId: 'customer-1', reconJobId: 'job-1', artifactType: 'candidate_image', contentType: 'image/jpeg',
  byteSize: 2048, sha256: 'b'.repeat(64), sensitivity: 'sensitive', retentionClass: 'pending_review',
  accessScope: 'admin_only', metadata: { source: 'fixture' },
});
assert.equal(normalized.artifactType, 'candidate_image');
assert.equal(normalized.retentionClass, 'pending_review');
assert.equal(normalized.metadata.source, 'fixture');
assert.throws(() => artifacts.normalizeReservation({ artifactType: 'candidate_image', contentType: 'image/jpeg', byteSize: 1, sha256: 'bad' }), /SHA-256/);
assert.throws(() => artifacts.normalizeReservation({ artifactType: 'unknown', contentType: 'image/jpeg', byteSize: 1, sha256: 'b'.repeat(64) }), /artifact type/i);
assert.equal(artifacts.RETENTION_POLICIES.transient_nonmatch.hours, 24);
assert.equal(artifacts.RETENTION_POLICIES.pending_review.days, 30);
assert.equal(typeof artifacts.expireUploadSessions, 'function');
Module._load = originalLoad;
console.log('DiveDeep Phase 3 artifact policy checks passed');
