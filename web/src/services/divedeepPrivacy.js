const crypto = require('crypto');
const net = require('net');
const { getPool } = require('../db/pool');
const {
  blindIndex,
  encryptPii,
  decryptPii,
  encryptJson,
  decryptJson,
  sha256,
  normalizeIdentifier,
} = require('./divedeepPii');
const {
  TEMPLATE_BY_KEY,
  LEGAL_BASIS_PRESETS,
  renderTemplate,
  templateCatalog,
} = require('./divedeepPrivacyTemplates');

const IDENTIFIER_TYPES = new Set(['name', 'alias', 'email', 'phone', 'address', 'username', 'domain', 'other']);
const VISIBILITY_ACTIONS = new Set(['remove', 'monitor', 'preserve', 'ignore', 'review']);
const VISIBILITY_SCOPES = new Set(['default', 'domain', 'source', 'category', 'identifier_type', 'profile_url']);
const PROFILE_STATUSES = new Set(['active', 'paused', 'deletion_pending', 'deleted']);
const EXPOSURE_STATUSES = new Set(['open', 'review', 'confirmed', 'preserved', 'ignored', 'removed', 'reappeared', 'false_positive']);
const EXPOSURE_PUBLICATION_STATUSES = new Set(['staged', 'approved', 'published', 'rejected']);
const VERIFICATION_RESULTS = new Set(['removed', 'still_present', 'changed', 'unreachable', 'needs_review']);
const JOB_TYPES = new Set(['initial_scan', 'rescan', 'verify', 'source_probe']);
const CASE_TRANSITIONS = {
  draft: new Set(['approved', 'withdrawn']),
  approved: new Set(['queued', 'withdrawn']),
  queued: new Set(['sent', 'failed', 'withdrawn']),
  sent: new Set(['acknowledged', 'needs_action', 'completed', 'denied', 'failed']),
  acknowledged: new Set(['needs_action', 'completed', 'denied']),
  needs_action: new Set(['approved', 'queued', 'sent', 'completed', 'denied', 'withdrawn']),
  failed: new Set(['queued', 'withdrawn']),
  completed: new Set([]),
  denied: new Set(['needs_action', 'withdrawn']),
  withdrawn: new Set([]),
};

function statusError(message, status = 400, code = 'DIVEDEEP_INVALID_REQUEST') {
  return Object.assign(new Error(message), { status, code });
}

function clean(value, max = 255) {
  const result = String(value == null ? '' : value).trim();
  return result ? result.slice(0, max) : '';
}

function required(value, label, max = 255) {
  const result = clean(value, max);
  if (!result) throw statusError(`${label} is required`);
  return result;
}

function asArray(value, max = 100) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw statusError('Expected an array');
  if (value.length > max) throw statusError(`Array cannot contain more than ${max} entries`);
  return value;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function bool(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function uuid() {
  return crypto.randomUUID();
}

function privateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19));
}

function privateHostname(value) {
  const hostname = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  const family = net.isIP(hostname);
  if (family === 4) return privateIpv4(hostname);
  if (family === 6) {
    if (hostname === '::' || hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(hostname)) return true;
    const mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return Boolean(mapped && privateIpv4(mapped[1]));
  }
  return false;
}

function normalizeUrl(value, label = 'URL') {
  const text = required(value, label, 2048);
  let parsed;
  try { parsed = new URL(text); } catch { throw statusError(`${label} must be a valid URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw statusError(`${label} must use HTTP or HTTPS`);
  if (privateHostname(parsed.hostname)) throw statusError(`${label} cannot target a local or private network address`, 400, 'DIVEDEEP_UNSAFE_URL');
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function profileUrlKey(value) {
  const parsed = new URL(normalizeUrl(value, 'Profile URL'));
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = parsed.pathname.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
  const identityQuery = pathname.toLowerCase() === '/profile.php' && parsed.searchParams.get('id')
    ? `?id=${encodeURIComponent(parsed.searchParams.get('id'))}`
    : '';
  return `${hostname}${pathname.toLowerCase()}${identityQuery}`;
}

function jsonText(value, fallback = {}) {
  return JSON.stringify(value == null ? fallback : value);
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mysqlDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw statusError('Invalid date value');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function assertTenant(tenantId) {
  return required(tenantId, 'tenantId', 36);
}

async function withTransaction(pool, callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* preserve original error */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function addEvent(connection, input) {
  await connection.query(
    `INSERT INTO divedeep_case_events
      (id,tenant_id,profile_id,case_id,exposure_id,event_type,actor_type,actor_id,details_json)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      uuid(), input.tenantId, input.profileId || null, input.caseId || null, input.exposureId || null,
      required(input.eventType, 'eventType', 96), clean(input.actorType || 'api_key', 32) || 'api_key',
      clean(input.actorId, 128) || null, jsonText(input.details || {}),
    ]
  );
}

