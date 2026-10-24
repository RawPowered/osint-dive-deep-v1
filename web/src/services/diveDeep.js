const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool } = require('../db/pool');
const { getDiveDeepConfig } = require('../config');
const {
  blindIndex,
  encryptPii,
  decryptPii,
  encryptJson,
  decryptJson,
  normalizeIdentifier,
} = require('./divedeepPii');
const {
  createProtectedProfile,
  listProtectedProfiles,
  getProtectedProfile,
  addProfileIdentifier,
  upsertVisibilityPolicy,
  listExposures,
  listCases,
  upsertExposure,
  updateExposureStatus,
  createCaseFromExposure,
  transitionCase,
  addVerification,
  exportProfilePacket,
  normalizeUrl,
  profileUrlKey,
  statusError,
} = require('./divedeepPrivacy');
const {
  writeEncryptedPhoto,
  readEncryptedPhoto,
  deleteEncryptedPhoto,
  sha256Buffer,
} = require('./diveDeepFiles');
const diveDeepAuthorizations = require('./diveDeepAuthorizations');
const platformCatalog = require('./platformCatalog');

const PLAN_TIERS = new Set(['standard', 'deep', 'sensitive', 'image']);
const DEFAULT_PACKAGES = Object.freeze([
  { id: 'standard', name: 'Basic Privacy', description: 'Public-profile review, standard discovery, and removal-case tracking.', monthlyPriceCents: 0, restricted: false, active: true, sortOrder: 10 },
  { id: 'deep', name: 'Advanced Discovery', description: 'Broader identity discovery across supported people-search and public-profile sources.', monthlyPriceCents: 0, restricted: false, active: true, sortOrder: 20 },
  { id: 'sensitive', name: '18+ Adult Site Scrubbing', description: 'Restricted adult-site review and removal-case support for adults protecting their own identity.', monthlyPriceCents: 0, restricted: true, active: true, sortOrder: 30 },
  { id: 'image', name: 'Advanced Image Scrubbing', description: 'Adult-site review plus authorized image-match review and image-removal case preparation.', monthlyPriceCents: 0, restricted: true, active: true, sortOrder: 40 },
]);
const CUSTOMER_STATUSES = new Set(['pending', 'active', 'paused', 'closed']);
const WORKFLOW_STATUSES = new Set([
  'onboarding', 'intake_ready', 'awaiting_dispatch', 'dispatched', 'researching',
  'awaiting_review', 'awaiting_customer_validation', 'disposition_required', 'evidence_ready',
  'removal_preparation', 'requests_in_progress', 'monitoring', 'closure_ready',
  'complete', 'blocked', 'exported', 'results_ready',
]);
const PHOTO_PURPOSES = new Set(['identity_search', 'sensitive_search', 'verification']);
const DIVEDEEP_RESULT_PACKET_MAX_BYTES = 5 * 1024 * 1024;
const DIVEDEEP_EVIDENCE_EMBEDDED_FIELDS = new Set([
  'base64', 'blob', 'bytes', 'contentBytes', 'data', 'fileContents', 'rawBytes',
]);
const SOCIAL_PROVIDERS = new Set([
  'facebook', 'instagram', 'x', 'tiktok', 'linkedin', 'reddit', 'youtube',
  'pinterest', 'snapchat', 'threads', 'github', 'other',
]);

function uuid() { return crypto.randomUUID(); }
function clean(value, max = 255) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : '';
}
function bool(value) { return value === true || value === 1 || String(value).toLowerCase() === 'true'; }
function asArray(value, max = 100) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw statusError('Expected an array');
  return value.slice(0, max);
}
function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function iso(value) { return value ? new Date(value).toISOString() : null; }
function normalizeEmail(value) { return clean(value, 320).toLowerCase(); }
function emailHash(value) { return blindIndex('divedeep-customer-accounts', 'email', normalizeEmail(value)); }
function strongPassword(value) {
  const password = String(value || '');
  if (password.length < 12 || password.length > 200) {
    throw statusError('Password must be between 12 and 200 characters', 400, 'DIVEDEEP_PASSWORD_WEAK');
  }
  return password;
}
function validatePlan(value) {
  const plan = clean(value || 'standard', 32).toLowerCase();
  if (!PLAN_TIERS.has(plan)) throw statusError('Invalid service level');
  return plan;
}
function requiresRestrictedConsent(plan) {
  return plan === 'sensitive' || plan === 'image';
}
function divedeepPacketBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { throw statusError('DiveDeep result packet is not valid JSON', 400, 'DIVEDEEP_DIVEDEEP_PACKET_INVALID'); }
}
function normalizeImportedEvidence(value) {
  return asArray(value || [], 50)
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      for (const key of DIVEDEEP_EVIDENCE_EMBEDDED_FIELDS) {
        if (item[key] != null && String(item[key]).length) {
          throw statusError(
            'Evidence files must remain outside the DiveDeep JSON packet',
            413,
            'DIVEDEEP_DIVEDEEP_EVIDENCE_EMBEDDED'
          );
        }
      }
      const ref = clean(item.ref, 1024);
      if (/^data:/i.test(ref)) {
        throw statusError(
          'Evidence data URIs are not accepted. Import evidence references and SHA-256 hashes only',
          413,
          'DIVEDEEP_DIVEDEEP_EVIDENCE_EMBEDDED'
        );
      }
      const rawSha256 = clean(item.sha256, 64);
      const sha256 = rawSha256 && /^[a-f0-9]{64}$/i.test(rawSha256) ? rawSha256.toLowerCase() : '';
      return {
        type: clean(item.type || 'reference', 64),
        ref,
        sha256,
        capturedAt: clean(item.capturedAt, 64),
        notes: clean(item.notes, 2000),
      };
    })
    .filter((item) => item.ref || item.sha256 || item.notes);
}
function normalizeImportedLocal(value) {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    privacyFindingId: clean(item.privacyFindingId, 128),
    privacyRequestId: clean(item.privacyRequestId, 128),
    privacyVerificationId: clean(item.privacyVerificationId, 128),
    coreFindingId: clean(item.coreFindingId, 128),
  };
}
function normalizeDiveDeepSummary(value) {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const key of ['sourcesReviewed', 'candidatesReviewed', 'confirmedFindings', 'requestsSent', 'removed', 'stillPresent']) {
    const number = Number(item[key]);
    output[key] = Number.isFinite(number) ? Math.max(0, Math.min(Math.trunc(number), 1000000)) : 0;
  }
  return output;
}

