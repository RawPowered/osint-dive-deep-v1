'use strict';

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const DEPLOYMENT_ENVIRONMENTS = Object.freeze(['development', 'staging', 'production']);
const ROLLOUT_ORDER = Object.freeze([
  'internal_test_records',
  'controlled_pilot',
  'small_customer_cohort',
  'normal_production',
  'enterprise_clients',
  'hourly_burst_capacity',
  'multi_provider_capacity',
]);
const REQUIRED_RELEASE_CHECKS = Object.freeze([
  'environment_separation',
  'migration_dry_run',
  'rollback_verification',
  'storage_lifecycle',
  'worker_loss',
  'expired_lease_recovery',
  'corrupt_upload',
  'retention_deletion',
  'sentinel_alert',
  'ghl_webhook_replay',
  'package_compatibility',
  'disaster_recovery',
]);

function statusError(message, status = 400, code = 'DIVEDEEP_PRODUCTION_READINESS_INVALID') {
  return Object.assign(new Error(message), { status, code });
}
function clean(value, max = 255) { return String(value == null ? '' : value).trim().slice(0, max); }
function parseJson(value, fallback = {}) { try { return value ? (typeof value === 'object' ? value : JSON.parse(value)) : fallback; } catch { return fallback; } }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function poolOrDefault(pool) { return pool || require('../db/pool').getPool(); }

const BLOCKED_OPERATIONAL_DETAIL_KEY = /(secret|token|credential|password|authorization|evidence|raw|payload|requestbody|responsebody|document|image|candidate|confidence|reviewnote|sourceurl|objectkey|externalcontact|email|phone|address|bucket|endpoint|hostname)/i;
function sanitizeOperationalDetails(value, depth = 0) {
  if (depth > 6) return '[depth-limited]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return clean(value, 1000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeOperationalDetails(item, depth + 1));
  if (typeof value !== 'object') return clean(value, 1000);
  const output = {};
  for (const [rawKey, item] of Object.entries(value).slice(0, 200)) {
    const key = clean(rawKey, 128);
    if (!key || BLOCKED_OPERATIONAL_DETAIL_KEY.test(key)) continue;
    output[key] = sanitizeOperationalDetails(item, depth + 1);
  }
  return output;
}

function normalizeDeploymentEnvironment(value) {
  const env = clean(value || 'development', 32).toLowerCase();
  if (!DEPLOYMENT_ENVIRONMENTS.includes(env)) {
    throw statusError('DEPLOYMENT_ENV must be development, staging, or production', 500, 'DIVEDEEP_DEPLOYMENT_ENV_INVALID');
  }
  return env;
}

function deploymentFingerprint(env = process.env) {
  const fields = [
    env.DEPLOYMENT_ENV,
    env.DIVEDEEP_DEPLOYMENT_ID,
    env.INSTANCE_ID,
    env.DB_HOST,
    env.DB_PORT,
    env.DB_NAME,
    env.DIVEDEEP_STORAGE_NAMESPACE,
    env.DIVEDEEP_PUBLIC_ORIGIN,
    env.DIVEDEEP_API_ORIGIN,
    env.DIVEDEEP_PRIMARY_COMPUTE_PROVIDER,
  ].map((value) => clean(value, 512));
  return sha256(fields.join('\n'));
}

function check(id, ok, severity, message, details = {}) {
  return { id, ok: Boolean(ok), severity, message, details };
}

