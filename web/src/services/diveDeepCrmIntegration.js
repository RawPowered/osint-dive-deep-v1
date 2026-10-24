'use strict';

const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getInstanceIdentity } = require('../instanceIdentity');
const { encryptSecret, decryptSecret } = require('./secretBox');
const { decryptPii } = require('./divedeepPii');
const {
  getIntegrationById,
  integrationCredential,
  LEADCONNECTOR_PROVIDER,
} = require('./crmIntegrations');
const hawk = require('./hawk');
const { recordEvent, newRequestId } = require('./sentinel');
const {
  hashPayload,
  sanitizeOutboundPayload,
  sanitizeInboundPayload,
} = require('./diveDeepCrmPrivacy');

const QUEUE_STATES = new Set(['queued', 'processing', 'retry', 'completed', 'dead_letter', 'ignored']);
const MAX_ERROR = 1000;
const MAX_ATTEMPTS = 6;
const WEBHOOK_SKEW_SECONDS = 300;
const STALE_LOCK_SECONDS = 10 * 60;

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : fallback; }
  catch { return fallback; }
}

function clean(value, max = 191) {
  return String(value == null ? '' : value).trim().replace(/[\r\n\t]/g, ' ').slice(0, max);
}

function normalizeEmail(value) { return clean(value, 320).toLowerCase(); }
function uuid() { return crypto.randomUUID(); }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function number(value) { return Number(value) || 0; }
function statusError(message, status = 400, code = 'DIVEDEEP_CRM_ERROR', details = null) {
  return Object.assign(new Error(message), { status, code, details });
}

function integrationConfig(integration) {
  const config = parseJson(integration?.config_json, {});
  return { ...config, diveDeep: parseJson(config.diveDeep, {}) };
}

function publicLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    integrationId: row.integration_id,
    locationId: row.location_id,
    externalContactId: row.external_contact_id,
    leadId: row.lead_id || null,
    status: row.status,
    linkSource: row.link_source,
    verifiedAt: iso(row.verified_at),
    lastInboundAt: iso(row.last_inbound_at),
    lastOutboundAt: iso(row.last_outbound_at),
    lastQueuedHash: row.last_queued_hash || null,
    lastDeliveredHash: row.last_delivered_hash || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function publicQueueEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    direction: row.direction || null,
    integrationId: row.integration_id,
    customerId: row.customer_id || null,
    externalContactId: row.external_contact_id || null,
    eventType: row.event_type,
    status: row.status,
    attempts: number(row.attempts),
    maxAttempts: number(row.max_attempts),
    availableAt: iso(row.available_at),
    errorCode: row.last_error_code || null,
    errorMessage: row.last_error_message || null,
    receivedAt: iso(row.received_at),
    processedAt: iso(row.processed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function listContactLinks(filters = {}, pool = null) {
  const p = pool || getPool();
  const where = [];
  const params = [];
  if (filters.customerId) { where.push('l.customer_id=?'); params.push(clean(filters.customerId, 36)); }
  if (filters.integrationId) { where.push('l.integration_id=?'); params.push(clean(filters.integrationId, 36)); }
  if (filters.status) { where.push('l.status=?'); params.push(clean(filters.status, 24)); }
  const limit = Math.min(Math.max(number(filters.limit) || 100, 1), 500);
  params.push(limit);
  const [rows] = await p.query(
    `SELECT l.* FROM divedeep_crm_contact_links l ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY l.updated_at DESC LIMIT ?`, params
  );
  return rows.map(publicLink);
}

async function loadContactRecord(integrationId, externalContactId, pool) {
  const [rows] = await pool.query(
    `SELECT payload_json FROM crm_contact_records WHERE integration_id=? AND external_record_id=? LIMIT 1`,
    [integrationId, externalContactId]
  );
  return parseJson(rows[0]?.payload_json, null);
}

function contactFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.contact && typeof payload.contact === 'object' ? payload.contact : payload;
}

