function buildExecutiveBrief(dashboard, rollout, snapshot, now = new Date(), targetAssessments = []) {
  const metrics=dashboard?.metrics || {};
  const total=metricValue(metrics.new_leads);
  const attention=[];
  const momentum=[];

  for(const target of targetAssessments.filter((item)=>item.status==='off_target')) {
    const direction=target.direction==='at_most'?'above':'below';
    const unit=target.unit==='percent'?' percentage points':'';
    attention.push(signal(`target-${target.metricId}`,'target',95,`${target.metricLabel} is off target`,
      `${formatValue(target.currentValue,target.unit)} is ${direction} the approved ${target.targetLabel} target by ${formatNumber(target.gap)}${unit}.`,
      `Review corrective action with ${target.businessOwner}.`,target.metricId,'targets'));
  }

  const unassigned=metricValue(metrics.actionable_unassigned);
  if(unassigned>0) attention.push(signal('ownership','attention',100,'Leads need ownership',
    `${formatNumber(unassigned)} actionable leads are unassigned${total>0?` (${percent(unassigned,total)} of this scope)`:''}.`,
    'Assign an owner or confirm that these leads should leave the actionable pool.','actionable_unassigned','leads'));

  const source=metrics.source_coverage;
  if(source?.status==='available'&&Number(source.denominator)>Number(source.numerator)) {
    const missing=Number(source.denominator)-Number(source.numerator);
    attention.push(signal('source-gap','data_quality',80,'Source attribution is incomplete',
      `${formatNumber(missing)} leads lack a governed marketing source (${percent(missing,source.denominator)} of this scope).`,
      'Resolve source mappings or correct missing CRM attribution.','source_coverage','overview'));
  }

  const dnc=metrics.dnc_blocked;
  const dncRate=metrics.dnc_rate;
  if(metricValue(dnc)>0) attention.push(signal('dnc','attention',70,'DNC records are excluded',
    `${formatNumber(metricValue(dnc))} leads are blocked from dialing${dncRate?.status==='available'?` (${Number(dncRate.value).toLocaleString(undefined,{maximumFractionDigits:1})}%)`:''}.`,
    'Keep these contacts excluded and review the clean actionable pool.','dnc_blocked','leads'));

  const historicalWin=metrics.lead_to_win_rate;
  if(historicalWin?.status!=='available') attention.push(signal('win-evidence','data_quality',60,'Historical win conversion is unavailable',
    historicalWin?.statusReason || 'A complete opportunity extract is required for historical win conversion.',
    'Load complete opportunity evidence before using historical win rates.','lead_to_win_rate','validation'));

  addComparison(momentum,metrics.new_leads,'Lead intake');
  addComparison(momentum,metrics.current_scheduled_rate,'Current scheduled rate','percentage points');
  addComparison(momentum,metrics.current_won_rate,'Current won rate','percentage points');

  const trust=buildTrustStatus(snapshot,rollout,now);
  const sorted=attention.sort((a,b)=>b.priority-a.priority);
  const decision=buildDecisionSummary(dashboard,metrics,sorted,trust);
  return {
    contractVersion:'1.1',
    asOf:dashboard?.period?.asOf || snapshot?.completedAt || snapshot?.createdAt || null,
    headline:total>0
      ? `${formatNumber(total)} leads in scope; ${formatNumber(unassigned)} require ownership.`
      : 'No leads are available in the selected scope.',
    attention:sorted.slice(0,4),
    attentionTotal:sorted.length,
    momentum:momentum.slice(0,3),
    targets:{
      configured:targetAssessments.length,
      onTarget:targetAssessments.filter((item)=>item.status==='on_target').length,
      nearTarget:targetAssessments.filter((item)=>item.status==='near_target').length,
      offTarget:targetAssessments.filter((item)=>item.status==='off_target').length,
      unavailable:targetAssessments.filter((item)=>item.status==='unavailable').length,
      notApplicable:targetAssessments.filter((item)=>item.status==='not_applicable').length,
      scopeReason:targetAssessments.find((item)=>item.status==='not_applicable')?.applicability?.reason || null,
      assessments:targetAssessments,
    },
    decision,
    trust,
  };
}