function validateEnvironmentSeparation(env = process.env) {
  const deploymentEnvironment = normalizeDeploymentEnvironment(env.DEPLOYMENT_ENV || (env.NODE_ENV === 'production' ? 'production' : 'development'));
  const checks = [];
  const required = [
    ['DIVEDEEP_DEPLOYMENT_ID', env.DIVEDEEP_DEPLOYMENT_ID],
    ['INSTANCE_ID', env.INSTANCE_ID],
    ['DB_NAME', env.DB_NAME],
    ['DIVEDEEP_STORAGE_NAMESPACE', env.DIVEDEEP_STORAGE_NAMESPACE],
    ['DIVEDEEP_PUBLIC_ORIGIN', env.DIVEDEEP_PUBLIC_ORIGIN],
    ['DIVEDEEP_API_ORIGIN', env.DIVEDEEP_API_ORIGIN],
    ['DIVEDEEP_PRIMARY_COMPUTE_PROVIDER', env.DIVEDEEP_PRIMARY_COMPUTE_PROVIDER],
  ];
  for (const [name, value] of required) {
    checks.push(check(`required_${name.toLowerCase()}`, Boolean(clean(value)), 'blocker', `${name} must be configured`, { name }));
  }

  const expectedNodeEnv = deploymentEnvironment === 'development' ? 'development' : 'production';
  checks.push(check('node_environment', clean(env.NODE_ENV).toLowerCase() === expectedNodeEnv, 'blocker', `NODE_ENV must be ${expectedNodeEnv} for ${deploymentEnvironment}`, { expected: expectedNodeEnv }));
  checks.push(check('cors_closed', String(env.CORS_ALLOW_ALL || '').toLowerCase() !== 'true' || deploymentEnvironment === 'development', 'blocker', 'CORS_ALLOW_ALL is forbidden outside development'));
  checks.push(check('reinstall_closed', String(env.ALLOW_REINSTALL || 'false').toLowerCase() !== 'true', 'blocker', 'Reinstallation must remain disabled'));

  if (deploymentEnvironment === 'production') {
    checks.push(check('production_ack', clean(env.DIVEDEEP_PRODUCTION_ACK) === 'DIVEDEEP_PRODUCTION', 'blocker', 'Production requires DIVEDEEP_PRODUCTION_ACK=DIVEDEEP_PRODUCTION'));
    checks.push(check('cookie_secure', String(env.COOKIE_SECURE || '').toLowerCase() === 'true', 'blocker', 'Production cookies must be secure'));
    checks.push(check('auto_approve_closed', String(env.DIVEDEEP_AUTO_APPROVE || 'false').toLowerCase() !== 'true', 'blocker', 'Production customer auto-approval must remain disabled during rollout'));
    checks.push(check('invite_or_closed_signup', Boolean(clean(env.DIVEDEEP_INVITE_CODE)) || String(env.DIVEDEEP_SIGNUPS_ENABLED || '').toLowerCase() === 'false', 'warning', 'Pilot rollout should use an invite code or disabled open signup'));
  }

  const envToken = deploymentEnvironment === 'production' ? 'prod' : deploymentEnvironment;
  const namespaceFields = [
    ['DB_NAME', env.DB_NAME],
    ['DIVEDEEP_STORAGE_NAMESPACE', env.DIVEDEEP_STORAGE_NAMESPACE],
    ['DIVEDEEP_DEPLOYMENT_ID', env.DIVEDEEP_DEPLOYMENT_ID],
  ];
  for (const [name, value] of namespaceFields) {
    const normalized = clean(value).toLowerCase();
    checks.push(check(`namespace_${name.toLowerCase()}`, normalized.includes(envToken), 'warning', `${name} should visibly identify the ${deploymentEnvironment} environment`, { expectedToken: envToken }));
  }

  const blockers = checks.filter((item) => !item.ok && item.severity === 'blocker');
  const warnings = checks.filter((item) => !item.ok && item.severity === 'warning');
  return {
    ok: blockers.length === 0,
    deploymentEnvironment,
    deploymentId: clean(env.DIVEDEEP_DEPLOYMENT_ID, 128) || null,
    fingerprint: deploymentFingerprint(env),
    checks,
    blockerCount: blockers.length,
    warningCount: warnings.length,
  };
}

