const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { encryptJson, decryptJson } = require('./divedeepPii');
const tokens = require('./diveDeepWorkerTokens');

const WORKER_SCOPES = Object.freeze([
  'manifest:read',
  'heartbeat:write',
  'events:write',
  'source_attempts:write',
  'checkpoints:read',
  'checkpoints:write',
  'candidates:write',
  'artifacts:read',
  'artifacts:write',
  'completion:write',
  'cleanup:write',
]);

function clean(value, max = 1024) { return String(value == null ? '' : value).trim().slice(0, max); }
function parseJson(value, fallback = {}) { if (!value) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function bool(value) { return value === true || value === 1 || String(value).toLowerCase() === 'true'; }
function statusError(message, status = 400, code = 'DIVEDEEP_WORKER_INVALID') { return Object.assign(new Error(message), { status, code }); }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }

function leaseSeconds() {
  const requested = Number(process.env.DIVEDEEP_WORKER_LEASE_SECONDS || 180);
  return Math.min(Math.max(Number.isFinite(requested) ? requested : 180, 60), 900);
}

function bootstrapSeconds() {
  const requested = Number(process.env.DIVEDEEP_WORKER_BOOTSTRAP_SECONDS || 900);
  return Math.min(Math.max(Number.isFinite(requested) ? requested : 900, 120), 1800);
}

function tokenSeconds() {
  const requested = Number(process.env.DIVEDEEP_WORKER_SESSION_SECONDS || 600);
  return Math.min(Math.max(Number.isFinite(requested) ? requested : 600, 120), 1800);
}

async function addJobEvent(connection, jobId, eventType, actorId, details = {}) {
  await connection.query(
    `INSERT INTO divedeep_recon_job_events (id,recon_job_id,event_type,actor_type,actor_id,details_json)
     VALUES (?,?,?,'worker',?,?)`,
    [crypto.randomUUID(), jobId, clean(eventType, 96), clean(actorId, 128) || null, JSON.stringify(details || {})]
  );
}

