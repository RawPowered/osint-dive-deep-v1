const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { encryptJson, decryptJson } = require('./divedeepPii');

const JOB_STATUSES = new Set([
  'created', 'blocked', 'ready', 'awaiting_capacity', 'dispatching', 'running',
  'awaiting_review', 'evidence_ready', 'completed', 'failed', 'cancelled', 'expired',
]);
const EXECUTION_STATUSES = new Set(['requested', 'running', 'completed', 'failed', 'cancelled', 'lost']);

function clean(value, max = 512) { return String(value == null ? '' : value).trim().slice(0, max); }
function parseJson(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : fallback; }
  catch { return fallback; }
}
function iso(value) { return value ? new Date(value).toISOString() : null; }
function statusError(message, status = 400, code = 'DIVEDEEP_RECON_JOB_INVALID') { return Object.assign(new Error(message), { status, code }); }
function rowJob(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    profileId: row.profile_id,
    packageId: row.package_id,
    packageVersionId: row.package_version_id,
    packageVersion: Number(row.package_version) || 0,
    sourceSetVersionId: row.source_set_version_id,
    imageAnalysisProfileVersionId: row.image_analysis_profile_version_id || null,
    authorizationId: row.authorization_id,
    authorizationDocumentSha256: row.authorization_document_sha256 || null,
    workerPoolId: row.worker_pool_id || null,
    workerPoolVersionId: row.worker_pool_version_id || null,
    status: row.status,
    currentGate: row.current_gate || null,
    priority: Number(row.priority) || 0,
    progressPercent: Number(row.progress_percent) || 0,
    sourceCount: Number(row.source_count) || 0,
    sourceCompletedCount: Number(row.source_completed_count) || 0,
    candidateCount: Number(row.candidate_count) || 0,
    reviewCount: Number(row.review_count) || 0,
    confirmedCount: Number(row.confirmed_count) || 0,
    externalOperationName: row.external_operation_name || null,
    externalExecutionName: row.external_execution_name || null,
    lastErrorCode: row.last_error_code || null,
    lastErrorMessage: row.last_error_message || null,
    requestedAt: iso(row.requested_at),
    dispatchedAt: iso(row.dispatched_at),
    startedAt: iso(row.started_at),
    heartbeatAt: iso(row.heartbeat_at),
    completedAt: iso(row.completed_at),
    expiresAt: iso(row.expires_at),
    createdBy: row.created_by || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function rowExecution(row) {
  return {
    id: row.id,
    reconJobId: row.recon_job_id,
    attemptNumber: Number(row.attempt_number) || 0,
    provider: row.provider,
    status: row.status,
    externalOperationName: row.external_operation_name || null,
    externalExecutionName: row.external_execution_name || null,
    providerState: parseJson(row.provider_state_json, {}),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function addEvent(connection, jobId, eventType, actorType, actorId, details = {}) {
  await connection.query(
    `INSERT INTO divedeep_recon_job_events (id,recon_job_id,event_type,actor_type,actor_id,details_json)
     VALUES (?,?,?,?,?,?)`,
    [crypto.randomUUID(), jobId, clean(eventType, 96), clean(actorType || 'system', 32), clean(actorId, 128) || null, JSON.stringify(details || {})]
  );
}

async function createJob(customerId, actorId, pool = null) {
  const p = pool || getPool();
  const workflow = require('./diveDeepWorkflow');
  const evaluation = await workflow.evaluateCustomer(customerId, actorId, p);
  const diveDeep = require('./diveDeep');
  const dashboard = await diveDeep.getCustomerDashboard(customerId, p, { includeUnpublished: true, findingPageSize: 1 });
  const workerPacketResponse = await diveDeep.exportCustomerPacket(customerId, 'json', p, { suppressWorkflow: true, suppressEvent: true, actorId });
  const workerPacket = JSON.parse(workerPacketResponse.body);
  const manifest = evaluation.manifest;
  if (!manifest) throw statusError('Customer package does not resolve to a published manifest', 409, 'DIVEDEEP_PACKAGE_MANIFEST_MISSING');
  const active = await p.query(
    `SELECT id,status FROM divedeep_recon_jobs WHERE customer_id=? AND status IN ('created','ready','awaiting_capacity','dispatching','running','awaiting_review','evidence_ready') ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  if (active[0][0]) throw statusError('This customer already has an active recon job', 409, 'DIVEDEEP_RECON_JOB_ACTIVE');
  const id = crypto.randomUUID();
  const packageVersion = manifest.package || {};
  const imageAnalysis = manifest.imageAnalysis || null;
  const sourceCount = Array.isArray(manifest.resources) ? manifest.resources.length : 0;
  const status = evaluation.ready ? 'ready' : (evaluation.jobCreatable ? 'awaiting_capacity' : 'blocked');
  const authorization = dashboard.authorization || {};
  const workerPool = evaluation.workerPool || null;
  const [inputArtifactRows] = await p.query(
    `SELECT id,artifact_type,content_type,COALESCE(actual_byte_size,expected_byte_size) byte_size,
            COALESCE(actual_sha256,expected_sha256) sha256,metadata_enc
       FROM divedeep_artifacts
      WHERE customer_id=? AND (profile_id IS NULL OR profile_id=?) AND artifact_type='reference_image'
        AND status='available' AND publication_status<>'deleted'
      ORDER BY created_at DESC LIMIT 25`,
    [customerId, dashboard.profile?.id || null]
  );
  const inputArtifacts = inputArtifactRows.map((row) => {
    const metadata = decryptJson(row.metadata_enc, {});
    return {
      id: row.id,
      artifactType: row.artifact_type,
      contentType: row.content_type,
      byteSize: Number(row.byte_size) || 0,
      sha256: row.sha256,
      photoId: metadata.photoId || metadata.profilePhotoId || row.id,
    };
  });
  const jobManifest = {
    schemaVersion: 1,
    jobId: id,
    createdAt: new Date().toISOString(),
    customerReference: customerId,
    profileId: dashboard.profile?.id || null,
    authorization: {
      id: authorization.id || null,
      version: authorization.authorizationVersion || null,
      documentSha256: authorization.documentSha256 || null,
      expiresAt: authorization.expiresAt || null,
    },
    package: packageVersion,
    sourceSet: manifest.sourceSet,
    sourcePools: manifest.pools || [],
    resources: manifest.resources || [],
    imageAnalysis,
    inputArtifacts,
    presentation: imageAnalysis?.presentation || null,
    execution: {
      provider: 'google_cloud_run_jobs',
      workerPoolId: workerPool?.pool?.id || null,
      workerPoolVersionId: workerPool?.version?.id || null,
      oneExecutionPerJob: true,
      retainWorkerData: false,
      callbackMode: 'api',
      workerIdentity: { mode: 'job_scoped_bootstrap', tokenTtlSeconds: 900, leaseHeartbeatSeconds: 180 },
    },
    retention: packageVersion.retentionPolicy || { nonmatchHours: 24, pendingReviewDays: 30 },
    authorizedInput: {
      schemaVersion: workerPacket.schemaVersion,
      product: workerPacket.product,
      exportedAt: workerPacket.exportedAt,
      customer: workerPacket.customer,
      authorization: workerPacket.authorization,
      divedeep: workerPacket.divedeep,
      connections: workerPacket.connections || [],
      photos: workerPacket.photos || [],
      socialMediaCatalog: workerPacket.socialMediaCatalog || [],
      manualProcessing: workerPacket.manualProcessing || {},
    },
  };
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO divedeep_recon_jobs
       (id,customer_id,profile_id,package_id,package_version_id,package_version,source_set_version_id,image_analysis_profile_version_id,
        authorization_id,authorization_document_sha256,worker_pool_id,worker_pool_version_id,status,current_gate,priority,manifest_enc,
        source_count,requested_at,expires_at,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(3),DATE_ADD(NOW(3),INTERVAL 30 DAY),?)`,
      [
        id, customerId, dashboard.profile?.id || null, packageVersion.packageId || dashboard.customer.planTier,
        packageVersion.id || null, Number(packageVersion.version) || 0, manifest.sourceSet?.versionId || null,
        imageAnalysis?.profileVersionId || null, authorization.id || null, authorization.documentSha256 || null,
        workerPool?.pool?.id || null, workerPool?.version?.id || null, status, evaluation.currentGate,
        Number(packageVersion.executionPolicy?.priority) || 0, encryptJson(jobManifest), sourceCount, clean(actorId, 128) || null,
      ]
    );
    await addEvent(connection, id, 'recon_job.created', 'admin', actorId, {
      status,
      packageId: packageVersion.packageId || dashboard.customer.planTier,
      packageVersion: Number(packageVersion.version) || 0,
      sourceCount,
      workerPoolId: workerPool?.pool?.id || null,
      gateReady: evaluation.ready,
      jobCreatable: evaluation.jobCreatable,
    });
    if (!evaluation.ready) await addEvent(connection, id, evaluation.jobCreatable ? 'recon_job.awaiting_capacity' : 'recon_job.blocked', 'system', null, { currentGate: evaluation.currentGate, gates: evaluation.gates.map((gate) => ({ key: gate.key, status: gate.status })) });
    await connection.query('UPDATE divedeep_customers SET workflow_status=?,updated_at=NOW(3) WHERE id=?', [evaluation.jobCreatable ? 'awaiting_dispatch' : 'blocked', customerId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  await workflow.evaluateCustomer(customerId, actorId, p);
  return getJob(id, p);
}

async function listJobs(filters = {}, pool = null) {
  const p = pool || getPool();
  const where = [];
  const params = [];
  if (filters.customerId) { where.push('j.customer_id=?'); params.push(clean(filters.customerId, 64)); }
  if (filters.status && JOB_STATUSES.has(filters.status)) { where.push('j.status=?'); params.push(filters.status); }
  if (filters.workerPoolId) { where.push('j.worker_pool_id=?'); params.push(clean(filters.workerPoolId, 64)); }
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
  params.push(limit);
  const [rows] = await p.query(
    `SELECT j.*,c.email_enc,c.first_name_enc,c.last_name_enc,w.name worker_pool_name
     FROM divedeep_recon_jobs j
     LEFT JOIN divedeep_customers c ON c.id=j.customer_id
     LEFT JOIN divedeep_worker_pools w ON w.id=j.worker_pool_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY j.created_at DESC LIMIT ?`, params
  );
  const { decryptPii } = require('./divedeepPii');
  return rows.map((row) => ({
    ...rowJob(row),
    customer: {
      id: row.customer_id,
      displayName: [decryptPii(row.first_name_enc), decryptPii(row.last_name_enc)].filter(Boolean).join(' '),
      email: decryptPii(row.email_enc),
    },
    workerPoolName: row.worker_pool_name || null,
  }));
}

async function getJob(jobId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_recon_jobs WHERE id=? LIMIT 1', [clean(jobId, 64)]);
  if (!rows[0]) throw statusError('Recon job not found', 404, 'DIVEDEEP_RECON_JOB_NOT_FOUND');
  const [executionRows] = await p.query('SELECT * FROM divedeep_recon_job_executions WHERE recon_job_id=? ORDER BY attempt_number DESC', [rows[0].id]);
  const [eventRows] = await p.query('SELECT * FROM divedeep_recon_job_events WHERE recon_job_id=? ORDER BY created_at DESC LIMIT 500', [rows[0].id]);
  return {
    ...rowJob(rows[0]),
    executions: executionRows.map(rowExecution),
    events: eventRows.map((row) => ({ id: row.id, eventType: row.event_type, actorType: row.actor_type, actorId: row.actor_id || null, details: parseJson(row.details_json, {}), createdAt: iso(row.created_at) })),
  };
}

async function getJobManifest(jobId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT manifest_enc FROM divedeep_recon_jobs WHERE id=? LIMIT 1', [clean(jobId, 64)]);
  if (!rows[0]) throw statusError('Recon job not found', 404, 'DIVEDEEP_RECON_JOB_NOT_FOUND');
  return decryptJson(rows[0].manifest_enc);
}

async function dispatchJob(jobId, actorId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT j.*,v.provider_config_json,v.limits_json,p.status pool_status,v.status version_status
     FROM divedeep_recon_jobs j
     LEFT JOIN divedeep_worker_pools p ON p.id=j.worker_pool_id
     LEFT JOIN divedeep_worker_pool_versions v ON v.id=j.worker_pool_version_id
     WHERE j.id=? LIMIT 1`, [clean(jobId, 64)]
  );
  const job = rows[0];
  if (!job) throw statusError('Recon job not found', 404, 'DIVEDEEP_RECON_JOB_NOT_FOUND');
  if (!['ready', 'awaiting_capacity', 'failed'].includes(job.status)) throw statusError(`Recon job cannot be dispatched from ${job.status}`, 409, 'DIVEDEEP_RECON_JOB_STATE');
  if (job.pool_status !== 'active' || job.version_status !== 'published') throw statusError('Assigned worker pool is not active and published', 409, 'DIVEDEEP_WORKER_POOL_UNAVAILABLE');
  const providerConfig = parseJson(job.provider_config_json, {});
  if (!providerConfig.dispatchEnabled) throw statusError('Cloud Run dispatch is disabled for this worker-pool version', 409, 'DIVEDEEP_CLOUD_RUN_DISPATCH_DISABLED');
  const limits = parseJson(job.limits_json, {});
  const maximumConcurrentExecutions = Math.max(1, Number(limits.maximumConcurrentExecutions) || 1);
  const [capacityRows] = await p.query(
    `SELECT COUNT(*) active_count FROM divedeep_recon_jobs
     WHERE worker_pool_id=? AND id<>? AND status IN ('dispatching','running')`,
    [job.worker_pool_id, job.id]
  );
  const activeCount = Number(capacityRows[0]?.active_count) || 0;
  if (activeCount >= maximumConcurrentExecutions) {
    const capacityConnection = await p.getConnection();
    try {
      await capacityConnection.beginTransaction();
      await capacityConnection.query(`UPDATE divedeep_recon_jobs SET status='awaiting_capacity',current_gate='worker_capacity',updated_at=NOW(3) WHERE id=?`, [job.id]);
      await capacityConnection.query(`UPDATE divedeep_customers SET workflow_status='awaiting_dispatch',updated_at=NOW(3) WHERE id=?`, [job.customer_id]);
      await addEvent(capacityConnection, job.id, 'recon_job.capacity_wait', 'system', null, { activeCount, maximumConcurrentExecutions, workerPoolId: job.worker_pool_id });
      await capacityConnection.commit();
    } catch (error) { await capacityConnection.rollback(); throw error; }
    finally { capacityConnection.release(); }
    throw statusError('The assigned Cloud Run worker pool is currently at capacity', 409, 'DIVEDEEP_WORKER_POOL_AT_CAPACITY');
  }
  const cloudRun = require('./diveDeepCloudRun');
  const [attemptRows] = await p.query('SELECT COALESCE(MAX(attempt_number),0)+1 attempt FROM divedeep_recon_job_executions WHERE recon_job_id=?', [job.id]);
  const attempt = Number(attemptRows[0]?.attempt) || 1;
  const executionId = crypto.randomUUID();
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE divedeep_recon_jobs SET status='dispatching',last_error_code=NULL,last_error_message=NULL,updated_at=NOW(3) WHERE id=?`, [job.id]);
    await connection.query(
      `INSERT INTO divedeep_recon_job_executions (id,recon_job_id,attempt_number,provider,status,provider_state_json)
       VALUES (?,?,?,'google_cloud_run_jobs','requested','{}')`, [executionId, job.id, attempt]
    );
    await addEvent(connection, job.id, 'recon_job.dispatch_requested', 'admin', actorId, { attempt, provider: 'google_cloud_run_jobs' });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }

  let bootstrap = null;
  try {
    const workerRuntime = require('./diveDeepWorkerRuntime');
    bootstrap = await workerRuntime.issueBootstrap(job.id, executionId, job.worker_pool_version_id, p);
    const result = await cloudRun.executeJob({
      jobId: job.id,
      poolVersionId: job.worker_pool_version_id,
      projectId: providerConfig.projectId,
      region: providerConfig.region,
      jobName: providerConfig.jobName,
      taskCount: providerConfig.taskCount,
      taskTimeoutSeconds: providerConfig.taskTimeoutSeconds,
      executionId,
      bootstrapToken: bootstrap.token,
    });
    const updateConnection = await p.getConnection();
    try {
      await updateConnection.beginTransaction();
      await updateConnection.query(
        `UPDATE divedeep_recon_job_executions SET status='requested',external_operation_name=?,provider_state_json=?,started_at=NOW(3),updated_at=NOW(3) WHERE id=?`,
        [result.operationName, JSON.stringify(result), executionId]
      );
      await updateConnection.query(
        `UPDATE divedeep_recon_jobs SET status='dispatching',external_execution_name=NULL,dispatched_at=NOW(3),started_at=COALESCE(started_at,NOW(3)),heartbeat_at=NOW(3),updated_at=NOW(3) WHERE id=?`,
        [job.id]
      );
      await updateConnection.query(`UPDATE divedeep_customers SET workflow_status='dispatched',updated_at=NOW(3) WHERE id=?`, [job.customer_id]);
      await addEvent(updateConnection, job.id, 'recon_job.dispatch_accepted', 'system', null, result);
      await updateConnection.commit();
    } catch (error) { await updateConnection.rollback(); throw error; }
    finally { updateConnection.release(); }
    return getJob(job.id, p);
  } catch (error) {
    if (bootstrap?.id) await require('./diveDeepWorkerRuntime').revokeBootstrap(bootstrap.id, error.code || 'dispatch_failed', p).catch(() => {});
    const failConnection = await p.getConnection();
    try {
      await failConnection.beginTransaction();
      await failConnection.query(
        `UPDATE divedeep_recon_job_executions SET status='failed',provider_state_json=?,completed_at=NOW(3),updated_at=NOW(3) WHERE id=?`,
        [JSON.stringify({ error: clean(error.message, 1000), code: clean(error.code, 96) }), executionId]
      );
      await failConnection.query(
        `UPDATE divedeep_recon_jobs SET status='failed',last_error_code=?,last_error_message=?,updated_at=NOW(3) WHERE id=?`,
        [clean(error.code, 96) || 'CLOUD_RUN_DISPATCH_FAILED', clean(error.message, 2000), job.id]
      );
      await addEvent(failConnection, job.id, 'recon_job.dispatch_failed', 'system', null, { code: error.code || null, message: clean(error.message, 1000) });
      await failConnection.commit();
    } catch (nested) { await failConnection.rollback(); }
    finally { failConnection.release(); }
    throw error;
  }
}

async function syncExecution(jobId, actorId = 'system', pool = null) {
  const p = pool || getPool();
  const job = await getJob(jobId, p);
  const current = job.executions[0];
  if (!current) throw statusError('Recon job has no Cloud Run execution to synchronize', 409, 'DIVEDEEP_RECON_EXECUTION_MISSING');
  const cloudRun = require('./diveDeepCloudRun');
  let result;
  let providerStatus;
  let operationDone = false;
  let providerError = null;

  if (current.externalExecutionName || job.externalExecutionName) {
    result = await cloudRun.getExecution(current.externalExecutionName || job.externalExecutionName);
    providerStatus = result.status;
  } else if (current.externalOperationName) {
    const operation = await cloudRun.checkRunOperation(current.externalOperationName);
    operationDone = operation.done;
    providerError = operation.error;
    result = operation.execution || {
      externalExecutionName: operation.externalExecutionName || null,
      status: operation.status,
      terminalCondition: operation.error ? { message: operation.error.message } : null,
    };
    providerStatus = operation.error ? 'failed' : (result.status || operation.status || 'dispatching');
  } else {
    throw statusError('Cloud Run operation reference has not been recorded', 409, 'DIVEDEEP_CLOUD_RUN_OPERATION_PENDING');
  }

  const nextStatus = providerStatus === 'completed'
    ? (['awaiting_review', 'evidence_ready', 'completed'].includes(job.status) ? job.status : 'awaiting_review')
    : providerStatus === 'failed'
      ? (['awaiting_review', 'evidence_ready', 'completed'].includes(job.status) ? job.status : 'failed')
      : providerStatus === 'cancelled'
        ? 'cancelled'
        : providerStatus === 'dispatching'
          ? 'dispatching'
          : 'running';
  const executionStatus = providerStatus === 'dispatching' ? 'requested' : providerStatus;
  const state = {
    ...result,
    operationDone,
    operationName: current.externalOperationName || null,
    error: providerError,
  };
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE divedeep_recon_job_executions SET status=?,external_execution_name=COALESCE(?,external_execution_name),provider_state_json=?,completed_at=CASE WHEN ? IN ('completed','failed','cancelled') THEN NOW(3) ELSE completed_at END,updated_at=NOW(3) WHERE id=?`,
      [executionStatus, result.externalExecutionName || null, JSON.stringify(state), executionStatus, current.id]
    );
    await connection.query(
      `UPDATE divedeep_recon_jobs SET status=?,external_execution_name=COALESCE(?,external_execution_name),heartbeat_at=NOW(3),completed_at=CASE WHEN ?='completed' THEN NOW(3) ELSE completed_at END,last_error_code=CASE WHEN ?='failed' THEN ? ELSE last_error_code END,last_error_message=CASE WHEN ?='failed' THEN ? ELSE last_error_message END,updated_at=NOW(3) WHERE id=?`,
      [nextStatus, result.externalExecutionName || null, providerStatus, providerStatus, providerError?.code || 'CLOUD_RUN_EXECUTION_FAILED', providerStatus, clean(providerError?.message || result.terminalCondition?.message, 2000), job.id]
    );
    if (nextStatus === 'running') await connection.query(`UPDATE divedeep_customers SET workflow_status='researching',updated_at=NOW(3) WHERE id=?`, [job.customerId]);
    if (nextStatus === 'awaiting_review') await connection.query(`UPDATE divedeep_customers SET workflow_status='awaiting_review',updated_at=NOW(3) WHERE id=?`, [job.customerId]);
    if (nextStatus === 'failed') await connection.query(`UPDATE divedeep_customers SET workflow_status='blocked',updated_at=NOW(3) WHERE id=?`, [job.customerId]);
    await addEvent(connection, job.id, 'recon_job.execution_synced', actorId === 'system' ? 'system' : 'admin', actorId, {
      providerStatus,
      nextStatus,
      operationDone,
      externalExecutionName: result.externalExecutionName || null,
    });
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return getJob(job.id, p);
}

async function cancelJob(jobId, actorId, pool = null) {
  const p = pool || getPool();
  const job = await getJob(jobId, p);
  if (['completed', 'cancelled', 'expired'].includes(job.status)) return job;
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE divedeep_recon_jobs SET status='cancelled',completed_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [job.id]);
    await connection.query(`UPDATE divedeep_recon_job_executions SET status='cancelled',completed_at=NOW(3),updated_at=NOW(3) WHERE recon_job_id=? AND status IN ('requested','running')`, [job.id]);
    await addEvent(connection, job.id, 'recon_job.cancelled', 'admin', actorId, { providerCancellationDeferred: true });
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return getJob(job.id, p);
}

async function operationsOverview(pool = null) {
  const p = pool || getPool();
  const [[jobCounts], [gateCounts], [reviewCounts], [retentionCounts], [caseCounts]] = await Promise.all([
    p.query(`SELECT
      SUM(status='ready') ready,
      SUM(status='awaiting_capacity') awaiting_capacity,
      SUM(status IN ('dispatching','running')) active,
      SUM(status='awaiting_review') awaiting_review,
      SUM(status='failed') failed,
      COUNT(*) total
      FROM divedeep_recon_jobs`),
    p.query(`SELECT status,COUNT(*) count FROM divedeep_customer_workflow_gates GROUP BY status`),
    p.query(`SELECT
      (SELECT COUNT(*) FROM divedeep_image_analysis_items WHERE state IN ('likely_match') AND visibility IN ('internal','review')) image_review,
      (SELECT COUNT(*) FROM divedeep_image_analysis_items WHERE state='customer_validation_requested' AND customer_disposition='pending') customer_validation,
      (SELECT COUNT(*) FROM divedeep_exposures WHERE status IN ('open','review')) finding_review`),
    p.query(`SELECT
      (SELECT COUNT(*) FROM divedeep_image_analysis_items WHERE expires_at IS NOT NULL AND expires_at<=DATE_ADD(NOW(3),INTERVAL 24 HOUR) AND state<>'expired') expiring_24h,
      (SELECT COUNT(*) FROM divedeep_image_analysis_items WHERE expires_at IS NOT NULL AND expires_at<NOW(3) AND state<>'expired') overdue,
      (SELECT COUNT(*) FROM divedeep_import_batches WHERE expires_at IS NOT NULL AND expires_at<=DATE_ADD(NOW(3),INTERVAL 24 HOUR) AND status NOT IN ('published','cancelled','expired')) import_expiring`),
    p.query(`SELECT state,COUNT(*) count FROM divedeep_cases GROUP BY state`),
  ]);
  return {
    jobs: {
      total: Number(jobCounts[0]?.total) || 0,
      ready: Number(jobCounts[0]?.ready) || 0,
      awaitingCapacity: Number(jobCounts[0]?.awaiting_capacity) || 0,
      active: Number(jobCounts[0]?.active) || 0,
      awaitingReview: Number(jobCounts[0]?.awaiting_review) || 0,
      failed: Number(jobCounts[0]?.failed) || 0,
    },
    gates: Object.fromEntries(gateCounts.map((row) => [row.status, Number(row.count) || 0])),
    review: {
      imageReview: Number(reviewCounts[0]?.image_review) || 0,
      customerValidation: Number(reviewCounts[0]?.customer_validation) || 0,
      findingReview: Number(reviewCounts[0]?.finding_review) || 0,
    },
    retention: {
      expiring24h: Number(retentionCounts[0]?.expiring_24h) || 0,
      overdue: Number(retentionCounts[0]?.overdue) || 0,
      importExpiring: Number(retentionCounts[0]?.import_expiring) || 0,
    },
    cases: Object.fromEntries(caseCounts.map((row) => [row.state, Number(row.count) || 0])),
  };
}

async function workQueue(pool = null) {
  const p = pool || getPool();
  const jobs = await listJobs({ limit: 500 }, p);
  const [customerRows] = await p.query(
    `SELECT id,status,workflow_status,plan_tier,first_name_enc,last_name_enc,email_enc,updated_at FROM divedeep_customers ORDER BY updated_at DESC LIMIT 500`
  );
  const { decryptPii } = require('./divedeepPii');
  const customers = customerRows.map((row) => ({
    id: row.id,
    displayName: [decryptPii(row.first_name_enc), decryptPii(row.last_name_enc)].filter(Boolean).join(' '),
    email: decryptPii(row.email_enc),
    status: row.status,
    workflowStatus: row.workflow_status,
    planTier: row.plan_tier,
    updatedAt: iso(row.updated_at),
  }));
  const lanes = {
    needsIntake: customers.filter((item) => ['onboarding'].includes(item.workflowStatus)),
    readyToRun: jobs.filter((item) => item.status === 'ready'),
    awaitingCapacity: jobs.filter((item) => item.status === 'awaiting_capacity'),
    running: jobs.filter((item) => ['dispatching', 'running'].includes(item.status)),
    needsReview: jobs.filter((item) => ['awaiting_review', 'evidence_ready'].includes(item.status)),
    blocked: jobs.filter((item) => ['blocked', 'failed'].includes(item.status)),
  };
  return { lanes, customers, jobs };
}

async function reviewQueue(pool = null) {
  const p = pool || getPool();
  const [imageRows] = await p.query(
    `SELECT i.id,i.session_id,i.state,i.visibility,i.review_band,i.review_confidence,i.customer_disposition,i.expires_at,i.updated_at,s.customer_id,s.recon_job_id
     FROM divedeep_image_analysis_items i INNER JOIN divedeep_image_analysis_sessions s ON s.id=i.session_id
     WHERE i.state IN ('likely_match','customer_validation_requested') OR i.visibility IN ('review','customer_validation')
     ORDER BY FIELD(i.review_band,'high_priority','manual_review','low_priority'),i.updated_at DESC LIMIT 500`
  );
  const [findingRows] = await p.query(
    `SELECT e.id,e.tenant_id customer_id,e.profile_id,e.content_category category,e.status,e.match_confidence confidence,e.updated_at
     FROM divedeep_exposures e WHERE e.status IN ('open','review') ORDER BY e.updated_at DESC LIMIT 500`
  );
  const [candidateRows] = await p.query(
    `SELECT c.id,c.recon_job_id,c.resource_id,c.candidate_type,c.source_key,c.confidence,c.review_band,c.state,c.sensitivity,c.expires_at,c.created_at,j.customer_id,j.profile_id
       FROM divedeep_recon_candidates c JOIN divedeep_recon_jobs j ON j.id=c.recon_job_id
      WHERE c.state IN ('review_required','customer_validation_requested')
      ORDER BY FIELD(c.review_band,'high_priority','customer_validation_eligible','manual_review','low_priority'),c.created_at DESC LIMIT 500`
  );
  return {
    imageItems: imageRows.map((row) => ({
      id: row.id, sessionId: row.session_id, customerId: row.customer_id, reconJobId: row.recon_job_id,
      state: row.state, visibility: row.visibility, reviewBand: row.review_band,
      reviewConfidence: row.review_confidence == null ? null : Number(row.review_confidence),
      customerDisposition: row.customer_disposition, expiresAt: iso(row.expires_at), updatedAt: iso(row.updated_at),
    })),
    findings: findingRows.map((row) => ({
      id: row.id, customerId: row.customer_id, profileId: row.profile_id, category: row.category,
      status: row.status, confidence: row.confidence == null ? null : Number(row.confidence), updatedAt: iso(row.updated_at),
    })),
    workerCandidates: candidateRows.map((row) => ({
      id: row.id, reconJobId: row.recon_job_id, customerId: row.customer_id, profileId: row.profile_id,
      resourceId: row.resource_id || null, candidateType: row.candidate_type, sourceKey: row.source_key || null,
      confidence: row.confidence == null ? null : Number(row.confidence), reviewBand: row.review_band,
      state: row.state, sensitivity: row.sensitivity, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at),
    })),
  };
}

async function retentionQueue(pool = null) {
  const p = pool || getPool();
  const [imageRows] = await p.query(
    `SELECT i.id,i.session_id,i.state,i.visibility,i.retention_class,i.expires_at,i.dispositioned_at,i.updated_at,s.customer_id,s.recon_job_id
     FROM divedeep_image_analysis_items i INNER JOIN divedeep_image_analysis_sessions s ON s.id=i.session_id
     WHERE i.expires_at IS NOT NULL AND i.state<>'expired' ORDER BY i.expires_at ASC LIMIT 1000`
  );
  const [batchRows] = await p.query(
    `SELECT id,customer_id,status,expires_at,updated_at FROM divedeep_import_batches WHERE expires_at IS NOT NULL AND status NOT IN ('published','cancelled','expired') ORDER BY expires_at ASC LIMIT 500`
  );
  const now = Date.now();
  const classify = (value) => {
    const time = value ? new Date(value).getTime() : Infinity;
    if (time <= now) return 'overdue';
    if (time <= now + 24 * 60 * 60 * 1000) return 'within_24h';
    if (time <= now + 7 * 24 * 60 * 60 * 1000) return 'within_7d';
    return 'scheduled';
  };
  return {
    imageItems: imageRows.map((row) => ({
      id: row.id, sessionId: row.session_id, customerId: row.customer_id, reconJobId: row.recon_job_id,
      state: row.state, visibility: row.visibility, retentionClass: row.retention_class,
      expiresAt: iso(row.expires_at), dispositionedAt: iso(row.dispositioned_at), updatedAt: iso(row.updated_at), bucket: classify(row.expires_at),
    })),
    importBatches: batchRows.map((row) => ({ id: row.id, customerId: row.customer_id, status: row.status, expiresAt: iso(row.expires_at), updatedAt: iso(row.updated_at), bucket: classify(row.expires_at) })),
  };
}

async function monitoringQueue(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT c.id,c.tenant_id customer_id,c.profile_id,c.state,c.delivery_method,c.confirmation_reference submission_reference,c.response_due_at deadline_at,c.updated_at,e.id exposure_id,e.status exposure_status
     FROM divedeep_cases c LEFT JOIN divedeep_exposures e ON e.id=c.exposure_id
     WHERE c.state IN ('sent','acknowledged','needs_action','completed','denied') OR e.status IN ('confirmed','removed','reappeared')
     ORDER BY COALESCE(c.response_due_at,c.updated_at) ASC LIMIT 1000`
  );
  return rows.map((row) => ({
    caseId: row.id, customerId: row.customer_id, profileId: row.profile_id, state: row.state,
    deliveryMethod: row.delivery_method, submissionReference: row.submission_reference,
    deadlineAt: iso(row.deadline_at), updatedAt: iso(row.updated_at), exposureId: row.exposure_id,
    exposureStatus: row.exposure_status,
  }));
}

async function caseQueue(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT c.id,c.tenant_id customer_id,c.profile_id,c.exposure_id,c.request_type,c.delivery_method,c.state,
            c.response_due_at,c.sent_at,c.confirmation_reference,c.created_at,c.updated_at,
            customer.first_name_enc,customer.last_name_enc,customer.email_enc,
            exposure.content_category,exposure.status exposure_status
     FROM divedeep_cases c
     LEFT JOIN divedeep_customers customer ON customer.id=c.tenant_id
     LEFT JOIN divedeep_exposures exposure ON exposure.id=c.exposure_id
     ORDER BY FIELD(c.state,'needs_action','failed','draft','approved','queued','sent','acknowledged','denied','completed','withdrawn'),c.updated_at DESC
     LIMIT 1000`
  );
  const { decryptPii } = require('./divedeepPii');
  return rows.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    customer: {
      displayName: [decryptPii(row.first_name_enc), decryptPii(row.last_name_enc)].filter(Boolean).join(' '),
      email: decryptPii(row.email_enc),
    },
    profileId: row.profile_id,
    exposureId: row.exposure_id,
    requestType: row.request_type,
    deliveryMethod: row.delivery_method,
    state: row.state,
    responseDueAt: iso(row.response_due_at),
    sentAt: iso(row.sent_at),
    confirmationReference: row.confirmation_reference || null,
    contentCategory: row.content_category || null,
    exposureStatus: row.exposure_status || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
}

module.exports = {
  JOB_STATUSES,
  EXECUTION_STATUSES,
  createJob,
  listJobs,
  getJob,
  getJobManifest,
  dispatchJob,
  syncExecution,
  cancelJob,
  operationsOverview,
  workQueue,
  reviewQueue,
  retentionQueue,
  monitoringQueue,
  caseQueue,
};
