const {getPool}=require('../db/pool');
const crypto=require('crypto');
const {getTelemetryWriterStatus}=require('./telemetryWriter');

const REQUIRED_TABLES=[
  'api_sentinel_events','api_login_events','sentinel_threat_cases','sentinel_case_actions',
  'sentinel_case_notes','sentinel_case_status_history','sentinel_http_envelopes',
  'sentinel_validation_runs','sentinel_validation_observations','sentinel_routine_runs',
  'sentinel_finding_dispositions',
  'sentinel_playbooks','sentinel_playbook_versions','sentinel_playbook_steps',
  'sentinel_playbook_runs','sentinel_playbook_step_runs',
  'sentinel_playbook_reviews',
  'sentinel_playbook_simulations',
  'sentinel_playbook_validation_results',
  'sentinel_resource_items','sentinel_resource_reviews',
];
const AUTH_REQUIRED_COLUMNS=['id','locationId','username','email','passwordHash','role'];
const AUTH_REQUIRED_INDEXES=['idx_users_location_username','idx_users_location_email'];

async function getSentinelControlHealth(){
  const pool=getPool();const checks=[];
  const [tables]=await pool.query(`SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${REQUIRED_TABLES.map(()=>'?').join(',')})`,REQUIRED_TABLES);
  const present=new Set(tables.map((row)=>String(row.tableName||row.TABLE_NAME)));
  const missing=REQUIRED_TABLES.filter((name)=>!present.has(name));
  checks.push(check('schema',missing.length?'critical':'healthy',missing.length?`Missing ${missing.length} required table(s)`:'Required Sentinel tables are installed',{missing}));
  checks.push(await databaseClockCheck(pool));
  checks.push(await verifyAuthenticationDatabase(pool));
  checks.push(telemetryWriterCheck(getTelemetryWriterStatus()));
  if(present.has('api_sentinel_events')&&present.has('api_login_events')){
    checks.push(await verifyTelemetryWritePath(pool));
  }
  if(present.has('api_sentinel_events')){
    const [rows]=await pool.query(`SELECT MAX(created_at) AS lastSeen,COUNT(*) AS events24h,TIMESTAMPDIFF(SECOND,MAX(created_at),NOW(3)) AS ageSeconds FROM api_sentinel_events WHERE created_at>=UTC_TIMESTAMP(3)-INTERVAL 24 HOUR`);
    checks.push(freshnessCheck('api_telemetry',rows[0]?.lastSeen,Number(rows[0]?.events24h)||0,rows[0]?.ageSeconds));
  }
  if(present.has('api_login_events')){
    const [rows]=await pool.query(`SELECT MAX(created_at) AS lastSeen,COUNT(*) AS events24h,TIMESTAMPDIFF(SECOND,MAX(created_at),NOW(3)) AS ageSeconds FROM api_login_events WHERE created_at>=UTC_TIMESTAMP(3)-INTERVAL 24 HOUR`);
    checks.push(freshnessCheck('authentication_telemetry',rows[0]?.lastSeen,Number(rows[0]?.events24h)||0,rows[0]?.ageSeconds));
  }
  if(present.has('sentinel_routine_runs')){
    const [rows]=await pool.query(`SELECT status,started_at,completed_at,error_summary FROM sentinel_routine_runs ORDER BY started_at DESC LIMIT 1`);
    const run=rows[0];
    const age=run?Date.now()-new Date(run.completed_at||run.started_at).getTime():Infinity;
    checks.push(check('daily_routine',!run||run.status==='failed'?'critical':age>36*3600000?'degraded':'healthy',!run?'No daily protection routine has run':run.status==='failed'?`Latest routine failed: ${run.error_summary||'unknown error'}`:age>36*3600000?'Latest routine is older than 36 hours':'Daily protection routine is current',{lastRunAt:run?.completed_at||run?.started_at||null,status:run?.status||null}));
  }
  if(present.has('sentinel_threat_cases')){
    const [rows]=await pool.query(`SELECT
      SUM(status NOT IN ('resolved','closed') AND owner_admin_id IS NULL) AS unassigned,
      SUM(status NOT IN ('resolved','closed') AND due_at IS NULL) AS missingSla,
      SUM(status NOT IN ('resolved','closed') AND due_at<UTC_TIMESTAMP(3)) AS breached
      FROM sentinel_threat_cases`);
    const value=rows[0]||{};const count=Number(value.unassigned)||0;const missingSla=Number(value.missingSla)||0;const breached=Number(value.breached)||0;
    checks.push(check('case_governance',breached?'critical':count||missingSla?'degraded':'healthy',breached?`${breached} case SLA breach(es)`:count||missingSla?`${count} unassigned; ${missingSla} without SLA`:'Active cases have ownership and SLA controls',{unassigned:count,missingSla,breached}));
  }
  if(present.has('sentinel_validation_observations')&&present.has('sentinel_validation_runs')){
    const [rows]=await pool.query(`SELECT COUNT(*) AS overdue FROM sentinel_validation_observations o
      INNER JOIN sentinel_validation_runs r ON r.id=o.run_id WHERE o.outcome='pending'
      AND DATE_ADD(o.simulated_at,INTERVAL r.detection_window_minutes MINUTE)<UTC_TIMESTAMP(3)`);
    const overdue=Number(rows[0]?.overdue)||0;
    checks.push(check('validation_pipeline',overdue?'degraded':'healthy',overdue?`${overdue} validation observation(s) await evaluation`:'No overdue validation observations',{overdue}));
  }
  if(present.has('sentinel_http_envelopes')){
    const [rows]=await pool.query(`SELECT COUNT(*) AS expired FROM sentinel_http_envelopes WHERE expires_at<UTC_TIMESTAMP(3)`);
    const expired=Number(rows[0]?.expired)||0;
    checks.push(check('forensic_retention',expired>1000?'degraded':'healthy',expired?`${expired} expired envelope(s) await routine cleanup`:'Expired forensic envelopes are cleared',{expired}));
  }
  return summarizeControlHealth(checks);
}