async function issueBootstrap(reconJobId, executionId, poolVersionId, pool = null) {
  const p = pool || getPool();
  const token = tokens.issueOpaqueToken(40);
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO divedeep_worker_bootstrap_tokens
     (id,recon_job_id,execution_id,worker_pool_version_id,token_hash,status,expires_at)
     VALUES (?,?,?,?,?,'issued',DATE_ADD(NOW(3),INTERVAL ? SECOND))`,
    [id, clean(reconJobId, 64), clean(executionId, 64), clean(poolVersionId, 64), tokens.hashOpaqueToken(token), bootstrapSeconds()]
  );
  return { id, token, expiresInSeconds: bootstrapSeconds() };
}

async function revokeBootstrap(id, reason = 'dispatch_failed', pool = null) {
  const p = pool || getPool();
  await p.query(
    `UPDATE divedeep_worker_bootstrap_tokens SET status='revoked',revoked_reason=?,updated_at=NOW(3)
     WHERE id=? AND status='issued'`,
    [clean(reason, 255), clean(id, 64)]
  );
}

function safeRegistrationMetadata(input = {}, requestContext = {}) {
  return {
    executionName: clean(input.executionName, 1024) || null,
    taskIndex: Number.isFinite(Number(input.taskIndex)) ? Number(input.taskIndex) : null,
    taskAttempt: Number.isFinite(Number(input.taskAttempt)) ? Number(input.taskAttempt) : null,
    revision: clean(input.workerVersion, 64) || null,
    workerProtocolVersion: Number(input.workerProtocolVersion) || null,
    hostname: clean(input.hostname, 255) || null,
    region: clean(input.region, 64) || null,
    userAgent: clean(requestContext.userAgent, 500) || null,
  };
}

async function registerWorker(input = {}, requestContext = {}, pool = null) {
  const p = pool || getPool();
  const jobId = clean(input.jobId, 64);
  const poolVersionId = clean(input.poolVersionId, 64);
  const bootstrapToken = clean(input.bootstrapToken, 4096);
  if (!jobId || !poolVersionId || !bootstrapToken) throw statusError('jobId, poolVersionId, and bootstrapToken are required');
  const tokenHash = tokens.hashOpaqueToken(bootstrapToken);
  const workerId = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  const metadata = safeRegistrationMetadata(input, requestContext);
  const connection = await p.getConnection();
  let executionId;
  let manifest;
  try {
    await connection.beginTransaction();
    const [bootstrapRows] = await connection.query(
      `SELECT b.*,j.status job_status,j.manifest_enc,j.customer_id,j.worker_pool_version_id,
              e.status execution_status,pv.provider_config_json
         FROM divedeep_worker_bootstrap_tokens b
         JOIN divedeep_recon_jobs j ON j.id=b.recon_job_id
         JOIN divedeep_recon_job_executions e ON e.id=b.execution_id
         JOIN divedeep_worker_pool_versions pv ON pv.id=b.worker_pool_version_id
        WHERE b.recon_job_id=? AND b.token_hash=? FOR UPDATE`,
      [jobId, tokenHash]
    );
    const row = bootstrapRows[0];
    if (!row || row.status !== 'issued') throw statusError('Worker bootstrap token is invalid or already used', 401, 'DIVEDEEP_WORKER_BOOTSTRAP_INVALID');
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await connection.query(`UPDATE divedeep_worker_bootstrap_tokens SET status='expired',updated_at=NOW(3) WHERE id=?`, [row.id]);
      throw statusError('Worker bootstrap token has expired', 401, 'DIVEDEEP_WORKER_BOOTSTRAP_EXPIRED');
    }
    if (row.worker_pool_version_id !== poolVersionId) {
      throw statusError('Worker pool version does not match the dispatched job', 403, 'DIVEDEEP_WORKER_POOL_MISMATCH');
    }
    const providerConfig = parseJson(row.provider_config_json, {});
    const expectedWorkerVersion = clean(providerConfig.workerVersion, 64);
    const expectedProtocolVersion = Number(providerConfig.workerProtocolVersion || 1);
    const reportedWorkerVersion = clean(input.workerVersion, 64);
    const reportedProtocolVersion = Number(input.workerProtocolVersion || 0);
    if (expectedWorkerVersion && reportedWorkerVersion !== expectedWorkerVersion) {
      throw statusError(`Worker version ${reportedWorkerVersion || 'unknown'} is incompatible with required version ${expectedWorkerVersion}`, 409, 'DIVEDEEP_WORKER_VERSION_MISMATCH');
    }
    if (reportedProtocolVersion !== expectedProtocolVersion) {
      throw statusError(`Worker protocol ${reportedProtocolVersion || 'unknown'} is incompatible with required protocol ${expectedProtocolVersion}`, 409, 'DIVEDEEP_WORKER_PROTOCOL_MISMATCH');
    }
    if (!['dispatching', 'running'].includes(row.job_status)) throw statusError(`Recon job cannot register a worker from ${row.job_status}`, 409, 'DIVEDEEP_WORKER_JOB_STATE');
    executionId = row.execution_id;
    manifest = decryptJson(row.manifest_enc);
    await connection.query(
      `INSERT INTO divedeep_worker_instances
       (id,recon_job_id,execution_id,worker_pool_version_id,provider_instance_id,status,registered_at,heartbeat_at,metadata_json,request_ip_hash)
       VALUES (?,?,?,?,?,'registered',NOW(3),NOW(3),?,?)`,
      [workerId, jobId, executionId, poolVersionId, clean(input.executionName, 1024) || null,
        JSON.stringify(metadata), requestContext.ip ? sha256(requestContext.ip) : null]
    );
    await connection.query(
      `INSERT INTO divedeep_job_leases
       (id,recon_job_id,execution_id,worker_instance_id,status,issued_at,expires_at,heartbeat_at)
       VALUES (?,?,?,?,'active',NOW(3),DATE_ADD(NOW(3),INTERVAL ? SECOND),NOW(3))`,
      [leaseId, jobId, executionId, workerId, leaseSeconds()]
    );
    await connection.query(`UPDATE divedeep_worker_bootstrap_tokens SET status='consumed',consumed_at=NOW(3),worker_instance_id=?,updated_at=NOW(3) WHERE id=?`, [workerId, row.id]);
    await connection.query(`UPDATE divedeep_worker_instances SET status='running',updated_at=NOW(3) WHERE id=?`, [workerId]);
    await connection.query(`UPDATE divedeep_recon_job_executions SET status='running',external_execution_name=COALESCE(?,external_execution_name),started_at=COALESCE(started_at,NOW(3)),updated_at=NOW(3) WHERE id=?`, [clean(input.executionName, 1024) || null, executionId]);
    await connection.query(`UPDATE divedeep_recon_jobs SET status='running',current_gate='worker_execution',heartbeat_at=NOW(3),started_at=COALESCE(started_at,NOW(3)),updated_at=NOW(3) WHERE id=?`, [jobId]);
    await connection.query(`UPDATE divedeep_customers SET workflow_status='researching',updated_at=NOW(3) WHERE id=?`, [row.customer_id]);
    await addJobEvent(connection, jobId, 'worker.registered', workerId, { leaseId, executionId, poolVersionId, metadata });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  const sessionToken = tokens.issueWorkerToken({ workerId, jobId, leaseId, executionId, poolVersionId, scopes: WORKER_SCOPES }, tokenSeconds());
  return {
    workerId,
    jobId,
    leaseId,
    leaseExpiresInSeconds: leaseSeconds(),
    token: sessionToken,
    tokenExpiresInSeconds: tokenSeconds(),
    manifest,
  };
}

async function authenticateClaims(claims, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT l.*,w.status worker_status,w.recon_job_id worker_job_id,j.status job_status,j.worker_pool_version_id
       FROM divedeep_job_leases l
       JOIN divedeep_worker_instances w ON w.id=l.worker_instance_id
       JOIN divedeep_recon_jobs j ON j.id=l.recon_job_id
      WHERE l.id=? AND l.worker_instance_id=? AND l.recon_job_id=? LIMIT 1`,
    [clean(claims.leaseId, 64), clean(claims.workerId, 64), clean(claims.jobId, 64)]
  );
  const row = rows[0];
  const cleanupOnly = Array.isArray(claims.scopes) && claims.scopes.length === 1 && claims.scopes[0] === 'cleanup:write';
  if (!row || (!cleanupOnly && row.status !== 'active') || (cleanupOnly && !['active', 'released'].includes(row.status))) {
    throw statusError('Worker lease is not active for this operation', 401, 'DIVEDEEP_WORKER_LEASE_INACTIVE');
  }
  if (!cleanupOnly && new Date(row.expires_at).getTime() <= Date.now()) throw statusError('Worker lease has expired', 401, 'DIVEDEEP_WORKER_LEASE_EXPIRED');
  const allowedWorkerStates = cleanupOnly ? ['finalizing', 'wiping'] : ['registered', 'running', 'uploading', 'finalizing', 'wiping'];
  if (!allowedWorkerStates.includes(row.worker_status)) throw statusError('Worker instance is not active for this operation', 401, 'DIVEDEEP_WORKER_INACTIVE');
  const allowedJobStates = cleanupOnly ? ['awaiting_review', 'completed', 'failed'] : ['running', 'dispatching'];
  if (!allowedJobStates.includes(row.job_status)) throw statusError(`Recon job is not accepting worker updates from ${row.job_status}`, 409, 'DIVEDEEP_WORKER_JOB_STATE');
  return {
    ...claims,
    leaseExpiresAt: iso(row.expires_at),
    workerStatus: row.worker_status,
    jobStatus: row.job_status,
  };
}

