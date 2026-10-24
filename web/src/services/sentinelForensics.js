const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getSessionSecret, getForensicKey, getSentinelForensicConfig } = require('../config');
const { encryptSecret, decryptSecret } = require('./secretBox');
const { enqueueTelemetry } = require('./telemetryWriter');

const REDACTED = '[REDACTED]';
const OMITTED = '[OMITTED]';
const SENSITIVE_KEY = /(authorization|password|passwd|secret|credential|cookie|session|token|api[_-]?key|private[_-]?key|pit|envelope[_-]?enc|integrity[_-]?hmac)/i;
const GOVERNED_SOURCE_KEY = /^(source|sourceCode|pythonSource|code)$/i;
const PII_KEY = /(^|_)(email|phone|mobile|address|street|name|first.?name|last.?name|full.?name|date.?of.?birth|dob|ssn|credit.?score|income|net.?worth)($|_)/i;
const SAFE_ID_KEY = /(^|_)(id|.*Id|locationId|userId|contactId|requestId|apiKeyId)$/i;
const URL_HEADER = /^(referer|referrer|location)$/i;
const BODY_TYPES = /^(application\/(?:[a-z0-9.+-]*\+)?json|text\/plain)(?:;|$)/i;

function forensicIntegrityKey(secret = getForensicKey() || getSessionSecret()) {
  return crypto.createHmac('sha256', secret)
    .update('divedeep-sentinel-forensics-integrity-v1')
    .digest();
}

function integrityFor(requestId, plaintext, secret) {
  return crypto.createHmac('sha256', forensicIntegrityKey(secret))
    .update(String(requestId || ''))
    .update('\n')
    .update(String(plaintext || ''))
    .digest('hex');
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left || '')) || !/^[a-f0-9]{64}$/i.test(String(right || ''))) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function redactValue(value, key = '', state = { count: 0 }, depth = 0) {
  if (depth > 12) {
    state.count += 1;
    return '[DEPTH_LIMIT]';
  }
  if (SENSITIVE_KEY.test(key) && !/^apiKeyId$/i.test(key)) {
    state.count += 1;
    return REDACTED;
  }
  if (GOVERNED_SOURCE_KEY.test(key)) {
    state.count += 1;
    return '[GOVERNED SOURCE OMITTED]';
  }
  if (PII_KEY.test(key) && !SAFE_ID_KEY.test(key)) {
    state.count += 1;
    return pseudonym(value, key);
  }
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, 200);
    const output = value.slice(0, limit).map((item) => redactValue(item, key, state, depth + 1));
    if (value.length > limit) output.push(`[${value.length - limit} ITEMS OMITTED]`);
    return output;
  }
  if (typeof value === 'object') {
    const output = {};
    const entries = Object.entries(value).slice(0, 300);
    for (const [childKey, child] of entries) {
      output[childKey] = redactValue(child, childKey, state, depth + 1);
    }
    if (Object.keys(value).length > entries.length) output._omittedFields = Object.keys(value).length - entries.length;
    return output;
  }
  return redactString(String(value), state);
}

function pseudonym(value, key) {
  const text = String(value == null ? '' : value);
  if (/phone|mobile/i.test(key)) {
    const digits = text.replace(/\D/g, '');
    return digits ? `[PHONE ending ${digits.slice(-4)}]` : '[PHONE REDACTED]';
  }
  if (/email/i.test(key)) {
    const domain = text.includes('@') ? text.split('@').pop().slice(0, 80) : '';
    return domain ? `[EMAIL at ${domain}]` : '[EMAIL REDACTED]';
  }
  return `[${String(key || 'PII').replace(/[^A-Za-z0-9_-]/g, '').toUpperCase()} REDACTED]`;
}

function redactString(input, state) {
  let value = input.slice(0, 8192);
  const replacements = [
    [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]'],
    [/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]'],
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL REDACTED]'],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(value)) {
      state.count += 1;
      value = value.replace(pattern, replacement);
    }
  }
  return value;
}

function sanitizeHeaders(headers, state = { count: 0 }) {
  const output = {};
  for (const [name, raw] of Object.entries(headers || {})) {
    const key = String(name).toLowerCase();
    if (SENSITIVE_KEY.test(key)) {
      state.count += 1;
      output[key] = REDACTED;
    } else if (URL_HEADER.test(key)) {
      output[key] = sanitizeUrl(Array.isArray(raw) ? raw.join(', ') : raw, state);
    } else {
      output[key] = redactValue(raw, key, state);
    }
  }
  return output;
}