async function fetchLiveContact(integration, externalContactId, fetchImpl = global.fetch) {
  if (!integration || integration.provider !== LEADCONNECTOR_PROVIDER) {
    throw statusError('DiveDeep contact verification requires a GoHighLevel Private Integration', 409, 'DIVEDEEP_CRM_GHL_REQUIRED');
  }
  const contactId = clean(externalContactId, 191);
  if (!contactId || !/^[A-Za-z0-9_-]{1,191}$/.test(contactId)) {
    throw statusError('A valid GoHighLevel contact ID is required', 400, 'DIVEDEEP_CRM_CONTACT_ID_INVALID');
  }
  const cfg = integrationConfig(integration);
  const url = `${String(integration.base_url).replace(/\/$/, '')}/contacts/${encodeURIComponent(contactId)}`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${integrationCredential(integration)}`,
      Version: clean(cfg.version || '2021-07-28', 32),
    },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw statusError('GoHighLevel contact verification failed', response.status === 404 ? 404 : 502, 'DIVEDEEP_CRM_CONTACT_VERIFY_FAILED', { upstreamStatus: response.status });
  }
  return contactFromPayload(body);
}

async function verifyCustomerContact(customerId, integration, externalContactId, pool, fetchImpl = global.fetch) {
  const [customers] = await pool.query(`SELECT id,email_enc FROM divedeep_customers WHERE id=? LIMIT 1`, [customerId]);
  if (!customers[0]) throw statusError('DiveDeep customer not found', 404, 'DIVEDEEP_CUSTOMER_NOT_FOUND');
  let contact = contactFromPayload(await loadContactRecord(integration.id, externalContactId, pool));
  if (!contact?.email) contact = await fetchLiveContact(integration, externalContactId, fetchImpl);
  const customerEmail = normalizeEmail(decryptPii(customers[0].email_enc));
  const contactEmail = normalizeEmail(contact?.email || contact?.emailAddress);
  if (!customerEmail || !contactEmail || customerEmail !== contactEmail) {
    throw statusError('The CRM contact email does not match the DiveDeep account', 409, 'DIVEDEEP_CRM_CONTACT_MISMATCH');
  }
  const contactLocation = clean(contact.locationId || contact.location_id, 128);
  if (contactLocation && contactLocation !== String(integration.location_id)) {
    throw statusError('The CRM contact belongs to a different location', 409, 'DIVEDEEP_CRM_LOCATION_MISMATCH');
  }
  return contact;
}

async function createContactLink(input, actor = 'system', pool = null, fetchImpl = global.fetch) {
  const p = pool || getPool();
  const customerId = clean(input.customerId, 36);
  const integrationId = clean(input.integrationId, 36);
  const externalContactId = clean(input.externalContactId || input.contactId, 191);
  if (!customerId || !integrationId || !externalContactId) {
    throw statusError('customerId, integrationId, and externalContactId are required', 400, 'DIVEDEEP_CRM_LINK_INPUT_REQUIRED');
  }
  const integration = await getIntegrationById(integrationId, p);
  if (!integration || !integration.is_enabled) throw statusError('Active CRM integration not found', 404, 'DIVEDEEP_CRM_INTEGRATION_NOT_FOUND');
  const contact = input.skipVerification === true
    ? null
    : await verifyCustomerContact(customerId, integration, externalContactId, p, fetchImpl);
  const [leadLinks] = await p.query(
    `SELECT lead_id FROM lead_source_links WHERE integration_id=? AND external_record_id=? LIMIT 1`,
    [integrationId, externalContactId]
  );
  const [existingLinks] = await p.query(
    `SELECT * FROM divedeep_crm_contact_links
     WHERE (integration_id=? AND external_contact_id=?) OR (customer_id=? AND integration_id=?)
     FOR UPDATE`,
    [integrationId, externalContactId, customerId, integrationId]
  );
  const contactOwner = existingLinks.find((row) => String(row.external_contact_id) === externalContactId);
  if (contactOwner && String(contactOwner.customer_id) !== customerId) {
    throw statusError('CRM contact is already linked to another customer', 409, 'DIVEDEEP_CRM_CONTACT_ALREADY_LINKED');
  }
  const customerLink = existingLinks.find((row) => String(row.customer_id) === customerId);
  const metadata = JSON.stringify({ actor: clean(actor, 128), verifiedLive: Boolean(contact) });
  if (customerLink) {
    await p.query(
      `UPDATE divedeep_crm_contact_links SET location_id=?,external_contact_id=?,lead_id=COALESCE(?,lead_id),
       status='active',link_source=?,verified_at=NOW(3),metadata_json=?,updated_at=NOW(3) WHERE id=?`,
      [integration.location_id, externalContactId, leadLinks[0]?.lead_id || null,
        clean(input.linkSource || 'verified_email_match', 32), metadata, customerLink.id]
    );
  } else {
    try {
      await p.query(
        `INSERT INTO divedeep_crm_contact_links
         (id,customer_id,integration_id,location_id,external_contact_id,lead_id,status,link_source,verified_at,metadata_json)
         VALUES (?,?,?,?,?,?,'active',?,NOW(3),?)`,
        [uuid(), customerId, integrationId, integration.location_id, externalContactId, leadLinks[0]?.lead_id || null,
          clean(input.linkSource || 'verified_email_match', 32), metadata]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw statusError('CRM contact is already linked to another customer', 409, 'DIVEDEEP_CRM_CONTACT_ALREADY_LINKED');
      throw error;
    }
  }
  const [rows] = await p.query(
    `SELECT * FROM divedeep_crm_contact_links WHERE integration_id=? AND external_contact_id=? LIMIT 1`,
    [integrationId, externalContactId]
  );
  await enqueueCustomerLifecycle(customerId, 'divedeep.customer.linked', { force: true, pool: p });
  const linked = publicLink(rows[0]);
  recordEvent({
    method: 'LINK', path: '/internal/divedeep/crm/contact-links', status_code: 201, duration_ms: 0,
    location_id: integration.location_id, request_id: newRequestId(), surface: 'divedeep', actor_type: 'system', actor_id: clean(actor, 128),
    action: 'divedeep.crm.contact_link.verified', entity_type: 'divedeep_crm_contact_link', entity_id: linked.id, outcome: 'success',
  });
  return linked;
}

async function claimSignupContact(customerId, input = {}, pool = null, fetchImpl = global.fetch) {
  const integrationId = clean(input.crmIntegrationId || input.integrationId, 36);
  const externalContactId = clean(input.crmContactId || input.externalContactId || input.contactId, 191);
  if (!integrationId || !externalContactId) return null;
  const link = await createContactLink({ customerId, integrationId, externalContactId, linkSource: 'signup_email_match' }, customerId, pool, fetchImpl);
  await enqueueCustomerLifecycle(customerId, 'divedeep.customer.created', { force: true, pool: pool || getPool() });
  return link;
}

async function unlinkContactLink(linkId, actor = 'admin', pool = null) {
  const p = pool || getPool();
  const [result] = await p.query(
    `UPDATE divedeep_crm_contact_links SET status='unlinked',metadata_json=JSON_SET(COALESCE(metadata_json,'{}'),'$.unlinkedBy',?),updated_at=NOW(3) WHERE id=?`,
    [clean(actor, 128), clean(linkId, 36)]
  );
  if (!result.affectedRows) throw statusError('CRM contact link not found', 404, 'DIVEDEEP_CRM_LINK_NOT_FOUND');
  return true;
}

function communicationKeyFor(snapshot) {
  if (snapshot.customerStatus === 'closed' || snapshot.workflowStatus === 'complete') return 'divedeep.example.invalidplete';
  if (snapshot.openCustomerActions > 0) return 'divedeep.action_required';
  if (snapshot.activeMonitoring > 0 || snapshot.workflowStatus === 'monitoring') return 'divedeep.monitoring_update';
  if (snapshot.onboardingComplete) return 'divedeep.service_update';
  return 'divedeep.welcome';
}

function milestoneTags(snapshot) {
  const tags = ['divedeep-customer'];
  if (snapshot.onboardingComplete) tags.push('divedeep-onboarding-complete');
  if (snapshot.openCustomerActions > 0) tags.push('divedeep-action-required');
  if (['dispatched', 'researching', 'awaiting_review', 'disposition_required', 'evidence_ready', 'removal_preparation', 'requests_in_progress'].includes(snapshot.workflowStatus)) tags.push('divedeep-service-active');
  if (snapshot.activeMonitoring > 0 || snapshot.workflowStatus === 'monitoring') tags.push('divedeep-monitoring');
  if (snapshot.workflowStatus === 'complete' || snapshot.customerStatus === 'closed') tags.push('divedeep-complete');
  return tags;
}

async function buildLifecycleSnapshot(customerId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT c.id,c.status,c.workflow_status,c.plan_tier,
       EXISTS(SELECT 1 FROM divedeep_protected_profiles p WHERE p.tenant_id=c.id) onboarding_complete,
       (SELECT COUNT(*) FROM divedeep_customer_action_requests a WHERE a.customer_id=c.id AND a.status IN ('pending','viewed')) open_actions,
       (SELECT COUNT(*) FROM divedeep_request_deliveries d WHERE d.customer_id=c.id AND d.status IN ('draft','approved','queued','sending','customer_action','failed')) pending_deliveries,
       (SELECT COUNT(*) FROM divedeep_monitoring_schedules m WHERE m.customer_id=c.id AND m.status='active') active_monitoring
     FROM divedeep_customers c WHERE c.id=? LIMIT 1`,
    [clean(customerId, 36)]
  );
  const row = rows[0];
  if (!row) throw statusError('DiveDeep customer not found', 404, 'DIVEDEEP_CUSTOMER_NOT_FOUND');
  const snapshot = {
    customerId: row.id,
    customerStatus: row.status,
    workflowStatus: row.workflow_status,
    planTier: row.plan_tier,
    onboardingComplete: Boolean(row.onboarding_complete),
    openCustomerActions: number(row.open_actions),
    pendingDeliveries: number(row.pending_deliveries),
    activeMonitoring: number(row.active_monitoring),
    serviceState: row.workflow_status,
    portalPath: '/divedeep/app',
  };
  snapshot.communicationKey = communicationKeyFor(snapshot);
  snapshot.tags = milestoneTags(snapshot);
  return snapshot;
}

