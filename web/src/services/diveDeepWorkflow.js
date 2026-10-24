const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { encryptPii, decryptPii, encryptJson, decryptJson } = require('./divedeepPii');

const GATES = Object.freeze([
  { key: 'enrollment', label: 'Enrollment', phase: 'intake' },
  { key: 'authorization', label: 'Limited Authorization', phase: 'intake' },
  { key: 'intake', label: 'Protected Profile Intake', phase: 'intake' },
  { key: 'package_snapshot', label: 'Package Snapshot', phase: 'scope' },
  { key: 'sensitive_consent', label: 'Sensitive Content Consent', phase: 'scope' },
  { key: 'reference_images', label: 'Reference Images', phase: 'scope' },
  { key: 'job_readiness', label: 'Job Readiness', phase: 'dispatch' },
  { key: 'capacity_assignment', label: 'Capacity Assignment', phase: 'dispatch' },
  { key: 'execution_completion', label: 'Recon Execution', phase: 'execution' },
  { key: 'candidate_review', label: 'Candidate Review', phase: 'review' },
  { key: 'evidence_disposition', label: 'Evidence Disposition', phase: 'review' },
  { key: 'removal_approval', label: 'Removal Approval', phase: 'removal' },
  { key: 'request_delivery', label: 'Request Delivery', phase: 'removal' },
  { key: 'monitoring_activation', label: 'Monitoring Activation', phase: 'monitoring' },
  { key: 'closure', label: 'Closure or Continuation', phase: 'closure' },
]);
const GATE_STATUSES = new Set(['pending', 'pass', 'blocked', 'waived']);
const REVIEW_TASK_STATUSES = new Set(['open', 'assigned', 'awaiting_customer', 'resolved', 'expired', 'cancelled']);
const DELIVERY_STATUSES = new Set(['draft', 'approved', 'queued', 'sending', 'sent', 'acknowledged', 'customer_action', 'completed', 'failed', 'cancelled']);
const MONITOR_RESULTS = new Set(['removed', 'still_present', 'changed', 'reappeared', 'unreachable', 'blocked', 'needs_review']);
const TERMINAL_CASE_STATES = new Set(['completed', 'denied', 'withdrawn']);