function assertEnvironmentSeparation(env = process.env) {
  const result = validateEnvironmentSeparation(env);
  if (!result.ok) {
    const error = statusError(`Deployment environment separation failed with ${result.blockerCount} blocker(s)`, 500, 'DIVEDEEP_ENVIRONMENT_SEPARATION_FAILED');
    error.details = result;
    throw error;
  }
  return result;
}

function rolloutIndex(stage) { return ROLLOUT_ORDER.indexOf(clean(stage, 64)); }
function validateRolloutTransition(currentStage, nextStage, options = {}) {
  const current = clean(currentStage || 'internal_test_records', 64);
  const next = clean(nextStage, 64);
  const currentIndex = rolloutIndex(current);
  const nextIndex = rolloutIndex(next);
  if (currentIndex < 0 || nextIndex < 0) throw statusError('Unsupported rollout stage', 400, 'DIVEDEEP_ROLLOUT_STAGE_INVALID');
  if (nextIndex === currentIndex) return { allowed: true, direction: 'same', current, next };
  if (nextIndex === currentIndex + 1) return { allowed: true, direction: 'forward', current, next };
  if (nextIndex < currentIndex && options.rollback === true && clean(options.reason, 1000)) {
    return { allowed: true, direction: 'rollback', current, next };
  }
  throw statusError('Rollout stages must advance one gate at a time; rollback requires an explicit reason', 409, 'DIVEDEEP_ROLLOUT_TRANSITION_BLOCKED');
}

function parseVersion(value) {
  const match = clean(value, 64).match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}
function compareVersions(a, b) {
  const av = parseVersion(a); const bv = parseVersion(b);
  if (!av || !bv) return null;
  for (let i = 0; i < 3; i += 1) if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  return 0;
}
function validatePackageCompatibility(input = {}) {
  const apiVersion = clean(input.apiVersion, 64);
  const schemaVersion = Number(input.schemaVersion);
  const workerVersion = clean(input.workerVersion, 64);
  const workerProtocol = clean(input.workerProtocol, 64);
  const frontendVersion = clean(input.frontendVersion, 64);
  const nodeVersion = clean(input.nodeVersion || process.versions.node, 64);
  const checks = [
    check('api_version', compareVersions(apiVersion, '1.16.0') >= 0, 'blocker', 'API version must be 1.16.0 or newer', { actual: apiVersion }),
    check('schema_version', schemaVersion >= 64, 'blocker', 'Schema version must be 64 or newer', { actual: schemaVersion }),
    check('worker_version', compareVersions(workerVersion, '5.29.0') >= 0, 'blocker', 'DiveDeep worker must be 5.29.0 or newer', { actual: workerVersion }),
    check('worker_protocol', workerProtocol === 'divedeep-worker-v1', 'blocker', 'Worker protocol must remain divedeep-worker-v1', { actual: workerProtocol }),
    check('frontend_version', compareVersions(frontendVersion, '1.6.3') >= 0, 'blocker', 'Frontend must be 1.6.3 or newer', { actual: frontendVersion }),
    check('node_version', Number((parseVersion(nodeVersion) || [0])[0]) >= 20, 'blocker', 'Node.js 20 or newer is required', { actual: nodeVersion }),
  ];
  return { ok: checks.every((item) => item.ok || item.severity !== 'blocker'), checks };
}

function verifyUploadIntegrity(buffer, expected = {}) {
  if (!Buffer.isBuffer(buffer)) throw statusError('Upload integrity verification requires a Buffer');
  const actualSha256 = sha256(buffer);
  const actualByteSize = buffer.length;
  const expectedSha256 = clean(expected.sha256, 64).toLowerCase();
  const expectedByteSize = Number(expected.byteSize);
  const hashMatches = /^[a-f0-9]{64}$/.test(expectedSha256) && crypto.timingSafeEqual(Buffer.from(actualSha256), Buffer.from(expectedSha256));
  const sizeMatches = Number.isInteger(expectedByteSize) && expectedByteSize === actualByteSize;
  return {
    ok: hashMatches && sizeMatches,
    hashMatches,
    sizeMatches,
    actualSha256,
    actualByteSize,
  };
}

