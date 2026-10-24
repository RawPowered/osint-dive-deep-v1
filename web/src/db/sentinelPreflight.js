const {loadEnv}=require('../config');
const {createPool}=require('./pool');
const {runSentinelPreflight}=require('../services/sentinelPreflight');

if(require.main===module){(async()=>{loadEnv();const pool=createPool();try{const result=await runSentinelPreflight(pool);console.log(`Sentinel preflight: ${result.ready?'READY':'NOT READY'} · ${result.passed} passed · ${result.warnings} warning(s) · ${result.failed} failed`);for(const item of result.checks)console.log(`[${item.status.toUpperCase()}] ${item.id}: ${item.detail}`);process.exitCode=result.ready?0:1;}finally{await pool.end();}})().catch((error)=>{console.error('Sentinel preflight failed:',error.message);process.exitCode=1;});}