function sanitizeUrl(input, state = { count: 0 }) {
  const text = String(input || '');
  try {
    const parsed = new URL(text, 'https://sentinel.invalid');
    for (const [key, value] of parsed.searchParams.entries()) {
      const redacted = redactValue(value, key, state);
      if (redacted !== value) parsed.searchParams.set(key, String(redacted));
    }
    parsed.hash = '';
    return parsed.origin === 'https://sentinel.invalid'
      ? `${parsed.pathname}${parsed.search}`
      : parsed.toString();
  } catch {
    return redactString(text.split('#')[0], state);
  }
}

function boundedBody(value, contentType, byteLength, maxBytes, state) {
  const type = String(contentType || '').toLowerCase();
  if (value == null || byteLength === 0) return { value: null, truncated: false };
  if (!BODY_TYPES.test(type)) return { value: `[${OMITTED}: ${type || 'unknown content type'}]`, truncated: false };
  if (byteLength > maxBytes) {
    return { value: `[${OMITTED}: ${byteLength} bytes exceeds ${maxBytes} byte evidence limit]`, truncated: true };
  }
  let parsed = value;
  if (Buffer.isBuffer(value)) parsed = value.toString('utf8');
  if (typeof parsed === 'string' && /json/i.test(type)) {
    try { parsed = JSON.parse(parsed); } catch { /* retain malformed JSON for investigation */ }
  }
  return { value: redactValue(parsed, '', state), truncated: false };
}

function attachForensicCapture(req, res, requestId) {
  if (shouldSkipCapture(req)) return;
  const config = getSentinelForensicConfig();
  if (!config.enabled) return;

  const chunks = [];
  let responseBytes = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = (chunk, encoding, callback) => {
    collectChunk(chunks, chunk, encoding, config.maxBodyBytes, (n) => { responseBytes += n; });
    return originalWrite(chunk, encoding, callback);
  };
  res.end = (chunk, encoding, callback) => {
    collectChunk(chunks, chunk, encoding, config.maxBodyBytes, (n) => { responseBytes += n; });
    return originalEnd(chunk, encoding, callback);
  };

  res.on('finish', () => {
    const state = { count: 0 };
    const requestType = String(req.get('content-type') || '');
    const responseType = String(res.getHeader('content-type') || '');
    const requestBytes = bodyBytes(req.body);
    const omitBodies = Boolean(req.sentinelOmitBodies);
    const requestBody = omitBodies
      ? { value: '[OMITTED: privacy data surface]', truncated: false }
      : boundedBody(req.body, requestType, requestBytes, config.maxBodyBytes, state);
    const responseRaw = chunks.length ? Buffer.concat(chunks) : null;
    const responseBody = omitBodies
      ? { value: '[OMITTED: privacy data surface]', truncated: false }
      : boundedBody(responseRaw, responseType, responseBytes, config.maxBodyBytes, state);
    const envelope = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      request: {
        method: req.method,
        target: sanitizeUrl(req.originalUrl || req.url || req.path, state),
        headers: sanitizeHeaders(req.headers, state),
        contentType: requestType || null,
        bytes: requestBytes,
        truncated: requestBody.truncated,
        payload: requestBody.value,
      },
      response: {
        status: res.statusCode,
        headers: sanitizeHeaders(res.getHeaders(), state),
        contentType: responseType || null,
        bytes: responseBytes,
        truncated: responseBody.truncated,
        payload: responseBody.value,
      },
      controls: {
        redactionCount: state.count,
        bodyLimitBytes: config.maxBodyBytes,
        retentionDays: config.retentionDays,
      },
    };
    recordForensicEnvelope(requestId, envelope, res.statusCode >= 400 ? 'error_response' : 'standard');
  });
}

function collectChunk(chunks, chunk, encoding, maxBytes, addBytes) {
  if (chunk == null) return;
  const safeEncoding = typeof encoding === 'string' ? encoding : 'utf8';
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), safeEncoding);
  addBytes(buffer.length);
  const retained = chunks.reduce((sum, item) => sum + item.length, 0);
  if (retained < maxBytes) chunks.push(buffer.subarray(0, maxBytes - retained));
}

function bodyBytes(body) {
  if (body == null) return 0;
  try { return Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body)); } catch { return 0; }
}

function shouldSkipCapture(req) {
  const path = String(req.path || req.url || '');
  return req.method === 'OPTIONS' || /\/api\/sentinel\/events\/[^/]+\/evidence(?:\?|$)/.test(path);
}

