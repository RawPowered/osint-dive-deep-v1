const { getPool }=require('../db/pool');
const { getAuthorizedIntegration }=require('./crmIntegrations');

const TARGETABLE_METRICS=new Set([
  'new_leads','current_scheduled_rate','current_won_rate','actionable_unassigned',
  'source_coverage','campaign_coverage','dnc_rate','location_completeness',
  'lead_to_appointment_rate','lead_to_win_rate','appointment_to_win_rate',
]);
const TARGET_DIRECTIONS=new Set(['at_least','at_most']);
const PERCENT_METRICS=new Set(['current_scheduled_rate','current_won_rate','source_coverage','campaign_coverage','dnc_rate','location_completeness','lead_to_appointment_rate','lead_to_win_rate','appointment_to_win_rate']);

async function listTargets(input,pool=null) {
  const p=pool||getPool();
  const integration=await getAuthorizedIntegration(required(input.integrationId,'integrationId'),required(input.apiKeyId,'apiKeyId'),'allow_read',p);
  const [rows]=await p.query(
    `SELECT metric_id AS metricId,period_days AS periodDays,target_value AS targetValue,target_direction AS direction,
            warning_margin AS warningMargin,business_owner AS businessOwner,is_active AS active,
            updated_by AS updatedBy,created_at AS createdAt,updated_at AS updatedAt
     FROM eagle_metric_targets WHERE integration_id=? AND api_key_id=? ORDER BY metric_id`,
    [integration.id,input.apiKeyId]
  );
  return rows.map(numericRow);
}

async function upsertTarget(input,admin,pool=null) {
  const p=pool||getPool();
  const integration=await getAuthorizedIntegration(required(input.integrationId,'integrationId'),required(input.apiKeyId,'apiKeyId'),'allow_read',p);
  const metricId=required(input.metricId,'metricId');
  if(!TARGETABLE_METRICS.has(metricId))throw statusError(400,'metricId is not targetable');
  const direction=String(input.direction||'');
  if(!TARGET_DIRECTIONS.has(direction))throw statusError(400,'direction must be at_least or at_most');
  const maximum=PERCENT_METRICS.has(metricId)?100:1000000000;
  const periodDays=normalizePeriodDays(input.periodDays);
  const targetValue=numberInRange(input.targetValue,'targetValue',0,maximum);
  const warningMargin=numberInRange(input.warningMargin??0,'warningMargin',0,maximum);
  const businessOwner=required(input.businessOwner,'businessOwner').slice(0,128);
  const reason=required(input.reason,'reason').slice(0,1000);
  const active=input.active!==false;
  const [beforeRows]=await p.query(
    `SELECT metric_id AS metricId,period_days AS periodDays,target_value AS targetValue,target_direction AS direction,
            warning_margin AS warningMargin,business_owner AS businessOwner,is_active AS active
     FROM eagle_metric_targets WHERE integration_id=? AND metric_id=? LIMIT 1`,[integration.id,metricId]
  );
  const after={metricId,periodDays,targetValue,direction,warningMargin,businessOwner,active};
  const conn=typeof p.getConnection==='function'?await p.getConnection():p;
  try{
    if(typeof conn.beginTransaction==='function')await conn.beginTransaction();
    await conn.query(
      `INSERT INTO eagle_metric_targets
         (integration_id,api_key_id,metric_id,period_days,target_value,target_direction,warning_margin,business_owner,is_active,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE api_key_id=VALUES(api_key_id),period_days=VALUES(period_days),target_value=VALUES(target_value),
         target_direction=VALUES(target_direction),warning_margin=VALUES(warning_margin),
         business_owner=VALUES(business_owner),is_active=VALUES(is_active),updated_by=VALUES(updated_by)`,
      [integration.id,input.apiKeyId,metricId,periodDays,targetValue,direction,warningMargin,businessOwner,active?1:0,admin?.id||null]
    );
    await conn.query(
      `INSERT INTO eagle_metric_target_audit
         (integration_id,api_key_id,metric_id,actor_admin_id,reason,before_json,after_json)
       VALUES (?,?,?,?,?,?,?)`,
      [integration.id,input.apiKeyId,metricId,admin?.id||null,reason,beforeRows[0]?JSON.stringify(numericRow(beforeRows[0])):null,JSON.stringify(after)]
    );
    if(typeof conn.commit==='function')await conn.commit();
  }catch(error){if(typeof conn.rollback==='function')await conn.rollback();throw error;}
  finally{if(conn!==p&&typeof conn.release==='function')conn.release();}
  return after;
}