function evaluateReleaseGate(checkRows = []) {
  const latest = new Map();
  for (const row of checkRows) {
    const type = clean(row.checkType || row.check_type, 64);
    if (!type || latest.has(type)) continue;
    latest.set(type, row);
  }
  const required = REQUIRED_RELEASE_CHECKS.map((type) => {
    const row = latest.get(type);
    return { type, status: clean(row?.status || 'missing', 32), completedAt: iso(row?.completedAt || row?.completed_at) };
  });
  const blockers = required.filter((item) => item.status !== 'passed');
  return { ready: blockers.length === 0, required, blockerCount: blockers.length, blockers };
}

function serializeCheck(row) {
  return {
    id: row.id,
    deploymentEnvironment: row.deployment_environment,
    releaseVersion: row.release_version,
    checkType: row.check_type,
    status: row.status,
    summary: row.summary,
    details: parseJson(row.details_json, {}),
    artifactSha256: row.artifact_sha256 || null,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    recordedBy: row.recorded_by || null,
  };
}

async function recordReadinessCheck(input = {}, actorId = null, pool = null) {
  const p = poolOrDefault(pool);
  const checkType = clean(input.checkType, 64);
  if (!REQUIRED_RELEASE_CHECKS.includes(checkType)) throw statusError('Unsupported readiness check type');
  const status = clean(input.status, 32);
  if (!['passed', 'failed', 'warning', 'skipped'].includes(status)) throw statusError('Readiness check status is invalid');
  const id = crypto.randomUUID();
  const environment = normalizeDeploymentEnvironment(input.deploymentEnvironment || process.env.DEPLOYMENT_ENV);
  await p.query(
    `INSERT INTO divedeep_release_readiness_checks
       (id,deployment_environment,release_version,check_type,status,summary,details_json,artifact_sha256,started_at,completed_at,recorded_by)
     VALUES (?,?,?,?,?,?,?,?,COALESCE(?,NOW(3)),NOW(3),?)`,
    [id, environment, clean(input.releaseVersion || '1.16.0', 64), checkType, status, clean(input.summary, 1000) || checkType,
      JSON.stringify(sanitizeOperationalDetails(input.details || {})), clean(input.artifactSha256, 64) || null, input.startedAt || null, clean(actorId, 128) || null]
  );
  const [rows] = await p.query(`SELECT * FROM divedeep_release_readiness_checks WHERE id=? LIMIT 1`, [id]);
  return serializeCheck(rows[0]);
}

async function listReadinessChecks(filters = {}, pool = null) {
  const p = poolOrDefault(pool);
  const environment = normalizeDeploymentEnvironment(filters.deploymentEnvironment || process.env.DEPLOYMENT_ENV);
  const limit = Math.min(Math.max(Number(filters.limit) || 250, 1), 1000);
  const [rows] = await p.query(
    `SELECT * FROM divedeep_release_readiness_checks WHERE deployment_environment=? ORDER BY completed_at DESC LIMIT ?`,
    [environment, limit]
  );
  return rows.map(serializeCheck);
}

async function getRolloutState(pool = null, deploymentEnvironment = null) {
  const p = poolOrDefault(pool);
  const environment = normalizeDeploymentEnvironment(deploymentEnvironment || process.env.DEPLOYMENT_ENV);
  const [rows] = await p.query(`SELECT * FROM divedeep_rollout_state WHERE deployment_environment=? LIMIT 1`, [environment]);
  if (!rows[0]) return { deploymentEnvironment: environment, stage: 'internal_test_records', status: 'held', cohortLimit: 0, updatedAt: null };
  const row = rows[0];
  return {
    deploymentEnvironment: row.deployment_environment,
    stage: row.stage,
    status: row.status,
    cohortLimit: Number(row.cohort_limit) || 0,
    decisionReason: row.decision_reason || null,
    updatedBy: row.updated_by || null,
    updatedAt: iso(row.updated_at),
  };
}

