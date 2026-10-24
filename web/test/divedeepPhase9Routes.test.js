'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const apiIndex = fs.readFileSync(path.join(root, 'src/routes/api/index.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const customer = fs.readFileSync(path.join(root, 'src/routes/api/diveDeepCustomerV1.js'), 'utf8');
const enterprise = fs.readFileSync(path.join(root, 'src/routes/api/diveDeepEnterpriseV1.js'), 'utf8');
const integrations = fs.readFileSync(path.join(root, 'src/routes/api/diveDeepIntegrationsV1.js'), 'utf8');
const workers = fs.readFileSync(path.join(root, 'src/routes/api/diveDeepWorkers.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'src/middleware/diveDeepExternalApiAuth.js'), 'utf8');

for (const route of ["'/customer/v1'", "'/enterprise/v1'", "'/integrations/v1'", "'/workers/v1'"]) {
  assert.ok(apiIndex.includes(route), `Missing API boundary ${route}`);
}
assert.ok(apiIndex.indexOf("'/customer/v1'") < apiIndex.indexOf('router.use(apiKeyAuth)'), 'Customer v1 must use service identity auth before legacy API auth');
assert.ok(apiIndex.indexOf("'/enterprise/v1'") < apiIndex.indexOf('router.use(apiKeyAuth)'), 'Enterprise v1 must use service identity auth before legacy API auth');
assert.match(app, /app\.use\('\/api\/admin\/divedeep'/);
assert.match(app, /X-DiveDeep-API-Version/);
assert.match(workers, /requireDiveDeepWorker/);
assert.match(customer, /identityTypes:\s*\['customer'\]/);
assert.match(enterprise, /identityTypes:\s*\['enterprise'\]/);
assert.match(integrations, /identityTypes:\s*\['integration'\]/);
assert.match(integrations, /\/oauth\/token/);
assert.match(integrations, /requireIdempotency/);
assert.match(auth, /DIVEDEEP_API_SURFACE_DENIED/);
assert.match(server, /runWebhookSweep/);
assert.match(server, /DIVEDEEP_WEBHOOK_SWEEP_ENABLED/);

for (const source of [customer, enterprise, integrations]) {
  assert.doesNotMatch(source, /diveDeepArtifacts|diveDeepObjectStorage|diveDeepImports|readAuthorizationDocument|getJobManifest/i);
}
for (const endpoint of ['reports/removals', 'reports/monitoring']) assert.ok(customer.includes(endpoint));
for (const endpoint of ['coverage', 'reports/removals', 'reports/monitoring']) assert.ok(enterprise.includes(endpoint));
console.log('DiveDeep Phase 9 route boundary checks passed');
