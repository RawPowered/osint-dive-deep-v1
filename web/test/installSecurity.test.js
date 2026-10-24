const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validPassword } = require('../src/services/adminUsers');
const {
  createConnectionProof,
  verifyConnectionProof,
  deriveBootstrapAdmin,
  generateBootstrapAdmin,
} = require('../src/routes/install');

const proofKey = Buffer.alloc(32, 9);
const database = {
  host: '127.0.0.1',
  port: 3306,
  user: 'divedeep_app',
  password: 'database-secret',
  database: 'divedeep',
  createDatabase: true,
};

const proof = createConnectionProof(database, proofKey, 1_000);
assert.equal(verifyConnectionProof(proof, database, proofKey, 1_001), true);
assert.equal(verifyConnectionProof(proof, { ...database, password: 'changed' }, proofKey, 1_001), false);
assert.equal(verifyConnectionProof(proof, database, proofKey, 1_000 + (10 * 60 * 1000) + 1), false);

const seed = Buffer.alloc(32, 7);
const deterministic = deriveBootstrapAdmin(seed);
assert.match(deterministic.username, /^fid_[A-Za-z0-9_-]{24}$/);
assert.doesNotThrow(() => validPassword(deterministic.password));
assert.deepEqual(Object.keys(deterministic).sort(), ['password', 'username']);
assert.equal(JSON.stringify(deterministic).includes(seed.toString('hex')), false);
assert.equal(JSON.stringify(deterministic).includes(seed.toString('base64url')), false);

const first = generateBootstrapAdmin();
const second = generateBootstrapAdmin();
assert.notEqual(first.username, second.username);
assert.notEqual(first.password, second.password);
assert.doesNotThrow(() => validPassword(first.password));

const installerUi = fs.readFileSync(path.join(__dirname, '..', 'public', 'install', 'index.html'), 'utf8');
assert.doesNotMatch(installerUi, /id="adminUsername"|id="adminPassword"|id="adminEmail"/);
assert.match(installerUi, /one-time launch receipt/i);
assert.match(installerUi, /Erase receipt &amp; launch/);
assert.match(installerUi, /connectionProof/);

console.log('Installer security tests passed');
