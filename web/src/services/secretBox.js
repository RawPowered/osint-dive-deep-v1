const crypto = require('crypto');
const { getSessionSecret, getSecretBoxKey } = require('../config');

const LEGACY_SALT = 'divedeep-sql-conn-v1';
const V2_SALT = 'divedeep-secret-box-v2';
const V2_PREFIX = 'v2:';

function deriveKey(secret, salt) {
  return crypto.scryptSync(secret, salt, 32);
}

function activeKey() {
  const dedicated = getSecretBoxKey();
  if (dedicated) return { key: deriveKey(dedicated, V2_SALT), version: 2 };
  return { key: deriveKey(getSessionSecret(), LEGACY_SALT), version: 1 };
}

function legacyKey() {
  return deriveKey(getSessionSecret(), LEGACY_SALT);
}

/**
 * Encrypt a string (AES-256-GCM). Returns base64(iv || tag || ciphertext).
 */
function encryptSecret(plain) {
  const active = activeKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', active.key, iv);
  const enc = Buffer.concat([cipher.update(String(plain ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, enc]).toString('base64');
  return active.version === 2 ? `${V2_PREFIX}${payload}` : payload;
}

/**
 * Decrypt a string produced by encryptSecret.
 */
function decryptSecret(encoded) {
  if (!encoded) return '';
  const value = String(encoded);
  const isV2 = value.startsWith(V2_PREFIX);
  const buf = Buffer.from(isV2 ? value.slice(V2_PREFIX.length) : value, 'base64');
  if (buf.length < 29) throw new Error('Invalid encrypted payload');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const dedicated = getSecretBoxKey();
  if (isV2 && !dedicated) throw new Error('SECRET_BOX_KEY is required for this encrypted payload');
  const key = isV2 ? deriveKey(dedicated, V2_SALT) : legacyKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
