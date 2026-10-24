const crypto=require('crypto');
const {getPool}=require('../db/pool');

const CONFIRMATION='PURGE EXPIRED SENTINEL DATA';
const DEFAULT_POLICIES={
  api_events:90,login_events:90,forensic_access:365,routine_runs:365,
  validation_runs:730,ip_intel_cache:30,
};

async function ensureRetentionPolicies(pool=getPool()){
  for(const [dataClass,days] of Object.entries(DEFAULT_POLICIES))await pool.query(`INSERT IGNORE INTO sentinel_retention_policies (data_class,retention_days) VALUES (?,?)`,[dataClass,days]);
}
async function listRetentionPolicies(){const pool=getPool();await ensureRetentionPolicies(pool);const [rows]=await pool.query(`SELECT data_class,retention_days,is_enabled,updated_by,updated_at FROM sentinel_retention_policies ORDER BY data_class`);return rows.map((row)=>({dataClass:row.data_class,retentionDays:Number(row.retention_days)||0,isEnabled:Boolean(row.is_enabled),updatedBy:row.updated_by,updatedAt:row.updated_at}));}
async function saveRetentionPolicy(input={},adminId=null){
  const dataClass=String(input.dataClass||'').trim();if(!(dataClass in DEFAULT_POLICIES))throw Object.assign(new Error('Unsupported retention data class'),{status:400});
  const days=Math.min(Math.max(Number(input.retentionDays)||0,1),3650);const pool=getPool();
  await pool.query(`INSERT INTO sentinel_retention_policies (data_class,retention_days,is_enabled,updated_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE retention_days=VALUES(retention_days),is_enabled=VALUES(is_enabled),updated_by=VALUES(updated_by)`,[dataClass,days,input.isEnabled===false?0:1,adminId||null]);
  return listRetentionPolicies();
}
async function previewRetention(){
  const pool=getPool();const policies=await listRetentionPolicies();const byClass=new Map(policies.map((item)=>[item.dataClass,item]));const impact={};
  for(const spec of retentionSpecs(byClass)){
    if(!spec.enabled){impact[spec.dataClass]={eligible:0,retentionDays:spec.days,enabled:false};continue;}
    const [rows]=await pool.query(spec.countSql,[spec.days]);impact[spec.dataClass]={eligible:Number(rows[0]?.eligible)||0,retentionDays:spec.days,enabled:true};
  }
  const [envelopes]=await pool.query(`SELECT COUNT(*) AS eligible FROM sentinel_http_envelopes WHERE expires_at<UTC_TIMESTAMP(3)`);
  impact.expired_forensic_envelopes={eligible:Number(envelopes[0]?.eligible)||0,policy:'expiry timestamp',enabled:true};
  return{impact,totalEligible:Object.values(impact).reduce((sum,item)=>sum+(Number(item.eligible)||0),0),preserved:['sentinel_threat_cases','sentinel_case_actions','sentinel_case_notes','sentinel_case_status_history','sentinel_forensic_access audit metadata'],confirmationRequired:CONFIRMATION};
}
async function executeRetention({confirmation}={},adminId=null){
  if(String(confirmation||'')!==CONFIRMATION)throw Object.assign(new Error('Exact retention confirmation phrase is required'),{status:400,code:'RETENTION_CONFIRMATION_REQUIRED'});
  const pool=getPool();const preview=await previewRetention();const id=crypto.randomUUID();
  await pool.query(`INSERT INTO sentinel_retention_runs (id,mode,status,executed_by,impact_json) VALUES (?,'execute','running',?,?)`,[id,adminId||null,JSON.stringify(preview)]);
  const policies=await listRetentionPolicies();const byClass=new Map(policies.map((item)=>[item.dataClass,item]));const deleted={};const conn=await pool.getConnection();
  try{await conn.beginTransaction();
    for(const spec of retentionSpecs(byClass)){
      if(!spec.enabled){deleted[spec.dataClass]=0;continue;}
      let total=0,rows=0;
      do{const [res]=await conn.query(spec.deleteSql,[spec.days]);rows=Number(res.affectedRows)||0;total+=rows;}while(rows>0);
      deleted[spec.dataClass]=total;
      if(spec.afterDeleteSql){
        let aTotal=0,aRows=0;
        do{const [aRes]=await conn.query(spec.afterDeleteSql,[spec.days]);aRows=Number(aRes.affectedRows)||0;aTotal+=aRows;}while(aRows>0);
        deleted[spec.dataClass]+=aTotal;
      }
    }
    let envTotal=0,envRows=0;
    do{const [res]=await conn.query(`DELETE FROM sentinel_http_envelopes WHERE expires_at<UTC_TIMESTAMP(3) LIMIT 10000`);envRows=Number(res.affectedRows)||0;envTotal+=envRows;}while(envRows>0);
    deleted.expired_forensic_envelopes=envTotal;
    await conn.commit();await pool.query(`UPDATE sentinel_retention_runs SET status='completed',impact_json=?,completed_at=UTC_TIMESTAMP(3) WHERE id=?`,[JSON.stringify({preview,deleted}),id]);
    return{id,status:'completed',preview,deleted};
  }catch(error){await conn.rollback();await pool.query(`UPDATE sentinel_retention_runs SET status='failed',error_summary=?,completed_at=UTC_TIMESTAMP(3) WHERE id=?`,[String(error.message||'Retention failed').slice(0,512),id]);throw error;}finally{conn.release();}
}
function retentionSpecs(byClass){
  const policy=(name)=>byClass.get(name)||{retentionDays:DEFAULT_POLICIES[name],isEnabled:true};
  return[
    spec('api_events','api_sentinel_events','created_at',policy('api_events')),
    spec('login_events','api_login_events','created_at',policy('login_events')),
    spec('forensic_access','sentinel_forensic_access','accessed_at',policy('forensic_access')),
    spec('routine_runs','sentinel_routine_runs','started_at',policy('routine_runs')),
    {dataClass:'validation_runs',days:policy('validation_runs').retentionDays,enabled:policy('validation_runs').isEnabled,countSql:`SELECT COUNT(*) AS eligible FROM sentinel_validation_runs WHERE created_at<UTC_TIMESTAMP(3)-INTERVAL ? DAY`,deleteSql:`DELETE o FROM sentinel_validation_observations o INNER JOIN sentinel_validation_runs r ON r.id=o.run_id WHERE r.created_at<UTC_TIMESTAMP(3)-INTERVAL ? DAY`,afterDeleteSql:`DELETE FROM sentinel_validation_runs WHERE created_at<UTC_TIMESTAMP(3)-INTERVAL ? DAY LIMIT 10000`},
    spec('ip_intel_cache','sentinel_ip_intel_cache','expires_at',policy('ip_intel_cache')),
  ];
}
function spec(dataClass,table,column,policy){return{dataClass,days:policy.retentionDays,enabled:policy.isEnabled,countSql:`SELECT COUNT(*) AS eligible FROM ${table} WHERE ${column}<UTC_TIMESTAMP(3)-INTERVAL ? DAY`,deleteSql:`DELETE FROM ${table} WHERE ${column}<UTC_TIMESTAMP(3)-INTERVAL ? DAY LIMIT 10000`};}
module.exports={CONFIRMATION,DEFAULT_POLICIES,listRetentionPolicies,saveRetentionPolicy,previewRetention,executeRetention,retentionSpecs};
