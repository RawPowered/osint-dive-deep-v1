const crypto = require('crypto');
const { getPool, getWorkPool } = require('../db/pool');
const { getDiveDeepConfig } = require('../config');
const { encryptPii, decryptPii, encryptJson, decryptJson } = require('./divedeepPii');
const { statusError } = require('./divedeepPrivacy');
const {
  detectImage,
  writeEncryptedEvidence,
  readEncryptedEvidence,
  deleteEncryptedEvidence,
  writeEncryptedImportBundle,
  readEncryptedImportBundle,
  deleteEncryptedImportBundle,
  sha256Buffer,
} = require('./diveDeepFiles');
const { extractZipBuffer } = require('./diveDeepZipServer');

const MANIFEST_TYPE = 'divedeep.recon-result-manifest';
const MANIFEST_VERSION = 1;
const MAX_PARTS = 1000;
const MAX_EVIDENCE = 1000;
const MAX_PART_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_FINDINGS = 5000;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_MIME_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
]);
const BATCH_STATUSES = new Set(['created', 'importing', 'ready_review', 'review', 'published', 'failed', 'cancelled', 'expired']);
const PUBLICATION_STATUSES = new Set(['staged', 'approved', 'published', 'rejected']);
const IMPORT_PART_LEASE_MINUTES = 10;
const MAX_FINDING_ERROR_SAMPLES = 25;
const MAX_FINDING_ERROR_GROUPS = 10;
const IMPORT_BUNDLE_MAX_BYTES = 150 * 1024 * 1024;
const IMPORT_BUNDLE_MAX_EXPANDED_BYTES = 250 * 1024 * 1024;
const importJobQueue = [];
const queuedImportJobs = new Set();
let importJobWorkerRunning = false;
const activePublicationCustomers = new Set();

function uuid() { return crypto.randomUUID(); }
function clean(value, max = 255) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : '';
}
function iso(value) { return value ? new Date(value).toISOString() : null; }
function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function requireSha(value, label = 'SHA-256') {
  const digest = clean(value, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw statusError(`${label} is invalid`, 400, 'DIVEDEEP_IMPORT_HASH_INVALID');
  return digest;
}
function requireSafeFileName(value, prefix) {
  const name = clean(value, 255).replace(/\\/g, '/');
  if (!name || name.startsWith('/') || name.includes('../') || !name.startsWith(prefix)) {
    throw statusError('Import manifest contains an unsafe file name', 400, 'DIVEDEEP_IMPORT_FILE_INVALID');
  }
  return name;
}
function normalizeEvidenceMime(value, fileName = '') {
  let mimeType = clean(value || 'application/octet-stream', 96).toLowerCase().split(';', 1)[0].trim();
  mimeType = IMAGE_MIME_ALIASES.get(mimeType) || mimeType;
  if (mimeType === 'application/octet-stream' || !mimeType) {
    if (/\.jpe?g$/i.test(fileName)) mimeType = 'image/jpeg';
    else if (/\.png$/i.test(fileName)) mimeType = 'image/png';
    else if (/\.webp$/i.test(fileName)) mimeType = 'image/webp';
  }
  return mimeType || 'application/octet-stream';
}
function integer(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw statusError(`${label} is invalid`, 400, 'DIVEDEEP_IMPORT_LIMIT_INVALID');
  }
  return number;
}
function sha256Json(value) {
  return crypto.createHash('sha256').update(Buffer.from(JSON.stringify(value), 'utf8')).digest('hex');
}
function mysqlDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}


function compactStoredError(value) {
  const text = clean(value, 2000);
  if (!text || !text.includes(';')) return text;
  const counts = new Map();
  for (const raw of text.split(/;\s*/)) {
    const message = clean(raw, 500);
    if (!message) continue;
    counts.set(message, (counts.get(message) || 0) + 1);
  }
  if (counts.size === 0) return text;
  const compacted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([message, count]) => count > 1 ? `${count}x ${message}` : message)
    .join('; ');
  return compacted.length < text.length ? clean(compacted, 2000) : text;
}

function summarizeFindingErrors(value) {
  const errors = Array.isArray(value) ? value : [];
  const groups = new Map();
  const samples = [];
  for (const item of errors) {
    const code = clean(item?.code || 'DIVEDEEP_DIVEDEEP_FINDING_FAILED', 96);
    const message = clean(item?.error || 'Finding import failed', 500);
    const key = `${code}\u0000${message}`;
    const group = groups.get(key) || { code, message, count: 0, findingKeys: [] };
    group.count += 1;
    const findingKey = clean(item?.findingKey, 128);
    if (findingKey && group.findingKeys.length < 3 && !group.findingKeys.includes(findingKey)) group.findingKeys.push(findingKey);
    groups.set(key, group);
    if (samples.length < MAX_FINDING_ERROR_SAMPLES) {
      samples.push({
        index: Number.isInteger(Number(item?.index)) ? Number(item.index) : null,
        findingKey,
        error: message,
        code,
      });
    }
  }
  const summary = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, MAX_FINDING_ERROR_GROUPS);
  const lastError = clean(summary.map((item) => `${item.count}x [${item.code}] ${item.message}`).join('; '), 2000);
  return { count: errors.length, samples, summary, lastError };
}

function compactImportResult(result) {
  const imported = Array.isArray(result?.imported) ? result.imported : [];
  const diagnostics = summarizeFindingErrors(result?.errors);
  return {
    imported,
    errors: diagnostics.samples,
    errorCount: diagnostics.count,
    errorSummary: diagnostics.summary,
    received: Number(result?.received) || imported.length + diagnostics.count,
  };
}