function buildDecisionSummary(dashboard,metrics,attention,trust) {
  const total=metricValue(metrics.new_leads);
  const unassigned=metricValue(metrics.actionable_unassigned);
  const leadChange=metricComparison(metrics.new_leads);
  const scheduledRate=availableMetricValue(metrics.current_scheduled_rate);
  const wonRate=availableMetricValue(metrics.current_won_rate);
  const unassignedRate=total>0?Math.round(unassigned/total*1000)/10:null;
  const leadingSource=topKnownRow(dashboard?.breakdowns?.sources?.rows || dashboard?.sources);
  const leadingMarket=topKnownRow(dashboard?.breakdowns?.cities?.rows || dashboard?.cities);
  const severe=attention.some((item)=>item.type==='target') || (unassignedRate!=null&&unassignedRate>=50);
  const posture=severe?'action':attention.length?'watch':'on_course';
  const postureLabel=posture==='action'?'Action required':posture==='watch'?'Watch closely':'On course';
  const pace=leadChange==null?'has no prior-period comparison'
    :leadChange===0?'is flat versus the prior period'
      :`is ${leadChange>0?'up':'down'} ${formatNumber(Math.abs(leadChange))}% versus the prior period`;
  const ownership=unassigned>0
    ? `${formatNumber(unassigned)} lead${unassigned===1?' is':'s are'} waiting for ownership`
    : 'every actionable lead has ownership';
  const context=[];
  if(leadingSource)context.push(`${leadingSource.label} is the largest governed source at ${formatNumber(leadingSource.share)}% of volume`);
  if(leadingMarket)context.push(`${leadingMarket.label} is the leading market at ${formatNumber(leadingMarket.share)}%`);
  if(!context.length)context.push('The selected scope has no reliable source or market leader yet');
  return {
    posture,postureLabel,
    headline:total>0?`Lead volume ${pace}; ${ownership}.`:'No leads are available in the selected scope.',
    narrative:`${context.join('; ')}. Current-state rates are ${formatOptionalPercent(scheduledRate)} scheduled and ${formatOptionalPercent(wonRate)} won.`,
    actionCount:attention.length,
    primaryAction:attention[0] || null,
    scorecards:[
      {id:'volume',label:'Lead volume',value:formatNumber(total),detail:leadChange==null?'No prior-period comparison':`${signed(leadChange)}% vs prior period`,state:leadChange>0?'positive':leadChange<0?'negative':'neutral'},
      {id:'ownership',label:'Needs ownership',value:formatNumber(unassigned),detail:unassignedRate==null?'No denominator':`${formatNumber(unassignedRate)}% of leads in scope`,state:unassigned>0?'risk':'positive'},
      {id:'scheduled',label:'Currently scheduled',value:formatOptionalPercent(scheduledRate),detail:metricComparisonLabel(metrics.current_scheduled_rate),state:metricComparison(metrics.current_scheduled_rate)>0?'positive':'neutral'},
      {id:'won',label:'Currently won',value:formatOptionalPercent(wonRate),detail:metricComparisonLabel(metrics.current_won_rate),state:wonRate>0?'positive':'neutral'},
    ],
    trust:{status:trust.overall,label:trust.overall==='ready'?'Evidence ready':trust.overall==='review'?'Evidence review needed':'Evidence monitored'},
  };
}

