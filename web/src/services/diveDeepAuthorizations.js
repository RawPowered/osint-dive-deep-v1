const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getDiveDeepConfig } = require('../config');
const {
  blindIndex,
  encryptPii,
  decryptPii,
  encryptJson,
  decryptJson,
} = require('./divedeepPii');
const { statusError } = require('./divedeepPrivacy');

function uuid() { return crypto.randomUUID(); }
function clean(value, max = 255) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : '';
}
function bool(value) { return value === true || value === 1 || String(value).toLowerCase() === 'true'; }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function normalizeName(value) { return clean(value, 255).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function sha256(value) { return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex'); }
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function serializeAuthorization(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    signerType: row.signer_type,
    signerName: decryptPii(row.signer_name_enc),
    jurisdictionCountry: row.jurisdiction_country,
    jurisdictionRegion: row.jurisdiction_region || '',
    authorizationVersion: row.authorization_version,
    electronicRecordsVersion: row.electronic_records_version,
    responsibleDataVersion: row.responsible_data_version,
    termsVersion: row.terms_version,
    privacyVersion: row.privacy_version,
    legalEntityName: row.legal_entity_name,
    scope: decryptJson(row.scope_enc, {}),
    signedAt: iso(row.signed_at),
    effectiveAt: iso(row.effective_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    documentSha256: row.document_sha256,
    networkRecorded: Boolean(row.ip_hash),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function addressLine(input) {
  return [
    clean(input.streetAddress, 255),
    clean(input.addressLine2, 255),
    [clean(input.city, 128), clean(input.jurisdictionRegion, 128), clean(input.postalCode, 32)].filter(Boolean).join(', '),
    clean(input.jurisdictionCountry || 'US', 64),
  ].filter(Boolean).join('\n');
}

function maskIp(value) {
  const ip = clean(value, 128);
  if (!ip) return 'Network information recorded';
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}:…`;
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.…` : 'Network information recorded';
}

function authorizationScope() {
  return {
    purpose: 'privacy discovery, correction, suppression, opt-out, deletion, content-removal, and verification activity',
    permittedActions: [
      'Submit supported privacy, deletion, opt-out, suppression, correction, and content-removal requests.',
      'Communicate with data brokers, websites, platforms, publishers, search providers, hosts, and service providers.',
      'Provide the minimum identifiers and supporting evidence reasonably required to match records and process a request.',
      'Receive procedural and status communications, follow up, and appeal supported denials.',
      'Track request status and report results to the customer.',
    ],
    limitations: [
      'No authority to access financial, medical, credit, or private communications accounts.',
      'No authority to commence litigation, settle claims, waive substantive rights, or accept money for the customer.',
      'No authority to sign sworn statements, change passwords, or impersonate the customer outside the limited request process.',
      'No authority to continue new submissions after revocation or expiration.',
    ],
  };
}

function renderAuthorizationDocument(data) {
  const scope = data.scope;
  const permitted = scope.permittedActions.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const limitations = scope.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DiveDeep Limited Authorization ${escapeHtml(data.authorizationId)}</title>
<style>
body{margin:0;background:#eef4fb;color:#10213a;font-family:Arial,Helvetica,sans-serif;line-height:1.55}.page{width:min(860px,calc(100% - 32px));margin:32px auto;background:#fff;border:1px solid #dbe5f2;border-radius:18px;box-shadow:0 18px 60px rgba(21,55,96,.1);overflow:hidden}.head{padding:30px 36px;background:linear-gradient(135deg,#061d42,#0b5bd3);color:#fff}.head h1{margin:8px 0;font-size:28px}.head p{margin:0;color:#dbeaff}.body{padding:34px 36px}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0 0 26px}.meta div{padding:12px;border:1px solid #dbe5f2;border-radius:12px}.meta b{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#60738e}.meta span{display:block;margin-top:4px;white-space:pre-line}.body h2{margin:26px 0 8px;font-size:18px;color:#082a61}.body p,.body li{font-size:14px}.signature{margin-top:30px;padding:20px;border:1px solid #bcd1ec;border-radius:14px;background:#f7fbff}.signature strong{display:block;font-size:20px;font-family:Georgia,serif;font-style:italic}.foot{padding:18px 36px;border-top:1px solid #dbe5f2;color:#60738e;font-size:11px;word-break:break-word}@media print{body{background:#fff}.page{width:100%;margin:0;border:0;box-shadow:none}.no-print{display:none}}</style></head>
<body><main class="page"><header class="head"><small>EXECUTED ELECTRONIC RECORD</small><h1>Limited Authorization and Consent for Privacy and Removal Requests</h1><p>This record documents the customer’s limited appointment of ${escapeHtml(data.legalEntityName)} to act for the purposes stated below.</p></header>
<section class="body">
<div class="meta"><div><b>Authorization ID</b><span>${escapeHtml(data.authorizationId)}</span></div><div><b>Document version</b><span>${escapeHtml(data.authorizationVersion)}</span></div><div><b>Customer</b><span>${escapeHtml(data.signerName)}</span></div><div><b>Account email</b><span>${escapeHtml(data.customerEmail)}</span></div><div><b>Address</b><span>${escapeHtml(data.address)}</span></div><div><b>Jurisdiction</b><span>${escapeHtml([data.jurisdictionRegion, data.jurisdictionCountry].filter(Boolean).join(', '))}</span></div></div>
<h2>1. Limited appointment</h2><p>I appoint ${escapeHtml(data.legalEntityName)}, operating the DiveDeep service, as my limited authorized agent solely to perform supported privacy discovery, correction, suppression, opt-out, deletion, content-removal, and verification activity concerning my own personal information.</p>
<h2>2. Actions I authorize</h2><ul>${permitted}</ul>
<h2>3. Disclosure of identifiers</h2><p>I authorize DiveDeep to disclose the minimum personal identifiers and supporting evidence reasonably necessary to locate my records, authenticate a request, and complete the authorized activity. A recipient may still require me to verify my identity or take action directly.</p>
<h2>4. Limits on authority</h2><ul>${limitations}</ul>
<h2>5. Customer attestations</h2><p>I attest that the information I supplied is accurate, that I am signing for myself, that submitted evidence is authentic to the best of my knowledge, and that I will not use the service to conceal fraud, evade lawful obligations, interfere with lawful records, or submit a request concerning another adult without documented authority.</p>
<h2>6. Duration and revocation</h2><p>This authorization is effective when signed and expires on ${escapeHtml(data.expiresDisplay)} unless I revoke it earlier. I may revoke through my DiveDeep account or the privacy contact listed below. Revocation prevents new submissions; records of completed or already transmitted activity may be retained as needed for security, legal, billing, and audit purposes.</p>
<h2>7. Electronic records and signature</h2><p>I consented to electronic records and signatures, reviewed the linked disclosures, and intentionally signed this authorization electronically. The system recorded the signing time, authenticated session, device information, and network information as evidence of execution.</p>
<div class="signature"><b>Electronic signature</b><strong>${escapeHtml(data.typedSignature)}</strong><span>Signed ${escapeHtml(data.signedDisplay)} · ${escapeHtml(maskIp(data.ipAddress))}</span></div>
<p class="no-print" style="margin-top:22px"><button onclick="window.print()">Print or save as PDF</button></p>
</section><footer class="foot">Legal entity: ${escapeHtml(data.legalEntityName)} · Privacy contact: ${escapeHtml(data.privacyContactEmail)}${data.legalPostalAddress ? ` · ${escapeHtml(data.legalPostalAddress)}` : ''}<br>Authorization ID: ${escapeHtml(data.authorizationId)} · Executed: ${escapeHtml(data.signedAt)} · Document SHA-256 is recorded in the DiveDeep authorization ledger</footer></main></body></html>`;
}

async function appendEvent(connection, authorizationId, customerId, eventType, context = {}, metadata = {}) {
  const [priorRows] = await connection.query(
    'SELECT event_hash FROM divedeep_authorization_events WHERE authorization_id=? ORDER BY occurred_at DESC,id DESC LIMIT 1',
    [authorizationId]
  );
  const previousHash = priorRows[0]?.event_hash || ''.padStart(64, '0');
  const occurredAt = new Date();
  const payload = {
    authorizationId,
    customerId,
    eventType: clean(eventType, 96),
    actorType: clean(context.actorType || 'customer', 32),
    actorId: clean(context.actorId || customerId, 128),
    occurredAt: occurredAt.toISOString(),
    metadata,
    previousHash,
  };
  const eventHash = sha256(JSON.stringify(payload));
  await connection.query(
    `INSERT INTO divedeep_authorization_events
      (id,authorization_id,customer_id,event_type,actor_type,actor_id,occurred_at,ip_address_enc,ip_hash,user_agent_enc,session_hash,metadata_enc,previous_event_hash,event_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), authorizationId, customerId, payload.eventType, payload.actorType, payload.actorId, occurredAt,
      encryptPii(clean(context.ipAddress, 128)), context.ipAddress ? blindIndex(customerId, 'other', `ip:${context.ipAddress}`) : null,
      encryptPii(clean(context.userAgent, 1000)), context.sessionId ? sha256(context.sessionId) : null,
      encryptJson(metadata || {}), previousHash, eventHash]
  );
  return eventHash;
}

async function getAuthorization(customerId, authorizationId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_authorizations WHERE id=? AND customer_id=? LIMIT 1', [authorizationId, customerId]);
  if (!rows[0]) throw statusError('Authorization record not found', 404, 'DIVEDEEP_AUTHORIZATION_NOT_FOUND');
  return serializeAuthorization(rows[0]);
}

async function getLatestAuthorization(customerId, pool = null) {
  const p = pool || getPool();
  await p.query("UPDATE divedeep_authorizations SET status='expired',updated_at=NOW(3) WHERE customer_id=? AND status='active' AND expires_at<=NOW(3)", [customerId]);
  const [rows] = await p.query('SELECT * FROM divedeep_authorizations WHERE customer_id=? ORDER BY signed_at DESC,created_at DESC LIMIT 1', [customerId]);
  return serializeAuthorization(rows[0]);
}

async function requireActiveAuthorization(customerId, pool = null) {
  const p = pool || getPool();
  await p.query("UPDATE divedeep_authorizations SET status='expired',updated_at=NOW(3) WHERE customer_id=? AND status='active' AND expires_at<=NOW(3)", [customerId]);
  const [rows] = await p.query("SELECT * FROM divedeep_authorizations WHERE customer_id=? AND status='active' AND effective_at<=NOW(3) AND expires_at>NOW(3) ORDER BY signed_at DESC LIMIT 1", [customerId]);
  if (!rows[0]) throw statusError('Complete the Limited Authorization before DiveDeep can act on your behalf', 409, 'DIVEDEEP_AUTHORIZATION_REQUIRED');
  return serializeAuthorization(rows[0]);
}

async function signAuthorization(customerId, input, context = {}, pool = null) {
  const p = pool || getPool();
  const config = getDiveDeepConfig();
  const [customerRows] = await p.query('SELECT * FROM divedeep_customers WHERE id=? LIMIT 1', [customerId]);
  const customer = customerRows[0];
  if (!customer || customer.status === 'closed') throw statusError('Customer account not found', 404, 'DIVEDEEP_CUSTOMER_NOT_FOUND');

  const signerName = clean(input.legalName, 255);
  const typedSignature = clean(input.typedSignature, 255);
  const country = clean(input.jurisdictionCountry || 'US', 64);
  const region = clean(input.jurisdictionRegion, 128);
  const address = addressLine(input);
  const phone = clean(input.phone, 64);
  if (!signerName || !typedSignature || !address || !country || !region) {
    throw statusError('Legal name, address, state or region, country, and typed signature are required', 400, 'DIVEDEEP_AUTHORIZATION_FIELDS_REQUIRED');
  }
  if (normalizeName(signerName) !== normalizeName(typedSignature)) {
    throw statusError('Your typed signature must match the legal name on the authorization', 400, 'DIVEDEEP_SIGNATURE_MISMATCH');
  }
  const requiredConsents = ['signingForSelf', 'electronicRecordsConsent', 'agencyConsent', 'dataDisclosureConsent', 'accuracyAttested', 'signatureIntent'];
  if (requiredConsents.some((field) => !bool(input[field]))) {
    throw statusError('All authorization acknowledgments must be accepted', 400, 'DIVEDEEP_AUTHORIZATION_CONSENT_REQUIRED');
  }

  const signedAt = new Date();
  const expiresAt = new Date(signedAt.getTime() + (config.authorizationValidityDays * 24 * 60 * 60 * 1000));
  const authorizationId = uuid();
  const scope = authorizationScope();
  const customerEmail = decryptPii(customer.email_enc);
  const consentRecord = {
    signingForSelf: true,
    electronicRecordsConsent: true,
    agencyConsent: true,
    dataDisclosureConsent: true,
    accuracyAttested: true,
    signatureIntent: true,
    localDate: clean(input.localDate, 32),
    timezone: clean(input.timezone, 80),
  };
  const documentData = {
    authorizationId,
    authorizationVersion: config.authorizationVersion,
    legalEntityName: config.legalEntityName,
    privacyContactEmail: config.privacyContactEmail,
    legalPostalAddress: config.legalPostalAddress,
    signerName,
    typedSignature,
    customerEmail,
    address,
    jurisdictionCountry: country,
    jurisdictionRegion: region,
    signedAt: signedAt.toISOString(),
    signedDisplay: signedAt.toUTCString(),
    expiresDisplay: expiresAt.toUTCString(),
    ipAddress: clean(context.ipAddress, 128),
    scope,
  };
  const documentHtml = renderAuthorizationDocument(documentData);
  const documentSha256 = sha256(documentHtml);

  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM divedeep_customers WHERE id=? FOR UPDATE', [customerId]);
    const [priorActiveRows] = await connection.query(
      "SELECT id FROM divedeep_authorizations WHERE customer_id=? AND status='active' ORDER BY signed_at DESC FOR UPDATE",
      [customerId]
    );
    await connection.query("UPDATE divedeep_authorizations SET status='superseded',updated_at=NOW(3) WHERE customer_id=? AND status='active'", [customerId]);
    for (const prior of priorActiveRows) {
      await appendEvent(connection, prior.id, customerId, 'authorization.superseded', { ...context, actorType: 'system', actorId: 'authorization-renewal' }, {
        supersededByAuthorizationId: authorizationId,
      });
    }
    await connection.query(
      `INSERT INTO divedeep_authorizations
       (id,customer_id,signer_type,status,authorization_version,electronic_records_version,responsible_data_version,terms_version,privacy_version,
        legal_entity_name,signer_name_enc,signer_address_enc,signer_phone_enc,jurisdiction_country,jurisdiction_region,scope_enc,typed_signature_enc,
        consent_record_enc,ip_address_enc,ip_hash,ip_source,user_agent_enc,session_hash,signed_at,effective_at,expires_at,document_html_enc,document_sha256)
       VALUES (?,?,'self','active',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [authorizationId, customerId, config.authorizationVersion, config.electronicRecordsVersion, config.responsibleDataVersion,
        config.termsVersion, config.privacyVersion, config.legalEntityName, encryptPii(signerName), encryptPii(address), encryptPii(phone),
        country, region || null, encryptJson(scope), encryptPii(typedSignature), encryptJson(consentRecord),
        encryptPii(clean(context.ipAddress, 128)), context.ipAddress ? blindIndex(customerId, 'other', `ip:${context.ipAddress}`) : null,
        clean(context.ipSource || 'express:req.ip', 64), encryptPii(clean(context.userAgent, 1000)), context.sessionId ? sha256(context.sessionId) : null,
        signedAt, signedAt, expiresAt, encryptPii(documentHtml), documentSha256]
    );
    await connection.query('UPDATE divedeep_customers SET authorization_affirmed_at=?,updated_at=NOW(3) WHERE id=?', [signedAt, customerId]);
    const signedEventDetails = {
      authorizationId,
      authorizationVersion: config.authorizationVersion,
      electronicRecordsVersion: config.electronicRecordsVersion,
      responsibleDataVersion: config.responsibleDataVersion,
      documentSha256,
      expiresAt: expiresAt.toISOString(),
    };
    await appendEvent(connection, authorizationId, customerId, 'authorization.signed', { ...context, actorType: 'customer', actorId: customerId }, signedEventDetails);
    await connection.query(
      `INSERT INTO divedeep_customer_events
        (id,customer_id,event_type,actor_type,actor_id,details_enc)
       VALUES (?,?,?,?,?,?)`,
      [uuid(), customerId, 'authorization.signed', 'customer', customerId, encryptJson(signedEventDetails)]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return getAuthorization(customerId, authorizationId, p);
}

async function revokeAuthorization(customerId, input = {}, context = {}, pool = null) {
  const p = pool || getPool();
  const reason = clean(input.reason || 'Revoked by customer', 2000);
  const connection = await p.getConnection();
  let authorizationId = null;
  try {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM divedeep_customers WHERE id=? FOR UPDATE', [customerId]);
    const [rows] = await connection.query(
      "SELECT * FROM divedeep_authorizations WHERE customer_id=? AND status='active' ORDER BY signed_at DESC LIMIT 1 FOR UPDATE",
      [customerId]
    );
    const row = rows[0];
    if (!row) throw statusError('No active authorization is available to revoke', 409, 'DIVEDEEP_AUTHORIZATION_NOT_ACTIVE');
    authorizationId = row.id;
    await connection.query("UPDATE divedeep_authorizations SET status='revoked',revoked_at=NOW(3),revocation_reason_enc=?,updated_at=NOW(3) WHERE id=? AND customer_id=? AND status='active'", [encryptPii(reason), row.id, customerId]);
    const revokedEventDetails = { authorizationId: row.id, reason };
    await appendEvent(connection, row.id, customerId, 'authorization.revoked', { ...context, actorType: 'customer', actorId: customerId }, revokedEventDetails);
    await connection.query(
      `INSERT INTO divedeep_customer_events
        (id,customer_id,event_type,actor_type,actor_id,details_enc)
       VALUES (?,?,?,?,?,?)`,
      [uuid(), customerId, 'authorization.revoked', 'customer', customerId, encryptJson(revokedEventDetails)]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return getAuthorization(customerId, authorizationId, p);
}

async function readAuthorizationDocument(customerId, authorizationId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT id,document_html_enc,document_sha256 FROM divedeep_authorizations WHERE id=? AND customer_id=? LIMIT 1', [authorizationId, customerId]);
  if (!rows[0]) throw statusError('Authorization record not found', 404, 'DIVEDEEP_AUTHORIZATION_NOT_FOUND');
  return { id: rows[0].id, html: decryptPii(rows[0].document_html_enc), sha256: rows[0].document_sha256 };
}

module.exports = {
  getAuthorization,
  getLatestAuthorization,
  requireActiveAuthorization,
  signAuthorization,
  revokeAuthorization,
  readAuthorizationDocument,
};