function normalizeManifest(value, customerId, profileId) {
  const manifest = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!manifest || manifest.packetType !== MANIFEST_TYPE || Number(manifest.schemaVersion) !== MANIFEST_VERSION) {
    throw statusError('Unsupported DiveDeep segmented-result manifest', 400, 'DIVEDEEP_IMPORT_MANIFEST_INVALID');
  }
  if (clean(manifest.customerId, 64) !== customerId || clean(manifest.profileId, 64) !== profileId) {
    throw statusError('The segmented result bundle belongs to a different customer or profile', 409, 'DIVEDEEP_IMPORT_OWNER_MISMATCH');
  }
  const sourceBatchId = clean(manifest.batchId, 64);
  if (!sourceBatchId) throw statusError('The import manifest is missing a batch ID', 400, 'DIVEDEEP_IMPORT_BATCH_ID_REQUIRED');
  const partsInput = Array.isArray(manifest.parts) ? manifest.parts : [];
  const evidenceInput = Array.isArray(manifest.evidence) ? manifest.evidence : [];
  if (!partsInput.length || partsInput.length > MAX_PARTS) throw statusError('The import manifest has an invalid part count', 400, 'DIVEDEEP_IMPORT_PART_COUNT');
  if (evidenceInput.length > MAX_EVIDENCE) throw statusError('The import manifest has too many evidence files', 400, 'DIVEDEEP_IMPORT_EVIDENCE_COUNT');

  const partNames = new Set();
  const partNumbers = new Set();
  const declaredFindingKeys = new Set();
  let findingCount = 0;
  const parts = partsInput.map((item, index) => {
    const fileName = requireSafeFileName(item?.fileName, 'findings/');
    if (partNames.has(fileName)) throw statusError('The import manifest contains duplicate part files');
    partNames.add(fileName);
    const match = fileName.match(/findings-(\d+)\.json$/i);
    const filePartNumber = match ? Number(match[1]) : index + 1;
    const partNumber = item?.partNumber == null
      ? filePartNumber
      : integer(item.partNumber, 1, MAX_PARTS, 'Part number');
    if (match && partNumber !== filePartNumber) throw statusError('A result part number does not match its file name');
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS || partNumbers.has(partNumber)) {
      throw statusError('The import manifest contains duplicate or invalid part numbers');
    }
    partNumbers.add(partNumber);
    const findingKeys = Array.isArray(item.findingKeys) ? item.findingKeys.map((key) => clean(key, 128)).filter(Boolean) : [];
    for (const findingKey of findingKeys) {
      if (declaredFindingKeys.has(findingKey)) throw statusError('The import manifest contains duplicate finding keys');
      declaredFindingKeys.add(findingKey);
    }
    const count = integer(item.findingCount ?? findingKeys.length, 0, 100, 'Finding count');
    if (findingKeys.length && findingKeys.length !== count) throw statusError('A result part finding-key count does not match its finding count');
    findingCount += count;
    return {
      partNumber,
      fileName,
      sha256: requireSha(item.sha256, 'Part SHA-256'),
      byteSize: integer(item.byteSize, 1, MAX_PART_BYTES, 'Part byte size'),
      findingCount: count,
      findingKeys,
    };
  }).sort((a, b) => a.partNumber - b.partNumber);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].partNumber !== index + 1) throw statusError('Result part numbers must be contiguous and start at 1');
  }
  if (findingCount > MAX_FINDINGS) throw statusError('The import bundle exceeds the finding safety limit', 400, 'DIVEDEEP_IMPORT_FINDING_COUNT');

  const evidenceIds = new Set();
  const evidenceNames = new Set();
  const evidence = evidenceInput.map((item) => {
    const evidenceId = clean(item?.evidenceId, 80);
    if (!evidenceId || evidenceIds.has(evidenceId)) throw statusError('The import manifest contains duplicate or invalid evidence IDs');
    evidenceIds.add(evidenceId);
    const fileName = requireSafeFileName(item.fileName, 'evidence/');
    if (evidenceNames.has(fileName)) throw statusError('The import manifest contains duplicate evidence files');
    evidenceNames.add(fileName);
    const mimeType = normalizeEvidenceMime(item.mimeType || item.mediaType, fileName);
    const uploadRequired = IMAGE_MIME_TYPES.has(mimeType) || item.uploadRequired === true;
    if (uploadRequired && !IMAGE_MIME_TYPES.has(mimeType)) {
      throw statusError('Only JPEG, PNG, and WebP evidence files can be uploaded', 415, 'DIVEDEEP_IMPORT_EVIDENCE_TYPE_UNSUPPORTED');
    }
    const byteSize = integer(item.byteSize, 1, MAX_IMAGE_BYTES, 'Evidence byte size');
    return {
      evidenceId,
      fileName,
      sha256: requireSha(item.sha256, 'Evidence SHA-256'),
      byteSize,
      mimeType,
      evidenceType: clean(item.evidenceType || 'candidate_image', 64),
      sensitivity: clean(item.sensitivity, 16).toLowerCase() === 'sensitive' ? 'sensitive' : 'standard',
      capturedAt: clean(item.capturedAt, 64),
      findingKeys: Array.isArray(item.findingKeys) ? item.findingKeys.map((key) => clean(key, 128)).filter(Boolean).slice(0, 500) : [],
      uploadRequired,
    };
  });
  for (const item of evidence) {
    if (item.uploadRequired && !item.findingKeys.length) throw statusError('Image evidence must be linked to at least one finding');
    for (const findingKey of item.findingKeys) {
      if (declaredFindingKeys.size && !declaredFindingKeys.has(findingKey)) {
        throw statusError('Evidence references a finding key that is not declared in the manifest');
      }
    }
  }
  return {
    packetType: MANIFEST_TYPE,
    schemaVersion: MANIFEST_VERSION,
    product: clean(manifest.product || 'DiveDeep', 64),
    generatedAt: clean(manifest.generatedAt, 64),
    batchId: sourceBatchId,
    scope: clean(manifest.scope, 32),
    customerId,
    profileId,
    sessionId: clean(manifest.sessionId, 128),
    summary: manifest.summary && typeof manifest.summary === 'object' ? manifest.summary : {},
    findingCount,
    parts,
    evidence,
  };
}

function serializeBatch(row, detail = {}) {
  return {
    id: row.id,
    customerId: row.customer_id,
    profileId: row.profile_id,
    sourceBatchId: row.source_batch_id,
    manifestSha256: row.manifest_sha256,
    status: row.status,
    partCount: Number(row.part_count) || 0,
    evidenceCount: Number(row.evidence_count) || 0,
    findingCount: Number(row.finding_count) || 0,
    importedCount: Number(row.imported_count) || 0,
    errorCount: Number(row.error_count) || 0,
    lastError: compactStoredError(row.last_error || (row.job_phase === 'failed' ? row.job_message : '')),
    job: row.job_phase ? {
      phase: row.job_phase,
      current: Number(row.job_current) || 0,
      total: Number(row.job_total) || 0,
      percent: Number(row.job_total) > 0 ? Math.min(100, Math.round(((Number(row.job_current) || 0) / Number(row.job_total)) * 100)) : 0,
      message: clean(row.job_message, 500),
      startedAt: iso(row.job_started_at),
      heartbeatAt: iso(row.job_heartbeat_at),
      completedAt: iso(row.job_completed_at),
      bundleUploaded: Boolean(row.bundle_storage_ref),
      safeToRefresh: Boolean(row.bundle_storage_ref) && ['queued','parts','evidence','finalizing','failed'].includes(row.job_phase),
    } : null,
    expiresAt: iso(row.expires_at),
    finalizedAt: iso(row.finalized_at),
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...detail,
  };
}

async function primaryProfileId(customerId, pool) {
  const [rows] = await pool.query(
    `SELECT id FROM divedeep_protected_profiles WHERE tenant_id=? AND status<>'deleted' ORDER BY created_at LIMIT 1`,
    [customerId]
  );
  if (!rows[0]) throw statusError('Customer has not completed onboarding', 409, 'DIVEDEEP_PROFILE_REQUIRED');
  return rows[0].id;
}

