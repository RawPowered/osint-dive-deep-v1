const crypto = require('crypto');
const { getPool } = require('../db/pool');

const TECHNIQUE_RE = /^T\d{4}(?:\.\d{3})?$/;
const OUTCOMES = new Set(['pending','detected','missed','partial','prevented']);
const RUN_STATUSES = new Set(['planned','running','completed','cancelled']);

function techniqueId(value) {
  const id = String(value || '').trim().toUpperCase();
  if (!TECHNIQUE_RE.test(id)) throw Object.assign(new Error('Technique ID must use MITRE format such as T1110 or T1110.001'), { status:400 });
  return id;
}

async function createValidationRun(input = {}, adminId = null) {
  const name = String(input.name || '').trim();
  if (!name) throw Object.assign(new Error('Validation run name is required'), { status:400 });
  const pool = getPool();
  const id = crypto.randomUUID();
  const status = input.start === true ? 'running' : 'planned';
  await pool.query(
    `INSERT INTO sentinel_validation_runs (id,name,objective,detection_window_minutes,status,created_by,started_at)
     VALUES (?,?,?,?,?,?,${status === 'running' ? 'UTC_TIMESTAMP(3)' : 'NULL'})`,
    [id,name.slice(0,128),String(input.objective || '').trim().slice(0,512) || null,
      Math.min(Math.max(Number(input.detectionWindowMinutes)||15,1),1440),status,adminId || null]
  );
  return getValidationRun(id);
}

async function getValidationRun(id) {
  const pool = getPool();
  const [runs] = await pool.query(`SELECT * FROM sentinel_validation_runs WHERE id=? LIMIT 1`, [id]);
  if (!runs[0]) return null;
  const [observations] = await pool.query(
    `SELECT * FROM sentinel_validation_observations WHERE run_id=? ORDER BY simulated_at,created_at`, [id]
  );
  return mapRun(runs[0], observations);
}

async function listValidationRuns({ limit = 100 } = {}) {
  const pool = getPool();
  const lim = Math.min(Math.max(Number(limit)||100,1),300);
  const [rows] = await pool.query(
    `SELECT r.*,COUNT(o.id) AS observations,SUM(o.outcome='detected') AS detected,
      SUM(o.outcome='missed') AS missed,SUM(o.outcome='prevented') AS prevented
     FROM sentinel_validation_runs r LEFT JOIN sentinel_validation_observations o ON o.run_id=r.id
     GROUP BY r.id ORDER BY r.created_at DESC LIMIT ?`, [lim]
  );
  return rows.map((row)=>mapRun(row));
}

async function setValidationRunStatus(id, status, adminId = null) {
  const value = String(status || '').trim().toLowerCase();
  if (!RUN_STATUSES.has(value)) throw Object.assign(new Error('Invalid validation run status'), { status:400 });
  const pool = getPool();
  const [result] = await pool.query(
    `UPDATE sentinel_validation_runs SET status=?,
      started_at=CASE WHEN ?='running' THEN COALESCE(started_at,UTC_TIMESTAMP(3)) ELSE started_at END,
      ended_at=CASE WHEN ? IN ('completed','cancelled') THEN UTC_TIMESTAMP(3) ELSE NULL END
     WHERE id=?`, [value,value,value,id]
  );
  if (!result.affectedRows) throw Object.assign(new Error('Validation run not found'), { status:404 });
  return getValidationRun(id);
}