function requireScope(principal, scope) {
  if (!Array.isArray(principal.scopes) || !principal.scopes.includes(scope)) throw statusError('Worker token does not permit this operation', 403, 'DIVEDEEP_WORKER_SCOPE');
}

async function getManifest(principal, pool = null) {
  requireScope(principal, 'manifest:read');
  const p = pool || getPool();
  const [rows] = await p.query('SELECT manifest_enc,status FROM divedeep_recon_jobs WHERE id=? LIMIT 1', [principal.jobId]);
  if (!rows[0]) throw statusError('Recon job not found', 404, 'DIVEDEEP_RECON_JOB_NOT_FOUND');
  return decryptJson(rows[0].manifest_enc);
}

async function heartbeat(principal, input = {}, pool = null) {
  requireScope(principal, 'heartbeat:write');
  const p = pool || getPool();
  const progress = Math.min(Math.max(Number(input.progressPercent) || 0, 0), 100);
  const sourceCompleted = Math.max(Number(input.sourceCompletedCount) || 0, 0);
  const candidateCount = Math.max(Number(input.candidateCount) || 0, 0);
  const status = clean(input.status, 32);
  const workerStatus = ['running', 'uploading', 'finalizing', 'wiping'].includes(status) ? status : 'running';
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    const [leaseRows] = await connection.query(`SELECT status,expires_at FROM divedeep_job_leases WHERE id=? AND worker_instance_id=? FOR UPDATE`, [principal.leaseId, principal.workerId]);
    if (!leaseRows[0] || leaseRows[0].status !== 'active') throw statusError('Worker lease is no longer active', 409, 'DIVEDEEP_WORKER_LEASE_INACTIVE');
    await connection.query(`UPDATE divedeep_job_leases SET expires_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),heartbeat_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [leaseSeconds(), principal.leaseId]);
    await connection.query(`UPDATE divedeep_worker_instances SET status=?,heartbeat_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [workerStatus, principal.workerId]);
    await connection.query(
      `UPDATE divedeep_recon_jobs SET status='running',progress_percent=GREATEST(progress_percent,?),source_completed_count=GREATEST(source_completed_count,?),candidate_count=GREATEST(candidate_count,?),heartbeat_at=NOW(3),updated_at=NOW(3) WHERE id=?`,
      [progress, sourceCompleted, candidateCount, principal.jobId]
    );
    if (input.message) await addJobEvent(connection, principal.jobId, 'worker.heartbeat', principal.workerId, { progressPercent: progress, message: clean(input.message, 500), status: workerStatus });
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return {
    ok: true,
    leaseExpiresInSeconds: leaseSeconds(),
    token: tokens.issueWorkerToken(principal, tokenSeconds()),
    tokenExpiresInSeconds: tokenSeconds(),
  };
}

async function recordEvents(principal, events = [], pool = null) {
  requireScope(principal, 'events:write');
  const p = pool || getPool();
  const safeEvents = (Array.isArray(events) ? events : []).slice(0, 100).map((event) => ({
    type: clean(event.type || 'worker.event', 96),
    details: parseJson(event.details, {}),
  }));
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    for (const event of safeEvents) await addJobEvent(connection, principal.jobId, event.type, principal.workerId, event.details);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return { accepted: safeEvents.length };
}