async function getBatchRow(customerId, batchId, pool, lock = false) {
  const [rows] = await pool.query(
    `SELECT * FROM divedeep_import_batches WHERE id=? AND customer_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [batchId, customerId]
  );
  if (!rows[0]) throw statusError('Import batch not found', 404, 'DIVEDEEP_IMPORT_BATCH_NOT_FOUND');
  return rows[0];
}

async function importBatchStatus(customerId, batchId, pool = null) {
  const p = pool || getPool();
  return serializeBatch(await getBatchRow(customerId, batchId, p));
}

async function reconcileImportState(customerId, pool, batchId = '') {
  const batchFilter = batchId ? ' AND ib.id=?' : '';
  const params = batchId ? [customerId, batchId] : [customerId];
  await pool.query(
    `UPDATE divedeep_import_parts ip
     JOIN divedeep_import_batches ib ON ib.id=ip.batch_id
     SET ip.status='failed',ip.imported_at=NULL,
         ip.last_error=COALESCE(NULLIF(ip.last_error,''),'A previous importer marked this part complete despite finding-level errors. Retry this part.'),
         ip.updated_at=NOW(3)
     WHERE ib.customer_id=?${batchFilter} AND ip.status='imported' AND ip.error_count>0`,
    params
  );
  await pool.query(
    `UPDATE divedeep_import_parts ip
     JOIN divedeep_import_batches ib ON ib.id=ip.batch_id
     SET ip.status='failed',
         ip.last_error=COALESCE(NULLIF(ip.last_error,''),'The previous part import did not finish and its processing lease expired. Retry this part.'),
         ip.updated_at=NOW(3)
     WHERE ib.customer_id=?${batchFilter} AND ip.status='importing'
       AND ip.updated_at<DATE_SUB(NOW(3), INTERVAL ${IMPORT_PART_LEASE_MINUTES} MINUTE)`,
    params
  );
  await pool.query(
    `UPDATE divedeep_import_batches ib
     SET ib.status='failed',ib.updated_at=NOW(3)
     WHERE ib.customer_id=?${batchId ? ' AND ib.id=?' : ''}
       AND ib.status IN ('created','importing')
       AND EXISTS (SELECT 1 FROM divedeep_import_parts ip WHERE ip.batch_id=ib.id AND ip.status='failed')`,
    params
  );
}

async function batchDetail(customerId, batchId, pool = null) {
  const p = pool || getPool();
  await reconcileImportState(customerId, p, batchId);
  const row = await getBatchRow(customerId, batchId, p);
  const [parts, evidence, findings] = await Promise.all([
    p.query(`SELECT part_number,file_name,sha256,byte_size,finding_count,status,imported_count,error_count,last_error,imported_at FROM divedeep_import_parts WHERE batch_id=? ORDER BY part_number`, [batchId]).then(([rows]) => rows),
    p.query(`SELECT external_evidence_id,file_name,sha256,byte_size,mime_type,evidence_type,sensitivity,status,evidence_file_id,last_error,uploaded_at FROM divedeep_import_evidence WHERE batch_id=? ORDER BY file_name`, [batchId]).then(([rows]) => rows),
    p.query(`SELECT f.finding_key,f.exposure_id,f.case_id,f.part_number,e.status,e.publication_status FROM divedeep_import_findings f JOIN divedeep_exposures e ON e.id=f.exposure_id WHERE f.batch_id=? ORDER BY f.part_number,f.finding_key`, [batchId]).then(([rows]) => rows),
  ]);
  const lastError = parts.find((item) => item.status === 'failed' && item.last_error)?.last_error
    || parts.find((item) => item.last_error)?.last_error
    || evidence.find((item) => item.status === 'failed' && item.last_error)?.last_error
    || evidence.find((item) => item.last_error)?.last_error
    || '';
  return serializeBatch({ ...row, last_error: lastError }, {
    parts: parts.map((item) => ({
      partNumber: Number(item.part_number), fileName: item.file_name, sha256: item.sha256,
      byteSize: Number(item.byte_size), findingCount: Number(item.finding_count), status: item.status,
      importedCount: Number(item.imported_count), errorCount: Number(item.error_count), lastError: compactStoredError(item.last_error), importedAt: iso(item.imported_at),
    })),
    evidence: evidence.map((item) => ({
      evidenceId: item.external_evidence_id, fileName: item.file_name, sha256: item.sha256,
      byteSize: Number(item.byte_size), mimeType: item.mime_type, evidenceType: item.evidence_type,
      sensitivity: item.sensitivity, status: item.status, evidenceFileId: item.evidence_file_id || null,
      lastError: compactStoredError(item.last_error), uploadedAt: iso(item.uploaded_at),
    })),
    findings: findings.map((item) => ({ findingKey: item.finding_key, exposureId: item.exposure_id, caseId: item.case_id || null, partNumber: Number(item.part_number), status: item.status, publicationStatus: item.publication_status })),
  });
}

async function listImportBatches(customerId, pool = null) {
  const p = pool || getPool();
  await reconcileImportState(customerId, p);
  const [rows] = await p.query(
    `SELECT ib.*,
       (SELECT ip.last_error FROM divedeep_import_parts ip
        WHERE ip.batch_id=ib.id AND ip.last_error IS NOT NULL AND ip.last_error<>''
        ORDER BY (ip.status='failed') DESC,ip.updated_at DESC LIMIT 1) last_error
     FROM divedeep_import_batches ib WHERE ib.customer_id=? ORDER BY ib.created_at DESC LIMIT 50`,
    [customerId]
  );
  return rows.map((row) => serializeBatch(row));
}


async function restartClosedImportBatch(customerId, batchId, actorId, pool) {
  const expiryDays = getDiveDeepConfig().importBatchExpiryDays;
  const expiresAt = new Date(Date.now() + (expiryDays * 24 * 60 * 60 * 1000));
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const batch = await getBatchRow(customerId, batchId, connection, true);
    if (!['cancelled', 'expired'].includes(batch.status)) {
      await connection.commit();
      return false;
    }
    await connection.query(`DELETE FROM divedeep_import_findings WHERE batch_id=?`, [batchId]);
    await connection.query(
      `UPDATE divedeep_import_parts
       SET status='pending',imported_count=0,error_count=0,last_error=NULL,imported_at=NULL,updated_at=NOW(3)
       WHERE batch_id=?`,
      [batchId]
    );
    await connection.query(
      `UPDATE divedeep_import_evidence
       SET status=CASE WHEN status='metadata_only' THEN 'metadata_only' ELSE 'pending' END,
           evidence_file_id=NULL,last_error=NULL,uploaded_at=NULL,updated_at=NOW(3)
       WHERE batch_id=?`,
      [batchId]
    );
    await connection.query(
      `UPDATE divedeep_import_batches
       SET status='created',imported_count=0,error_count=0,bundle_storage_ref=NULL,bundle_sha256=NULL,bundle_byte_size=NULL,
           job_phase=NULL,job_current=0,job_total=0,job_message=NULL,job_started_at=NULL,job_heartbeat_at=NULL,job_completed_at=NULL,
           expires_at=?,finalized_at=NULL,published_at=NULL,updated_at=NOW(3)
       WHERE id=? AND customer_id=?`,
      [expiresAt, batchId, customerId]
    );
    const diveDeep = require('./diveDeep');
    await diveDeep.addCustomerEvent(customerId, 'admin.segmented_import_restarted', {
      batchId,
      previousStatus: batch.status,
      sourceBatchId: batch.source_batch_id,
    }, 'admin', actorId, connection);
    await connection.commit();
    if (batch.bundle_storage_ref) {
      try { deleteEncryptedImportBundle(batch.bundle_storage_ref); } catch { /* stale package cleanup is best effort */ }
    }
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function createImportBatch(customerId, manifestValue, manifestSha256, actorId, pool = null) {
  const p = pool || getPool();
  await cleanupExpiredImports(p).catch(() => {});
  const profileId = await primaryProfileId(customerId, p);
  const manifest = normalizeManifest(manifestValue, customerId, profileId);
  const digest = requireSha(manifestSha256 || sha256Json(manifestValue), 'Manifest SHA-256');
  const [existingRows] = await p.query(`SELECT * FROM divedeep_import_batches WHERE customer_id=? AND source_batch_id=? LIMIT 1`, [customerId, manifest.batchId]);
  if (existingRows[0]) {
    if (existingRows[0].manifest_sha256 !== digest) throw statusError('A different manifest already uses this DiveDeep batch ID', 409, 'DIVEDEEP_IMPORT_BATCH_CONFLICT');
    if (['cancelled', 'expired'].includes(existingRows[0].status)) {
      await restartClosedImportBatch(customerId, existingRows[0].id, actorId, p);
    } else {
      await reconcileImportState(customerId, p, existingRows[0].id);
    }
    return batchDetail(customerId, existingRows[0].id, p);
  }
  const id = uuid();
  const expiryDays = getDiveDeepConfig().importBatchExpiryDays;
  const expiresAt = new Date(Date.now() + (expiryDays * 24 * 60 * 60 * 1000));
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO divedeep_import_batches
       (id,customer_id,profile_id,source_batch_id,manifest_sha256,manifest_enc,status,part_count,evidence_count,finding_count,expires_at,created_by)
       VALUES (?,?,?,?,?,?,'created',?,?,?,?,?)`,
      [id, customerId, profileId, manifest.batchId, digest, encryptJson(manifest), manifest.parts.length, manifest.evidence.length, manifest.findingCount, expiresAt, clean(actorId, 128) || null]
    );
    for (const part of manifest.parts) {
      await connection.query(
        `INSERT INTO divedeep_import_parts (id,batch_id,part_number,file_name,sha256,byte_size,finding_count,status)
         VALUES (?,?,?,?,?,?,?,'pending')`,
        [uuid(), id, part.partNumber, part.fileName, part.sha256, part.byteSize, part.findingCount]
      );
    }
    for (const item of manifest.evidence) {
      await connection.query(
        `INSERT INTO divedeep_import_evidence
         (id,batch_id,external_evidence_id,file_name,sha256,byte_size,mime_type,evidence_type,sensitivity,finding_keys_json,status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), id, item.evidenceId, item.fileName, item.sha256, item.byteSize, item.mimeType, item.evidenceType, item.sensitivity, JSON.stringify(item.findingKeys), item.uploadRequired ? 'pending' : 'metadata_only']
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  return batchDetail(customerId, id, p);
}

async function importBatchPart(customerId, batchId, partNumberValue, packet, rawBody, fileSha256, actorId, pool = null) {
  const p = pool || getPool();
  const partNumber = integer(partNumberValue, 1, MAX_PARTS, 'Part number');
  await reconcileImportState(customerId, p, batchId);
  const batch = await getBatchRow(customerId, batchId, p);
  if (!['created', 'importing', 'failed'].includes(batch.status)) throw statusError('This import batch no longer accepts result parts', 409, 'DIVEDEEP_IMPORT_BATCH_CLOSED');
  const [partRows] = await p.query(`SELECT * FROM divedeep_import_parts WHERE batch_id=? AND part_number=? LIMIT 1`, [batchId, partNumber]);
  const part = partRows[0];
  if (!part) throw statusError('This result part is not declared in the manifest', 404, 'DIVEDEEP_IMPORT_PART_NOT_FOUND');
  if (part.status === 'imported' && Number(part.error_count) === 0) {
    return { result: { imported: [], errors: [], errorCount: 0, errorSummary: [], received: Number(part.finding_count), skipped: true }, batch: await batchDetail(customerId, batchId, p) };
  }
  const payload = Buffer.isBuffer(rawBody) && rawBody.length ? rawBody : Buffer.from(JSON.stringify(packet), 'utf8');
  const digest = sha256Buffer(payload);
  if (digest !== part.sha256 || requireSha(fileSha256 || digest) !== part.sha256) throw statusError('Result part SHA-256 does not match the manifest', 409, 'DIVEDEEP_IMPORT_PART_HASH_MISMATCH');
  if (payload.length !== Number(part.byte_size)) throw statusError('Result part byte size does not match the manifest', 409, 'DIVEDEEP_IMPORT_PART_SIZE_MISMATCH');
  if (packet?.packetType !== 'divedeep.recon-results' || Number(packet.schemaVersion) !== 1 ||
      clean(packet?.batch?.batchId, 64) !== batch.source_batch_id || Number(packet?.batch?.part) !== partNumber ||
      Number(packet?.batch?.totalParts) !== Number(batch.part_count)) {
    throw statusError('Result part metadata does not match the import batch', 409, 'DIVEDEEP_IMPORT_PART_METADATA_MISMATCH');
  }
  const packetFindings = Array.isArray(packet.findings) ? packet.findings : [];
  if (packetFindings.length !== Number(part.finding_count)) {
    throw statusError('Result part finding count does not match the manifest', 409, 'DIVEDEEP_IMPORT_PART_FINDING_COUNT_MISMATCH');
  }
  const [claim] = await p.query(
    `UPDATE divedeep_import_parts
     SET status='importing',imported_count=0,error_count=0,last_error=NULL,imported_at=NULL,updated_at=NOW(3)
     WHERE batch_id=? AND part_number=? AND status IN ('pending','failed')`,
    [batchId, partNumber]
  );
  if (Number(claim.affectedRows) !== 1) throw statusError('Result part is already being imported', 409, 'DIVEDEEP_IMPORT_PART_BUSY');
  await p.query(`UPDATE divedeep_import_batches SET status='importing',updated_at=NOW(3) WHERE id=?`, [batchId]);
  try {
    const diveDeep = require('./diveDeep');
    const rawResult = await diveDeep.importDiveDeepResultPacket(customerId, packet, actorId, p, {
      suppressEvent: true,
      deferWorkflow: true,
      importBatchId: batchId,
    });
    for (const item of rawResult.imported) {
      if (item.priorPublicationStatus !== 'published') {
        const publicationStatus = ['false_positive', 'ignored'].includes(item.status)
          ? 'rejected'
          : ['confirmed', 'preserved', 'removed', 'reappeared'].includes(item.status)
            ? 'approved'
            : 'staged';
        await p.query(`UPDATE divedeep_exposures SET publication_status=?,updated_at=NOW(3) WHERE id=? AND tenant_id=?`, [publicationStatus, item.exposureId, customerId]);
      }
      await p.query(
        `INSERT INTO divedeep_import_findings (id,batch_id,part_number,finding_key,exposure_id,case_id)
         VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE exposure_id=VALUES(exposure_id),case_id=VALUES(case_id)`,
        [uuid(), batchId, partNumber, clean(item.findingKey, 128) || `part-${partNumber}-exposure-${item.exposureId}`, item.exposureId, item.caseId || null]
      );
    }
    const result = compactImportResult(rawResult);
    const partStatus = result.errorCount > 0 ? 'failed' : 'imported';
    await p.query(
      `UPDATE divedeep_import_parts SET status=?,imported_count=?,error_count=?,last_error=?,
         imported_at=CASE WHEN ?='imported' THEN NOW(3) ELSE NULL END,updated_at=NOW(3)
       WHERE batch_id=? AND part_number=?`,
      [partStatus, result.imported.length, result.errorCount, result.errorCount ? summarizeFindingErrors(rawResult.errors).lastError : null, partStatus, batchId, partNumber]
    );
    await refreshBatchCounts(batchId, p);
    if (result.errorCount > 0) {
      await p.query(`UPDATE divedeep_import_batches SET status='failed',updated_at=NOW(3) WHERE id=?`, [batchId]);
    }
    return { result, batch: await batchDetail(customerId, batchId, p) };
  } catch (error) {
    await p.query(`UPDATE divedeep_import_parts SET status='failed',last_error=?,updated_at=NOW(3) WHERE batch_id=? AND part_number=?`, [clean(error.message, 2000), batchId, partNumber]);
    await p.query(`UPDATE divedeep_import_batches SET status='failed',updated_at=NOW(3) WHERE id=?`, [batchId]);
    await refreshBatchCounts(batchId, p);
    throw error;
  }
}

async function refreshBatchCounts(batchId, pool) {
  const [[partRow], [findingRow]] = await Promise.all([
    pool.query(`SELECT SUM(imported_count) imported_count,SUM(error_count) error_count FROM divedeep_import_parts WHERE batch_id=?`, [batchId]).then(([rows]) => rows),
    pool.query(`SELECT COUNT(*) count FROM divedeep_import_findings WHERE batch_id=?`, [batchId]).then(([rows]) => rows),
  ]);
  await pool.query(
    `UPDATE divedeep_import_batches
     SET imported_count=?,error_count=?,
         status=CASE WHEN ?>0 AND status IN ('created','importing') THEN 'failed' ELSE status END,
         updated_at=NOW(3) WHERE id=?`,
    [Number(findingRow?.count) || Number(partRow?.imported_count) || 0, Number(partRow?.error_count) || 0, Number(partRow?.error_count) || 0, batchId]
  );
}

async function uploadBatchEvidence(customerId, batchId, externalEvidenceId, file, actorId, pool = null) {
  const p = pool || getPool();
  const batch = await getBatchRow(customerId, batchId, p);
  if (!['created', 'importing', 'failed', 'ready_review', 'review'].includes(batch.status)) throw statusError('This import batch no longer accepts evidence uploads', 409, 'DIVEDEEP_IMPORT_BATCH_CLOSED');
  const [rows] = await p.query(`SELECT * FROM divedeep_import_evidence WHERE batch_id=? AND external_evidence_id=? LIMIT 1`, [batchId, clean(externalEvidenceId, 80)]);
  const expected = rows[0];
  if (!expected) throw statusError('This evidence file is not declared in the manifest', 404, 'DIVEDEEP_IMPORT_EVIDENCE_NOT_FOUND');
  if (expected.status === 'metadata_only') throw statusError('This evidence record does not require a file upload', 409, 'DIVEDEEP_IMPORT_EVIDENCE_METADATA_ONLY');
  if (expected.status === 'uploaded') return batchDetail(customerId, batchId, p);
  if (!file || !Buffer.isBuffer(file.buffer)) throw statusError('Evidence image is required');
  if (file.buffer.length !== Number(expected.byte_size) || file.buffer.length > MAX_IMAGE_BYTES) throw statusError('Evidence byte size does not match the manifest', 409, 'DIVEDEEP_IMPORT_EVIDENCE_SIZE_MISMATCH');
  const digest = sha256Buffer(file.buffer);
  if (digest !== expected.sha256 || (file.sha256 && requireSha(file.sha256) !== expected.sha256)) throw statusError('Evidence SHA-256 does not match the manifest', 409, 'DIVEDEEP_IMPORT_EVIDENCE_HASH_MISMATCH');
  const detected = detectImage(file.buffer, normalizeEvidenceMime(file.mimeType, expected.file_name));
  if (!detected || detected.mimeType !== normalizeEvidenceMime(expected.mime_type, expected.file_name)) throw statusError('Evidence image type does not match the manifest', 415, 'DIVEDEEP_IMPORT_EVIDENCE_TYPE_MISMATCH');
  const findingKeys = parseJson(expected.finding_keys_json, []);
  if (!findingKeys.length) throw statusError('Evidence is not linked to a finding', 409, 'DIVEDEEP_IMPORT_EVIDENCE_UNLINKED');
  const placeholders = findingKeys.map(() => '?').join(',');
  const [findingRows] = await p.query(`SELECT finding_key,exposure_id FROM divedeep_import_findings WHERE batch_id=? AND finding_key IN (${placeholders})`, [batchId, ...findingKeys]);
  if (!findingRows.length) throw statusError('Import the matching result part before uploading this evidence file', 409, 'DIVEDEEP_IMPORT_EVIDENCE_WAITING_FOR_FINDING');

  let evidenceId;
  let storageRef = '';
  const [existingRows] = await p.query(`SELECT * FROM divedeep_evidence_files WHERE customer_id=? AND sha256=? AND publication_status<>'deleted' LIMIT 1`, [customerId, digest]);
  if (existingRows[0]) {
    evidenceId = existingRows[0].id;
    await p.query(
      `UPDATE divedeep_evidence_files
       SET import_batch_id=?,external_evidence_id=?,
           sensitivity=CASE WHEN ?='sensitive' THEN 'sensitive' ELSE sensitivity END,
           publication_status=CASE WHEN publication_status='published' THEN 'published' ELSE 'staged' END,
           updated_at=NOW(3)
       WHERE id=?`,
      [batchId, expected.external_evidence_id, expected.sensitivity, evidenceId]
    );
  } else {
    evidenceId = uuid();
    storageRef = writeEncryptedEvidence(customerId, evidenceId, file.buffer);
    try {
      await p.query(
        `INSERT INTO divedeep_evidence_files
         (id,customer_id,profile_id,import_batch_id,external_evidence_id,evidence_type,label_enc,original_name_enc,mime_type,byte_size,sha256,storage_ref,sensitivity,publication_status,captured_at,metadata_enc,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'staged',?,?,?)`,
        [evidenceId, customerId, batch.profile_id, batchId, expected.external_evidence_id, expected.evidence_type,
          encryptPii(clean(file.label || expected.evidence_type, 255)), encryptPii(clean(file.originalName || expected.file_name.split('/').pop(), 255)),
          detected.mimeType, file.buffer.length, digest, storageRef, expected.sensitivity, mysqlDate(file.capturedAt),
          encryptJson({ source: 'divedeep-segmented-import', manifestFileName: expected.file_name }), clean(actorId, 128) || null]
      );
    } catch (error) {
      deleteEncryptedEvidence(storageRef);
      throw error;
    }
  }
  for (const finding of findingRows) {
    await p.query(
      `INSERT IGNORE INTO divedeep_evidence_links (id,evidence_id,exposure_id,finding_key,relationship) VALUES (?,?,?,?,?)`,
      [uuid(), evidenceId, finding.exposure_id, finding.finding_key, 'supports']
    );
    await p.query(
      `UPDATE divedeep_exposures SET evidence_ref=COALESCE(evidence_ref,?),evidence_sha256=COALESCE(evidence_sha256,?),updated_at=NOW(3) WHERE id=? AND tenant_id=?`,
      [`divedeep://evidence/${evidenceId}`, digest, finding.exposure_id, customerId]
    );
  }
  await p.query(
    `UPDATE divedeep_import_evidence SET status='uploaded',evidence_file_id=?,last_error=NULL,uploaded_at=NOW(3),updated_at=NOW(3)
     WHERE batch_id=? AND external_evidence_id=?`,
    [evidenceId, batchId, expected.external_evidence_id]
  );
  return batchDetail(customerId, batchId, p);
}