async function setRolloutStage(input = {}, actorId = null, pool = null) {
  const p = poolOrDefault(pool);
  const environment = normalizeDeploymentEnvironment(input.deploymentEnvironment || process.env.DEPLOYMENT_ENV);
  const current = await getRolloutState(p, environment);
  const transition = validateRolloutTransition(current.stage, input.stage, { rollback: input.rollback === true, reason: input.reason });
  const checkRows = await listReadinessChecks({ deploymentEnvironment: environment, limit: 1000 }, p);
  const gate = evaluateReleaseGate(checkRows);
  if (transition.direction === 'forward' && !gate.ready) {
    throw statusError('All required Phase 10 readiness checks must pass before rollout advances', 409, 'DIVEDEEP_ROLLOUT_READINESS_BLOCKED');
  }
  if (transition.next === 'multi_provider_capacity' && transition.direction === 'forward') {
    const [providerRows] = await p.query(`SELECT COUNT(*) ready FROM divedeep_compute_provider_readiness WHERE deployment_environment=? AND status='ready'`, [environment]);
    if (Number(providerRows[0]?.ready) < 2) {
      throw statusError('Multi-provider capacity requires at least two providers in ready state', 409, 'DIVEDEEP_SECOND_PROVIDER_NOT_READY');
    }
  }
  const status = clean(input.status || (transition.direction === 'rollback' ? 'rolled_back' : 'active'), 32);
  if (!['held', 'active', 'completed', 'rolled_back'].includes(status)) throw statusError('Rollout state status is invalid');
  const cohortLimit = Math.min(Math.max(Number(input.cohortLimit) || 0, 0), 1000000);
  await p.query(
    `INSERT INTO divedeep_rollout_state
       (deployment_environment,stage,status,cohort_limit,decision_reason,updated_by)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE stage=VALUES(stage),status=VALUES(status),cohort_limit=VALUES(cohort_limit),decision_reason=VALUES(decision_reason),updated_by=VALUES(updated_by),updated_at=NOW(3)`,
    [environment, transition.next, status, cohortLimit, clean(input.reason, 1000) || null, clean(actorId, 128) || null]
  );
  await p.query(
    `INSERT INTO divedeep_rollout_events (id,deployment_environment,from_stage,to_stage,direction,reason,actor_id,details_json)
     VALUES (?,?,?,?,?,?,?,?)`,
    [crypto.randomUUID(), environment, transition.current, transition.next, transition.direction, clean(input.reason, 1000) || null, clean(actorId, 128) || null, JSON.stringify({ cohortLimit, status })]
  );
  return getRolloutState(p, environment);
}

