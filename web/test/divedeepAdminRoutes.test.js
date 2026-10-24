const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { createAdminDiveDeepRouter } = require('../src/routes/adminDiveDeep');

const customer = {
  id: 'customer-1', email: 'alpha@example.com', displayName: 'Alpha Tester',
  planTier: 'deep', status: 'active', workflowStatus: 'intake_ready',
};
const dashboard = { customer, profile: { id: 'profile-1', identifiers: [], policies: [] }, connections: [], photos: [], exposures: [], cases: [], events: [], stats: {} };
const calls = [];
const csrfToken = 'divedeep-admin-csrf-test-token-000001';
const service = {
  listCustomers: async () => [customer],
  getAdminOverview: async () => ({ metrics: { activeCustomers: 1 }, workflow: { intake_ready: 1 }, cases: {}, exports: {} }),
  getCustomerDashboard: async (id) => { calls.push(['detail', id]); return dashboard; },
  adminUpdateCustomer: async (id, body, actor) => { calls.push(['update', id, body, actor]); return { ...customer, ...body }; },
  exportCustomerPacket: async (id, format) => ({ contentType: 'application/json', extension: format === 'json' ? 'json' : format, body: '{}' }),
  getCustomerById: async () => customer,
  adminAddFinding: async (id, body, actor) => { calls.push(['finding', id, body, actor]); return { exposure: { id: 'exposure-1' }, case: null }; },
  adminUpdateFinding: async (id, exposureId, body, actor) => { calls.push(['finding-update', id, exposureId, body, actor]); return { id: exposureId, status: body.status }; },
  adminTransitionPrivacyCase: async () => ({ id: 'case-1', state: 'sent' }),
  adminVerifyPrivacyCase: async () => ({ id: 'verification-1', result: 'removed' }),
  importDiveDeepResultPacket: async (id, body, actor) => { calls.push(['divedeep-import', id, body, actor]); return { imported: [{ exposureId: 'exposure-2' }], errors: [], received: 1 }; },
  readProfilePhoto: async () => ({ photo: { id: 'photo-1', mimeType: 'image/jpeg' }, buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }),
};
const importService = {
  listImportBatches: async () => [{ id: 'batch-1', status: 'created' }],
  createImportBatch: async (id, manifest, sha, actor) => { calls.push(['batch-create', id, manifest, sha, actor]); return { id: 'batch-1', status: 'created' }; },
  batchDetail: async () => ({ id: 'batch-1', status: 'ready_review' }),
  importBatchPart: async (id, batchId, part, body, raw, sha, actor) => {
    calls.push(['batch-part', id, batchId, part, body, sha, actor]);
    if (String(part) === '2') return { result: { imported: [], errors: [{ error: 'Invalid listing URL' }], errorCount: 1 }, batch: { id: batchId, status: 'failed' } };
    if (String(part) === '3') return { result: { imported: [{ exposureId: 'exposure-3' }], errors: [{ error: 'Invalid listing URL' }], errorCount: 1 }, batch: { id: batchId, status: 'failed' } };
    return { result: { imported: [], errors: [], errorCount: 0 }, batch: { id: batchId, status: 'importing' } };
  },
  uploadBatchEvidence: async (id, batchId, evidenceId, file, actor) => { calls.push(['batch-evidence', id, batchId, evidenceId, file.mimeType, actor]); return { id: batchId, status: 'importing' }; },
  finalizeImportBatch: async () => ({ id: 'batch-1', status: 'ready_review' }),
  publishImportBatch: async () => ({ id: 'batch-1', status: 'published' }),
  cancelImportBatch: async () => ({ id: 'batch-1', status: 'cancelled' }),
  setFindingPublication: async (id, exposureId, status, actor) => ({ customerId: id, exposureId, publicationStatus: status, actor }),
  readEvidenceFile: async () => ({ evidence: { id: 'evidence-1', mimeType: 'image/jpeg' }, buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }),
  cleanupExpiredImports: async () => ({ expiredBatches: 0, deletedEvidence: 0 }),
};

