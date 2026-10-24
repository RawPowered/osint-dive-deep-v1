const crypto = require('crypto');
const { encryptSecret, decryptSecret } = require('./secretBox');
const { getSecretBoxKey, getSessionSecret } = require('../config');

function normalizeIdentifier(type, value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  switch (String(type || '').toLowerCase()) {
    case 'email': return text.toLowerCase();
    case 'phone': return text.replace(/\D/g, '');
    case 'domain': return text.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    case 'username': return text.toLowerCase().replace(/^@/, '');
    case 'address': return text.toLowerCase().replace(/\s+/g, ' ');
    case 'name':
    case 'alias': return text.toLowerCase().replace(/\s+/g, ' ');
    default: return text.toLowerCase().replace(/\s+/g, ' ');
  }
}

function indexKey() {
  const secret = getSecretBoxKey() || getSessionSecret();
  return crypto.createHmac('sha256', secret)
    .update('divedeep-divedeep-pii-index-v1')
    .digest();
}

function blindIndex(tenantId, type, value) {
  const normalized = normalizeIdentifier(type, value);
  if (!normalized) return null;
  return crypto.createHmac('sha256', indexKey())
    .update(String(tenantId || ''))
    .update('\n')
    .update(String(type || '').toLowerCase())
    .update('\n')
    .update(normalized)
    .digest('hex');
}

function encryptPii(value) {
  if (value == null || value === '') return null;
  return encryptSecret(String(value));
}

function decryptPii(value) {
  if (!value) return '';
  return decryptSecret(value);
}

function encryptJson(value) {
  return encryptPii(JSON.stringify(value == null ? null : value));
}

function decryptJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(decryptPii(value)); } catch { return fallback; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
}

module.exports = {
  normalizeIdentifier,
  blindIndex,
  encryptPii,
  decryptPii,
  encryptJson,
  decryptJson,
  sha256,
};