async function assignCustomerToRollout(input = {}, actorId = null, pool = null) {
  const p = poolOrDefault(pool);
  const environment = normalizeDeploymentEnvironment(input.deploymentEnvironment || process.env.DEPLOYMENT_ENV);
  const customerId = clean(input.customerId, 64);
  const stage = clean(input.stage, 64);
  if (!customerId || rolloutIndex(stage) < 0) throw statusError('A valid customer and rollout stage are required');
  if (stage === 'controlled_pilot') {
    const [rows] = await p.query(`SELECT COUNT(*) total FROM divedeep_rollout_assignments WHERE deployment_environment=? AND stage='controlled_pilot' AND status='active' AND customer_id<>?`, [environment, customerId]);
    if (Number(rows[0]?.total) > 0) throw statusError('Only one controlled pilot customer may be active', 409, 'DIVEDEEP_PILOT_LIMIT_REACHED');
  }
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO divedeep_rollout_assignments
       (id,deployment_environment,customer_id,stage,status,assigned_by,notes)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE stage=VALUES(stage),status=VALUES(status),assigned_by=VALUES(assigned_by),notes=VALUES(notes),updated_at=NOW(3)`,
    [id, environment, customerId, stage, clean(input.status || 'active', 32), clean(actorId, 128) || null, clean(input.notes, 2000) || null]
  );
  return { customerId, deploymentEnvironment: environment, stage, status: clean(input.status || 'active', 32) };
}

async function recordDisasterRecoveryRehearsal(input = {}, actorId = null, pool = null) {
  const p = poolOrDefault(pool);
  const environment = normalizeDeploymentEnvironment(input.deploymentEnvironment || process.env.DEPLOYMENT_ENV);
  const status = clean(input.status, 32);
  if (!['passed', 'failed', 'partial'].includes(status)) throw statusError('Disaster recovery rehearsal status is invalid');
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO divedeep_disaster_recovery_rehearsals
       (id,deployment_environment,release_version,status,rpo_minutes,rto_minutes,backup_sha256,restore_target,summary,details_json,performed_by,started_at,completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(3))`,
    [id, environment, clean(input.releaseVersion || '1.16.0', 64), status,
      Math.max(Number(input.rpoMinutes) || 0, 0), Math.max(Number(input.rtoMinutes) || 0, 0), clean(input.backupSha256, 64) || null,
      clean(input.restoreTarget, 255) || null, clean(input.summary, 2000) || status, JSON.stringify(sanitizeOperationalDetails(input.details || {})), clean(actorId, 128) || null,
      input.startedAt || new Date()]
  );
  return { id, deploymentEnvironment: environment, status };
}

async function recordProviderReadiness(input = {}, actorId = null, pool = null) {
  const p = poolOrDefault(pool);
  const environment = normalizeDeploymentEnvironment(input.deploymentEnvironment || process.env.DEPLOYMENT_ENV);
  const provider = clean(input.provider, 64);
  if (!provider) throw statusError('Compute provider is required');
  const status = clean(input.status, 32);
  if (!['not_configured', 'configured', 'validated', 'ready', 'blocked'].includes(status)) throw statusError('Provider readiness status is invalid');
  await p.query(
    `INSERT INTO divedeep_compute_provider_readiness
       (deployment_environment,provider,status,protocol_version,package_version,last_validation_at,details_json,updated_by)
     VALUES (?,?,?,?,?,IF(? IN ('validated','ready'),NOW(3),NULL),?,?)
     ON DUPLICATE KEY UPDATE status=VALUES(status),protocol_version=VALUES(protocol_version),package_version=VALUES(package_version),last_validation_at=VALUES(last_validation_at),details_json=VALUES(details_json),updated_by=VALUES(updated_by),updated_at=NOW(3)`,
    [environment, provider, status, clean(input.protocolVersion, 64) || null, clean(input.packageVersion, 64) || null, status, JSON.stringify(sanitizeOperationalDetails(input.details || {})), clean(actorId, 128) || null]
  );
  return { deploymentEnvironment: environment, provider, status };
}

