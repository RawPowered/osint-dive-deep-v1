const crypto=require('crypto');
const {getPool}=require('../db/pool');
const {fingerprintFor}=require('./sentinelCases');

const DISPOSITIONS=new Set(['acknowledged','known_benign','remediated']);

async function createFindingDisposition(finding,input={},adminId=null){
  const disposition=String(input.disposition||'').trim().toLowerCase();
  if(!DISPOSITIONS.has(disposition))throw Object.assign(new Error('Invalid finding disposition'),{status:400});
  const reason=String(input.reason||'').trim();if(!reason)throw Object.assign(new Error('Disposition reason is required'),{status:400});
  const context=finding.context||{};const durationDays=Math.min(Math.max(Number(input.durationDays)||30,1),365);
  const scope={apiKeyId:context.apiKeyId||null,keyPrefix:context.keyPrefix||null,statusCode:context.statusCode??null,ip:context.ip||null,method:context.method||null,path:context.path||null};
  const conditions={
    allowedStatusCodes:Array.isArray(input.allowedStatusCodes)?input.allowedStatusCodes.map(Number).filter(Number.isFinite):(context.statusCode!=null?[Number(context.statusCode)]:[]),
    allowedIps:Array.isArray(input.allowedIps)?input.allowedIps.map(String).filter(Boolean):(context.ip?[String(context.ip)]:[]),
    maxCount:Math.max(Number(input.maxCount)||Math.ceil((Number(finding.count)||1)*2),Number(finding.count)||1),
  };
  const id=crypto.randomUUID();const pool=getPool();
  await pool.query(`INSERT INTO sentinel_finding_dispositions
    (id,fingerprint,rule_id,entity_type,entity,disposition,scope_json,conditions_json,reason,baseline_count,created_by,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? DAY))`,
    [id,fingerprintFor(finding),String(finding.ruleId||'unknown').slice(0,64),String(finding.entityType||'metric').slice(0,32),String(finding.entity||'').slice(0,255),disposition,JSON.stringify(scope),JSON.stringify(conditions),reason.slice(0,1000),Number(finding.count)||0,adminId||null,durationDays]);
  return{id,fingerprint:fingerprintFor(finding),disposition,scope,conditions,reason,expiresInDays:durationDays};
}

async function applyFindingDispositions(findings=[]){
  if(!findings.length)return{active:[],suppressed:[],acknowledged:[]};const pool=getPool();const fingerprints=[...new Set(findings.map(fingerprintFor))];const placeholders=fingerprints.map(()=>'?').join(',');
  const [rows]=await pool.query(`SELECT * FROM sentinel_finding_dispositions WHERE is_active=1 AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3)) AND fingerprint IN (${placeholders}) ORDER BY created_at DESC`,fingerprints);
  const byFingerprint=new Map();for(const row of rows)if(!byFingerprint.has(row.fingerprint))byFingerprint.set(row.fingerprint,row);
  const active=[];const suppressed=[];const acknowledged=[];
  for(const finding of findings){const row=byFingerprint.get(fingerprintFor(finding));if(!row){active.push(finding);continue;}const disposition=mapDisposition(row);const evaluation=evaluateDisposition(finding,disposition);
    const enriched={...finding,disposition:{...disposition,evaluation}};
    if(disposition.disposition==='acknowledged'){active.push(enriched);acknowledged.push(enriched);}
    else if(evaluation.matches){suppressed.push(enriched);}else{active.push({...enriched,reactivated:true,reactivationReasons:evaluation.reasons});}
  }
  return{active,suppressed,acknowledged};
}

function evaluateDisposition(finding,record){
  const context=finding.context||{};const conditions=record.conditions||{};const reasons=[];
  if(conditions.allowedStatusCodes?.length&&!conditions.allowedStatusCodes.includes(Number(context.statusCode)))reasons.push('status_code_changed');
  if(conditions.allowedIps?.length&&!conditions.allowedIps.includes(String(context.ip||'')))reasons.push('source_ip_changed');
  if(Number.isFinite(Number(conditions.maxCount))&&Number(finding.count)>Number(conditions.maxCount))reasons.push('volume_exceeded');
  const scope=record.scope||{};
  if(scope.apiKeyId&&String(scope.apiKeyId)!==String(context.apiKeyId||''))reasons.push('api_key_changed');
  if(scope.path&&scope.path!==context.path)reasons.push('path_changed');
  return{matches:reasons.length===0,reasons};
}

async function listFindingDispositions({activeOnly=true,limit=200}={}){const pool=getPool();const [rows]=await pool.query(`SELECT * FROM sentinel_finding_dispositions ${activeOnly?'WHERE is_active=1 AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3))':''} ORDER BY created_at DESC LIMIT ?`,[Math.min(Math.max(Number(limit)||200,1),500)]);return rows.map(mapDisposition);}
async function revokeFindingDisposition(id,{adminId=null,reason='Revoked by administrator'}={}){const pool=getPool();const [result]=await pool.query(`UPDATE sentinel_finding_dispositions SET is_active=0,revoked_at=UTC_TIMESTAMP(3),revoked_by=?,revoke_reason=? WHERE id=? AND is_active=1`,[adminId||null,String(reason).slice(0,512),id]);if(!result.affectedRows)throw Object.assign(new Error('Active disposition not found'),{status:404});return{id,revoked:true};}
function mapDisposition(row){return{id:row.id,fingerprint:row.fingerprint,ruleId:row.rule_id,entityType:row.entity_type,entity:row.entity,disposition:row.disposition,scope:parse(row.scope_json),conditions:parse(row.conditions_json),reason:row.reason,baselineCount:Number(row.baseline_count)||0,createdBy:row.created_by,expiresAt:row.expires_at,isActive:Boolean(row.is_active),createdAt:row.created_at};}
function parse(value){try{return typeof value==='string'?JSON.parse(value):value||{};}catch{return{};}}
module.exports={DISPOSITIONS,createFindingDisposition,applyFindingDispositions,evaluateDisposition,listFindingDispositions,revokeFindingDisposition,mapDisposition};
