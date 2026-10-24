const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, getSecretBoxKey, getSessionSecret, getDiveDeepConfig } = require('../config');

const FILE_PREFIX = Buffer.from('FID1');
const KEY_SALT = 'divedeep-private-files-v1';

function storageRoot() {
  const configured = getDiveDeepConfig().privateStorageDir;
  const root = configured ? path.resolve(configured) : path.join(ROOT, 'var', 'divedeep-private');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch {}
  return root;
}

function activeKey() {
  const secret = getSecretBoxKey() || getSessionSecret();
  if (!secret || secret === 'dev-only-change-me') {
    throw Object.assign(new Error('Secure file encryption key is not configured'), {
      status: 503,
      code: 'DIVEDEEP_FILE_KEY_MISSING',
    });
  }
  return crypto.scryptSync(secret, KEY_SALT, 32);
}

function safeSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function relativePrivatePath(kind, customerId, fileId) {
  const safeKind = safeSegment(kind);
  const customer = safeSegment(customerId);
  const file = safeSegment(fileId);
  if (!safeKind || !customer || !file) throw new Error('Invalid storage identifier');
  return path.join(safeKind, customer, `${file}.fid`);
}

function relativePhotoPath(customerId, photoId) {
  return relativePrivatePath('photos', customerId, photoId);
}

function resolveStorageRef(storageRef) {
  const root = storageRoot();
  const absolute = path.resolve(root, String(storageRef || ''));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error('Invalid storage reference'), { status: 400 });
  }
  return absolute;
}

function encryptBuffer(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', activeKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([FILE_PREFIX, iv, tag, ciphertext]);
}

function decryptBuffer(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 33 || !payload.subarray(0, 4).equals(FILE_PREFIX)) {
    throw new Error('Invalid DiveDeep encrypted file');
  }
  const iv = payload.subarray(4, 16);
  const tag = payload.subarray(16, 32);
  const ciphertext = payload.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', activeKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function detectImage(buffer, declaredMime = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  if (declaredMime === 'image/jpeg' || declaredMime === 'image/png' || declaredMime === 'image/webp') return null;
  return null;
}

function writeEncryptedPrivateFile(kind, customerId, fileId, buffer, options = {}) {
  const storageRef = relativePrivatePath(kind, customerId, fileId);
  const absolute = resolveStorageRef(storageRef);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  if (options.replace) {
    try { fs.unlinkSync(absolute); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.writeFileSync(absolute, encryptBuffer(buffer), { mode: 0o600, flag: 'wx' });
  return storageRef.split(path.sep).join('/');
}

function writeEncryptedPhoto(customerId, photoId, buffer) {
  return writeEncryptedPrivateFile('photos', customerId, photoId, buffer);
}

function writeEncryptedEvidence(customerId, evidenceId, buffer) {
  return writeEncryptedPrivateFile('evidence', customerId, evidenceId, buffer);
}

function writeEncryptedImportBundle(customerId, batchId, buffer) {
  return writeEncryptedPrivateFile('imports', customerId, batchId, buffer, { replace: true });
}

function readEncryptedPrivateFile(storageRef) {
  return decryptBuffer(fs.readFileSync(resolveStorageRef(storageRef)));
}

function readEncryptedPhoto(storageRef) {
  return readEncryptedPrivateFile(storageRef);
}

function readEncryptedEvidence(storageRef) {
  return readEncryptedPrivateFile(storageRef);
}

function readEncryptedImportBundle(storageRef) {
  return readEncryptedPrivateFile(storageRef);
}

function deleteEncryptedPrivateFile(storageRef) {
  const absolute = resolveStorageRef(storageRef);
  try { fs.unlinkSync(absolute); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function deleteEncryptedPhoto(storageRef) {
  return deleteEncryptedPrivateFile(storageRef);
}

function deleteEncryptedEvidence(storageRef) {
  return deleteEncryptedPrivateFile(storageRef);
}

function deleteEncryptedImportBundle(storageRef) {
  return deleteEncryptedPrivateFile(storageRef);
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  storageRoot,
  detectImage,
  writeEncryptedPhoto,
  readEncryptedPhoto,
  deleteEncryptedPhoto,
  writeEncryptedEvidence,
  readEncryptedEvidence,
  deleteEncryptedEvidence,
  writeEncryptedImportBundle,
  readEncryptedImportBundle,
  deleteEncryptedImportBundle,
  sha256Buffer,
};
