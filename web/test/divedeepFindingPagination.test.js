const assert = require('assert/strict');
const Module = require('module');
const path = require('path');

const servicePath = path.join(__dirname, '..', 'src', 'services', 'diveDeep.js');
const originalLoad = Module._load;
const calls = { exposureOptions: null, evidenceOptions: null };
const profile = { id: 'profile-1', identifiers: [], policies: [] };
const fakePool = {
  query: async (sql) => {
    if (String(sql).includes('COUNT(*) total FROM divedeep_exposures')) return [[{ total: 45 }], []];
    throw new Error(`Unexpected query: ${sql}`);
  },
};

const privacyStub = {
  createProtectedProfile: async () => profile,
  listProtectedProfiles: async () => [profile],
  getProtectedProfile: async () => profile,
  addProfileIdentifier: async () => ({}),
  upsertVisibilityPolicy: async () => ({}),
  listExposures: async (customerId, options) => {
    calls.exposureOptions = { customerId, ...options };
    return Array.from({ length: 5 }, (_, index) => ({ id: `exposure-${index + 41}`, publicationStatus: 'published' }));
  },
  listCases: async () => [],
  upsertExposure: async () => ({}),
  updateExposureStatus: async () => ({}),
  createCaseFromExposure: async () => ({}),
  transitionCase: async () => ({}),
  addVerification: async () => ({}),
  exportProfilePacket: async () => ({}),
  normalizeUrl: (value) => value,
  profileUrlKey: (value) => value,
  statusError: (message, status = 400, code = 'TEST_ERROR') => Object.assign(new Error(message), { status, code }),
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'bcryptjs') return { hash: async () => 'hash', compare: async () => true };
  if (parent?.filename === servicePath) {
    if (request === '../db/pool') return { getPool: () => fakePool };
    if (request === '../config') return { getDiveDeepConfig: () => ({}), getDiveDeepMetaConfig: () => ({}) };
    if (request === './divedeepPii') {
      return {
        blindIndex: () => 'blind', encryptPii: (v) => v, decryptPii: (v) => v,
        encryptJson: (v) => JSON.stringify(v), decryptJson: (v) => v,
        normalizeIdentifier: (v) => v,
      };
    }
    if (request === './divedeepPrivacy') return privacyStub;
    if (request === './diveDeepFiles') {
      return {
        writeEncryptedPhoto: () => 'ref', readEncryptedPhoto: () => Buffer.alloc(0),
        deleteEncryptedPhoto: () => {}, sha256Buffer: () => 'a'.repeat(64),
      };
    }
    if (request === './diveDeepAuthorizations') {
      return { getLatestAuthorization: async () => null, requireActiveAuthorization: async () => ({}) };
    }
    if (request === './diveDeepImports') {
      return {
        listEvidenceFiles: async (customerId, options) => {
          calls.evidenceOptions = { customerId, ...options };
          return [{ id: 'evidence-1', exposureId: 'exposure-41' }];
        },
      };
    }
  }
  return originalLoad(request, parent, isMain);
};

try {
  delete require.cache[servicePath];
  const service = require(servicePath);
  service.getCustomerFindingPage('customer-1', { page: 3, pageSize: 20 }, fakePool).then((result) => {
    assert.equal(result.pagination.page, 3);
    assert.equal(result.pagination.pageCount, 3);
    assert.equal(result.pagination.total, 45);
    assert.equal(result.pagination.hasPrevious, true);
    assert.equal(result.pagination.hasNext, false);
    assert.equal(result.exposures.length, 5);
    assert.equal(calls.exposureOptions.offset, 40);
    assert.equal(calls.exposureOptions.limit, 20);
    assert.equal(calls.exposureOptions.publicationStatus, 'published');
    assert.deepEqual(calls.evidenceOptions.exposureIds, result.exposures.map((item) => item.id));
    console.log('DiveDeep finding pagination behavior passed');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => {
    Module._load = originalLoad;
  });
} catch (error) {
  Module._load = originalLoad;
  throw error;
}
