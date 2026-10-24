const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getParrotConfig } = require('../config');
const { recordEvent, newRequestId } = require('./sentinel');

const CONTRACT_VERSION = 'parrot.v1';
const SOURCES = Object.freeze(['hawk', 'eagle', 'owl', 'admin']);
const MODES = Object.freeze(['dry_run', 'live']);
const SCRIPT_ID_RE = /^[a-z][a-z0-9_.-]{1,95}$/;
const SAFE_ID_RE = /^[A-Za-z0-9_.:@-]+$/;
const SECRET_KEY_RE = /(?:authorization|cookie|password|secret|token|credential|api[_-]?key)/i;
const MAX_STORED_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024;
const SOURCE_CAPABILITIES = Object.freeze([]);

async function checkHealth(fetchImpl = global.fetch) {
  const config = requireConfig();
  return requestJson(`${config.baseUrl}/healthz`, { method:'GET' }, config.timeoutMs, fetchImpl, false);
}

async function getCatalog(fetchImpl = global.fetch) {
  const config = requireConfig();
  const payload = await requestJson(`${config.baseUrl}/v1/catalog`, {
    method:'GET',
    headers:{ Accept:'application/json', Authorization:`Bearer ${config.token}` },
  }, config.timeoutMs, fetchImpl);
  const scripts = Array.isArray(payload.scripts) ? payload.scripts.map(publicScript).filter(Boolean) : [];
  return { contractVersion:payload.contractVersion || CONTRACT_VERSION, scripts };
}

async function validateSource(input, fetchImpl = global.fetch) {
  const config = requireConfig();
  const source = String(input?.source || '');
  if (!source.trim()) throw statusError('Python source is required', 400, 'PARROT_SOURCE_REQUIRED');
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw statusError('Python source is too large', 413, 'PARROT_SOURCE_TOO_LARGE');
  const payload = await requestJson(`${config.baseUrl}/v1/source/validate`, {
    method:'POST',
    headers:{ Accept:'application/json', 'Content-Type':'application/json', Authorization:`Bearer ${config.token}` },
    body:JSON.stringify({ source, capabilities:normalizeCapabilities(input.capabilities) }),
  }, config.timeoutMs, fetchImpl);
  return safeData(payload.validation || {});
}