async function finalizeImportBatch(customerId, batchId, actorId, pool = null) {
  const p = pool || getPool();
  await getBatchRow(customerId, batchId, p);
  const [[partCounts], [evidenceCounts]] = await Promise.all([
    p.query(`SELECT COUNT(*) total,SUM(status='imported') complete,SUM(status='failed') failed,SUM(error_count) errors FROM divedeep_import_parts WHERE batch_id=?`, [batchId]).then(([rows]) => rows),
    p.query(`SELECT COUNT(*) total,SUM(status IN ('uploaded','metadata_only')) complete,SUM(status='failed') failed FROM divedeep_import_evidence WHERE batch_id=?`, [batchId]).then(([rows]) => rows),
  ]);
  if (Number(partCounts.complete) !== Number(partCounts.total) || Number(evidenceCounts.complete) !== Number(evidenceCounts.total)) {
    throw statusError('Import batch is incomplete. Finish all result parts and evidence uploads first', 409, 'DIVEDEEP_IMPORT_INCOMPLETE');
  }
  if (Number(partCounts.failed) || Number(evidenceCounts.failed)) throw statusError('Import batch contains failed files', 409, 'DIVEDEEP_IMPORT_FAILED_FILES');
  if (Number(partCounts.errors)) {
    throw statusError('Import batch contains finding errors. Retry the failed parts after correcting the reported finding issue', 409, 'DIVEDEEP_IMPORT_FINDING_ERRORS');
  }
  await p.query(`UPDATE divedeep_import_batches SET status='ready_review',finalized_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [batchId]);
  await p.query(`UPDATE divedeep_customers SET workflow_status='results_ready',updated_at=NOW(3) WHERE id=?`, [customerId]);
  const diveDeep = require('./diveDeep');
  await diveDeep.addCustomerEvent(customerId, 'admin.segmented_import_ready', { batchId }, 'admin', actorId, p);
  return batchDetail(customerId, batchId, p);
}


function packageEntry(entries, fileName) {
  return entries.get(String(fileName || '').replace(/\\/g, '/')) || null;
}

function validateBundleRecords(batch, entries) {
  for (const part of batch.parts || []) {
    const payload = packageEntry(entries, part.fileName);
    if (!payload) throw statusError(`The uploaded ZIP is missing ${part.fileName}`, 400, 'DIVEDEEP_IMPORT_BUNDLE_FILE_MISSING');
    if (payload.length !== Number(part.byteSize)) throw statusError(`File size mismatch: ${part.fileName}`, 409, 'DIVEDEEP_IMPORT_PART_SIZE_MISMATCH');
    if (sha256Buffer(payload) !== part.sha256) throw statusError(`SHA-256 mismatch: ${part.fileName}`, 409, 'DIVEDEEP_IMPORT_PART_HASH_MISMATCH');
  }
  for (const item of batch.evidence || []) {
    if (item.status === 'metadata_only') continue;
    const payload = packageEntry(entries, item.fileName);
    if (!payload) throw statusError(`The uploaded ZIP is missing ${item.fileName}`, 400, 'DIVEDEEP_IMPORT_BUNDLE_FILE_MISSING');
    if (payload.length !== Number(item.byteSize)) throw statusError(`File size mismatch: ${item.fileName}`, 409, 'DIVEDEEP_IMPORT_EVIDENCE_SIZE_MISMATCH');
    if (sha256Buffer(payload) !== item.sha256) throw statusError(`SHA-256 mismatch: ${item.fileName}`, 409, 'DIVEDEEP_IMPORT_EVIDENCE_HASH_MISMATCH');
  }
}

function importJobCounts(batch) {
  const parts = batch.parts || [];
  const evidence = batch.evidence || [];
  const partComplete = parts.filter((item) => item.status === 'imported' && Number(item.errorCount || 0) === 0).length;
  const evidenceComplete = evidence.filter((item) => ['uploaded', 'metadata_only'].includes(item.status)).length;
  return { current: partComplete + evidenceComplete, total: parts.length + evidence.length + 1 };
}

async function updateImportJob(pool, batchId, values = {}) {
  const phase = clean(values.phase, 32) || null;
  const current = Math.max(0, Number(values.current) || 0);
  const total = Math.max(current, Number(values.total) || 0);
  const message = clean(values.message, 500) || null;
  await pool.query(
    `UPDATE divedeep_import_batches
     SET job_phase=?,job_current=?,job_total=?,job_message=?,job_heartbeat_at=NOW(3),
         job_started_at=COALESCE(job_started_at,NOW(3)),
         job_completed_at=CASE WHEN ? IN ('complete','cancelled') THEN NOW(3) ELSE job_completed_at END,
         updated_at=NOW(3) WHERE id=?`,
    [phase, current, total, message, phase, batchId]
  );
}

function queueImportJob(customerId, batchId, actorId = 'system') {
  const key = `${customerId}:${batchId}`;
  if (queuedImportJobs.has(key)) return false;
  queuedImportJobs.add(key);
  importJobQueue.push({ customerId, batchId, actorId: clean(actorId, 128) || 'system', key });
  setImmediate(drainImportJobQueue);
  return true;
}

async function drainImportJobQueue() {
  if (importJobWorkerRunning) return;
  importJobWorkerRunning = true;
  try {
    while (importJobQueue.length) {
      const job = importJobQueue.shift();
      try { await runImportBundleJob(job.customerId, job.batchId, job.actorId); }
      catch (error) { console.warn(`DiveDeep background import failed code=${error.code || error.name || 'IMPORT_JOB_FAILED'}`); }
      finally { queuedImportJobs.delete(job.key); }
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    importJobWorkerRunning = false;
  }
}

async function enqueueImportBundle(customerId, zipBuffer, actorId, pool = null) {
  const p = pool || getPool();
  if (!Buffer.isBuffer(zipBuffer) || !zipBuffer.length) throw statusError('A DiveDeep ZIP is required', 400, 'DIVEDEEP_IMPORT_BUNDLE_REQUIRED');
  if (zipBuffer.length > IMPORT_BUNDLE_MAX_BYTES) throw statusError('The DiveDeep ZIP exceeds the 150 MB server import limit', 413, 'DIVEDEEP_IMPORT_BUNDLE_TOO_LARGE');
  const archive = extractZipBuffer(zipBuffer, {
    maxArchiveBytes: IMPORT_BUNDLE_MAX_BYTES,
    maxExpandedBytes: IMPORT_BUNDLE_MAX_EXPANDED_BYTES,
    maxEntryBytes: MAX_IMAGE_BYTES,
    maxEntries: 2100,
  });
  const manifestBytes = archive.entries.get('manifest.json');
  if (!manifestBytes) throw statusError('manifest.json was not found in the DiveDeep ZIP', 400, 'DIVEDEEP_IMPORT_MANIFEST_MISSING');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw statusError('manifest.json is not valid JSON', 400, 'DIVEDEEP_IMPORT_MANIFEST_INVALID'); }
  const batch = await createImportBatch(customerId, manifest, sha256Buffer(manifestBytes), actorId, p);
  if (['ready_review', 'review', 'published'].includes(batch.status)) {
    throw statusError('This DiveDeep batch has already completed import', 409, 'DIVEDEEP_IMPORT_ALREADY_COMPLETE');
  }
  validateBundleRecords(batch, archive.entries);
  const bundleSha256 = sha256Buffer(zipBuffer);
  const storageRef = writeEncryptedImportBundle(customerId, batch.id, zipBuffer);
  const counts = importJobCounts(batch);
  await p.query(
    `UPDATE divedeep_import_batches
     SET bundle_storage_ref=?,bundle_sha256=?,bundle_byte_size=?,status='importing',job_phase='queued',
         job_current=?,job_total=?,job_message='Package uploaded. Waiting for the background importer.',
         job_started_at=NULL,job_heartbeat_at=NOW(3),job_completed_at=NULL,updated_at=NOW(3)
     WHERE id=? AND customer_id=?`,
    [storageRef, bundleSha256, zipBuffer.length, counts.current, counts.total, batch.id, customerId]
  );
  const diveDeep = require('./diveDeep');
  await diveDeep.addCustomerEvent(customerId, 'admin.segmented_import_queued', {
    batchId: batch.id,
    sourceBatchId: batch.sourceBatchId,
    archiveBytes: archive.archiveBytes,
    expandedBytes: archive.expandedBytes,
  }, 'admin', actorId, p);
  queueImportJob(customerId, batch.id, actorId);
  return batchDetail(customerId, batch.id, p);
}

async function runImportBundleJob(customerId, batchId, actorId = 'system', pool = null) {
  const p = pool || getWorkPool();
  const [claim] = await p.query(
    `UPDATE divedeep_import_batches SET job_phase='parts',status='importing',job_message='Opening verified package…',
       job_started_at=COALESCE(job_started_at,NOW(3)),job_heartbeat_at=NOW(3),updated_at=NOW(3)
     WHERE id=? AND customer_id=? AND job_phase='queued' AND bundle_storage_ref IS NOT NULL`,
    [batchId, customerId]
  );
  if (Number(claim.affectedRows) !== 1) return batchDetail(customerId, batchId, p);
  let row = await getBatchRow(customerId, batchId, p);
  let total = Number(row.job_total) || 1;
  let current = Number(row.job_current) || 0;
  try {
    const zipBuffer = readEncryptedImportBundle(row.bundle_storage_ref);
    if (row.bundle_sha256 && sha256Buffer(zipBuffer) !== row.bundle_sha256) throw statusError('Stored import package failed integrity verification', 409, 'DIVEDEEP_IMPORT_BUNDLE_HASH_MISMATCH');
    const archive = extractZipBuffer(zipBuffer, {
      maxArchiveBytes: IMPORT_BUNDLE_MAX_BYTES,
      maxExpandedBytes: IMPORT_BUNDLE_MAX_EXPANDED_BYTES,
      maxEntryBytes: MAX_IMAGE_BYTES,
      maxEntries: 2100,
    });
    let detail = await batchDetail(customerId, batchId, p);
    validateBundleRecords(detail, archive.entries);
    const counts = importJobCounts(detail);
    current = counts.current;
    total = counts.total;
    await updateImportJob(p, batchId, { phase: 'parts', current, total, message: `Importing result parts (${current}/${total})` });

    for (const part of detail.parts || []) {
      if (part.status === 'imported' && Number(part.errorCount || 0) === 0) continue;
      const payload = packageEntry(archive.entries, part.fileName);
      let packet;
      try { packet = JSON.parse(payload.toString('utf8')); }
      catch { throw statusError(`${part.fileName} is not valid JSON`, 400, 'DIVEDEEP_IMPORT_PART_JSON_INVALID'); }
      await updateImportJob(p, batchId, { phase: 'parts', current, total, message: `Importing ${part.fileName}` });
      const imported = await importBatchPart(customerId, batchId, part.partNumber, packet, payload, part.sha256, actorId, p);
      const errorCount = Number(imported.result?.errorCount) || 0;
      if (errorCount) throw statusError(findingImportMessageForJob(imported.result), 422, 'DIVEDEEP_IMPORT_PART_FINDINGS_FAILED');
      current += 1;
      await updateImportJob(p, batchId, { phase: 'parts', current, total, message: `Imported ${part.fileName}` });
      await new Promise((resolve) => setImmediate(resolve));
    }

    detail = await batchDetail(customerId, batchId, p);
    await updateImportJob(p, batchId, { phase: 'evidence', current, total, message: 'Storing verified evidence files' });
    for (const item of detail.evidence || []) {
      if (['uploaded', 'metadata_only'].includes(item.status)) continue;
      const payload = packageEntry(archive.entries, item.fileName);
      await updateImportJob(p, batchId, { phase: 'evidence', current, total, message: `Storing ${item.fileName}` });
      await uploadBatchEvidence(customerId, batchId, item.evidenceId, {
        buffer: payload,
        mimeType: item.mimeType,
        sha256: item.sha256,
        originalName: item.fileName.split('/').pop(),
        label: item.evidenceType,
      }, actorId, p);
      current += 1;
      await updateImportJob(p, batchId, { phase: 'evidence', current, total, message: `Stored ${item.fileName}` });
      await new Promise((resolve) => setImmediate(resolve));
    }

    await updateImportJob(p, batchId, { phase: 'finalizing', current, total, message: 'Finalizing private review workspace' });
    const finalized = await finalizeImportBatch(customerId, batchId, actorId, p);
    current = total;
    await updateImportJob(p, batchId, { phase: 'complete', current, total, message: 'Import complete. Findings are ready for review.' });
    try { deleteEncryptedImportBundle(row.bundle_storage_ref); }
    catch { /* encrypted package cleanup is best effort */ }
    await p.query(`UPDATE divedeep_import_batches SET bundle_storage_ref=NULL,updated_at=NOW(3) WHERE id=? AND customer_id=?`, [batchId, customerId]);
    return finalized;
  } catch (error) {
    await p.query(
      `UPDATE divedeep_import_batches SET status='failed',job_phase='failed',job_message=?,job_heartbeat_at=NOW(3),updated_at=NOW(3)
       WHERE id=? AND customer_id=?`,
      [clean(error.message, 500) || 'Background import failed', batchId, customerId]
    );
    const diveDeep = require('./diveDeep');
    await diveDeep.addCustomerEvent(customerId, 'admin.segmented_import_job_failed', { batchId, code: error.code || '', message: clean(error.message, 500) }, 'admin', actorId, p).catch(() => {});
    throw error;
  }
}

function findingImportMessageForJob(result) {
  const count = Number(result?.errorCount ?? result?.errors?.length) || 0;
  const groups = Array.isArray(result?.errorSummary) ? result.errorSummary : [];
  const detail = groups.slice(0, 3).map((item) => `${Number(item.count) || 1}x [${item.code || 'FINDING_FAILED'}] ${item.message || 'Finding import failed'}`).join('; ');
  return `${count || 'One or more'} finding${count === 1 ? '' : 's'} failed${detail ? `: ${detail}` : ''}`;
}

async function resumeImportBundleJob(customerId, batchId, actorId, pool = null) {
  const p = pool || getPool();
  const row = await getBatchRow(customerId, batchId, p);
  if (!row.bundle_storage_ref) throw statusError('The server no longer has the source package. Upload the DiveDeep ZIP again.', 409, 'DIVEDEEP_IMPORT_BUNDLE_REQUIRED');
  if (['ready_review', 'review', 'published', 'cancelled', 'expired'].includes(row.status)) throw statusError('This import batch cannot be resumed', 409, 'DIVEDEEP_IMPORT_BATCH_CLOSED');
  await p.query(
    `UPDATE divedeep_import_batches SET status='importing',job_phase='queued',job_message='Resume requested. Waiting for the background importer.',
       job_heartbeat_at=NOW(3),job_completed_at=NULL,updated_at=NOW(3) WHERE id=? AND customer_id=?`,
    [batchId, customerId]
  );
  queueImportJob(customerId, batchId, actorId);
  return batchDetail(customerId, batchId, p);
}

async function resumePendingImportJobs(pool = null) {
  const p = pool || getPool();
  await p.query(
    `UPDATE divedeep_import_batches SET job_phase='queued',job_message='Server restarted. Import queued for recovery.',updated_at=NOW(3)
     WHERE bundle_storage_ref IS NOT NULL AND job_phase IN ('parts','evidence','finalizing')`
  );
  const [rows] = await p.query(
    `SELECT id,customer_id,COALESCE(created_by,'system') actor_id FROM divedeep_import_batches
     WHERE bundle_storage_ref IS NOT NULL AND job_phase='queued' ORDER BY updated_at ASC LIMIT 100`
  );
  for (const row of rows) queueImportJob(row.customer_id, row.id, row.actor_id);
  return { queued: rows.length };
}

async function setFindingsPublicationUnlocked(customerId, exposureIds, publicationStatus, actorId, pool = null) {
  const p = pool || getWorkPool();
  const next = clean(publicationStatus, 16).toLowerCase();
  if (!PUBLICATION_STATUSES.has(next)) throw statusError('Invalid publication status');
  const ids = [...new Set((Array.isArray(exposureIds) ? exposureIds : [exposureIds]).map((id) => clean(id, 64)).filter(Boolean))].sort();
  if (!ids.length) throw statusError('Select at least one finding', 400, 'DIVEDEEP_FINDING_SELECTION_REQUIRED');
  if (ids.length > 500) throw statusError('A maximum of 500 findings can be updated at once', 400, 'DIVEDEEP_FINDING_SELECTION_LIMIT');
  const placeholders = ids.map(() => '?').join(',');
  const connection = typeof p.getConnection === 'function' ? await p.getConnection() : p;
  const ownsConnection = connection !== p;
  try {
    if (typeof connection.beginTransaction === 'function') await connection.beginTransaction();
    try { await connection.query('SET SESSION innodb_lock_wait_timeout=15'); } catch { /* managed database may restrict session settings */ }
    const [rows] = await connection.query(
      `SELECT id FROM divedeep_exposures WHERE tenant_id=? AND id IN (${placeholders}) FOR UPDATE`,
      [customerId, ...ids]
    );
    if (rows.length !== ids.length) throw statusError('One or more findings were not found', 404, 'DIVEDEEP_FINDING_NOT_FOUND');
    await connection.query(
      `UPDATE divedeep_exposures SET publication_status=?,status=CASE WHEN ?='rejected' THEN 'false_positive' ELSE status END,updated_at=NOW(3)
       WHERE tenant_id=? AND id IN (${placeholders})`,
      [next, next, customerId, ...ids]
    );
    const targetJoin = `JOIN (SELECT DISTINCT evidence_id FROM divedeep_evidence_links WHERE exposure_id IN (${placeholders})) target ON target.evidence_id=ef.id`;
    if (next === 'published') {
      await connection.query(
        `UPDATE divedeep_evidence_files ef ${targetJoin}
         SET ef.publication_status='published',ef.updated_at=NOW(3)
         WHERE ef.customer_id=? AND ef.publication_status<>'deleted'`,
        [...ids, customerId]
      );
    } else if (next === 'approved') {
      await connection.query(
        `UPDATE divedeep_evidence_files ef ${targetJoin}
         SET ef.publication_status='approved',ef.updated_at=NOW(3)
         WHERE ef.customer_id=? AND ef.publication_status='staged'`,
        [...ids, customerId]
      );
    } else {
      const evidenceStatus = next === 'rejected' ? 'rejected' : 'staged';
      await connection.query(
        `UPDATE divedeep_evidence_files ef ${targetJoin}
         SET ef.publication_status=?,ef.updated_at=NOW(3)
         WHERE ef.customer_id=? AND ef.publication_status<>'deleted'
           AND NOT EXISTS (
             SELECT 1 FROM divedeep_evidence_links el2
             JOIN divedeep_exposures e2 ON e2.id=el2.exposure_id
             WHERE el2.evidence_id=ef.id AND e2.publication_status='published'
           )`,
        [...ids, evidenceStatus, customerId]
      );
    }
    const diveDeep = require('./diveDeep');
    await diveDeep.addCustomerEvent(customerId, 'admin.finding_publication_changed', {
      exposureIds: ids,
      count: ids.length,
      publicationStatus: next,
    }, 'admin', actorId, connection);
    if (typeof connection.commit === 'function') await connection.commit();
    return { exposureIds: ids, publicationStatus: next, updated: ids.length };
  } catch (error) {
    if (typeof connection.rollback === 'function') await connection.rollback().catch(() => {});
    throw error;
  } finally {
    if (ownsConnection) connection.release();
  }
}

async function setFindingsPublication(customerId, exposureIds, publicationStatus, actorId, pool = null) {
  const lockKey = clean(customerId, 64);
  if (activePublicationCustomers.has(lockKey)) {
    throw statusError(
      'Another evidence review update is already running for this customer. Wait for it to finish, then retry.',
      409,
      'DIVEDEEP_REVIEW_UPDATE_BUSY'
    );
  }
  activePublicationCustomers.add(lockKey);
  try {
    return await setFindingsPublicationUnlocked(customerId, exposureIds, publicationStatus, actorId, pool);
  } finally {
    activePublicationCustomers.delete(lockKey);
  }
}

async function setFindingPublication(customerId, exposureId, publicationStatus, actorId, pool = null) {
  const result = await setFindingsPublication(customerId, [exposureId], publicationStatus, actorId, pool);
  return { exposureId, publicationStatus: result.publicationStatus };
}

async function publishImportBatch(customerId, batchId, input, actorId, pool = null) {
  const p = pool || getPool();
  const batch = await getBatchRow(customerId, batchId, p);
  if (!['ready_review', 'review', 'published'].includes(batch.status)) throw statusError('Finalize the import batch before publishing', 409, 'DIVEDEEP_IMPORT_NOT_READY');
  const [rows] = await p.query(
    `SELECT DISTINCT f.exposure_id,e.status,e.publication_status FROM divedeep_import_findings f
     JOIN divedeep_exposures e ON e.id=f.exposure_id WHERE f.batch_id=?`,
    [batchId]
  );
  const allowed = new Set(rows.map((row) => row.exposure_id));
  const defaultPublish = rows.filter((row) => row.publication_status === 'approved' && !['false_positive','ignored'].includes(row.status)).map((row) => row.exposure_id);
  const automaticReject = rows.filter((row) => ['false_positive','ignored'].includes(row.status) || row.publication_status === 'rejected').map((row) => row.exposure_id);
  const selected = Array.isArray(input?.exposureIds) && input.exposureIds.length ? input.exposureIds.map((id) => clean(id, 64)).filter((id) => allowed.has(id)) : defaultPublish;
  const rejected = Array.isArray(input?.rejectExposureIds) ? input.rejectExposureIds.map((id) => clean(id, 64)).filter((id) => allowed.has(id)) : automaticReject;
  if (selected.length) await setFindingsPublication(customerId, selected, 'published', actorId, p);
  if (rejected.length) await setFindingsPublication(customerId, rejected, 'rejected', actorId, p);
  const [remainingRows] = await p.query(
    `SELECT COUNT(*) count FROM divedeep_import_findings f JOIN divedeep_exposures e ON e.id=f.exposure_id
     WHERE f.batch_id=? AND e.publication_status IN ('staged','approved')`,
    [batchId]
  );
  const complete = Number(remainingRows[0]?.count) === 0;
  await p.query(`UPDATE divedeep_import_batches SET status=?,published_at=CASE WHEN ? THEN NOW(3) ELSE published_at END,updated_at=NOW(3) WHERE id=?`, [complete ? 'published' : 'review', complete ? 1 : 0, batchId]);
  const diveDeep = require('./diveDeep');
  await diveDeep.addCustomerEvent(customerId, 'admin.segmented_import_published', { batchId, published: selected.length, rejected: rejected.length, complete }, 'admin', actorId, p);
  return batchDetail(customerId, batchId, p);
}

async function cancelImportBatch(customerId, batchId, actorId, pool = null) {
  const p = pool || getPool();
  const batch = await getBatchRow(customerId, batchId, p);
  if (['published', 'cancelled', 'expired'].includes(batch.status)) {
    if (batch.status === 'cancelled') return batchDetail(customerId, batchId, p);
    throw statusError('This import batch cannot be cancelled', 409, 'DIVEDEEP_IMPORT_BATCH_CLOSED');
  }
  await p.query(
    `UPDATE divedeep_exposures e JOIN divedeep_import_findings f ON f.exposure_id=e.id
     SET e.publication_status='rejected',e.updated_at=NOW(3)
     WHERE f.batch_id=? AND e.tenant_id=? AND e.publication_status IN ('staged','approved')`,
    [batchId, customerId]
  );
  await p.query(
    `UPDATE divedeep_evidence_files SET publication_status='rejected',updated_at=NOW(3)
     WHERE import_batch_id=? AND customer_id=? AND publication_status IN ('staged','approved')`,
    [batchId, customerId]
  );
  await p.query(`UPDATE divedeep_import_batches SET status='cancelled',job_phase='cancelled',job_message='Import cancelled by an administrator.',job_completed_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [batchId]);
  if (batch.bundle_storage_ref) {
    try { deleteEncryptedImportBundle(batch.bundle_storage_ref); } catch { /* encrypted package cleanup is best effort */ }
    await p.query(`UPDATE divedeep_import_batches SET bundle_storage_ref=NULL,updated_at=NOW(3) WHERE id=?`, [batchId]);
  }
  const diveDeep = require('./diveDeep');
  await diveDeep.addCustomerEvent(customerId, 'admin.segmented_import_cancelled', { batchId }, 'admin', actorId, p);
  return batchDetail(customerId, batchId, p);
}