const catalogService = {
  getCatalogBundle: async () => ({
    summary: { resources: { active: 1, domains: 1 }, pools: { active: 1 }, sourceSets: { active: 1 }, packageVersions: { published: 1 } },
    schemas: [{ id: 'schema-1', name: 'Website Source', version: 1, status: 'published' }],
    resources: [{ id: 'resource-1', name: 'Example Source', primaryDomain: 'example.com', status: 'active' }],
    pools: [{ id: 'pool-1', name: 'Mainstream Social', versions: [] }],
    sourceSets: [{ id: 'set-1', name: 'Standard Coverage', versions: [] }],
    packageVersions: [{ id: 'package-version-1', packageId: 'standard', version: 1, status: 'published' }],
  }),
  listResourceRevisions: async (id) => [{ id: 'revision-1', resourceId: id, revision: 1 }],
  resolvePackageSourceManifest: async (id, version) => ({ package: { packageId: id, version: Number(version) || 1 }, sourceSet: { id: 'set-1', version: 1 }, pools: [], resources: [] }),
  createMetadataSchema: async (body, actor) => { calls.push(['catalog-schema-create', body, actor]); return { id: 'schema-2', ...body }; },
  updateMetadataSchema: async (id, body, actor) => ({ id, ...body, actor }),
  createResource: async (body, actor) => { calls.push(['catalog-resource-create', body, actor]); return { id: 'resource-2', ...body }; },
  updateResource: async (id, body, actor) => ({ id, ...body, actor }),
  createPool: async (body, actor) => ({ id: 'pool-2', ...body, actor }),
  createPoolVersion: async (id, body, actor) => ({ id: 'pool-version-2', poolId: id, ...body, actor }),
  updatePoolVersion: async (id, body, actor) => ({ id, ...body, actor }),
  replacePoolMembers: async (id, members, actor) => ({ versionId: id, memberCount: members.length, actor }),
  publishPoolVersion: async (id, actor) => ({ id, status: 'published', actor }),
  createSourceSet: async (body, actor) => ({ id: 'source-set-2', ...body, actor }),
  createSourceSetVersion: async (id, body, actor) => ({ id: 'source-set-version-2', sourceSetId: id, ...body, actor }),
  updateSourceSetVersion: async (id, body, actor) => ({ id, ...body, actor }),
  replaceSourceSetLinks: async (id, body, actor) => ({ versionId: id, ...body, actor }),
  publishSourceSetVersion: async (id, actor) => ({ id, status: 'published', actor }),
  createPackageVersion: async (id, body, actor) => ({ id: 'package-version-2', packageId: id, ...body, actor }),
  publishPackageVersion: async (id, actor) => ({ id, status: 'published', actor }),
};
const integrationService = {
  listIntegrations: async () => [{ provider: 'stripe', configured: true, secrets: [{ field: 'secretKey', configured: true, hint: '••••1234' }] }],
  saveIntegration: async (provider, body, actor) => { calls.push(['integration-save', provider, body, actor]); return { provider, configured: true, secrets: [{ field: 'secretKey', configured: true, hint: '••••1234' }] }; },
  verifyIntegration: async (provider, actor) => ({ provider, actor, verificationStatus: 'configured' }),
  disableIntegration: async (provider, actor) => ({ provider, actor, enabled: false }),
  listIntegrationEvents: async () => [{ provider: 'stripe', eventType: 'integration.updated', details: {}, createdAt: new Date().toISOString() }],
};