async function databaseClockCheck(pool,nowMs=Date.now()){
  try{
    const [rows]=await pool.query(`SELECT
      TIMESTAMPDIFF(MINUTE,UTC_TIMESTAMP(),NOW()) AS sessionOffsetMinutes,
      UNIX_TIMESTAMP() AS epochSeconds`);
    const sessionOffsetMinutes=Number(rows[0]?.sessionOffsetMinutes)||0;
    const epochSeconds=Number(rows[0]?.epochSeconds);
    const driftMs=Number.isFinite(epochSeconds)?Math.abs(nowMs-(epochSeconds*1000)):Infinity;
    const status=driftMs>60000?'critical':driftMs>10000?'degraded':'healthy';
    const detail=status==='critical'?'Database clock differs from the API host by more than 60 seconds':
      status==='degraded'?'Database clock differs from the API host by more than 10 seconds':
        `Database clock is synchronized; SQL session offset is ${sessionOffsetMinutes} minute(s)`;
    return check('database_clock',status,detail,{sessionOffsetMinutes,driftMs:Math.round(driftMs)});
  }catch(error){
    return check('database_clock','critical','Database clock verification failed',{code:safeErrorCode(error)});
  }
}

/**
 * Confirm that operator authentication is bound to the installed core/Legacy
 * database and that its users table is both usable and indexed for login.
 * Counts are safe operational metadata; password material is never selected.
 */
async function verifyAuthenticationDatabase(pool){
  try{
    const [databaseRows]=await pool.query('SELECT DATABASE() AS databaseName');
    const databaseName=String(databaseRows[0]?.databaseName||'').trim();
    if(!databaseName){
      return check('authentication_database','critical','No installed authentication database is selected',{source:'core',databaseName:null});
    }

    const [columnRows]=await pool.query(
      `SELECT COLUMN_NAME AS columnName FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'`
    );
    const columns=new Set(columnRows.map((row)=>String(row.columnName||row.COLUMN_NAME)));
    const missingColumns=AUTH_REQUIRED_COLUMNS.filter((name)=>!columns.has(name));
    if(missingColumns.length){
      return check(
        'authentication_database',
        'critical',
        'Installed Legacy users table is missing required authentication columns',
        {source:'core',databaseName,missingColumns}
      );
    }

    const [indexRows]=await pool.query(
      `SELECT DISTINCT INDEX_NAME AS indexName FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'`
    );
    const indexes=new Set(indexRows.map((row)=>String(row.indexName||row.INDEX_NAME)));
    const missingIndexes=AUTH_REQUIRED_INDEXES.filter((name)=>!indexes.has(name));
    const [countRows]=await pool.query(
      `SELECT COUNT(*) AS totalUsers,
              SUM(passwordHash IS NOT NULL AND passwordHash<>'') AS credentialUsers,
              SUM(passwordHash LIKE '$2%') AS bcryptUsers
       FROM users`
    );
    const totalUsers=Number(countRows[0]?.totalUsers)||0;
    const credentialUsers=Number(countRows[0]?.credentialUsers)||0;
    const bcryptUsers=Number(countRows[0]?.bcryptUsers)||0;
    const legacyHashUsers=Math.max(credentialUsers-bcryptUsers,0);
    const missingCredentialUsers=Math.max(totalUsers-credentialUsers,0);
    const metrics={
      source:'core',databaseName,totalUsers,credentialUsers,bcryptUsers,
      legacyHashUsers,missingCredentialUsers,missingIndexes,
    };
    if(!credentialUsers){
      return check('authentication_database','critical','Installed Legacy users table has no password credentials',metrics);
    }
    const migrationRisks=[];
    if(legacyHashUsers) migrationRisks.push(`${legacyHashUsers} user credential(s) still use the replayable legacy hash path`);
    if(missingCredentialUsers) migrationRisks.push(`${missingCredentialUsers} user(s) have no password credential`);
    if(missingIndexes.length) migrationRisks.push('Legacy users login indexes are missing');
    if(migrationRisks.length){
      return check('authentication_database','degraded',migrationRisks.join('; '),metrics);
    }
    return check('authentication_database','healthy','Installed Legacy users table is ready for credential verification',metrics);
  }catch(error){
    return check(
      'authentication_database',
      'critical',
      'Installed Legacy authentication database check failed',
      {source:'core',code:safeErrorCode(error)}
    );
  }
}