function serializeEvidence(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    importBatchId: row.import_batch_id || null,
    externalEvidenceId: row.external_evidence_id || '',
    exposureId: row.exposure_id || null,
    findingKey: row.finding_key || '',
    evidenceType: row.evidence_type,
    label: decryptPii(row.label_enc),
    originalName: decryptPii(row.original_name_enc),
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size) || 0,
    sha256: row.sha256,
    sensitivity: row.sensitivity,
    publicationStatus: row.publication_status,
    capturedAt: iso(row.captured_at),
    metadata: decryptJson(row.metadata_enc, {}),
    createdAt: iso(row.created_at),
  };
}

async function listEvidenceFiles(customerId, options = {}, pool = null) {
  const p = pool || getPool();
  const params = [customerId];
  let where = `ef.customer_id=? AND ef.publication_status<>'deleted'`;
  if (!options.includeUnpublished) where += ` AND ef.publication_status='published' AND e.publication_status='published'`;
  if (options.exposureId) { where += ' AND el.exposure_id=?'; params.push(options.exposureId); }
  const exposureIds = [...new Set((Array.isArray(options.exposureIds) ? options.exposureIds : [])
    .map((value) => clean(value, 64)).filter(Boolean))];
  if (exposureIds.length) {
    where += ` AND el.exposure_id IN (${exposureIds.map(() => '?').join(',')})`;
    params.push(...exposureIds);
  } else if (Array.isArray(options.exposureIds)) {
    return [];
  }
  const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 1000);
  const offset = Math.max(Number(options.offset) || 0, 0);
  params.push(limit, offset);
  const [rows] = await p.query(
    `SELECT ef.*,el.exposure_id,el.finding_key FROM divedeep_evidence_files ef
     LEFT JOIN divedeep_evidence_links el ON el.evidence_id=ef.id
     LEFT JOIN divedeep_exposures e ON e.id=el.exposure_id WHERE ${where}
     ORDER BY ef.created_at DESC LIMIT ? OFFSET ?`,
    params
  );
  return rows.map(serializeEvidence);
}

