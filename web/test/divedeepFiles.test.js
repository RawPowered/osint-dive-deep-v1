const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'divedeep-files-'));
process.env.SECRET_BOX_KEY = 'divedeep-files-test-key-000000000000000000';
process.env.SESSION_SECRET = 'divedeep-session-test-key-000000000000000';
process.env.DIVEDEEP_PRIVATE_STORAGE_DIR = temp;

const files = require('../src/services/diveDeepFiles');

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(128, 7), Buffer.from([0xff, 0xd9])]);
const detected = files.detectImage(jpeg, 'image/jpeg');
assert.equal(detected.mimeType, 'image/jpeg');
const ref = files.writeEncryptedPhoto('customer-123', 'photo-456', jpeg);
assert.ok(ref.includes('photos/'));
const stored = fs.readFileSync(path.join(temp, ...ref.split('/')));
assert.equal(stored.includes(jpeg), false, 'plaintext image bytes must not be stored directly');
assert.deepEqual(files.readEncryptedPhoto(ref), jpeg);
assert.equal(files.sha256Buffer(jpeg).length, 64);
files.deleteEncryptedPhoto(ref);
assert.equal(fs.existsSync(path.join(temp, ...ref.split('/'))), false);
const evidenceRef = files.writeEncryptedEvidence('customer-123', 'evidence-789', jpeg);
assert.ok(evidenceRef.includes('evidence/'));
assert.deepEqual(files.readEncryptedEvidence(evidenceRef), jpeg);
files.deleteEncryptedEvidence(evidenceRef);
assert.equal(fs.existsSync(path.join(temp, ...evidenceRef.split('/'))), false);
const importRef = files.writeEncryptedImportBundle('customer-123', 'batch-456', Buffer.from('verified package'));
assert.ok(importRef.includes('imports/'));
assert.equal(files.readEncryptedImportBundle(importRef).toString(), 'verified package');
files.writeEncryptedImportBundle('customer-123', 'batch-456', Buffer.from('replacement package'));
assert.equal(files.readEncryptedImportBundle(importRef).toString(), 'replacement package');
files.deleteEncryptedImportBundle(importRef);
assert.equal(fs.existsSync(path.join(temp, ...importRef.split('/'))), false);
fs.rmSync(temp, { recursive: true, force: true });
console.log('DiveDeep encrypted file tests passed');