function serializeIdentifier(row) {
  return {
    id: row.id,
    type: row.identifier_type,
    label: row.label || '',
    value: decryptPii(row.value_enc),
    isPrimary: Boolean(row.is_primary),
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function serializePolicy(row) {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeValue: row.scope_value || '',
    action: row.action,
    priority: Number(row.priority) || 0,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function serializeAuthorization(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.authorization_type,
    requesterRole: row.requester_role,
    requesterName: decryptPii(row.requester_name_enc),
    requesterEmail: decryptPii(row.requester_email_enc),
    scope: parseJson(row.scope_json, {}),
    statementVersion: row.statement_version,
    signedAt: iso(row.signed_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    status: row.status,
    verificationChannel: row.verification_channel || '',
    proofRef: row.proof_ref || '',
  };
}

async function getProtectedProfile(tenantId, profileId, pool = null) {
  const p = pool || getPool();
  const tenant = assertTenant(tenantId);
  const [rows] = await p.query(
    `SELECT * FROM divedeep_protected_profiles WHERE id=? AND tenant_id=? LIMIT 1`,
    [profileId, tenant]
  );
  if (!rows[0]) throw statusError('Protected profile not found', 404, 'DIVEDEEP_PROFILE_NOT_FOUND');
  const [identifierRows, policyRows, authorizationRows] = await Promise.all([
    p.query(`SELECT * FROM divedeep_profile_identifiers WHERE tenant_id=? AND profile_id=? ORDER BY is_primary DESC,created_at`, [tenant, profileId]).then(([items]) => items),
    p.query(`SELECT * FROM divedeep_visibility_policies WHERE tenant_id=? AND profile_id=? ORDER BY priority DESC,created_at`, [tenant, profileId]).then(([items]) => items),
    p.query(`SELECT * FROM research_authorizations WHERE tenant_id=? AND profile_id=? ORDER BY signed_at DESC LIMIT 1`, [tenant, profileId]).then(([items]) => items),
  ]);
  const row = rows[0];
  return {
    id: row.id,
    displayName: decryptPii(row.display_name_enc),
    jurisdictionCountry: row.jurisdiction_country || '',
    jurisdictionRegion: row.jurisdiction_region || '',
    status: row.status,
    scanCadenceDays: Number(row.scan_cadence_days) || 30,
    nextScanAt: iso(row.next_scan_at),
    lastScanAt: iso(row.last_scan_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    identifiers: identifierRows.map(serializeIdentifier),
    policies: policyRows.map(serializePolicy),
    authorization: serializeAuthorization(authorizationRows[0]),
  };
}

async function listProtectedProfiles(tenantId, options = {}, pool = null) {
  const p = pool || getPool();
  const tenant = assertTenant(tenantId);
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const params = [tenant];
  let where = 'tenant_id=?';
  if (options.status) {
    if (!PROFILE_STATUSES.has(options.status)) throw statusError('Invalid profile status');
    where += ' AND status=?';
    params.push(options.status);
  }
  params.push(limit);
  const [rows] = await p.query(
    `SELECT id FROM divedeep_protected_profiles WHERE ${where} ORDER BY updated_at DESC LIMIT ?`, params
  );
  const profiles = [];
  for (const row of rows) profiles.push(await getProtectedProfile(tenant, row.id, p));
  return profiles;
}

function validateIdentifier(input) {
  const type = clean(input.type, 32).toLowerCase();
  if (!IDENTIFIER_TYPES.has(type)) throw statusError(`Unsupported identifier type: ${type || 'blank'}`);
  const value = required(input.value, 'identifier value', 2048);
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw statusError('Email identifier is invalid');
  if (type === 'phone' && normalizeIdentifier(type, value).length < 7) throw statusError('Phone identifier is invalid');
  return { type, value, label: clean(input.label, 128), isPrimary: bool(input.isPrimary) };
}

async function insertIdentifier(connection, tenantId, profileId, raw, actorId = null) {
  const item = validateIdentifier(raw);
  const id = uuid();
  const hash = blindIndex(tenantId, item.type, item.value);
  if (item.isPrimary) {
    await connection.query(
      `UPDATE divedeep_profile_identifiers SET is_primary=0 WHERE tenant_id=? AND profile_id=? AND identifier_type=?`,
      [tenantId, profileId, item.type]
    );
  }
  try {
    await connection.query(
      `INSERT INTO divedeep_profile_identifiers
        (id,tenant_id,profile_id,identifier_type,label,value_enc,value_hash,is_primary,status)
       VALUES (?,?,?,?,?,?,?,?, 'active')`,
      [id, tenantId, profileId, item.type, item.label || null, encryptPii(item.value), hash, item.isPrimary ? 1 : 0]
    );
  } catch (error) {
    if (String(error.code || '').includes('DUP')) throw statusError('Identifier already exists on this profile', 409, 'DIVEDEEP_IDENTIFIER_DUPLICATE');
    throw error;
  }
  await addEvent(connection, {
    tenantId, profileId, eventType: 'profile.identifier_added', actorId,
    details: { identifierId: id, identifierType: item.type, isPrimary: item.isPrimary },
  });
  return id;
}

async function enqueueScanJob(input, pool = null) {
  const p = pool || getPool();
  const tenantId = assertTenant(input.tenantId);
  const profileId = required(input.profileId, 'profileId', 36);
  const jobType = clean(input.jobType || 'rescan', 32);
  if (!JOB_TYPES.has(jobType)) throw statusError('Invalid DiveDeep job type');
  const idempotencyKey = clean(input.idempotencyKey, 191) || `${jobType}:${profileId}:${uuid()}`;
  const jobId = uuid();
  try {
    await p.query(
      `INSERT INTO divedeep_scan_jobs
        (id,tenant_id,profile_id,job_type,status,idempotency_key,payload_json,max_attempts,available_at)
       VALUES (?,?,?,?,'queued',?,?,?,COALESCE(?,NOW(3)))`,
      [jobId, tenantId, profileId, jobType, idempotencyKey, jsonText(input.payload || {}), Math.min(Math.max(Number(input.maxAttempts) || 4, 1), 10), mysqlDate(input.availableAt)]
    );
  } catch (error) {
    if (!String(error.code || '').includes('DUP')) throw error;
    const [rows] = await p.query(
      `SELECT * FROM divedeep_scan_jobs WHERE tenant_id=? AND idempotency_key=? LIMIT 1`,
      [tenantId, idempotencyKey]
    );
    return serializeJob(rows[0]);
  }
  return getJob(tenantId, jobId, p);
}

async function createProtectedProfile(input, tenantId, actorId = null, pool = null) {
  const p = pool || getPool();
  const tenant = assertTenant(tenantId);
  if (!bool(input.authorizationAffirmed)) throw statusError('Authorization must be affirmed before creating a protected profile', 400, 'DIVEDEEP_AUTHORIZATION_REQUIRED');
  const displayName = required(input.displayName, 'displayName', 255);
  const requesterName = required(input.requesterName, 'requesterName', 255);
  const requesterEmail = required(input.requesterEmail, 'requesterEmail', 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail)) throw statusError('requesterEmail is invalid');
  const authorizationType = clean(input.authorizationType || 'self', 32);
  if (!['self', 'authorized_agent', 'guardian'].includes(authorizationType)) throw statusError('Invalid authorizationType');
  const identifiers = asArray(input.identifiers, 50).map(validateIdentifier);
  if (!identifiers.length) throw statusError('At least one identity identifier is required');
  const defaultAction = clean(input.defaultVisibilityAction || 'review', 32);
  if (!VISIBILITY_ACTIONS.has(defaultAction)) throw statusError('Invalid defaultVisibilityAction');
  const profileId = uuid();

  await withTransaction(p, async (connection) => {
    await connection.query(
      `INSERT INTO divedeep_protected_profiles
        (id,tenant_id,display_name_enc,jurisdiction_country,jurisdiction_region,status,scan_cadence_days,next_scan_at,created_by)
       VALUES (?,?,?,?,?,'active',?,NOW(3),?)`,
      [profileId, tenant, encryptPii(displayName), clean(input.jurisdictionCountry, 64), clean(input.jurisdictionRegion, 128), Math.min(Math.max(Number(input.scanCadenceDays) || 30, 1), 365), clean(actorId, 128) || null]
    );
    for (const identifier of identifiers) await insertIdentifier(connection, tenant, profileId, identifier, actorId);
    await connection.query(
      `INSERT INTO research_authorizations
        (id,tenant_id,profile_id,authorization_type,requester_role,requester_name_enc,requester_email_enc,
         scope_json,statement_version,signed_at,expires_at,status,verification_channel,proof_ref)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
      [uuid(), tenant, profileId, authorizationType, clean(input.requesterRole || authorizationType, 64), encryptPii(requesterName), encryptPii(requesterEmail),
        jsonText(input.authorizationScope || { purpose: 'privacy removal and monitoring' }), clean(input.statementVersion || 'divedeep-authorization-v1', 64),
        mysqlDate(input.authorizationDate || new Date()), mysqlDate(input.authorizationExpiresAt), clean(input.verificationChannel, 255) || null, clean(input.proofRef, 512) || null]
    );
    await connection.query(
      `INSERT INTO divedeep_visibility_policies
        (id,tenant_id,profile_id,scope_type,scope_value,action,priority)
       VALUES (?, ?, ?, 'default', '', ?, 0)`,
      [uuid(), tenant, profileId, defaultAction]
    );
    await addEvent(connection, {
      tenantId: tenant, profileId, eventType: 'profile.created', actorId,
      details: { authorizationType, identifierCount: identifiers.length, defaultAction },
    });
    if (input.enqueueInitialScan !== false) {
      await enqueueScanJob({
        tenantId: tenant, profileId, jobType: 'initial_scan', idempotencyKey: `initial_scan:${profileId}:v1`,
        payload: { source: 'profile_created' },
      }, connection);
    }
  });
  return getProtectedProfile(tenant, profileId, p);
}

async function addProfileIdentifier(tenantId, profileId, input, actorId = null, pool = null) {
  const p = pool || getPool();
  await getProtectedProfile(tenantId, profileId, p);
  let id;
  await withTransaction(p, async (connection) => {
    id = await insertIdentifier(connection, tenantId, profileId, input, actorId);
    await connection.query(`UPDATE divedeep_protected_profiles SET updated_at=NOW(3) WHERE id=? AND tenant_id=?`, [profileId, tenantId]);
  });
  const [rows] = await p.query(`SELECT * FROM divedeep_profile_identifiers WHERE id=? AND tenant_id=? LIMIT 1`, [id, tenantId]);
  return serializeIdentifier(rows[0]);
}

async function upsertVisibilityPolicy(tenantId, profileId, input, actorId = null, pool = null) {
  const p = pool || getPool();
  await getProtectedProfile(tenantId, profileId, p);
  const scopeType = clean(input.scopeType || 'default', 32);
  if (!VISIBILITY_SCOPES.has(scopeType)) throw statusError('Invalid visibility policy scope');
  const scopeValue = scopeType === 'default'
    ? ''
    : scopeType === 'profile_url'
      ? profileUrlKey(required(input.scopeValue, 'scopeValue', 2048)).slice(0, 255)
      : required(input.scopeValue, 'scopeValue', 255).toLowerCase();
  const action = clean(input.action, 32);
  if (!VISIBILITY_ACTIONS.has(action)) throw statusError('Invalid visibility policy action');
  const priority = Math.min(Math.max(Number(input.priority) || 0, -1000), 1000);
  const id = uuid();
  await withTransaction(p, async (connection) => {
    await connection.query(
      `INSERT INTO divedeep_visibility_policies
        (id,tenant_id,profile_id,scope_type,scope_value,action,priority)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE action=VALUES(action),priority=VALUES(priority),updated_at=NOW(3)`,
      [id, tenantId, profileId, scopeType, scopeValue, action, priority]
    );
    await addEvent(connection, {
      tenantId, profileId, eventType: 'profile.policy_updated', actorId,
      details: { scopeType, scopeValue, action, priority },
    });
  });
  const [rows] = await p.query(
    `SELECT * FROM divedeep_visibility_policies WHERE tenant_id=? AND profile_id=? AND scope_type=? AND scope_value=? LIMIT 1`,
    [tenantId, profileId, scopeType, scopeValue]
  );
  return serializePolicy(rows[0]);
}

async function listSources(tenantId, pool = null) {
  const p = pool || getPool();
  const tenant = assertTenant(tenantId);
  const [rows] = await p.query(
    `SELECT id,slug,name,domain,category,privacy_email,privacy_form_url,adapter_type,automation_level,
            allowed_request_types_json,jurisdictions_json,verification_requirements_json,rate_limit_json,status
     FROM divedeep_sources
     WHERE status='active' AND (tenant_id IS NULL OR tenant_id=?)
     ORDER BY tenant_id IS NULL DESC,name`,
    [tenant]
  );
  return rows.map((row) => ({
    id: row.id, slug: row.slug, name: row.name, domain: row.domain || '', category: row.category,
    privacyEmail: row.privacy_email || '', privacyFormUrl: row.privacy_form_url || '',
    adapterType: row.adapter_type, automationLevel: Number(row.automation_level) || 0,
    allowedRequestTypes: parseJson(row.allowed_request_types_json, []),
    jurisdictions: parseJson(row.jurisdictions_json, []),
    verificationRequirements: parseJson(row.verification_requirements_json, {}),
    rateLimit: parseJson(row.rate_limit_json, {}), status: row.status,
  }));
}

function serializeExposure(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    domain: row.domain || '',
    listingUrl: row.listing_url,
    listingIdentifier: decryptPii(row.listing_identifier_enc),
    subjectIdentifier: decryptPii(row.subject_identifier_enc),
    matchConfidence: Number(row.match_confidence) || 0,
    contentCategory: row.content_category,
    status: row.status,
    publicationStatus: row.publication_status || 'published',
    visibilityAction: row.visibility_action,
    evidenceRef: row.evidence_ref || '',
    evidenceSha256: row.evidence_sha256 || '',
    metadata: decryptJson(row.metadata_enc, {}),
    discoveredAt: iso(row.discovered_at),
    lastSeenAt: iso(row.last_seen_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function resolveVisibilityAction(tenantId, profileId, exposure, pool) {
  const [rows] = await pool.query(
    `SELECT * FROM divedeep_visibility_policies
     WHERE tenant_id=? AND profile_id=?
     ORDER BY priority DESC, FIELD(scope_type,'profile_url','source','domain','category','identifier_type','default'), updated_at DESC`,
    [tenantId, profileId]
  );
  for (const row of rows) {
    if (row.scope_type === 'default') return row.action;
    if (row.scope_type === 'source' && row.scope_value === clean(exposure.sourceId, 255).toLowerCase()) return row.action;
    if (row.scope_type === 'domain' && row.scope_value === clean(exposure.domain, 255).toLowerCase()) return row.action;
    if (row.scope_type === 'category' && row.scope_value === clean(exposure.contentCategory, 255).toLowerCase()) return row.action;
    if (row.scope_type === 'identifier_type' && row.scope_value === clean(exposure.identifierType, 255).toLowerCase()) return row.action;
    if (row.scope_type === 'profile_url' && exposure.listingUrl) {
      const listing = profileUrlKey(exposure.listingUrl);
      if (listing === row.scope_value || listing.startsWith(`${row.scope_value.replace(/\/+$/, '')}/`)) return row.action;
    }
  }
  return 'review';
}

async function upsertExposure(tenantId, profileId, input, actorId = null, pool = null) {
  const p = pool || getPool();
  await getProtectedProfile(tenantId, profileId, p);
  const listingUrl = normalizeUrl(input.listingUrl, 'listingUrl');
  const parsed = new URL(listingUrl);
  const sourceId = clean(input.sourceId, 36) || null;
  let source = null;
  if (sourceId) {
    const [sourceRows] = await p.query(
      `SELECT * FROM divedeep_sources WHERE id=? AND status='active' AND (tenant_id IS NULL OR tenant_id=?) LIMIT 1`,
      [sourceId, tenantId]
    );
    source = sourceRows[0] || null;
    if (!source) throw statusError('DiveDeep source not found', 404, 'DIVEDEEP_SOURCE_NOT_FOUND');
  }
  const exposureInput = {
    listingUrl,
    sourceId,
    sourceName: clean(input.sourceName || source?.name || parsed.hostname, 255),
    domain: clean(input.domain || source?.domain || parsed.hostname, 255).toLowerCase(),
    contentCategory: clean(input.contentCategory || source?.category || 'standard', 64),
    identifierType: clean(input.identifierType, 32),
  };
  const visibilityAction = await resolveVisibilityAction(tenantId, profileId, exposureInput, p);
  const status = visibilityAction === 'preserve' ? 'preserved' : visibilityAction === 'ignore' ? 'ignored' : 'review';
  const confidence = Math.min(Math.max(Number(input.matchConfidence) || 0, 0), 1);
  const requestedPublicationStatus = clean(input.publicationStatus, 16).toLowerCase();
  if (requestedPublicationStatus && !EXPOSURE_PUBLICATION_STATUSES.has(requestedPublicationStatus)) {
    throw statusError('Invalid exposure publication status');
  }
  const urlHash = sha256(listingUrl);
  let exposureId;

  await withTransaction(p, async (connection) => {
    const [existing] = await connection.query(
      `SELECT id,status FROM divedeep_exposures WHERE tenant_id=? AND profile_id=? AND listing_url_hash=? LIMIT 1 FOR UPDATE`,
      [tenantId, profileId, urlHash]
    );
    if (existing[0]) {
      exposureId = existing[0].id;
      const nextStatus = existing[0].status === 'removed' ? 'reappeared' : existing[0].status;
      await connection.query(
        `UPDATE divedeep_exposures SET source_id=?,source_name=?,domain=?,listing_url=?,listing_identifier_enc=?,
          subject_identifier_enc=?,match_confidence=?,content_category=?,visibility_action=?,status=?,publication_status=COALESCE(?,publication_status),evidence_ref=?,
          evidence_sha256=?,metadata_enc=?,last_seen_at=NOW(3),updated_at=NOW(3)
         WHERE id=? AND tenant_id=?`,
        [sourceId, exposureInput.sourceName, exposureInput.domain, listingUrl, encryptPii(clean(input.listingIdentifier, 1024)),
          encryptPii(clean(input.subjectIdentifier, 2048)), confidence, exposureInput.contentCategory, visibilityAction,
          nextStatus, requestedPublicationStatus || null, clean(input.evidenceRef, 1024) || null, clean(input.evidenceSha256, 64) || null,
          encryptJson(input.metadata || {}), exposureId, tenantId]
      );
      await addEvent(connection, {
        tenantId, profileId, exposureId, eventType: nextStatus === 'reappeared' ? 'exposure.reappeared' : 'exposure.seen_again', actorId,
        details: { sourceId, domain: exposureInput.domain, matchConfidence: confidence },
      });
    } else {
      exposureId = uuid();
      await connection.query(
        `INSERT INTO divedeep_exposures
          (id,tenant_id,profile_id,source_id,source_name,domain,listing_url,listing_url_hash,listing_identifier_enc,
           subject_identifier_enc,match_confidence,content_category,status,publication_status,visibility_action,evidence_ref,evidence_sha256,
           metadata_enc,discovered_at,last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,NOW(3)),NOW(3))`,
        [exposureId, tenantId, profileId, sourceId, exposureInput.sourceName, exposureInput.domain, listingUrl, urlHash,
          encryptPii(clean(input.listingIdentifier, 1024)), encryptPii(clean(input.subjectIdentifier, 2048)), confidence,
          exposureInput.contentCategory, status, requestedPublicationStatus || 'published', visibilityAction, clean(input.evidenceRef, 1024) || null,
          clean(input.evidenceSha256, 64) || null, encryptJson(input.metadata || {}), mysqlDate(input.discoveredAt)]
      );
      await addEvent(connection, {
        tenantId, profileId, exposureId, eventType: 'exposure.discovered', actorId,
        details: { sourceId, domain: exposureInput.domain, matchConfidence: confidence, visibilityAction },
      });
    }
    await connection.query(`UPDATE divedeep_protected_profiles SET updated_at=NOW(3) WHERE id=? AND tenant_id=?`, [profileId, tenantId]);
  });
  return getExposure(tenantId, exposureId, p);
}

async function getExposure(tenantId, exposureId, pool = null) {
  const p = pool || getPool();
  const tenant = assertTenant(tenantId);
  const [rows] = await p.query(`SELECT * FROM divedeep_exposures WHERE id=? AND tenant_id=? LIMIT 1`, [exposureId, tenant]);
  if (!rows[0]) throw statusError('Exposure not found', 404, 'DIVEDEEP_EXPOSURE_NOT_FOUND');
  return serializeExposure(rows[0]);
}

async function listExposures(tenantId, options = {}, pool = null) {
  const p = pool || getPool();
  const params = [assertTenant(tenantId)];
  let where = 'tenant_id=?';
  if (options.profileId) { where += ' AND profile_id=?'; params.push(options.profileId); }
  if (options.status) {
    if (!EXPOSURE_STATUSES.has(options.status)) throw statusError('Invalid exposure status');
    where += ' AND status=?'; params.push(options.status);
  }
  if (options.publicationStatus) {
    where += ' AND publication_status=?';
    params.push(clean(options.publicationStatus, 16));
  }
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const offset = Math.max(Number(options.offset) || 0, 0);
  params.push(limit, offset);
  const [rows] = await p.query(`SELECT * FROM divedeep_exposures WHERE ${where} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`, params);
  return rows.map(serializeExposure);
}

async function updateExposureStatus(tenantId, exposureId, status, actorId = null, pool = null) {
  const p = pool || getPool();
  const next = clean(status, 32);
  if (!EXPOSURE_STATUSES.has(next)) throw statusError('Invalid exposure status');
  const exposure = await getExposure(tenantId, exposureId, p);
  if (['preserve', 'ignore'].includes(exposure.visibilityAction)) {
    throw statusError(
      'This listing is protected by the customer visibility policy and cannot become a removal case',
      409,
      'DIVEDEEP_EXPOSURE_PROTECTED'
    );
  }
  await withTransaction(p, async (connection) => {
    await connection.query(`UPDATE divedeep_exposures SET status=?,updated_at=NOW(3) WHERE id=? AND tenant_id=?`, [next, exposureId, tenantId]);
    await addEvent(connection, {
      tenantId, profileId: exposure.profileId, exposureId, eventType: 'exposure.status_changed', actorId,
      details: { from: exposure.status, to: next },
    });
  });
  return getExposure(tenantId, exposureId, p);
}

function defaultTemplateForExposure(exposure) {
  const category = String(exposure.contentCategory || '').toLowerCase();
  if (category.includes('people')) return 'people-search-removal';
  if (category.includes('b2b') || category.includes('lead')) return 'b2b-contact-removal';
  if (category.includes('marketing')) return 'marketing-suppression';
  if (category.includes('adult')) return 'adult-profile-removal';
  return 'data-broker-deletion';
}

async function activeAuthorization(tenantId, profileId, pool) {
  const [rows] = await pool.query(
    `SELECT * FROM research_authorizations
     WHERE tenant_id=? AND profile_id=? AND status='active' AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at>NOW(3))
     ORDER BY signed_at DESC LIMIT 1`,
    [tenantId, profileId]
  );
  if (!rows[0]) throw statusError('An active authorization is required', 409, 'DIVEDEEP_AUTHORIZATION_INACTIVE');
  return rows[0];
}

async function primaryIdentifier(tenantId, profileId, pool) {
  const [rows] = await pool.query(
    `SELECT * FROM divedeep_profile_identifiers
     WHERE tenant_id=? AND profile_id=? AND status='active'
     ORDER BY is_primary DESC, FIELD(identifier_type,'email','phone','address','name','alias','username','domain','other'),created_at LIMIT 1`,
    [tenantId, profileId]
  );
  return rows[0] ? decryptPii(rows[0].value_enc) : '';
}

function serializeCase(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    exposureId: row.exposure_id,
    sourceId: row.source_id,
    requestType: row.request_type,
    templateKey: row.template_key,
    deliveryMethod: row.delivery_method,
    state: row.state,
    jurisdictionBasis: row.jurisdiction_basis || '',
    recipientEmail: decryptPii(row.recipient_email_enc),
    emailSubject: decryptPii(row.email_subject_enc),
    emailBody: decryptPii(row.email_body_enc),
    responseDueAt: iso(row.response_due_at),
    sentAt: iso(row.sent_at),
    confirmationReference: row.confirmation_reference || '',
    notes: decryptPii(row.notes_enc),
    revision: Number(row.revision) || 1,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function getCase(tenantId, caseId, pool = null) {
  const p = pool || getPool();
  const tenant = assertTenant(tenantId);
  const [rows] = await p.query(`SELECT * FROM divedeep_cases WHERE id=? AND tenant_id=? LIMIT 1`, [caseId, tenant]);
  if (!rows[0]) throw statusError('Privacy case not found', 404, 'DIVEDEEP_CASE_NOT_FOUND');
  return serializeCase(rows[0]);
}

async function listCases(tenantId, options = {}, pool = null) {
  const p = pool || getPool();
  const params = [assertTenant(tenantId)];
  const join = options.publishedOnly
    ? ` JOIN divedeep_exposures published_exposure ON published_exposure.id=privacy_case.exposure_id AND published_exposure.publication_status='published'`
    : '';
  let where = 'privacy_case.tenant_id=?';
  if (options.profileId) { where += ' AND privacy_case.profile_id=?'; params.push(options.profileId); }
  if (options.state) { where += ' AND privacy_case.state=?'; params.push(clean(options.state, 32)); }
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const offset = Math.max(Number(options.offset) || 0, 0);
  params.push(limit, offset);
  const [rows] = await p.query(
    `SELECT privacy_case.* FROM divedeep_cases privacy_case${join} WHERE ${where} ORDER BY privacy_case.updated_at DESC LIMIT ? OFFSET ?`,
    params
  );
  return rows.map(serializeCase);
}

async function createCaseFromExposure(tenantId, exposureId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const exposure = await getExposure(tenantId, exposureId, p);
  if (!['confirmed', 'reappeared'].includes(exposure.status) && !bool(input.reviewApproved)) {
    throw statusError('Exposure must be confirmed before creating a removal case', 409, 'DIVEDEEP_EXPOSURE_CONFIRMATION_REQUIRED');
  }
  const profile = await getProtectedProfile(tenantId, exposure.profileId, p);
  const authorization = await activeAuthorization(tenantId, exposure.profileId, p);
  let source = null;
  if (exposure.sourceId) {
    const [sourceRows] = await p.query(`SELECT * FROM divedeep_sources WHERE id=? AND (tenant_id IS NULL OR tenant_id=?) LIMIT 1`, [exposure.sourceId, tenantId]);
    source = sourceRows[0] || null;
  }
  const templateKey = clean(input.templateKey || defaultTemplateForExposure(exposure), 64);
  if (!TEMPLATE_BY_KEY[templateKey]) throw statusError('Unknown privacy request template');
  const requesterName = decryptPii(authorization.requester_name_enc);
  const requesterEmail = decryptPii(authorization.requester_email_enc);
  const subjectIdentifier = clean(input.subjectIdentifier, 2048) || exposure.subjectIdentifier || await primaryIdentifier(tenantId, exposure.profileId, p);
  const legalBasis = clean(input.legalBasis, 4096) || LEGAL_BASIS_PRESETS[clean(input.legalBasisPreset, 64)] || LEGAL_BASIS_PRESETS['plain-language'];
  const requesterStatement = authorization.authorization_type === 'self'
    ? 'the person identified in this request'
    : 'an authorized representative of the person identified in this request';
  const caseId = uuid();
  const requestActions = required(input.requestActions || 'Delete or suppress the identified personal information and prevent republication under the same identity, subject to lawful exceptions.', 'requestActions', 5000);
  const recipientEmail = clean(input.recipientEmail || source?.privacy_email, 320);
  const deliveryMethod = clean(input.deliveryMethod || (recipientEmail ? 'email' : source?.adapter_type || 'customer_form'), 32);
  const idempotencyKey = clean(input.idempotencyKey, 191) || null;
  if (idempotencyKey) {
    const [existing] = await p.query(`SELECT * FROM divedeep_cases WHERE tenant_id=? AND idempotency_key=? LIMIT 1`, [tenantId, idempotencyKey]);
    if (existing[0]) return serializeCase(existing[0]);
  }
  const rendered = renderTemplate(templateKey, {
    company_name: exposure.sourceName,
    requester_statement: requesterStatement,
    subject_name: profile.displayName,
    subject_email_or_identifier: subjectIdentifier,
    profile_url: exposure.listingUrl,
    listing_identifier: exposure.listingIdentifier,
    request_actions: requestActions,
    legal_basis: legalBasis,
    case_reference: caseId,
    requester_name: requesterName,
    requester_email: requesterEmail,
  });

  await withTransaction(p, async (connection) => {
    await connection.query(
      `INSERT INTO divedeep_cases
        (id,tenant_id,profile_id,exposure_id,source_id,request_type,template_key,delivery_method,state,
         jurisdiction_basis,recipient_email_enc,email_subject_enc,email_body_enc,response_due_at,idempotency_key,notes_enc)
       VALUES (?,?,?,?,?,?,?,?, 'draft',?,?,?,?,?,?,?)`,
      [caseId, tenantId, exposure.profileId, exposureId, exposure.sourceId || null, clean(input.requestType || templateKey, 64),
        templateKey, deliveryMethod, legalBasis, encryptPii(recipientEmail), encryptPii(rendered.subject), encryptPii(rendered.body),
        mysqlDate(input.responseDueAt), idempotencyKey, encryptPii(clean(input.notes, 5000))]
    );
    await connection.query(`UPDATE divedeep_exposures SET status='confirmed',updated_at=NOW(3) WHERE id=? AND tenant_id=?`, [exposureId, tenantId]);
    await addEvent(connection, {
      tenantId, profileId: exposure.profileId, caseId, exposureId, eventType: 'case.drafted', actorId,
      details: { templateKey, deliveryMethod, recipientConfigured: Boolean(recipientEmail) },
    });
  });
  return getCase(tenantId, caseId, p);
}

async function transitionCase(tenantId, caseId, input, actorId = null, pool = null) {
  const p = pool || getPool();
  const next = required(input.state, 'state', 32);
  const current = await getCase(tenantId, caseId, p);
  const allowed = CASE_TRANSITIONS[current.state];
  if (!allowed || !allowed.has(next)) throw statusError(`Cannot transition case from ${current.state} to ${next}`, 409, 'DIVEDEEP_CASE_TRANSITION_INVALID');
  const expectedRevision = input.expectedRevision == null ? current.revision : Number(input.expectedRevision);
  await withTransaction(p, async (connection) => {
    const sentAtSql = next === 'sent' ? 'COALESCE(sent_at,NOW(3))' : 'sent_at';
    const [result] = await connection.query(
      `UPDATE divedeep_cases SET state=?,confirmation_reference=?,notes_enc=?,response_due_at=?,sent_at=${sentAtSql},revision=revision+1,updated_at=NOW(3)
       WHERE id=? AND tenant_id=? AND revision=?`,
      [next, clean(input.confirmationReference, 255) || current.confirmationReference || null,
        encryptPii(clean(input.notes, 5000) || current.notes), mysqlDate(input.responseDueAt) || mysqlDate(current.responseDueAt),
        caseId, tenantId, expectedRevision]
    );
    if (!result.affectedRows) throw statusError('Case changed in another session; reload before updating', 409, 'DIVEDEEP_CASE_REVISION_CONFLICT');
    await addEvent(connection, {
      tenantId, profileId: current.profileId, caseId, exposureId: current.exposureId,
      eventType: 'case.state_changed', actorId, details: { from: current.state, to: next, revision: expectedRevision + 1 },
    });
  });
  return getCase(tenantId, caseId, p);
}

async function addVerification(tenantId, caseId, input, actorId = null, pool = null) {
  const p = pool || getPool();
  const privacyCase = await getCase(tenantId, caseId, p);
  const result = required(input.result, 'result', 32);
  if (!VERIFICATION_RESULTS.has(result)) throw statusError('Invalid verification result');
  const verificationId = uuid();
  await withTransaction(p, async (connection) => {
    await connection.query(
      `INSERT INTO divedeep_verifications
        (id,tenant_id,profile_id,case_id,exposure_id,result,source_url,notes_enc,checked_at,evidence_ref,evidence_sha256)
       VALUES (?,?,?,?,?,?,?,?,COALESCE(?,NOW(3)),?,?)`,
      [verificationId, tenantId, privacyCase.profileId, caseId, privacyCase.exposureId, result,
        input.sourceUrl ? normalizeUrl(input.sourceUrl, 'sourceUrl') : null, encryptPii(clean(input.notes, 5000)),
        mysqlDate(input.checkedAt), clean(input.evidenceRef, 1024) || null, clean(input.evidenceSha256, 64) || null]
    );
    if (result === 'removed') {
      await connection.query(`UPDATE divedeep_exposures SET status='removed',updated_at=NOW(3) WHERE id=? AND tenant_id=?`, [privacyCase.exposureId, tenantId]);
      if (!['completed', 'withdrawn'].includes(privacyCase.state)) {
        await connection.query(`UPDATE divedeep_cases SET state='completed',revision=revision+1,updated_at=NOW(3) WHERE id=? AND tenant_id=?`, [caseId, tenantId]);
      }
    } else if (result === 'still_present') {
      await connection.query(`UPDATE divedeep_exposures SET status='confirmed',updated_at=NOW(3) WHERE id=? AND tenant_id=?`, [privacyCase.exposureId, tenantId]);
    }
    await addEvent(connection, {
      tenantId, profileId: privacyCase.profileId, caseId, exposureId: privacyCase.exposureId,
      eventType: 'case.verified', actorId, details: { verificationId, result },
    });
  });
  return getVerification(tenantId, verificationId, p);
}

async function getVerification(tenantId, verificationId, pool = null) {
  const p = pool || getPool();
  const tenant = assertTenant(tenantId);
  const [rows] = await p.query(`SELECT * FROM divedeep_verifications WHERE id=? AND tenant_id=? LIMIT 1`, [verificationId, tenant]);
  if (!rows[0]) throw statusError('Verification not found', 404, 'DIVEDEEP_VERIFICATION_NOT_FOUND');
  const row = rows[0];
  return {
    id: row.id, profileId: row.profile_id, caseId: row.case_id, exposureId: row.exposure_id,
    result: row.result, sourceUrl: row.source_url || '', notes: decryptPii(row.notes_enc),
    evidenceRef: row.evidence_ref || '', evidenceSha256: row.evidence_sha256 || '', checkedAt: iso(row.checked_at),
  };
}

async function getCaseTimeline(tenantId, caseId, pool = null) {
  const p = pool || getPool();
  await getCase(tenantId, caseId, p);
  const [rows] = await p.query(
    `SELECT id,event_type,actor_type,actor_id,details_json,created_at
     FROM divedeep_case_events WHERE tenant_id=? AND case_id=? ORDER BY created_at,id`,
    [tenantId, caseId]
  );
  return rows.map((row) => ({
    id: row.id, eventType: row.event_type, actorType: row.actor_type, actorId: row.actor_id,
    details: parseJson(row.details_json, {}), createdAt: iso(row.created_at),
  }));
}

function serializeJob(row) {
  if (!row) return null;
  return {
    id: row.id, profileId: row.profile_id, jobType: row.job_type, status: row.status,
    idempotencyKey: row.idempotency_key, payload: parseJson(row.payload_json, {}),
    attempts: Number(row.attempts) || 0, maxAttempts: Number(row.max_attempts) || 0,
    availableAt: iso(row.available_at), leaseUntil: iso(row.lease_until), workerId: row.worker_id || '',
    lastError: row.last_error || '', createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), completedAt: iso(row.completed_at),
  };
}

async function getJob(tenantId, jobId, pool = null) {
  const p = pool || getPool();
  const tenant = assertTenant(tenantId);
  const [rows] = await p.query(`SELECT * FROM divedeep_scan_jobs WHERE id=? AND tenant_id=? LIMIT 1`, [jobId, tenant]);
  if (!rows[0]) throw statusError('Scan job not found', 404, 'DIVEDEEP_JOB_NOT_FOUND');
  return serializeJob(rows[0]);
}

async function listJobs(tenantId, options = {}, pool = null) {
  const p = pool || getPool();
  const params = [assertTenant(tenantId)];
  let where = 'tenant_id=?';
  if (options.profileId) { where += ' AND profile_id=?'; params.push(options.profileId); }
  if (options.status) { where += ' AND status=?'; params.push(clean(options.status, 32)); }
  params.push(Math.min(Math.max(Number(options.limit) || 100, 1), 500));
  const [rows] = await p.query(`SELECT * FROM divedeep_scan_jobs WHERE ${where} ORDER BY created_at DESC LIMIT ?`, params);
  return rows.map(serializeJob);
}

async function claimJob(tenantId, input = {}, pool = null) {
  const p = pool || getPool();
  const tenant = assertTenant(tenantId);
  const workerId = required(input.workerId, 'workerId', 128);
  const leaseSeconds = Math.min(Math.max(Number(input.leaseSeconds) || 300, 30), 3600);
  const leaseToken = crypto.randomBytes(32).toString('base64url');
  let claimed = null;
  await withTransaction(p, async (connection) => {
    const [rows] = await connection.query(
      `SELECT * FROM divedeep_scan_jobs
       WHERE tenant_id=? AND available_at<=NOW(3)
         AND (status='queued' OR (status='running' AND lease_until<NOW(3)))
       ORDER BY available_at,created_at LIMIT 1 FOR UPDATE`,
      [tenant]
    );
    if (!rows[0]) return;
    const row = rows[0];
    const attempts = Number(row.attempts) + 1;
    if (attempts > Number(row.max_attempts)) {
      await connection.query(`UPDATE divedeep_scan_jobs SET status='dead',completed_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [row.id]);
      return;
    }
    await connection.query(
      `UPDATE divedeep_scan_jobs SET status='running',attempts=?,worker_id=?,lease_token_hash=?,
       lease_until=DATE_ADD(NOW(3), INTERVAL ? SECOND),updated_at=NOW(3) WHERE id=? AND tenant_id=?`,
      [attempts, workerId, sha256(leaseToken), leaseSeconds, row.id, tenant]
    );
    const [updated] = await connection.query(`SELECT * FROM divedeep_scan_jobs WHERE id=? AND tenant_id=? LIMIT 1`, [row.id, tenant]);
    claimed = { ...serializeJob(updated[0]), leaseToken };
    await addEvent(connection, {
      tenantId: tenant, profileId: row.profile_id, eventType: 'scan.claimed', actorType: 'worker', actorId: workerId,
      details: { jobId: row.id, jobType: row.job_type, attempt: attempts },
    });
  });
  return claimed;
}