async function readEvidenceFile(customerId, evidenceId, options = {}, pool = null) {
  const p = pool || getPool();
  const params = [evidenceId, customerId];
  const visibilityJoin = options.includeUnpublished
    ? ''
    : ` JOIN divedeep_evidence_links el ON el.evidence_id=ef.id JOIN divedeep_exposures e ON e.id=el.exposure_id AND e.publication_status='published'`;
  const visibilityWhere = options.includeUnpublished ? '' : ` AND ef.publication_status='published'`;
  const [rows] = await p.query(
    `SELECT ef.* FROM divedeep_evidence_files ef${visibilityJoin}
     WHERE ef.id=? AND ef.customer_id=? AND ef.publication_status<>'deleted'${visibilityWhere} LIMIT 1`,
    params
  );
  if (!rows[0]) throw statusError('Evidence file not found', 404, 'DIVEDEEP_EVIDENCE_NOT_FOUND');
  return { evidence: serializeEvidence(rows[0]), buffer: readEncryptedEvidence(rows[0].storage_ref) };
}

async function cleanupExpiredImports(pool = null) {
  const p = pool || getPool();
  const retentionDays = getDiveDeepConfig().stagedEvidenceRetentionDays;
  const evidenceCutoff = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000));
  const [expiredRows] = await p.query(`SELECT id,bundle_storage_ref FROM divedeep_import_batches WHERE status IN ('created','importing','failed') AND expires_at IS NOT NULL AND expires_at<NOW(3) LIMIT 200`);
  if (expiredRows.length) {
    const ids = expiredRows.map((row) => row.id);
    await p.query(`UPDATE divedeep_import_batches SET status='expired',job_phase='cancelled',job_message='Import expired before completion.',job_completed_at=NOW(3),bundle_storage_ref=NULL,updated_at=NOW(3) WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const row of expiredRows) { if (row.bundle_storage_ref) { try { deleteEncryptedImportBundle(row.bundle_storage_ref); } catch {} } }
  }
  const [evidenceRows] = await p.query(
    `SELECT ef.id,ef.storage_ref FROM divedeep_evidence_files ef
     LEFT JOIN divedeep_evidence_links el ON el.evidence_id=ef.id
     LEFT JOIN divedeep_exposures e ON e.id=el.exposure_id AND e.publication_status='published'
     WHERE ef.publication_status IN ('staged','rejected') AND ef.created_at<?
     GROUP BY ef.id HAVING COUNT(e.id)=0 LIMIT 200`,
    [evidenceCutoff]
  );
  for (const row of evidenceRows) {
    try { deleteEncryptedEvidence(row.storage_ref); } catch {}
    await p.query(`UPDATE divedeep_evidence_files SET publication_status='deleted',updated_at=NOW(3) WHERE id=?`, [row.id]);
  }
  return { expiredBatches: expiredRows.length, deletedEvidence: evidenceRows.length };
}

module.exports = {
  createImportBatch,
  batchDetail,
  importBatchStatus,
  listImportBatches,
  importBatchPart,
  uploadBatchEvidence,
  finalizeImportBatch,
  publishImportBatch,
  setFindingPublication,
  setFindingsPublication,
  enqueueImportBundle,
  resumeImportBundleJob,
  resumePendingImportJobs,
  cancelImportBatch,
  listEvidenceFiles,
  readEvidenceFile,
  cleanupExpiredImports,
  normalizeManifest,
  summarizeFindingErrors,
  compactImportResult,
  compactStoredError,
  restartClosedImportBatch,
};
