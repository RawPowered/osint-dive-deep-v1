const assert = require('assert/strict');
const imports = require('../src/services/diveDeepImports');
const { normalizeManifest, summarizeFindingErrors, compactImportResult, compactStoredError } = imports;
assert.equal(typeof imports.importBatchStatus, 'function');
assert.equal(typeof imports.enqueueImportBundle, 'function');
assert.equal(typeof imports.resumeImportBundleJob, 'function');
assert.equal(typeof imports.resumePendingImportJobs, 'function');
assert.equal(typeof imports.setFindingsPublication, 'function');

const customerId = 'customer-1';
const profileId = 'profile-1';
const manifest = normalizeManifest({
  packetType: 'divedeep.recon-result-manifest',
  schemaVersion: 1,
  batchId: 'batch-1',
  customerId,
  profileId,
  parts: [{ partNumber: 1, fileName: 'findings/findings-0001.json', sha256: 'a'.repeat(64), byteSize: 400, findingCount: 1, findingKeys: ['finding-1'] }],
  evidence: [{ evidenceId: 'ev_1', fileName: 'evidence/ev_1.jpg', sha256: 'b'.repeat(64), byteSize: 120, mimeType: 'image/jpeg', evidenceType: 'candidate_image', findingKeys: ['finding-1'] }],
}, customerId, profileId);
assert.equal(manifest.parts[0].partNumber, 1);
assert.equal(manifest.evidence[0].uploadRequired, true);
assert.equal(manifest.findingCount, 1);
assert.throws(() => normalizeManifest({ ...manifest, customerId: 'other' }, customerId, profileId), /different customer/i);
assert.throws(() => normalizeManifest({ ...manifest, parts: [{ ...manifest.parts[0], fileName: '../escape.json' }] }, customerId, profileId), /unsafe file/i);

assert.throws(() => normalizeManifest({
  ...manifest,
  parts: [{ ...manifest.parts[0], partNumber: 2, fileName: 'findings/findings-0002.json' }],
}, customerId, profileId), /contiguous/i);
assert.throws(() => normalizeManifest({
  ...manifest,
  parts: [{ ...manifest.parts[0], partNumber: 2, fileName: 'findings/findings-0001.json' }],
}, customerId, profileId), /does not match its file name/i);
assert.throws(() => normalizeManifest({
  ...manifest,
  evidence: [{ ...manifest.evidence[0], findingKeys: ['unknown-finding'] }],
}, customerId, profileId), /not declared/i);
assert.throws(() => normalizeManifest({
  ...manifest,
  parts: [
    manifest.parts[0],
    { ...manifest.parts[0], partNumber: 2, fileName: 'findings/findings-0002.json', sha256: 'c'.repeat(64), findingKeys: ['finding-1'] },
  ],
}, customerId, profileId), /duplicate finding keys/i);

const aliasManifest = normalizeManifest({
  packetType: 'divedeep.recon-result-manifest',
  schemaVersion: 1,
  batchId: 'batch-alias',
  customerId,
  profileId,
  parts: [{ fileName: 'findings/findings-0001.json', sha256: 'd'.repeat(64), byteSize: 400, findingCount: 1, findingKeys: ['finding-alias'] }],
  evidence: [{ evidenceId: 'ev_alias', fileName: 'evidence/ev_alias.jpg', sha256: 'e'.repeat(64), byteSize: 120, mimeType: 'image/jpg; charset=binary', uploadRequired: false, evidenceType: 'candidate_image', findingKeys: ['finding-alias'] }],
}, customerId, profileId);
assert.equal(aliasManifest.evidence[0].mimeType, 'image/jpeg');
assert.equal(aliasManifest.evidence[0].uploadRequired, true);

const diagnostic = summarizeFindingErrors([
  { index: 0, findingKey: 'one', code: 'BAD_URL', error: 'Listing URL is invalid' },
  { index: 1, findingKey: 'two', code: 'BAD_URL', error: 'Listing URL is invalid' },
  { index: 2, findingKey: 'three', code: 'OTHER', error: 'Other failure' },
]);
assert.equal(diagnostic.count, 3);
assert.equal(diagnostic.summary[0].count, 2);
assert.match(diagnostic.lastError, /2x \[BAD_URL\]/);
const compact = compactImportResult({ imported: [{ findingKey: 'ok' }], errors: Array.from({ length: 30 }, (_, index) => ({ index, findingKey: `bad-${index}`, code: 'BAD', error: 'Failed' })), received: 31 });
assert.equal(compact.errorCount, 30);
assert.equal(compact.errors.length, 25);
assert.equal(compact.received, 31);

console.log('DiveDeep segmented import validation tests passed');

assert.equal(compactStoredError('Profile URL is required; Profile URL is required; Other failure'), '2x Profile URL is required; Other failure');