async function completeJob(tenantId, jobId, input, pool = null) {
  const p = pool || getPool();
  const tenant = assertTenant(tenantId);
  const leaseToken = required(input.leaseToken, 'leaseToken', 256);
  const outcome = clean(input.status || 'succeeded', 32);
  if (!['succeeded', 'failed', 'retry'].includes(outcome)) throw statusError('Invalid job completion status');
  let finalStatus;
  await withTransaction(p, async (connection) => {
    const [rows] = await connection.query(`SELECT * FROM divedeep_scan_jobs WHERE id=? AND tenant_id=? LIMIT 1 FOR UPDATE`, [jobId, tenant]);
    const row = rows[0];
    if (!row) throw statusError('Scan job not found', 404, 'DIVEDEEP_JOB_NOT_FOUND');
    const leaseExpired = row.lease_until && new Date(row.lease_until).getTime() < Date.now();
    if (row.status !== 'running' || row.lease_token_hash !== sha256(leaseToken) || leaseExpired) {
      throw statusError('Job lease is invalid or expired', 409, 'DIVEDEEP_JOB_LEASE_INVALID');
    }
    if (outcome === 'succeeded') finalStatus = 'succeeded';
    else if (outcome === 'retry' || Number(row.attempts) < Number(row.max_attempts)) finalStatus = 'queued';
    else finalStatus = 'dead';
    await connection.query(
      `UPDATE divedeep_scan_jobs SET status=?,lease_token_hash=NULL,lease_until=NULL,worker_id=NULL,
       available_at=CASE WHEN ?='queued' THEN DATE_ADD(NOW(3),INTERVAL ? SECOND) ELSE available_at END,
       result_json=?,last_error=?,completed_at=CASE WHEN ? IN ('succeeded','dead') THEN NOW(3) ELSE NULL END,updated_at=NOW(3)
       WHERE id=? AND tenant_id=?`,
      [finalStatus, finalStatus, Math.min(Math.max(Number(input.retryAfterSeconds) || 60, 5), 86400),
        jsonText(input.resultSummary || {}), clean(input.error, 2000) || null, finalStatus, jobId, tenant]
    );
    if (finalStatus === 'succeeded') {
      await connection.query(
        `UPDATE divedeep_protected_profiles SET last_scan_at=NOW(3),next_scan_at=DATE_ADD(NOW(3),INTERVAL scan_cadence_days DAY),updated_at=NOW(3)
         WHERE id=? AND tenant_id=?`,
        [row.profile_id, tenant]
      );
    }
    await addEvent(connection, {
      tenantId: tenant, profileId: row.profile_id, eventType: `scan.${finalStatus}`, actorType: 'worker', actorId: clean(input.workerId, 128) || row.worker_id,
      details: { jobId, jobType: row.job_type, attempts: row.attempts, errorCode: clean(input.errorCode, 64) || null },
    });
  });
  return getJob(tenant, jobId, p);
}

