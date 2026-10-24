const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { normalizeWebOrigin } = require('../src/config');
const { buildCorsOptions } = require('../src/middleware/corsSetup');
const { frontendRuntimeConfig } = require('../src/routes/install');

assert.equal(normalizeWebOrigin('https://demo.example.test/'), 'https://demo.example.test');
assert.equal(normalizeWebOrigin('http://localhost:3000', 'Local URL'), 'http://localhost:3000');
assert.throws(() => normalizeWebOrigin('http://demo.example.test'), /HTTPS/);
assert.throws(() => normalizeWebOrigin('https://demo.example.test/path'), /without a path/);
assert.match(frontendRuntimeConfig('https://api.demo.example.test'), /api\.demo\.example\.test/);
assert.match(frontendRuntimeConfig('https://api.demo.example.test'), /DiveDeepClient/);
assert.match(frontendRuntimeConfig('https://api.demo.example.test'), /configured: true/);
assert.doesNotMatch(frontendRuntimeConfig('https://api.demo.example.test'), /SESSION_SECRET|DB_PASSWORD|SECRET_BOX_KEY|FORENSIC_KEY/);

const corsOptions = buildCorsOptions();
assert.ok(corsOptions.allowedHeaders.includes('X-DiveDeep-CSRF'));
assert.ok(corsOptions.allowedHeaders.includes('X-DiveDeep-Photo-Label'));

const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'public', 'divedeep-runtime.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'public', 'js', 'divedeep-auth.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'divedeep-app.js'), 'utf8');
assert.match(runtime, /DiveDeepClient/);
assert.match(runtime, /frontend is not configured/);
assert.match(auth, /credentials: 'include'/);
assert.match(auth, /signup is not connected to its API/);
assert.doesNotMatch(auth, /apiUrl\(path\)\s*\|\|\s*path/);
assert.match(app, /credentials: 'include'/);
assert.match(app, /requestJson\('\/divedeep\/api\/session'/);
assert.match(app, /fetch\(apiUrl\(url\)/);
console.log('DiveDeep split-deployment checks passed');