async function runScript(input, options = {}, pool = null, fetchImpl = global.fetch) {
  const p = pool || getPool();
  const config = requireConfig();
  const normalized = normalizeRun(input, options, config);
  if (normalized.idempotencyKey) {
    const existing = await findIdempotentRun(p, normalized);
    if (existing) return { ...publicRun(existing), reused:true };
  }
  const started = Date.now();
  await p.query(
    `INSERT INTO parrot_runs
      (id,request_id,api_key_id,location_id,data_source_slug,source,script_id,script_version,mode,status,
       idempotency_key,input_json,initiated_by_type,initiated_by_id)
     VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?,?)`,
    [normalized.runId, normalized.requestId, normalized.apiKeyId, normalized.locationId,
      normalized.dataSourceSlug, normalized.source, normalized.scriptId, normalized.scriptVersion,
      normalized.mode, normalized.idempotencyKey, JSON.stringify(normalized.inputs),
      normalized.actorType, normalized.actorId]
  );
  let statusCode = 200;
  let outcome = 'success';
  let errorClass = 'none';
  try {
    const payload = await requestJson(`${config.baseUrl}/v1/runs`, {
      method:'POST',
      headers:{
        Accept:'application/json', 'Content-Type':'application/json',
        Authorization:`Bearer ${config.token}`, 'X-Request-Id':normalized.requestId,
      },
      body:JSON.stringify({
        contractVersion:CONTRACT_VERSION,
        runId:normalized.runId,
        requestId:normalized.requestId,
        source:normalized.source,
        mode:normalized.mode,
        scriptId:normalized.scriptId,
        scriptVersion:normalized.scriptVersion,
        idempotencyKey:normalized.idempotencyKey,
        context:{
          apiKeyId:normalized.apiKeyId,
          locationId:normalized.locationId,
          dataSourceSlug:normalized.dataSourceSlug,
          actorType:normalized.actorType,
          actorId:normalized.actorId,
          hawkExecutionId:normalized.hawkExecutionId,
          hawkNodeId:normalized.hawkNodeId,
        },
        inputs:normalized.inputs,
        limits:{ timeoutMs:normalized.timeoutMs, outputBytes:MAX_STORED_BYTES },
        ...(normalized.sourcePackage ? { sourcePackage:normalized.sourcePackage } : {}),
      }),
    }, normalized.timeoutMs, fetchImpl);
    const output = safeData(payload.output);
    const durationMs = Math.max(0, Number(payload.metrics?.durationMs) || (Date.now() - started));
    await p.query(
      `UPDATE parrot_runs SET status='completed',script_version=?,output_json=?,duration_ms=?,completed_at=UTC_TIMESTAMP(3)
       WHERE id=?`,
      [cleanText(payload.script?.version || normalized.scriptVersion, 32) || null,
        JSON.stringify(output), durationMs, normalized.runId]
    );
    const completedAt = new Date().toISOString();
    return {
      id:normalized.runId, requestId:normalized.requestId, apiKeyId:normalized.apiKeyId,
      locationId:normalized.locationId, dataSourceSlug:normalized.dataSourceSlug,
      source:normalized.source, scriptId:normalized.scriptId,
      scriptVersion:cleanText(payload.script?.version || normalized.scriptVersion, 32) || null,
      mode:normalized.mode, status:'completed', idempotencyKey:normalized.idempotencyKey,
      output, durationMs, warnings:Array.isArray(payload.warnings) ? payload.warnings.slice(0, 20) : [],
      startedAt:new Date(started).toISOString(), completedAt, createdAt:new Date(started).toISOString(), reused:false,
    };
  } catch (error) {
    statusCode = Number(error.status) || 502;
    outcome = 'failure';
    errorClass = error.code === 'PARROT_TIMEOUT' ? 'timeout' : statusCode >= 500 ? 'server' : 'client';
    await p.query(
      `UPDATE parrot_runs SET status='failed',error_code=?,error_message=?,duration_ms=?,completed_at=UTC_TIMESTAMP(3)
       WHERE id=?`,
      [cleanText(error.code || 'PARROT_RUN_FAILED', 64), cleanText(error.message, 1000), Date.now() - started, normalized.runId]
    );
    throw error;
  } finally {
    if (options.telemetry !== false) recordEvent({
      request_id:normalized.requestId,
      api_key_id:normalized.apiKeyId,
      method:'POST', path:'/internal/parrot/v1/runs', status_code:statusCode,
      duration_ms:Date.now() - started, location_id:normalized.locationId,
      error_class:errorClass, surface:'parrot', actor_type:normalized.source,
      actor_id:normalized.actorId, action:`parrot.run.${outcome === 'success' ? 'completed' : 'failed'}`,
      entity_type:'parrot_script', entity_id:normalized.scriptId, outcome,
    });
  }
}

async function listRuns(scope, filters = {}, pool = null) {
  requireScope(scope);
  const p = pool || getPool();
  const where = ['api_key_id=?', 'location_id=?', 'data_source_slug=?'];
  const params = [scope.apiKeyId, scope.locationId, cleanSourceSlug(scope.dataSourceSlug)];
  if (filters.status && ['running', 'completed', 'failed'].includes(String(filters.status))) {
    where.push('status=?'); params.push(String(filters.status));
  }
  if (filters.source && SOURCES.includes(String(filters.source))) {
    where.push('source=?'); params.push(String(filters.source));
  }
  if (filters.scriptId && SCRIPT_ID_RE.test(String(filters.scriptId))) {
    where.push('script_id=?'); params.push(String(filters.scriptId));
  }
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  const [rows] = await p.query(
    `SELECT * FROM parrot_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit]
  );
  return rows.map(publicRun);
}

async function getRun(id, scope, pool = null) {
  requireScope(scope);
  const runId = safeId(id, 36);
  if (!runId) throw statusError('Invalid PARROT run ID', 400, 'PARROT_RUN_ID_INVALID');
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT * FROM parrot_runs WHERE id=? AND api_key_id=? AND location_id=? AND data_source_slug=? LIMIT 1`,
    [runId, scope.apiKeyId, scope.locationId, cleanSourceSlug(scope.dataSourceSlug)]
  );
  if (!rows[0]) throw statusError('PARROT run not found', 404, 'PARROT_RUN_NOT_FOUND');
  return publicRun(rows[0]);
}