function normalizeAttempt(item = {}) {
  const status = clean(item.status || 'completed', 32);
  const allowed = new Set(['started', 'completed', 'no_result', 'candidate_found', 'blocked', 'rate_limited', 'timed_out', 'unsupported', 'failed', 'skipped']);
  if (!allowed.has(status)) throw statusError(`Unsupported source-attempt status: ${status}`);
  return {
    clientAttemptId: clean(item.attemptId, 128) || crypto.randomUUID(),
    resourceId: clean(item.resourceId, 64) || null,
    sourcePoolVersionId: clean(item.sourcePoolVersionId, 64) || null,
    sourceKey: clean(item.sourceKey, 191) || null,
    status,
    startedAt: item.startedAt ? new Date(item.startedAt) : null,
    completedAt: item.completedAt ? new Date(item.completedAt) : null,
    candidateCount: Math.max(Number(item.candidateCount) || 0, 0),
    relevantCount: Math.max(Number(item.relevantCount) || 0, 0),
    durationMs: Math.max(Number(item.durationMs) || 0, 0),
    errorClass: clean(item.errorClass, 96) || null,
    metadata: parseJson(item.metadata, {}),
  };
}

async function recordSourceAttempts(principal, items = [], pool = null) {
  requireScope(principal, 'source_attempts:write');
  const p = pool || getPool();
  const attempts = (Array.isArray(items) ? items : []).slice(0, 100).map(normalizeAttempt);
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    for (const item of attempts) {
      await connection.query(
        `INSERT INTO divedeep_source_attempts
         (id,recon_job_id,worker_instance_id,lease_id,client_attempt_id,resource_id,source_pool_version_id,source_key,status,started_at,completed_at,candidate_count,relevant_count,error_class,duration_ms,metadata_enc,payload_expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,DATE_ADD(NOW(3),INTERVAL 24 HOUR))
         ON DUPLICATE KEY UPDATE status=VALUES(status),completed_at=VALUES(completed_at),candidate_count=VALUES(candidate_count),relevant_count=VALUES(relevant_count),error_class=VALUES(error_class),duration_ms=VALUES(duration_ms),metadata_enc=VALUES(metadata_enc),updated_at=NOW(3)`,
        [crypto.randomUUID(), principal.jobId, principal.workerId, principal.leaseId, item.clientAttemptId, item.resourceId,
          item.sourcePoolVersionId, item.sourceKey, item.status, item.startedAt, item.completedAt, item.candidateCount,
          item.relevantCount, item.errorClass, item.durationMs, encryptJson(item.metadata)]
      );
    }
    const [[counts]] = await connection.query(
      `SELECT COUNT(*) total,SUM(status IN ('completed','no_result','candidate_found','blocked','rate_limited','timed_out','unsupported','failed','skipped')) completed,
              COALESCE(SUM(candidate_count),0) candidates
         FROM divedeep_source_attempts WHERE recon_job_id=?`, [principal.jobId]
    );
    await connection.query(
      `UPDATE divedeep_recon_jobs SET source_completed_count=?,candidate_count=GREATEST(candidate_count,?),progress_percent=LEAST(99,CASE WHEN source_count>0 THEN FLOOR((? / source_count)*100) ELSE progress_percent END),heartbeat_at=NOW(3),updated_at=NOW(3) WHERE id=?`,
      [Number(counts.completed) || 0, Number(counts.candidates) || 0, Number(counts.completed) || 0, principal.jobId]
    );
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  const clientIds = attempts.map((item) => item.clientAttemptId);
  let attemptRows = [];
  if (clientIds.length) {
    const placeholders = clientIds.map(() => '?').join(',');
    const [rows] = await p.query(
      `SELECT id,client_attempt_id FROM divedeep_source_attempts WHERE recon_job_id=? AND client_attempt_id IN (${placeholders})`,
      [principal.jobId, ...clientIds]
    );
    attemptRows = rows.map((row) => ({ id: row.id, clientAttemptId: row.client_attempt_id }));
  }
  return { accepted: attempts.length, attempts: attemptRows };
}

