const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getAuthorizedIntegration } = require('./crmIntegrations');
const eagle = require('./eagle');

const ROLLOUT_MODES = new Set(['legacy','parallel','governed']);
const TOLERANCE_TYPES = new Set(['absolute','percent_difference']);
const VALIDATION_METRICS = new Set([
  'new_leads','current_scheduled_rate','current_won_rate','actionable_unassigned',
  'source_coverage','campaign_coverage','dnc_rate','location_completeness',
  'lead_to_appointment_rate','lead_to_win_rate','appointment_to_win_rate',
]);

async function createValidationRun(input, admin, pool = null) {
  const p = pool || getPool();
  const snapshot = await eagle.getSnapshot(required(input.snapshotId,'snapshotId'), required(input.apiKeyId,'apiKeyId'), p);
  const scope = validationScope(input, snapshot);
  const requestedChecks = Array.isArray(input.checks) ? input.checks : [];
  if (!requestedChecks.length || requestedChecks.length > 25) {
    throw statusError(400,'Validation requires between 1 and 25 metric checks');
  }
  const referenceSystem = required(input.referenceSystem,'referenceSystem').slice(0,128);
  const dashboard = await eagle.getDashboard(scope, p);
  const validationMetrics = { ...(dashboard.metrics || {}), ...(dashboard.historicalFunnel?.metrics || {}) };
  const checks = requestedChecks.map((check,index) => evaluateCheck(check,index,validationMetrics));
  const totals = summarizeChecks(checks);
  const status = totals.failed ? 'failed' : totals.unavailable ? 'incomplete' : 'passed';
  const id = crypto.randomUUID();
  const conn = typeof p.getConnection === 'function' ? await p.getConnection() : p;
  try {
    if (typeof conn.beginTransaction === 'function') await conn.beginTransaction();
    await conn.query(
      `INSERT INTO eagle_validation_runs
         (id,snapshot_id,integration_id,api_key_id,reference_system,scope_json,status,
          checks_total,checks_passed,checks_failed,checks_unavailable,created_by,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      [id,snapshot.id,snapshot.integrationId,snapshot.apiKeyId,referenceSystem,JSON.stringify(scope),status,
        totals.total,totals.passed,totals.failed,totals.unavailable,admin?.id || null]
    );
    for (const check of checks) {
      await conn.query(
        `INSERT INTO eagle_validation_checks
           (run_id,metric_id,metric_label,metric_unit,eagle_value,reference_value,absolute_difference,
            percent_difference,tolerance_value,tolerance_type,outcome,evidence_reference,note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,check.metricId,check.metricLabel,check.metricUnit,check.eagleValue,check.referenceValue,
          check.absoluteDifference,check.percentDifference,check.toleranceValue,check.toleranceType,
          check.outcome,check.evidenceReference,check.note]
      );
    }
    if (typeof conn.commit === 'function') await conn.commit();
  } catch (error) {
    if (typeof conn.rollback === 'function') await conn.rollback();
    throw error;
  } finally {
    if (conn !== p && typeof conn.release === 'function') conn.release();
  }
  return { id,snapshotId:snapshot.id,integrationId:snapshot.integrationId,referenceSystem,status,...totals,checks,scope };
}

function validationScope(input, snapshot) {
  const scope = {
    snapshotId:snapshot.id,apiKeyId:snapshot.apiKeyId,integrationId:snapshot.integrationId,
  };
  const days = Number(input.days);
  if ([7,30,90,365].includes(days)) scope.days=days;
  for (const [key,max] of [['state',2],['city',128],['service',128],['disposition',64],['source',191],['campaign',191]]) {
    if (input[key]) scope[key]=String(input[key]).slice(0,max);
  }
  return scope;
}

function evaluateCheck(input, index, metrics) {
  const metricId = String(input?.metricId || '');
  if (!VALIDATION_METRICS.has(metricId)) throw statusError(400,`Validation check ${index + 1} has an unsupported metricId`);
  const referenceValue = Number(input.referenceValue);
  if (!Number.isFinite(referenceValue)) throw statusError(400,`Validation check ${index + 1} referenceValue must be numeric`);
  const evidenceReference = required(input.evidenceReference,`Validation check ${index + 1} evidenceReference`).slice(0,512);
  const metric = metrics[metricId];
  const defaultType = metric?.unit === 'percent' ? 'absolute' : 'percent_difference';
  const toleranceType = String(input.toleranceType || defaultType);
  if (!TOLERANCE_TYPES.has(toleranceType)) throw statusError(400,`Validation check ${index + 1} toleranceType is invalid`);
  const fallbackTolerance = toleranceType === 'absolute' ? .5 : 1;
  const toleranceValue = input.toleranceValue == null ? fallbackTolerance : Number(input.toleranceValue);
  if (!Number.isFinite(toleranceValue) || toleranceValue < 0 || toleranceValue > 100) {
    throw statusError(400,`Validation check ${index + 1} toleranceValue must be between 0 and 100`);
  }
  const available = metric?.status === 'available' && Number.isFinite(Number(metric.value));
  const eagleValue = available ? Number(metric.value) : null;
  const absoluteDifference = available ? round(Math.abs(eagleValue-referenceValue),6) : null;
  const percentDifference = !available ? null : referenceValue === 0
    ? (absoluteDifference === 0 ? 0 : null)
    : round(absoluteDifference/Math.abs(referenceValue)*100,6);
  const passed = available && (toleranceType === 'absolute'
    ? absoluteDifference <= toleranceValue
    : percentDifference != null && percentDifference <= toleranceValue);
  return {
    metricId,metricLabel:metric?.label || metricId,metricUnit:metric?.unit || 'unknown',
    eagleValue,referenceValue,absoluteDifference,percentDifference,toleranceValue,toleranceType,
    outcome:!available ? 'unavailable' : passed ? 'passed' : 'failed',
    evidenceReference,note:String(input.note || '').trim().slice(0,1000) || null,
  };
}

