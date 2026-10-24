const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { argument } = require('../src/db/resetDiveDeepOwnerPassword');

const previous = process.argv;
process.argv = ['node', 'resetDiveDeepOwnerPassword.js', '--username', 'fid_owner'];
assert.equal(argument('username'), 'fid_owner');
process.argv = previous;

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'resetDiveDeepOwnerPassword.js'), 'utf8');
assert.match(source, /promptSecret\('New root-owner password/);
assert.match(source, /verifyPassword\(owner\.username, password/);
assert.doesNotMatch(source, /--password/);
console.log('DiveDeep root-owner recovery checks passed');
