'use strict';

const crypto = require('crypto');

const FORBIDDEN_KEY_RE = /(?:^|[._-])(evidence|artifact|candidate|finding|exposure|image|photo|face|facial|biometric|rekognition|confidence|reviewer|review_note|authorization_document|identity_document|passport|driver.?license|social.?security|ssn|removal_destination|destination_enc|storage_ref|source_url|permalink|caption|raw_body|request_body|response_body|message_body|email_body|html|attachment)(?:$|[._-])/i;
const SECRET_KEY_RE = /(?:authorization|cookie|password|secret|token|credential|api[_-]?key|access[_-]?key|refresh[_-]?key)/i;
const URL_VALUE_RE = /^https?:\/\//i;
const MAX_STRING = 500;
const MAX_ARRAY = 50;
const MAX_KEYS = 80;
const MAX_DEPTH = 5;

const OUTBOUND_ROOT_KEYS = new Set([
  'eventName', 'eventId', 'occurredAt', 'customerId', 'contactId', 'locationId',
  'customerStatus', 'workflowStatus', 'planTier', 'onboardingComplete',
  'openCustomerActions', 'pendingDeliveries', 'activeMonitoring', 'serviceState',
  'portalPath', 'communicationKey', 'tags', 'lifecycle', 'source',
]);

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function containsSensitiveEvidence(value, path = '', depth = 0) {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item, index) => containsSensitiveEvidence(item, `${path}[${index}]`, depth + 1));
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    const full = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEY_RE.test(full) || SECRET_KEY_RE.test(full)) return true;
    if (containsSensitiveEvidence(child, full, depth + 1)) return true;
  }
  return false;
}

function assertNoSensitiveEvidence(value) {
  if (containsSensitiveEvidence(value)) {
    const error = new Error('Sensitive privacy evidence cannot be sent to the CRM');
    error.status = 400;
    error.code = 'DIVEDEEP_CRM_SENSITIVE_PAYLOAD_BLOCKED';
    throw error;
  }
  return value;
}

function sanitizeOutboundPayload(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  assertNoSensitiveEvidence(source);
  const output = {};
  for (const key of OUTBOUND_ROOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    output[key] = sanitizeScalarTree(source[key], key, 0, { allowUrl: key === 'portalPath' });
  }
  assertNoSensitiveEvidence(output);
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 32 * 1024) {
    const error = new Error('CRM lifecycle payload is too large');
    error.status = 413;
    error.code = 'DIVEDEEP_CRM_PAYLOAD_TOO_LARGE';
    throw error;
  }
  return output;
}

function sanitizeInboundPayload(input) {
  const root = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const contact = objectValue(root.contact);
  const opportunity = objectValue(root.opportunity);
  const appointment = objectValue(root.appointment);
  const customData = objectValue(root.customData || root.custom_data);
  const output = {
    eventName: clean(root.eventName || root.event || root.type || customData.eventName || customData.event_name, 96),
    contactId: clean(root.contactId || root.contact_id || contact.id || root.id, 191),
    locationId: clean(root.locationId || root.location_id || contact.locationId || root.location?.id, 128),
    tag: clean(root.tag || root.tagAdded || root.tagRemoved, 191),
    tags: stringList(root.tags || contact.tags),
    customerId: clean(customData.customerId || customData.customer_id || root.diveDeepCustomerId, 36),
    opportunity: compact({
      id: clean(opportunity.id || root.opportunityId, 191),
      status: clean(opportunity.status, 32),
      pipelineId: clean(opportunity.pipelineId, 191),
      pipelineStageId: clean(opportunity.pipelineStageId, 191),
    }),
    appointment: compact({
      id: clean(appointment.id || root.appointmentId, 191),
      status: clean(appointment.status || appointment.appointmentStatus, 32),
      startTime: clean(appointment.startTime, 64),
    }),
    receivedAt: new Date().toISOString(),
  };
  const result = compact(output);
  assertNoSensitiveEvidence(result);
  return result;
}

function sanitizeScalarTree(value, path, depth, options = {}) {
  if (depth > MAX_DEPTH) return null;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, MAX_STRING);
    if (!options.allowUrl && URL_VALUE_RE.test(text)) return '[url omitted]';
    return text;
  }
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => sanitizeScalarTree(item, path, depth + 1, options));
  if (typeof value !== 'object') return clean(value, MAX_STRING);
  const entries = [];
  for (const [key, child] of Object.entries(value).slice(0, MAX_KEYS)) {
    const full = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEY_RE.test(full) || SECRET_KEY_RE.test(full)) continue;
    entries.push([clean(key, 64), sanitizeScalarTree(child, full, depth + 1, options)]);
  }
  return compact(Object.fromEntries(entries));
}

function compact(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== '' && !(Array.isArray(item) && !item.length) && !(typeof item === 'object' && !Array.isArray(item) && !Object.keys(item).length)));
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringList(value) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(items.map((item) => clean(item, 191)).filter(Boolean))].slice(0, MAX_ARRAY);
}

function clean(value, max) {
  return String(value == null ? '' : value).trim().replace(/[\r\n\t]/g, ' ').slice(0, max);
}

module.exports = {
  FORBIDDEN_KEY_RE,
  SECRET_KEY_RE,
  stableJson,
  hashPayload,
  containsSensitiveEvidence,
  assertNoSensitiveEvidence,
  sanitizeOutboundPayload,
  sanitizeInboundPayload,
};
