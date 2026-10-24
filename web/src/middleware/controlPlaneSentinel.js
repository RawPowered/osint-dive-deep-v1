const { recordEvent, newRequestId } = require('../services/sentinel');
const { touchSighting } = require('../services/sentinelSightings');
const { principalType } = require('./sessionAuth');
const { attachForensicCapture } = require('../services/sentinelForensics');

const ACTION_RULES = [
  rule('PUT', /^\/api\/owl\/service-pools$/, 'owl.service_pool.configure', 'service_pool'),
  rule('PUT', /^\/api\/owl\/service-pool-calendars$/, 'owl.service_pool.calendars.configure', 'service_pool'),
  rule('POST', /^\/api\/owl\/service-pools\/move$/, 'owl.service_pool.leads.move', 'lead_batch'),
  rule('POST', /^\/api\/owl\/service-pools\/reclassify$/, 'owl.service_pool.reclassify', 'lead_batch'),
  rule('POST', /^\/api\/owl\/service-pools\/recheck$/, 'owl.service_pool.recheck', 'lead_batch'),
  rule('PUT', /^\/api\/owl\/pool-rules\/([^/]+)$/, 'owl.pool_rule.configure', 'pool_rule', 1),
  rule('POST', /^\/api\/owl\/pools\/move$/, 'owl.pool.leads.move', 'lead_batch'),
  rule('POST', /^\/api\/owl\/leads\/pull$/, 'owl.crm_pull.queue', 'crm_import_run'),
  rule('POST', /^\/api\/owl\/dnc-screening\/scrub$/, 'owl.dnc.api.batch_scrub', 'lead_batch'),
  rule('POST', /^\/api\/owl\/dnc-review-rescrub$/, 'owl.dnc.api.review_rescrub', 'lead_batch'),
  rule('POST', /^\/api\/owl\/dnc-review-release$/, 'owl.dnc.review.release', 'lead_batch'),
  rule('POST', /^\/api\/owl\/no-phone\/refresh$/, 'owl.channels.no_phone_refresh', 'lead_batch'),
  rule('POST', /^\/api\/owl\/dnc-rescrub$/, 'owl.dnc.api.pool_rescrub', 'lead_batch'),
  rule('POST', /^\/api\/owl\/dnc-screening\/([^/]+)\/scrub$/, 'owl.dnc.api.lead_scrub', 'lead', 1),
  rule('POST', /^\/api\/owl\/dnc-screening\/tag-check$/, 'owl.dnc.batch_check', 'lead_batch'),
  rule('POST', /^\/api\/owl\/dnc-screening\/([^/]+)\/tag-check$/, 'owl.dnc.lead_check', 'lead', 1),
  rule('PATCH', /^\/api\/owl\/leads\/([^/]+)$/, 'owl.lead.update', 'lead', 1),
  rule('POST', /^\/api\/owl\/leads\/assign$/, 'owl.leads.assign', 'lead_batch'),
  rule('POST', /^\/api\/owl\/leads\/unassign$/, 'owl.leads.unassign', 'lead_batch'),
  rule('POST', /^\/api\/owl\/leads\/([^/]+)\/scheduled-call-release$/, 'owl.lead.scheduled_call_release', 'lead', 1),
  rule('POST', /^\/api\/owl\/access\/accounts$/, 'owl.access.account.create', 'administrator'),
  rule('POST', /^\/api\/owl\/users$/, 'owl.user.create', 'user'),
  rule('PATCH', /^\/api\/owl\/users\/([^/]+)\/password$/, 'owl.user.password_change', 'user', 1),
  rule('PATCH', /^\/api\/owl\/users\/([^/]+)$/, 'owl.user.update', 'user', 1),
  rule('PUT', /^\/api\/owl\/schedules\/([^/]+)$/, 'owl.schedule.update', 'schedule', 1),
  rule('POST', /^\/api\/owl\/schedules\/([^/]+)\/submit$/, 'owl.schedule.submit', 'schedule', 1),

  rule('POST', /^\/api\/eagle\/snapshots$/, 'eagle.snapshot.create', 'snapshot'),
  rule('POST', /^\/api\/eagle\/geography-reference\/refresh$/, 'eagle.census.refresh', 'geography_reference'),
  rule('POST', /^\/api\/eagle\/campaigns\/sync$/, 'eagle.campaign.sync', 'campaign_sync'),
  rule('GET', /^\/api\/eagle\/export\.csv$/, 'eagle.leads.export', 'lead_export'),
  rule('POST', /^\/api\/eagle\/debug\/schedules\/([^/]+)\/reset$/, 'eagle.schedule.reset', 'schedule', 1),

  rule('POST', /^\/api\/song\/scripts$/, 'song.script.create', 'song_script'),
  rule('POST', /^\/api\/song\/imports\/vibe\/preview$/, 'song.vibe_import.preview', 'song_import'),
  rule('POST', /^\/api\/song\/imports\/vibe\/apply$/, 'song.vibe_import.apply', 'song_import'),
  rule('PUT', /^\/api\/song\/scripts\/([^/]+)\/draft$/, 'song.script.save', 'song_script', 1),
  rule('POST', /^\/api\/song\/scripts\/([^/]+)\/validate$/, 'song.script.validate', 'song_script', 1),
  rule('POST', /^\/api\/song\/scripts\/([^/]+)\/publish$/, 'song.script.publish', 'song_script', 1),
  rule('POST', /^\/api\/song\/scripts\/([^/]+)\/clone$/, 'song.script.clone', 'song_script', 1),
  rule('POST', /^\/api\/song\/scripts\/([^/]+)\/archive$/, 'song.script.archive', 'song_script', 1),

  rule('POST', /^\/api\/hawk\/flows$/, 'hawk.flow.create', 'hawk_flow'),
  rule('POST', /^\/api\/hawk\/folders$/, 'hawk.folder.create', 'hawk_flow_folder'),
  rule('PUT', /^\/api\/hawk\/folders\/([^/]+)$/, 'hawk.folder.update', 'hawk_flow_folder', 1),
  rule('DELETE', /^\/api\/hawk\/folders\/([^/]+)$/, 'hawk.folder.delete', 'hawk_flow_folder', 1),
  rule('POST', /^\/api\/hawk\/catalog\/refresh$/, 'hawk.catalog.refresh', 'crm_integration'),
  rule('POST', /^\/api\/hawk\/imports\/preview$/, 'hawk.import.preview', 'hawk_import'),
  rule('POST', /^\/api\/hawk\/imports\/apply$/, 'hawk.import.apply', 'hawk_import'),
  rule('PUT', /^\/api\/hawk\/flows\/([^/]+)\/draft$/, 'hawk.flow.save', 'hawk_flow', 1),
  rule('PUT', /^\/api\/hawk\/flows\/([^/]+)\/organization$/, 'hawk.flow.organize', 'hawk_flow', 1),
  rule('POST', /^\/api\/hawk\/flows\/([^/]+)\/archive$/, 'hawk.flow.archive', 'hawk_flow', 1),
  rule('POST', /^\/api\/hawk\/flows\/([^/]+)\/validate$/, 'hawk.flow.validate', 'hawk_flow', 1),
  rule('POST', /^\/api\/hawk\/flows\/([^/]+)\/publish$/, 'hawk.flow.publish', 'hawk_flow', 1),
  rule('POST', /^\/api\/hawk\/flows\/([^/]+)\/state$/, 'hawk.flow.state', 'hawk_flow', 1),
  rule('POST', /^\/api\/hawk\/flows\/([^/]+)\/test$/, 'hawk.execution.test', 'hawk_flow', 1),
  rule('POST', /^\/api\/hawk\/flows\/([^/]+)\/webhook-sample$/, 'hawk.webhook.sample.send', 'hawk_flow', 1),
  rule('POST', /^\/api\/hawk\/flows\/([^/]+)\/execute$/, 'hawk.execution.live', 'hawk_flow', 1),
  rule('POST', /^\/api\/hawk\/executions\/([^/]+)\/replay$/, 'hawk.execution.replay', 'hawk_execution', 1),

  rule('GET', /^\/api\/parrot\/health$/, 'parrot.health.read', 'parrot_service'),
  rule('GET', /^\/api\/parrot\/catalog$/, 'parrot.catalog.read', 'parrot_catalog'),
  rule('GET', /^\/api\/parrot\/runs$/, 'parrot.run.list', 'parrot_run'),
  rule('GET', /^\/api\/parrot\/runs\/([^/]+)$/, 'parrot.run.read', 'parrot_run', 1),
  rule('POST', /^\/api\/parrot\/runs$/, 'parrot.run.create', 'parrot_run'),
  rule('POST', /^\/api\/parrot\/scripts\/validate$/, 'parrot.script.validate', 'parrot_script'),
  rule('GET', /^\/api\/parrot\/imports\/schema$/, 'parrot.import.schema', 'parrot_import'),
  rule('POST', /^\/api\/parrot\/imports\/preview$/, 'parrot.import.preview', 'parrot_import'),
  rule('POST', /^\/api\/parrot\/imports\/apply$/, 'parrot.import.apply', 'parrot_import'),
  rule('GET', /^\/api\/parrot\/scripts$/, 'parrot.script.list', 'parrot_script'),
  rule('POST', /^\/api\/parrot\/scripts$/, 'parrot.script.create', 'parrot_script'),
  rule('GET', /^\/api\/parrot\/scripts\/([^/]+)$/, 'parrot.script.read', 'parrot_script', 1),
  rule('GET', /^\/api\/parrot\/scripts\/([^/]+)\/export$/, 'parrot.script.export', 'parrot_script', 1),
  rule('PUT', /^\/api\/parrot\/scripts\/([^/]+)$/, 'parrot.script.version.create', 'parrot_script', 1),
  rule('POST', /^\/api\/parrot\/scripts\/([^/]+)\/dry-run$/, 'parrot.script.dry_run', 'parrot_script', 1),
  rule('POST', /^\/api\/parrot\/scripts\/([^/]+)\/deploy$/, 'parrot.script.deploy', 'parrot_script', 1),
  rule('POST', /^\/api\/parrot\/scripts\/([^/]+)\/retire$/, 'parrot.script.retire', 'parrot_script', 1),
];