async function request(base, pathname, options = {}, cookie = '') {
  const headers = { 'X-Admin-CSRF': csrfToken, ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  return fetch(base + pathname, { ...options, headers, redirect: 'manual' });
}

async function run() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'divedeep-admin-route-test-secret-00000', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => {
    const principalType = req.get('x-test-principal') === 'platform' ? 'platform' : 'root';
    req.session.admin = { id: 'admin-1', username: principalType, role: principalType === 'root' ? 'admin' : 'platform_operator', principalType };
    req.session.adminCsrf = csrfToken;
    next();
  });
  app.use('/private-control', createAdminDiveDeepRouter({ service, integrationService, importService, catalogService, workflowService: { reconcileReviewTasks: async () => ({}), evaluateCustomer: async () => ({}) } }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const list = await request(base, '/private-control/api/divedeep/customers');
    assert.equal(list.status, 200);
    assert.equal((await list.json()).customers.length, 1);

    const overview = await request(base, '/private-control/api/divedeep/overview');
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).overview.metrics.activeCustomers, 1);

    const detail = await request(base, '/private-control/api/divedeep/customers/customer-1');
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).dashboard.customer.id, 'customer-1');

    const catalog = await request(base, '/private-control/api/divedeep/catalog');
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).catalog.resources[0].primaryDomain, 'example.com');

    const manifest = await request(base, '/private-control/api/divedeep/packages/standard/source-manifest?version=1');
    assert.equal(manifest.status, 200);
    assert.equal((await manifest.json()).manifest.package.version, 1);

    const resourceCreate = await request(base, '/private-control/api/divedeep/catalog/resources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second Source', resourceType: 'website', metadata: {} }),
    });
    assert.equal(resourceCreate.status, 201);
    assert.equal(calls.find((item) => item[0] === 'catalog-resource-create')[2], 'admin-1');

    const oldNodeRoute = await request(base, '/private-control/api/divedeep/divedeep/nodes');
    assert.equal(oldNodeRoute.status, 404);

    const update = await request(base, '/private-control/api/divedeep/customers/customer-1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowStatus: 'researching' }),
    });
    assert.equal(update.status, 200);
    assert.equal(calls.find((item) => item[0] === 'update')[3], 'admin-1');

    const exported = await request(base, '/private-control/api/divedeep/customers/customer-1/export?format=json');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /divedeep-alpha-tester\.json/);

    const finding = await request(base, '/private-control/api/divedeep/customers/customer-1/findings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceName: 'Example', listingUrl: 'https://example.com/profile' }),
    });
    assert.equal(finding.status, 201);

    const batchCreate = await request(base, '/private-control/api/divedeep/customers/customer-1/import-batches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: { batchId: 'source-1' }, manifestSha256: 'a'.repeat(64) }),
    });
    assert.equal(batchCreate.status, 201);

    const batchList = await request(base, '/private-control/api/divedeep/customers/customer-1/import-batches');
    assert.equal(batchList.status, 200);

    const batchPart = await request(base, '/private-control/api/divedeep/customers/customer-1/import-batches/batch-1/parts/1', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DiveDeep-File-SHA256': 'b'.repeat(64) }, body: JSON.stringify({ packetType: 'divedeep.recon-results' }),
    });
    assert.equal(batchPart.status, 200);

    const batchPartFailed = await request(base, '/private-control/api/divedeep/customers/customer-1/import-batches/batch-1/parts/2', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DiveDeep-File-SHA256': 'b'.repeat(64) }, body: JSON.stringify({ packetType: 'divedeep.recon-results' }),
    });
    assert.equal(batchPartFailed.status, 422);
    const batchPartFailedBody = await batchPartFailed.json();
    assert.equal(batchPartFailedBody.code, 'DIVEDEEP_IMPORT_PART_FINDINGS_FAILED');
    assert.equal(batchPartFailedBody.batch.status, 'failed');

    const batchPartPartial = await request(base, '/private-control/api/divedeep/customers/customer-1/import-batches/batch-1/parts/3', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DiveDeep-File-SHA256': 'b'.repeat(64) }, body: JSON.stringify({ packetType: 'divedeep.recon-results' }),
    });
    assert.equal(batchPartPartial.status, 207);
    assert.equal((await batchPartPartial.json()).code, 'DIVEDEEP_IMPORT_PART_PARTIAL_FAILURE');

    const evidenceUpload = await request(base, '/private-control/api/divedeep/customers/customer-1/import-batches/batch-1/evidence/ev-1', {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-DiveDeep-File-SHA256': 'c'.repeat(64) }, body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(evidenceUpload.status, 201);

    const finalized = await request(base, '/private-control/api/divedeep/customers/customer-1/import-batches/batch-1/finalize', { method: 'POST', body: '{}' });
    assert.equal(finalized.status, 200);
    const published = await request(base, '/private-control/api/divedeep/customers/customer-1/import-batches/batch-1/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(published.status, 200);
    const cancelled = await request(base, '/private-control/api/divedeep/customers/customer-1/import-batches/batch-1/cancel', { method: 'POST', body: '{}' });
    assert.equal(cancelled.status, 200);
    const publication = await request(base, '/private-control/api/divedeep/customers/customer-1/findings/exposure-1/publication', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicationStatus: 'published' }) });
    assert.equal(publication.status, 200);
    const evidence = await request(base, '/private-control/api/divedeep/customers/customer-1/evidence/evidence-1');
    assert.equal(evidence.status, 200);

    const importedResults = await request(base, '/private-control/api/divedeep/customers/customer-1/divedeep-results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, packetType: 'divedeep.recon-results', source: { customerId: 'customer-1', profileId: 'profile-1' }, findings: [] }),
    });
    assert.equal(importedResults.status, 200);
    assert.equal(calls.find((item) => item[0] === 'divedeep-import')[3], 'admin-1');

    const findingUpdate = await request(base, '/private-control/api/divedeep/customers/customer-1/findings/exposure-1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'confirmed' }),
    });
    assert.equal(findingUpdate.status, 200);

    const integrations = await request(base, '/private-control/api/divedeep/integrations');
    const integrationPayload = await integrations.json();
    assert.equal(integrations.status, 200);
    assert.equal(integrationPayload.integrations[0].secrets[0].hint, '••••1234');
    assert.equal(JSON.stringify(integrationPayload).includes('sk_live'), false);

    const saveIntegration = await request(base, '/private-control/api/divedeep/integrations/stripe', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { publishableKey: 'pk_live_example' }, secrets: { secretKey: 'sk_live_hidden' } }),
    });
    assert.equal(saveIntegration.status, 200);
    assert.equal(calls.find((item) => item[0] === 'integration-save')[3], 'admin-1');

    const platformDenied = await request(base, '/private-control/api/divedeep/integrations', {
      headers: { 'X-Test-Principal': 'platform' },
    });
    assert.equal(platformDenied.status, 403);

    const invalidCsrf = await request(base, '/private-control/api/divedeep/integrations/stripe', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Admin-CSRF': 'wrong-token' }, body: '{}',
    });
    assert.equal(invalidCsrf.status, 403);

    const photo = await request(base, '/private-control/api/divedeep/customers/customer-1/photos/photo-1');
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('DiveDeep admin route tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
