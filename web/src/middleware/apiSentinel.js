const { recordEvent, newRequestId } = require('../services/sentinel');
const { touchSighting } = require('../services/sentinelSightings');
const { attachForensicCapture } = require('../services/sentinelForensics');

function extractLocationId(req) {
  if (req.body && req.body.locationId) return String(req.body.locationId);
  if (req.query && req.query.locationId) return String(req.query.locationId);
  return null;
}

function classifyError(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'none';
}

/**
 * Logs every /api request after response finishes. Never logs secrets.
 * Place early on the API router (before or after auth — works either way).
 * Also updates first-contact IP sightings (async).
 */
function apiSentinel(req, res, next) {
  // Do not log CORS preflight noise
  if (req.method === 'OPTIONS') return next();

  const started = process.hrtime.bigint();
  const requestId = req.sentinelRequestId || newRequestId();
  req.sentinelRequestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  attachForensicCapture(req, res, requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const status = res.statusCode;
    const key = req.apiKey || null;
    const path = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;
    const errorClass = classifyError(status);
    const operator = req.operatorSession || null;
    const outcome = status === 401 || status === 403 ? 'denied' : status >= 400 ? 'failure' : 'success';
    const context = apiContext(req.method, req.path);

    recordEvent({
      request_id: requestId,
      api_key_id: key && key.id ? key.id : null,
      key_prefix: key && key.key_prefix ? key.key_prefix : null,
      method: req.method,
      path,
      status_code: status,
      duration_ms: Math.round(durationMs),
      ip: req.ip,
      user_agent: req.get('user-agent'),
      location_id: extractLocationId(req),
      error_class: errorClass,
      surface:context.surface,
      actor_type:operator ? 'operator' : key ? 'api_key' : 'anonymous',
      actor_id:operator?.userId || null,
      actor_username:operator?.username || null,
      action:req.sentinelApi?.action || context.action,
      entity_type:req.sentinelApi?.entityType || context.entityType,
      entity_id:req.sentinelApi?.entityId ? String(req.sentinelApi.entityId).slice(0, 191) : context.entityId,
      outcome,
    });

    touchSighting({
      ip: req.ip,
      status_code: status,
      path,
      method: req.method,
      error_class: errorClass,
    });
  });

  next();
}

function apiContext(method, path) {
  // Routers see the path relative to the install-defined public API mount.
  // Accept the historical development mount too so this pure helper remains
  // useful in isolated tests and log reprocessing.
  const routePath = String(path || '').replace(/^\/api(?=\/|$)/, '') || '/';
  const verb = method === 'GET' ? 'read' : method === 'DELETE' ? 'delete'
    : method === 'POST' ? 'create' : 'update';

  if (method === 'POST' && routePath === '/song/events') {
    return { surface: 'song', action: 'song.runtime.event', entityType: null, entityId: null };
  }
  if (routePath.startsWith('/leads') || routePath.startsWith('/sessions')) {
    return { surface: 'owl', action: `owl.${verb}`, entityType: null, entityId: null };
  }
  if (routePath.startsWith('/crm')) {
    return { surface: 'hawk', action: `hawk.crm.${verb}`, entityType: null, entityId: null };
  }
  if (routePath.startsWith('/song')) {
    return { surface: 'song', action: `song.runtime.${verb}`, entityType: null, entityId: null };
  }
  if (routePath.startsWith('/sql')) {
    return { surface: 'eagle', action: `eagle.sql.${verb}`, entityType: null, entityId: null };
  }
  if (routePath.startsWith('/workers/v1')) {
    return { surface: 'divedeep', action: `divedeep.worker.${verb}`, entityType: 'recon_job', entityId: null };
  }
  if (routePath.startsWith('/customer/v1')) {
    return { surface: 'divedeep', action: `divedeep.customer_api.${verb}`, entityType: 'divedeep_customer', entityId: null };
  }
  if (routePath.startsWith('/enterprise/v1')) {
    return { surface: 'divedeep', action: `divedeep.enterprise_api.${verb}`, entityType: 'divedeep_organization', entityId: null };
  }
  if (routePath.startsWith('/integrations/v1')) {
    return { surface: 'divedeep', action: `divedeep.integration_api.${verb}`, entityType: 'divedeep_service_identity', entityId: null };
  }
  if (routePath.startsWith('/divedeep')) {
    return { surface: 'divedeep', action: `divedeep.${verb}`, entityType: null, entityId: null };
  }
  if (routePath.startsWith('/system') || routePath.startsWith('/users')) {
    return { surface: 'sentinel', action: `sentinel.auth.${verb}`, entityType: null, entityId: null };
  }
  
  return { surface: 'api', action: `api.${verb}`, entityType: null, entityId: null };
}

module.exports = { apiSentinel, apiContext };
