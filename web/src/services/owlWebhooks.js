const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { encryptSecret, decryptSecret } = require('./secretBox');
const { selectAuthorizedContactIntegration, resolveOperationalPool, syncContactIntoOwl } = require('./owlContactSync');

const MAX_SKEW_SECONDS = 300;
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{20,64}$/;
const EVENT_ALIASES = new Map([
  ['contact_created','contact_created'], ['contact.created','contact_created'], ['contactcreate','contact_created'],
  ['contact_create','contact_created'], ['owl.contact.prepare','contact_created'],
  ['contact_updated','contact_updated'], ['contact.updated','contact_updated'], ['contactupdate','contact_updated'],
  ['contact_update','contact_updated'], ['owl.contact.updated','contact_updated'],
]);

async function getEndpoint(scope, pool = null) {
  const p = pool || getPool();
  requireScope(scope);
  const [rows] = await p.query(
    `SELECT e.*,i.name AS integration_name
     FROM owl_webhook_endpoints e
     LEFT JOIN crm_integrations i ON i.id=e.integration_id
     WHERE e.api_key_id=? AND e.location_id=? AND e.data_source_slug=? LIMIT 1`,
    [scope.apiKeyId, scope.locationId, scope.dataSourceSlug]
  );
  const endpoint = publicEndpoint(rows[0] || null);
  if (!endpoint) return { endpoint:null, deliveries:[] };
  const [deliveries] = await p.query(
    `SELECT id,request_id,event_name,contact_id,status,lead_id,outcome,error_code,error_message,
            duration_ms,received_at,completed_at
     FROM owl_webhook_deliveries WHERE endpoint_id=? ORDER BY received_at DESC LIMIT 25`,
    [endpoint.id]
  );
  return { endpoint, deliveries:deliveries.map(publicDelivery) };
}