async function verifyTelemetryWritePath(pool){
  const requestId=crypto.randomUUID();
  let connection;
  try{
    if(!pool||typeof pool.getConnection!=='function'){
      return check('telemetry_write_path','degraded','Transactional telemetry write probe unavailable',{code:'CONNECTION_PROBE_UNAVAILABLE'});
    }
    connection=await pool.getConnection();
    await connection.beginTransaction();
    await connection.query(`INSERT INTO api_sentinel_events
      (method,path,status_code,duration_ms,error_class,request_id,surface,actor_type,action,outcome)
      VALUES ('PROBE','/internal/sentinel-write-probe',204,0,'none',?,'sentinel','system','sentinel.write_probe','success')`,[requestId]);
    await connection.query(`INSERT INTO api_login_events
      (event_type,outcome,detail,request_id)
      VALUES ('health_probe','success','transactional_write_probe',?)`,[requestId]);
    await connection.rollback();
    return check('telemetry_write_path','healthy','Transactional API and authentication telemetry writes succeeded',{requestId:null});
  }catch(error){
    if(connection){try{await connection.rollback();}catch{}}
    const code=safeErrorCode(error);
    return check('telemetry_write_path','critical','Telemetry tables are not writable',{code});
  }finally{
    if(connection&&typeof connection.release==='function')connection.release();
  }
}

function telemetryWriterCheck(status){
  const writers=status?.writers||{};
  const snapshots=Object.values(writers);
  const latestUnrecovered=snapshots.some((writer)=>writer.lastFailureAt&&
    (!writer.lastSuccessAt||new Date(writer.lastFailureAt)>new Date(writer.lastSuccessAt)));
  const dropped=Number(status?.dropped)||0;
  const failed=Number(status?.failed)||0;
  const pending=Number(status?.pending)||0;
  const state=dropped||latestUnrecovered?'critical':failed||pending>100?'degraded':'healthy';
  const detail=dropped?`${dropped} telemetry event(s) dropped`:
    latestUnrecovered?'A telemetry writer has an unrecovered failure':
      failed?`${failed} telemetry write(s) failed and later activity recovered`:
        pending>100?`${pending} telemetry event(s) await persistence`:'Telemetry writers are operational';
  return check('telemetry_writers',state,detail,{pending,failed,dropped,writers});
}

function safeErrorCode(error){
  const raw=error&&(error.code||error.name)?String(error.code||error.name):'WRITE_PROBE_FAILED';
  return raw.replace(/[^A-Za-z0-9_.-]/g,'').slice(0,64)||'WRITE_PROBE_FAILED';
}

function freshnessCheck(id,lastSeen,events24h,measuredAgeSeconds){
  if(!lastSeen)return check(id,'degraded','No telemetry has been recorded',{lastSeen:null,events24h});
  const measured=Number(measuredAgeSeconds);
  const age=Number.isFinite(measured)?Math.max(0,measured*1000):Date.now()-new Date(lastSeen).getTime();
  return check(id,age>60*60000?'critical':age>15*60000?'degraded':'healthy',age>60*60000?'Telemetry is older than 60 minutes':age>15*60000?'Telemetry is older than 15 minutes':'Telemetry is current',{lastSeen,events24h});
}
function check(id,status,detail,metrics={}){return{id,status,detail,metrics};}
function summarizeControlHealth(checks){
  const counts={healthy:0,degraded:0,critical:0};for(const item of checks)counts[item.status]=(counts[item.status]||0)+1;
  const status=counts.critical?'critical':counts.degraded?'degraded':'healthy';
  return{status,counts,checks,calculatedAt:new Date().toISOString()};
}
module.exports={
  REQUIRED_TABLES,AUTH_REQUIRED_COLUMNS,AUTH_REQUIRED_INDEXES,getSentinelControlHealth,
  freshnessCheck,summarizeControlHealth,verifyTelemetryWritePath,
  verifyAuthenticationDatabase,telemetryWriterCheck,databaseClockCheck,
};