function summarizeChecks(checks) {
  return {
    total:checks.length,
    passed:checks.filter((check)=>check.outcome==='passed').length,
    failed:checks.filter((check)=>check.outcome==='failed').length,
    unavailable:checks.filter((check)=>check.outcome==='unavailable').length,
  };
}

async function listValidationRuns(input, pool = null) {
  const p = pool || getPool();
  const integration = await getAuthorizedIntegration(required(input.integrationId,'integrationId'),required(input.apiKeyId,'apiKeyId'),'allow_read',p);
  const limit = Math.min(Math.max(Number(input.limit)||20,1),100);
  const [rows] = await p.query(
    `SELECT id,snapshot_id AS snapshotId,reference_system AS referenceSystem,status,
            checks_total AS checksTotal,checks_passed AS checksPassed,checks_failed AS checksFailed,
            checks_unavailable AS checksUnavailable,created_by AS createdBy,
            completed_at AS completedAt,created_at AS createdAt
     FROM eagle_validation_runs WHERE integration_id=? AND api_key_id=?
     ORDER BY created_at DESC LIMIT ?`,
    [integration.id,input.apiKeyId,limit]
  );
  return rows.map(numericRow);
}

async function getValidationRun(id, apiKeyId, pool = null) {
  const p = pool || getPool();
  const [runs] = await p.query(
    `SELECT id,snapshot_id AS snapshotId,integration_id AS integrationId,api_key_id AS apiKeyId,
            reference_system AS referenceSystem,scope_json AS scope,status,checks_total AS checksTotal,
            checks_passed AS checksPassed,checks_failed AS checksFailed,
            checks_unavailable AS checksUnavailable,created_by AS createdBy,
            completed_at AS completedAt,created_at AS createdAt
     FROM eagle_validation_runs WHERE id=? AND api_key_id=? LIMIT 1`,
    [id,apiKeyId]
  );
  if (!runs[0]) throw statusError(404,'EAGLE validation run not found');
  const [checks] = await p.query(
    `SELECT metric_id AS metricId,metric_label AS metricLabel,metric_unit AS metricUnit,
            eagle_value AS eagleValue,reference_value AS referenceValue,
            absolute_difference AS absoluteDifference,percent_difference AS percentDifference,
            tolerance_value AS toleranceValue,tolerance_type AS toleranceType,outcome,
            evidence_reference AS evidenceReference,note,created_at AS createdAt
     FROM eagle_validation_checks WHERE run_id=? ORDER BY id`,
    [id]
  );
  return { ...numericRow(runs[0]),scope:parseJson(runs[0].scope),checks:checks.map(numericRow) };
}

async function listRolloutAudit(input, pool = null) {
  const p=pool||getPool();
  const integration=await getAuthorizedIntegration(required(input.integrationId,'integrationId'),required(input.apiKeyId,'apiKeyId'),'allow_read',p);
  const limit=Math.min(Math.max(Number(input.limit)||20,1),100);
  const [rows]=await p.query(
    `SELECT id,actor_admin_id AS actorAdminId,from_mode AS fromMode,to_mode AS toMode,reason,
            validation_run_id AS validationRunId,created_at AS createdAt
     FROM eagle_rollout_audit WHERE integration_id=? AND api_key_id=?
     ORDER BY created_at DESC LIMIT ?`,[integration.id,input.apiKeyId,limit]
  );
  return rows.map(numericRow);
}