async function enqueueCustomerLifecycle(customerId, eventType = 'divedeep.lifecycle.updated', options = {}) {
  const p = options.pool || getPool();
  const snapshot = await buildLifecycleSnapshot(customerId, p);
  const [links] = await p.query(`SELECT * FROM divedeep_crm_contact_links WHERE customer_id=? AND status='active'`, [customerId]);
  const results = [];
  for (const link of links) {
    const linkMetadata = parseJson(link.metadata_json, {});
    const previousLifecycle = parseJson(linkMetadata.lastLifecycle, {});
    let resolvedEventType = eventType;
    if (eventType === 'divedeep.lifecycle.updated' && previousLifecycle.onboardingComplete === false && snapshot.onboardingComplete === true) {
      resolvedEventType = 'divedeep.onboarding.completed';
    }
    const payload = sanitizeOutboundPayload({
      eventName: resolvedEventType,
      eventId: uuid(),
      occurredAt: new Date().toISOString(),
      contactId: link.external_contact_id,
      locationId: link.location_id,
      ...snapshot,
      lifecycle: {
        customerStatus: snapshot.customerStatus,
        workflowStatus: snapshot.workflowStatus,
        onboardingComplete: snapshot.onboardingComplete,
        openCustomerActions: snapshot.openCustomerActions,
        pendingDeliveries: snapshot.pendingDeliveries,
        activeMonitoring: snapshot.activeMonitoring,
      },
      source: 'divedeep',
    });
    const lifecycleHash = hashPayload({ ...snapshot, eventName: undefined });
    if (!options.force && link.last_queued_hash === lifecycleHash) continue;
    const idempotencyKey = `${customerId}:${link.id}:${resolvedEventType}:${lifecycleHash}`.slice(0, 191);
    const eventId = uuid();
    try {
      await p.query(
        `INSERT INTO divedeep_crm_outbound_events
         (id,contact_link_id,customer_id,integration_id,external_contact_id,event_type,idempotency_key,payload_hash,payload_json,status,available_at)
         VALUES (?,?,?,?,?,?,?,?,?,'queued',NOW(3))`,
        [eventId, link.id, customerId, link.integration_id, link.external_contact_id, clean(resolvedEventType, 96), idempotencyKey, hashPayload(payload), JSON.stringify(payload)]
      );
      const nextMetadata = {
        ...linkMetadata,
        lastLifecycle: {
          customerStatus: snapshot.customerStatus,
          workflowStatus: snapshot.workflowStatus,
          onboardingComplete: snapshot.onboardingComplete,
          openCustomerActions: snapshot.openCustomerActions,
          pendingDeliveries: snapshot.pendingDeliveries,
          activeMonitoring: snapshot.activeMonitoring,
        },
      };
      await p.query(
        `UPDATE divedeep_crm_contact_links SET last_queued_hash=?,metadata_json=?,updated_at=NOW(3) WHERE id=?`,
        [lifecycleHash, JSON.stringify(nextMetadata), link.id]
      );
      results.push({ id: eventId, duplicate: false });
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
      results.push({ id: null, duplicate: true });
    }
  }
  return { customerId, queued: results.filter((item) => !item.duplicate).length, links: links.length, events: results };
}

