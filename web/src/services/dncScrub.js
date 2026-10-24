const DNC_SCRUB_ENDPOINT = 'https://www.dncscrub.com/app/main/rpc/scrub';
const DEFAULT_TIMEOUT_MS = 30000;
// Keep each synchronous provider call small enough to finish inside common
// reverse-proxy request windows. OWL resumes larger runs across many calls.
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 50;
const DEFAULT_REQUESTS_PER_MINUTE = 30;
const MAX_REQUESTS_PER_MINUTE = 30;
const RESULT_CODES = Object.freeze({
  C: resultDefinition('clean', 'Clean', 'clean', false),
  E: resultDefinition('clean', 'Valid EBR', 'ebr', false),
  O: resultDefinition('clean', 'EBR override', 'ebr_override', false),
  X: resultDefinition('clean', 'Industry exemption', 'industry_exemption', false),
  W: resultDefinition('clean', 'Wireless', 'wireless_or_voip', false),
  G: resultDefinition('clean', 'EBR + wireless/VoIP', 'ebr_wireless_or_voip', false),
  H: resultDefinition('clean', 'EBR override + wireless/VoIP', 'ebr_override_wireless_or_voip', false),
  Y: resultDefinition('clean', 'VoIP', 'wireless_or_voip', false),
  D: resultDefinition('blocked', 'Do Not Call', 'dnc_registry_match', false),
  P: resultDefinition('blocked', 'Internal DNC', 'internal_dnc_match', true),
  // These codes prohibit dialing under the current provider result, but do not
  // prove that the person is on a DNC list. Keep them non-callable in a
  // governed review state instead of inflating the terminal DNC population.
  B: resultDefinition('review', 'Configuration / coverage hold', 'configuration_or_coverage', true),
  I: resultDefinition('review', 'Invalid number', 'invalid_contact_data', true),
  M: resultDefinition('review', 'Malformed number', 'invalid_contact_data', true),
  L: resultDefinition('review', 'Wireless prohibited', 'jurisdiction_restriction', true),
  F: resultDefinition('review', 'EBR + wireless restricted', 'jurisdiction_restriction', true),
  V: resultDefinition('review', 'EBR override + wireless restricted', 'jurisdiction_restriction', true),
});
const CALLABLE_CODES = new Set(Object.entries(RESULT_CODES).filter(([, value]) => value.state === 'clean').map(([code]) => code));
const BLOCKED_CODES = new Set(Object.entries(RESULT_CODES).filter(([, value]) => value.state === 'blocked').map(([code]) => code));
const REVIEW_CODES = new Set(Object.entries(RESULT_CODES).filter(([, value]) => value.state === 'review').map(([code]) => code));
const ALTERNATIVE_PHONE_FIELD_ID = String(process.env.CRM_ALTERNATIVE_PHONE_FIELD_ID || '').trim();
const PHONE_3_FIELD_ID = String(process.env.CRM_PHONE_3_FIELD_ID || '').trim();
const PHONE_KEYS = new Set([
  'phone', 'phonenumber', 'mobile', 'mobilephone', 'telephone', 'primaryphone', 'contactphone',
]);
let rateLimitTail = Promise.resolve();
let nextRequestAt = 0;

