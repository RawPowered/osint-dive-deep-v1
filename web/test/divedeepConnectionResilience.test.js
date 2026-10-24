const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pool = fs.readFileSync(path.join(root, 'src/db/pool.js'), 'utf8');
const imports = fs.readFileSync(path.join(root, 'src/services/diveDeepImports.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src/services/diveDeep.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/diveDeep.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/divedeep-app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/divedeep/app.html'), 'utf8');

assert.ok(pool.includes('queueLimit'), 'Database requests must have a bounded wait queue');
assert.ok(pool.includes('idleTimeout'), 'Idle database connections must be retired');
assert.ok(pool.includes('enableKeepAlive: true'), 'Database sockets must use keepalive');
assert.ok(pool.includes('function getWorkPool()'), 'Long-running work must use an isolated pool');
assert.ok(imports.includes("const p = pool || getWorkPool();"), 'Import and review work must not monopolize the customer pool');
assert.ok(imports.includes('activePublicationCustomers'), 'Concurrent review writes must be serialized per customer');
assert.ok(service.includes('getCustomerFindingPage'), 'Customer findings must be fetched by page');
assert.ok(service.includes("publication_status='published'"), 'Customer finding pages must enforce publication visibility in SQL');
assert.ok(routes.includes("router.get('/api/findings'"), 'Customer UI needs a lightweight finding-page endpoint');
assert.ok(routes.includes('Server-Timing'), 'Dashboard and finding routes should expose server timing for diagnosis');
assert.ok(app.includes('DIVEDEEP_REQUEST_TIMEOUT'), 'Customer requests must stop waiting indefinitely');
assert.ok(app.includes('retries: 1'), 'Customer bootstrap must retry transient failures');
assert.ok(app.includes('dashboardLoadPromise'), 'Customer dashboard loads must be single-flight');
assert.ok(app.includes('/divedeep/api/findings?page='), 'Finding pagination must request only the selected page');
assert.ok(html.includes('bootRetry'), 'A failed bootstrap must provide an in-page retry action');
assert.match(html, /divedeep-app\.js\?v=20260724-176/, 'Customer app cache key must advance');

console.log('DiveDeep connection resilience checks passed');