function normalizeRun(input, options, config) {
  const source = String(input.source || 'admin').trim().toLowerCase();
  const mode = String(input.mode || 'dry_run').trim().toLowerCase();
  const scriptId = String(input.scriptId || '').trim().toLowerCase();
  const apiKeyId = safeId(input.apiKeyId, 36);
  const locationId = safeId(input.locationId, 128);
  if (!apiKeyId || !locationId) throw statusError('apiKeyId and locationId are required', 400, 'PARROT_SCOPE_REQUIRED');
  if (!SOURCES.includes(source)) throw statusError('PARROT source is invalid', 400, 'PARROT_SOURCE_INVALID');
  if (!MODES.includes(mode)) throw statusError('PARROT mode is invalid', 400, 'PARROT_MODE_INVALID');
  if (!SCRIPT_ID_RE.test(scriptId)) throw statusError('PARROT script ID is invalid', 400, 'PARROT_SCRIPT_ID_INVALID');
  if (!input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs)) {
    throw statusError('PARROT inputs must be an object', 400, 'PARROT_INPUT_INVALID');
  }
  const inputs = safeData(input.inputs);
  if (Buffer.byteLength(JSON.stringify(inputs)) > 128 * 1024) throw statusError('PARROT inputs are too large', 413, 'PARROT_INPUT_TOO_LARGE');
  const requestedTimeout = Number(input.timeoutMs || config.timeoutMs);
  return {
    runId:crypto.randomUUID(),
    requestId:safeId(options.requestId || input.requestId, 64) || newRequestId(),
    apiKeyId, locationId, dataSourceSlug:cleanSourceSlug(input.dataSourceSlug),
    source, mode, scriptId, scriptVersion:cleanText(input.scriptVersion, 32) || null,
    idempotencyKey:cleanText(input.idempotencyKey, 191) || null,
    inputs,
    timeoutMs:Number.isFinite(requestedTimeout) ? Math.min(Math.max(requestedTimeout, 100), config.timeoutMs) : config.timeoutMs,
    actorType:cleanText(options.actorType || input.actorType || source, 32) || source,
    actorId:safeId(options.actorId || input.actorId, 128),
    hawkExecutionId:safeId(options.hawkExecutionId || input.hawkExecutionId, 36),
    hawkNodeId:safeId(options.hawkNodeId || input.hawkNodeId, 64),
    sourcePackage:normalizeSourcePackage(input.sourcePackage),
  };
}

function normalizeSourcePackage(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw statusError('PARROT source package is invalid', 400, 'PARROT_SOURCE_PACKAGE_INVALID');
  const source = String(value.source || '');
  if (!source.trim()) throw statusError('PARROT source package is missing source', 400, 'PARROT_SOURCE_REQUIRED');
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw statusError('PARROT source package is too large', 413, 'PARROT_SOURCE_TOO_LARGE');
  const sha256 = String(value.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw statusError('PARROT source package hash is invalid', 400, 'PARROT_SOURCE_HASH_INVALID');
  return {
    source,
    sha256,
    version:cleanText(value.version, 32) || sha256.slice(0, 12),
    capabilities:normalizeCapabilities(value.capabilities),
    approved:value.approved === true,
  };
}

function normalizeCapabilities(values) {
  return Array.isArray(values) ? [...new Set(values.map((item) => String(item).trim().toLowerCase()).filter((item) => SOURCE_CAPABILITIES.includes(item)))].sort() : [];
}

async function requestJson(url, init, timeoutMs, fetchImpl, requireOk = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, redirect:'error', signal:controller.signal });
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_STORED_BYTES) throw statusError('PARROT response is too large', 502, 'PARROT_RESPONSE_TOO_LARGE');
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch {
      const contentType = cleanText(response.headers?.get?.('content-type'), 80) || 'unknown content type';
      throw statusError(
        `PARROT returned a non-JSON response (HTTP ${response.status}; ${contentType})`,
        502,
        'PARROT_RESPONSE_NON_JSON',
        { upstreamStatus:response.status, contentType }
      );
    }
    if ((requireOk && (!response.ok || payload.ok === false)) || (!requireOk && !response.ok)) {
      const status = response.status >= 500 ? 502 : response.status === 401 || response.status === 403 ? 502 : 422;
      throw statusError(cleanText(payload.error, 500) || `PARROT returned HTTP ${response.status}`, status,
        cleanText(payload.code, 64) || 'PARROT_HTTP_ERROR');
    }
    return safeData(payload);
  } catch (error) {
    if (error.name === 'AbortError') throw statusError('PARROT request timed out', 504, 'PARROT_TIMEOUT');
    throw error;
  } finally { clearTimeout(timer); }
}