function controlPlaneSentinel(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  const started = process.hrtime.bigint();
  const requestId = req.sentinelRequestId || newRequestId();
  req.sentinelRequestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  attachForensicCapture(req, res, requestId);
  // Capture while inside the mounted admin router. Express restores the outer secret mount later.
  const classified = classifyControlRequest(req.method, internalPath(req));

  res.on('finish', () => {
    const status = res.statusCode;
    const admin = req.session?.admin || null;
    const apiKeyId = safeApiKeyId(
      req.sentinelControl?.apiKeyId || req.body?.apiKeyId || req.query?.apiKeyId || admin?.apiKeyId
    );
    const outcome = req.sentinelControlDenied || status === 401 || status === 403
      ? 'denied'
      : status >= 400 ? 'failure' : 'success';
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const event = {
      request_id:requestId,
      api_key_id:apiKeyId,
      method:req.method,
      path:classified.path,
      status_code:status,
      duration_ms:Math.round(durationMs),
      ip:req.ip,
      user_agent:req.get('user-agent'),
      location_id:safeId(req.sentinelControl?.locationId || req.body?.locationId || req.query?.locationId, 128),
      error_class:classifyError(status, outcome),
      surface:classified.surface,
      actor_type:admin ? principalType(admin) : 'anonymous',
      actor_id:safeId(admin?.id, 128),
      actor_username:safeUsername(admin?.username),
      action:req.sentinelControl?.action || classified.action,
      entity_type:req.sentinelControl?.entityType || classified.entityType,
      entity_id:safeId(req.sentinelControl?.entityId || classified.entityId, 191),
      outcome,
    };
    recordEvent(event);
    touchSighting({
      ip:req.ip, status_code:status, path:classified.path, method:req.method,
      error_class:event.error_class,
    });
  });
  next();
}