async function getCheckpoints(principal, pool = null) {
  requireScope(principal, 'checkpoints:read');
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT id,checkpoint_key,sequence_number,state_enc,created_at,updated_at
       FROM divedeep_job_checkpoints
      WHERE recon_job_id=?
      ORDER BY checkpoint_key ASC,sequence_number DESC,updated_at DESC`,
    [principal.jobId]
  );
  const latest = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.checkpoint_key)) continue;
    seen.add(row.checkpoint_key);
    latest.push({
      id: row.id,
      checkpointKey: row.checkpoint_key,
      sequence: Number(row.sequence_number) || 0,
      state: decryptJson(row.state_enc),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    });
  }
  return { checkpoints: latest };
}

async function recordCheckpoint(principal, input = {}, pool = null) {
  requireScope(principal, 'checkpoints:write');
  const p = pool || getPool();
  const checkpointKey = clean(input.checkpointKey || 'default', 128);
  const sequence = Math.max(Number(input.sequence) || 0, 0);
  const state = parseJson(input.state, {});
  await p.query(
    `INSERT INTO divedeep_job_checkpoints
     (id,recon_job_id,worker_instance_id,lease_id,checkpoint_key,sequence_number,state_enc)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE worker_instance_id=VALUES(worker_instance_id),lease_id=VALUES(lease_id),state_enc=VALUES(state_enc),updated_at=NOW(3)`,
    [crypto.randomUUID(), principal.jobId, principal.workerId, principal.leaseId, checkpointKey, sequence, encryptJson(state)]
  );
  return { checkpointKey, sequence };
}

function normalizeCandidate(input = {}) {
  const candidateType = clean(input.candidateType || 'web_result', 64);
  const sourceUrl = clean(input.sourceUrl, 8192);
  const sourceKey = clean(input.sourceKey, 191) || null;
  const dedupeBasis = clean(input.dedupeKey, 2048) || `${candidateType}|${sourceUrl}|${clean(input.externalId, 512)}`;
  const reviewBand = clean(input.reviewBand || 'manual_review', 32);
  if (!['low_priority', 'manual_review', 'high_priority', 'customer_validation_eligible'].includes(reviewBand)) throw statusError('Candidate review band is invalid');
  return {
    id: crypto.randomUUID(),
    clientCandidateId: clean(input.candidateId, 128) || null,
    sourceAttemptId: clean(input.sourceAttemptId, 64) || null,
    resourceId: clean(input.resourceId, 64) || null,
    candidateType,
    sourceKey,
    sourceUrl,
    sourceUrlHash: sourceUrl ? sha256(sourceUrl) : null,
    dedupeHash: sha256(dedupeBasis),
    title: clean(input.title, 1000),
    summary: clean(input.summary, 4000),
    discoveredAt: input.discoveredAt ? new Date(input.discoveredAt) : new Date(),
    confidence: input.confidence == null ? null : Math.min(Math.max(Number(input.confidence) || 0, 0), 100),
    reviewBand,
    artifactIds: Array.isArray(input.artifactIds) ? input.artifactIds.map((id) => clean(id, 64)).filter(Boolean).slice(0, 50) : [],
    normalized: parseJson(input.normalized, {}),
    sensitivity: ['standard', 'sensitive', 'restricted'].includes(clean(input.sensitivity, 32)) ? clean(input.sensitivity, 32) : 'standard',
  };
}

async function submitCandidates(principal, items = [], pool = null) {
  requireScope(principal, 'candidates:write');
  const p = pool || getPool();
  const candidates = (Array.isArray(items) ? items : []).slice(0, 100).map(normalizeCandidate);
  const accepted = [];
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    for (const item of candidates) {
      const [result] = await connection.query(
        `INSERT IGNORE INTO divedeep_recon_candidates
         (id,recon_job_id,worker_instance_id,lease_id,source_attempt_id,resource_id,client_candidate_id,candidate_type,source_key,source_url_hash,dedupe_hash,title_enc,summary_enc,discovered_at,confidence,review_band,state,sensitivity,artifact_ids_json,normalized_result_enc,retention_class,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'review_required',?,?,?,?,DATE_ADD(NOW(3),INTERVAL 30 DAY))`,
        [item.id, principal.jobId, principal.workerId, principal.leaseId, item.sourceAttemptId, item.resourceId,
          item.clientCandidateId, item.candidateType, item.sourceKey, item.sourceUrlHash, item.dedupeHash,
          item.title ? encryptJson(item.title) : null, item.summary ? encryptJson(item.summary) : null,
          item.discoveredAt, item.confidence, item.reviewBand, item.sensitivity, JSON.stringify(item.artifactIds),
          encryptJson({ ...item.normalized, sourceUrl: item.sourceUrl || null }), 'pending_review']
      );
      if (result.affectedRows) accepted.push(item.id);
    }
    const [[counts]] = await connection.query(`SELECT COUNT(*) total FROM divedeep_recon_candidates WHERE recon_job_id=?`, [principal.jobId]);
    await connection.query(`UPDATE divedeep_recon_jobs SET candidate_count=?,review_count=?,heartbeat_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [Number(counts.total) || 0, Number(counts.total) || 0, principal.jobId]);
    await addJobEvent(connection, principal.jobId, 'worker.candidates_submitted', principal.workerId, { received: candidates.length, accepted: accepted.length });
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return { received: candidates.length, accepted: accepted.length, candidateIds: accepted };
}