function buildTrustStatus(snapshot,rollout,now = new Date()) {
  const freshnessHours=boundedEnv('EAGLE_FRESHNESS_SLA_HOURS',26,1,168);
  const validationHours=boundedEnv('EAGLE_VALIDATION_MAX_AGE_HOURS',72,1,720);
  const snapshotAge=ageHours(snapshot?.completedAt || snapshot?.createdAt,now);
  const validationAge=ageHours(rollout?.latestRun?.createdAt,now);
  const snapshotStatus=snapshotAge==null?'unavailable':snapshotAge<=freshnessHours?'current':'stale';
  const validationStatus=!rollout?.latestRun?'unavailable'
    :rollout.latestRun.status!=='passed'?'review'
      :validationAge!=null&&validationAge<=validationHours?'current':'stale';
  const governed=rollout?.mode==='governed';
  const overall=snapshotStatus==='stale'||(governed&&validationStatus!=='current')?'review'
    :governed?'ready':'monitor';
  return {
    overall,
    snapshot:{status:snapshotStatus,ageHours:snapshotAge,maxAgeHours:freshnessHours,asOf:snapshot?.completedAt || snapshot?.createdAt || null},
    validation:{status:validationStatus,ageHours:validationAge,maxAgeHours:validationHours,latestRunId:rollout?.latestRun?.id || null},
    rollout:{mode:rollout?.mode || 'parallel',readyForGoverned:Boolean(rollout?.readyForGoverned)},
  };
}

function addComparison(output,metric,label,unitLabel) {
  if(metric?.status!=='available'||!metric.comparison||!Number.isFinite(Number(metric.comparison.value)))return;
  const value=Number(metric.comparison.value);const direction=value>0?'up':value<0?'down':'flat';
  const unit=metric.comparison.kind==='percentage_points'?'points':'percent';
  output.push({metricId:metric.metricId,label,direction,value,unit,
    text:value===0?`${label} is unchanged from the prior period.`:`${label} is ${direction} ${Math.abs(value).toLocaleString(undefined,{maximumFractionDigits:1})} ${unitLabel||unit} from the prior period.`});
}

function signal(id,type,priority,title,detail,action,metricId,view){return{id,type,priority,title,detail,action,metricId,view};}
function metricValue(metric){return metric?.status==='available'&&Number.isFinite(Number(metric.value))?Number(metric.value):0;}
function availableMetricValue(metric){return metric?.status==='available'&&Number.isFinite(Number(metric.value))?Number(metric.value):null;}
function metricComparison(metric){return metric?.comparison&&Number.isFinite(Number(metric.comparison.value))?Number(metric.comparison.value):null;}
function metricComparisonLabel(metric){const value=metricComparison(metric);return value==null?'No prior-period comparison':value===0?'Unchanged vs prior period':`${signed(value)} pts vs prior period`;}
function signed(value){return `${Number(value)>0?'+':''}${formatNumber(value)}`;}
function formatOptionalPercent(value){return value==null?'Unavailable':`${formatNumber(value)}%`;}
function topKnownRow(rows){return (rows||[]).find((row)=>row&&!row.isOther&&!row.unknownReason&&!['unattributed','unmapped identifier','unknown','[object object]'].includes(String(row.label||'').trim().toLowerCase())&&Number.isFinite(Number(row.share)));}
function percent(value,total){return Number(total)>0?`${(Number(value)/Number(total)*100).toLocaleString(undefined,{maximumFractionDigits:1})}%`:'—';}
function formatNumber(value){return Number(value||0).toLocaleString();}
function formatValue(value,unit){return unit==='percent'?`${Number(value).toLocaleString(undefined,{maximumFractionDigits:1})}%`:formatNumber(value);}
function ageHours(value,now){if(!value)return null;const date=new Date(value),end=new Date(now);if(Number.isNaN(date.getTime())||Number.isNaN(end.getTime()))return null;return Math.max(0,Math.round((end-date)/360000)/10);}
function boundedEnv(name,fallback,min,max){const value=Number(process.env[name]);return Number.isFinite(value)?Math.min(Math.max(value,min),max):fallback;}

module.exports={buildExecutiveBrief,buildDecisionSummary,buildTrustStatus,ageHours};