function safeCompare(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizePilotCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9][A-Z0-9-]{5,63}$/.test(code)) throw statusError('Pilot code must be 6-64 letters, numbers, or hyphens');
  return code;
}
function pilotCodeHash(code) { return blindIndex('divedeep-pilot-codes', 'code', code); }
function asPriceCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw statusError('Monthly price must be between $0 and $100,000');
  return Math.round(amount * 100);
}
function serializePackage(row) {
  return {
    id: row.id, name: row.name, description: row.description,
    monthlyPrice: (Number(row.monthly_price_cents) || 0) / 100,
    monthlyPriceCents: Number(row.monthly_price_cents) || 0,
    stripePriceId: row.stripe_price_id || '', restricted: Boolean(row.is_restricted),
    sensitive: Boolean(row.is_restricted), active: Boolean(row.is_active), sortOrder: Number(row.sort_order) || 0,
    currentVersion: Number(row.current_version) || 1,
    updatedAt: iso(row.updated_at),
  };
}
function serializePilotCode(row) {
  return {
    id: row.id, codeHint: row.code_hint, label: row.label, packageId: row.package_id || '',
    discountPercent: Number(row.discount_percent) || 0, developerTest: Boolean(row.developer_test),
    maxRedemptions: row.max_redemptions == null ? null : Number(row.max_redemptions),
    redemptionCount: Number(row.redemption_count) || 0, active: Boolean(row.is_active),
    startsAt: iso(row.starts_at), expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

async function ensureDefaultPackages(pool = null) {
  const p = pool || getPool();
  for (const item of DEFAULT_PACKAGES) {
    await p.query(
      `INSERT IGNORE INTO divedeep_packages
        (id,name,description,monthly_price_cents,is_restricted,is_active,sort_order)
       VALUES (?,?,?,?,?,?,?)`,
      [item.id, item.name, item.description, item.monthlyPriceCents, item.restricted ? 1 : 0, item.active ? 1 : 0, item.sortOrder]
    );
  }
}

async function listPackages(options = {}, pool = null) {
  const p = pool || getPool();
  await ensureDefaultPackages(p);
  const activeOnly = options.activeOnly === true;
  const [rows] = await p.query(
    `SELECT * FROM divedeep_packages ${activeOnly ? 'WHERE is_active=1' : ''} ORDER BY sort_order,id`
  );
  return rows.map(serializePackage);
}

async function getPackage(packageId, pool = null) {
  const p = pool || getPool();
  await ensureDefaultPackages(p);
  const [rows] = await p.query('SELECT * FROM divedeep_packages WHERE id=? LIMIT 1', [validatePlan(packageId)]);
  if (!rows[0]) throw statusError('Selected package is unavailable', 409, 'DIVEDEEP_PACKAGE_UNAVAILABLE');
  return serializePackage(rows[0]);
}

async function updatePackage(packageId, input, actorId, pool = null) {
  const p = pool || getPool();
  const id = validatePlan(packageId);
  const current = await getPackage(id, p);
  const name = clean(input.name || current.name, 120);
  const description = clean(input.description || current.description, 1000);
  if (!name || !description) throw statusError('Package name and description are required');
  const cents = input.monthlyPrice !== undefined ? asPriceCents(input.monthlyPrice) : current.monthlyPriceCents;
  const stripePriceId = clean(input.stripePriceId ?? current.stripePriceId, 255) || null;
  const active = input.active === undefined ? current.active : bool(input.active);
  await p.query(
    `UPDATE divedeep_packages SET name=?,description=?,monthly_price_cents=?,stripe_price_id=?,is_active=?,updated_by=?,updated_at=NOW(3) WHERE id=?`,
    [name, description, cents, stripePriceId, active ? 1 : 0, clean(actorId, 128) || null, id]
  );
  return getPackage(id, p);
}

async function listPilotCodes(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_pilot_codes ORDER BY created_at DESC LIMIT 500');
  return rows.map(serializePilotCode);
}

async function createPilotCode(input, actorId, pool = null) {
  const p = pool || getPool();
  const code = input.code ? normalizePilotCode(input.code) : `FID-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const label = clean(input.label || 'Pilot access', 160);
  if (!label) throw statusError('Pilot code label is required');
  const packageId = input.packageId ? validatePlan(input.packageId) : null;
  if (packageId) await getPackage(packageId, p);
  const discountPercent = Number(input.discountPercent ?? 0);
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) throw statusError('Discount must be between 0 and 100 percent');
  const developerTest = bool(input.developerTest);
  if (developerTest && discountPercent !== 100) throw statusError('Developer test codes must be 100% free');
  const max = input.maxRedemptions === '' || input.maxRedemptions == null ? null : Number(input.maxRedemptions);
  if (max !== null && (!Number.isInteger(max) || max < 1 || max > 100000)) throw statusError('Maximum redemptions must be a whole number from 1 to 100,000');
  const startsAt = input.startsAt ? new Date(input.startsAt) : null;
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if ((startsAt && Number.isNaN(startsAt.getTime())) || (expiresAt && Number.isNaN(expiresAt.getTime())) || (startsAt && expiresAt && startsAt >= expiresAt)) throw statusError('Pilot-code dates are invalid');
  const id = uuid();
  try {
    await p.query(
      `INSERT INTO divedeep_pilot_codes
       (id,code_hash,code_hint,label,package_id,discount_percent,developer_test,max_redemptions,starts_at,expires_at,is_active,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
      [id, pilotCodeHash(code), `${code.slice(0, 5)}…${code.slice(-4)}`, label, packageId, discountPercent, developerTest ? 1 : 0, max, startsAt, expiresAt, clean(actorId, 128) || null]
    );
  } catch (error) {
    if (String(error.code || '').includes('DUP')) throw statusError('That pilot code is already in use', 409, 'DIVEDEEP_PILOT_CODE_EXISTS');
    throw error;
  }
  const [rows] = await p.query('SELECT * FROM divedeep_pilot_codes WHERE id=? LIMIT 1', [id]);
  return { pilotCode: serializePilotCode(rows[0]), code };
}

async function updatePilotCode(codeId, input, actorId, pool = null) {
  const p = pool || getPool();
  const active = bool(input.active);
  const [result] = await p.query(
    'UPDATE divedeep_pilot_codes SET is_active=?,updated_by=?,updated_at=NOW(3) WHERE id=?',
    [active ? 1 : 0, clean(actorId, 128) || null, clean(codeId, 64)]
  );
  if (Number(result.affectedRows) !== 1) throw statusError('Pilot code not found', 404, 'DIVEDEEP_PILOT_CODE_NOT_FOUND');
  const [rows] = await p.query('SELECT * FROM divedeep_pilot_codes WHERE id=? LIMIT 1', [codeId]);
  return serializePilotCode(rows[0]);
}

async function redeemPilotCode(inputCode, selectedPackageId, pool = null) {
  const p = pool || getPool();
  const code = normalizePilotCode(inputCode);
  const [rows] = await p.query('SELECT * FROM divedeep_pilot_codes WHERE code_hash=? LIMIT 1', [pilotCodeHash(code)]);
  const row = rows[0];
  const now = new Date();
  if (!row || !row.is_active || (row.starts_at && new Date(row.starts_at) > now) || (row.expires_at && new Date(row.expires_at) <= now)) {
    throw statusError('Pilot code is invalid or expired', 403, 'DIVEDEEP_PILOT_CODE_INVALID');
  }
  if (row.package_id && row.package_id !== selectedPackageId) throw statusError('This pilot code applies to a different package', 403, 'DIVEDEEP_PILOT_CODE_PACKAGE');
  const [result] = await p.query(
    `UPDATE divedeep_pilot_codes SET redemption_count=redemption_count+1,updated_at=NOW(3)
     WHERE id=? AND is_active=1 AND (starts_at IS NULL OR starts_at<=NOW(3)) AND (expires_at IS NULL OR expires_at>NOW(3))
       AND (max_redemptions IS NULL OR redemption_count<max_redemptions)`,
    [row.id]
  );
  if (Number(result.affectedRows) !== 1) throw statusError('Pilot code has reached its redemption limit', 403, 'DIVEDEEP_PILOT_CODE_LIMIT');
  return serializePilotCode({ ...row, redemption_count: Number(row.redemption_count) + 1 });
}

function serializeCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: decryptPii(row.email_enc),
    firstName: decryptPii(row.first_name_enc),
    lastName: decryptPii(row.last_name_enc),
    displayName: [decryptPii(row.first_name_enc), decryptPii(row.last_name_enc)].filter(Boolean).join(' '),
    planTier: row.plan_tier,
    packagePriceCents: Number(row.package_price_cents) || 0,
    discountPercent: Number(row.discount_percent) || 0,
    pilotCodeId: row.pilot_code_id || null,
    status: row.status,
    workflowStatus: row.workflow_status,
    termsVersion: row.terms_version,
    privacyVersion: row.privacy_version,
    termsAcceptedAt: iso(row.terms_accepted_at),
    authorizationAffirmedAt: iso(row.authorization_affirmed_at),
    noticeVersion: row.notice_version || '',
    noticeAcknowledgedAt: iso(row.notice_acknowledged_at),
    age18AffirmedAt: iso(row.age_18_affirmed_at),
    sensitiveContentConsentAt: iso(row.sensitive_content_consent_at),
    lastLoginAt: iso(row.last_login_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function serializeConnection(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    provider: row.provider,
    connectionMode: row.connection_mode,
    externalUserId: decryptPii(row.external_user_id_enc),
    username: decryptPii(row.username_enc),
    profileUrl: decryptPii(row.profile_url_enc),
    displayName: decryptPii(row.display_name_enc),
    scopes: parseJson(row.scopes_json, []),
    status: row.status,
    metadata: decryptJson(row.metadata_enc, {}),
    tokenExpiresAt: iso(row.token_expires_at),
    connectedAt: iso(row.connected_at),
    disconnectedAt: iso(row.disconnected_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function serializePhoto(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    label: decryptPii(row.label_enc),
    originalName: decryptPii(row.original_name_enc),
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size) || 0,
    sha256: row.sha256,
    purpose: row.purpose,
    status: row.status,
    metadata: decryptJson(row.metadata_enc, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function serializeSocialMediaItem(row) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    itemType: row.item_type,
    externalItemId: decryptPii(row.external_item_id_enc),
    caption: decryptPii(row.caption_enc),
    permalink: decryptPii(row.permalink_enc),
    profilePhotoId: row.profile_photo_id || null,
    selectionStatus: row.selection_status,
    status: row.status,
    publishedAt: iso(row.published_at),
    metadata: decryptJson(row.metadata_enc, {}),
    lastSyncedAt: iso(row.last_synced_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function addCustomerEvent(customerId, eventType, details = {}, actorType = 'customer', actorId = null, pool = null) {
  const p = pool || getPool();
  await p.query(
    `INSERT INTO divedeep_customer_events
      (id,customer_id,event_type,actor_type,actor_id,details_enc)
     VALUES (?,?,?,?,?,?)`,
    [uuid(), customerId, clean(eventType, 96), clean(actorType, 32), clean(actorId, 128) || null, encryptJson(details || {})]
  );
}

async function listCustomerEvents(customerId, limit = 100, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT * FROM divedeep_customer_events WHERE customer_id=? ORDER BY created_at DESC LIMIT ?`,
    [customerId, Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id || '',
    details: decryptJson(row.details_enc, {}),
    createdAt: iso(row.created_at),
  }));
}

async function getCustomerById(customerId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT * FROM divedeep_customers WHERE id=? LIMIT 1`, [customerId]);
  if (!rows[0]) throw statusError('Customer account not found', 404, 'DIVEDEEP_CUSTOMER_NOT_FOUND');
  return serializeCustomer(rows[0]);
}

async function registerCustomer(input, pool = null) {
  const p = pool || getPool();
  const config = getDiveDeepConfig();
  if (!config.signupsEnabled) throw statusError('Pilot registrations are currently closed', 403, 'DIVEDEEP_SIGNUPS_CLOSED');
  const firstName = clean(input.firstName, 120);
  const lastName = clean(input.lastName, 120);
  if (!firstName || !lastName) throw statusError('First and last name are required');
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw statusError('A valid email address is required');
  const password = strongPassword(input.password);
  const plan = validatePlan(input.planTier);
  const packageDefinition = await getPackage(plan, p);
  if (!packageDefinition.active) throw statusError('This package is not currently available', 409, 'DIVEDEEP_PACKAGE_UNAVAILABLE');
  const submittedCode = clean(input.pilotCode || input.inviteCode, 200);
  let pilotCode = null;
  if (submittedCode) pilotCode = await redeemPilotCode(submittedCode, plan, p);
  if (config.inviteCode && !pilotCode && !safeCompare(submittedCode, config.inviteCode)) {
    throw statusError('A valid pilot access code is required', 403, 'DIVEDEEP_INVITE_REQUIRED');
  }
  if (!bool(input.termsAccepted) || !bool(input.noticeAcknowledged)) {
    throw statusError('The Terms and Notice at Collection must be acknowledged', 400, 'DIVEDEEP_CONSENT_REQUIRED');
  }
  if (requiresRestrictedConsent(plan) && (!bool(input.age18Affirmed) || !bool(input.sensitiveContentConsent))) {
    throw statusError('Restricted adult-content services require adult-status and sensitive-content consent', 400, 'DIVEDEEP_SENSITIVE_CONSENT_REQUIRED');
  }
  const id = uuid();
  const hash = emailHash(email);
  const passwordHash = await bcrypt.hash(password, 12);
  const status = config.autoApprove ? 'active' : 'pending';
  const discountPercent = pilotCode ? pilotCode.discountPercent : 0;
  const priceCents = Math.round(packageDefinition.monthlyPriceCents * (1 - (discountPercent / 100)));
  try {
    await p.query(
      `INSERT INTO divedeep_customers
        (id,email_enc,email_hash,password_hash,first_name_enc,last_name_enc,plan_tier,package_price_cents,discount_percent,pilot_code_id,status,workflow_status,
         terms_version,privacy_version,terms_accepted_at,authorization_affirmed_at,notice_version,notice_acknowledged_at,age_18_affirmed_at,
         sensitive_content_consent_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'onboarding',?,?,NOW(3),NULL,?,NOW(3),?,?)`,
      [
        id, encryptPii(email), hash, passwordHash, encryptPii(firstName), encryptPii(lastName), plan, priceCents, discountPercent, pilotCode?.id || null, status,
        config.termsVersion, config.privacyVersion, config.noticeVersion,
        bool(input.age18Affirmed) ? new Date() : null,
        bool(input.sensitiveContentConsent) ? new Date() : null,
      ]
    );
  } catch (error) {
    if (String(error.code || '').includes('DUP')) {
      throw statusError('An account already exists for this email address', 409, 'DIVEDEEP_EMAIL_EXISTS');
    }
    throw error;
  }
  await addCustomerEvent(id, 'account.created', {
    planTier: plan, status, priceCents, discountPercent, pilotCodeId: pilotCode?.id || null,
    developerTest: Boolean(pilotCode?.developerTest), termsVersion: config.termsVersion,
    privacyVersion: config.privacyVersion, noticeVersion: config.noticeVersion,
  }, 'customer', id, p);
  return getCustomerById(id, p);
}

async function authenticateCustomer(emailInput, passwordInput, pool = null) {
  const p = pool || getPool();
  const email = normalizeEmail(emailInput);
  const [rows] = await p.query(`SELECT * FROM divedeep_customers WHERE email_hash=? LIMIT 1`, [emailHash(email)]);
  const row = rows[0];
  const valid = row ? await bcrypt.compare(String(passwordInput || ''), row.password_hash) : false;
  if (!valid || row.status === 'closed') throw statusError('Invalid email or password', 401, 'DIVEDEEP_LOGIN_FAILED');
  await p.query(`UPDATE divedeep_customers SET last_login_at=NOW(3) WHERE id=?`, [row.id]);
  await addCustomerEvent(row.id, 'account.login', {}, 'customer', row.id, p);
  return getCustomerById(row.id, p);
}

function dedupeIdentifiers(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const type = clean(item.type, 32).toLowerCase();
    const value = clean(item.value, 2048);
    if (!type || !value) continue;
    const key = `${type}:${normalizeIdentifier(type, value)}`;
    if (!normalizeIdentifier(type, value) || seen.has(key)) continue;
    seen.add(key);
    result.push({ type, value, label: clean(item.label, 128), isPrimary: bool(item.isPrimary) });
  }
  return result;
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

async function primaryProfile(customerId, pool = null) {
  const profiles = await listProtectedProfiles(customerId, { limit: 10 }, pool || getPool());
  return profiles[0] || null;
}

async function completeOnboarding(customerId, input, pool = null) {
  const p = pool || getPool();
  const customer = await getCustomerById(customerId, p);
  const formalAuthorization = await diveDeepAuthorizations.requireActiveAuthorization(customerId, p);
  const existing = await primaryProfile(customerId, p);
  if (existing) throw statusError('Protected profile has already been created', 409, 'DIVEDEEP_PROFILE_EXISTS');
  const plan = validatePlan(input.planTier || customer.planTier);
  if (requiresRestrictedConsent(plan) && (!customer.age18AffirmedAt || !customer.sensitiveContentConsentAt)) {
    throw statusError('Restricted adult-content consent is incomplete', 409, 'DIVEDEEP_SENSITIVE_CONSENT_REQUIRED');
  }
  const fullName = clean(input.legalName || customer.displayName, 255);
  if (!fullName) throw statusError('Legal name is required');
  const identifiers = dedupeIdentifiers([
    { type: 'name', value: fullName, label: 'Legal name', isPrimary: true },
    { type: 'email', value: customer.email, label: 'Account email', isPrimary: true },
    ...listValues(input.aliases).map((value) => ({ type: 'alias', value, label: 'Alias' })),
    ...listValues(input.emails).map((value) => ({ type: 'email', value, label: 'Additional email' })),
    ...listValues(input.phones).map((value) => ({ type: 'phone', value, label: 'Phone' })),
    ...listValues(input.addresses).map((value) => ({ type: 'address', value, label: 'Address history' })),
    ...listValues(input.usernames).map((value) => ({ type: 'username', value, label: 'Known username' })),
    ...listValues(input.domains).map((value) => ({ type: 'domain', value, label: 'Owned domain' })),
  ]);
  const profile = await createProtectedProfile({
    displayName: fullName,
    requesterName: customer.displayName,
    requesterEmail: customer.email,
    authorizationAffirmed: true,
    authorizationType: 'self',
    authorizationScope: {
      purpose: 'privacy discovery, removal requests, and ongoing monitoring',
      serviceLevel: plan,
      customerId,
      formalAuthorizationId: formalAuthorization.id,
      formalAuthorizationVersion: formalAuthorization.authorizationVersion,
      formalAuthorizationSignedAt: formalAuthorization.signedAt,
      formalAuthorizationExpiresAt: formalAuthorization.expiresAt,
    },
    statementVersion: getDiveDeepConfig().authorizationVersion,
    jurisdictionCountry: clean(input.jurisdictionCountry || 'US', 64),
    jurisdictionRegion: clean(input.jurisdictionRegion, 128),
    scanCadenceDays: plan === 'standard' ? 60 : 30,
    defaultVisibilityAction: clean(input.defaultVisibilityAction || 'remove', 32),
    identifiers,
  }, customerId, `customer:${customerId}`, p);

  for (const domain of listValues(input.preserveDomains)) {
    await upsertVisibilityPolicy(customerId, profile.id, {
      scopeType: 'domain', scopeValue: domain, action: 'preserve', priority: 100,
    }, `customer:${customerId}`, p);
  }
  for (const connection of asArray(input.connections, 30)) {
    if (connection && (connection.username || connection.profileUrl)) {
      await createSocialConnection(customerId, profile.id, connection, `customer:${customerId}`, p);
    }
  }
  await p.query(
    `UPDATE divedeep_customers SET plan_tier=?,workflow_status='intake_ready',updated_at=NOW(3) WHERE id=?`,
    [plan, customerId]
  );
  await addCustomerEvent(customerId, 'profile.intake_completed', {
    profileId: profile.id,
    identifierCount: identifiers.length,
    planTier: plan,
  }, 'customer', customerId, p);
  return getCustomerDashboard(customerId, p);
}

async function addIdentifier(customerId, input, pool = null) {
  const p = pool || getPool();
  const profile = await primaryProfile(customerId, p);
  if (!profile) throw statusError('Complete profile onboarding first', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  const identifier = await addProfileIdentifier(customerId, profile.id, input, `customer:${customerId}`, p);
  await addCustomerEvent(customerId, 'profile.identifier_added', { type: input.type }, 'customer', customerId, p);
  return identifier;
}

async function setVisibilityPolicy(customerId, input, pool = null) {
  const p = pool || getPool();
  const profile = await primaryProfile(customerId, p);
  if (!profile) throw statusError('Complete profile onboarding first', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  const policy = await upsertVisibilityPolicy(customerId, profile.id, input, `customer:${customerId}`, p);
  await addCustomerEvent(customerId, 'profile.visibility_policy_updated', {
    scopeType: policy.scopeType, scopeValue: policy.scopeValue, action: policy.action,
  }, 'customer', customerId, p);
  return policy;
}

async function createSocialConnection(customerId, profileId, input, actorId = null, pool = null) {
  const p = pool || getPool();
  const provider = clean(input.provider || 'other', 32).toLowerCase();
  if (!SOCIAL_PROVIDERS.has(provider)) throw statusError('Unsupported social provider');
  const username = clean(input.username, 255).replace(/^@/, '');
  const profileUrl = input.profileUrl ? normalizeUrl(input.profileUrl, 'Profile URL') : '';
  const externalUserId = clean(input.externalUserId, 255);
  if (!username && !profileUrl && !externalUserId) throw statusError('Username or profile URL is required');
  const connectionMode = clean(input.connectionMode || 'manual', 16);
  if (!['manual', 'oauth'].includes(connectionMode)) throw statusError('Invalid connection mode');
  const id = uuid();
  const usernameHash = username ? blindIndex(customerId, 'username', `${provider}:${username}`) : null;
  const externalHash = externalUserId ? blindIndex(customerId, 'other', `${provider}:${externalUserId}`) : null;
  try {
    await p.query(
      `INSERT INTO divedeep_social_connections
        (id,customer_id,profile_id,provider,connection_mode,external_user_id_enc,external_user_id_hash,
         username_enc,username_hash,profile_url_enc,display_name_enc,scopes_json,access_token_enc,
         refresh_token_enc,token_expires_at,metadata_enc,status,connected_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(3))`,
      [
        id, customerId, profileId, provider, connectionMode,
        encryptPii(externalUserId), externalHash, encryptPii(username), usernameHash,
        encryptPii(profileUrl), encryptPii(clean(input.displayName, 255)), JSON.stringify(asArray(input.scopes, 50)),
        encryptPii(clean(input.accessToken, 8192)), encryptPii(clean(input.refreshToken, 8192)),
        input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null, encryptJson(input.metadata || {}),
        clean(input.status || 'connected', 24),
      ]
    );
  } catch (error) {
    if (String(error.code || '').includes('DUP')) throw statusError('This social profile is already connected', 409, 'DIVEDEEP_CONNECTION_EXISTS');
    throw error;
  }
  await addCustomerEvent(customerId, 'social.connection_added', { provider, connectionId: id }, actorId ? 'system' : 'customer', actorId || customerId, p);
  return getSocialConnection(customerId, id, p);
}

async function getSocialConnection(customerId, connectionId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT * FROM divedeep_social_connections WHERE id=? AND customer_id=? LIMIT 1`, [connectionId, customerId]);
  if (!rows[0]) throw statusError('Social connection not found', 404, 'DIVEDEEP_CONNECTION_NOT_FOUND');
  return serializeConnection(rows[0]);
}

async function listSocialConnections(customerId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT * FROM divedeep_social_connections WHERE customer_id=? AND status<>'deleted' ORDER BY updated_at DESC`,
    [customerId]
  );
  const connections = rows.map(serializeConnection);
  const profile = await primaryProfile(customerId, p);
  if (!profile) return connections;
  const [policyRows] = await p.query(
    `SELECT scope_value,action FROM divedeep_visibility_policies
     WHERE tenant_id=? AND profile_id=? AND scope_type='profile_url'`,
    [customerId, profile.id]
  );
  const protectedKeys = new Set(policyRows
    .filter((item) => ['preserve', 'ignore'].includes(item.action))
    .map((item) => item.scope_value));
  return connections.map((connection) => {
    let protectedFromRemoval = false;
    try { protectedFromRemoval = Boolean(connection.profileUrl && protectedKeys.has(profileUrlKey(connection.profileUrl))); }
    catch { protectedFromRemoval = false; }
    return { ...connection, protectedFromRemoval };
  });
}

async function setSocialConnectionProtection(customerId, connectionId, protectInput, pool = null) {
  const p = pool || getPool();
  const connection = await getSocialConnection(customerId, connectionId, p);
  if (!connection.profileUrl) throw statusError('This connected account does not have a profile URL to protect');
  const profile = await primaryProfile(customerId, p);
  if (!profile) throw statusError('Complete profile onboarding first', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  const protect = bool(protectInput);
  const policy = await upsertVisibilityPolicy(customerId, profile.id, {
    scopeType: 'profile_url',
    scopeValue: connection.profileUrl,
    action: protect ? 'preserve' : 'review',
    priority: 1000,
  }, `customer:${customerId}`, p);
  const protectedKey = profileUrlKey(connection.profileUrl);
  const [exposureRows] = await p.query(
    `SELECT id,listing_url,status FROM divedeep_exposures WHERE tenant_id=? AND profile_id=?`,
    [customerId, profile.id]
  );
  const matchedExposureIds = exposureRows.filter((item) => {
    try {
      const listingKey = profileUrlKey(item.listing_url);
      return listingKey === protectedKey || listingKey.startsWith(`${protectedKey.replace(/\/+$/, '')}/`);
    } catch { return false; }
  }).map((item) => item.id);
  let withdrawnCases = 0;
  for (const exposureId of matchedExposureIds) {
    if (protect) {
      await p.query(
        `UPDATE divedeep_exposures SET visibility_action='preserve',
         status=CASE WHEN status IN ('open','review','confirmed','reappeared') THEN 'preserved' ELSE status END,
         updated_at=NOW(3) WHERE id=? AND tenant_id=?`,
        [exposureId, customerId]
      );
      const [pendingCases] = await p.query(
        `SELECT id FROM divedeep_cases
         WHERE tenant_id=? AND exposure_id=? AND state IN ('draft','approved','queued')`,
        [customerId, exposureId]
      );
      for (const pendingCase of pendingCases) {
        await transitionCase(customerId, pendingCase.id, {
          state: 'withdrawn',
          notes: 'Automatically withdrawn because the customer protected an owned social account.',
        }, `customer:${customerId}`, p);
        withdrawnCases += 1;
      }
    } else {
      await p.query(
        `UPDATE divedeep_exposures SET visibility_action='review',
         status=CASE WHEN status='preserved' THEN 'review' ELSE status END,
         updated_at=NOW(3) WHERE id=? AND tenant_id=?`,
        [exposureId, customerId]
      );
    }
  }
  await addCustomerEvent(customerId, protect ? 'social.account_protected' : 'social.account_protection_removed', {
    connectionId,
    provider: connection.provider,
    policyId: policy.id,
    matchedExposures: matchedExposureIds.length,
    withdrawnPendingCases: withdrawnCases,
  }, 'customer', customerId, p);
  return {
    connection: { ...connection, protectedFromRemoval: protect },
    policy,
    matchedExposures: matchedExposureIds.length,
    withdrawnPendingCases: withdrawnCases,
  };
}

async function disconnectSocialConnection(customerId, connectionId, pool = null) {
  const p = pool || getPool();
  const connection = await getSocialConnection(customerId, connectionId, p);
  await p.query(
    `UPDATE divedeep_social_connections SET status='disconnected',access_token_enc=NULL,refresh_token_enc=NULL,
      disconnected_at=NOW(3),updated_at=NOW(3) WHERE id=? AND customer_id=?`,
    [connectionId, customerId]
  );
  await addCustomerEvent(customerId, 'social.connection_disconnected', {
    connectionId, provider: connection.provider,
  }, 'customer', customerId, p);
  return getSocialConnection(customerId, connectionId, p);
}

async function getFacebookConnectionCredentials(customerId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT id,external_user_id_enc,access_token_enc,scopes_json,token_expires_at,status
     FROM divedeep_social_connections WHERE customer_id=? AND provider='facebook' AND connection_mode='oauth'
     ORDER BY updated_at DESC LIMIT 1`,
    [customerId]
  );
  const row = rows[0];
  const externalUserId = row ? decryptPii(row.external_user_id_enc) : '';
  const accessToken = row ? decryptPii(row.access_token_enc) : '';
  if (!row || row.status !== 'connected' || !externalUserId || !accessToken) {
    throw statusError('Connect Facebook before selecting album photos', 409, 'DIVEDEEP_FACEBOOK_CONNECTION_REQUIRED');
  }
  if (row.token_expires_at && new Date(row.token_expires_at).getTime() <= Date.now()) {
    throw statusError('Reconnect Facebook to refresh its permission', 409, 'DIVEDEEP_FACEBOOK_RECONNECT_REQUIRED');
  }
  return {
    connectionId: row.id,
    externalUserId,
    accessToken,
    scopes: parseJson(row.scopes_json, []),
  };
}

async function syncSocialMediaItems(customerId, connectionId, providerInput, itemsInput, pool = null) {
  const p = pool || getPool();
  const provider = clean(providerInput, 32).toLowerCase();
  if (!['facebook', 'instagram'].includes(provider)) throw statusError('Unsupported social media catalog provider');
  const connection = await getSocialConnection(customerId, connectionId, p);
  if (connection.provider !== 'facebook' || connection.connectionMode !== 'oauth' || connection.status !== 'connected') {
    throw statusError('An active Meta connection is required', 409, 'DIVEDEEP_META_CONNECTION_REQUIRED');
  }
  const items = asArray(itemsInput, 500);
  let synchronized = 0;
  for (const input of items) {
    const externalItemId = clean(input?.externalItemId, 255);
    const itemType = clean(input?.itemType, 32).toLowerCase();
    if (!externalItemId || !['image', 'post', 'video', 'carousel'].includes(itemType)) continue;
    const itemHash = blindIndex(customerId, 'other', `${provider}:media:${externalItemId}`);
    await p.query(
      `INSERT INTO divedeep_social_media_items
        (id,customer_id,connection_id,provider,item_type,external_item_id_enc,external_item_id_hash,
         caption_enc,permalink_enc,published_at,metadata_enc,last_synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(3))
       ON DUPLICATE KEY UPDATE connection_id=VALUES(connection_id),item_type=VALUES(item_type),
         caption_enc=VALUES(caption_enc),permalink_enc=VALUES(permalink_enc),
         published_at=VALUES(published_at),metadata_enc=VALUES(metadata_enc),
         status='active',last_synced_at=NOW(3),updated_at=NOW(3)`,
      [
        uuid(), customerId, connectionId, provider, itemType,
        encryptPii(externalItemId), itemHash,
        encryptPii(clean(input.caption, 5000)), encryptPii(clean(input.permalink, 2048)),
        input.publishedAt ? new Date(input.publishedAt) : null,
        encryptJson(input.metadata || {}),
      ]
    );
    synchronized += 1;
  }
  await addCustomerEvent(customerId, 'social.media_synchronized', {
    provider, connectionId, itemCount: synchronized,
  }, 'system', 'meta-sync', p);
  return { provider, synchronized };
}

async function listSocialMediaItems(customerId, options = {}, pool = null) {
  const p = pool || getPool();
  const params = [customerId];
  const where = ["customer_id=?", "status='active'"];
  const provider = clean(options.provider, 32).toLowerCase();
  const itemType = clean(options.itemType, 32).toLowerCase();
  if (provider) { where.push('provider=?'); params.push(provider); }
  if (itemType) { where.push('item_type=?'); params.push(itemType); }
  params.push(Math.min(Math.max(Number(options.limit) || 200, 1), 500));
  const [rows] = await p.query(
    `SELECT * FROM divedeep_social_media_items WHERE ${where.join(' AND ')}
     ORDER BY published_at DESC,updated_at DESC LIMIT ?`,
    params
  );
  return rows.map(serializeSocialMediaItem);
}

async function markSocialMediaWhitelisted(customerId, providerInput, externalItemIdInput, photoId, pool = null) {
  const p = pool || getPool();
  const provider = clean(providerInput, 32).toLowerCase();
  const externalItemId = clean(externalItemIdInput, 255);
  const itemHash = blindIndex(customerId, 'other', `${provider}:media:${externalItemId}`);
  await p.query(
    `UPDATE divedeep_social_media_items SET selection_status='whitelisted',profile_photo_id=?,updated_at=NOW(3)
     WHERE customer_id=? AND provider=? AND external_item_id_hash=?`,
    [photoId, customerId, provider, itemHash]
  );
}

async function requestFirstScrub(customerId, pool = null) {
  const p = pool || getPool();
  await diveDeepAuthorizations.requireActiveAuthorization(customerId, p);
  const profile = await primaryProfile(customerId, p);
  if (!profile) throw statusError('Create your discovery profile first', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  await p.query(`UPDATE divedeep_customers SET workflow_status='intake_ready',updated_at=NOW(3) WHERE id=?`, [customerId]);
  await addCustomerEvent(customerId, 'profile.first_scrub_requested', { profileId: profile.id }, 'customer', customerId, p);
  return getCustomerDashboard(customerId, p);
}

async function saveFacebookConnection(customerId, payload, pool = null) {
  const p = pool || getPool();
  const profile = await primaryProfile(customerId, p);
  if (!profile) throw statusError('Complete profile onboarding before connecting Facebook', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  const [rows] = await p.query(
    `SELECT id FROM divedeep_social_connections WHERE customer_id=? AND provider='facebook' AND external_user_id_hash=? LIMIT 1`,
    [customerId, blindIndex(customerId, 'other', `facebook:${payload.id}`)]
  );
  if (rows[0]) {
    await p.query(
      `UPDATE divedeep_social_connections SET connection_mode='oauth',display_name_enc=?,profile_url_enc=?,scopes_json=?,
       access_token_enc=?,token_expires_at=?,metadata_enc=?,status='connected',connected_at=NOW(3),disconnected_at=NULL,updated_at=NOW(3)
       WHERE id=? AND customer_id=?`,
      [encryptPii(clean(payload.name, 255)), encryptPii(clean(payload.link, 2048)), JSON.stringify(payload.scopes || []),
        encryptPii(clean(payload.accessToken, 8192)), payload.tokenExpiresAt ? new Date(payload.tokenExpiresAt) : null,
        encryptJson(payload.metadata || {}), rows[0].id, customerId]
    );
    await addCustomerEvent(customerId, 'social.facebook_reconnected', { connectionId: rows[0].id }, 'system', 'meta-oauth', p);
    return getSocialConnection(customerId, rows[0].id, p);
  }
  return createSocialConnection(customerId, profile.id, {
    provider: 'facebook', connectionMode: 'oauth', externalUserId: payload.id,
    displayName: payload.name, profileUrl: payload.link, scopes: payload.scopes,
    accessToken: payload.accessToken, tokenExpiresAt: payload.tokenExpiresAt,
    metadata: payload.metadata || {}, status: 'connected',
  }, 'meta-oauth', p);
}

async function saveInstagramConnection(customerId, payload, pool = null) {
  const p = pool || getPool();
  const profile = await primaryProfile(customerId, p);
  if (!profile) throw statusError('Complete profile onboarding before connecting Instagram', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  const externalId = clean(payload.id, 255);
  const username = clean(payload.username, 255).replace(/^@/, '');
  if (!externalId || !username) throw statusError('Instagram account identity is incomplete');
  const externalHash = blindIndex(customerId, 'other', `instagram:${externalId}`);
  const [rows] = await p.query(
    `SELECT id FROM divedeep_social_connections
     WHERE customer_id=? AND provider='instagram' AND external_user_id_hash=? LIMIT 1`,
    [customerId, externalHash]
  );
  const profileUrl = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  if (rows[0]) {
    await p.query(
      `UPDATE divedeep_social_connections SET connection_mode='oauth',username_enc=?,username_hash=?,
       display_name_enc=?,profile_url_enc=?,metadata_enc=?,status='connected',connected_at=NOW(3),
       disconnected_at=NULL,updated_at=NOW(3) WHERE id=? AND customer_id=?`,
      [
        encryptPii(username), blindIndex(customerId, 'username', `instagram:${username}`),
        encryptPii(username), encryptPii(profileUrl),
        encryptJson({ linkedThrough: 'facebook_page', pageId: clean(payload.pageId, 255) || null }),
        rows[0].id, customerId,
      ]
    );
    return getSocialConnection(customerId, rows[0].id, p);
  }
  return createSocialConnection(customerId, profile.id, {
    provider: 'instagram',
    connectionMode: 'oauth',
    externalUserId: externalId,
    username,
    displayName: username,
    profileUrl,
    scopes: payload.scopes || [],
    metadata: { linkedThrough: 'facebook_page', pageId: clean(payload.pageId, 255) || null },
    status: 'connected',
  }, 'meta-oauth', p);
}

async function addProfilePhoto(customerId, file, input = {}, pool = null) {
  const p = pool || getPool();
  const profile = await primaryProfile(customerId, p);
  if (!profile) throw statusError('Complete profile onboarding first', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) throw statusError('Image file is required');
  const purpose = clean(input.purpose || 'identity_search', 32);
  if (!PHOTO_PURPOSES.has(purpose)) throw statusError('Invalid photo purpose');
  if (purpose === 'sensitive_search') {
    const customer = await getCustomerById(customerId, p);
    if (!requiresRestrictedConsent(customer.planTier) || !customer.sensitiveContentConsentAt) {
      throw statusError('Sensitive-search photos require restricted-content consent', 409, 'DIVEDEEP_SENSITIVE_CONSENT_REQUIRED');
    }
  }
  const photoId = uuid();
  const storageRef = writeEncryptedPhoto(customerId, photoId, file.buffer);
  try {
    await p.query(
      `INSERT INTO divedeep_profile_photos
        (id,customer_id,profile_id,label_enc,original_name_enc,mime_type,byte_size,sha256,storage_ref,purpose,status,metadata_enc)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'active',?)`,
      [photoId, customerId, profile.id, encryptPii(clean(input.label || 'Reference photo', 255)),
        encryptPii(clean(input.originalName || 'profile-image', 255)), file.mimeType, file.buffer.length,
        sha256Buffer(file.buffer), storageRef, purpose, encryptJson({ source: 'customer_upload' })]
    );
  } catch (error) {
    deleteEncryptedPhoto(storageRef);
    throw error;
  }
  await addCustomerEvent(customerId, 'profile.photo_uploaded', { photoId, purpose }, 'customer', customerId, p);
  return getProfilePhoto(customerId, photoId, p);
}

async function getProfilePhoto(customerId, photoId, pool = null, includeStorage = false) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT * FROM divedeep_profile_photos WHERE id=? AND customer_id=? LIMIT 1`, [photoId, customerId]);
  if (!rows[0]) throw statusError('Profile photo not found', 404, 'DIVEDEEP_PHOTO_NOT_FOUND');
  const result = serializePhoto(rows[0]);
  if (includeStorage) result.storageRef = rows[0].storage_ref;
  return result;
}

async function listProfilePhotos(customerId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT * FROM divedeep_profile_photos WHERE customer_id=? AND status='active' ORDER BY created_at DESC`, [customerId]);
  return rows.map(serializePhoto);
}

async function readProfilePhoto(customerId, photoId, pool = null) {
  const photo = await getProfilePhoto(customerId, photoId, pool, true);
  return { photo, buffer: readEncryptedPhoto(photo.storageRef) };
}

async function removeProfilePhoto(customerId, photoId, pool = null) {
  const p = pool || getPool();
  const photo = await getProfilePhoto(customerId, photoId, p, true);
  await p.query(`UPDATE divedeep_profile_photos SET status='deleted',updated_at=NOW(3) WHERE id=? AND customer_id=?`, [photoId, customerId]);
  deleteEncryptedPhoto(photo.storageRef);
  await addCustomerEvent(customerId, 'profile.photo_deleted', { photoId }, 'customer', customerId, p);
  return { ok: true };
}

function customerFindingPageSize(value) {
  return Math.min(Math.max(Number(value) || 20, 5), 50);
}

async function getCustomerFindingPage(customerId, input = {}, pool = null) {
  const p = pool || getPool();
  const profileId = clean(input.profileId, 64);
  const profile = profileId ? { id: profileId } : await primaryProfile(customerId, p);
  const pageSize = customerFindingPageSize(input.pageSize);
  if (!profile) {
    return {
      exposures: [],
      evidenceFiles: [],
      pagination: { page: 1, pageSize, pageCount: 1, total: 0, hasPrevious: false, hasNext: false },
    };
  }
  const [[countRow]] = await p.query(
    `SELECT COUNT(*) total FROM divedeep_exposures
     WHERE tenant_id=? AND profile_id=? AND publication_status='published'`,
    [customerId, profile.id]
  );
  const total = Number(countRow?.total) || 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = Math.max(Number(input.page) || 1, 1);
  const page = Math.min(requestedPage, pageCount);
  const exposures = await listExposures(customerId, {
    profileId: profile.id,
    publicationStatus: 'published',
    limit: pageSize,
    offset: (page - 1) * pageSize,
  }, p);
  const evidenceFiles = await require('./diveDeepImports').listEvidenceFiles(customerId, {
    includeUnpublished: false,
    exposureIds: exposures.map((item) => item.id),
    limit: Math.min(500, pageSize * 12),
  }, p);
  return {
    exposures,
    evidenceFiles,
    pagination: {
      page,
      pageSize,
      pageCount,
      total,
      hasPrevious: page > 1,
      hasNext: page < pageCount,
    },
  };
}

async function getPublishedDashboardStats(customerId, profileId, pool = null) {
  const p = pool || getPool();
  if (!profileId) {
    return {
      found: 0, underReview: 0, stillPresent: 0, removed: 0,
      requestsPrepared: 0, requestsSent: 0, requestsCompleted: 0,
    };
  }
  const [[exposureRows], [caseRows]] = await Promise.all([
    p.query(
      `SELECT
         SUM(status NOT IN ('false_positive','ignored')) found,
         SUM(status IN ('review','open')) under_review,
         SUM(status IN ('confirmed','reappeared')) still_present,
         SUM(status='removed') removed
       FROM divedeep_exposures
       WHERE tenant_id=? AND profile_id=? AND publication_status='published'`,
      [customerId, profileId]
    ),
    p.query(
      `SELECT
         COUNT(*) requests_prepared,
         SUM(privacy_case.state IN ('sent','acknowledged','needs_action','completed','denied')) requests_sent,
         SUM(privacy_case.state='completed') requests_completed
       FROM divedeep_cases privacy_case
       JOIN divedeep_exposures exposure ON exposure.id=privacy_case.exposure_id AND exposure.publication_status='published'
       WHERE privacy_case.tenant_id=? AND privacy_case.profile_id=?`,
      [customerId, profileId]
    ),
  ]);
  const exposure = exposureRows[0] || {};
  const cases = caseRows[0] || {};
  return {
    found: Number(exposure.found) || 0,
    underReview: Number(exposure.under_review) || 0,
    stillPresent: Number(exposure.still_present) || 0,
    removed: Number(exposure.removed) || 0,
    requestsPrepared: Number(cases.requests_prepared) || 0,
    requestsSent: Number(cases.requests_sent) || 0,
    requestsCompleted: Number(cases.requests_completed) || 0,
  };
}

async function getCustomerDashboard(customerId, pool = null, options = {}) {
  const p = pool || getPool();
  const customer = await getCustomerById(customerId, p);
  const profile = await primaryProfile(customerId, p);
  const importService = require('./diveDeepImports');

  const [connections, photos, events, authorization] = await Promise.all([
    listSocialConnections(customerId, p),
    listProfilePhotos(customerId, p),
    listCustomerEvents(customerId, 100, p),
    diveDeepAuthorizations.getLatestAuthorization(customerId, p),
  ]);

  let exposures = [];
  let cases = [];
  let evidenceFiles = [];
  let importBatches = [];
  let findingPagination = { page: 1, pageSize: 20, pageCount: 1, total: 0, hasPrevious: false, hasNext: false };
  let stats = {
    found: 0, underReview: 0, stillPresent: 0, removed: 0,
    requestsPrepared: 0, requestsSent: 0, requestsCompleted: 0,
  };

  if (options.includeUnpublished) {
    [evidenceFiles, importBatches] = await Promise.all([
      importService.listEvidenceFiles(customerId, { includeUnpublished: true }, p),
      importService.listImportBatches(customerId, p),
    ]);
    if (profile) {
      [exposures, cases] = await Promise.all([
        listExposures(customerId, { profileId: profile.id, limit: 500 }, p),
        listCases(customerId, { profileId: profile.id, limit: 500 }, p),
      ]);
    }
    findingPagination = {
      page: 1,
      pageSize: Math.max(exposures.length, 1),
      pageCount: 1,
      total: exposures.length,
      hasPrevious: false,
      hasNext: false,
    };
    stats = {
      found: exposures.filter((item) => !['false_positive', 'ignored'].includes(item.status)).length,
      underReview: exposures.filter((item) => ['review', 'open'].includes(item.status)).length,
      stillPresent: exposures.filter((item) => ['confirmed', 'reappeared'].includes(item.status)).length,
      removed: exposures.filter((item) => item.status === 'removed').length,
      requestsPrepared: cases.length,
      requestsSent: cases.filter((item) => ['sent', 'acknowledged', 'needs_action', 'completed', 'denied'].includes(item.state)).length,
      requestsCompleted: cases.filter((item) => item.state === 'completed').length,
    };
  } else if (profile) {
    const [findingPage, publishedCases, publishedStats] = await Promise.all([
      getCustomerFindingPage(customerId, { page: 1, pageSize: options.findingPageSize || 20, profileId: profile.id }, p),
      listCases(customerId, { profileId: profile.id, publishedOnly: true, limit: 100 }, p),
      getPublishedDashboardStats(customerId, profile.id, p),
    ]);
    exposures = findingPage.exposures;
    evidenceFiles = findingPage.evidenceFiles;
    findingPagination = findingPage.pagination;
    cases = publishedCases;
    stats = publishedStats;
  }

  const visibleEvents = options.includeUnpublished ? events : events.filter((event) => {
    if (event.eventType === 'admin.segmented_import_ready') return false;
    if (event.eventType === 'admin.finding_publication_changed') return false;
    return true;
  });

  return {
    customer,
    authorization,
    profile,
    connections,
    photos,
    exposures,
    cases,
    events: visibleEvents,
    stats,
    evidenceFiles,
    importBatches,
    findingPagination,
  };
}

async function updateCustomerPlan(customerId, input, pool = null) {
  const p = pool || getPool();
  const current = await getCustomerById(customerId, p);
  const plan = validatePlan(input.planTier);
  if (requiresRestrictedConsent(plan) && (!bool(input.age18Affirmed) || !bool(input.sensitiveContentConsent))) {
    throw statusError('Restricted adult-content services require adult-status and sensitive-content consent', 400, 'DIVEDEEP_SENSITIVE_CONSENT_REQUIRED');
  }
  await p.query(
    `UPDATE divedeep_customers SET plan_tier=?,age_18_affirmed_at=CASE WHEN ? THEN COALESCE(age_18_affirmed_at,NOW(3)) ELSE age_18_affirmed_at END,
     sensitive_content_consent_at=CASE WHEN ? THEN COALESCE(sensitive_content_consent_at,NOW(3)) ELSE sensitive_content_consent_at END,
     updated_at=NOW(3) WHERE id=?`,
    [plan, bool(input.age18Affirmed) ? 1 : 0, bool(input.sensitiveContentConsent) ? 1 : 0, customerId]
  );
  await addCustomerEvent(customerId, 'account.plan_changed', { from: current.planTier, to: plan }, 'customer', customerId, p);
  return getCustomerById(customerId, p);
}

async function getAdminOverview(pool = null) {
  const p = pool || getPool();
  const [[summaryRows], [workflowRows], [caseRows]] = await Promise.all([
    p.query(`SELECT
      (SELECT COUNT(*) FROM divedeep_customers WHERE status='active') active_customers,
      (SELECT COUNT(*) FROM divedeep_customers WHERE workflow_status='intake_ready') profiles_ready,
      (SELECT COUNT(*) FROM divedeep_exposures WHERE status IN ('open','review')) pending_findings,
      (SELECT COUNT(*) FROM divedeep_cases WHERE state IN ('sent','acknowledged','needs_action','completed','denied')) requests_sent,
      (SELECT COUNT(*) FROM divedeep_exposures WHERE status='removed') confirmed_removed,
      (SELECT COUNT(*) FROM divedeep_exposures WHERE status IN ('confirmed','reappeared')) still_present,
      (SELECT COUNT(*) FROM divedeep_customer_events WHERE event_type='admin.packet_exported') total_exports,
      (SELECT COUNT(*) FROM divedeep_customer_events WHERE event_type='admin.packet_exported'
        AND created_at >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01')) month_exports,
      (SELECT MAX(created_at) FROM divedeep_customer_events WHERE event_type='admin.packet_exported') last_export_at`),
    p.query(`SELECT workflow_status status,COUNT(*) count FROM divedeep_customers GROUP BY workflow_status`),
    p.query(`SELECT state,COUNT(*) count FROM divedeep_cases GROUP BY state`),
  ]);
  const row = summaryRows[0] || {};
  const metrics = {
    activeCustomers: Number(row.active_customers) || 0,
    profilesReady: Number(row.profiles_ready) || 0,
    pendingFindings: Number(row.pending_findings) || 0,
    requestsSent: Number(row.requests_sent) || 0,
    confirmedRemoved: Number(row.confirmed_removed) || 0,
    stillPresent: Number(row.still_present) || 0,
  };
  const workflow = Object.fromEntries(workflowRows.map((item) => [item.status, Number(item.count) || 0]));
  const cases = Object.fromEntries(caseRows.map((item) => [item.state, Number(item.count) || 0]));
  const removed = metrics.confirmedRemoved;
  const stillPresent = metrics.stillPresent;
  return {
    metrics,
    workflow,
    cases,
    exports: {
      total: Number(row.total_exports) || 0,
      thisMonth: Number(row.month_exports) || 0,
      lastExportAt: iso(row.last_export_at),
      successRate: removed + stillPresent ? Math.round((removed / (removed + stillPresent)) * 1000) / 10 : 0,
    },
  };
}

async function listCustomers(options = {}, pool = null) {
  const p = pool || getPool();
  const params = [];
  const where = [];
  if (options.status && CUSTOMER_STATUSES.has(options.status)) { where.push('c.status=?'); params.push(options.status); }
  if (options.planTier && PLAN_TIERS.has(options.planTier)) { where.push('c.plan_tier=?'); params.push(options.planTier); }
  if (options.workflowStatus && WORKFLOW_STATUSES.has(options.workflowStatus)) { where.push('c.workflow_status=?'); params.push(options.workflowStatus); }
  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 500);
  params.push(limit);
  const [rows] = await p.query(
    `SELECT c.*,
      (SELECT COUNT(*) FROM divedeep_protected_profiles p2 WHERE p2.tenant_id=c.id AND p2.status<>'deleted') profile_count,
      (SELECT COUNT(*) FROM divedeep_exposures e WHERE e.tenant_id=c.id) exposure_count,
      (SELECT COUNT(*) FROM divedeep_cases nc WHERE nc.tenant_id=c.id) case_count
     FROM divedeep_customers c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.updated_at DESC LIMIT ?`,
    params
  );
  const query = clean(options.query, 255).toLowerCase();
  return rows.map((row) => ({
    ...serializeCustomer(row),
    profileCount: Number(row.profile_count) || 0,
    exposureCount: Number(row.exposure_count) || 0,
    caseCount: Number(row.case_count) || 0,
  })).filter((item) => !query || `${item.displayName} ${item.email}`.toLowerCase().includes(query));
}

async function adminUpdateCustomer(customerId, input, actorId, pool = null) {
  const p = pool || getPool();
  const current = await getCustomerById(customerId, p);
  const status = input.status ? clean(input.status, 24) : current.status;
  const workflowStatus = input.workflowStatus ? clean(input.workflowStatus, 32) : current.workflowStatus;
  const planTier = input.planTier ? validatePlan(input.planTier) : current.planTier;
  if (!CUSTOMER_STATUSES.has(status)) throw statusError('Invalid customer status');
  if (!WORKFLOW_STATUSES.has(workflowStatus)) throw statusError('Invalid workflow status');
  if (requiresRestrictedConsent(planTier) && !current.sensitiveContentConsentAt) {
    throw statusError("Restricted adult-content tiers cannot be assigned without the customer's sensitive-content consent", 409, 'DIVEDEEP_SENSITIVE_CONSENT_REQUIRED');
  }
  await p.query(
    `UPDATE divedeep_customers SET status=?,workflow_status=?,plan_tier=?,updated_at=NOW(3) WHERE id=?`,
    [status, workflowStatus, planTier, customerId]
  );
  await addCustomerEvent(customerId, 'admin.customer_updated', {
    status, workflowStatus, planTier, note: clean(input.note, 2000),
  }, 'admin', actorId, p);
  return getCustomerById(customerId, p);
}

async function adminAddFinding(customerId, input, actorId, pool = null, options = {}) {
  const p = pool || getPool();
  const profile = await primaryProfile(customerId, p);
  if (!profile) throw statusError('Customer has not completed onboarding', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  const customer = await getCustomerById(customerId, p);
  const category = clean(input.contentCategory || 'standard', 64).toLowerCase();
  if ((category.includes('adult') || category.includes('sensitive')) &&
      (!requiresRestrictedConsent(customer.planTier) || !customer.sensitiveContentConsentAt)) {
    throw statusError('Sensitive findings require customer restricted-content consent', 409, 'DIVEDEEP_SENSITIVE_CONSENT_REQUIRED');
  }
  let exposure = await upsertExposure(customerId, profile.id, {
    sourceName: input.sourceName,
    listingUrl: input.listingUrl,
    listingIdentifier: input.listingIdentifier,
    subjectIdentifier: input.subjectIdentifier,
    matchConfidence: Number(input.matchConfidence) || 0,
    contentCategory: category,
    publicationStatus: clean(input.publicationStatus, 16),
    evidenceRef: clean(input.evidenceRef, 1024),
    evidenceSha256: clean(input.evidenceSha256, 64),
    metadata: { ...(input.metadata || {}), enteredBy: 'divedeep-admin', notes: clean(input.notes, 3000) },
  }, `admin:${actorId}`, p);
  if (bool(input.confirmed)) {
    exposure = await updateExposureStatus(customerId, exposure.id, 'confirmed', `admin:${actorId}`, p);
  }
  let privacyCase = null;
  if (bool(input.createCase)) {
    await diveDeepAuthorizations.requireActiveAuthorization(customerId, p);
    if (exposure.status !== 'confirmed') exposure = await updateExposureStatus(customerId, exposure.id, 'confirmed', `admin:${actorId}`, p);
    privacyCase = await createCaseFromExposure(customerId, exposure.id, {
      reviewApproved: true,
      recipientEmail: input.recipientEmail,
      deliveryMethod: input.deliveryMethod,
      templateKey: input.templateKey,
      requestActions: input.requestActions,
      notes: input.notes,
      idempotencyKey: clean(input.idempotencyKey, 191),
    }, `admin:${actorId}`, p);
  }
  if (!options.deferWorkflow) {
    await p.query(`UPDATE divedeep_customers SET workflow_status='results_ready',updated_at=NOW(3) WHERE id=?`, [customerId]);
  }
  if (!options.suppressEvent) {
    await addCustomerEvent(customerId, 'admin.finding_added', {
      exposureId: exposure.id, caseId: privacyCase?.id || null, sourceName: exposure.sourceName,
    }, 'admin', actorId, p);
  }
  return { exposure, case: privacyCase };
}

async function adminUpdateFinding(customerId, exposureId, input, actorId, pool = null, options = {}) {
  const p = pool || getPool();
  const status = clean(input.status, 32).toLowerCase();
  const allowed = new Set(['review', 'confirmed', 'preserved', 'ignored', 'false_positive', 'removed', 'reappeared']);
  if (!allowed.has(status)) throw statusError('Invalid finding status');
  const exposures = await listExposures(customerId, { limit: 500 }, p);
  if (!exposures.some((item) => item.id === exposureId)) {
    throw statusError('Finding not found', 404, 'DIVEDEEP_FINDING_NOT_FOUND');
  }
  const exposure = await updateExposureStatus(customerId, exposureId, status, `admin:${actorId}`, p);
  if (['false_positive', 'ignored'].includes(status)) {
    await p.query(`UPDATE divedeep_exposures SET publication_status='rejected',updated_at=NOW(3) WHERE id=? AND tenant_id=?`, [exposureId, customerId]);
    exposure.publicationStatus = 'rejected';
  }
  if (!options.suppressEvent) {
    await addCustomerEvent(customerId, 'admin.finding_updated', {
      exposureId, status, note: clean(input.note, 2000),
    }, 'admin', actorId, p);
  }
  return exposure;
}

async function adminTransitionPrivacyCase(customerId, caseId, input, actorId, pool = null, options = {}) {
  const p = pool || getPool();
  if (clean(input.state, 32) === 'sent') await diveDeepAuthorizations.requireActiveAuthorization(customerId, p);
  const result = await transitionCase(customerId, caseId, input, `admin:${actorId}`, p);
  if (!options.suppressEvent) {
    await addCustomerEvent(customerId, 'admin.case_transitioned', { caseId, state: result.state }, 'admin', actorId, p);
  }
  return result;
}

async function adminVerifyPrivacyCase(customerId, caseId, input, actorId, pool = null, options = {}) {
  const p = pool || getPool();
  const result = await addVerification(customerId, caseId, input, `admin:${actorId}`, p);
  if (!options.suppressEvent) {
    await addCustomerEvent(customerId, 'admin.case_verified', { caseId, result: result.result }, 'admin', actorId, p);
  }
  return result;
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function packetCsv(packet) {
  const rows = [['record_type', 'category', 'label', 'value', 'status', 'notes']];
  for (const identifier of packet.divedeep.profile?.identifiers || []) {
    rows.push(['identifier', identifier.type, identifier.label, identifier.value, identifier.status, identifier.isPrimary ? 'primary' : '']);
  }
  for (const connection of packet.connections || []) {
    rows.push(['social_connection', connection.provider, connection.displayName, connection.profileUrl || connection.username,
      connection.status, connection.connectionMode]);
  }
  for (const photo of packet.photos || []) {
    rows.push(['photo', photo.purpose, photo.label, photo.id, photo.status, `${photo.mimeType}; sha256=${photo.sha256}`]);
  }
  for (const item of packet.socialMediaCatalog || []) {
    rows.push(['social_media', `${item.provider}:${item.itemType}`, item.caption, item.permalink || item.externalItemId,
      item.selectionStatus, item.publishedAt || '']);
  }
  for (const policy of packet.divedeep.profile?.policies || []) {
    rows.push(['visibility_policy', policy.scopeType, policy.scopeValue, policy.action, 'active', `priority=${policy.priority}`]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

function packetMarkdown(packet) {
  const c = packet.customer;
  const p = packet.divedeep.profile;
  const lines = [
    `# DiveDeep DiveDeep Handoff`, '',
    `- Customer: ${c.displayName}`,
    `- Customer ID: ${c.id}`,
    `- Service level: ${c.planTier}`,
    `- Workflow status: ${c.workflowStatus}`,
    `- Exported: ${packet.exportedAt}`,
    '', '## Protected profile',
    `- Profile ID: ${p?.id || 'Not completed'}`,
    `- Jurisdiction: ${[p?.jurisdictionRegion, p?.jurisdictionCountry].filter(Boolean).join(', ') || 'Not provided'}`,
    '', '## Identifiers',
  ];
  for (const item of p?.identifiers || []) lines.push(`- **${item.type}** (${item.label || 'unlabeled'}): ${item.value}`);
  lines.push('', '## Connected and declared profiles');
  for (const item of packet.connections || []) lines.push(`- **${item.provider}**: ${item.profileUrl || item.username || item.externalUserId} (${item.connectionMode})`);
  lines.push('', '## Reference photos');
  for (const item of packet.photos || []) lines.push(`- ${item.id}: ${item.label} — ${item.mimeType}, SHA-256 ${item.sha256}`);
  lines.push('', '## Authorized social media catalog');
  for (const item of packet.socialMediaCatalog || []) {
    lines.push(`- **${item.provider}/${item.itemType}**: ${item.permalink || item.externalItemId} (${item.selectionStatus})`);
  }
  lines.push('', '## Visibility rules');
  for (const item of p?.policies || []) lines.push(`- ${item.scopeType}:${item.scopeValue || '*'} → ${item.action}`);
  lines.push('', '## Manual processing guidance');
  for (const line of packet.manualProcessing.instructions) lines.push(`- ${line}`);
  return lines.join('\n');
}


function divedeepImportStatus(value) {
  const status = clean(value || 'review', 32).toLowerCase();
  const aliases = {
    open: 'review', candidate: 'review', pending: 'review',
    verified: 'confirmed', still_present: 'confirmed',
  };
  return aliases[status] || status;
}

function caseTransitionPath(target) {
  const paths = {
    draft: [],
    approved: ['approved'],
    queued: ['approved', 'queued'],
    sent: ['approved', 'queued', 'sent'],
    acknowledged: ['approved', 'queued', 'sent', 'acknowledged'],
    needs_action: ['approved', 'queued', 'sent', 'needs_action'],
    completed: ['approved', 'queued', 'sent', 'completed'],
    denied: ['approved', 'queued', 'sent', 'denied'],
    failed: ['approved', 'queued', 'failed'],
    withdrawn: ['withdrawn'],
  };
  return paths[clean(target || 'draft', 32).toLowerCase()] || [];
}

async function transitionImportedCase(customerId, privacyCase, removal, actorId, pool, options = {}) {
  let current = privacyCase;
  const target = clean(removal.status || 'draft', 32).toLowerCase();
  if (current.state === target) return current;
  const fullPath = caseTransitionPath(target);
  const currentIndex = fullPath.indexOf(current.state);
  const remaining = currentIndex >= 0 ? fullPath.slice(currentIndex + 1) : fullPath;
  for (const state of remaining) {
    if (current.state === state) continue;
    current = await adminTransitionPrivacyCase(customerId, current.id, {
      state,
      expectedRevision: current.revision,
      confirmationReference: removal.confirmationReference,
      responseDueAt: removal.responseDueAt,
      notes: removal.notes,
    }, actorId, pool, options);
  }
  return current;
}

async function importDiveDeepResultPacket(customerId, packetValue, actorId, pool = null, options = {}) {
  const p = pool || getPool();
  const packet = parseJson(packetValue, null);
  if (packet && divedeepPacketBytes(packet) > DIVEDEEP_RESULT_PACKET_MAX_BYTES) {
    throw statusError(
      'DiveDeep result packet exceeds the 5 MB metadata limit',
      413,
      'DIVEDEEP_DIVEDEEP_PACKET_TOO_LARGE'
    );
  }
  if (!packet || packet.packetType !== 'divedeep.recon-results' || Number(packet.schemaVersion) !== 1) {
    throw statusError('Unsupported DiveDeep result packet', 400, 'DIVEDEEP_DIVEDEEP_PACKET_INVALID');
  }
  const source = packet.source && typeof packet.source === 'object' ? packet.source : {};
  if (clean(source.customerId, 64) !== customerId) {
    throw statusError('The DiveDeep packet belongs to a different customer', 409, 'DIVEDEEP_DIVEDEEP_CUSTOMER_MISMATCH');
  }
  const profile = await primaryProfile(customerId, p);
  if (!profile) throw statusError('Customer has not completed onboarding', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  if (clean(source.profileId, 64) !== profile.id) {
    throw statusError('The DiveDeep packet belongs to a different protected profile', 409, 'DIVEDEEP_DIVEDEEP_PROFILE_MISMATCH');
  }
  const findings = asArray(packet.findings, 500);
  const imported = [];
  const errors = [];
  for (let index = 0; index < findings.length; index += 1) {
    const item = findings[index];
    try {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw statusError('Finding must be an object');
      const evidence = normalizeImportedEvidence(item.evidence);
      const primaryEvidence = evidence.find((value) => value.ref || value.sha256) || {};
      const removal = item.removal && typeof item.removal === 'object' && !Array.isArray(item.removal) ? item.removal : {};
      const verification = item.verification && typeof item.verification === 'object' && !Array.isArray(item.verification) ? item.verification : {};
      const rawStatus = clean(item.status || 'review', 32).toLowerCase();
      const requestedStatus = divedeepImportStatus(rawStatus);
      const normalizedListingUrl = normalizeUrl(item.listingUrl, 'listingUrl');
      const listingUrlHash = crypto.createHash('sha256').update(normalizedListingUrl).digest('hex');
      const [priorExposureRows] = await p.query(
        `SELECT id,publication_status FROM divedeep_exposures WHERE tenant_id=? AND profile_id=? AND listing_url_hash=? LIMIT 1`,
        [customerId, profile.id, listingUrlHash]
      );
      const priorPublicationStatus = priorExposureRows[0]?.publication_status || null;
      const importPublicationStatus = priorPublicationStatus === 'published'
        ? ''
        : ['false_positive', 'ignored'].includes(requestedStatus)
          ? 'rejected'
          : ['confirmed', 'preserved', 'removed', 'reappeared'].includes(requestedStatus)
            ? 'approved'
            : 'staged';
      const createCase = bool(removal.createCase) || Boolean(removal.status) || Boolean(verification.result) || ['removed', 'still_present'].includes(rawStatus);
      let result = await adminAddFinding(customerId, {
        sourceName: item.sourceName,
        listingUrl: normalizedListingUrl,
        listingIdentifier: item.listingIdentifier,
        subjectIdentifier: item.subjectIdentifier,
        matchConfidence: Number(item.matchConfidence) || 0,
        contentCategory: item.contentCategory || 'standard',
        publicationStatus: importPublicationStatus,
        evidenceRef: primaryEvidence.ref || '',
        evidenceSha256: primaryEvidence.sha256 || '',
        confirmed: ['confirmed', 'removed', 'reappeared', 'still_present'].includes(requestedStatus),
        createCase,
        recipientEmail: removal.recipientEmail,
        deliveryMethod: removal.deliveryMethod,
        templateKey: removal.templateKey,
        requestActions: removal.requestActions,
        notes: item.notes,
        idempotencyKey: clean(item.findingKey, 128) ? `divedeep:${clean(item.findingKey, 128)}` : '',
        metadata: {
          source: 'divedeep-manual-import',
          findingKey: clean(item.findingKey, 128),
          discoveredAt: clean(item.discoveredAt, 64),
          evidence,
          local: normalizeImportedLocal(item.local),
          packetGeneratedAt: clean(packet.generatedAt, 64),
          diveDeepPacketSha256: clean(source.diveDeepPacketSha256, 64),
          importBatchId: clean(options.importBatchId, 64),
        },
      }, actorId, p, { suppressEvent: Boolean(options.suppressEvent), deferWorkflow: Boolean(options.deferWorkflow) });

      if (['preserved', 'ignored', 'false_positive', 'removed', 'reappeared'].includes(requestedStatus) && result.exposure.status !== requestedStatus) {
        result.exposure = await adminUpdateFinding(customerId, result.exposure.id, { status: requestedStatus }, actorId, p, { suppressEvent: Boolean(options.suppressEvent) });
      }
      if (result.case && removal.status) {
        result.case = await transitionImportedCase(customerId, result.case, removal, actorId, p, { suppressEvent: Boolean(options.suppressEvent) });
      }
      let verificationResult = null;
      const verificationOutcome = verification.result || (rawStatus === 'still_present' ? 'still_present' : rawStatus === 'removed' ? 'removed' : '');
      if (result.case && verificationOutcome) {
        verificationResult = await adminVerifyPrivacyCase(customerId, result.case.id, {
          result: verificationOutcome,
          sourceUrl: verification.sourceUrl || item.listingUrl,
          notes: verification.notes,
          checkedAt: verification.checkedAt,
          evidenceRef: verification.evidenceRef || primaryEvidence.ref || '',
          evidenceSha256: verification.evidenceSha256 || primaryEvidence.sha256 || '',
        }, actorId, p, { suppressEvent: Boolean(options.suppressEvent) });
      }
      imported.push({
        index,
        findingKey: clean(item.findingKey, 128),
        exposureId: result.exposure.id,
        caseId: result.case?.id || null,
        verificationId: verificationResult?.id || null,
        priorPublicationStatus,
        status: result.exposure.status,
      });
    } catch (error) {
      errors.push({ index, findingKey: clean(item?.findingKey, 128), error: error.message, code: error.code || 'DIVEDEEP_DIVEDEEP_FINDING_FAILED' });
    }
  }
  if (!options.deferWorkflow) {
    await p.query(
      `UPDATE divedeep_customers SET workflow_status=?,updated_at=NOW(3) WHERE id=?`,
      [errors.length && !imported.length ? 'researching' : 'results_ready', customerId]
    );
  }
  if (!options.suppressEvent) {
    await addCustomerEvent(customerId, 'admin.divedeep_results_imported', {
      packetGeneratedAt: clean(packet.generatedAt, 64),
      findingsReceived: findings.length,
      imported: imported.length,
      failed: errors.length,
      summary: normalizeDiveDeepSummary(packet.summary),
    }, 'admin', actorId, p);
  }
  return { imported, errors, received: findings.length };
}

async function exportCustomerPacket(customerId, format = 'json', pool = null, options = {}) {
  const p = pool || getPool();
  const formalAuthorization = await diveDeepAuthorizations.requireActiveAuthorization(customerId, p);
  const dashboard = await getCustomerDashboard(customerId, p);
  if (!dashboard.profile) throw statusError('Customer onboarding is incomplete', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  const [divedeep, socialMediaCatalog, sourceManifest] = await Promise.all([
    exportProfilePacket(customerId, dashboard.profile.id, p),
    listSocialMediaItems(customerId, { limit: 500 }, p),
    platformCatalog.resolvePackageSourceManifest(dashboard.customer.planTier, null, p),
  ]);
  const packet = {
    schemaVersion: 2,
    product: 'OSINT Dive Deep v1',
    exportedAt: new Date().toISOString(),
    customer: dashboard.customer,
    authorization: {
      id: formalAuthorization.id,
      status: formalAuthorization.status,
      version: formalAuthorization.authorizationVersion,
      signedAt: formalAuthorization.signedAt,
      expiresAt: formalAuthorization.expiresAt,
      documentSha256: formalAuthorization.documentSha256,
    },
    divedeep,
    connections: dashboard.connections,
    photos: dashboard.photos,
    socialMediaCatalog,
    manualProcessing: {
      serviceLevel: dashboard.customer.planTier,
      packageVersion: sourceManifest.package.version,
      sourceSet: sourceManifest.sourceSet,
      sourcePools: sourceManifest.pools.map((item) => ({
        id: item.poolId,
        versionId: item.poolVersionId,
        version: item.version,
        namespace: item.namespace,
        type: item.poolType,
        slug: item.slug,
        name: item.name,
        inclusionMode: item.inclusionMode,
        priority: item.priority,
      })),
      resources: sourceManifest.resources.map((item) => ({
        id: item.id,
        type: item.resourceType,
        slug: item.slug,
        name: item.name,
        primaryDomain: item.primaryDomain,
        serviceType: item.serviceType,
        category: item.category,
        topic: item.topic,
        sensitivityClass: item.sensitivityClass,
        adapterKey: item.adapterKey,
        capabilities: item.capabilities,
        declarations: item.declarations,
        limits: item.limits,
        removalMethods: item.removalMethods,
        monitoringSupport: item.monitoringSupport,
      })),
      imageAnalysis: sourceManifest.imageAnalysis || null,
      instructions: [
        'Use only the identifiers, profiles, source pools, resources, and image-analysis policy included in this authorized packet.',
        'Record each attempted source using its catalog resource ID and resolved pool-version ID.',
        'Record every candidate URL with source, discovery timestamp, match confidence, and evidence reference.',
        'Treat assisted image-analysis output as a review signal, never as automatic proof of identity.',
        'Never automatically confirm, publish, retain, or submit a removal request from a similarity score alone.',
        'Present candidate thumbnails as blurred by default until a reviewer or the customer completes the permitted validation step.',
        'Use customer_validation_requested only when the profile permits it and reviewer confidence meets the configured minimum.',
        'Do not create Rekognition face collections or persistent provider-side biometric vectors.',
        'Return normalized results and artifact references to DiveDeep; do not retain completed case data in the worker.',
        'Honor profile_url preserve policies: owned protected accounts must not become removal cases.',
        'Treat sensitive-site evidence as restricted and avoid unnecessary copies.',
      ],
    },

  };
  if (!options.suppressWorkflow) await p.query(`UPDATE divedeep_customers SET workflow_status='exported',updated_at=NOW(3) WHERE id=?`, [customerId]);
  if (!options.suppressEvent) await addCustomerEvent(customerId, 'admin.packet_exported', { format }, 'admin', options.actorId || 'export', p);
  if (format === 'csv') return { contentType: 'text/csv; charset=utf-8', extension: 'csv', body: packetCsv(packet) };
  if (format === 'md' || format === 'markdown') return { contentType: 'text/markdown; charset=utf-8', extension: 'md', body: packetMarkdown(packet) };
  return { contentType: 'application/json; charset=utf-8', extension: 'json', body: JSON.stringify(packet, null, 2) };
}

module.exports = {
  PLAN_TIERS,
  DEFAULT_PACKAGES,
  CUSTOMER_STATUSES,
  WORKFLOW_STATUSES,
  SOCIAL_PROVIDERS,
  PHOTO_PURPOSES,
  registerCustomer,
  listPackages,
  getPackage,
  updatePackage,
  listPilotCodes,
  createPilotCode,
  updatePilotCode,
  authenticateCustomer,
  getCustomerById,
  getCustomerDashboard,
  getCustomerFindingPage,
  completeOnboarding,
  addIdentifier,
  setVisibilityPolicy,
  createSocialConnection,
  listSocialConnections,
  disconnectSocialConnection,
  setSocialConnectionProtection,
  getFacebookConnectionCredentials,
  syncSocialMediaItems,
  listSocialMediaItems,
  markSocialMediaWhitelisted,
  requestFirstScrub,
  saveFacebookConnection,
  saveInstagramConnection,
  addProfilePhoto,
  readProfilePhoto,
  removeProfilePhoto,
  updateCustomerPlan,
  getAdminOverview,
  listCustomers,
  adminUpdateCustomer,
  adminAddFinding,
  adminUpdateFinding,
  adminTransitionPrivacyCase,
  adminVerifyPrivacyCase,
  importDiveDeepResultPacket,
  exportCustomerPacket,
  listCustomerEvents,
  addCustomerEvent,
};