async function reconcileLifecycleQueue(options = {}, pool = null) {
  const p = pool || getPool();
  const limit = Math.min(Math.max(number(options.limit) || 200, 1), 1000);
  const [rows] = await p.query(
    `SELECT DISTINCT customer_id FROM divedeep_crm_contact_links WHERE status='active' ORDER BY updated_at ASC LIMIT ?`,
    [limit]
  );
  let queued = 0;
  for (const row of rows) queued += (await enqueueCustomerLifecycle(row.customer_id, 'divedeep.lifecycle.updated', { pool: p })).queued;
  return { customersChecked: rows.length, queued };
}

function webhookSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function secretHint(secret) { return `••••${String(secret).slice(-6)}`; }

async function provisionWebhookEndpoint(integrationId, options = {}, pool = null) {
  const p = pool || getPool();
  const integration = await getIntegrationById(clean(integrationId, 36), p);
  if (!integration) throw statusError('CRM integration not found', 404, 'DIVEDEEP_CRM_INTEGRATION_NOT_FOUND');
  const [existing] = await p.query(`SELECT * FROM divedeep_crm_webhook_endpoints WHERE integration_id=? LIMIT 1`, [integration.id]);
  const secret = webhookSecret();
  if (existing[0] && options.rotate !== true) return { endpoint: publicWebhookEndpoint(existing[0]), secret: null };
  const publicId = existing[0]?.public_id || crypto.randomBytes(18).toString('base64url');
  await p.query(
    `INSERT INTO divedeep_crm_webhook_endpoints
     (id,integration_id,public_id,secret_enc,secret_hint,is_enabled)
     VALUES (?,?,?,?,?,1)
     ON DUPLICATE KEY UPDATE secret_enc=VALUES(secret_enc),secret_hint=VALUES(secret_hint),is_enabled=1,updated_at=NOW(3)`,
    [existing[0]?.id || uuid(), integration.id, publicId, encryptSecret(secret), secretHint(secret)]
  );
  const [rows] = await p.query(`SELECT * FROM divedeep_crm_webhook_endpoints WHERE integration_id=? LIMIT 1`, [integration.id]);
  return { endpoint: publicWebhookEndpoint(rows[0]), secret };
}

function publicWebhookEndpoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    integrationId: row.integration_id,
    publicId: row.public_id,
    path: `${getInstanceIdentity().webhookBasePath}/crm/${row.public_id}`,
    secretHint: row.secret_hint,
    enabled: Boolean(row.is_enabled),
    lastReceivedAt: iso(row.last_received_at),
    authentication: ['bearer', 'hmac-sha256'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function getWebhookEndpoint(integrationId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT * FROM divedeep_crm_webhook_endpoints WHERE integration_id=? LIMIT 1`, [clean(integrationId, 36)]);
  return publicWebhookEndpoint(rows[0]);
}

async function disableWebhookEndpoint(integrationId, pool = null) {
  const p = pool || getPool();
  await p.query(`UPDATE divedeep_crm_webhook_endpoints SET is_enabled=0,updated_at=NOW(3) WHERE integration_id=?`, [clean(integrationId, 36)]);
  return getWebhookEndpoint(integrationId, p);
}

function header(headers, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) if (String(key).toLowerCase() === wanted) return clean(Array.isArray(value) ? value[0] : value, 4096);
  return '';
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function verifyWebhookAuth(secret, headers, rawBody, now = Date.now()) {
  const authorization = header(headers, 'authorization');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || header(headers, 'x-divedeep-crm-secret');
  if (bearer && equalSecret(bearer, secret)) return 'bearer';
  const timestamp = header(headers, 'x-divedeep-timestamp') || header(headers, 'x-hawk-timestamp');
  const signature = (header(headers, 'x-divedeep-signature') || header(headers, 'x-hawk-signature')).replace(/^sha256=/i, '');
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) throw statusError('Webhook authentication failed', 401, 'DIVEDEEP_CRM_WEBHOOK_AUTH_FAILED');
  const seconds = timestamp.length === 13 ? Math.floor(Number(timestamp) / 1000) : Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > WEBHOOK_SKEW_SECONDS) throw statusError('Webhook timestamp is outside the five-minute window', 401, 'DIVEDEEP_CRM_WEBHOOK_TIMESTAMP_INVALID');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody || Buffer.alloc(0)).digest('hex');
  if (!equalSecret(signature.toLowerCase(), expected)) throw statusError('Webhook authentication failed', 401, 'DIVEDEEP_CRM_WEBHOOK_AUTH_FAILED');
  return 'hmac';
}

async function acceptInboundWebhook(input, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT e.*,i.location_id FROM divedeep_crm_webhook_endpoints e
     INNER JOIN crm_integrations i ON i.id=e.integration_id AND i.is_enabled=1
     WHERE e.public_id=? AND e.is_enabled=1 LIMIT 1`,
    [clean(input.publicId, 64)]
  );
  const endpoint = rows[0];
  if (!endpoint) throw statusError('Webhook endpoint not found', 404, 'DIVEDEEP_CRM_WEBHOOK_NOT_FOUND');
  const authMode = verifyWebhookAuth(decryptSecret(endpoint.secret_enc), input.headers || {}, input.rawBody || Buffer.from(JSON.stringify(input.body || {})));
  const payload = sanitizeInboundPayload(input.body || {});
  if (payload.locationId && String(payload.locationId) !== String(endpoint.location_id)) {
    throw statusError('Webhook location does not match the configured integration', 403, 'DIVEDEEP_CRM_WEBHOOK_LOCATION_MISMATCH');
  }
  payload.locationId = payload.locationId || endpoint.location_id;
  const payloadHash = hashPayload(payload);
  const eventKey = clean(
    header(input.headers, 'x-webhook-id') || header(input.headers, 'x-request-id') || input.body?.webhookId || input.body?.id || `${payload.eventName || 'event'}:${payload.contactId || 'none'}:${payloadHash}`,
    191
  );
  const eventId = uuid();
  try {
    await p.query(
      `INSERT INTO divedeep_crm_inbound_events
       (id,endpoint_id,integration_id,event_key,event_type,external_contact_id,payload_hash,payload_json,status,auth_mode,request_id,available_at)
       VALUES (?,?,?,?,?,?,?,?,'queued',?,?,NOW(3))`,
      [eventId, endpoint.id, endpoint.integration_id, eventKey, clean(payload.eventName || 'webhook.received', 96), payload.contactId || null, payloadHash, JSON.stringify(payload), authMode, clean(input.requestId, 64) || null]
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return { accepted: true, duplicate: true, eventId: null };
    throw error;
  }
  await p.query(`UPDATE divedeep_crm_webhook_endpoints SET last_received_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [endpoint.id]);
  return { accepted: true, duplicate: false, eventId };
}

async function claimQueueRow(table, workerId, pool) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT * FROM ${table} WHERE status IN ('queued','retry') AND available_at<=NOW(3)
       ORDER BY available_at ASC,created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    const row = rows[0];
    if (!row) { await connection.commit(); return null; }
    await connection.query(
      `UPDATE ${table} SET status='processing',attempts=attempts+1,locked_at=NOW(3),locked_by=?,updated_at=NOW(3) WHERE id=?`,
      [clean(workerId, 128), row.id]
    );
    await connection.commit();
    row.attempts = number(row.attempts) + 1;
    row.status = 'processing';
    return row;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally { connection.release(); }
}

function triggerMatches(graph, eventName) {
  const trigger = parseJson(graph, {}).nodes?.find((node) => node.type === 'trigger');
  if (!trigger) return false;
  const configured = clean(trigger.config?.event, 96);
  if (configured === eventName) return true;
  if (configured === 'webhook.received') {
    const discriminator = clean(trigger.config?.eventName, 96);
    return !discriminator || discriminator === eventName;
  }
  return false;
}

async function dispatchHawkFlows(integrationId, locationId, eventName, payload, idempotencyPrefix, pool, fetchImpl = global.fetch) {
  const [rows] = await pool.query(
    `SELECT f.id,f.api_key_id,f.location_id,f.data_source_slug,v.graph_json
     FROM hawk_flows f INNER JOIN hawk_flow_versions v ON v.id=f.published_version_id
     WHERE f.integration_id=? AND f.location_id=? AND f.status='active' AND f.published_version_id IS NOT NULL`,
    [integrationId, locationId]
  );
  const executions = [];
  for (const row of rows.filter((item) => triggerMatches(item.graph_json, eventName))) {
    const execution = await hawk.executeFlow(row.id, {
      apiKeyId: row.api_key_id,
      locationId: row.location_id,
      dataSourceSlug: row.data_source_slug || 'core',
    }, payload, {
      dryRun: false,
      confirmLive: true,
      useDraft: false,
      idempotencyKey: `${idempotencyPrefix}:hawk:${row.id}`.slice(0, 191),
      requestId: newRequestId(),
      initiatedByType: 'system',
      initiatedById: 'divedeep-crm-queue',
    }, null, pool, fetchImpl);
    executions.push({ flowId: row.id, executionId: execution.id, status: execution.status });
    if (execution.status !== 'successful') throw statusError('A matching HAWK lifecycle workflow failed', 502, 'DIVEDEEP_CRM_HAWK_FAILED', { executionId: execution.id, flowId: row.id });
  }
  return executions;
}

async function resolveFieldUpdates(integration, snapshot, pool) {
  const cfg = integrationConfig(integration).diveDeep;
  const mappings = cfg.fieldMappings && typeof cfg.fieldMappings === 'object' ? cfg.fieldMappings : {};
  const requested = Object.entries(mappings).filter(([source, target]) => Object.prototype.hasOwnProperty.call(snapshot, source) && clean(target, 191));
  if (!requested.length) return [];
  const targets = requested.map(([, target]) => clean(target, 191));
  const placeholders = targets.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT field_id,field_key FROM crm_object_field_definitions
     WHERE integration_id=? AND object_model='contact' AND is_current=1
       AND (field_id IN (${placeholders}) OR field_key IN (${placeholders}))`,
    [integration.id, ...targets, ...targets]
  );
  const byTarget = new Map();
  for (const row of rows) {
    byTarget.set(String(row.field_id), row.field_id);
    if (row.field_key) byTarget.set(String(row.field_key), row.field_id);
  }
  return requested.flatMap(([source, target]) => {
    const id = byTarget.get(String(target));
    return id ? [{ id, field_value: snapshot[source] }] : [];
  });
}

async function deliverOutboundEvent(row, pool, fetchImpl = global.fetch) {
  const payload = sanitizeOutboundPayload(parseJson(row.payload_json, {}));
  const integration = await getIntegrationById(row.integration_id, pool);
  if (!integration || !integration.is_enabled) throw statusError('CRM integration is disabled', 409, 'DIVEDEEP_CRM_INTEGRATION_DISABLED');
  const snapshot = payload.lifecycle || payload;
  const customFields = await resolveFieldUpdates(integration, { ...payload, ...snapshot }, pool);
  const ghlResults = [];
  if (customFields.length) {
    ghlResults.push(await hawk.runGhlAction('ghl.update_contact', { contactId: row.external_contact_id, fields: { customFields } }, integration, fetchImpl));
  }
  const tags = Array.isArray(payload.tags) ? payload.tags.filter((tag) => /^divedeep-[a-z0-9-]{1,80}$/.test(tag)) : [];
  if (tags.length) ghlResults.push(await hawk.runGhlAction('ghl.add_tags', { contactId: row.external_contact_id, tags }, integration, fetchImpl));
  const hawkExecutions = await dispatchHawkFlows(row.integration_id, integration.location_id, row.event_type, payload, row.idempotency_key, pool, fetchImpl);
  if (!ghlResults.length && !hawkExecutions.length) throw statusError('No safe CRM lifecycle delivery path is configured', 409, 'DIVEDEEP_CRM_DELIVERY_NOT_CONFIGURED');
  await recordEagleEvent({
    integrationId: row.integration_id,
    locationId: integration.location_id,
    externalContactId: row.external_contact_id,
    customerId: row.customer_id,
    eventType: row.event_type,
    sourceEventId: row.id,
    eventStatus: payload.workflowStatus || payload.customerStatus || 'recorded',
  }, pool);
  return { ghlResults, hawkExecutions, payloadHash: row.payload_hash };
}

async function processInboundEvent(row, pool, fetchImpl = global.fetch) {
  const payload = sanitizeInboundPayload(parseJson(row.payload_json, {}));
  const integration = await getIntegrationById(row.integration_id, pool);
  if (!integration || !integration.is_enabled) throw statusError('CRM integration is disabled', 409, 'DIVEDEEP_CRM_INTEGRATION_DISABLED');
  let link = null;
  if (row.external_contact_id) {
    const [links] = await pool.query(
      `SELECT * FROM divedeep_crm_contact_links WHERE integration_id=? AND external_contact_id=? AND status='active' LIMIT 1`,
      [row.integration_id, row.external_contact_id]
    );
    link = links[0] || null;
    if (!link && payload.customerId) {
      await createContactLink({ customerId: payload.customerId, integrationId: row.integration_id, externalContactId: row.external_contact_id, linkSource: 'verified_webhook' }, 'crm-webhook', pool, fetchImpl);
      const [created] = await pool.query(`SELECT * FROM divedeep_crm_contact_links WHERE integration_id=? AND external_contact_id=? LIMIT 1`, [row.integration_id, row.external_contact_id]);
      link = created[0] || null;
    }
    if (link) await pool.query(`UPDATE divedeep_crm_contact_links SET last_inbound_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [link.id]);
  }
  const executions = await dispatchHawkFlows(row.integration_id, integration.location_id, row.event_type, payload, `inbound:${row.id}`, pool, fetchImpl);
  if (link) {
    await recordEagleEvent({
      integrationId: row.integration_id,
      locationId: integration.location_id,
      externalContactId: row.external_contact_id,
      leadId: link.lead_id,
      customerId: link.customer_id,
      eventType: row.event_type,
      sourceEventId: row.id,
      eventStatus: payload.opportunity?.status || payload.appointment?.status || 'recorded',
    }, pool);
  }
  return { linkId: link?.id || null, hawkExecutions: executions };
}

function eagleEventType(eventType) {
  const mapping = {
    'divedeep.customer.linked': 'divedeep_linked',
    'divedeep.lifecycle.updated': 'divedeep_lifecycle',
    'divedeep.customer.created': 'divedeep_customer',
    'divedeep.onboarding.completed': 'divedeep_onboarded',
  };
  return clean(mapping[eventType] || eventType.replace(/[^a-z0-9]+/gi, '_').toLowerCase(), 40);
}

async function recordEagleEvent(input, pool) {
  await pool.query(
    `INSERT INTO eagle_lead_events
     (integration_id,location_id,external_contact_id,lead_id,event_type,event_at,source_type,source_event_id,event_status,metadata_json)
     VALUES (?,?,?,?,?,NOW(3),'divedeep_crm',?,?,?)
     ON DUPLICATE KEY UPDATE event_status=VALUES(event_status),lead_id=COALESCE(VALUES(lead_id),lead_id),last_seen_at=NOW(3)`,
    [input.integrationId, input.locationId, input.externalContactId, input.leadId || null, eagleEventType(input.eventType), clean(input.sourceEventId, 191), clean(input.eventStatus, 32), JSON.stringify({ customerId: clean(input.customerId, 36) || null })]
  );
}

async function completeQueueRow(table, row, result, pool) {
  const hawkExecutions = result?.hawkExecutions || [];
  await pool.query(
    `UPDATE ${table} SET status='completed',locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_message=NULL,
       hawk_execution_ids_json=?,processed_at=NOW(3),updated_at=NOW(3) WHERE id=?`,
    [JSON.stringify(hawkExecutions.map((item) => item.executionId)), row.id]
  );
  if (table === 'divedeep_crm_outbound_events') {
    await pool.query(
      `UPDATE divedeep_crm_contact_links SET last_outbound_at=NOW(3),last_delivered_hash=?,updated_at=NOW(3) WHERE id=?`,
      [row.payload_hash, row.contact_link_id]
    );
  }
}

async function failQueueRow(table, row, error, pool) {
  const attempts = number(row.attempts);
  const maxAttempts = number(row.max_attempts) || MAX_ATTEMPTS;
  const code = clean(error.code || 'DIVEDEEP_CRM_PROCESSING_FAILED', 96);
  const message = clean(error.message || 'CRM queue processing failed', MAX_ERROR);
  if (attempts >= maxAttempts) {
    await pool.query(
      `UPDATE ${table} SET status='dead_letter',locked_at=NULL,locked_by=NULL,last_error_code=?,last_error_message=?,dead_lettered_at=NOW(3),updated_at=NOW(3) WHERE id=?`,
      [code, message, row.id]
    );
    const direction = table.includes('outbound') ? 'outbound' : 'inbound';
    await pool.query(
      `INSERT INTO divedeep_crm_dead_letters
       (id,direction,source_event_id,integration_id,customer_id,external_contact_id,event_type,payload_hash,error_code,error_message)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE error_code=VALUES(error_code),error_message=VALUES(error_message),updated_at=NOW(3)`,
      [uuid(), direction, row.id, row.integration_id, row.customer_id || null, row.external_contact_id || null, row.event_type, row.payload_hash, code, message]
    );
    return 'dead_letter';
  }
  const delaySeconds = Math.min(3600, 30 * (2 ** Math.max(attempts - 1, 0)));
  await pool.query(
    `UPDATE ${table} SET status='retry',available_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),locked_at=NULL,locked_by=NULL,
       last_error_code=?,last_error_message=?,updated_at=NOW(3) WHERE id=?`,
    [delaySeconds, code, message, row.id]
  );
  return 'retry';
}

async function recoverStaleQueueRows(direction, pool = null) {
  const p = pool || getPool();
  const table = direction === 'inbound' ? 'divedeep_crm_inbound_events' : direction === 'outbound' ? 'divedeep_crm_outbound_events' : null;
  if (!table) throw statusError('direction must be inbound or outbound', 400, 'DIVEDEEP_CRM_DIRECTION_INVALID');
  const [result] = await p.query(
    `UPDATE ${table} SET status='retry',available_at=NOW(3),locked_at=NULL,locked_by=NULL,
       last_error_code='DIVEDEEP_CRM_STALE_LOCK_RECOVERED',last_error_message='A prior queue worker stopped before completing this event',updated_at=NOW(3)
     WHERE status='processing' AND locked_at<DATE_SUB(NOW(3),INTERVAL ${STALE_LOCK_SECONDS} SECOND)`
  );
  if (number(result.affectedRows) > 0) {
    recordEvent({
      method: 'QUEUE', path: `/internal/divedeep/crm/${direction}/recover`, status_code: 200, duration_ms: 0,
      location_id: null, request_id: newRequestId(), surface: 'divedeep', actor_type: 'system', actor_id: 'divedeep-crm-recovery',
      action: `divedeep.crm.${direction}.stale_lock_recovered`, entity_type: 'crm_queue', entity_id: direction,
      outcome: 'success', metadata: { recovered: number(result.affectedRows) },
    });
  }
  return number(result.affectedRows);
}

async function processQueue(direction, options = {}, pool = null, fetchImpl = global.fetch) {
  const p = pool || getPool();
  const table = direction === 'inbound' ? 'divedeep_crm_inbound_events' : 'divedeep_crm_outbound_events';
  const limit = Math.min(Math.max(number(options.limit) || 50, 1), 500);
  const workerId = clean(options.workerId || `${process.pid}:${direction}`, 128);
  const summary = { direction, claimed: 0, completed: 0, retried: 0, deadLettered: 0, errors: [] };
  for (let i = 0; i < limit; i += 1) {
    const row = await claimQueueRow(table, workerId, p);
    if (!row) break;
    summary.claimed += 1;
    try {
      const result = direction === 'inbound'
        ? await processInboundEvent(row, p, fetchImpl)
        : await deliverOutboundEvent(row, p, fetchImpl);
      await completeQueueRow(table, row, result, p);
      summary.completed += 1;
      recordEvent({
        method: 'QUEUE', path: `/internal/divedeep/crm/${direction}`, status_code: 200, duration_ms: 0,
        location_id: null, request_id: newRequestId(), surface: 'divedeep', actor_type: 'system', actor_id: workerId,
        action: `divedeep.crm.${direction}.processed`, entity_type: 'crm_queue_event', entity_id: row.id, outcome: 'success',
      });
    } catch (error) {
      const state = await failQueueRow(table, row, error, p);
      if (state === 'retry') summary.retried += 1; else summary.deadLettered += 1;
      summary.errors.push({ id: row.id, code: error.code || 'DIVEDEEP_CRM_PROCESSING_FAILED', message: clean(error.message, 300) });
      recordEvent({
        method: 'QUEUE', path: `/internal/divedeep/crm/${direction}`, status_code: state === 'retry' ? 503 : 422, duration_ms: 0,
        location_id: null, error_class: error.code || 'DIVEDEEP_CRM_PROCESSING_FAILED', request_id: newRequestId(), surface: 'divedeep',
        actor_type: 'system', actor_id: workerId, action: `divedeep.crm.${direction}.${state}`, entity_type: 'crm_queue_event', entity_id: row.id, outcome: 'failure',
      });
    }
  }
  return summary;
}

async function runCrmSweep(options = {}, pool = null, fetchImpl = global.fetch) {
  const p = pool || getPool();
  const recovered = {
    inbound: await recoverStaleQueueRows('inbound', p),
    outbound: await recoverStaleQueueRows('outbound', p),
  };
  const lifecycle = options.reconcile === false ? { customersChecked: 0, queued: 0 } : await reconcileLifecycleQueue({ limit: options.reconcileLimit }, p);
  const inbound = await processQueue('inbound', { limit: options.inboundLimit || options.limit, workerId: options.workerId }, p, fetchImpl);
  const outbound = await processQueue('outbound', { limit: options.outboundLimit || options.limit, workerId: options.workerId }, p, fetchImpl);
  return { recovered, lifecycle, inbound, outbound };
}

async function listQueueEvents(direction, filters = {}, pool = null) {
  const p = pool || getPool();
  const table = direction === 'inbound' ? 'divedeep_crm_inbound_events' : 'divedeep_crm_outbound_events';
  const where = [];
  const params = [];
  if (filters.status && QUEUE_STATES.has(filters.status)) { where.push('status=?'); params.push(filters.status); }
  if (filters.integrationId) { where.push('integration_id=?'); params.push(clean(filters.integrationId, 36)); }
  if (filters.customerId && direction === 'outbound') { where.push('customer_id=?'); params.push(clean(filters.customerId, 36)); }
  const limit = Math.min(Math.max(number(filters.limit) || 100, 1), 500);
  params.push(limit);
  const [rows] = await p.query(
    `SELECT *,? AS direction FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
    [direction, ...params]
  );
  return rows.map(publicQueueEvent);
}

async function retryDeadLetter(direction, eventId, actor = 'admin', pool = null) {
  const p = pool || getPool();
  const table = direction === 'inbound' ? 'divedeep_crm_inbound_events' : direction === 'outbound' ? 'divedeep_crm_outbound_events' : null;
  if (!table) throw statusError('direction must be inbound or outbound', 400, 'DIVEDEEP_CRM_DIRECTION_INVALID');
  const [result] = await p.query(
    `UPDATE ${table} SET status='retry',attempts=0,available_at=NOW(3),locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_message=NULL,dead_lettered_at=NULL,updated_at=NOW(3)
     WHERE id=? AND status='dead_letter'`,
    [clean(eventId, 36)]
  );
  if (!result.affectedRows) throw statusError('Dead-letter event not found', 404, 'DIVEDEEP_CRM_DEAD_LETTER_NOT_FOUND');
  await p.query(
    `UPDATE divedeep_crm_dead_letters SET replay_count=replay_count+1,resolved_at=NOW(3),resolved_by=?,updated_at=NOW(3)
     WHERE direction=? AND source_event_id=?`,
    [clean(actor, 128), direction, clean(eventId, 36)]
  );
  return true;
}

async function operationsOverview(pool = null) {
  const p = pool || getPool();
  const [[links], [outbound], [inbound], [dead]] = await Promise.all([
    p.query(`SELECT COUNT(*) total,SUM(status='active') active FROM divedeep_crm_contact_links`),
    p.query(`SELECT COUNT(*) total,SUM(status IN ('queued','processing','retry')) pending,SUM(status='dead_letter') dead_letter,SUM(status='completed') completed FROM divedeep_crm_outbound_events`),
    p.query(`SELECT COUNT(*) total,SUM(status IN ('queued','processing','retry')) pending,SUM(status='dead_letter') dead_letter,SUM(status='completed') completed FROM divedeep_crm_inbound_events`),
    p.query(`SELECT COUNT(*) total,SUM(resolved_at IS NULL) unresolved FROM divedeep_crm_dead_letters`),
  ]);
  return {
    contactLinks: { total: number(links[0]?.total), active: number(links[0]?.active) },
    outbound: { total: number(outbound[0]?.total), pending: number(outbound[0]?.pending), deadLetter: number(outbound[0]?.dead_letter), completed: number(outbound[0]?.completed) },
    inbound: { total: number(inbound[0]?.total), pending: number(inbound[0]?.pending), deadLetter: number(inbound[0]?.dead_letter), completed: number(inbound[0]?.completed) },
    deadLetters: { total: number(dead[0]?.total), unresolved: number(dead[0]?.unresolved) },
  };
}

module.exports = {
  parseJson,
  publicLink,
  publicQueueEvent,
  listContactLinks,
  createContactLink,
  claimSignupContact,
  unlinkContactLink,
  buildLifecycleSnapshot,
  enqueueCustomerLifecycle,
  reconcileLifecycleQueue,
  provisionWebhookEndpoint,
  getWebhookEndpoint,
  disableWebhookEndpoint,
  verifyWebhookAuth,
  acceptInboundWebhook,
  processQueue,
  recoverStaleQueueRows,
  runCrmSweep,
  listQueueEvents,
  retryDeadLetter,
  operationsOverview,
  triggerMatches,
  communicationKeyFor,
  milestoneTags,
};
