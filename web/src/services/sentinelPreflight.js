const REQUIRED_SCHEMA={
  users:['id','locationId','username','email','passwordHash','role'],
  api_sentinel_events:['id','created_at','method','path','status_code','request_id','surface','actor_type','action','outcome'],
  api_login_events:['id','created_at','event_type','outcome','request_id'],
  sentinel_http_envelopes:['request_id','captured_at','envelope_enc','integrity_hmac','expires_at'],
  sentinel_ip_sightings:['ip','first_seen','last_seen','total_requests','auth_fail_count','success_count'],
  sentinel_threat_cases:['id','status','owner_admin_id','disposition','due_at','resolution_summary','validation_summary','reopen_count'],
  sentinel_case_notes:['id','case_id','admin_id','note_type','note','created_at'],
  sentinel_case_status_history:['id','case_id','from_status','to_status','created_at'],
  sentinel_validation_runs:['id','status','detection_window_minutes'],
  sentinel_validation_observations:['id','run_id','technique_id','outcome','evaluated_at','remediation_case_id'],
  sentinel_routine_runs:['id','routine_key','status','summary_json'],
  sentinel_retention_policies:['data_class','retention_days','is_enabled'],
  sentinel_retention_runs:['id','mode','status','impact_json'],
  sentinel_finding_dispositions:['id','fingerprint','disposition','scope_json','conditions_json','expires_at','is_active'],
  sentinel_playbooks:['id','slug','status','current_version_id'],
  sentinel_playbook_versions:['id','playbook_id','version_number','status'],
  sentinel_playbook_steps:['id','version_id','step_order','risk_class'],
  sentinel_playbook_runs:['id','playbook_id','version_id','status','mode'],
  sentinel_playbook_step_runs:['id','run_id','step_id','status','evidence_reference'],
  sentinel_playbook_reviews:['id','playbook_id','version_id','action','from_status','to_status','reason'],
  sentinel_playbook_simulations:['id','playbook_id','version_id','mode','status','context_hash','action_plan_json','result_json'],
  sentinel_playbook_validation_results:['id','playbook_id','version_id','gate_key','outcome','evidence_reference','tested_by'],
  sentinel_resource_items:['id','slug','item_type','review_status','source_domain','linked_case_id','linked_playbook_id'],
  sentinel_resource_reviews:['id','resource_id','actor_admin_id','from_status','to_status','note'],
  dialer_activity_minutes:['location_id','user_id','activity_minute','heartbeat_count'],
};
const REQUIRED_INDEXES={
  users:['idx_users_location_username','idx_users_location_email'],
  api_sentinel_events:['idx_sentinel_created','idx_sentinel_status','idx_sentinel_action'],
  api_login_events:['idx_login_created','idx_login_outcome','idx_login_ip'],
  sentinel_threat_cases:['uq_case_fingerprint','idx_cases_status'],
  sentinel_validation_observations:['idx_validation_observation_run','idx_validation_observation_technique'],
  sentinel_routine_runs:['uq_sentinel_routine_key'],
};

async function runSentinelPreflight(pool){
  const checks=[];const names=Object.keys(REQUIRED_SCHEMA);
  const [columns]=await pool.query(`SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(()=>'?').join(',')})`,names);
  const found=new Map();for(const row of columns){const table=String(row.tableName||row.TABLE_NAME);if(!found.has(table))found.set(table,new Set());found.get(table).add(String(row.columnName||row.COLUMN_NAME));}
  for(const [table,required] of Object.entries(REQUIRED_SCHEMA)){const actual=found.get(table)||new Set();const missing=required.filter((column)=>!actual.has(column));checks.push({id:`schema:${table}`,status:missing.length?'fail':'pass',detail:missing.length?`Missing columns: ${missing.join(', ')}`:'Required columns installed'});}
  const indexTables=Object.keys(REQUIRED_INDEXES);const [indexes]=await pool.query(`SELECT TABLE_NAME AS tableName,INDEX_NAME AS indexName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${indexTables.map(()=>'?').join(',')})`,indexTables);
  const foundIndexes=new Map();for(const row of indexes){const table=String(row.tableName||row.TABLE_NAME);if(!foundIndexes.has(table))foundIndexes.set(table,new Set());foundIndexes.get(table).add(String(row.indexName||row.INDEX_NAME));}
  for(const [table,required] of Object.entries(REQUIRED_INDEXES)){const actual=foundIndexes.get(table)||new Set();const missing=required.filter((index)=>!actual.has(index));checks.push({id:`indexes:${table}`,status:missing.length?'fail':'pass',detail:missing.length?`Missing indexes: ${missing.join(', ')}`:'Required indexes installed'});}
  const [settings]=await pool.query(`SELECT setting_key,setting_value FROM app_settings WHERE setting_key IN ('installed','schema_version')`);
  const values=Object.fromEntries(settings.map((row)=>[row.setting_key,row.setting_value]));
  checks.push({id:'installation',status:values.installed==='true'?'pass':'fail',detail:values.installed==='true'?'Application installation marker present':'Application is not marked installed'});
  checks.push({id:'schema_version',status:values.schema_version?'pass':'warn',detail:values.schema_version?`Schema version ${values.schema_version}`:'Schema version marker missing'});
  const [authRows]=await pool.query(`SELECT COUNT(*) AS totalUsers,SUM(passwordHash IS NOT NULL AND passwordHash<>'') AS credentialUsers FROM users`);
  const totalUsers=Number(authRows[0]?.totalUsers)||0;const credentialUsers=Number(authRows[0]?.credentialUsers)||0;
  checks.push({
    id:'authentication_database',
    status:credentialUsers===0?'fail':credentialUsers<totalUsers?'warn':'pass',
    detail:credentialUsers===0?'Legacy users table has no password credentials':credentialUsers<totalUsers?`${totalUsers-credentialUsers} of ${totalUsers} Legacy user(s) have no password credential`:`${credentialUsers} Legacy user credential(s) are available`,
  });
  const [legacy]=await pool.query(`SELECT status,COUNT(*) AS total FROM sentinel_threat_cases WHERE status IN ('under_review','watching','blocked','dismissed') GROUP BY status`);
  checks.push({id:'legacy_case_statuses',status:legacy.length?'warn':'pass',detail:legacy.length?`${legacy.reduce((sum,row)=>sum+Number(row.total||0),0)} legacy case status record(s) remain`:'Case lifecycle migration complete'});
  if(typeof pool.getConnection==='function'){
    const {verifyTelemetryWritePath}=require('./sentinelHealth');
    const probe=await verifyTelemetryWritePath(pool);
    checks.push({id:'telemetry_write_path',status:probe.status==='healthy'?'pass':'fail',detail:probe.detail});
  }else{
    checks.push({id:'telemetry_write_path',status:'warn',detail:'Transactional write probe skipped by pool adapter'});
  }
  const summary=summarizePreflight(checks);return{...summary,checks,checkedAt:new Date().toISOString()};
}
function summarizePreflight(checks){const failed=checks.filter((item)=>item.status==='fail').length;const warnings=checks.filter((item)=>item.status==='warn').length;return{ready:failed===0,failed,warnings,passed:checks.length-failed-warnings};}
module.exports={REQUIRED_SCHEMA,REQUIRED_INDEXES,runSentinelPreflight,summarizePreflight};