function recordForensicEnvelope(requestId, envelope, captureReason) {
  return enqueueTelemetry('forensic_envelopes', async () => {
      const plaintext = JSON.stringify(envelope);
      const config = getSentinelForensicConfig();
      await getPool().query(
        `INSERT INTO sentinel_http_envelopes
          (request_id, envelope_enc, integrity_hmac, capture_reason, expires_at)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? DAY))
         ON DUPLICATE KEY UPDATE envelope_enc = VALUES(envelope_enc),
           integrity_hmac = VALUES(integrity_hmac), capture_reason = VALUES(capture_reason),
           expires_at = VALUES(expires_at)`,
        [requestId, encryptSecret(plaintext), integrityFor(requestId, plaintext), captureReason, config.retentionDays]
      );
  });
}

async function revealForensicEvidence({ eventId, admin, reason, ip, userAgent }) {
  const purpose = String(reason || '').trim().slice(0, 512);
  if (purpose.length < 8) throw Object.assign(new Error('Investigation reason must be at least 8 characters'), { status: 400 });
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT e.id AS event_id, e.request_id, e.created_at, e.surface, e.action, e.path,
            e.method, e.status_code, e.ip, h.envelope_enc, h.integrity_hmac,
            h.capture_reason, h.captured_at, h.expires_at
     FROM api_sentinel_events e
     LEFT JOIN sentinel_http_envelopes h ON h.request_id = e.request_id
     WHERE e.id = ? LIMIT 1`,
    [eventId]
  );
  if (!rows.length) throw Object.assign(new Error('Security event not found'), { status: 404 });
  const row = rows[0];
  if (!row.envelope_enc) {
    await recordForensicAccess(pool, row, admin, purpose, ip, userAgent, 'unavailable', false);
    throw Object.assign(new Error('Forensic evidence is unavailable or expired'), { status: 404 });
  }
  let plaintext;
  let integrityOk = false;
  try {
    plaintext = decryptSecret(row.envelope_enc);
    integrityOk = safeEqualHex(row.integrity_hmac, integrityFor(row.request_id, plaintext));
    if (!integrityOk && getForensicKey()) {
      integrityOk = safeEqualHex(
        row.integrity_hmac,
        integrityFor(row.request_id, plaintext, getSessionSecret())
      );
    }
  } catch {
    integrityOk = false;
  }
  if (!integrityOk) {
    await recordForensicAccess(pool, row, admin, purpose, ip, userAgent, 'integrity_failure', false);
    throw Object.assign(new Error('Forensic evidence failed integrity verification'), { status: 409, code: 'EVIDENCE_INTEGRITY_FAILURE' });
  }
  let envelope;
  try {
    envelope = JSON.parse(plaintext);
  } catch {
    await recordForensicAccess(pool, row, admin, purpose, ip, userAgent, 'decode_failure', false);
    throw Object.assign(new Error('Forensic evidence could not be decoded'), { status: 409, code: 'EVIDENCE_DECODE_FAILURE' });
  }
  await recordForensicAccess(pool, row, admin, purpose, ip, userAgent, 'revealed', true);
  return {
    event: {
      id: row.event_id, requestId: row.request_id, createdAt: row.created_at,
      surface: row.surface, action: row.action, method: row.method, path: row.path,
      statusCode: row.status_code, ip: row.ip,
    },
    evidence: envelope,
    integrity: { verified: true, algorithm: 'HMAC-SHA-256', capturedAt: row.captured_at, expiresAt: row.expires_at },
  };
}

async function recordForensicAccess(pool, row, admin, reason, ip, userAgent, outcome, integrityOk) {
  await pool.query(
    `INSERT INTO sentinel_forensic_access
      (id, request_id, event_id, admin_id, admin_username, purpose, ip, user_agent,
       fields_viewed, integrity_ok, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'request,response,headers,payload', ?, ?)`,
    [crypto.randomUUID(), row.request_id, row.event_id, admin?.id || null,
      String(admin?.username || '').slice(0, 128) || null, reason,
      String(ip || '').slice(0, 45) || null, String(userAgent || '').slice(0, 512) || null,
      integrityOk ? 1 : 0, outcome]
  );
}

async function purgeExpiredForensics() {
  const pool = getPool();
  const [result] = await pool.query('DELETE FROM sentinel_http_envelopes WHERE expires_at < NOW(3)');
  return Number(result.affectedRows) || 0;
}

async function listForensicAccess({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [rows] = await getPool().query(
    `SELECT id, accessed_at, request_id, event_id, admin_id, admin_username, purpose,
            ip, fields_viewed, integrity_ok, outcome
     FROM sentinel_forensic_access ORDER BY accessed_at DESC LIMIT ?`,
    [safeLimit]
  );
  return rows;
}

module.exports = {
  attachForensicCapture,
  redactValue,
  sanitizeHeaders,
  sanitizeUrl,
  boundedBody,
  integrityFor,
  revealForensicEvidence,
  purgeExpiredForensics,
  listForensicAccess,
  shouldSkipCapture,
};