async function authorizeArtifactDownload(principal, artifactId, pool = null) {
  requireScope(principal, 'artifacts:read');
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT a.id,a.recon_job_id,a.customer_id,a.profile_id,a.artifact_type,a.status,j.customer_id job_customer_id,j.profile_id job_profile_id
       FROM divedeep_artifacts a JOIN divedeep_recon_jobs j ON j.id=?
      WHERE a.id=? LIMIT 1`,
    [principal.jobId, clean(artifactId, 64)]
  );
  const row = rows[0];
  if (!row || row.status !== 'available') throw statusError('Input artifact is unavailable', 404, 'DIVEDEEP_WORKER_ARTIFACT_NOT_FOUND');
  const sameJob = row.recon_job_id === principal.jobId;
  const sameCustomerProfile = row.customer_id === row.job_customer_id && (!row.profile_id || row.profile_id === row.job_profile_id);
  if (!sameJob && !sameCustomerProfile) throw statusError('Artifact does not belong to this worker assignment', 403, 'DIVEDEEP_WORKER_ARTIFACT_FORBIDDEN');
  if (!sameJob && row.artifact_type !== 'reference_image') throw statusError('Only approved reference images may be read across a customer job', 403, 'DIVEDEEP_WORKER_ARTIFACT_FORBIDDEN');
  return require('./diveDeepArtifacts').createAccessGrant(row.id, principal.workerId, 'worker_input', p, { actorType: 'worker' });
}

async function reserveArtifact(principal, input = {}, pool = null) {
  requireScope(principal, 'artifacts:write');
  const p = pool || getPool();
  const [jobRows] = await p.query('SELECT customer_id,profile_id FROM divedeep_recon_jobs WHERE id=? LIMIT 1', [principal.jobId]);
  if (!jobRows[0]) throw statusError('Recon job not found', 404, 'DIVEDEEP_RECON_JOB_NOT_FOUND');
  const artifacts = require('./diveDeepArtifacts');
  return artifacts.reserveUpload({
    ...input,
    customerId: jobRows[0].customer_id,
    profileId: jobRows[0].profile_id,
    reconJobId: principal.jobId,
    accessScope: 'admin_only',
  }, principal.workerId, p, { actorType: 'worker' });
}

async function finalizeArtifact(principal, artifactId, pool = null) {
  requireScope(principal, 'artifacts:write');
  const p = pool || getPool();
  const [rows] = await p.query('SELECT id,recon_job_id FROM divedeep_artifacts WHERE id=? LIMIT 1', [clean(artifactId, 64)]);
  if (!rows[0] || rows[0].recon_job_id !== principal.jobId) throw statusError('Artifact does not belong to this worker job', 404, 'DIVEDEEP_WORKER_ARTIFACT_NOT_FOUND');
  return require('./diveDeepArtifacts').finalizeUpload(rows[0].id, principal.workerId, p, { actorType: 'worker' });
}

async function completeJob(principal, input = {}, pool = null) {
  requireScope(principal, 'completion:write');
  const p = pool || getPool();
  const outcome = clean(input.outcome || 'completed', 32);
  if (!['completed', 'partial', 'failed'].includes(outcome)) throw statusError('Worker completion outcome is invalid');
  const summary = parseJson(input.summary, {});
  const connection = await p.getConnection();
  let nextStatus;
  let workflowCustomerId = null;
  try {
    await connection.beginTransaction();
    const [[candidateCounts]] = await connection.query(`SELECT COUNT(*) total FROM divedeep_recon_candidates WHERE recon_job_id=?`, [principal.jobId]);
    const [[attemptCounts]] = await connection.query(`SELECT COUNT(*) total,SUM(status IN ('completed','no_result','candidate_found','blocked','rate_limited','timed_out','unsupported','failed','skipped')) completed FROM divedeep_source_attempts WHERE recon_job_id=?`, [principal.jobId]);
    const candidateCount = Number(candidateCounts.total) || 0;
    const completedSources = Number(attemptCounts.completed) || 0;
    nextStatus = outcome === 'failed' ? 'failed' : candidateCount > 0 ? 'awaiting_review' : 'completed';
    await connection.query(
      `INSERT INTO divedeep_recon_job_completions
       (id,recon_job_id,execution_id,worker_instance_id,lease_id,outcome,summary_enc,source_attempt_count,candidate_count,cleanup_status,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,'pending',NOW(3))`,
      [crypto.randomUUID(), principal.jobId, principal.executionId, principal.workerId, principal.leaseId, outcome,
        encryptJson(summary), completedSources, candidateCount]
    );
    await connection.query(`UPDATE divedeep_job_leases SET status='released',released_at=NOW(3),release_reason=?,updated_at=NOW(3) WHERE id=? AND status='active'`, [outcome, principal.leaseId]);
    await connection.query(`UPDATE divedeep_worker_instances SET status='finalizing',completed_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [principal.workerId]);
    await connection.query(`UPDATE divedeep_recon_job_executions SET status=?,completed_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [outcome === 'failed' ? 'failed' : 'completed', principal.executionId]);
    await connection.query(
      `UPDATE divedeep_recon_jobs SET status=?,current_gate=?,progress_percent=100,source_completed_count=?,candidate_count=?,review_count=?,heartbeat_at=NOW(3),completed_at=NOW(3),last_error_code=?,last_error_message=?,updated_at=NOW(3) WHERE id=?`,
      [nextStatus, nextStatus === 'awaiting_review' ? 'candidate_review' : 'complete', completedSources, candidateCount, candidateCount,
        outcome === 'failed' ? clean(input.errorCode, 96) || 'WORKER_REPORTED_FAILURE' : null,
        outcome === 'failed' ? clean(input.errorMessage, 2000) || 'Worker reported failure' : null, principal.jobId]
    );
    const [jobRows] = await connection.query('SELECT customer_id FROM divedeep_recon_jobs WHERE id=? LIMIT 1', [principal.jobId]);
    workflowCustomerId = jobRows[0].customer_id;
    await connection.query(`UPDATE divedeep_customers SET workflow_status=?,updated_at=NOW(3) WHERE id=?`, [nextStatus === 'awaiting_review' ? 'awaiting_review' : nextStatus === 'failed' ? 'blocked' : 'closure_ready', workflowCustomerId]);
    await addJobEvent(connection, principal.jobId, 'worker.completed', principal.workerId, { outcome, nextStatus, completedSources, candidateCount, summary });
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  if (workflowCustomerId) {
    const workflow = require('./diveDeepWorkflow');
    await workflow.reconcileReviewTasks(workflowCustomerId, principal.workerId, p).catch(() => {});
  }
  const cleanupToken = tokens.issueWorkerToken({
    workerId: principal.workerId,
    jobId: principal.jobId,
    leaseId: principal.leaseId,
    executionId: principal.executionId,
    poolVersionId: principal.poolVersionId,
    scopes: ['cleanup:write'],
  }, tokenSeconds());
  return { ok: true, status: nextStatus, cleanupRequired: true, cleanupToken, cleanupTokenExpiresInSeconds: tokenSeconds() };
}

async function acknowledgeCleanup(principal, input = {}, pool = null) {
  requireScope(principal, 'cleanup:write');
  const p = pool || getPool();
  const details = {
    workspaceRemoved: bool(input.workspaceRemoved),
    browserProfileRemoved: bool(input.browserProfileRemoved),
    temporaryFilesRemoved: bool(input.temporaryFilesRemoved),
    bytesRemaining: Math.max(Number(input.bytesRemaining) || 0, 0),
    completedAt: new Date().toISOString(),
  };
  if (!details.workspaceRemoved || !details.browserProfileRemoved || !details.temporaryFilesRemoved || details.bytesRemaining !== 0) {
    throw statusError('Cleanup acknowledgement must confirm removal of all temporary job data', 409, 'DIVEDEEP_WORKER_CLEANUP_INCOMPLETE');
  }
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE divedeep_worker_instances SET status='terminated',cleanup_ack_at=NOW(3),cleanup_details_json=?,updated_at=NOW(3) WHERE id=?`, [JSON.stringify(details), principal.workerId]);
    await connection.query(`UPDATE divedeep_recon_job_completions SET cleanup_status='confirmed',cleanup_ack_at=NOW(3),cleanup_details_json=?,updated_at=NOW(3) WHERE recon_job_id=? AND worker_instance_id=? ORDER BY completed_at DESC LIMIT 1`, [JSON.stringify(details), principal.jobId, principal.workerId]);
    await addJobEvent(connection, principal.jobId, 'worker.cleanup_confirmed', principal.workerId, details);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return { ok: true };
}

