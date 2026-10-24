const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { encryptJson, decryptJson } = require('./divedeepPii');
const storage = require('./diveDeepObjectStorage');

const RETENTION_POLICIES = Object.freeze({
  transient_nonmatch: { hours: 24, reviewStatus: 'rejected' },
  failed_upload: { hours: 24, reviewStatus: 'not_required' },
  pending_review: { days: 30, reviewStatus: 'pending' },
  confirmed_relevant: { days: null, reviewStatus: 'confirmed' },
  removal_evidence: { days: null, reviewStatus: 'confirmed' },
  deletion_pending: { hours: 1, reviewStatus: 'not_required' },
  audit_metadata: { days: null, reviewStatus: 'not_required' },
});

const ARTIFACT_TYPES = new Set([
  'reference_image', 'candidate_image', 'blurred_thumbnail', 'screenshot', 'page_capture',
  'recon_output', 'removal_confirmation', 'import_bundle', 'document', 'other',
]);

function statusError(message, status = 400, code = 'DIVEDEEP_ARTIFACT_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function clean(value, max = 2048) { return String(value == null ? '' : value).trim().slice(0, max); }
function parseJson(value, fallback = {}) { if (!value) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function iso(value) { return value ? new Date(value).toISOString() : null; }

function expiryForRetention(retentionClass, now = new Date()) {
  const policy = RETENTION_POLICIES[retentionClass];
  if (!policy) throw statusError('Unsupported artifact retention class');
  if (policy.hours == null && policy.days == null) return null;
  const ms = policy.hours != null ? policy.hours * 3600000 : policy.days * 86400000;
  return new Date(now.getTime() + ms);
}

function normalizeReservation(input = {}) {
  const artifactType = clean(input.artifactType || 'other', 64);
  if (!ARTIFACT_TYPES.has(artifactType)) throw statusError('Unsupported artifact type');
  const retentionClass = clean(input.retentionClass || 'pending_review', 64);
  if (!RETENTION_POLICIES[retentionClass]) throw statusError('Unsupported artifact retention class');
  const contentType = clean(input.contentType, 128).toLowerCase();
  if (!contentType || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType)) throw statusError('A valid artifact content type is required');
  const byteSize = Number(input.byteSize);
  if (!Number.isInteger(byteSize) || byteSize < 1 || byteSize > 5 * 1024 * 1024 * 1024) throw statusError('Artifact byte size is invalid');
  const sha256 = clean(input.sha256, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw statusError('Artifact SHA-256 must contain 64 hexadecimal characters');
  const sensitivity = clean(input.sensitivity || 'standard', 32);
  if (!['standard', 'sensitive', 'restricted'].includes(sensitivity)) throw statusError('Artifact sensitivity is invalid');
  const accessScope = clean(input.accessScope || 'admin_only', 64);
  if (!['worker_only', 'admin_only', 'customer_after_publish'].includes(accessScope)) throw statusError('Artifact access scope is invalid');
  return {
    customerId: clean(input.customerId, 64) || null,
    profileId: clean(input.profileId, 64) || null,
    reconJobId: clean(input.reconJobId, 64) || null,
    imageAnalysisItemId: clean(input.imageAnalysisItemId, 64) || null,
    parentArtifactId: clean(input.parentArtifactId, 64) || null,
    artifactType, retentionClass, contentType, byteSize, sha256, sensitivity, accessScope,
    originalName: clean(input.originalName, 255) || null,
    metadata: parseJson(input.metadata, {}),
  };
}

function publicArtifact(row) {
  return {
    id: row.id,
    customerId: row.customer_id || null,
    profileId: row.profile_id || null,
    reconJobId: row.recon_job_id || null,
    imageAnalysisItemId: row.image_analysis_item_id || null,
    parentArtifactId: row.parent_artifact_id || null,
    artifactType: row.artifact_type,
    provider: row.storage_provider,
    bucket: row.storage_bucket || null,
    status: row.status,
    contentType: row.content_type,
    expectedByteSize: Number(row.expected_byte_size) || 0,
    actualByteSize: row.actual_byte_size == null ? null : Number(row.actual_byte_size),
    sha256: row.expected_sha256,
    verifiedSha256: row.actual_sha256 || null,
    sensitivity: row.sensitivity,
    retentionClass: row.retention_class,
    reviewStatus: row.review_status,
    publicationStatus: row.publication_status,
    accessScope: row.access_scope,
    legalHold: Boolean(row.legal_hold),
    lifecycleExempt: Boolean(row.lifecycle_exempt),
    expiresAt: iso(row.expires_at),
    verifiedAt: iso(row.verified_at),
    deletedAt: iso(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    originalName: row.original_name_enc ? decryptJson(row.original_name_enc, null) : null,
    metadata: decryptJson(row.metadata_enc, {}),
  };
}

async function addEvent(connection, artifactId, eventType, actorType, actorId, details = {}) {
  await connection.query(
    `INSERT INTO divedeep_artifact_events (id,artifact_id,event_type,actor_type,actor_id,details_json)
     VALUES (?,?,?,?,?,?)`,
    [crypto.randomUUID(), artifactId, clean(eventType, 96), clean(actorType, 32), clean(actorId, 128) || null, JSON.stringify(details)]
  );
}

async function addRetentionAction(connection, artifactId, action, reason, actorId, status = 'succeeded') {
  const now = new Date();
  await connection.query(
    `INSERT INTO divedeep_retention_actions
     (id,artifact_id,action,status,reason,execute_after,attempt_count,requested_by,completed_at)
     VALUES (?,?,?,?,?,?,1,?,?)`,
    [crypto.randomUUID(), artifactId, clean(action, 32), status, clean(reason, 1000) || 'Administrative retention action', now, clean(actorId, 128) || null, status === 'succeeded' ? now : null]
  );
}

async function syncRetentionMarker(row, markerValue, pool = null) {
  if (row.storage_provider !== 's3' || !row.object_key || row.status === 'deleted') return { updated: false, reason: 'no_active_object' };
  return storage.updateRetentionTags({
    bucket: row.storage_bucket,
    objectKey: row.object_key,
    versionId: row.storage_version_id,
    retentionMarker: markerValue,
    sensitivity: row.sensitivity,
  }, pool);
}

async function reserveUpload(input, actorId, pool = null, options = {}) {
  const p = pool || getPool();
  const normalized = normalizeReservation(input);
  const runtime = await require('./diveDeepIntegrations').getRuntimeIntegration('object_storage', p);
  if (!runtime) throw statusError('Private object storage is not enabled', 409, 'DIVEDEEP_STORAGE_DISABLED');
  const config = storage.normalizeConfig(runtime.config);
  if (normalized.byteSize > config.maximumArtifactBytes) throw statusError('Artifact exceeds the configured storage size limit', 413, 'DIVEDEEP_ARTIFACT_TOO_LARGE');
  const artifactId = crypto.randomUUID();
  const uploadSessionId = crypto.randomUUID();
  const objectKey = storage.buildObjectKey(config, { ...normalized, artifactId, contentType: normalized.contentType });
  const expiresAt = expiryForRetention(normalized.retentionClass);
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO divedeep_artifacts
       (id,customer_id,profile_id,recon_job_id,image_analysis_item_id,parent_artifact_id,artifact_type,storage_provider,
        storage_bucket,object_key,status,content_type,expected_byte_size,expected_sha256,sensitivity,retention_class,
        review_status,publication_status,access_scope,expires_at,original_name_enc,metadata_enc,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?,?,?,?,?,?,?,?,?)`,
      [artifactId, normalized.customerId, normalized.profileId, normalized.reconJobId, normalized.imageAnalysisItemId,
        normalized.parentArtifactId, normalized.artifactType, config.driver, config.bucket || null, objectKey,
        normalized.contentType, normalized.byteSize, normalized.sha256, normalized.sensitivity, normalized.retentionClass,
        RETENTION_POLICIES[normalized.retentionClass].reviewStatus, 'staged', normalized.accessScope, expiresAt,
        normalized.originalName ? encryptJson(normalized.originalName) : null, encryptJson(normalized.metadata), clean(actorId, 128) || null]
    );
    await connection.query(
      `INSERT INTO divedeep_artifact_upload_sessions
       (id,artifact_id,status,method,expires_at,expected_headers_json,created_by)
       VALUES (?,?,'issuing','presigned_put',DATE_ADD(NOW(3),INTERVAL ? SECOND),'{}',?)`,
      [uploadSessionId, artifactId, config.uploadUrlSeconds, clean(actorId, 128) || null]
    );
    await addEvent(connection, artifactId, 'artifact.reserved', options.actorType === 'worker' ? 'worker' : 'admin', actorId, { retentionClass: normalized.retentionClass, byteSize: normalized.byteSize, contentType: normalized.contentType });
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }

  try {
    const authorization = await storage.createUploadAuthorization({
      artifactId, customerId: normalized.customerId, reconJobId: normalized.reconJobId,
      objectKey, contentType: normalized.contentType, byteSize: normalized.byteSize, sha256: normalized.sha256,
      retentionClass: normalized.retentionClass, sensitivity: normalized.sensitivity,
    }, p);
    await p.query(
      `UPDATE divedeep_artifact_upload_sessions SET status='issued',expected_headers_json=?,expires_at=?,updated_at=NOW(3) WHERE id=?`,
      [JSON.stringify(authorization.headers), authorization.expiresAt, uploadSessionId]
    );
    await p.query(`UPDATE divedeep_artifacts SET status='uploading',updated_at=NOW(3) WHERE id=?`, [artifactId]);
    return { artifact: await getArtifact(artifactId, p), upload: { sessionId: uploadSessionId, ...authorization } };
  } catch (error) {
    await p.query(`UPDATE divedeep_artifacts SET status='failed',retention_class='failed_upload',review_status='not_required',expires_at=DATE_ADD(NOW(3),INTERVAL 24 HOUR),last_error_code=?,last_error_message=?,updated_at=NOW(3) WHERE id=?`, [error.code || 'UPLOAD_AUTHORIZATION_FAILED', clean(error.message, 2000), artifactId]);
    await p.query(`UPDATE divedeep_artifact_upload_sessions SET status='failed',last_error=?,updated_at=NOW(3) WHERE id=?`, [clean(error.message, 2000), uploadSessionId]);
    throw error;
  }
}

async function getArtifactRow(artifactId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_artifacts WHERE id=? LIMIT 1', [clean(artifactId, 64)]);
  if (!rows[0]) throw statusError('Artifact not found', 404, 'DIVEDEEP_ARTIFACT_NOT_FOUND');
  return rows[0];
}

async function getArtifact(artifactId, pool = null) {
  const p = pool || getPool();
  const row = await getArtifactRow(artifactId, p);
  const [events] = await p.query('SELECT id,event_type,actor_type,actor_id,details_json,created_at FROM divedeep_artifact_events WHERE artifact_id=? ORDER BY created_at DESC LIMIT 100', [row.id]);
  return { ...publicArtifact(row), events: events.map((event) => ({ id: event.id, eventType: event.event_type, actorType: event.actor_type, actorId: event.actor_id || null, details: parseJson(event.details_json, {}), createdAt: iso(event.created_at) })) };
}

async function listArtifacts(filters = {}, pool = null) {
  const p = pool || getPool();
  const where = [];
  const params = [];
  if (filters.customerId) { where.push('customer_id=?'); params.push(clean(filters.customerId, 64)); }
  if (filters.reconJobId) { where.push('recon_job_id=?'); params.push(clean(filters.reconJobId, 64)); }
  if (filters.status) { where.push('status=?'); params.push(clean(filters.status, 32)); }
  if (filters.retentionClass) { where.push('retention_class=?'); params.push(clean(filters.retentionClass, 64)); }
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
  params.push(limit);
  const [rows] = await p.query(`SELECT * FROM divedeep_artifacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`, params);
  return rows.map(publicArtifact);
}

async function finalizeUpload(artifactId, actorId, pool = null, options = {}) {
  const p = pool || getPool();
  const row = await getArtifactRow(artifactId, p);
  if (!['uploading', 'reserved', 'verifying'].includes(row.status)) throw statusError(`Artifact cannot be finalized from ${row.status}`, 409, 'DIVEDEEP_ARTIFACT_STATE');
  await p.query(`UPDATE divedeep_artifacts SET status='verifying',updated_at=NOW(3) WHERE id=?`, [row.id]);
  let head;
  try { head = await storage.headObject({ bucket: row.storage_bucket, objectKey: row.object_key }, p); }
  catch (error) {
    await p.query(`UPDATE divedeep_artifacts SET status='failed',retention_class='failed_upload',expires_at=DATE_ADD(NOW(3),INTERVAL 24 HOUR),last_error_code=?,last_error_message=?,updated_at=NOW(3) WHERE id=?`, [error.code || 'ARTIFACT_HEAD_FAILED', clean(error.message, 2000), row.id]);
    throw error;
  }
  const expectedBase64 = storage.checksumBase64(row.expected_sha256);
  const metadataHash = clean(head.metadata?.sha256, 64).toLowerCase();
  const hashMatches = head.checksumSha256 ? head.checksumSha256 === expectedBase64 : metadataHash === row.expected_sha256;
  const sizeMatches = Number(head.byteSize) === Number(row.expected_byte_size);
  const typeMatches = !head.contentType || head.contentType.toLowerCase() === row.content_type.toLowerCase();
  if (!hashMatches || !sizeMatches || !typeMatches) {
    const details = { hashMatches, sizeMatches, typeMatches, actualByteSize: head.byteSize, actualContentType: head.contentType };
    const connection = await p.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(`UPDATE divedeep_artifacts SET status='quarantined',retention_class='failed_upload',review_status='not_required',expires_at=DATE_ADD(NOW(3),INTERVAL 24 HOUR),actual_byte_size=?,actual_sha256=?,storage_etag=?,storage_version_id=?,last_error_code='ARTIFACT_VERIFICATION_FAILED',last_error_message='Uploaded object did not match the reserved artifact contract',updated_at=NOW(3) WHERE id=?`, [head.byteSize, metadataHash || null, head.etag || null, head.versionId || null, row.id]);
      await addEvent(connection, row.id, 'artifact.verification_failed', options.actorType === 'worker' ? 'worker' : 'admin', actorId, details);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    throw statusError('Uploaded object did not match the reserved artifact contract', 409, 'DIVEDEEP_ARTIFACT_VERIFICATION_FAILED');
  }
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE divedeep_artifacts SET status='available',actual_byte_size=?,actual_sha256=?,storage_etag=?,storage_version_id=?,verified_at=NOW(3),last_error_code=NULL,last_error_message=NULL,updated_at=NOW(3) WHERE id=?`, [head.byteSize, row.expected_sha256, head.etag || null, head.versionId || null, row.id]);
    await connection.query(`UPDATE divedeep_artifact_upload_sessions SET status='finalized',finalized_at=NOW(3),updated_at=NOW(3) WHERE artifact_id=? AND status IN ('issued','uploading','issuing')`, [row.id]);
    await addEvent(connection, row.id, 'artifact.verified', options.actorType === 'worker' ? 'worker' : 'admin', actorId, { byteSize: head.byteSize, checksumMode: head.checksumSha256 ? 'sha256_header' : 'metadata_only' });
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return getArtifact(row.id, p);
}

async function createAccessGrant(artifactId, actorId, purpose = 'admin_review', pool = null, options = {}) {
  const p = pool || getPool();
  const row = await getArtifactRow(artifactId, p);
  if (row.status !== 'available') throw statusError('Artifact is not available for access', 409, 'DIVEDEEP_ARTIFACT_UNAVAILABLE');
  const grant = await storage.createDownloadAuthorization({ bucket: row.storage_bucket, objectKey: row.object_key, versionId: row.storage_version_id, contentDisposition: 'inline' }, p);
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await addEvent(connection, row.id, 'artifact.access_granted', options.actorType === 'worker' ? 'worker' : 'admin', actorId, { purpose: clean(purpose, 96), expiresAt: grant.expiresAt });
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return { artifact: publicArtifact(row), ...grant, cacheControl: 'private, no-store, max-age=0' };
}

async function updateDisposition(artifactId, input, actorId, pool = null) {
  const p = pool || getPool();
  const row = await getArtifactRow(artifactId, p);
  const action = clean(input.action, 64);
  const mapping = {
    mark_nonmatch: { retentionClass: 'transient_nonmatch', reviewStatus: 'rejected', publicationStatus: 'rejected' },
    pending_review: { retentionClass: 'pending_review', reviewStatus: 'pending', publicationStatus: 'staged' },
    request_customer_validation: { retentionClass: 'pending_review', reviewStatus: 'customer_validation', publicationStatus: 'staged' },
    confirm_relevant: { retentionClass: 'confirmed_relevant', reviewStatus: 'confirmed', publicationStatus: 'approved' },
    removal_evidence: { retentionClass: 'removal_evidence', reviewStatus: 'confirmed', publicationStatus: 'approved' },
    delete_now: { retentionClass: 'deletion_pending', reviewStatus: row.review_status, publicationStatus: 'deleted' },
  };
  const next = mapping[action];
  if (!next) throw statusError('Unsupported artifact disposition');
  const expiry = action === 'delete_now' ? new Date() : expiryForRetention(next.retentionClass);
  const reason = clean(input.reason, 1000) || `Artifact disposition: ${action}`;
  if (action !== 'delete_now') await syncRetentionMarker(row, next.retentionClass, p);
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE divedeep_artifacts SET retention_class=?,review_status=?,publication_status=?,lifecycle_exempt=0,expires_at=?,updated_at=NOW(3) WHERE id=?`, [next.retentionClass, next.reviewStatus, next.publicationStatus, expiry, row.id]);
    await addEvent(connection, row.id, 'artifact.dispositioned', 'admin', actorId, { action, reason, retentionClass: next.retentionClass, expiresAt: iso(expiry) });
    await addRetentionAction(connection, row.id, 'reclassify', reason, actorId);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return getArtifact(row.id, p);
}

async function setHold(artifactId, hold, reason, actorId, pool = null) {
  const p = pool || getPool();
  if (!clean(reason, 1000)) throw statusError('A reason is required for retention hold changes');
  const row = await getArtifactRow(artifactId, p);
  await syncRetentionMarker(row, hold ? 'legal_hold' : 'retention_exception', p);
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE divedeep_artifacts SET legal_hold=?,lifecycle_exempt=1,hold_reason_enc=?,hold_set_by=?,hold_set_at=${hold ? 'NOW(3)' : 'NULL'},updated_at=NOW(3) WHERE id=?`, [hold ? 1 : 0, hold ? encryptJson(clean(reason, 1000)) : null, hold ? clean(actorId, 128) : null, row.id]);
    await addEvent(connection, row.id, hold ? 'artifact.hold_applied' : 'artifact.hold_released', 'admin', actorId, { reason: clean(reason, 1000) });
    await addRetentionAction(connection, row.id, hold ? 'hold' : 'release_hold', clean(reason, 1000), actorId);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return getArtifact(row.id, p);
}

async function extendRetention(artifactId, days, reason, actorId, pool = null) {
  const p = pool || getPool();
  const extensionDays = Math.min(Math.max(Number(days) || 0, 1), 365);
  if (!clean(reason, 1000)) throw statusError('A reason is required to extend retention');
  const row = await getArtifactRow(artifactId, p);
  if (row.status === 'deleted') throw statusError('Deleted artifacts cannot have retention extended', 409, 'DIVEDEEP_ARTIFACT_DELETED');
  await syncRetentionMarker(row, 'retention_exception', p);
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE divedeep_artifacts SET lifecycle_exempt=1,expires_at=DATE_ADD(GREATEST(COALESCE(expires_at,NOW(3)),NOW(3)),INTERVAL ? DAY),updated_at=NOW(3) WHERE id=?`, [extensionDays, row.id]);
    await addEvent(connection, row.id, 'artifact.retention_extended', 'admin', actorId, { days: extensionDays, reason: clean(reason, 1000) });
    await addRetentionAction(connection, row.id, 'extend', clean(reason, 1000), actorId);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return getArtifact(row.id, p);
}

async function retentionQueue(filters = {}, pool = null) {
  const p = pool || getPool();
  const limit = Math.min(Math.max(Number(filters.limit) || 250, 1), 500);
  const [rows] = await p.query(
    `SELECT * FROM divedeep_artifacts
     WHERE status<>'deleted' AND (expires_at IS NOT NULL OR legal_hold=1 OR status IN ('quarantined','failed','deletion_pending'))
     ORDER BY legal_hold DESC,COALESCE(expires_at,'9999-12-31') ASC LIMIT ?`, [limit]
  );
  const artifacts = rows.map((row) => ({ ...publicArtifact(row), bucket: row.legal_hold ? 'hold' : (row.expires_at && new Date(row.expires_at) <= new Date() ? 'due' : 'scheduled') }));
  const counts = { due: 0, next24Hours: 0, pendingReview: 0, held: 0, failed: 0 };
  const now = Date.now();
  for (const item of artifacts) {
    if (item.legalHold) counts.held += 1;
    if (item.status === 'failed' || item.status === 'quarantined') counts.failed += 1;
    if (item.retentionClass === 'pending_review') counts.pendingReview += 1;
    if (item.expiresAt) {
      const remaining = new Date(item.expiresAt).getTime() - now;
      if (remaining <= 0) counts.due += 1;
      else if (remaining <= 86400000) counts.next24Hours += 1;
    }
  }
  return { artifacts, counts };
}


async function expireUploadSessions(limit = 250, pool = null) {
  const p = pool || getPool();
  const safeLimit = Math.min(Math.max(Number(limit) || 250, 1), 500);
  const [rows] = await p.query(
    `SELECT s.id AS session_id,s.artifact_id
       FROM divedeep_artifact_upload_sessions s
       JOIN divedeep_artifacts a ON a.id=s.artifact_id
      WHERE s.status IN ('issuing','issued','uploading') AND s.expires_at<=NOW(3)
        AND a.status IN ('reserved','uploading')
      ORDER BY s.expires_at ASC LIMIT ?`, [safeLimit]
  );
  for (const item of rows) {
    const connection = await p.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(`UPDATE divedeep_artifact_upload_sessions SET status='expired',last_error='Upload authorization expired before finalization',updated_at=NOW(3) WHERE id=? AND status IN ('issuing','issued','uploading')`, [item.session_id]);
      await connection.query(`UPDATE divedeep_artifacts SET status='failed',retention_class='failed_upload',review_status='not_required',expires_at=DATE_ADD(NOW(3),INTERVAL 24 HOUR),last_error_code='UPLOAD_AUTHORIZATION_EXPIRED',last_error_message='Upload authorization expired before finalization',updated_at=NOW(3) WHERE id=? AND status IN ('reserved','uploading')`, [item.artifact_id]);
      await addEvent(connection, item.artifact_id, 'artifact.upload_expired', 'system', null, { uploadSessionId: item.session_id });
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  return rows.length;
}

async function runRetentionSweep(options = {}, pool = null) {
  const p = pool || getPool();
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const expiredUploads = await expireUploadSessions(limit, p);
  const [rows] = await p.query(
    `SELECT * FROM divedeep_artifacts
     WHERE legal_hold=0 AND status IN ('available','failed','quarantined','deletion_pending')
       AND expires_at IS NOT NULL AND expires_at<=NOW(3)
     ORDER BY expires_at ASC LIMIT ?`, [limit]
  );
  const result = { expiredUploads, selected: rows.length, deleted: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const actionId = crypto.randomUUID();
    const [claim] = await p.query(`UPDATE divedeep_artifacts SET status='deletion_pending',updated_at=NOW(3) WHERE id=? AND legal_hold=0 AND status<>'deleted'`, [row.id]);
    if (!claim.affectedRows) { result.skipped += 1; continue; }
    await p.query(`INSERT INTO divedeep_retention_actions (id,artifact_id,action,status,reason,execute_after,attempt_count) VALUES (?,?,'delete','running','Retention deadline reached',NOW(3),1)`, [actionId, row.id]);
    try {
      if (row.storage_provider === 's3') await storage.deleteObject({ bucket: row.storage_bucket, objectKey: row.object_key, versionId: row.storage_version_id }, p);
      const connection = await p.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query(`UPDATE divedeep_artifacts SET status='deleted',publication_status='deleted',deleted_at=NOW(3),object_key=NULL,storage_etag=NULL,updated_at=NOW(3) WHERE id=?`, [row.id]);
        await connection.query(`UPDATE divedeep_retention_actions SET status='succeeded',completed_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [actionId]);
        await addEvent(connection, row.id, 'artifact.deleted', 'system', null, { retentionClass: row.retention_class, reason: 'Retention deadline reached' });
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
      result.deleted += 1;
    } catch (error) {
      await p.query(`UPDATE divedeep_artifacts SET status='deletion_pending',last_error_code=?,last_error_message=?,updated_at=NOW(3) WHERE id=?`, [error.code || 'ARTIFACT_DELETE_FAILED', clean(error.message, 2000), row.id]);
      await p.query(`UPDATE divedeep_retention_actions SET status='failed',last_error=?,next_attempt_at=DATE_ADD(NOW(3),INTERVAL 6 HOUR),completed_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [clean(error.message, 2000), actionId]);
      result.failed += 1;
    }
  }
  return result;
}

module.exports = {
  RETENTION_POLICIES,
  ARTIFACT_TYPES,
  expiryForRetention,
  normalizeReservation,
  reserveUpload,
  finalizeUpload,
  getArtifact,
  listArtifacts,
  createAccessGrant,
  updateDisposition,
  setHold,
  extendRetention,
  retentionQueue,
  expireUploadSessions,
  runRetentionSweep,
};