function getDncScrubConfig(env = process.env) {
  // DNC_SCRUB_KEY is the canonical Namecheap/Node environment variable.
  // Keep the former double-underscore spelling as a compatibility fallback only.
  const apiKey = String(env.DNC_SCRUB_KEY || env.DNC_SCRUB__KEY || '').trim();
  if (!apiKey) {
    throw serviceError('DNCScrub is not configured', 'DNC_SCRUB_NOT_CONFIGURED', 503);
  }
  if (apiKey.length > 2048 || /[\x00-\x20\x7f]/.test(apiKey)) {
    throw serviceError('DNCScrub configuration is invalid', 'DNC_SCRUB_INVALID_CONFIG', 503);
  }
  return {
    apiKey,
    projectId: optionalScrubIdentifier(env.DNC_SCRUB_PROJECT_ID, 'project'),
    campaignId: optionalScrubIdentifier(env.DNC_SCRUB_CAMPAIGN_ID, 'campaign'),
    timeoutMs: boundedInt(env.DNC_SCRUB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 60000),
    batchSize: boundedInt(env.DNC_SCRUB_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE),
    maxRetries: boundedInt(env.DNC_SCRUB_MAX_RETRIES, 2, 0, 4),
    requestsPerMinute: boundedInt(
      env.DNC_SCRUB_REQUESTS_PER_MINUTE,
      DEFAULT_REQUESTS_PER_MINUTE,
      1,
      MAX_REQUESTS_PER_MINUTE
    ),
  };
}

function isDncScrubConfigured(env = process.env) {
  try {
    getDncScrubConfig(env);
    return true;
  } catch {
    return false;
  }
}

function normalizePhone(value) {
  if (value == null || (typeof value !== 'string' && typeof value !== 'number')) return null;
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return /^\d{10}$/.test(digits) ? digits : null;
}

function extractPhone(contactData) {
  return extractPhoneCandidates(contactData)[0]?.phone || null;
}

function extractPhoneCandidates(contactData) {
  const record = parseContactData(contactData);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  const candidates = [];
  const seen = new Set();
  const add = (slot, fieldId, value) => {
    const raw = phoneValue(value);
    const phone = normalizePhone(raw);
    if (!phone || seen.has(phone)) return;
    seen.add(phone);
    candidates.push({ slot, fieldId, phone, raw:String(raw) });
  };
  add('primary', null, firstRecordValue(record, [
    'phone', 'phoneNumber', 'mobile', 'mobilePhone', 'telephone', 'primaryPhone', 'contactPhone',
  ]));
  add('alternative', ALTERNATIVE_PHONE_FIELD_ID,
    customFieldValue(record, ALTERNATIVE_PHONE_FIELD_ID) ?? firstRecordValue(record, [
      'alternativePhone', 'alternative_phone', 'Alternative Phone',
    ]));
  add('phone3', PHONE_3_FIELD_ID,
    customFieldValue(record, PHONE_3_FIELD_ID) ?? firstRecordValue(record, [
      'phone3', 'phone_3', 'Phone 3',
    ]));

  const fallback = extractLegacyPhone(record);
  if (fallback && !seen.has(fallback)) {
    candidates.unshift({ slot:'primary', fieldId:null, phone:fallback, raw:fallback });
  }
  return candidates;
}

function extractLegacyPhone(record) {
  const candidates = [];
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (PHONE_KEYS.has(normalizedKey)) candidates.push(child);
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };
  visit(record, 0);
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const normalized = normalizePhone(item && typeof item === 'object' ? item.number || item.phone : item);
        if (normalized) return normalized;
      }
      continue;
    }
    const normalized = normalizePhone(
      candidate && typeof candidate === 'object' ? candidate.number || candidate.phone : candidate
    );
    if (normalized) return normalized;
  }
  return null;
}

function firstRecordValue(record, keys) {
  for (const source of [record, record.contact]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const key of keys) if (source[key] != null && source[key] !== '') return source[key];
  }
  return null;
}

function customFieldValue(record, fieldId) {
  const fields = record.customFields ?? record.custom_fields ?? record.contact?.customFields;
  if (Array.isArray(fields)) {
    const field = fields.find((item) => String(item?.id || item?.fieldId || item?.field_id || '') === fieldId);
    return field && (field.field_value ?? field.fieldValue ?? field.value ?? field.valueString);
  }
  if (fields && typeof fields === 'object') {
    const value = fields[fieldId];
    return value && typeof value === 'object'
      ? value.field_value ?? value.fieldValue ?? value.value ?? value.valueString
      : value;
  }
  return null;
}

