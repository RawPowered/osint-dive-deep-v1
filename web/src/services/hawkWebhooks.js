const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { encryptSecret, decryptSecret } = require('./secretBox');
const hawk = require('./hawk');

const MAX_SKEW_SECONDS = 300;
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{20,64}$/;

async function getFlowWebhook(flowId, scope, pool = null) {
  const p = pool || getPool();
  await hawk.getFlow(flowId, scope, p);
  const [rows] = await p.query(
    `SELECT id,flow_id,public_id,secret_hint,is_enabled,last_received_at,created_at,updated_at
     FROM hawk_webhook_endpoints WHERE flow_id=? LIMIT 1`, [flowId]
  );
  return publicEndpoint(rows[0] || null);
}

async function provisionFlowWebhook(flowId, scope, actor, options = {}, pool = null) {
  const p = pool || getPool();
  const flow = await hawk.getFlow(flowId, scope, p);
  const trigger = flow.graph?.nodes?.find((node) => node.type === 'trigger');
  if (!trigger || (trigger.config?.event || 'manual') === 'manual') {
    throw statusError('Select an automatic or webhook trigger before creating an endpoint', 409, 'HAWK_WEBHOOK_TRIGGER_REQUIRED');
  }
  const [existingRows] = await p.query('SELECT * FROM hawk_webhook_endpoints WHERE flow_id=? LIMIT 1', [flowId]);
  const existing = existingRows[0] || null;
  if (existing && options.rotate !== true) {
    if (!existing.is_enabled) {
      await p.query(
        `UPDATE hawk_webhook_endpoints SET is_enabled=1,rotated_by=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
        [actor?.id || null, existing.id]
      );
      return { endpoint:await getFlowWebhook(flowId, scope, p), secret:null, rotated:false };
    }
    return { endpoint:publicEndpoint(existing), secret:null, rotated:false };
  }

  const secret = crypto.randomBytes(32).toString('base64url');
  const hint = secret.slice(-6);
  if (existing) {
    await p.query(
      `UPDATE hawk_webhook_endpoints SET secret_enc=?,secret_hint=?,is_enabled=1,rotated_by=?,updated_at=CURRENT_TIMESTAMP(3)
       WHERE id=?`, [encryptSecret(secret), hint, actor?.id || null, existing.id]
    );
  } else {
    await p.query(
      `INSERT INTO hawk_webhook_endpoints
         (id,flow_id,public_id,secret_enc,secret_hint,is_enabled,created_by)
       VALUES (?,?,?,?,?,1,?)`,
      [crypto.randomUUID(), flowId, crypto.randomBytes(24).toString('base64url'), encryptSecret(secret), hint, actor?.id || null]
    );
  }
  return { endpoint: await getFlowWebhook(flowId, scope, p), secret, rotated: Boolean(existing) };
}

async function disableFlowWebhook(flowId, scope, actor, pool = null) {
  const p = pool || getPool();
  await hawk.getFlow(flowId, scope, p);
  await p.query(
    `UPDATE hawk_webhook_endpoints SET is_enabled=0,rotated_by=?,updated_at=CURRENT_TIMESTAMP(3)
     WHERE flow_id=?`, [actor?.id || null, flowId]
  );
  return getFlowWebhook(flowId, scope, p);
}

async function acceptWebhook(input, pool = null) {
  const p = pool || getPool();
  const publicId = String(input.publicId || '').trim();
  if (!PUBLIC_ID_RE.test(publicId)) throw statusError('Webhook endpoint not found', 404, 'HAWK_WEBHOOK_NOT_FOUND');
  const [rows] = await p.query(
    `SELECT w.*,f.api_key_id,f.location_id,f.data_source_slug,f.status AS flow_status,f.published_version_id,
            v.graph_json
     FROM hawk_webhook_endpoints w
     INNER JOIN hawk_flows f ON f.id=w.flow_id
     LEFT JOIN hawk_flow_versions v ON v.id=f.published_version_id
     WHERE w.public_id=? LIMIT 1`, [publicId]
  );
  const endpoint = rows[0];
  if (!endpoint || !endpoint.is_enabled) throw statusError('Webhook endpoint not found', 404, 'HAWK_WEBHOOK_NOT_FOUND');
  if (endpoint.flow_status !== 'active' || !endpoint.published_version_id || !endpoint.graph_json) {
    throw statusError('Webhook flow is not active', 409, 'HAWK_WEBHOOK_FLOW_INACTIVE');
  }

  const rawBody = Buffer.isBuffer(input.rawBody)
    ? input.rawBody
    : Buffer.from(JSON.stringify(input.body || {}), 'utf8');
  const secret = decryptSecret(endpoint.secret_enc);
  const authMode = verifyWebhookAuth(secret, input.headers || {}, rawBody, input.now || Date.now());
  const payload = normalizeWebhookPayload(input.body || {});
  if (payload.locationId && String(payload.locationId) !== String(endpoint.location_id)) {
    throw statusError('Webhook location does not match this HAWK flow', 403, 'HAWK_WEBHOOK_LOCATION_MISMATCH');
  }
  const graph = parseJson(endpoint.graph_json, {});
  const trigger = graph.nodes?.find((node) => node.type === 'trigger');
  const match = matchesTrigger(trigger, payload);
  if (!match.accepted) throw statusError(match.reason, 202, 'HAWK_WEBHOOK_IGNORED');

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const explicitId = header(input.headers, 'x-hawk-event-id') || payload.eventId || payload.webhookId;
  const bucket = Math.floor(Number(input.now || Date.now()) / (MAX_SKEW_SECONDS * 1000));
  const eventKey = String(explicitId ? `event:${explicitId}` : `body:${payloadHash}:${bucket}`).slice(0, 191);
  const deliveryId = crypto.randomUUID();
  try {
    await p.query(
      `INSERT INTO hawk_webhook_deliveries
         (id,endpoint_id,flow_id,request_id,event_key,payload_sha256,auth_mode,status)
       VALUES (?,?,?,?,?,?,?,'accepted')`,
      [deliveryId, endpoint.id, endpoint.flow_id, clean(input.requestId, 64) || null, eventKey, payloadHash, authMode]
    );
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') return { accepted: true, duplicate: true, deliveryId: null, dispatch: null };
    throw error;
  }
  await p.query('UPDATE hawk_webhook_endpoints SET last_received_at=CURRENT_TIMESTAMP(3) WHERE id=?', [endpoint.id]);
  return {
    accepted: true,
    duplicate: false,
    deliveryId,
    dispatch: {
      deliveryId,
      endpointId:endpoint.id,
      flowId:endpoint.flow_id,
      scope:{ apiKeyId:endpoint.api_key_id, locationId:endpoint.location_id, dataSourceSlug:endpoint.data_source_slug },
      input:payload,
      idempotencyKey:`webhook:${endpoint.id}:${eventKey}`.slice(0, 191),
      requestId:clean(input.requestId, 64) || null,
    },
  };
}

async function dispatchWebhook(dispatch, pool = null, fetchImpl = global.fetch) {
  if (!dispatch) return null;
  const p = pool || getPool();
  try {
    const execution = await hawk.executeFlow(dispatch.flowId, dispatch.scope, dispatch.input, {
      dryRun:false,
      confirmLive:true,
      useDraft:false,
      idempotencyKey:dispatch.idempotencyKey,
      requestId:dispatch.requestId,
      initiatedByType:'webhook',
      initiatedById:dispatch.endpointId,
    }, null, p, fetchImpl);
    await p.query(
      `UPDATE hawk_webhook_deliveries SET status=?,execution_id=?,error_code=?,completed_at=CURRENT_TIMESTAMP(3)
       WHERE id=?`,
      [execution.status === 'successful' ? 'completed' : 'failed', execution.id, execution.errorCode || null, dispatch.deliveryId]
    );
    return execution;
  } catch (error) {
    await p.query(
      `UPDATE hawk_webhook_deliveries SET status='failed',error_code=?,completed_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
      [clean(error.code || 'HAWK_WEBHOOK_DISPATCH_FAILED', 64), dispatch.deliveryId]
    );
    throw error;
  }
}

function verifyWebhookAuth(secret, headers, rawBody, now = Date.now()) {
  const authorization = header(headers, 'authorization');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || header(headers, 'x-hawk-secret');
  if (bearer && equalSecret(bearer, secret)) return 'bearer';

  const timestamp = header(headers, 'x-hawk-timestamp');
  const signature = header(headers, 'x-hawk-signature').replace(/^sha256=/i, '');
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) {
    throw statusError('Webhook authentication failed', 401, 'HAWK_WEBHOOK_AUTH_FAILED');
  }
  const seconds = timestamp.length === 13 ? Math.floor(Number(timestamp) / 1000) : Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > MAX_SKEW_SECONDS) {
    throw statusError('Webhook timestamp is outside the five-minute window', 401, 'HAWK_WEBHOOK_TIMESTAMP_INVALID');
  }
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  if (!equalSecret(signature.toLowerCase(), expected)) {
    throw statusError('Webhook authentication failed', 401, 'HAWK_WEBHOOK_AUTH_FAILED');
  }
  return 'hmac';
}