async function findIdempotentRun(pool, input) {
  const [rows] = await pool.query(
    `SELECT * FROM parrot_runs WHERE api_key_id=? AND location_id=? AND source=? AND script_id=? AND idempotency_key=? LIMIT 1`,
    [input.apiKeyId, input.locationId, input.source, input.scriptId, input.idempotencyKey]
  );
  return rows[0] || null;
}

function publicScript(script) {
  const id = String(script?.id || '').trim().toLowerCase();
  if (!SCRIPT_ID_RE.test(id)) return null;
  return {
    id, version:cleanText(script.version, 32), name:cleanText(script.name, 191) || id,
    description:cleanText(script.description, 1000), owner:cleanText(script.owner, 191),
    sources:Array.isArray(script.sources) ? script.sources.filter((item) => SOURCES.includes(item)) : [],
    modes:Array.isArray(script.modes) ? script.modes.filter((item) => MODES.includes(item)) : [],
    timeoutMs:Math.min(Math.max(Number(script.timeoutMs) || 5000, 100), 30000),
    dataSensitivity:cleanText(script.dataSensitivity, 32) || 'internal',
    inputSchema:safeData(script.inputSchema || {}), outputSchema:safeData(script.outputSchema || {}),
  };
}

function publicRun(row) {
  return {
    id:row.id, requestId:row.request_id, apiKeyId:row.api_key_id, locationId:row.location_id,
    dataSourceSlug:row.data_source_slug || 'core', source:row.source, scriptId:row.script_id,
    scriptVersion:row.script_version || null, mode:row.mode, status:row.status,
    idempotencyKey:row.idempotency_key || null, input:safeData(parseJson(row.input_json, {})),
    output:safeData(parseJson(row.output_json, null)), errorCode:row.error_code || null,
    errorMessage:row.error_message || null, durationMs:row.duration_ms == null ? null : Number(row.duration_ms),
    initiatedByType:row.initiated_by_type || null, initiatedById:row.initiated_by_id || null,
    startedAt:row.started_at || null, completedAt:row.completed_at || null, createdAt:row.created_at || null,
  };
}

function safeData(value, depth = 0) {
  if (depth > 8) return '[depth-limited]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 16000);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeData(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      output[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : safeData(item, depth + 1);
    }
    if (depth === 0 && Buffer.byteLength(JSON.stringify(output)) > MAX_STORED_BYTES) {
      return { _truncated:true, preview:JSON.stringify(output).slice(0, 16000) };
    }
    return output;
  }
  return String(value).slice(0, 1000);
}

function requireConfig() {
  const config = getParrotConfig();
  if (!config.enabled) throw statusError('PARROT is not configured', 503, 'PARROT_NOT_CONFIGURED', { reason:config.error });
  return config;
}
function requireScope(scope) {
  if (!safeId(scope?.apiKeyId, 36) || !safeId(scope?.locationId, 128)) throw statusError('PARROT scope is required', 400, 'PARROT_SCOPE_REQUIRED');
}
function cleanSourceSlug(value) {
  const slug = String(value || 'core').trim().toLowerCase();
  return slug === 'core' || /^[a-z][a-z0-9_-]{1,62}$/.test(slug) ? slug : 'core';
}
function safeId(value, length) { const text = String(value || '').trim(); return text && SAFE_ID_RE.test(text) ? text.slice(0, length) : null; }
function cleanText(value, length) { return String(value == null ? '' : value).trim().replace(/[\r\n\t]/g, ' ').slice(0, length); }
function parseJson(value, fallback) { if (value == null || value === '') return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function statusError(message, status, code, details = null) { return Object.assign(new Error(message), { status, code, details }); }

module.exports = {
  CONTRACT_VERSION, SOURCES, MODES, SOURCE_CAPABILITIES, checkHealth, getCatalog, validateSource, runScript, listRuns, getRun,
  normalizeRun, normalizeSourcePackage, normalizeCapabilities, requestJson, safeData, publicScript, publicRun,
};