function phoneValue(value) {
  if (!value || typeof value !== 'object') return value;
  return value.number ?? value.phone ?? value.value ?? value.field_value ?? null;
}

function classifyDncScrubResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('DNCScrub returned an invalid result', 'DNC_SCRUB_INVALID_RESULT', 502);
  }
  const phone = normalizePhone(value.Phone ?? value.phone);
  const resultCode = String(value.ResultCode ?? value.resultCode ?? '').trim().toUpperCase().slice(0, 8);
  const definition = RESULT_CODES[resultCode] || resultDefinition('pending', 'Unrecognized result', 'unrecognized', true);
  return {
    phone,
    resultCode,
    state: definition.state,
    resultLabel: definition.label,
    decisionCategory: definition.category,
    reviewRequired: definition.reviewRequired,
    reason: sanitizeProviderText(value.Reason ?? value.reason, 255),
    lineType: sanitizeProviderText(value.LineType ?? value.lineType, 64),
    region: sanitizeProviderText(value.RegionAbbrev ?? value.regionAbbrev, 16),
    ebrType: sanitizeProviderText(value.EBRType ?? value.ebrType, 16),
    callingWindow: sanitizeProviderText(value.CallingWindow ?? value.callingWindow, 32),
    doNotCallToday: String(value.DoNotCallToday ?? value.doNotCallToday ?? '') === '1',
    isWirelessOrVoip: String(value.IsWirelessOrVoIP ?? value.isWirelessOrVoIP ?? '') === '1',
  };
}