function classifyControlRequest(method, inputPath) {
  const path = normalizePath(inputPath);
  const surface = surfaceFor(path);
  for (const item of ACTION_RULES) {
    if (item.method !== String(method || '').toUpperCase()) continue;
    const match = path.match(item.pattern);
    if (!match) continue;
    return {
      surface,
      path:item.entityIndex ? path.replace(match[item.entityIndex], ':id') : path,
      action:item.action,
      entityType:item.entityType,
      entityId:item.entityIndex ? safeId(match[item.entityIndex], 191) : null,
    };
  }
  const verb = method === 'GET' ? (path.endsWith('.csv') ? 'export' : 'read')
    : method === 'POST' ? 'create'
      : method === 'DELETE' ? 'delete' : 'update';
  return {
    surface,
    path:redactDynamicPath(path),
    action:`${surface}.${verb}`,
    entityType:null,
    entityId:null,
  };
}

function internalPath(req) {
  return normalizePath(req.path || req.url || '/');
}

function normalizePath(value) {
  const path = String(value || '/').split('?')[0];
  return path.startsWith('/') ? path.slice(0, 255) : `/${path}`.slice(0, 255);
}

function surfaceFor(path) {
  if (/^\/(?:api\/)?owl(?:\/|$)/.test(path)) return 'owl';
  if (/^\/(?:api\/)?eagle(?:\/|$)/.test(path)) return 'eagle';
  if (/^\/(?:api\/)?song(?:\/|$)/.test(path)) return 'song';
  if (/^\/(?:api\/)?hawk(?:\/|$)/.test(path)) return 'hawk';
  if (/^\/(?:api\/)?parrot(?:\/|$)/.test(path)) return 'parrot';
  if (/^\/(?:api\/)?sentinel(?:\/|$)/.test(path)) return 'sentinel';
  if (/^\/(?:api\/)?crm-integrations(?:\/|$)/.test(path)) return 'crm_admin';
  if (/^\/(?:api\/)?divedeep(?:\/|$)/.test(path)) return 'divedeep';
  return 'admin';
}

function redactDynamicPath(path) {
  return path.replace(
    /\/(scripts|flows|executions|runs|leads|users|schedules|snapshots|pulls|sync|cases|blocks|rules)\/[^/]+/g,
    '/$1/:id'
  );
}

function classifyError(status, outcome) {
  if (outcome === 'denied') return 'unauthorized';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'none';
}

function safeApiKeyId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,36}$/.test(text) ? text : null;
}

function safeId(value, length) {
  if (value == null) return null;
  const text = String(value).trim();
  return text && /^[A-Za-z0-9_.:@-]+$/.test(text) ? text.slice(0, length) : null;
}

function safeUsername(value) {
  if (value == null) return null;
  return String(value).replace(/[\r\n\t]/g, '').slice(0, 128) || null;
}

function rule(method, pattern, action, entityType, entityIndex = null) {
  return { method, pattern, action, entityType, entityIndex };
}

module.exports = {
  controlPlaneSentinel,
  classifyControlRequest,
  normalizePath,
  surfaceFor,
  safeId,
};