async function recordValidationObservation(runId, input = {}, adminId = null) {
  const pool = getPool();
  const run = await getValidationRun(runId);
  if (!run) throw Object.assign(new Error('Validation run not found'), { status:404 });
  if (run.status === 'completed' || run.status === 'cancelled') throw Object.assign(new Error('Completed validation runs cannot be modified'), { status:409 });
  const technique = techniqueId(input.techniqueId);
  const outcome = String(input.outcome || 'pending').trim().toLowerCase();
  if (!OUTCOMES.has(outcome)) throw Object.assign(new Error('Invalid validation outcome'), { status:400 });
  const simulatedAt = validDate(input.simulatedAt) || new Date();
  const detectedAt = validDate(input.detectedAt);
  if (outcome === 'detected' && !detectedAt) throw Object.assign(new Error('detectedAt is required for detected outcomes'), { status:400 });
  if (detectedAt && detectedAt < simulatedAt) throw Object.assign(new Error('detectedAt cannot precede simulatedAt'), { status:400 });
  await pool.query(
    `INSERT INTO sentinel_validation_observations
       (id,run_id,technique_id,tactic,expected_rule_id,triggered_case_id,outcome,simulated_at,detected_at,note,recorded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [crypto.randomUUID(),runId,technique,String(input.tactic || '').trim().slice(0,64)||null,
      String(input.expectedRuleId || '').trim().slice(0,64)||null,String(input.triggeredCaseId || '').trim()||null,
      outcome,mysqlDate(simulatedAt),detectedAt ? mysqlDate(detectedAt) : null,String(input.note || '').trim().slice(0,1000)||null,adminId||null]
  );
  return getValidationRun(runId);
}

async function evaluateValidationRun(runId, { createRemediation = false, forceMissed = false } = {}, adminId = null) {
  const pool = getPool();
  const run = await getValidationRun(runId);
  if (!run) throw Object.assign(new Error('Validation run not found'), { status:404 });
  const windowMinutes = Number(run.detectionWindowMinutes)||15;
  let detected=0;let missed=0;let waiting=0;let remediations=0;
  for(const observation of run.observationRows||[]){
    if(observation.outcome!=='pending')continue;
    const simulated=new Date(observation.simulatedAt);
    const deadline=new Date(simulated.getTime()+windowMinutes*60000);
    const [matches]=await pool.query(
      `SELECT c.id,c.rule_id,c.last_seen,c.created_at FROM sentinel_threat_cases c
       LEFT JOIN sentinel_rule_techniques rt ON rt.rule_id=c.rule_id
       WHERE (c.rule_id=? OR (? IS NULL AND rt.technique_id=?))
         AND COALESCE(c.last_seen,c.created_at) BETWEEN ? AND ?
       ORDER BY COALESCE(c.last_seen,c.created_at) ASC LIMIT 1`,
      [observation.expectedRuleId,observation.expectedRuleId,observation.techniqueId,mysqlDate(simulated),mysqlDate(deadline)]
    );
    if(matches[0]){
      const detectedAt=new Date(matches[0].last_seen||matches[0].created_at);
      await pool.query(`UPDATE sentinel_validation_observations SET outcome='detected',triggered_case_id=?,detected_at=?,evaluated_at=UTC_TIMESTAMP(3),evaluation_source='case_correlation' WHERE id=?`,
        [matches[0].id,mysqlDate(detectedAt),observation.id]);detected+=1;continue;
    }
    if(!forceMissed&&Date.now()<deadline.getTime()){waiting+=1;continue;}
    await pool.query(`UPDATE sentinel_validation_observations SET outcome='missed',evaluated_at=UTC_TIMESTAMP(3),evaluation_source='case_correlation' WHERE id=?`,[observation.id]);
    missed+=1;
    if(createRemediation){
      const caseId=await createGapCase(pool,{...observation,outcome:'missed'},run,adminId);
      await pool.query(`UPDATE sentinel_validation_observations SET remediation_case_id=? WHERE id=?`,[caseId,observation.id]);remediations+=1;
    }
  }
  return { detected,missed,waiting,remediations,run:await getValidationRun(runId) };
}

async function createGapCase(pool,observation,run,adminId){
  const fingerprint=`purple_validation_gap:technique:${observation.techniqueId}`.slice(0,191);
  const [existing]=await pool.query(`SELECT id FROM sentinel_threat_cases WHERE fingerprint=? LIMIT 1`,[fingerprint]);
  if(existing[0])return existing[0].id;
  const id=crypto.randomUUID();
  const evidence=JSON.stringify({validationRunId:run.id,techniqueId:observation.techniqueId,expectedRuleId:observation.expectedRuleId||null,simulatedAt:observation.simulatedAt});
  await pool.query(`INSERT INTO sentinel_threat_cases
    (id,fingerprint,rule_id,severity,title,summary,entity_type,entity,status,owner_admin_id,priority,due_at,evidence_json,count,first_seen,last_seen)
    VALUES (?,?,'purple_validation_gap','high',?,?,'technique',?,'open',?,'high',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 4 HOUR),?,1,?,?)`,
    [id,fingerprint,`Detection gap: ${observation.techniqueId}`.slice(0,255),
      `Purple Team validation did not observe the expected detection during ${run.name}`.slice(0,512),observation.techniqueId,adminId||null,evidence,observation.simulatedAt,observation.simulatedAt]);
  return id;
}

async function mapRuleTechnique(input = {}, adminId = null) {
  const ruleId = String(input.ruleId || '').trim().slice(0,64);
  if (!ruleId) throw Object.assign(new Error('Rule ID is required'), { status:400 });
  const technique = techniqueId(input.techniqueId);
  const pool = getPool();
  await pool.query(
    `INSERT INTO sentinel_rule_techniques (rule_id,technique_id,tactic,updated_by) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE tactic=VALUES(tactic),updated_by=VALUES(updated_by)`,
    [ruleId,technique,String(input.tactic || '').trim().slice(0,64)||null,adminId||null]
  );
  return { ruleId,techniqueId:technique,tactic:String(input.tactic || '').trim()||null };
}

async function getValidationCoverage({ sinceDays = 90 } = {}) {
  const pool = getPool();
  const days = Math.min(Math.max(Number(sinceDays)||90,1),3650);
  const [totals] = await pool.query(
    `SELECT COUNT(*) AS observations,COUNT(DISTINCT technique_id) AS techniques,
      SUM(outcome='detected') AS detected,SUM(outcome='missed') AS missed,
      SUM(outcome='partial') AS partial,SUM(outcome='prevented') AS prevented,
      AVG(CASE WHEN detected_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND,simulated_at,detected_at) END) AS avgDetectionSeconds
     FROM sentinel_validation_observations WHERE simulated_at>=UTC_TIMESTAMP(3)-INTERVAL ? DAY`, [days]
  );
  const [techniques] = await pool.query(
    `SELECT technique_id AS techniqueId,MAX(tactic) AS tactic,COUNT(*) AS tests,
      SUM(outcome='detected') AS detected,SUM(outcome='missed') AS missed,
      MAX(simulated_at) AS lastTested
     FROM sentinel_validation_observations WHERE simulated_at>=UTC_TIMESTAMP(3)-INTERVAL ? DAY
     GROUP BY technique_id ORDER BY missed DESC,tests DESC,technique_id`, [days]
  );
  const [mapped] = await pool.query(`SELECT COUNT(DISTINCT technique_id) AS mappedTechniques,COUNT(DISTINCT rule_id) AS mappedRules FROM sentinel_rule_techniques`);
  const value = totals[0] || {};
  const detected = Number(value.detected)||0;
  const missed = Number(value.missed)||0;
  return { sinceDays:days,totals:{ observations:Number(value.observations)||0,techniques:Number(value.techniques)||0,
    detected,missed,partial:Number(value.partial)||0,prevented:Number(value.prevented)||0,
    detectionRate:detected+missed ? detected/(detected+missed) : 0,avgDetectionSeconds:Number(value.avgDetectionSeconds)||0,
    mappedTechniques:Number(mapped[0]?.mappedTechniques)||0,mappedRules:Number(mapped[0]?.mappedRules)||0 },
    techniques:techniques.map((row)=>({...row,tests:Number(row.tests)||0,detected:Number(row.detected)||0,missed:Number(row.missed)||0})) };
}

function mapRun(row, observations) {
  return { id:row.id,name:row.name,objective:row.objective,status:row.status,createdBy:row.created_by,
    detectionWindowMinutes:Number(row.detection_window_minutes)||15,
    startedAt:row.started_at,endedAt:row.ended_at,createdAt:row.created_at,updatedAt:row.updated_at,
    observations:Number(row.observations)||0,detected:Number(row.detected)||0,missed:Number(row.missed)||0,
    prevented:Number(row.prevented)||0,observationRows:observations?.map(mapObservation) };
}
function mapObservation(row) { return { id:row.id,techniqueId:row.technique_id,tactic:row.tactic,expectedRuleId:row.expected_rule_id,
  triggeredCaseId:row.triggered_case_id,outcome:row.outcome,simulatedAt:row.simulated_at,detectedAt:row.detected_at,
  evaluatedAt:row.evaluated_at,evaluationSource:row.evaluation_source,remediationCaseId:row.remediation_case_id,note:row.note,recordedBy:row.recorded_by }; }
function validDate(value) { if (!value) return null; const date=new Date(value); return Number.isNaN(date.getTime())?null:date; }
function mysqlDate(date) { return date.toISOString().slice(0,23).replace('T',' '); }

module.exports = { techniqueId,createValidationRun,getValidationRun,listValidationRuns,setValidationRunStatus,
  recordValidationObservation,evaluateValidationRun,mapRuleTechnique,getValidationCoverage,OUTCOMES,RUN_STATUSES };