async function scrubPhoneNumbers(values, options = {}) {
  const config = options.config || getDncScrubConfig(options.env);
  const supplied = Array.isArray(values) ? values : [];
  const normalized = supplied.map(normalizePhone);
  if (normalized.some((phone) => !phone)) {
    throw serviceError('Every DNCScrub phone must contain exactly 10 digits', 'DNC_SCRUB_INVALID_PHONE', 400);
  }
  const phones = [...new Set(normalized)];
  if (!phones.length) throw serviceError('At least one valid 10-digit phone number is required', 'DNC_SCRUB_INVALID_PHONE', 400);
  if (phones.length > config.batchSize || phones.length > MAX_BATCH_SIZE) {
    throw serviceError(`DNCScrub batches are limited to ${Math.min(config.batchSize, MAX_BATCH_SIZE)} numbers`, 'DNC_SCRUB_BATCH_LIMIT', 400);
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw serviceError('DNCScrub transport is unavailable', 'DNC_SCRUB_TRANSPORT_UNAVAILABLE', 503);
  }
  const requestBody = { phoneList: phones.join(','), version: '5', output: 'json' };
  if (config.projectId) requestBody.projId = config.projectId;
  if (config.campaignId) requestBody.campaignId = config.campaignId;
  const payload = JSON.stringify(requestBody);
  let lastError;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    await acquireRateLimitSlot(config, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(DNC_SCRUB_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          loginId: config.apiKey,
        },
        body: payload,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = upstreamStatusError(response.status);
        if (retryable && attempt < config.maxRetries) {
          lastError = error;
          await retryDelay(response, attempt, options.sleep, options.now);
          continue;
        }
        throw error;
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > 5 * 1024 * 1024) {
        throw serviceError('DNCScrub response exceeded the safe size limit', 'DNC_SCRUB_RESPONSE_TOO_LARGE', 502);
      }
      let body;
      try {
        body = JSON.parse(await response.text());
      } catch {
        throw serviceError('DNCScrub returned an invalid response', 'DNC_SCRUB_INVALID_RESPONSE', 502);
      }
      if (!Array.isArray(body)) {
        throw serviceError('DNCScrub returned an invalid response', 'DNC_SCRUB_INVALID_RESPONSE', 502);
      }
      return body.map(classifyDncScrubResult).filter((item) => item.phone);
    } catch (error) {
      if (error.name === 'AbortError') {
        lastError = serviceError('DNCScrub request timed out', 'DNC_SCRUB_TIMEOUT', 504);
      } else if (error.code && String(error.code).startsWith('DNC_SCRUB_')) {
        lastError = error;
      } else {
        lastError = serviceError('DNCScrub request failed', 'DNC_SCRUB_REQUEST_FAILED', 502);
      }
      if (attempt < config.maxRetries && ['DNC_SCRUB_TIMEOUT', 'DNC_SCRUB_REQUEST_FAILED'].includes(lastError.code)) {
        await retryDelay(null, attempt, options.sleep, options.now);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || serviceError('DNCScrub request failed', 'DNC_SCRUB_REQUEST_FAILED', 502);
}

function upstreamStatusError(status) {
  if (status === 401 || status === 403) {
    return serviceError('DNCScrub authentication failed', 'DNC_SCRUB_AUTH_FAILED', 503);
  }
  if (status === 429) return serviceError('DNCScrub rate limit was reached', 'DNC_SCRUB_RATE_LIMIT', 503);
  return serviceError('DNCScrub upstream request failed', 'DNC_SCRUB_UPSTREAM_ERROR', 502);
}

async function retryDelay(response, attempt, sleep, now = Date.now) {
  const rawRetryAfter = response?.headers?.get('retry-after');
  const retryAfterSeconds = rawRetryAfter == null || rawRetryAfter === '' ? NaN : Number(rawRetryAfter);
  const retryAfterDateMs = Number.isFinite(retryAfterSeconds) ? NaN : Date.parse(rawRetryAfter || '');
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? retryAfterSeconds * 1000
    : Number.isFinite(retryAfterDateMs) ? Math.max(0, retryAfterDateMs - now()) : NaN;
  const milliseconds = Number.isFinite(retryAfterMs)
    ? Math.min(retryAfterMs, 5000)
    : Math.min(1000 * (2 ** attempt), 16000);
  await (sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(milliseconds);
}

async function acquireRateLimitSlot(config, options = {}) {
  if (!config.requestsPerMinute || options.rateLimit === false) return;
  const previous = rateLimitTail;
  let release;
  rateLimitTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const now = options.now || Date.now;
    const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
    const intervalMs = Math.ceil(60000 / config.requestsPerMinute);
    const waitMs = Math.max(0, nextRequestAt - now());
    if (waitMs) await sleep(waitMs);
    const reservedAt = Math.max(now(), nextRequestAt);
    nextRequestAt = reservedAt + intervalMs;
  } finally {
    release();
  }
}

function resetDncRateLimiter() {
  rateLimitTail = Promise.resolve();
  nextRequestAt = 0;
}

function sanitizeProviderText(value, maxLength) {
  if (value == null) return null;
  const text = String(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/(?:\+?1[\s.()-]*)?(?:\d[\s.()-]*){9}\d/g, '[redacted-phone]')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, maxLength) : null;
}

function parseContactData(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.floor(number), min), max) : fallback;
}

function optionalScrubIdentifier(value, label) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > 128 || /[\x00-\x20\x7f]/.test(text)) {
    throw serviceError(`DNCScrub ${label} configuration is invalid`, 'DNC_SCRUB_INVALID_CONFIG', 503);
  }
  return text;
}

function serviceError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

function resultDefinition(state, label, category, reviewRequired) {
  return Object.freeze({ state, label, category, reviewRequired });
}

module.exports = {
  DNC_SCRUB_ENDPOINT,
  CALLABLE_CODES,
  BLOCKED_CODES,
  REVIEW_CODES,
  RESULT_CODES,
  getDncScrubConfig,
  isDncScrubConfigured,
  normalizePhone,
  extractPhone,
  extractPhoneCandidates,
  ALTERNATIVE_PHONE_FIELD_ID,
  PHONE_3_FIELD_ID,
  classifyDncScrubResult,
  scrubPhoneNumbers,
  acquireRateLimitSlot,
  resetDncRateLimiter,
  sanitizeProviderText,
};