async function provisionEndpoint(scope, actor, options = {}, pool = null) {
  const p = pool || getPool();
  requireScope(scope);
  const integrationId = String(options.integrationId || '').trim();
  if (!integrationId) throw statusError('CRM integration is required', 400, 'OWL_WEBHOOK_CONNECTION_REQUIRED');
  await selectAuthorizedContactIntegration(p, { ...scope, integrationId });
  await resolveOperationalPool({ corePool:p, apiKeyId:scope.apiKeyId, dataSourceSlug:scope.dataSourceSlug });
  const allowCreated = options.allowContactCreated !== false;
  const allowUpdated = options.allowContactUpdated !== false;
  if (!allowCreated && !allowUpdated) throw statusError('Enable at least one contact event', 400, 'OWL_WEBHOOK_EVENT_REQUIRED');

  const [existingRows] = await p.query(
    `SELECT * FROM owl_webhook_endpoints
     WHERE api_key_id=? AND location_id=? AND data_source_slug=? LIMIT 1`,
    [scope.apiKeyId, scope.locationId, scope.dataSourceSlug]
  );
  const existing = existingRows[0] || null;
  const rotate = options.rotate === true;
  let secret = null;
  if (!existing || rotate) secret = crypto.randomBytes(32).toString('base64url');
  if (existing) {
    await p.query(
      `UPDATE owl_webhook_endpoints SET integration_id=?,allow_contact_created=?,allow_contact_updated=?,
         is_enabled=1,secret_enc=COALESCE(?,secret_enc),secret_hint=COALESCE(?,secret_hint),
         rotated_by=?,updated_at=CURRENT_TIMESTAMP(3)
       WHERE id=?`,
      [integrationId, allowCreated ? 1 : 0, allowUpdated ? 1 : 0,
        secret ? encryptSecret(secret) : null, secret ? secret.slice(-6) : null,
        actor?.id || null, existing.id]
    );
  } else {
    await p.query(
      `INSERT INTO owl_webhook_endpoints
         (id,api_key_id,location_id,data_source_slug,integration_id,public_id,secret_enc,secret_hint,
          allow_contact_created,allow_contact_updated,is_enabled,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
      [crypto.randomUUID(), scope.apiKeyId, scope.locationId, scope.dataSourceSlug, integrationId,
        crypto.randomBytes(24).toString('base64url'), encryptSecret(secret), secret.slice(-6),
        allowCreated ? 1 : 0, allowUpdated ? 1 : 0, actor?.id || null]
    );
  }
  const result = await getEndpoint(scope, p);
  return { ...result, secret, rotated:Boolean(existing && rotate) };
}

async function disableEndpoint(scope, actor, pool = null) {
  const p = pool || getPool();
  requireScope(scope);
  await p.query(
    `UPDATE owl_webhook_endpoints SET is_enabled=0,rotated_by=?,updated_at=CURRENT_TIMESTAMP(3)
     WHERE api_key_id=? AND location_id=? AND data_source_slug=?`,
    [actor?.id || null, scope.apiKeyId, scope.locationId, scope.dataSourceSlug]
  );
  return getEndpoint(scope, p);
}

async function receiveWebhook(input, pool = null) {
  const p = pool || getPool();
  const started = Date.now();
  const publicId = String(input.publicId || '').trim();
  if (!PUBLIC_ID_RE.test(publicId)) throw statusError('Webhook endpoint not found', 404, 'OWL_WEBHOOK_NOT_FOUND');
  const [rows] = await p.query(
    `SELECT e.*,i.is_enabled AS integration_enabled
     FROM owl_webhook_endpoints e
     INNER JOIN crm_integrations i ON i.id=e.integration_id
     WHERE e.public_id=? LIMIT 1`, [publicId]
  );
  const endpoint = rows[0];
  if (!endpoint || !endpoint.is_enabled || !endpoint.integration_enabled) {
    throw statusError('Webhook endpoint not found', 404, 'OWL_WEBHOOK_NOT_FOUND');
  }
  const rawBody = Buffer.isBuffer(input.rawBody) ? input.rawBody : Buffer.from(JSON.stringify(input.body || {}), 'utf8');
  const authMode = verifyWebhookAuth(decryptSecret(endpoint.secret_enc), input.headers || {}, rawBody, input.now || Date.now());
  const payload = normalizePayload(input.body || {});
  if (payload.locationId && payload.locationId !== String(endpoint.location_id)) {
    throw statusError('Webhook location does not match this OWL endpoint', 403, 'OWL_WEBHOOK_LOCATION_MISMATCH');
  }
  const eventName = normalizeEventName(payload.eventName);
  if (!eventName) throw statusError('Supported eventName is required', 400, 'OWL_WEBHOOK_EVENT_INVALID');
  if (eventName === 'contact_created' && !endpoint.allow_contact_created) throw statusError('Contact-created events are disabled', 409, 'OWL_WEBHOOK_EVENT_DISABLED');
  if (eventName === 'contact_updated' && !endpoint.allow_contact_updated) throw statusError('Contact-updated events are disabled', 409, 'OWL_WEBHOOK_EVENT_DISABLED');
  const contactId = String(payload.contactId || '').trim();
  if (!contactId) throw statusError('contactId is required', 400, 'OWL_WEBHOOK_CONTACT_ID_REQUIRED');

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const explicitId = header(input.headers, 'x-owl-event-id') || payload.eventId || payload.webhookId;
  const bucket = Math.floor(Number(input.now || Date.now()) / (MAX_SKEW_SECONDS * 1000));
  const eventKey = String(explicitId ? `event:${explicitId}` : `body:${payloadHash}:${bucket}`).slice(0, 191);
  const requestId = clean(input.requestId, 64) || null;
  let deliveryId = crypto.randomUUID();
  let duplicate = false;
  try {
    await p.query(
      `INSERT INTO owl_webhook_deliveries
         (id,endpoint_id,request_id,event_key,event_name,contact_id,payload_sha256,auth_mode,status)
       VALUES (?,?,?,?,?,?,?,?,'accepted')`,
      [deliveryId, endpoint.id, requestId, eventKey, eventName, contactId, payloadHash, authMode]
    );
  } catch (error) {
    if (error?.code !== 'ER_DUP_ENTRY') throw error;
    duplicate = true;
    const [existingRows] = await p.query(
      `SELECT * FROM owl_webhook_deliveries WHERE endpoint_id=? AND event_key=? LIMIT 1`,
      [endpoint.id, eventKey]
    );
    const existing = existingRows[0];
    if (existing?.status === 'completed') {
      return { ...parseJson(existing.result_json, {}), ok:true, ready:true, duplicate:true, requestId:requestId || existing.request_id };
    }
    if (!existing) throw error;
    if (existing.status === 'accepted') {
      throw statusError('This webhook event is already being synchronized', 409, 'OWL_WEBHOOK_EVENT_IN_PROGRESS');
    }
    deliveryId = existing.id;
    await p.query(
      `UPDATE owl_webhook_deliveries SET request_id=?,status='accepted',error_code=NULL,error_message=NULL,
         completed_at=NULL,received_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
      [requestId, deliveryId]
    );
  }

  await p.query('UPDATE owl_webhook_endpoints SET last_received_at=CURRENT_TIMESTAMP(3) WHERE id=?', [endpoint.id]);
  try {
    const result = await syncContactIntoOwl({
      corePool:p,
      apiKeyId:endpoint.api_key_id,
      locationId:endpoint.location_id,
      dataSourceSlug:endpoint.data_source_slug,
      integrationId:endpoint.integration_id,
      contactId,
      eventName,
      fetchImpl:input.fetchImpl || global.fetch,
    });
    const response = { ok:true, ready:true, duplicate, eventName, ...result, requestId };
    await p.query(
      `UPDATE owl_webhook_deliveries SET status='completed',lead_id=?,outcome=?,result_json=?,duration_ms=?,
         completed_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
      [result.leadId, result.outcome, JSON.stringify(response), Date.now() - started, deliveryId]
    );
    await p.query(
      `UPDATE owl_webhook_endpoints SET last_success_at=CURRENT_TIMESTAMP(3),last_error_code=NULL WHERE id=?`,
      [endpoint.id]
    );
    return response;
  } catch (error) {
    await p.query(
      `UPDATE owl_webhook_deliveries SET status='failed',error_code=?,error_message=?,duration_ms=?,
         completed_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
      [clean(error.code || 'OWL_WEBHOOK_SYNC_FAILED', 64), clean(error.message, 1000), Date.now() - started, deliveryId]
    );
    await p.query('UPDATE owl_webhook_endpoints SET last_error_code=? WHERE id=?', [clean(error.code || 'OWL_WEBHOOK_SYNC_FAILED', 64), endpoint.id]);
    throw error;
  }
}