function uuid() { return crypto.randomUUID(); }
function clean(value, max = 512) { return String(value == null ? '' : value).trim().slice(0, max); }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function parseJson(value, fallback = {}) { if (value == null || value === '') return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function number(value) { return Number(value) || 0; }
function statusError(message, status = 400, code = 'DIVEDEEP_WORKFLOW_INVALID') { return Object.assign(new Error(message), { status, code }); }
function gateDefinition(key) { return GATES.find((item) => item.key === key) || { key, label: key, phase: 'workflow' }; }
function result(key, status, summary, details = {}) {
  if (!GATE_STATUSES.has(status)) throw statusError(`Invalid workflow-gate state for ${key}`);
  const definition = gateDefinition(key);
  return { key, label: definition.label, phase: definition.phase, status, summary, details };
}
function authorizationActive(authorization, now = new Date()) {
  if (!authorization || authorization.status !== 'active') return false;
  return !authorization.expiresAt || new Date(authorization.expiresAt) > now;
}
function profileIdentifierCount(profile) { return Array.isArray(profile?.identifiers) ? profile.identifiers.filter((item) => item?.value).length : 0; }
function gateByKey(gates, key) { return gates.find((gate) => gate.key === key); }
function passed(gate) { return gate && ['pass', 'waived'].includes(gate.status); }
function activeJobStatus(status) { return ['created', 'ready', 'awaiting_capacity', 'dispatching', 'running', 'awaiting_review', 'evidence_ready'].includes(status); }

function initialGates(dashboard, context = {}) {
  const customer = dashboard?.customer || {};
  const profile = dashboard?.profile || null;
  const authorization = dashboard?.authorization || profile?.authorization || null;
  const manifest = context.manifest || null;
  const workerPool = context.workerPool || null;
  const providerIntegration = context.providerIntegration || null;
  const restricted = customer.planTier === 'sensitive' || customer.planTier === 'image';
  const imageRequired = Boolean(manifest?.imageAnalysis?.required || manifest?.imageAnalysis?.isRequired || manifest?.package?.imageAnalysisRequired);
  const photos = Array.isArray(dashboard?.photos) ? dashboard.photos.filter((photo) => photo.status !== 'deleted') : [];
  const identifiers = profileIdentifierCount(profile);
  const gates = [];

  gates.push(customer.status === 'active'
    ? result('enrollment', 'pass', 'Customer enrollment is active.', { customerStatus: customer.status })
    : result('enrollment', 'blocked', 'Customer account must be active before privacy work can begin.', { customerStatus: customer.status || 'unknown' }));
  gates.push(authorizationActive(authorization)
    ? result('authorization', 'pass', 'Limited Authorization is active and unexpired.', { authorizationId: authorization.id || null, expiresAt: authorization.expiresAt || null })
    : result('authorization', 'blocked', 'An active, unexpired Limited Authorization is required.', { authorizationStatus: authorization?.status || 'missing', expiresAt: authorization?.expiresAt || null }));
  gates.push(profile && identifiers > 0
    ? result('intake', 'pass', 'Protected profile contains authorized identifiers.', { profileId: profile.id, identifierCount: identifiers })
    : result('intake', 'blocked', 'Protected profile intake must contain at least one authorized identifier.', { profileId: profile?.id || null, identifierCount: identifiers }));
  gates.push(manifest?.package?.version && manifest?.sourceSet?.versionId
    ? result('package_snapshot', 'pass', 'Published package and source coverage resolve to an immutable snapshot.', { packageVersionId: manifest.package.id || null, packageVersion: manifest.package.version, sourceSetVersionId: manifest.sourceSet.versionId })
    : result('package_snapshot', 'blocked', 'The selected package must resolve to a published source-set version.', { packageId: customer.planTier || null }));
  if (!restricted) gates.push(result('sensitive_consent', 'waived', 'Sensitive-content consent is not required for this package.', { restricted: false }));
  else if (customer.age18AffirmedAt && customer.sensitiveContentConsentAt) gates.push(result('sensitive_consent', 'pass', 'Adult-status and sensitive-content consent are recorded.', { age18AffirmedAt: customer.age18AffirmedAt, sensitiveContentConsentAt: customer.sensitiveContentConsentAt }));
  else gates.push(result('sensitive_consent', 'blocked', 'Restricted packages require adult-status and separate sensitive-content consent.', { age18Affirmed: Boolean(customer.age18AffirmedAt), sensitiveContentConsent: Boolean(customer.sensitiveContentConsentAt) }));
  if (!imageRequired) gates.push(result('reference_images', 'waived', 'This package does not require reference images.', { imageRequired: false, photoCount: photos.length }));
  else if (photos.length) gates.push(result('reference_images', 'pass', 'Authorized reference images are available.', { imageRequired: true, photoCount: photos.length }));
  else gates.push(result('reference_images', 'blocked', 'At least one authorized reference image is required.', { imageRequired: true, photoCount: 0 }));

  const preconditionsPass = gates.every((gate) => passed(gate));
  const job = context.job || null;
  if (!preconditionsPass) gates.push(result('job_readiness', 'blocked', 'Enrollment, authorization, intake, and scope gates must pass first.', { blockingGateKeys: gates.filter((gate) => gate.status === 'blocked').map((gate) => gate.key) }));
  else if (job && ['blocked', 'failed', 'cancelled', 'expired'].includes(job.status)) gates.push(result('job_readiness', 'blocked', `The latest recon job is ${job.status} and requires operator action.`, { jobId: job.id, jobStatus: job.status, errorCode: job.lastErrorCode || null }));
  else gates.push(result('job_readiness', 'pass', job ? 'An immutable recon job exists for this workflow.' : 'The customer is eligible for an immutable recon job.', { jobId: job?.id || null, jobStatus: job?.status || null }));

  if (!preconditionsPass) gates.push(result('capacity_assignment', 'blocked', 'Capacity cannot be assigned until the customer is eligible.', {}));
  else if (job && job.workerPoolVersionId && !['created', 'blocked'].includes(job.status)) gates.push(result('capacity_assignment', 'pass', 'The recon job is assigned to a versioned worker pool.', { workerPoolVersionId: job.workerPoolVersionId, jobStatus: job.status }));
  else if (!providerIntegration) gates.push(result('capacity_assignment', 'blocked', 'Google Cloud Run Jobs integration is disabled or incomplete.', { provider: 'google_cloud_run' }));
  else if (!providerIntegration.config?.dispatchEnabled) gates.push(result('capacity_assignment', 'blocked', 'Cloud Run dispatch has not been authorized.', { dispatchEnabled: false }));
  else if (!workerPool?.version?.id) gates.push(result('capacity_assignment', 'blocked', 'No published worker pool is compatible with this package.', {}));
  else if (!workerPool.version.providerConfig?.dispatchEnabled) gates.push(result('capacity_assignment', 'blocked', 'The compatible worker pool has dispatch disabled.', { workerPoolVersionId: workerPool.version.id }));
  else if (number(workerPool.version.capacity?.available) < 1) gates.push(result('capacity_assignment', 'pending', 'The customer is ready, but the compatible worker pool is currently at capacity.', { workerPoolVersionId: workerPool.version.id, capacity: workerPool.version.capacity || null }));
  else gates.push(result('capacity_assignment', 'pass', 'Compatible ephemeral worker capacity is available.', { workerPoolVersionId: workerPool.version.id, capacity: workerPool.version.capacity || null }));
  return gates;
}

function evaluateDashboard(dashboard, context = {}) {
  const gates = initialGates(dashboard, context);
  const job = context.job || null;
  const counts = context.counts || {};
  const executionPrerequisites = passed(gateByKey(gates, 'job_readiness')) && passed(gateByKey(gates, 'capacity_assignment'));

  if (!executionPrerequisites) gates.push(result('execution_completion', gateByKey(gates, 'job_readiness')?.status === 'blocked' ? 'blocked' : 'pending', 'Recon execution cannot complete until dispatch gates are satisfied.', { jobId: job?.id || null }));
  else if (!job) gates.push(result('execution_completion', 'pending', 'An authorized recon job has not been created or launched yet.', {}));
  else if (['awaiting_review', 'evidence_ready', 'completed'].includes(job.status)) gates.push(result('execution_completion', 'pass', 'The ephemeral worker returned its completion record.', { jobId: job.id, jobStatus: job.status, completedAt: job.completedAt || null, sourceCompletedCount: job.sourceCompletedCount || 0 }));
  else if (['failed', 'cancelled', 'expired', 'blocked'].includes(job.status)) gates.push(result('execution_completion', 'blocked', `Recon execution ended in ${job.status}.`, { jobId: job.id, jobStatus: job.status, errorCode: job.lastErrorCode || null }));
  else gates.push(result('execution_completion', 'pending', 'Recon is queued, dispatching, or running.', { jobId: job.id, jobStatus: job.status, progressPercent: job.progressPercent || 0 }));

  const executionGate = gateByKey(gates, 'execution_completion');
  const totalCandidates = number(counts.candidates?.total) + number(counts.imageItems?.total) + number(counts.exposures?.total);
  const openReviews = Math.max(number(counts.reviewTasks?.open), number(counts.candidates?.open) + number(counts.imageItems?.open) + number(counts.exposures?.openReview));
  const customerActions = Math.max(number(counts.customerActions?.pending), number(counts.imageItems?.customerValidation));
  if (!passed(executionGate)) gates.push(result('candidate_review', executionGate.status === 'blocked' ? 'blocked' : 'pending', 'Candidate review begins after recon execution completes.', { totalCandidates, openReviews, customerActions }));
  else if (customerActions > 0) gates.push(result('candidate_review', 'pending', 'One or more candidates require customer validation.', { totalCandidates, openReviews, customerActions, customerValidationRequired: true }));
  else if (openReviews > 0) gates.push(result('candidate_review', 'pending', 'Human review tasks remain open.', { totalCandidates, openReviews }));
  else if (totalCandidates === 0) gates.push(result('candidate_review', 'waived', 'Recon completed without reviewable candidates.', { totalCandidates: 0 }));
  else gates.push(result('candidate_review', 'pass', 'All discovered candidates have been dispositioned.', { totalCandidates, confirmed: number(counts.candidates?.confirmed) + number(counts.imageItems?.confirmed) + number(counts.exposures?.confirmed) }));

  const reviewGate = gateByKey(gates, 'candidate_review');
  const pendingArtifacts = number(counts.artifacts?.pending) + number(counts.artifacts?.quarantined);
  const relevantEvidence = number(counts.artifacts?.confirmed) + number(counts.candidates?.confirmed) + number(counts.imageItems?.confirmed) + number(counts.exposures?.confirmed);
  if (!passed(reviewGate)) gates.push(result('evidence_disposition', reviewGate.status === 'blocked' ? 'blocked' : 'pending', 'Evidence disposition waits for candidate review.', { pendingArtifacts, relevantEvidence }));
  else if (pendingArtifacts > 0) gates.push(result('evidence_disposition', 'pending', 'Evidence remains pending, quarantined, or awaiting customer validation.', { pendingArtifacts, relevantEvidence }));
  else if (relevantEvidence === 0) gates.push(result('evidence_disposition', 'waived', 'No confirmed evidence requires preservation or removal action.', { relevantEvidence: 0 }));
  else gates.push(result('evidence_disposition', 'pass', 'Relevant evidence has an explicit retention and publication disposition.', { relevantEvidence }));

  const evidenceGate = gateByKey(gates, 'evidence_disposition');
  const eligibleRemovals = number(counts.exposures?.removalEligible);
  const cases = counts.cases || {};
  if (!passed(evidenceGate)) gates.push(result('removal_approval', evidenceGate.status === 'blocked' ? 'blocked' : 'pending', 'Removal preparation waits for evidence disposition.', { eligibleRemovals }));
  else if (eligibleRemovals === 0 && number(cases.total) === 0) gates.push(result('removal_approval', 'waived', 'No confirmed finding currently requires a removal request.', {}));
  else if (number(cases.draft) > 0 || number(cases.total) < eligibleRemovals) gates.push(result('removal_approval', 'pending', 'Removal cases must be prepared and approved by an authorized reviewer.', { eligibleRemovals, caseCount: number(cases.total), draftCount: number(cases.draft) }));
  else gates.push(result('removal_approval', 'pass', 'All removal-eligible findings have approved or later-stage cases.', { eligibleRemovals, caseCount: number(cases.total) }));

  const removalGate = gateByKey(gates, 'removal_approval');
  const deliveries = counts.deliveries || {};
  if (removalGate.status === 'waived') gates.push(result('request_delivery', 'waived', 'No removal request requires delivery.', {}));
  else if (!passed(removalGate)) gates.push(result('request_delivery', removalGate.status === 'blocked' ? 'blocked' : 'pending', 'Request delivery waits for removal approval.', {}));
  else if (number(deliveries.failed) > 0 && number(deliveries.actionable) === 0) gates.push(result('request_delivery', 'blocked', 'A request delivery failed and has no scheduled retry.', { failed: number(deliveries.failed) }));
  else if (number(deliveries.pending) > 0 || number(deliveries.total) < number(cases.deliverable)) gates.push(result('request_delivery', 'pending', 'Approved removal requests remain queued, unsent, or require customer action.', { deliveryCount: number(deliveries.total), pending: number(deliveries.pending), customerAction: number(deliveries.customerAction) }));
  else gates.push(result('request_delivery', 'pass', 'Removal requests have been delivered, acknowledged, or completed.', { sent: number(deliveries.sent), completed: number(deliveries.completed) }));

  const deliveryGate = gateByKey(gates, 'request_delivery');
  const monitoring = counts.monitoring || {};
  const monitoringRequired = number(cases.monitoringRequired) > 0 || number(counts.exposures?.monitorOnly) > 0;
  if (!monitoringRequired && deliveryGate.status === 'waived') gates.push(result('monitoring_activation', 'waived', 'No monitoring commitment is required for this workflow.', {}));
  else if (!passed(deliveryGate)) gates.push(result('monitoring_activation', deliveryGate.status === 'blocked' ? 'blocked' : 'pending', 'Monitoring begins after the applicable request-delivery gate.', { monitoringRequired }));
  else if (number(monitoring.active) < 1 && number(monitoring.completed) < 1) gates.push(result('monitoring_activation', 'pending', 'At least one active or completed verification schedule is required.', { monitoringRequired, activeSchedules: number(monitoring.active), completedSchedules: number(monitoring.completed) }));
  else if (number(monitoring.active) > 0) gates.push(result('monitoring_activation', 'pass', 'Monitoring is active with a scheduled next check.', { activeSchedules: number(monitoring.active), completedSchedules: number(monitoring.completed), nextRunAt: monitoring.nextRunAt || null }));
  else gates.push(result('monitoring_activation', 'pass', 'Required monitoring checks completed for this service cycle.', { activeSchedules: 0, completedSchedules: number(monitoring.completed) }));

  const run = context.workflowRun || null;
  const priorBlocking = gates.filter((gate) => gate.key !== 'closure' && gate.status === 'blocked');
  const priorPending = gates.filter((gate) => gate.key !== 'closure' && gate.status === 'pending');
  if (run && ((['completed', 'closed'].includes(run.status) && run.outcome === 'completed') || (run.status === 'monitoring' && run.outcome === 'continuing_monitoring'))) gates.push(result('closure', 'pass', run.outcome === 'continuing_monitoring' ? 'The active service cycle is closed while monitoring continues.' : 'The privacy workflow is complete.', { workflowRunId: run.id, outcome: run.outcome, closedAt: run.closedAt || null }));
  else if (priorBlocking.length) gates.push(result('closure', 'blocked', 'The workflow cannot close while a blocking gate remains.', { blockingGateKeys: priorBlocking.map((gate) => gate.key) }));
  else if (priorPending.length) gates.push(result('closure', 'pending', 'The workflow remains active until all required gates are complete.', { pendingGateKeys: priorPending.map((gate) => gate.key) }));
  else gates.push(result('closure', 'pending', 'All operational gates are satisfied. An administrator must close the cycle or continue monitoring.', { closureReady: true }));

  const blocked = gates.filter((gate) => gate.status === 'blocked');
  const pending = gates.filter((gate) => gate.status === 'pending');
  const current = blocked[0] || pending[0] || gateByKey(gates, 'closure');
  return {
    ready: passed(gateByKey(gates, 'job_readiness')) && passed(gateByKey(gates, 'capacity_assignment')),
    jobCreatable: ['pass', 'pending'].includes(gateByKey(gates, 'capacity_assignment')?.status) && gates.slice(0, 7).every((gate) => gate.status !== 'blocked'),
    complete: gateByKey(gates, 'closure')?.status === 'pass',
    closureReady: Boolean(gateByKey(gates, 'closure')?.details?.closureReady),
    currentGate: current?.key || 'closure',
    currentPhase: current?.phase || 'closure',
    gates,
    counts,
    evaluatedAt: new Date().toISOString(),
  };
}

function workflowStatusForEvaluation(evaluation, context = {}) {
  if (evaluation.complete) return context.workflowRun?.outcome === 'continuing_monitoring' ? 'monitoring' : 'complete';
  const gate = evaluation.currentGate;
  if (['enrollment', 'authorization', 'intake'].includes(gate)) return 'onboarding';
  if (['package_snapshot', 'sensitive_consent', 'reference_images'].includes(gate) && gateByKey(evaluation.gates, gate)?.status === 'blocked') return 'blocked';
  if (['job_readiness', 'capacity_assignment'].includes(gate)) return 'awaiting_dispatch';
  if (gate === 'execution_completion') return context.job?.status === 'dispatching' ? 'dispatched' : 'researching';
  if (gate === 'candidate_review') return number(evaluation.counts?.customerActions?.pending) + number(evaluation.counts?.imageItems?.customerValidation) > 0 ? 'awaiting_customer_validation' : 'awaiting_review';
  if (gate === 'evidence_disposition') return 'disposition_required';
  if (gate === 'removal_approval') return 'removal_preparation';
  if (gate === 'request_delivery') return 'requests_in_progress';
  if (gate === 'monitoring_activation') return 'monitoring';
  if (gate === 'closure') return 'closure_ready';
  return 'blocked';
}

function serializeRun(row) {
  if (!row) return null;
  return { id: row.id, customerId: row.customer_id, profileId: row.profile_id, packageVersionId: row.package_version_id, sourceSetVersionId: row.source_set_version_id, authorizationId: row.authorization_id, activeReconJobId: row.active_recon_job_id, status: row.status, stage: row.stage, outcome: row.outcome, summary: parseJson(row.summary_json, {}), startedAt: iso(row.started_at), completedAt: iso(row.completed_at), closedAt: iso(row.closed_at), closedBy: row.closed_by || null, closureReason: row.closure_reason || null, updatedAt: iso(row.updated_at) };
}

async function latestWorkflowRun(customerId, pool) {
  const [rows] = await pool.query(`SELECT * FROM divedeep_workflow_runs WHERE customer_id=? ORDER BY created_at DESC LIMIT 1`, [clean(customerId, 36)]);
  return serializeRun(rows[0]);
}

async function loadOperationalContext(customerId, pool = null) {
  const p = pool || getPool();
  const diveDeep = require('./diveDeep');
  const catalog = require('./platformCatalog');
  const workerPools = require('./diveDeepWorkerPools');
  const dashboard = await diveDeep.getCustomerDashboard(customerId, p, { includeUnpublished: true, findingPageSize: 1 });
  let manifest = null; let workerPool = null; let providerIntegration = null;
  try { manifest = await catalog.resolvePackageSourceManifest(dashboard.customer.planTier, null, p); } catch { /* represented by package gate */ }
  if (manifest) { try { workerPool = await workerPools.selectPoolForManifest(manifest, p); } catch { /* represented by capacity gate */ } }
  try { providerIntegration = await require('./diveDeepIntegrations').getRuntimeIntegration('google_cloud_run', p); } catch { /* represented by capacity gate */ }
  const [jobRows] = await p.query(`SELECT * FROM divedeep_recon_jobs WHERE customer_id=? ORDER BY created_at DESC LIMIT 1`, [customerId]);
  const jobRow = jobRows[0];
  const job = jobRow ? {
    id: jobRow.id, status: jobRow.status, workerPoolVersionId: jobRow.worker_pool_version_id, progressPercent: number(jobRow.progress_percent), sourceCompletedCount: number(jobRow.source_completed_count), sourceCount: number(jobRow.source_count), candidateCount: number(jobRow.candidate_count), completedAt: iso(jobRow.completed_at), lastErrorCode: jobRow.last_error_code || null,
  } : null;
  const [[candidateRows], [imageRows], [artifactRows], [exposureRows], [caseRows], [deliveryRows], [monitorRows], [reviewRows], [actionRows]] = await Promise.all([
    p.query(`SELECT COUNT(*) total,SUM(state IN ('review_required','customer_validation_requested')) open,SUM(state IN ('confirmed','promoted')) confirmed,SUM(state IN ('rejected','expired')) rejected FROM divedeep_recon_candidates WHERE recon_job_id IN (SELECT id FROM divedeep_recon_jobs WHERE customer_id=?)`, [customerId]),
    p.query(`SELECT COUNT(*) total,SUM(i.state IN ('likely_match','customer_validation_requested')) open,SUM(i.state='customer_validation_requested' AND i.customer_disposition='pending') customer_validation,SUM(i.state IN ('reviewer_confirmed','customer_confirmed')) confirmed FROM divedeep_image_analysis_items i JOIN divedeep_image_analysis_sessions s ON s.id=i.session_id WHERE s.customer_id=?`, [customerId]),
    p.query(`SELECT COUNT(*) total,SUM(review_status IN ('pending','customer_validation')) pending,SUM(status='quarantined') quarantined,SUM(review_status='confirmed') confirmed FROM divedeep_artifacts WHERE customer_id=? AND status<>'deleted'`, [customerId]),
    p.query(`SELECT COUNT(*) total,SUM(status IN ('open','review')) open_review,SUM(status IN ('confirmed','preserved','removed','reappeared')) confirmed,SUM(status IN ('confirmed','reappeared') AND visibility_action='remove') removal_eligible,SUM(visibility_action='monitor' AND status NOT IN ('false_positive','ignored')) monitor_only FROM divedeep_exposures WHERE tenant_id=?`, [customerId]),
    p.query(`SELECT COUNT(*) total,SUM(state='draft') draft,SUM(state IN ('approved','queued','sent','acknowledged','needs_action','completed','denied')) approved_or_later,SUM(state IN ('approved','queued','sent','acknowledged','needs_action')) deliverable,SUM(state IN ('sent','acknowledged','needs_action','completed','denied')) monitoring_required,SUM(state NOT IN ('completed','denied','withdrawn')) unresolved FROM divedeep_cases WHERE tenant_id=?`, [customerId]),
    p.query(`SELECT COUNT(*) total,SUM(status IN ('draft','approved','queued','sending','customer_action')) pending,SUM(status='failed') failed,SUM(status='failed' AND next_attempt_at IS NOT NULL) actionable,SUM(status='customer_action') customer_action,SUM(status IN ('sent','acknowledged')) sent,SUM(status='completed') completed FROM divedeep_request_deliveries WHERE customer_id=?`, [customerId]),
    p.query(`SELECT COUNT(*) total,SUM(status='active') active,SUM(status='completed') completed,SUM(status='failed') failed,MIN(CASE WHEN status='active' THEN next_run_at END) next_run_at FROM divedeep_monitoring_schedules WHERE customer_id=?`, [customerId]),
    p.query(`SELECT COUNT(*) total,SUM(status IN ('open','assigned','awaiting_customer')) open,SUM(status='awaiting_customer') awaiting_customer FROM divedeep_review_tasks WHERE customer_id=?`, [customerId]),
    p.query(`SELECT COUNT(*) total,SUM(status IN ('pending','viewed')) pending FROM divedeep_customer_action_requests WHERE customer_id=?`, [customerId]),
  ]);
  const workflowRun = await latestWorkflowRun(customerId, p);
  return {
    dashboard, manifest, workerPool, providerIntegration, job, workflowRun,
    counts: {
      candidates: { total: number(candidateRows[0]?.total), open: number(candidateRows[0]?.open), confirmed: number(candidateRows[0]?.confirmed), rejected: number(candidateRows[0]?.rejected) },
      imageItems: { total: number(imageRows[0]?.total), open: number(imageRows[0]?.open), customerValidation: number(imageRows[0]?.customer_validation), confirmed: number(imageRows[0]?.confirmed) },
      artifacts: { total: number(artifactRows[0]?.total), pending: number(artifactRows[0]?.pending), quarantined: number(artifactRows[0]?.quarantined), confirmed: number(artifactRows[0]?.confirmed) },
      exposures: { total: number(exposureRows[0]?.total), openReview: number(exposureRows[0]?.open_review), confirmed: number(exposureRows[0]?.confirmed), removalEligible: number(exposureRows[0]?.removal_eligible), monitorOnly: number(exposureRows[0]?.monitor_only) },
      cases: { total: number(caseRows[0]?.total), draft: number(caseRows[0]?.draft), approvedOrLater: number(caseRows[0]?.approved_or_later), deliverable: number(caseRows[0]?.deliverable), monitoringRequired: number(caseRows[0]?.monitoring_required), unresolved: number(caseRows[0]?.unresolved) },
      deliveries: { total: number(deliveryRows[0]?.total), pending: number(deliveryRows[0]?.pending), failed: number(deliveryRows[0]?.failed), actionable: number(deliveryRows[0]?.actionable), customerAction: number(deliveryRows[0]?.customer_action), sent: number(deliveryRows[0]?.sent), completed: number(deliveryRows[0]?.completed) },
      monitoring: { total: number(monitorRows[0]?.total), active: number(monitorRows[0]?.active), completed: number(monitorRows[0]?.completed), failed: number(monitorRows[0]?.failed), nextRunAt: iso(monitorRows[0]?.next_run_at) },
      reviewTasks: { total: number(reviewRows[0]?.total), open: number(reviewRows[0]?.open), awaitingCustomer: number(reviewRows[0]?.awaiting_customer) },
      customerActions: { total: number(actionRows[0]?.total), pending: number(actionRows[0]?.pending) },
    },
  };
}

async function ensureWorkflowRun(connection, customerId, evaluation, context, actorId) {
  await connection.query(`SELECT id FROM divedeep_customers WHERE id=? FOR UPDATE`, [customerId]);
  const [rows] = await connection.query(`SELECT * FROM divedeep_workflow_runs WHERE customer_id=? AND status IN ('active','blocked','monitoring') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [customerId]);
  let row = rows[0];
  if (!row) {
    const id = uuid();
    await connection.query(`INSERT INTO divedeep_workflow_runs (id,customer_id,profile_id,package_version_id,source_set_version_id,authorization_id,active_recon_job_id,status,stage,outcome,summary_json) VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`, [id, customerId, context.dashboard?.profile?.id || null, context.manifest?.package?.id || null, context.manifest?.sourceSet?.versionId || null, context.dashboard?.authorization?.id || context.dashboard?.profile?.authorization?.id || null, context.job?.id || null, evaluation.currentGate === 'closure' ? 'active' : (evaluation.gates.some((gate) => gate.status === 'blocked') ? 'blocked' : 'active'), evaluation.currentGate, JSON.stringify({ createdBy: actorId, lastEvaluation: evaluation.evaluatedAt })]);
    const [created] = await connection.query(`SELECT * FROM divedeep_workflow_runs WHERE id=?`, [id]);
    row = created[0];
  }
  return row;
}

async function persistEvaluation(customerId, evaluation, actorId = 'system', pool = null, context = {}) {
  const p = pool || getPool();
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    const run = await ensureWorkflowRun(connection, customerId, evaluation, context, actorId);
    const [previousRows] = await connection.query(`SELECT gate_key,status FROM divedeep_customer_workflow_gates WHERE customer_id=? FOR UPDATE`, [customerId]);
    const previous = new Map(previousRows.map((row) => [row.gate_key, row.status]));
    for (const gate of evaluation.gates) {
      await connection.query(`INSERT INTO divedeep_customer_workflow_gates (id,customer_id,gate_key,status,summary,details_json,evaluated_at,evaluated_by) VALUES (?,?,?,?,?,?,NOW(3),?) ON DUPLICATE KEY UPDATE status=VALUES(status),summary=VALUES(summary),details_json=VALUES(details_json),evaluated_at=NOW(3),evaluated_by=VALUES(evaluated_by),updated_at=NOW(3)`, [uuid(), customerId, gate.key, gate.status, clean(gate.summary, 1000), JSON.stringify(gate.details || {}), clean(actorId, 128) || 'system']);
      if (previous.get(gate.key) !== gate.status) await connection.query(`INSERT INTO divedeep_workflow_gate_events (id,workflow_run_id,customer_id,gate_key,previous_status,new_status,reason,details_json,actor_type,actor_id) VALUES (?,?,?,?,?,?,?,?,?,?)`, [uuid(), run.id, customerId, gate.key, previous.get(gate.key) || null, gate.status, clean(gate.summary, 1000), JSON.stringify(gate.details || {}), actorId === 'system' ? 'system' : 'admin', clean(actorId, 128) || null]);
    }
    const workflowStatus = workflowStatusForEvaluation(evaluation, context);
    const runStatus = evaluation.complete ? (context.workflowRun?.outcome === 'continuing_monitoring' ? 'monitoring' : 'completed') : (evaluation.gates.some((gate) => gate.status === 'blocked') ? 'blocked' : (workflowStatus === 'monitoring' ? 'monitoring' : 'active'));
    await connection.query(`UPDATE divedeep_workflow_runs SET profile_id=?,package_version_id=?,source_set_version_id=?,authorization_id=?,active_recon_job_id=?,status=?,stage=?,summary_json=?,completed_at=IF(?='completed',COALESCE(completed_at,NOW(3)),completed_at),updated_at=NOW(3) WHERE id=?`, [context.dashboard?.profile?.id || null, context.manifest?.package?.id || null, context.manifest?.sourceSet?.versionId || null, context.dashboard?.authorization?.id || context.dashboard?.profile?.authorization?.id || null, context.job?.id || null, runStatus, evaluation.currentGate, JSON.stringify({ counts: evaluation.counts, currentPhase: evaluation.currentPhase, closureReady: evaluation.closureReady, evaluatedAt: evaluation.evaluatedAt }), runStatus, run.id]);
    await connection.query(`UPDATE divedeep_customers SET workflow_status=?,updated_at=NOW(3) WHERE id=?`, [workflowStatus, customerId]);
    await connection.query(`INSERT INTO divedeep_customer_events (id,customer_id,event_type,actor_type,actor_id,details_enc) VALUES (?,?,?,?,?,?)`, [uuid(), customerId, 'workflow.evaluated', actorId === 'system' ? 'system' : 'admin', clean(actorId, 128) || null, encryptJson({ workflowRunId: run.id, currentGate: evaluation.currentGate, workflowStatus, closureReady: evaluation.closureReady })]);
    await connection.commit();
    return { ...evaluation, workflowStatus, workflowRunId: run.id };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function evaluateCustomer(customerId, actorId = 'system', pool = null) {
  const p = pool || getPool();
  const context = await loadOperationalContext(customerId, p);
  const evaluation = evaluateDashboard(context.dashboard, context);
  const persisted = await persistEvaluation(customerId, evaluation, actorId, p, context);
  return { ...persisted, manifest: context.manifest, workerPool: context.workerPool, customer: context.dashboard.customer, job: context.job };
}

async function getCustomerGates(customerId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT gate_key,status,summary,details_json,evaluated_at,evaluated_by,updated_at FROM divedeep_customer_workflow_gates WHERE customer_id=? ORDER BY FIELD(gate_key,'enrollment','authorization','intake','package_snapshot','sensitive_consent','reference_images','job_readiness','capacity_assignment','execution_completion','candidate_review','evidence_disposition','removal_approval','request_delivery','monitoring_activation','closure')`, [clean(customerId, 64)]);
  return rows.map((row) => ({ key: row.gate_key, label: gateDefinition(row.gate_key).label, phase: gateDefinition(row.gate_key).phase, status: row.status, summary: row.summary, details: parseJson(row.details_json, {}), evaluatedAt: iso(row.evaluated_at), evaluatedBy: row.evaluated_by || null, updatedAt: iso(row.updated_at) }));
}

async function reconcileReviewTasks(customerId, actorId = 'system', pool = null) {
  const p = pool || getPool();
  const dueAt = new Date(Date.now() + 30 * 86400000);
  const connection = await p.getConnection();
  let created = 0;
  try {
    await connection.beginTransaction();
    const [candidateRows] = await connection.query(`SELECT c.id,c.recon_job_id,c.state,c.review_band,c.sensitivity FROM divedeep_recon_candidates c JOIN divedeep_recon_jobs j ON j.id=c.recon_job_id WHERE j.customer_id=? AND c.state IN ('review_required','customer_validation_requested')`, [customerId]);
    for (const row of candidateRows) {
      const status = row.review_band === 'customer_validation_eligible' || row.state === 'customer_validation_requested' ? 'awaiting_customer' : 'open';
      const priority = row.review_band === 'high_priority' ? 'high' : 'normal';
      const [resultSet] = await connection.query(`INSERT IGNORE INTO divedeep_review_tasks (id,customer_id,recon_job_id,entity_type,entity_id,review_type,status,priority,due_at) VALUES (?,?,?,'recon_candidate',?,'identity_match',?,?,?)`, [uuid(), customerId, row.recon_job_id, row.id, status, priority, dueAt]);
      created += resultSet.affectedRows || 0;
    }
    const [imageRows] = await connection.query(`SELECT i.id,s.recon_job_id,i.state,i.review_band FROM divedeep_image_analysis_items i JOIN divedeep_image_analysis_sessions s ON s.id=i.session_id WHERE s.customer_id=? AND i.state IN ('likely_match','customer_validation_requested')`, [customerId]);
    for (const row of imageRows) {
      const status = row.state === 'customer_validation_requested' ? 'awaiting_customer' : 'open';
      const [resultSet] = await connection.query(`INSERT IGNORE INTO divedeep_review_tasks (id,customer_id,recon_job_id,entity_type,entity_id,review_type,status,priority,due_at) VALUES (?,?,?,'image_analysis_item',?,'identity_match',?,?,?)`, [uuid(), customerId, row.recon_job_id, row.id, status, row.review_band === 'high_priority' ? 'high' : 'normal', dueAt]);
      created += resultSet.affectedRows || 0;
      if (status === 'awaiting_customer') await connection.query(`INSERT INTO divedeep_customer_action_requests (id,customer_id,workflow_run_id,action_type,entity_type,entity_id,status,title,instructions_enc,due_at) SELECT ?,?,(SELECT id FROM divedeep_workflow_runs WHERE customer_id=? ORDER BY created_at DESC LIMIT 1),'image_validation','image_analysis_item',?,'pending','Please confirm whether this image belongs to you',?,? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM divedeep_customer_action_requests WHERE customer_id=? AND action_type='image_validation' AND entity_type='image_analysis_item' AND entity_id=?)`, [uuid(), customerId, customerId, row.id, encryptPii('Review the protected blurred preview and choose Yes, Not me, or Unsure.'), dueAt, customerId, row.id]);
    }
    const [exposureRows] = await connection.query(`SELECT id FROM divedeep_exposures WHERE tenant_id=? AND status IN ('open','review')`, [customerId]);
    for (const row of exposureRows) { const [r] = await connection.query(`INSERT IGNORE INTO divedeep_review_tasks (id,customer_id,entity_type,entity_id,review_type,status,priority,due_at) VALUES (?,?,'exposure',?,'evidence_disposition','open','normal',?)`, [uuid(), customerId, row.id, dueAt]); created += r.affectedRows || 0; }
    const [artifactRows] = await connection.query(`SELECT id,recon_job_id,sensitivity FROM divedeep_artifacts WHERE customer_id=? AND status IN ('available','quarantined') AND review_status IN ('pending','customer_validation')`, [customerId]);
    for (const row of artifactRows) { const [r] = await connection.query(`INSERT IGNORE INTO divedeep_review_tasks (id,customer_id,recon_job_id,entity_type,entity_id,review_type,status,priority,due_at) VALUES (?,?,?,'artifact',?,'evidence_disposition',?,?,?)`, [uuid(), customerId, row.recon_job_id, row.id, row.sensitivity === 'restricted' ? 'high' : 'normal', dueAt]); created += r.affectedRows || 0; }
    await connection.query(`UPDATE divedeep_review_tasks t JOIN divedeep_recon_candidates c ON t.entity_type='recon_candidate' AND t.entity_id=c.id SET t.status='resolved',t.disposition=c.state,t.resolved_at=COALESCE(t.resolved_at,NOW(3)),t.updated_at=NOW(3) WHERE t.customer_id=? AND t.status IN ('open','assigned','awaiting_customer') AND c.state NOT IN ('review_required','customer_validation_requested')`, [customerId]);
    await connection.query(`UPDATE divedeep_review_tasks t JOIN divedeep_image_analysis_items i ON t.entity_type='image_analysis_item' AND t.entity_id=i.id SET t.status='resolved',t.disposition=i.state,t.resolved_at=COALESCE(t.resolved_at,NOW(3)),t.updated_at=NOW(3) WHERE t.customer_id=? AND t.status IN ('open','assigned','awaiting_customer') AND i.state NOT IN ('likely_match','customer_validation_requested')`, [customerId]);
    await connection.query(`UPDATE divedeep_customer_action_requests a JOIN divedeep_image_analysis_items i ON a.entity_type='image_analysis_item' AND a.entity_id=i.id SET a.status='completed',a.completed_at=COALESCE(a.completed_at,NOW(3)),a.updated_at=NOW(3) WHERE a.customer_id=? AND a.status IN ('pending','viewed') AND i.customer_disposition<>'pending'`, [customerId]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  const evaluation = await evaluateCustomer(customerId, actorId, p);
  return { created, evaluation };
}

async function listReviewTasks(filters = {}, pool = null) {
  const p = pool || getPool(); const where = []; const params = [];
  if (filters.customerId) { where.push('t.customer_id=?'); params.push(clean(filters.customerId, 36)); }
  if (filters.status) { where.push('t.status=?'); params.push(clean(filters.status, 32)); }
  const limit = Math.min(Math.max(number(filters.limit) || 500, 1), 1000); params.push(limit);
  const [rows] = await p.query(`SELECT t.*,c.first_name_enc,c.last_name_enc,c.email_enc FROM divedeep_review_tasks t LEFT JOIN divedeep_customers c ON c.id=t.customer_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY FIELD(t.priority,'urgent','high','normal','low'),COALESCE(t.due_at,t.created_at),t.created_at LIMIT ?`, params);
  return rows.map((row) => ({ id: row.id, customerId: row.customer_id, customer: { displayName: [decryptPii(row.first_name_enc), decryptPii(row.last_name_enc)].filter(Boolean).join(' '), email: decryptPii(row.email_enc) }, reconJobId: row.recon_job_id, entityType: row.entity_type, entityId: row.entity_id, reviewType: row.review_type, status: row.status, priority: row.priority, assignedTo: row.assigned_to || null, assignedAt: iso(row.assigned_at), dueAt: iso(row.due_at), disposition: row.disposition || null, confidence: row.confidence == null ? null : Number(row.confidence), note: row.note || null, resolvedBy: row.resolved_by || null, resolvedAt: iso(row.resolved_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }));
}

async function updateReviewTask(taskId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT * FROM divedeep_review_tasks WHERE id=? LIMIT 1`, [clean(taskId, 36)]); const task = rows[0];
  if (!task) throw statusError('Review task not found', 404, 'DIVEDEEP_REVIEW_TASK_NOT_FOUND');
  const status = clean(input.status || task.status, 32); if (!REVIEW_TASK_STATUSES.has(status)) throw statusError('Invalid review-task status');
  const disposition = clean(input.disposition || task.disposition, 64) || null;
  const confidence = input.confidence == null || input.confidence === '' ? task.confidence : Math.max(0, Math.min(100, Number(input.confidence)));
  const assignedTo = clean(input.assignedTo || (status === 'assigned' ? actorId : task.assigned_to), 128) || null;
  await p.query(`UPDATE divedeep_review_tasks SET status=?,priority=COALESCE(?,priority),assigned_to=?,assigned_at=IF(? IS NOT NULL,COALESCE(assigned_at,NOW(3)),assigned_at),disposition=?,confidence=?,note=?,resolved_by=IF(?='resolved',?,resolved_by),resolved_at=IF(?='resolved',NOW(3),resolved_at),updated_at=NOW(3) WHERE id=?`, [status, clean(input.priority, 16) || null, assignedTo, assignedTo, disposition, confidence, clean(input.note, 2000) || task.note, status, clean(actorId, 128) || null, status, task.id]);
  await evaluateCustomer(task.customer_id, actorId || 'system', p);
  return (await listReviewTasks({ customerId: task.customer_id, limit: 1000 }, p)).find((item) => item.id === task.id);
}

async function createDelivery(caseId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const [caseRows] = await p.query(`SELECT * FROM divedeep_cases WHERE id=? LIMIT 1`, [clean(caseId, 36)]); const privacyCase = caseRows[0];
  if (!privacyCase) throw statusError('Removal case not found', 404, 'DIVEDEEP_CASE_NOT_FOUND');
  if (!['approved','queued','needs_action','failed'].includes(privacyCase.state)) throw statusError('Removal case must be approved before delivery is prepared', 409, 'DIVEDEEP_CASE_NOT_APPROVED');
  const method = clean(input.deliveryMethod || privacyCase.delivery_method, 32);
  if (!new Set(['email','customer_form','api','browser','guidance']).has(method)) throw statusError('Invalid delivery method');
  const requestedStatus = clean(input.status || 'approved', 32);
  if (!DELIVERY_STATUSES.has(requestedStatus)) throw statusError('Invalid delivery status');
  const status = method === 'customer_form' && requestedStatus === 'approved' ? 'customer_action' : requestedStatus;
  const id = uuid();
  await p.query(`INSERT INTO divedeep_request_deliveries (id,customer_id,case_id,delivery_method,provider,destination_enc,status,max_attempts,next_attempt_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE provider=VALUES(provider),destination_enc=VALUES(destination_enc),status=VALUES(status),max_attempts=VALUES(max_attempts),next_attempt_at=VALUES(next_attempt_at),updated_at=NOW(3)`, [id, privacyCase.tenant_id, privacyCase.id, method, clean(input.provider, 64) || null, input.destination ? encryptPii(clean(input.destination, 1000)) : null, status, Math.min(Math.max(number(input.maxAttempts) || 4, 1), 20), input.nextAttemptAt ? new Date(input.nextAttemptAt) : null, clean(actorId, 128) || null]);
  const [deliveryRows] = await p.query(`SELECT * FROM divedeep_request_deliveries WHERE case_id=? AND delivery_method=? LIMIT 1`, [privacyCase.id, method]);
  const delivery = deliveryRows[0];
  if (method === 'customer_form' || status === 'customer_action') {
    await p.query(`INSERT INTO divedeep_customer_action_requests (id,customer_id,workflow_run_id,action_type,entity_type,entity_id,status,title,instructions_enc,due_at) SELECT ?,?,(SELECT id FROM divedeep_workflow_runs WHERE customer_id=? ORDER BY created_at DESC LIMIT 1),'removal_form','request_delivery',?,'pending','Complete the required removal form',?,? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM divedeep_customer_action_requests WHERE customer_id=? AND action_type='removal_form' AND entity_type='request_delivery' AND entity_id=?)`, [uuid(), privacyCase.tenant_id, privacyCase.tenant_id, delivery.id, encryptPii(clean(input.customerInstructions || 'Complete the requested form so the removal request can proceed.', 2000)), input.customerDueAt ? new Date(input.customerDueAt) : new Date(Date.now() + 7 * 86400000), privacyCase.tenant_id, delivery.id]);
  }
  await p.query(`UPDATE divedeep_cases SET state=?,updated_at=NOW(3),revision=revision+1 WHERE id=?`, [method === 'customer_form' || status === 'customer_action' ? 'needs_action' : 'queued', privacyCase.id]);
  await evaluateCustomer(privacyCase.tenant_id, actorId || 'system', p);
  return serializeDelivery(delivery);
}

function serializeDelivery(row) { if (!row) return null; return { id: row.id, customerId: row.customer_id, caseId: row.case_id, deliveryMethod: row.delivery_method, provider: row.provider || null, status: row.status, attemptCount: number(row.attempt_count), maxAttempts: number(row.max_attempts), nextAttemptAt: iso(row.next_attempt_at), sentAt: iso(row.sent_at), acknowledgedAt: iso(row.acknowledged_at), completedAt: iso(row.completed_at), providerMessageId: row.provider_message_id || null, confirmationReference: row.confirmation_reference || null, lastErrorCode: row.last_error_code || null, lastErrorMessage: row.last_error_message || null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }

async function listDeliveries(filters = {}, pool = null) {
  const p = pool || getPool(); const where=[]; const params=[];
  if (filters.customerId) { where.push('d.customer_id=?'); params.push(clean(filters.customerId,36)); }
  if (filters.status) { where.push('d.status=?'); params.push(clean(filters.status,32)); }
  params.push(Math.min(Math.max(number(filters.limit)||500,1),1000));
  const [rows]=await p.query(`SELECT d.* FROM divedeep_request_deliveries d ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY d.updated_at DESC LIMIT ?`,params); return rows.map(serializeDelivery);
}

function caseStateForDelivery(status) { return { approved:'approved',queued:'queued',sending:'queued',sent:'sent',acknowledged:'acknowledged',customer_action:'needs_action',completed:'completed',failed:'failed',cancelled:'withdrawn' }[status] || null; }
async function recordDeliveryAttempt(deliveryId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT * FROM divedeep_request_deliveries WHERE id=? LIMIT 1`, [clean(deliveryId,36)]); const delivery=rows[0]; if(!delivery) throw statusError('Delivery not found',404,'DIVEDEEP_DELIVERY_NOT_FOUND');
  const status=clean(input.status,32); if(!DELIVERY_STATUSES.has(status) || ['draft','approved','cancelled'].includes(status)) throw statusError('Invalid delivery-attempt status');
  const attemptNumber=number(delivery.attempt_count)+1; if(attemptNumber>number(delivery.max_attempts)) throw statusError('Delivery attempt limit reached',409,'DIVEDEEP_DELIVERY_ATTEMPT_LIMIT');
  const connection=await p.getConnection();
  try{
    await connection.beginTransaction();
    await connection.query(`INSERT INTO divedeep_request_delivery_attempts (id,delivery_id,attempt_number,status,provider_status,provider_message_id,response_enc,error_code,error_message,completed_at) VALUES (?,?,?,?,?,?,?,?,?,NOW(3))`,[uuid(),delivery.id,attemptNumber,status==='sending'?'started':status,clean(input.providerStatus,96)||null,clean(input.providerMessageId,255)||null,input.response?encryptJson(input.response):null,clean(input.errorCode,96)||null,clean(input.errorMessage,2000)||null]);
    const nextAttempt=status==='failed'&&attemptNumber<number(delivery.max_attempts)?new Date(Date.now()+Math.min(24,Math.pow(2,attemptNumber))*3600000):null;
    await connection.query(`UPDATE divedeep_request_deliveries SET status=?,attempt_count=?,next_attempt_at=?,sent_at=IF(?='sent',COALESCE(sent_at,NOW(3)),sent_at),acknowledged_at=IF(?='acknowledged',COALESCE(acknowledged_at,NOW(3)),acknowledged_at),completed_at=IF(?='completed',COALESCE(completed_at,NOW(3)),completed_at),provider_message_id=COALESCE(?,provider_message_id),confirmation_reference=COALESCE(?,confirmation_reference),last_error_code=?,last_error_message=?,updated_at=NOW(3) WHERE id=?`,[status,attemptNumber,nextAttempt,status,status,status,clean(input.providerMessageId,255)||null,clean(input.confirmationReference,255)||null,clean(input.errorCode,96)||null,clean(input.errorMessage,2000)||null,delivery.id]);
    const caseState=caseStateForDelivery(status); if(caseState) await connection.query(`UPDATE divedeep_cases SET state=?,sent_at=IF(?='sent',COALESCE(sent_at,NOW(3)),sent_at),confirmation_reference=COALESCE(?,confirmation_reference),updated_at=NOW(3),revision=revision+1 WHERE id=?`,[caseState,caseState,clean(input.confirmationReference,255)||null,delivery.case_id]);
    if(status==='customer_action') await connection.query(`INSERT INTO divedeep_customer_action_requests (id,customer_id,workflow_run_id,action_type,entity_type,entity_id,status,title,instructions_enc,due_at) SELECT ?,?,(SELECT id FROM divedeep_workflow_runs WHERE customer_id=? ORDER BY created_at DESC LIMIT 1),'removal_form','request_delivery',?,'pending','Complete the required removal form',?,? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM divedeep_customer_action_requests WHERE customer_id=? AND action_type='removal_form' AND entity_type='request_delivery' AND entity_id=?)`,[uuid(),delivery.customer_id,delivery.customer_id,delivery.id,encryptPii(clean(input.customerInstructions||'Complete the requested form so the removal request can proceed.',2000)),input.customerDueAt?new Date(input.customerDueAt):new Date(Date.now()+7*86400000),delivery.customer_id,delivery.id]);
    if(['sent','acknowledged','completed','cancelled'].includes(status)) await connection.query(`UPDATE divedeep_customer_action_requests SET status=IF(?='cancelled','cancelled','completed'),completed_at=IF(?='cancelled',completed_at,COALESCE(completed_at,NOW(3))),updated_at=NOW(3) WHERE customer_id=? AND entity_type='request_delivery' AND entity_id=? AND status IN ('pending','viewed')`,[status,status,delivery.customer_id,delivery.id]);
    await connection.query(`INSERT INTO divedeep_case_events (id,tenant_id,case_id,event_type,actor_type,actor_id,details_json) VALUES (?,?,?,?,?,?,?)`,[uuid(),delivery.customer_id,delivery.case_id,`delivery.${status}`,'admin',clean(actorId,128)||null,JSON.stringify({deliveryId:delivery.id,attemptNumber,status,providerStatus:clean(input.providerStatus,96)||null})]);
    await connection.commit();
  }catch(error){await connection.rollback();throw error;}finally{connection.release();}
  await evaluateCustomer(delivery.customer_id,actorId||'system',p); return (await listDeliveries({customerId:delivery.customer_id,limit:1000},p)).find((item)=>item.id===delivery.id);
}

async function createMonitoringSchedule(customerId, input = {}, actorId = null, pool = null) {
  const p=pool||getPool(); const type=clean(input.monitorType||'removal_verification',64); const allowed=new Set(['removal_verification','reappearance_check','known_url','package_rescan','sensitive_image_recheck','response_deadline']); if(!allowed.has(type)) throw statusError('Invalid monitoring type');
  const cadence=clean(input.cadence||'once',32); if(!new Set(['once','daily','weekly','monthly','quarterly']).has(cadence)) throw statusError('Invalid monitoring cadence');
  if(input.caseId){const [rows]=await p.query(`SELECT id FROM divedeep_cases WHERE id=? AND tenant_id=? LIMIT 1`,[clean(input.caseId,36),clean(customerId,36)]);if(!rows[0])throw statusError('Removal case not found for this customer',404,'DIVEDEEP_CASE_NOT_FOUND');}
  const id=uuid(); await p.query(`INSERT INTO divedeep_monitoring_schedules (id,customer_id,profile_id,exposure_id,case_id,monitor_type,cadence,status,next_run_at,configuration_json,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[id,clean(customerId,36),clean(input.profileId,36)||null,clean(input.exposureId,36)||null,clean(input.caseId,36)||null,type,cadence,input.activate===false?'draft':'active',input.nextRunAt?new Date(input.nextRunAt):new Date(Date.now()+86400000),JSON.stringify(input.configuration&&typeof input.configuration==='object'?input.configuration:{}),clean(actorId,128)||null]); await evaluateCustomer(customerId,actorId||'system',p); return getMonitoringSchedule(id,p);
}
function nextForCadence(cadence,from=new Date()){const d=new Date(from);if(cadence==='daily')d.setUTCDate(d.getUTCDate()+1);else if(cadence==='weekly')d.setUTCDate(d.getUTCDate()+7);else if(cadence==='monthly')d.setUTCMonth(d.getUTCMonth()+1);else if(cadence==='quarterly')d.setUTCMonth(d.getUTCMonth()+3);else return null;return d;}
async function getMonitoringSchedule(id,pool=null){const p=pool||getPool();const [rows]=await p.query(`SELECT * FROM divedeep_monitoring_schedules WHERE id=? LIMIT 1`,[clean(id,36)]);const row=rows[0];if(!row)throw statusError('Monitoring schedule not found',404,'DIVEDEEP_MONITORING_NOT_FOUND');return{id:row.id,customerId:row.customer_id,profileId:row.profile_id,exposureId:row.exposure_id,caseId:row.case_id,monitorType:row.monitor_type,cadence:row.cadence,status:row.status,nextRunAt:iso(row.next_run_at),lastRunAt:iso(row.last_run_at),failureCount:number(row.failure_count),configuration:parseJson(row.configuration_json,{}),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
async function listMonitoringSchedules(filters={},pool=null){const p=pool||getPool();const where=[];const params=[];if(filters.customerId){where.push('customer_id=?');params.push(clean(filters.customerId,36));}if(filters.status){where.push('status=?');params.push(clean(filters.status,32));}params.push(Math.min(Math.max(number(filters.limit)||500,1),1000));const [rows]=await p.query(`SELECT id FROM divedeep_monitoring_schedules ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY COALESCE(next_run_at,updated_at) ASC LIMIT ?`,params);return Promise.all(rows.map((row)=>getMonitoringSchedule(row.id,p)));}
async function recordMonitoringCheck(scheduleId,input={},actorId=null,pool=null){const p=pool||getPool();const schedule=await getMonitoringSchedule(scheduleId,p);const outcome=clean(input.result,32);if(!MONITOR_RESULTS.has(outcome))throw statusError('Invalid monitoring result');const id=uuid();const connection=await p.getConnection();try{await connection.beginTransaction();await connection.query(`INSERT INTO divedeep_monitoring_checks (id,schedule_id,customer_id,result,http_status,content_fingerprint,artifact_id,notes_enc,checked_by) VALUES (?,?,?,?,?,?,?,?,?)`,[id,schedule.id,schedule.customerId,outcome,input.httpStatus==null?null:number(input.httpStatus),clean(input.contentFingerprint,64)||null,clean(input.artifactId,36)||null,input.notes?encryptPii(clean(input.notes,4000)):null,clean(actorId,128)||null]);const next=nextForCadence(schedule.cadence);const status=schedule.cadence==='once'?'completed':(outcome==='blocked'?'failed':'active');await connection.query(`UPDATE divedeep_monitoring_schedules SET status=?,last_run_at=NOW(3),next_run_at=?,failure_count=IF(? IN ('blocked','unreachable'),failure_count+1,0),updated_at=NOW(3) WHERE id=?`,[status,next,outcome,schedule.id]);if(schedule.exposureId&&outcome==='removed')await connection.query(`UPDATE divedeep_exposures SET status='removed',last_seen_at=NOW(3),updated_at=NOW(3) WHERE id=?`,[schedule.exposureId]);if(schedule.exposureId&&outcome==='reappeared')await connection.query(`UPDATE divedeep_exposures SET status='reappeared',last_seen_at=NOW(3),updated_at=NOW(3) WHERE id=?`,[schedule.exposureId]);if(schedule.caseId&&outcome==='removed')await connection.query(`UPDATE divedeep_cases SET state='completed',updated_at=NOW(3),revision=revision+1 WHERE id=?`,[schedule.caseId]);if(schedule.caseId&&['still_present','reappeared','needs_review'].includes(outcome))await connection.query(`UPDATE divedeep_cases SET state='needs_action',updated_at=NOW(3),revision=revision+1 WHERE id=? AND state NOT IN ('withdrawn')`,[schedule.caseId]);if(schedule.caseId&&schedule.exposureId&&schedule.profileId)await connection.query(`INSERT INTO divedeep_verifications (id,tenant_id,profile_id,case_id,exposure_id,result,source_url,notes_enc,checked_at,evidence_ref,evidence_sha256) VALUES (?,?,?,?,?,?,?,?,NOW(3),?,?)`,[uuid(),schedule.customerId,schedule.profileId,schedule.caseId,schedule.exposureId,outcome==='reappeared'?'still_present':outcome==='blocked'?'needs_review':outcome,clean(input.sourceUrl,2048)||null,input.notes?encryptPii(clean(input.notes,4000)):null,clean(input.evidenceRef,1024)||null,clean(input.evidenceSha256,64)||null]);await connection.commit();}catch(error){await connection.rollback();throw error;}finally{connection.release();}await evaluateCustomer(schedule.customerId,actorId||'system',p);return{...await getMonitoringSchedule(schedule.id,p),lastResult:outcome,checkId:id};}

async function listCustomerActions(customerId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT id,action_type,entity_type,entity_id,status,title,due_at,viewed_at,completed_at,created_at,updated_at FROM divedeep_customer_action_requests WHERE customer_id=? ORDER BY FIELD(status,'pending','viewed','completed','expired','cancelled'),COALESCE(due_at,created_at),created_at`, [clean(customerId, 36)]);
  return rows.map((row) => ({ id: row.id, actionType: row.action_type, entityType: row.entity_type, entityId: row.entity_id, status: row.status, title: row.title, dueAt: iso(row.due_at), viewedAt: iso(row.viewed_at), completedAt: iso(row.completed_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }));
}

async function completeCustomerAction(customerId, actionId, input = {}, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT * FROM divedeep_customer_action_requests WHERE id=? AND customer_id=? LIMIT 1`, [clean(actionId, 36), clean(customerId, 36)]);
  const action = rows[0];
  if (!action) throw statusError('Customer action not found', 404, 'DIVEDEEP_CUSTOMER_ACTION_NOT_FOUND');
  if (!['pending', 'viewed'].includes(action.status)) throw statusError('Customer action is no longer open', 409, 'DIVEDEEP_CUSTOMER_ACTION_CLOSED');
  if (action.action_type === 'image_validation') throw statusError('Use the protected image-validation endpoint for this action', 409, 'DIVEDEEP_IMAGE_VALIDATION_ENDPOINT_REQUIRED');
  const response = input.response && typeof input.response === 'object' ? input.response : { note: clean(input.note, 2000) };
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE divedeep_customer_action_requests SET status='completed',response_enc=?,viewed_at=COALESCE(viewed_at,NOW(3)),completed_at=NOW(3),updated_at=NOW(3) WHERE id=?`, [encryptJson(response), action.id]);
    if (action.entity_type === 'request_delivery' && action.action_type === 'removal_form') {
      await connection.query(`UPDATE divedeep_request_deliveries SET status='approved',next_attempt_at=COALESCE(next_attempt_at,NOW(3)),updated_at=NOW(3) WHERE id=? AND customer_id=? AND status='customer_action'`, [action.entity_id, customerId]);
      await connection.query(`UPDATE divedeep_cases c JOIN divedeep_request_deliveries d ON d.case_id=c.id SET c.state='approved',c.updated_at=NOW(3),c.revision=c.revision+1 WHERE d.id=? AND d.customer_id=? AND c.state='needs_action'`, [action.entity_id, customerId]);
    }
    await connection.query(`INSERT INTO divedeep_customer_events (id,customer_id,event_type,actor_type,actor_id,details_enc) VALUES (?,?,?,?,?,?)`, [uuid(), customerId, 'workflow.customer_action.completed', 'customer', customerId, encryptJson({ actionId: action.id, actionType: action.action_type, entityType: action.entity_type, entityId: action.entity_id })]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  await reconcileReviewTasks(customerId, `customer:${customerId}`, p).catch(() => {});
  return (await listCustomerActions(customerId, p)).find((item) => item.id === action.id);
}

function customerStatusCopy(workflowStatus) {
  return {
    onboarding: 'Finish setting up your protected profile.',
    intake_ready: 'Your protected profile is ready for review.',
    awaiting_dispatch: 'Your authorized search is being prepared.',
    dispatched: 'A protected search worker is starting.',
    researching: 'Your authorized sources are being checked.',
    awaiting_review: 'Potential matches are being reviewed by a person.',
    awaiting_customer_validation: 'Your confirmation is needed for one or more protected previews.',
    disposition_required: 'Reviewed evidence is being classified securely.',
    evidence_ready: 'Reviewed evidence is ready for the next privacy action.',
    removal_preparation: 'Removal requests are being prepared and checked.',
    requests_in_progress: 'Approved privacy requests are in progress.',
    monitoring: 'Monitoring and verification checks are active.',
    closure_ready: 'This service cycle is ready to be completed.',
    complete: 'This privacy service cycle is complete.',
    blocked: 'An administrator is resolving an issue before work continues.',
  }[workflowStatus] || 'Your privacy workflow is being updated.';
}

async function getCustomerWorkflowPresentation(customerId, pool = null) {
  const p = pool || getPool();
  const [workflow, customerRows] = await Promise.all([
    getCustomerWorkflow(customerId, p),
    p.query(`SELECT workflow_status FROM divedeep_customers WHERE id=? LIMIT 1`, [clean(customerId, 36)]).then(([rows]) => rows),
  ]);
  const workflowStatus = customerRows[0]?.workflow_status || workflow.run?.stage || 'onboarding';
  const actions = (workflow.customerActions || []).filter((item) => ['pending', 'viewed'].includes(item.status)).map((item) => ({ id: item.id, actionType: item.actionType, status: item.status, title: item.title, dueAt: item.dueAt }));
  return {
    status: workflowStatus,
    message: customerStatusCopy(workflowStatus),
    stage: workflow.run?.stage || workflowStatus,
    outcome: workflow.run?.outcome || 'pending',
    gates: (workflow.gates || []).map((gate) => ({ key: gate.key, label: gate.label, phase: gate.phase, status: gate.status, summary: gate.summary })),
    actions,
    activeMonitoring: (workflow.schedules || []).filter((item) => item.status === 'active').length,
    updatedAt: workflow.run?.updatedAt || null,
  };
}

async function closeWorkflow(customerId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const evaluation = await evaluateCustomer(customerId, actorId || 'system', p);
  const mode = clean(input.outcome || 'completed', 32);
  if (!['completed', 'continuing_monitoring', 'withdrawn'].includes(mode)) throw statusError('Invalid workflow closure outcome');
  if (mode !== 'withdrawn' && !evaluation.closureReady) throw statusError('Workflow cannot close until all required operational gates are satisfied', 409, 'DIVEDEEP_WORKFLOW_NOT_READY_TO_CLOSE');
  const context = await loadOperationalContext(customerId, p);
  if (mode === 'continuing_monitoring' && number(context.counts.monitoring.active) < 1) throw statusError('Continuing monitoring requires an active schedule', 409, 'DIVEDEEP_MONITORING_REQUIRED');
  if (mode === 'completed' && number(context.counts.monitoring.active) > 0) throw statusError('Pause or complete active monitoring schedules before final closure', 409, 'DIVEDEEP_MONITORING_STILL_ACTIVE');
  const run = context.workflowRun;
  if (!run) throw statusError('Workflow run not found', 404, 'DIVEDEEP_WORKFLOW_RUN_NOT_FOUND');
  const reason = clean(input.reason, 2000);
  if (!reason) throw statusError('A closure reason is required');
  const status = mode === 'continuing_monitoring' ? 'monitoring' : mode === 'withdrawn' ? 'withdrawn' : 'completed';
  const customerStatus = mode === 'continuing_monitoring' ? 'monitoring' : 'complete';
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE divedeep_workflow_runs SET status=?,outcome=?,stage='closure',closed_at=NOW(3),closed_by=?,closure_reason=?,completed_at=IF(?='completed',COALESCE(completed_at,NOW(3)),completed_at),updated_at=NOW(3) WHERE id=?`, [status, mode, clean(actorId, 128) || null, reason, status, run.id]);
    await connection.query(`UPDATE divedeep_customers SET workflow_status=?,updated_at=NOW(3) WHERE id=?`, [customerStatus, customerId]);
    const [gateRows] = await connection.query(`SELECT status FROM divedeep_customer_workflow_gates WHERE customer_id=? AND gate_key='closure' LIMIT 1 FOR UPDATE`, [customerId]);
    const previousStatus = gateRows[0]?.status || null;
    const closureSummary = mode === 'continuing_monitoring' ? 'The active service cycle is closed while monitoring continues.' : mode === 'withdrawn' ? 'The workflow was withdrawn with an explicit reason.' : 'The privacy workflow is complete.';
    const details = { workflowRunId: run.id, outcome: mode, closedAt: new Date().toISOString() };
    await connection.query(`INSERT INTO divedeep_customer_workflow_gates (id,customer_id,gate_key,status,summary,details_json,evaluated_at,evaluated_by) VALUES (?,?,'closure','pass',?,?,NOW(3),?) ON DUPLICATE KEY UPDATE status='pass',summary=VALUES(summary),details_json=VALUES(details_json),evaluated_at=NOW(3),evaluated_by=VALUES(evaluated_by),updated_at=NOW(3)`, [uuid(), customerId, closureSummary, JSON.stringify(details), clean(actorId, 128) || 'system']);
    if (previousStatus !== 'pass') await connection.query(`INSERT INTO divedeep_workflow_gate_events (id,workflow_run_id,customer_id,gate_key,previous_status,new_status,reason,details_json,actor_type,actor_id) VALUES (?,?,?,'closure',?,'pass',?,?,?,?)`, [uuid(), run.id, customerId, previousStatus, closureSummary, JSON.stringify(details), actorId ? 'admin' : 'system', clean(actorId, 128) || null]);
    await connection.query(`INSERT INTO divedeep_customer_events (id,customer_id,event_type,actor_type,actor_id,details_enc) VALUES (?,?,?,?,?,?)`, [uuid(), customerId, 'workflow.closed', actorId ? 'admin' : 'system', clean(actorId, 128) || null, encryptJson({ workflowRunId: run.id, outcome: mode, reason })]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return getCustomerWorkflow(customerId, p);
}

async function getCustomerWorkflow(customerId,pool=null){const p=pool||getPool();const [run,gates,tasks,deliveries,schedules]=await Promise.all([latestWorkflowRun(customerId,p),getCustomerGates(customerId,p),listReviewTasks({customerId,limit:1000},p),listDeliveries({customerId,limit:1000},p),listMonitoringSchedules({customerId,limit:1000},p)]);const [eventRows,actionRows,checkRows]=await Promise.all([p.query(`SELECT * FROM divedeep_workflow_gate_events WHERE customer_id=? ORDER BY created_at DESC LIMIT 300`,[customerId]).then(([rows])=>rows),p.query(`SELECT * FROM divedeep_customer_action_requests WHERE customer_id=? ORDER BY updated_at DESC LIMIT 300`,[customerId]).then(([rows])=>rows),p.query(`SELECT mc.* FROM divedeep_monitoring_checks mc JOIN divedeep_monitoring_schedules ms ON ms.id=mc.schedule_id WHERE ms.customer_id=? ORDER BY mc.checked_at DESC LIMIT 300`,[customerId]).then(([rows])=>rows)]);return{customerId,run,gates,reviewTasks:tasks,customerActions:actionRows.map((row)=>({id:row.id,actionType:row.action_type,entityType:row.entity_type,entityId:row.entity_id,status:row.status,title:row.title,dueAt:iso(row.due_at),viewedAt:iso(row.viewed_at),completedAt:iso(row.completed_at),updatedAt:iso(row.updated_at)})),deliveries,schedules,checks:checkRows.map((row)=>({id:row.id,scheduleId:row.schedule_id,result:row.result,httpStatus:row.http_status,artifactId:row.artifact_id,checkedBy:row.checked_by,checkedAt:iso(row.checked_at)})),events:eventRows.map((row)=>({id:row.id,workflowRunId:row.workflow_run_id,gateKey:row.gate_key,previousStatus:row.previous_status,newStatus:row.new_status,reason:row.reason,details:parseJson(row.details_json,{}),actorType:row.actor_type,actorId:row.actor_id,createdAt:iso(row.created_at)}))};}

async function listWorkflowSummaries(filters={},pool=null){const p=pool||getPool();const limit=Math.min(Math.max(number(filters.limit)||500,1),1000);const params=[];let where='';if(filters.status){where='WHERE c.workflow_status=?';params.push(clean(filters.status,64));}params.push(limit);const [rows]=await p.query(`SELECT c.id,c.plan_tier,c.status,c.workflow_status,c.first_name_enc,c.last_name_enc,c.email_enc,c.updated_at,w.id workflow_run_id,w.stage,w.status workflow_run_status,w.outcome,w.updated_at workflow_updated_at,(SELECT rj.status FROM divedeep_recon_jobs rj WHERE rj.customer_id=c.id ORDER BY rj.created_at DESC LIMIT 1) latest_job_status,(SELECT COUNT(*) FROM divedeep_review_tasks t WHERE t.customer_id=c.id AND t.status IN ('open','assigned','awaiting_customer')) open_reviews,(SELECT COUNT(*) FROM divedeep_customer_action_requests a WHERE a.customer_id=c.id AND a.status IN ('pending','viewed')) customer_actions,(SELECT COUNT(*) FROM divedeep_request_deliveries d WHERE d.customer_id=c.id AND d.status IN ('draft','approved','queued','sending','customer_action','failed')) pending_deliveries,(SELECT COUNT(*) FROM divedeep_monitoring_schedules m WHERE m.customer_id=c.id AND m.status='active') active_monitoring FROM divedeep_customers c LEFT JOIN divedeep_workflow_runs w ON w.id=(SELECT wr.id FROM divedeep_workflow_runs wr WHERE wr.customer_id=c.id ORDER BY wr.created_at DESC LIMIT 1) ${where} ORDER BY COALESCE(w.updated_at,c.updated_at) DESC LIMIT ?`,params);return rows.map((row)=>({customerId:row.id,displayName:[decryptPii(row.first_name_enc),decryptPii(row.last_name_enc)].filter(Boolean).join(' '),email:decryptPii(row.email_enc),planTier:row.plan_tier,customerStatus:row.status,workflowStatus:row.workflow_status,workflowRunId:row.workflow_run_id||null,stage:row.stage||row.workflow_status,workflowRunStatus:row.workflow_run_status||null,outcome:row.outcome||'pending',openReviews:number(row.open_reviews),customerActions:number(row.customer_actions),pendingDeliveries:number(row.pending_deliveries),activeMonitoring:number(row.active_monitoring),latestJobStatus:row.latest_job_status||null,updatedAt:iso(row.workflow_updated_at||row.updated_at)}));}
async function workQueue(pool=null){const summaries=await listWorkflowSummaries({limit:1000},pool);const lanes={needsIntake:[],readyToRun:[],awaitingCapacity:[],running:[],needsReview:[],customerValidation:[],evidenceDisposition:[],removalApproval:[],delivery:[],monitoring:[],closureReady:[],blocked:[]};for(const item of summaries){const normalized={...item,id:item.customerId,packageId:item.planTier,status:item.workflowStatus,currentGate:item.stage,customer:{displayName:item.displayName,email:item.email}};if(item.workflowStatus==='onboarding')lanes.needsIntake.push(normalized);else if(item.workflowStatus==='awaiting_dispatch'&&(item.latestJobStatus==='awaiting_capacity'||item.stage==='capacity_assignment'))lanes.awaitingCapacity.push(normalized);else if(item.workflowStatus==='awaiting_dispatch')lanes.readyToRun.push(normalized);else if(['dispatched','researching'].includes(item.workflowStatus))lanes.running.push(normalized);else if(item.workflowStatus==='awaiting_customer_validation')lanes.customerValidation.push(normalized);else if(item.workflowStatus==='awaiting_review')lanes.needsReview.push(normalized);else if(item.workflowStatus==='disposition_required')lanes.evidenceDisposition.push(normalized);else if(item.workflowStatus==='removal_preparation')lanes.removalApproval.push(normalized);else if(item.workflowStatus==='requests_in_progress')lanes.delivery.push(normalized);else if(item.workflowStatus==='monitoring')lanes.monitoring.push(normalized);else if(item.workflowStatus==='closure_ready')lanes.closureReady.push(normalized);else if(item.workflowStatus==='blocked')lanes.blocked.push(normalized);else if(item.workflowStatus==='intake_ready')lanes.readyToRun.push(normalized);}return{lanes,summaries};}
async function operationsOverview(pool=null){const p=pool||getPool();const [[runs],[reviews],[actions],[deliveries],[monitoring],[closures]]=await Promise.all([p.query(`SELECT COUNT(*) total,SUM(status='active') active,SUM(status='blocked') blocked,SUM(status='monitoring') monitoring,SUM(status IN ('completed','closed')) completed FROM divedeep_workflow_runs`),p.query(`SELECT COUNT(*) total,SUM(status IN ('open','assigned','awaiting_customer')) open,SUM(status='awaiting_customer') awaiting_customer FROM divedeep_review_tasks`),p.query(`SELECT COUNT(*) total,SUM(status IN ('pending','viewed')) pending FROM divedeep_customer_action_requests`),p.query(`SELECT COUNT(*) total,SUM(status IN ('draft','approved','queued','sending','customer_action')) pending,SUM(status='failed') failed FROM divedeep_request_deliveries`),p.query(`SELECT COUNT(*) total,SUM(status='active') active,SUM(status='failed') failed FROM divedeep_monitoring_schedules`),p.query(`SELECT COUNT(*) total,SUM(workflow_status='closure_ready') closure_ready FROM divedeep_customers`)]);return{workflowRuns:{total:number(runs[0]?.total),active:number(runs[0]?.active),blocked:number(runs[0]?.blocked),monitoring:number(runs[0]?.monitoring),completed:number(runs[0]?.completed)},reviewTasks:{total:number(reviews[0]?.total),open:number(reviews[0]?.open),awaitingCustomer:number(reviews[0]?.awaiting_customer)},customerActions:{total:number(actions[0]?.total),pending:number(actions[0]?.pending)},deliveries:{total:number(deliveries[0]?.total),pending:number(deliveries[0]?.pending),failed:number(deliveries[0]?.failed)},monitoring:{total:number(monitoring[0]?.total),active:number(monitoring[0]?.active),failed:number(monitoring[0]?.failed)},closureReady:number(closures[0]?.closure_ready)};}

module.exports={GATES,GATE_STATUSES,authorizationActive,profileIdentifierCount,evaluateDashboard,workflowStatusForEvaluation,loadOperationalContext,persistEvaluation,evaluateCustomer,getCustomerGates,reconcileReviewTasks,listReviewTasks,updateReviewTask,createDelivery,listDeliveries,recordDeliveryAttempt,createMonitoringSchedule,getMonitoringSchedule,listMonitoringSchedules,recordMonitoringCheck,listCustomerActions,completeCustomerAction,getCustomerWorkflowPresentation,closeWorkflow,getCustomerWorkflow,listWorkflowSummaries,workQueue,operationsOverview};
