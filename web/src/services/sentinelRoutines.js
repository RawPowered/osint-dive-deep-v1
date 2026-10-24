const crypto=require('crypto');
const { getPool }=require('../db/pool');
const { computeThreats }=require('./sentinelThreats');
const { listValidationRuns,evaluateValidationRun }=require('./sentinelValidation');
const { purgeExpiredForensics }=require('./sentinelForensics');
const { buildDailySocReport }=require('./sentinelReports');

function dailyRoutineKey(date=new Date()) { return `daily_protection:${date.toISOString().slice(0,10)}`; }

async function runDailyProtectionRoutine({ hours=24,force=false }={},adminId=null) {
  const pool=getPool();const key=dailyRoutineKey();
  if(!force){const [existing]=await pool.query(`SELECT * FROM sentinel_routine_runs WHERE routine_key=? LIMIT 1`,[key]);if(existing[0])return {reused:true,run:mapRun(existing[0])};}
  const id=crypto.randomUUID();const effectiveKey=force?`${key}:${id.slice(0,8)}`:key;
  await pool.query(`INSERT INTO sentinel_routine_runs (id,routine_key,status,triggered_by) VALUES (?,?,'running',?)`,[id,effectiveKey,adminId||null]);
  const summary={ detections:{},validation:{runs:0,detected:0,missed:0,waiting:0},forensics:{expiredPurged:0},exceptions:[],report:null };
  try{
    const threats=await computeThreats({sinceHours:hours,syncCases:true});
    summary.detections={findings:threats.findings?.length||0,counts:threats.counts||{},caseSync:threats.caseSync||{}};
    const runs=await listValidationRuns({limit:300});
    for(const run of runs.filter((item)=>item.status==='running')){
      const result=await evaluateValidationRun(run.id,{createRemediation:true,forceMissed:false},adminId);
      summary.validation.runs+=1;summary.validation.detected+=result.detected;summary.validation.missed+=result.missed;summary.validation.waiting+=result.waiting;
    }
    summary.forensics.expiredPurged=await purgeExpiredForensics();
    const report=await buildDailySocReport({sinceHours:hours});
    const ops=report.operations?.totals||{};
    summary.report={posture:report.posture,caseFlow:report.caseFlow,priorityCases:report.priorityCases?.length||0};
    if(ops.slaBreached)summary.exceptions.push({type:'sla_breach',count:ops.slaBreached});
    if(ops.unassigned)summary.exceptions.push({type:'unassigned_cases',count:ops.unassigned});
    if(report.telemetry?.freshness?.apiLastSeen&&Date.now()-new Date(report.telemetry.freshness.apiLastSeen).getTime()>15*60000)summary.exceptions.push({type:'stale_api_telemetry',count:1});
    await pool.query(`UPDATE sentinel_routine_runs SET status='completed',summary_json=?,completed_at=UTC_TIMESTAMP(3) WHERE id=?`,[JSON.stringify(summary),id]);
    return {reused:false,run:{id,routineKey:effectiveKey,routineType:'daily_protection',status:'completed',triggeredBy:adminId||null,summary}};
  }catch(error){
    await pool.query(`UPDATE sentinel_routine_runs SET status='failed',error_summary=?,summary_json=?,completed_at=UTC_TIMESTAMP(3) WHERE id=?`,[String(error.message||'Routine failed').slice(0,512),JSON.stringify(summary),id]);
    throw error;
  }
}

async function listRoutineRuns({limit=30}={}){
  const lim=Math.min(Math.max(Number(limit)||30,1),200);const [rows]=await getPool().query(`SELECT * FROM sentinel_routine_runs ORDER BY started_at DESC LIMIT ?`,[lim]);return rows.map(mapRun);
}
function mapRun(row){let summary=null;try{summary=typeof row.summary_json==='string'?JSON.parse(row.summary_json):row.summary_json;}catch{}return{id:row.id,routineKey:row.routine_key,routineType:row.routine_type,status:row.status,triggeredBy:row.triggered_by,summary,errorSummary:row.error_summary,startedAt:row.started_at,completedAt:row.completed_at};}

module.exports={dailyRoutineKey,runDailyProtectionRoutine,listRoutineRuns,mapRun};