function normalizeWebhookPayload(body) {
  const root = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const contact = root.contact && typeof root.contact === 'object' ? root.contact : {};
  const customData = root.customData && typeof root.customData === 'object' && !Array.isArray(root.customData)
    ? root.customData
    : (root.custom_data && typeof root.custom_data === 'object' && !Array.isArray(root.custom_data) ? root.custom_data : {});
  const payload = hawk.normalizeTriggerData({ ...root, ...contact, ...customData });
  payload.contactId = payload.contactId || payload.contact_id || contact.id || root.id || null;
  payload.locationId = payload.locationId || payload.location_id || contact.locationId || root.location?.id || null;
  payload.eventName = payload.eventName || customData.eventName || customData.event_name || root.event || root.type || null;
  if (typeof payload.tags === 'string') payload.tags = payload.tags.split(',').map((tag) => tag.trim()).filter(Boolean);
  payload.webhook = { type:root.type || root.event || null, receivedAt:new Date().toISOString() };
  return hawk.safeData(payload);
}

function matchesTrigger(trigger, payload) {
  if (!trigger) return { accepted:false, reason:'Published flow has no trigger' };
  const config = trigger.config || {};
  const event = config.event || 'manual';
  if (event === 'manual') return { accepted:false, reason:'Manual flows do not accept webhooks' };
  if (event === 'webhook.received') {
    const expected = String(config.eventName || '').trim().toLowerCase();
    const received = String(payload.eventName || '').trim().toLowerCase();
    // The endpoint is already flow-scoped and authenticated. HighLevel's native
    // Webhook action may omit custom data from some standard payload variants,
    // so a missing discriminator is safe to infer. An explicit mismatch is not.
    return !expected || !received || received === expected
      ? { accepted:true }
      : { accepted:false, reason:`Webhook event does not match ${config.eventName}` };
  }
  if (event === 'contact.tag_added') {
    const expected = String(config.tag || '').trim().toLowerCase();
    const changed = String(payload.tag || payload.tagAdded || '').trim().toLowerCase();
    const tags = Array.isArray(payload.tags) ? payload.tags.map((tag) => String(tag).toLowerCase()) : [];
    return !expected || changed === expected || tags.includes(expected)
      ? { accepted:true }
      : { accepted:false, reason:`Contact does not contain configured tag ${config.tag}` };
  }
  if (event === 'contact.tag_removed') {
    const expected = String(config.tag || '').trim().toLowerCase();
    const changed = String(payload.tag || payload.tagRemoved || '').trim().toLowerCase();
    return !expected || changed === expected
      ? { accepted:true }
      : { accepted:false, reason:`Webhook does not identify removed tag ${config.tag}` };
  }
  return { accepted:true };
}

function publicEndpoint(row) {
  if (!row) return null;
  return {
    id:row.id,
    flowId:row.flow_id,
    publicId:row.public_id,
    secretHint:row.secret_hint,
    enabled:Boolean(row.is_enabled),
    lastReceivedAt:row.last_received_at || null,
    createdAt:row.created_at || null,
    updatedAt:row.updated_at || null,
    authentication:['bearer','hmac-sha256'],
  };
}

function header(headers, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) if (key.toLowerCase() === wanted) return String(Array.isArray(value) ? value[0] : value || '').trim();
  return '';
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function clean(value, max) { return String(value == null ? '' : value).trim().replace(/[\r\n\t]/g, ' ').slice(0, max); }
function parseJson(value, fallback) { try { return typeof value === 'object' ? value : JSON.parse(value); } catch { return fallback; } }
function statusError(message, status, code) { return Object.assign(new Error(message), { status, code }); }

module.exports = {
  getFlowWebhook,
  provisionFlowWebhook,
  disableFlowWebhook,
  acceptWebhook,
  dispatchWebhook,
  verifyWebhookAuth,
  normalizeWebhookPayload,
  matchesTrigger,
};