async function getRolloutStatus(input, pool = null) {
  const p = pool || getPool();
  let integrationId = input.integrationId;
  let apiKeyId = input.apiKeyId;
  if (input.snapshotId) {
    const snapshot = await eagle.getSnapshot(input.snapshotId,apiKeyId || null,p);
    integrationId=snapshot.integrationId;apiKeyId=snapshot.apiKeyId;
  }
  const integration = await getAuthorizedIntegration(required(integrationId,'integrationId'),required(apiKeyId,'apiKeyId'),'allow_read',p);
  const requiredPasses = Math.min(Math.max(Number(process.env.EAGLE_VALIDATION_REQUIRED_RUNS)||2,1),10);
  await p.query(
    `INSERT IGNORE INTO eagle_rollout_states (integration_id,api_key_id,rollout_mode,required_passes)
     VALUES (?,?,'parallel',?)`,
    [integration.id,apiKeyId,requiredPasses]
  );
  const [states] = await p.query(
    `SELECT api_key_id AS stateApiKeyId,rollout_mode AS mode,required_passes AS requiredPasses,promoted_by AS promotedBy,
            promoted_at AS promotedAt,updated_at AS updatedAt
     FROM eagle_rollout_states WHERE integration_id=? LIMIT 1`,[integration.id]
  );
  const [runs] = await p.query(
    `SELECT id,snapshot_id AS snapshotId,status,checks_total AS checksTotal,
            checks_passed AS checksPassed,checks_failed AS checksFailed,
            checks_unavailable AS checksUnavailable,created_at AS createdAt
     FROM eagle_validation_runs WHERE integration_id=? AND api_key_id=?
     ORDER BY created_at DESC LIMIT 20`,[integration.id,apiKeyId]
  );
  const consecutivePasses=countConsecutivePasses(runs);
  const state = numericRow(states[0] || { mode:'parallel',requiredPasses });
  return {
    ...state,integrationId:integration.id,apiKeyId,
    ownershipMatches:state.stateApiKeyId === apiKeyId,
    consecutivePasses,
    readyForGoverned:consecutivePasses>=Number(state.requiredPasses || requiredPasses),
    latestRun:runs[0] ? numericRow(runs[0]) : null,
  };
}

async function setRolloutMode(input, admin, pool = null) {
  const p = pool || getPool();
  const integrationId = required(input.integrationId,'integrationId');
  const apiKeyId = required(input.apiKeyId,'apiKeyId');
  const integration = await getAuthorizedIntegration(integrationId,apiKeyId,'allow_read',p);
  const toMode = String(input.mode || '').toLowerCase();
  if (!ROLLOUT_MODES.has(toMode)) throw statusError(400,'mode must be legacy, parallel, or governed');
  const reason = required(input.reason,'reason').slice(0,1000);
  const before = await getRolloutStatus({ integrationId,apiKeyId },p);
  const ownershipChanged = Boolean(before.stateApiKeyId && before.stateApiKeyId !== apiKeyId);
  const ownershipEvidence = ownershipChanged
    ? ` [API key ownership transfer: ${before.stateApiKeyId} -> ${apiKeyId}]`
    : '';
  const auditReason = `${reason.slice(0,Math.max(0,1000-ownershipEvidence.length))}${ownershipEvidence}`;
  if (toMode === 'governed' && !before.readyForGoverned) {
    throw statusError(409,`Governed rollout requires ${before.requiredPasses} consecutive passed validations on distinct snapshots; ${before.consecutivePasses} are ready`);
  }
  const conn = typeof p.getConnection === 'function' ? await p.getConnection() : p;
  try {
    if (typeof conn.beginTransaction === 'function') await conn.beginTransaction();
    await conn.query(
      `UPDATE eagle_rollout_states SET api_key_id=?,rollout_mode=?,promoted_by=?,
         promoted_at=CASE WHEN ?='governed' THEN CURRENT_TIMESTAMP ELSE promoted_at END
       WHERE integration_id=?`,[apiKeyId,toMode,admin?.id || null,toMode,integration.id]
    );
    await conn.query(
      `INSERT INTO eagle_rollout_audit
         (integration_id,api_key_id,actor_admin_id,from_mode,to_mode,reason,validation_run_id)
       VALUES (?,?,?,?,?,?,?)`,
      [integration.id,apiKeyId,admin?.id || null,before.mode,toMode,auditReason,before.latestRun?.id || null]
    );
    if (typeof conn.commit === 'function') await conn.commit();
  } catch (error) {
    if (typeof conn.rollback === 'function') await conn.rollback();
    throw error;
  } finally {
    if (conn !== p && typeof conn.release === 'function') conn.release();
  }
  return getRolloutStatus({ integrationId,apiKeyId },p);
}

function numericRow(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key,value])=>[
    key,typeof value==='number'||/^-?\d+(\.\d+)?$/.test(String(value??''))?Number(value):value,
  ]));
}
function countConsecutivePasses(runs) {
  const seen=new Set();let count=0;
  for(const run of runs||[]){if(run.status!=='passed')break;if(seen.has(run.snapshotId))continue;seen.add(run.snapshotId);count+=1;}
  return count;
}
function parseJson(value){if(!value||typeof value==='object')return value||{};try{return JSON.parse(value);}catch{return{};}}
function round(value,places){const factor=10**places;return Math.round(value*factor)/factor;}
function required(value,label){const text=String(value??'').trim();if(!text)throw statusError(400,`${label} is required`);return text;}
function statusError(status,message){return Object.assign(new Error(message),{status});}

module.exports={
  VALIDATION_METRICS,createValidationRun,listValidationRuns,getValidationRun,
  getRolloutStatus,setRolloutMode,evaluateCheck,summarizeChecks,validationScope,
  countConsecutivePasses,
  listRolloutAudit,
};