async function throughputAndCostReview(options = {}, pool = null) {
  const p = poolOrDefault(pool);
  const hours = Math.min(Math.max(Number(options.hours) || 24, 1), 24 * 31);
  const [[jobs], [webhooks], [crm], [workers], [artifacts]] = await Promise.all([
    p.query(`SELECT COUNT(*) total,SUM(status='completed') completed,SUM(status='failed') failed,AVG(TIMESTAMPDIFF(SECOND,requested_at,completed_at)) avg_seconds FROM divedeep_recon_jobs WHERE created_at>=NOW()-INTERVAL ? HOUR`, [hours]),
    p.query(`SELECT COUNT(*) total,SUM(status='completed') completed,SUM(status='dead_letter') dead_letters,AVG(attempts) avg_attempts FROM divedeep_webhook_deliveries WHERE created_at>=NOW()-INTERVAL ? HOUR`, [hours]),
    p.query(`SELECT COUNT(*) total,SUM(status='completed') completed,SUM(status='dead_letter') dead_letters FROM divedeep_crm_outbound_events WHERE created_at>=NOW()-INTERVAL ? HOUR`, [hours]),
    p.query(`SELECT COUNT(*) total,SUM(status='lost') lost FROM divedeep_worker_instances WHERE created_at>=NOW()-INTERVAL ? HOUR`, [hours]),
    p.query(`SELECT COALESCE(SUM(actual_byte_size),0) bytes,COUNT(*) total FROM divedeep_artifacts WHERE created_at>=NOW()-INTERVAL ? HOUR`, [hours]),
  ]);
  const executionCost = Number(options.executionCostUsd) || 0;
  const storageCost = Number(options.storageCostUsd) || 0;
  const providerCost = Number(options.providerCostUsd) || 0;
  return {
    windowHours: hours,
    jobs: { total: Number(jobs[0]?.total) || 0, completed: Number(jobs[0]?.completed) || 0, failed: Number(jobs[0]?.failed) || 0, averageSeconds: Number(jobs[0]?.avg_seconds) || 0 },
    webhooks: { total: Number(webhooks[0]?.total) || 0, completed: Number(webhooks[0]?.completed) || 0, deadLetters: Number(webhooks[0]?.dead_letters) || 0, averageAttempts: Number(webhooks[0]?.avg_attempts) || 0 },
    crm: { total: Number(crm[0]?.total) || 0, completed: Number(crm[0]?.completed) || 0, deadLetters: Number(crm[0]?.dead_letters) || 0 },
    workers: { total: Number(workers[0]?.total) || 0, lost: Number(workers[0]?.lost) || 0 },
    artifacts: { total: Number(artifacts[0]?.total) || 0, bytes: Number(artifacts[0]?.bytes) || 0 },
    cost: { executionUsd: executionCost, storageUsd: storageCost, providerUsd: providerCost, totalUsd: executionCost + storageCost + providerCost },
  };
}

async function getProductionReadinessOverview(pool = null) {
  const p = poolOrDefault(pool);
  const environment = normalizeDeploymentEnvironment(process.env.DEPLOYMENT_ENV);
  const checks = await listReadinessChecks({ deploymentEnvironment: environment, limit: 1000 }, p);
  const rollout = await getRolloutState(p);
  const [providers] = await p.query(`SELECT provider,status,protocol_version,package_version,last_validation_at,updated_at FROM divedeep_compute_provider_readiness WHERE deployment_environment=? ORDER BY provider`, [environment]);
  return {
    environment: validateEnvironmentSeparation(process.env),
    releaseGate: evaluateReleaseGate(checks),
    rollout,
    providers: providers.map((row) => ({ provider: row.provider, status: row.status, protocolVersion: row.protocol_version, packageVersion: row.package_version, lastValidationAt: iso(row.last_validation_at), updatedAt: iso(row.updated_at) })),
    runtime: { node: process.versions.node, platform: process.platform, hostnameHash: sha256(os.hostname()).slice(0, 16) },
  };
}

function loadCompatibilityMatrix(root = path.join(__dirname, '..', '..')) {
  const file = path.join(root, 'deploy', 'compatibility', 'COMPATIBILITY_MATRIX.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  DEPLOYMENT_ENVIRONMENTS,
  ROLLOUT_ORDER,
  REQUIRED_RELEASE_CHECKS,
  normalizeDeploymentEnvironment,
  deploymentFingerprint,
  validateEnvironmentSeparation,
  assertEnvironmentSeparation,
  validateRolloutTransition,
  validatePackageCompatibility,
  verifyUploadIntegrity,
  sanitizeOperationalDetails,
  evaluateReleaseGate,
  recordReadinessCheck,
  listReadinessChecks,
  getRolloutState,
  setRolloutStage,
  assignCustomerToRollout,
  recordDisasterRecoveryRehearsal,
  recordProviderReadiness,
  throughputAndCostReview,
  getProductionReadinessOverview,
  loadCompatibilityMatrix,
};