async function sweepExpiredLeases(options = {}, pool = null) {
  const p = pool || getPool();
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const [rows] = await p.query(
    `SELECT l.id lease_id,l.recon_job_id,l.worker_instance_id,l.execution_id,j.status job_status
       FROM divedeep_job_leases l JOIN divedeep_recon_jobs j ON j.id=l.recon_job_id
      WHERE l.status='active' AND l.expires_at<=NOW(3) ORDER BY l.expires_at ASC LIMIT ?`, [limit]
  );
  let recovered = 0;
  for (const row of rows) {
    const connection = await p.getConnection();
    try {
      await connection.beginTransaction();
      const [claim] = await connection.query(`UPDATE divedeep_job_leases SET status='expired',released_at=NOW(3),release_reason='heartbeat_expired',updated_at=NOW(3) WHERE id=? AND status='active'`, [row.lease_id]);
      if (!claim.affectedRows) { await connection.rollback(); continue; }
      await connection.query(`UPDATE divedeep_worker_instances SET status='lost',completed_at=NOW(3),last_error='Worker heartbeat lease expired',updated_at=NOW(3) WHERE id=?`, [row.worker_instance_id]);
      await connection.query(`UPDATE divedeep_recon_job_executions SET status='lost',completed_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [row.execution_id]);
      await connection.query(`UPDATE divedeep_recon_jobs SET status='awaiting_capacity',current_gate='worker_capacity',last_error_code='WORKER_LEASE_EXPIRED',last_error_message='The ephemeral worker stopped heartbeating before completion',updated_at=NOW(3) WHERE id=? AND status IN ('dispatching','running')`, [row.recon_job_id]);
      await addJobEvent(connection, row.recon_job_id, 'worker.lease_expired', row.worker_instance_id, { leaseId: row.lease_id });
      await connection.commit();
      recovered += 1;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  await p.query(`UPDATE divedeep_worker_bootstrap_tokens SET status='expired',updated_at=NOW(3) WHERE status='issued' AND expires_at<=NOW(3)`).catch(() => {});
  return { selected: rows.length, recovered };
}

async function sweepExpiredWorkerMetadata(options = {}, pool = null) {
  const p = pool || getPool();
  const limit = Math.min(Math.max(Number(options.limit) || 250, 1), 1000);
  const [attemptRows] = await p.query(
    `SELECT id FROM divedeep_source_attempts WHERE metadata_enc IS NOT NULL AND payload_expires_at IS NOT NULL AND payload_expires_at<=NOW(3) ORDER BY payload_expires_at ASC LIMIT ?`,
    [limit]
  );
  for (const row of attemptRows) {
    await p.query(`UPDATE divedeep_source_attempts SET metadata_enc=NULL,updated_at=NOW(3) WHERE id=? AND payload_expires_at<=NOW(3)`, [row.id]);
  }
  const [candidateRows] = await p.query(
    `SELECT id FROM divedeep_recon_candidates WHERE state IN ('review_required','customer_validation_requested','rejected') AND expires_at IS NOT NULL AND expires_at<=NOW(3) ORDER BY expires_at ASC LIMIT ?`,
    [limit]
  );
  for (const row of candidateRows) {
    await p.query(
      `UPDATE divedeep_recon_candidates SET state='expired',title_enc=NULL,summary_enc=NULL,normalized_result_enc=?,artifact_ids_json='[]',updated_at=NOW(3) WHERE id=? AND expires_at<=NOW(3)`,
      [encryptJson({ expired: true, reason: 'retention_deadline' }), row.id]
    );
  }
  return { sourceAttemptPayloadsCleared: attemptRows.length, candidatesExpired: candidateRows.length };
}

async function listWorkers(filters = {}, pool = null) {
  const p = pool || getPool();
  const where = [];
  const params = [];
  if (filters.status) { where.push('w.status=?'); params.push(clean(filters.status, 32)); }
  if (filters.jobId) { where.push('w.recon_job_id=?'); params.push(clean(filters.jobId, 64)); }
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
  params.push(limit);
  const [rows] = await p.query(
    `SELECT w.*,l.id lease_id,l.status lease_status,l.expires_at lease_expires_at,j.status job_status,p.name pool_name
       FROM divedeep_worker_instances w
       LEFT JOIN divedeep_job_leases l ON l.worker_instance_id=w.id
       LEFT JOIN divedeep_recon_jobs j ON j.id=w.recon_job_id
       LEFT JOIN divedeep_worker_pool_versions pv ON pv.id=w.worker_pool_version_id
       LEFT JOIN divedeep_worker_pools p ON p.id=pv.pool_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY w.created_at DESC LIMIT ?`, params
  );
  return rows.map((row) => ({
    id: row.id,
    reconJobId: row.recon_job_id,
    executionId: row.execution_id,
    poolVersionId: row.worker_pool_version_id,
    poolName: row.pool_name || null,
    providerInstanceId: row.provider_instance_id || null,
    status: row.status,
    leaseId: row.lease_id || null,
    leaseStatus: row.lease_status || null,
    leaseExpiresAt: iso(row.lease_expires_at),
    jobStatus: row.job_status || null,
    metadata: parseJson(row.metadata_json, {}),
    registeredAt: iso(row.registered_at),
    heartbeatAt: iso(row.heartbeat_at),
    completedAt: iso(row.completed_at),
    cleanupAckAt: iso(row.cleanup_ack_at),
    lastError: row.last_error || null,
  }));
}

async function getWorkerOperations(pool = null) {
  const p = pool || getPool();
  const [[workers], [leases], [attempts], [candidates]] = await Promise.all([
    p.query(`SELECT COUNT(*) total,SUM(status IN ('registered','running','uploading','finalizing','wiping')) active,SUM(status='lost') lost,SUM(status='terminated') terminated FROM divedeep_worker_instances`),
    p.query(`SELECT COUNT(*) total,SUM(status='active') active,SUM(status='expired') expired FROM divedeep_job_leases`),
    p.query(`SELECT COUNT(*) total,SUM(status='candidate_found') candidate_sources,SUM(status IN ('failed','timed_out','blocked','rate_limited')) exceptions FROM divedeep_source_attempts`),
    p.query(`SELECT COUNT(*) total,SUM(state='review_required') review_required FROM divedeep_recon_candidates`),
  ]);
  return {
    workers: { total: Number(workers[0]?.total) || 0, active: Number(workers[0]?.active) || 0, lost: Number(workers[0]?.lost) || 0, terminated: Number(workers[0]?.terminated) || 0 },
    leases: { total: Number(leases[0]?.total) || 0, active: Number(leases[0]?.active) || 0, expired: Number(leases[0]?.expired) || 0 },
    sourceAttempts: { total: Number(attempts[0]?.total) || 0, candidateSources: Number(attempts[0]?.candidate_sources) || 0, exceptions: Number(attempts[0]?.exceptions) || 0 },
    candidates: { total: Number(candidates[0]?.total) || 0, reviewRequired: Number(candidates[0]?.review_required) || 0 },
  };
}

module.exports = {
  WORKER_SCOPES,
  issueBootstrap,
  revokeBootstrap,
  registerWorker,
  authenticateClaims,
  getManifest,
  heartbeat,
  recordEvents,
  recordSourceAttempts,
  getCheckpoints,
  recordCheckpoint,
  submitCandidates,
  authorizeArtifactDownload,
  reserveArtifact,
  finalizeArtifact,
  completeJob,
  acknowledgeCleanup,
  sweepExpiredLeases,
  sweepExpiredWorkerMetadata,
  listWorkers,
  getWorkerOperations,
};
