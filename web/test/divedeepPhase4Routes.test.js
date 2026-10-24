'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const routes = fs.readFileSync(path.join(root, 'src/routes/api/diveDeepWorkers.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'src/routes/api/index.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src/services/diveDeepWorkerRuntime.js'), 'utf8');
const sentinel = fs.readFileSync(path.join(root, 'src/middleware/apiSentinel.js'), 'utf8');
for (const route of ['register', 'manifest', 'heartbeat', 'events', 'source-attempts', 'checkpoints', 'candidates', 'upload-authorizations', 'download-authorization', 'complete', 'cleanup']) {
  assert.ok(routes.includes(route), `missing worker route ${route}`);
}
assert.ok(index.indexOf("router.use('/workers/v1'") < index.indexOf('router.use(apiKeyAuth)'), 'worker auth must be mounted before general client API-key auth');
assert.match(runtime, /job_scoped|bootstrap|WORKER_SCOPES/);
assert.match(runtime, /'checkpoints:read'/);
assert.match(runtime, /async function getCheckpoints/);
assert.match(runtime, /DIVEDEEP_WORKER_VERSION_MISMATCH/);
assert.match(runtime, /DIVEDEEP_WORKER_PROTOCOL_MISMATCH/);
assert.match(routes, /router.get\('\/jobs\/:jobId\/checkpoints'/);
assert.match(runtime, /scopes: \['cleanup:write'\]/);
assert.match(runtime, /cleanupOnly/);
assert.match(runtime, /Only approved reference images may be read/);
assert.match(sentinel, /workers\/v1/);
assert.match(routes, /sentinelOmitBodies = true/);
console.log('DiveDeep Phase 4 worker route and security checks passed');
