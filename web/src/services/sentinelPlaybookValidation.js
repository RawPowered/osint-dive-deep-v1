const crypto=require('crypto');
const {getPool}=require('../db/pool');
const {getPlaybook}=require('./sentinelPlaybooks');

const VALIDATION_GATES=Object.freeze([
  {key:'trigger_matching',label:'Trigger matching',description:'Expected cases recommend the playbook and unrelated cases do not.'},
  {key:'authorization',label:'Authorization',description:'Unauthorized roles cannot approve, publish, or execute restricted operations.'},
  {key:'idempotency',label:'Idempotency',description:'Repeating the workflow does not duplicate or corrupt response state.'},
  {key:'failure_handling',label:'Failure handling',description:'Timeout, retry, cancellation, and partial failure behavior is understood.'},
  {key:'rollback',label:'Rollback',description:'Rollback guidance is executable and preserves forensic evidence.'},
  {key:'evidence_completeness',label:'Evidence completeness',description:'Required decisions, references, actor, and timestamps are retained.'},
  {key:'case_resolution',label:'Case resolution',description:'The workflow supports governed resolution and validation without bypass.'},
  {key:'drift_reactivation',label:'Drift and reactivation',description:'Changed IP, key, path, status, volume, or conditions return to analyst review.'},
]);
const OUTCOMES=new Set(['passed','failed','partial','not_tested']);

async function recordValidation(playbookId,{gateKey,outcome,evidenceReference,note}={},adminId=null){const gate=VALIDATION_GATES.find((item)=>item.key===gateKey);if(!gate)throw statusError(400,'Unknown playbook validation gate');if(!OUTCOMES.has(outcome))throw statusError(400,'Invalid validation outcome');if(outcome!=='not_tested'&&!String(evidenceReference||'').trim())throw statusError(400,'An evidence reference is required');const playbook=await getPlaybook(playbookId),pool=getPool();await pool.query(`INSERT INTO sentinel_playbook_validation_results (id,playbook_id,version_id,gate_key,outcome,evidence_reference,note,tested_by) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE outcome=VALUES(outcome),evidence_reference=VALUES(evidence_reference),note=VALUES(note),tested_by=VALUES(tested_by),tested_at=UTC_TIMESTAMP(3)`,[crypto.randomUUID(),playbook.id,playbook.currentVersionId,gate.key,outcome,String(evidenceReference||'not tested').slice(0,512),String(note||'').slice(0,1000)||null,adminId||null]);return getPlaybookValidation(playbook.id,playbook.currentVersionId);}
async function getPlaybookValidation(playbookId,versionId=null){let version=versionId;if(!version){const playbook=await getPlaybook(playbookId);version=playbook.currentVersionId;}const pool=getPool();const [rows]=await pool.query(`SELECT * FROM sentinel_playbook_validation_results WHERE version_id=? ORDER BY tested_at DESC`,[version]);return summarizeValidation(rows);}
function summarizeValidation(rows=[]){const byKey=new Map(rows.map((row)=>[row.gate_key,row]));const gates=VALIDATION_GATES.map((gate)=>{const row=byKey.get(gate.key);return{...gate,outcome:row?.outcome||'not_tested',evidenceReference:row?.evidence_reference||null,note:row?.note||null,testedBy:row?.tested_by||null,testedAt:row?.tested_at||null};});const passed=gates.filter((gate)=>gate.outcome==='passed').length,failed=gates.filter((gate)=>gate.outcome==='failed').length,partial=gates.filter((gate)=>gate.outcome==='partial').length;return{ready:passed===gates.length,total:gates.length,passed,failed,partial,notTested:gates.length-passed-failed-partial,gates};}
async function assertValidationReady(versionId){const pool=getPool();const [rows]=await pool.query(`SELECT gate_key,outcome FROM sentinel_playbook_validation_results WHERE version_id=?`,[versionId]);const summary=summarizeValidation(rows);if(!summary.ready)throw statusError(409,`Playbook validation incomplete: ${summary.passed}/${summary.total} gates passed`);return summary;}
function statusError(status,message){return Object.assign(new Error(message),{status});}
module.exports={VALIDATION_GATES,OUTCOMES,recordValidation,getPlaybookValidation,summarizeValidation,assertValidationReady};