function evaluateTargets(metrics,targets,scope={}) {
  return (targets||[]).filter((target)=>Boolean(target.active)).map((target)=>{
    const applicability=targetApplicability(target,scope);
    if(!applicability.applicable)return {...evaluateTarget(metrics?.[target.metricId],target),status:'not_applicable',applicability};
    return {...evaluateTarget(metrics?.[target.metricId],target),applicability};
  });
}

function targetApplicability(target,scope={}) {
  const filters=scope.filters||{};
  const activeFilters=Object.entries(filters).filter(([,value])=>value!=null&&String(value).trim()!=='').map(([key])=>key);
  const targetDays=target.periodDays==null?null:Number(target.periodDays);
  const currentDays=scope.days==null||scope.days===''?null:Number(scope.days);
  const scopeLabel=targetDays?`Integration-wide / last ${targetDays} days`:'Integration-wide / all time';
  if(activeFilters.length)return {applicable:false,scopeLabel,reason:`Clear ${activeFilters.join(', ')} filters to apply this integration-wide target.`};
  if(targetDays!==currentDays)return {applicable:false,scopeLabel,reason:`Target is approved for ${targetDays?`the last ${targetDays} days`:'all time'}; the current period does not match.`};
  return {applicable:true,scopeLabel,reason:null};
}

function evaluateTarget(metric,target) {
  const value=metric?.status==='available'&&Number.isFinite(Number(metric.value))?Number(metric.value):null;
  const targetValue=Number(target.targetValue),margin=Number(target.warningMargin)||0;
  const unit=metric?.unit||'unknown';
  if(value==null)return {...target,metricLabel:metric?.label||target.metricId,unit,currentValue:null,status:'unavailable',favorableVariance:null,targetLabel:formatTarget(directionSymbol(target.direction),targetValue,unit)};
  const favorableVariance=target.direction==='at_least'?value-targetValue:targetValue-value;
  const status=favorableVariance>=0?'on_target':favorableVariance>=-margin?'near_target':'off_target';
  return {...target,metricLabel:metric?.label||target.metricId,unit,currentValue:value,status,
    favorableVariance:round(favorableVariance,6),gap:round(Math.max(0,-favorableVariance),6),
    targetLabel:formatTarget(directionSymbol(target.direction),targetValue,unit)};
}

function directionSymbol(direction){return direction==='at_most'?'≤':'≥';}
function formatTarget(symbol,value,unit){const formatted=Number(value).toLocaleString(undefined,{maximumFractionDigits:2});return `${symbol} ${formatted}${unit==='percent'?'%':''}`;}
function numberInRange(value,label,min,max){const number=Number(value);if(!Number.isFinite(number)||number<min||number>max)throw statusError(400,`${label} must be between ${min} and ${max}`);return number;}
function normalizePeriodDays(value){if(value==null||value==='')return null;const days=Number(value);if(![7,30,90,365].includes(days))throw statusError(400,'periodDays must be 7, 30, 90, 365, or empty for all time');return days;}
function numericRow(row){return Object.fromEntries(Object.entries(row||{}).map(([key,value])=>[key,typeof value==='number'||/^-?\d+(\.\d+)?$/.test(String(value??''))?Number(value):value]));}
function round(value,places){const factor=10**places;return Math.round(value*factor)/factor;}
function required(value,label){const text=String(value??'').trim();if(!text)throw statusError(400,`${label} is required`);return text;}
function statusError(status,message){return Object.assign(new Error(message),{status});}

module.exports={TARGETABLE_METRICS,listTargets,upsertTarget,evaluateTargets,evaluateTarget,targetApplicability,normalizePeriodDays};