async function exportProfilePacket(tenantId, profileId, pool = null) {
  const p = pool || getPool();
  const profile = await getProtectedProfile(tenantId, profileId, p);
  const [exposures, cases, jobs] = await Promise.all([
    listExposures(tenantId, { profileId, limit: 500 }, p),
    listCases(tenantId, { profileId, limit: 500 }, p),
    listJobs(tenantId, { profileId, limit: 500 }, p),
  ]);
  const caseIds = cases.map((item) => item.id);
  let events = [];
  let verifications = [];
  if (caseIds.length) {
    const placeholders = caseIds.map(() => '?').join(',');
    const [eventRows, verificationRows] = await Promise.all([
      p.query(`SELECT * FROM divedeep_case_events WHERE tenant_id=? AND case_id IN (${placeholders}) ORDER BY created_at`, [tenantId, ...caseIds]).then(([rows]) => rows),
      p.query(`SELECT * FROM divedeep_verifications WHERE tenant_id=? AND case_id IN (${placeholders}) ORDER BY checked_at`, [tenantId, ...caseIds]).then(([rows]) => rows),
    ]);
    events = eventRows.map((row) => ({ id: row.id, caseId: row.case_id, exposureId: row.exposure_id, eventType: row.event_type, details: parseJson(row.details_json, {}), createdAt: iso(row.created_at) }));
    verifications = verificationRows.map((row) => ({ id: row.id, caseId: row.case_id, exposureId: row.exposure_id, result: row.result, sourceUrl: row.source_url || '', notes: decryptPii(row.notes_enc), checkedAt: iso(row.checked_at), evidenceRef: row.evidence_ref || '', evidenceSha256: row.evidence_sha256 || '' }));
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile,
    exposures,
    cases,
    verifications,
    events,
    jobs,
  };
}

module.exports = {
  IDENTIFIER_TYPES,
  VISIBILITY_ACTIONS,
  EXPOSURE_STATUSES,
  CASE_TRANSITIONS,
  templateCatalog,
  createProtectedProfile,
  listProtectedProfiles,
  getProtectedProfile,
  addProfileIdentifier,
  upsertVisibilityPolicy,
  listSources,
  enqueueScanJob,
  listJobs,
  claimJob,
  completeJob,
  upsertExposure,
  getExposure,
  listExposures,
  updateExposureStatus,
  createCaseFromExposure,
  getCase,
  listCases,
  transitionCase,
  addVerification,
  getCaseTimeline,
  exportProfilePacket,
  statusError,
  normalizeUrl,
  profileUrlKey,
};