function verifyWebhookAuth(secret, headers, rawBody, now = Date.now()) {
  const authorization = header(headers, 'authorization');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || header(headers, 'x-owl-secret');
  if (bearer && equalSecret(bearer, secret)) return 'bearer';
  const timestamp = header(headers, 'x-owl-timestamp');
  const signature = header(headers, 'x-owl-signature').replace(/^sha256=/i, '');
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) {
    throw statusError('Webhook authentication failed', 401, 'OWL_WEBHOOK_AUTH_FAILED');
  }
  const seconds = timestamp.length === 13 ? Math.floor(Number(timestamp) / 1000) : Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > MAX_SKEW_SECONDS) {
    throw statusError('Webhook timestamp is outside the five-minute window', 401, 'OWL_WEBHOOK_TIMESTAMP_INVALID');
  }
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  if (!equalSecret(signature.toLowerCase(), expected)) throw statusError('Webhook authentication failed', 401, 'OWL_WEBHOOK_AUTH_FAILED');
  return 'hmac';
}

function normalizePayload(body) {
  const root = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const contact = root.contact && typeof root.contact === 'object' ? root.contact : {};
  const custom = root.customData && typeof root.customData === 'object' ? root.customData :
    root.custom_data && typeof root.custom_data === 'object' ? root.custom_data : {};
  return {
    contactId:String(custom.contactId || custom.contact_id || root.contactId || root.contact_id || contact.id || root.id || '').trim(),
    locationId:String(custom.locationId || custom.location_id || root.locationId || root.location_id || contact.locationId || root.location?.id || '').trim(),
    eventName:String(custom.eventName || custom.event_name || root.eventName || root.event_name || root.event || root.type || '').trim(),
    eventId:String(custom.eventId || custom.event_id || root.eventId || root.event_id || '').trim(),
    webhookId:String(root.webhookId || root.webhook_id || '').trim(),
  };
}

function normalizeEventName(value) {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  return EVENT_ALIASES.get(key) || null;
}

function publicEndpoint(row) {
  if (!row) return null;
  return {
    id:row.id,
    publicId:row.public_id,
    apiKeyId:row.api_key_id,
    locationId:row.location_id,
    dataSourceSlug:row.data_source_slug,
    integrationId:row.integration_id,
    integrationName:row.integration_name || null,
    secretHint:row.secret_hint,
    enabled:Boolean(row.is_enabled),
    allowContactCreated:Boolean(row.allow_contact_created),
    allowContactUpdated:Boolean(row.allow_contact_updated),
    lastReceivedAt:row.last_received_at || null,
    lastSuccessAt:row.last_success_at || null,
    lastErrorCode:row.last_error_code || null,
    createdAt:row.created_at || null,
    updatedAt:row.updated_at || null,
    authentication:['bearer','hmac-sha256'],
  };
}

function publicDelivery(row) {
  return {
    id:row.id, requestId:row.request_id || null, eventName:row.event_name,
    contactId:row.contact_id, status:row.status, leadId:row.lead_id || null,
    outcome:row.outcome || null, errorCode:row.error_code || null,
    errorMessage:row.error_message || null, durationMs:row.duration_ms == null ? null : Number(row.duration_ms),
    receivedAt:row.received_at, completedAt:row.completed_at || null,
  };
}

function requireScope(scope = {}) {
  for (const field of ['apiKeyId','locationId','dataSourceSlug']) if (!String(scope[field] || '').trim()) throw statusError(`${field} is required`, 400, 'OWL_WEBHOOK_SCOPE_REQUIRED');
}
function header(headers, name) { const wanted=name.toLowerCase(); for (const [key,value] of Object.entries(headers || {})) if (key.toLowerCase()===wanted) return String(Array.isArray(value)?value[0]:value || '').trim(); return ''; }
function equalSecret(left,right) { const a=Buffer.from(String(left||'')); const b=Buffer.from(String(right||'')); return a.length===b.length && a.length>0 && crypto.timingSafeEqual(a,b); }
function clean(value,max) { return String(value == null ? '' : value).trim().replace(/[\r\n\t]/g,' ').slice(0,max); }
function parseJson(value,fallback) { try { return typeof value==='object' && value!==null ? value : JSON.parse(value); } catch { return fallback; } }
function statusError(message,status,code) { return Object.assign(new Error(message),{status,code}); }

module.exports = {
  getEndpoint,
  provisionEndpoint,
  disableEndpoint,
  receiveWebhook,
  verifyWebhookAuth,
  normalizePayload,
  normalizeEventName,
};
