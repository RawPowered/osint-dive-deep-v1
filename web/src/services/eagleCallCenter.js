const { getPool } = require('../db/pool');
const { getAuthorizedIntegration } = require('./crmIntegrations');
const { DEFAULT_POOL_RULES, listPoolRules } = require('./leadPools');
const { getScheduleWeek, SCHEDULE_TIME_ZONE } = require('./dialerSchedules');

const CALL_CENTER_CONTRACT_VERSION = '1.0';
const CALL_CENTER_METRIC_VERSION = '1.0';
const CALL_CENTER_WORKING_NOW_SECONDS = 180;
const CALL_CENTER_MINIMUM_SAMPLE = Object.freeze({ eligibleLeads:20, verifiedMinutes:300 });
const CALL_CENTER_ELIGIBILITY = Object.freeze({
  workedEvidence:"A CRM-confirmed outbound call attributed to the dialer user during the selected performance period.",
  included:"Distinct called leads whose current DNC state is clean and whose current lifecycle is not DNC Screening, DNC, or Invalid.",
  excluded:"Authorization intents, pending or blocked DNC records, DNC lifecycle records, and Invalid lifecycle records.",
  attribution:"A worked lead contributes once to the yield numerator when the same user booked at least one appointment for it during the selected period.",
  limitation:"Eligibility is evaluated from current operational state because event-time lead eligibility is not yet persisted. Yield is directional and must remain partial.",
});

const CALL_CENTER_METRIC_DEFINITIONS = [
  definition('call_center_roster_users','Roster users','Dialer users configured for the selected CRM location.','count','Configured dialer users',null,'live_operational_state'),
  definition('call_center_working_now','Working now','Roster users with verified dialer activity within the last three minutes.','count','Users with recent verified activity','Roster users','live_operational_state'),
  definition('call_center_schedule_submission_rate','Schedule submission rate','Roster users with a submitted current-week schedule divided by roster users.','percent','Users with submitted schedules','Roster users','current_schedule_week'),
  definition('call_center_submitted_hours','Submitted scheduled hours','Hours contained in submitted current-week schedules. Draft and missing schedules are excluded.','hours','Minutes in submitted schedules',null,'current_schedule_week'),
  definition('call_center_verified_hours','Verified hours','Distinct dialer activity minutes recorded during the selected performance period, expressed as hours.','hours','Verified activity minutes',null,'selected_performance_period'),
  definition('call_center_attendance_rate','Attendance to date','Current-week verified minutes for users with submitted schedules divided by their scheduled minutes elapsed to the report time. Overage is not capped.','percent','Verified minutes for submitted users','Elapsed submitted schedule minutes','current_schedule_week'),
  definition('call_center_engagement_rate','Engaged time rate','Verified activity minutes associated with a CRM contact divided by all verified activity minutes.','percent','Contact-engaged activity minutes','Verified activity minutes','selected_performance_period'),
  definition('call_center_confirmed_calls','CRM-confirmed calls','Outbound call events confirmed by CRM evidence. Dialer authorization intents are excluded.','count','CRM-confirmed outbound call events',null,'selected_performance_period'),
  definition('call_center_call_attribution_rate','Call attribution rate','CRM-confirmed outbound calls attributed to a configured dialer user divided by all CRM-confirmed outbound calls.','percent','User-attributed CRM-confirmed calls','All CRM-confirmed calls','selected_performance_period'),
  definition('call_center_calls_per_verified_hour','Calls per verified hour','CRM-confirmed outbound calls divided by verified dialer activity hours.','rate','CRM-confirmed outbound calls','Verified activity hours','selected_performance_period'),
  definition('call_center_eligible_leads_worked','Eligible leads worked','Distinct leads with an attributed CRM-confirmed outbound call that pass the current-state eligibility rules.','count','Eligible distinct called leads',null,'selected_performance_period_current_state_eligibility'),
  definition('call_center_appointments_booked','Appointments booked','Authoritative local appointment records created by dialer users during the selected performance period.','count','Local appointment records',null,'selected_performance_period'),
  definition('call_center_appointment_yield','Appointment yield','Eligible worked leads with at least one same-user appointment divided by eligible leads worked. This remains partial until event-time eligibility is persisted.','percent','Eligible worked leads with an appointment','Eligible leads worked','selected_performance_period_current_state_eligibility'),
  definition('call_center_available_leads','Available clean leads','Unowned, DNC-clean leads in an enabled Dialer-assignable lifecycle pool.','count','Clean unowned assignable leads',null,'live_operational_state'),
  definition('call_center_active_assignment_load','Active assignment load','Owned leads in enabled non-terminal lifecycle pools.','count','Owned non-terminal leads',null,'live_operational_state'),
];

function definition(metricId,label,description,unit,numeratorLabel,denominatorLabel,timeBasis) {
  return { metricId,definitionVersion:CALL_CENTER_METRIC_VERSION,label,description,unit,numeratorLabel,denominatorLabel,timeBasis,businessOwner:'Revenue Operations' };
}

function buildCallCenterPeriod(input = {}, now = new Date()) {
  const asOf = validDate(now);
  const scheduleWeek = getScheduleWeek(asOf);
  const requested = String(input.period || (input.days ? `${input.days}d` : 'current_week')).toLowerCase();
  let code = 'current_week';
  let days = null;
  let start = new Date(scheduleWeek.deadlineAt);
  if (['1d','7d','30d'].includes(requested)) {
    code = requested;
    days = Number(requested.slice(0,-1));
    start = new Date(asOf.getTime() - days * 86400000);
  } else if (requested !== 'current_week') {
    throw Object.assign(new Error('period must be current_week, 1d, 7d, or 30d'), { status:400 });
  }
  const duration = Math.max(0,asOf.getTime()-start.getTime());
  return {
    code,days,asOf:asOf.toISOString(),periodStart:start.toISOString(),periodEnd:asOf.toISOString(),
    previousPeriodStart:new Date(start.getTime()-duration).toISOString(),previousPeriodEnd:start.toISOString(),
    timeZone:SCHEDULE_TIME_ZONE,scheduleWeek,
  };
}

function buildCallCenterContract(input = {}) {
  const period = input.period;
  const now = validDate(input.now || period?.asOf || new Date());
  const availability = { users:'available',schedules:'available',performanceActivity:'available',weekActivity:'available',calls:'available',appointments:'available',appointmentYield:'available',leads:'available',poolRules:'available',...(input.availability||{}) };
  const users = input.users || [];
  const schedules = indexBy(input.schedules,'userId');
  const performanceActivity = indexBy(input.performanceActivity,'userId');
  const weekActivity = indexBy(input.weekActivity,'userId');
  const calls = indexBy(input.calls,'userId');
  const appointments = indexBy(input.appointments,'userId');
  const appointmentYield = indexBy(input.appointmentYield,'userId');
  const rules = normalizeRules(input.rules || [],input.locationId);
  const statusRules = new Map(rules.flatMap((rule)=>rule.statusValues.map((status)=>[String(status),rule])));
  const poolState = buildPoolState(input.leadGroups || [],rules,statusRules);
  const assignmentByUser = poolState.assignmentByUser;

  const agents = users.map((user) => {
    const id = String(user.id);
    const schedule = schedules.get(id) || {};
    const activity = performanceActivity.get(id) || {};
    const currentWeek = weekActivity.get(id) || {};
    const call = calls.get(id) || {};
    const appointment = appointments.get(id) || {};
    const yieldEvidence = appointmentYield.get(id) || {};
    const scheduleData = parseJson(schedule.scheduleData);
    const scheduleState = !scheduleData ? 'missing' : schedule.submittedAt ? 'submitted' : 'draft';
    const expectedMinutes = scheduleState === 'submitted' ? calculateExpectedMinutesElapsed(scheduleData,now) : 0;
    const weekVerifiedMinutes = number(currentWeek.verifiedMinutes);
    const verifiedMinutes = number(activity.verifiedMinutes);
    const engagedMinutes = number(activity.engagedMinutes);
    const confirmedCalls = number(call.confirmedCalls);
    const eligibleLeadsWorked = number(call.eligibleLeadsWorked);
    const appointmentsFromWorkedLeads = number(yieldEvidence.appointmentsFromWorkedLeads);
    const isWorkingNow = Boolean(currentWeek.lastHeartbeat && now.getTime()-new Date(currentWeek.lastHeartbeat).getTime() <= CALL_CENTER_WORKING_NOW_SECONDS*1000);
    const attendanceAvailable = availability.weekActivity === 'available' && scheduleState === 'submitted' && expectedMinutes > 0;
    const activityAvailable = availability.performanceActivity === 'available';
    const callsAvailable = availability.calls === 'available';
    return {
      userId:id,username:user.username||null,displayName:user.crmUserName||user.username||id,role:user.role||null,
      isWorkingNow,lastHeartbeat:currentWeek.lastHeartbeat||null,
      schedule:{ state:scheduleState,submittedAt:schedule.submittedAt||null,scheduledMinutes:number(schedule.scheduledMinutes),expectedMinutes,verifiedMinutes:weekVerifiedMinutes },
      workload:{ activeAssigned:number(assignmentByUser.get(id)),contactsEngaged:number(activity.contactsWorked) },
      performance:{ verifiedMinutes,engagedMinutes,confirmedCalls,authorizationIntents:number(call.authorizationIntents),eligibleLeadsWorked,appointmentsBooked:number(appointment.appointmentsBooked),appointmentsFromWorkedLeads },
      metrics:{
        attendance_rate:metric('call_center_attendance_rate',attendanceAvailable?rate(weekVerifiedMinutes,expectedMinutes):null,period,{numerator:attendanceAvailable?weekVerifiedMinutes:null,denominator:attendanceAvailable?expectedMinutes:null,status:attendanceAvailable?'available':'unavailable',statusReason:attendanceAvailable?null:scheduleState!=='submitted'?'A submitted current-week schedule is required.':'No elapsed scheduled minutes are available.'}),
        engagement_rate:metric('call_center_engagement_rate',activityAvailable?rate(engagedMinutes,verifiedMinutes):null,period,{numerator:activityAvailable?engagedMinutes:null,denominator:activityAvailable?verifiedMinutes:null,status:activityAvailable&&verifiedMinutes>0?'available':'unavailable',statusReason:verifiedMinutes>0?null:'No verified activity minutes are available.'}),
        calls_per_verified_hour:metric('call_center_calls_per_verified_hour',activityAvailable&&callsAvailable?perHour(confirmedCalls,verifiedMinutes):null,period,{numerator:confirmedCalls,denominator:verifiedMinutes/60,status:activityAvailable&&callsAvailable&&verifiedMinutes>0?'available':'unavailable',statusReason:verifiedMinutes>0?null:'No verified activity-hour denominator is available.'}),
        appointment_yield:metric('call_center_appointment_yield',callsAvailable&&availability.appointmentYield==='available'?rate(appointmentsFromWorkedLeads,eligibleLeadsWorked):null,period,{numerator:appointmentsFromWorkedLeads,denominator:eligibleLeadsWorked,status:callsAvailable&&availability.appointmentYield==='available'&&eligibleLeadsWorked>0?'partial':'unavailable',statusReason:callsAvailable&&availability.appointmentYield==='available'&&eligibleLeadsWorked>0?CALL_CENTER_ELIGIBILITY.limitation:'No eligible worked-lead and appointment denominator is available.'}),
      },
      stewardshipRisk:{ status:'not_assessed',minimumSample:CALL_CENTER_MINIMUM_SAMPLE,reason:'No lead-stewardship classification is produced until approved targets, service/source normalization, and minimum-sample governance are configured.' },
    };
  });

  const roster = agents.length;
  const submitted = agents.filter((row)=>row.schedule.state==='submitted');
  const submittedMinutes = sum(submitted,(row)=>row.schedule.scheduledMinutes);
  const verifiedMinutes = sum(agents,(row)=>row.performance.verifiedMinutes);
  const engagedMinutes = sum(agents,(row)=>row.performance.engagedMinutes);
  const weekExpectedMinutes = sum(submitted,(row)=>row.schedule.expectedMinutes);
  const submittedVerifiedMinutes = sum(submitted,(row)=>row.schedule.verifiedMinutes);
  const confirmedCalls = sum(input.calls||[],(row)=>number(row.confirmedCalls));
  const attributedConfirmedCalls = sum((input.calls||[]).filter((row)=>row.userId),(row)=>number(row.confirmedCalls));
  const authorizationIntents = sum(input.calls||[],(row)=>number(row.authorizationIntents));
  const eligibleLeadsWorked = sum(agents,(row)=>row.performance.eligibleLeadsWorked);
  const appointmentsFromWorkedLeads = sum(agents,(row)=>row.performance.appointmentsFromWorkedLeads);
  const appointmentsBooked = sum(input.appointments||[],(row)=>number(row.appointmentsBooked));
  const scheduleAvailable = availability.users==='available'&&availability.schedules==='available';
  const activityAvailable = availability.performanceActivity==='available';
  const weekActivityAvailable = availability.weekActivity==='available';
  const callsAvailable = availability.calls==='available';
  const appointmentsAvailable = availability.appointments==='available';
  const appointmentYieldAvailable = availability.appointmentYield==='available';
  const leadsAvailable = availability.leads==='available';
  const metrics = {
    call_center_roster_users:metric('call_center_roster_users',availability.users==='available'?roster:null,period,{status:availability.users==='available'?'available':'unavailable'}),
    call_center_working_now:metric('call_center_working_now',weekActivityAvailable?agents.filter((row)=>row.isWorkingNow).length:null,period,{denominator:roster,status:weekActivityAvailable?'available':'unavailable'}),
    call_center_schedule_submission_rate:metric('call_center_schedule_submission_rate',scheduleAvailable?rate(submitted.length,roster):null,period,{numerator:submitted.length,denominator:roster,status:scheduleAvailable&&roster>0?'available':'unavailable',statusReason:roster?null:'No roster users are available.'}),
    call_center_submitted_hours:metric('call_center_submitted_hours',scheduleAvailable?hours(submittedMinutes):null,period,{numerator:submittedMinutes,status:scheduleAvailable?'available':'unavailable'}),
    call_center_verified_hours:metric('call_center_verified_hours',activityAvailable?hours(verifiedMinutes):null,period,{numerator:verifiedMinutes,status:activityAvailable?'available':'unavailable'}),
    call_center_attendance_rate:metric('call_center_attendance_rate',weekActivityAvailable&&scheduleAvailable?rate(submittedVerifiedMinutes,weekExpectedMinutes):null,period,{numerator:submittedVerifiedMinutes,denominator:weekExpectedMinutes,status:weekActivityAvailable&&scheduleAvailable&&weekExpectedMinutes>0?'available':'unavailable',statusReason:weekExpectedMinutes?null:'No elapsed submitted schedule minutes are available.'}),
    call_center_engagement_rate:metric('call_center_engagement_rate',activityAvailable?rate(engagedMinutes,verifiedMinutes):null,period,{numerator:engagedMinutes,denominator:verifiedMinutes,status:activityAvailable&&verifiedMinutes>0?'available':'unavailable',statusReason:verifiedMinutes?null:'No verified activity minutes are available.'}),
    call_center_confirmed_calls:metric('call_center_confirmed_calls',callsAvailable?confirmedCalls:null,period,{status:callsAvailable?'available':'unavailable'}),
    call_center_call_attribution_rate:metric('call_center_call_attribution_rate',callsAvailable?rate(attributedConfirmedCalls,confirmedCalls):null,period,{numerator:attributedConfirmedCalls,denominator:confirmedCalls,status:callsAvailable&&confirmedCalls>0?'available':'unavailable',statusReason:confirmedCalls?null:'No CRM-confirmed calls are available.'}),
    call_center_calls_per_verified_hour:metric('call_center_calls_per_verified_hour',callsAvailable&&activityAvailable?perHour(confirmedCalls,verifiedMinutes):null,period,{numerator:confirmedCalls,denominator:verifiedMinutes/60,status:callsAvailable&&activityAvailable&&verifiedMinutes>0?'available':'unavailable',statusReason:verifiedMinutes?null:'No verified activity-hour denominator is available.'}),
    call_center_eligible_leads_worked:metric('call_center_eligible_leads_worked',callsAvailable?eligibleLeadsWorked:null,period,{status:callsAvailable?'partial':'unavailable',statusReason:callsAvailable?CALL_CENTER_ELIGIBILITY.limitation:'CRM-confirmed call evidence is unavailable.'}),
    call_center_appointments_booked:metric('call_center_appointments_booked',appointmentsAvailable?appointmentsBooked:null,period,{status:appointmentsAvailable?'available':'unavailable'}),
    call_center_appointment_yield:metric('call_center_appointment_yield',callsAvailable&&appointmentYieldAvailable?rate(appointmentsFromWorkedLeads,eligibleLeadsWorked):null,period,{numerator:appointmentsFromWorkedLeads,denominator:eligibleLeadsWorked,status:callsAvailable&&appointmentYieldAvailable&&eligibleLeadsWorked>0?'partial':'unavailable',statusReason:callsAvailable&&appointmentYieldAvailable&&eligibleLeadsWorked>0?CALL_CENTER_ELIGIBILITY.limitation:'No eligible worked-lead and appointment denominator is available.'}),
    call_center_available_leads:metric('call_center_available_leads',leadsAvailable?poolState.availableLeads:null,period,{status:leadsAvailable?'available':'unavailable'}),
    call_center_active_assignment_load:metric('call_center_active_assignment_load',leadsAvailable?poolState.activeAssigned:null,period,{status:leadsAvailable?'available':'unavailable'}),
  };

  return {
    contractVersion:CALL_CENTER_CONTRACT_VERSION,metricDefinitionVersion:CALL_CENTER_METRIC_VERSION,
    scope:{ apiKeyId:input.apiKeyId,integrationId:input.integrationId,locationId:input.locationId,asOf:period.asOf,performancePeriod:{code:period.code,start:period.periodStart,end:period.periodEnd},scheduleWeek:period.scheduleWeek,timeZone:period.timeZone },
    definitions:CALL_CENTER_METRIC_DEFINITIONS,eligibility:CALL_CENTER_ELIGIBILITY,minimumSample:CALL_CENTER_MINIMUM_SAMPLE,
    metrics,summary:{ rosterUsers:roster,workingNow:agents.filter((row)=>row.isWorkingNow).length,submittedSchedules:submitted.length,draftSchedules:agents.filter((row)=>row.schedule.state==='draft').length,missingSchedules:agents.filter((row)=>row.schedule.state==='missing').length,authorizationIntents },
    evidence:{
      schedules:evidence(availability.schedules,'Current-week schedule ledger','Draft and missing schedules are not counted as submitted hours.'),
      activity:evidence(availability.performanceActivity,'Verified dialer activity minutes','Verified time is activity-supported and is not equivalent to raw clocked-in duration.'),
      calls:{...evidence(availability.calls,'CRM call-event ledger','Dialer authorization intents are excluded from confirmed-call metrics.'),confirmedCalls,attributedConfirmedCalls,authorizationIntents,attributionRate:rate(attributedConfirmedCalls,confirmedCalls)},
      appointments:evidence(availability.appointments,'DiveDeep appointment ledger','Appointments created outside the local appointment API may not be represented.'),
      leadEligibility:{status:callsAvailable?'partial':'unavailable',source:'Current lead state joined to CRM-confirmed calls',limitation:CALL_CENTER_ELIGIBILITY.limitation},
      pools:evidence(availability.poolRules,'Governed OWL lifecycle rules','In-memory required defaults are used when no stored rules exist.'),
    },
    pools:{ lifecycle:poolState.lifecycle,services:poolState.services,reconciliation:poolState.reconciliation },
    agents,
    stewardship:{ status:'not_assessed',reason:'Phase 1 intentionally defines but does not score lead stewardship. Approved targets and normalized comparison cohorts are required first.' },
  };
}

async function getCallCenter(input = {}, pool = null, now = new Date()) {
  const p = pool || getPool();
  const apiKeyId = required(input.apiKeyId,'apiKeyId');
  const integrationId = required(input.integrationId,'integrationId');
  const integration = await getAuthorizedIntegration(integrationId,apiKeyId,'allow_read',p);
  const locationId = String(integration.location_id || '');
  if (!locationId) throw Object.assign(new Error('CRM integration has no location'), { status:409 });
  const period = buildCallCenterPeriod(input,now);
  let rules;
  let poolRulesStatus = 'available';
  try { rules = await listPoolRules(p,'core',locationId,{ensureDefaults:false}); }
  catch (error) { if (!optionalEvidenceError(error)) throw error; rules=[]; poolRulesStatus='unavailable'; }
  if (!rules.length) { rules=normalizeRules([],locationId); poolRulesStatus='partial'; }
  const protectedStatuses = [...new Set(rules.filter((rule)=>['dnc_pending','no_phone','dnc','invalid'].includes(rule.poolKey)).flatMap((rule)=>rule.statusValues))];
  if (!protectedStatuses.length) protectedStatuses.push('dnc_pending','pending_dnc','dnd','no_phone','do_not_call','dnc','invalid');
  const placeholders = protectedStatuses.map(()=>'?').join(',');
  const query = (name,sql,params)=>safeRows(p,name,sql,params);
  const [users,schedules,performanceActivity,weekActivity,calls,appointments,appointmentYield,leadGroups] = await Promise.all([
    query('users',`SELECT id,username,crmUserName,role FROM users WHERE locationId=? ORDER BY username,id`,[locationId]),
    query('schedules',`SELECT userId,scheduleData,scheduledMinutes,submittedAt,updatedAt FROM user_schedule_weeks WHERE locationId=? AND weekStart=?`,[locationId,period.scheduleWeek.weekStart]),
    query('performanceActivity',`SELECT user_id AS userId,COUNT(*) AS verifiedMinutes,SUM(crm_contact_id IS NOT NULL) AS engagedMinutes,COUNT(DISTINCT crm_contact_id) AS contactsWorked,MAX(activity_minute) AS lastHeartbeat FROM dialer_activity_minutes WHERE location_id=? AND activity_minute>=? AND activity_minute<=? GROUP BY user_id`,[locationId,sqlDate(period.periodStart),sqlDate(period.periodEnd)]),
    query('weekActivity',`SELECT user_id AS userId,COUNT(*) AS verifiedMinutes,SUM(crm_contact_id IS NOT NULL) AS engagedMinutes,COUNT(DISTINCT crm_contact_id) AS contactsWorked,MAX(activity_minute) AS lastHeartbeat FROM dialer_activity_minutes WHERE location_id=? AND activity_minute>=? AND activity_minute<=? GROUP BY user_id`,[locationId,sqlDate(period.scheduleWeek.deadlineAt),sqlDate(period.periodEnd)]),
    query('calls',`SELECT a.user_id AS userId,COUNT(DISTINCT CASE WHEN a.source='crm' THEN a.id END) AS confirmedCalls,COUNT(DISTINCT CASE WHEN a.source='dialer' THEN a.id END) AS authorizationIntents,COUNT(DISTINCT CASE WHEN a.source='crm' AND l.dncStatus='clean' AND l.status NOT IN (${placeholders}) THEN a.lead_id END) AS eligibleLeadsWorked FROM lead_call_attempts a LEFT JOIN leads l ON l.id=a.lead_id AND l.locationId=a.location_id WHERE a.location_id=? AND a.direction='outbound' AND a.occurred_at>=? AND a.occurred_at<=? GROUP BY a.user_id`,[...protectedStatuses,locationId,sqlDate(period.periodStart),sqlDate(period.periodEnd)]),
    query('appointments',`SELECT userId,COUNT(*) AS appointmentsBooked,COUNT(DISTINCT leadId) AS appointmentLeads FROM appointments WHERE locationId=? AND createdAt>=? AND createdAt<=? GROUP BY userId`,[locationId,sqlDate(period.periodStart),sqlDate(period.periodEnd)]),
    query('appointmentYield',`SELECT a.user_id AS userId,COUNT(DISTINCT CASE WHEN l.dncStatus='clean' AND l.status NOT IN (${placeholders}) THEN ap.leadId END) AS appointmentsFromWorkedLeads FROM lead_call_attempts a INNER JOIN leads l ON l.id=a.lead_id AND l.locationId=a.location_id INNER JOIN appointments ap ON ap.locationId=a.location_id AND ap.userId=a.user_id AND ap.leadId=a.lead_id AND ap.createdAt>=? AND ap.createdAt<=? WHERE a.location_id=? AND a.source='crm' AND a.direction='outbound' AND a.occurred_at>=? AND a.occurred_at<=? GROUP BY a.user_id`,[...protectedStatuses,sqlDate(period.periodStart),sqlDate(period.periodEnd),locationId,sqlDate(period.periodStart),sqlDate(period.periodEnd)]),
    query('leads',`SELECT COALESCE(NULLIF(serviceType,''),'Other') AS serviceType,status,assignedTo,dncStatus,COUNT(*) AS total,MIN(dateAdded) AS oldestLead,MAX(lastContacted) AS lastContacted FROM leads WHERE locationId=? GROUP BY serviceType,status,assignedTo,dncStatus`,[locationId]),
  ]);
  return buildCallCenterContract({
    apiKeyId,integrationId,locationId,period,now,rules,
    users:users.rows,schedules:schedules.rows,performanceActivity:performanceActivity.rows,weekActivity:weekActivity.rows,
    calls:calls.rows,appointments:appointments.rows,appointmentYield:appointmentYield.rows,leadGroups:leadGroups.rows,
    availability:{ users:users.status,schedules:schedules.status,performanceActivity:performanceActivity.status,weekActivity:weekActivity.status,calls:calls.status,appointments:appointments.status,appointmentYield:appointmentYield.status,leads:leadGroups.status,poolRules:poolRulesStatus },
  });
}

function buildPoolState(rows,rules,statusRules) {
  const lifecycleMap = new Map(rules.map((rule)=>[rule.poolKey,{...rule,total:0,assigned:0,unassigned:0,oldestLead:null}]));
  const serviceMap = new Map();
  const assignmentByUser = new Map();
  let availableLeads=0;let activeAssigned=0;let sourceTotal=0;let unmappedTotal=0;
  for (const row of rows) {
    const total=number(row.total);sourceTotal+=total;
    const rule=statusRules.get(String(row.status));
    const key=rule?.poolKey||'unmapped';
    if(!lifecycleMap.has(key))lifecycleMap.set(key,{poolKey:'unmapped',label:'Unmapped',statusValues:[],destinationStatus:null,assignmentPolicy:null,isAssignable:false,isTerminal:false,color:'#64748b',sortOrder:9999,isEnabled:true,total:0,assigned:0,unassigned:0,oldestLead:null});
    const lifecycle=lifecycleMap.get(key);lifecycle.total+=total;
    if(row.assignedTo){lifecycle.assigned+=total;assignmentByUser.set(String(row.assignedTo),number(assignmentByUser.get(String(row.assignedTo)))+total);}else lifecycle.unassigned+=total;
    lifecycle.oldestLead=earliest(lifecycle.oldestLead,row.oldestLead);
    const isAvailable=Boolean(rule?.isEnabled&&rule.isAssignable&&!row.assignedTo&&String(row.dncStatus)==='clean');
    const isActiveAssigned=Boolean(row.assignedTo&&rule?.isEnabled&&!rule.isTerminal);
    if(isAvailable)availableLeads+=total;if(isActiveAssigned)activeAssigned+=total;if(!rule)unmappedTotal+=total;
    const service=String(row.serviceType||'Other');
    if(!serviceMap.has(service))serviceMap.set(service,{serviceType:service,total:0,available:0,assigned:0,working:0,scheduled:0,terminal:0,oldestUnworked:null});
    const item=serviceMap.get(service);item.total+=total;if(isAvailable){item.available+=total;item.oldestUnworked=earliest(item.oldestUnworked,row.oldestLead);}if(row.assignedTo)item.assigned+=total;if(rule?.poolKey==='working')item.working+=total;if(rule?.poolKey==='scheduled')item.scheduled+=total;if(rule?.isTerminal)item.terminal+=total;
  }
  const lifecycle=[...lifecycleMap.values()].filter((row)=>row.total>0||row.poolKey!=='unmapped').sort((a,b)=>a.sortOrder-b.sortOrder||a.label.localeCompare(b.label));
  const services=[...serviceMap.values()].sort((a,b)=>b.total-a.total||a.serviceType.localeCompare(b.serviceType));
  return { availableLeads,activeAssigned,assignmentByUser,lifecycle,services,reconciliation:{sourceTotal,lifecycleTotal:sum(lifecycle,(row)=>row.total),serviceTotal:sum(services,(row)=>row.total),unmappedTotal,reconciled:sourceTotal===sum(lifecycle,(row)=>row.total)&&sourceTotal===sum(services,(row)=>row.total)} };
}

function normalizeRules(rules,locationId) {
  const values=rules.length?rules:DEFAULT_POOL_RULES.map((rule)=>({...rule,source:'core',locationId}));
  return values.map((rule)=>({...rule,statusValues:Array.isArray(rule.statusValues)?rule.statusValues.map(String):[],isEnabled:rule.isEnabled!==false,isAssignable:Boolean(rule.isAssignable),isTerminal:Boolean(rule.isTerminal),sortOrder:number(rule.sortOrder)}));
}

function calculateExpectedMinutesElapsed(scheduleData,now=new Date()) {
  const data=parseJson(scheduleData);if(!data||typeof data!=='object')return 0;
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:SCHEDULE_TIME_ZONE,weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(validDate(now)).map((part)=>[part.type,part.value]));
  const names=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const today=names.indexOf(String(parts.weekday||'').toLowerCase());if(today<0)return 0;
  const currentMinute=Number(parts.hour)*60+Number(parts.minute);const days=data.days&&typeof data.days==='object'?data.days:data;let elapsed=0;
  for(let index=0;index<=today;index+=1){const name=names[index];const value=days[name]??days[name.slice(0,3)]??days[name[0].toUpperCase()+name.slice(1)];const shifts=Array.isArray(value)?value:value?[value]:[];for(const shift of shifts){if(!shift||typeof shift!=='object')continue;if(Number.isFinite(Number(shift.minutes))){if(index<today)elapsed+=Math.max(0,Math.round(Number(shift.minutes)));continue;}const start=clockMinute(shift.start||shift.startTime);const end=clockMinute(shift.end||shift.endTime);if(start==null||end==null)continue;const normalizedEnd=end>=start?end:end+1440;const effectiveNow=index<today?normalizedEnd:Math.min(Math.max(currentMinute,start),normalizedEnd);const raw=Math.max(0,effectiveNow-start);const total=Math.max(1,normalizedEnd-start);const breakShare=Math.round(Math.max(0,Number(shift.breakMinutes)||0)*raw/total);elapsed+=Math.max(0,raw-breakShare);}}
  return elapsed;
}

function metric(metricId,value,period,options={}) { const definitionValue=CALL_CENTER_METRIC_DEFINITIONS.find((item)=>item.metricId===metricId);const available=value!=null&&Number.isFinite(Number(value));return {...definitionValue,status:options.status||(available?'available':'unavailable'),statusReason:options.statusReason||null,value:available?Number(value):null,numerator:options.numerator==null?null:Number(options.numerator),denominator:options.denominator==null?null:Number(options.denominator),asOf:period.asOf,periodStart:definitionValue.timeBasis==='current_schedule_week'?period.scheduleWeek.deadlineAt:period.periodStart,periodEnd:period.periodEnd}; }
function evidence(status,source,limitation){return {status:['available','partial'].includes(status)?status:'unavailable',source,limitation};}
async function safeRows(pool,name,sql,params){try{const [rows]=await pool.query(sql,params);return {name,status:'available',rows};}catch(error){if(!optionalEvidenceError(error))throw error;return {name,status:'unavailable',rows:[],reason:error.message};}}
function optionalEvidenceError(error){return ['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR','ER_TABLEACCESS_DENIED_ERROR','ER_DBACCESS_DENIED_ERROR'].includes(error?.code);}
function indexBy(rows,key){return new Map((rows||[]).filter((row)=>row[key]!=null).map((row)=>[String(row[key]),row]));}
function parseJson(value){if(!value)return null;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return null;}}
function validDate(value){const date=value instanceof Date?value:new Date(value);if(Number.isNaN(date.getTime()))throw Object.assign(new Error('Invalid Call Center report time'),{status:400});return date;}
function sqlDate(value){return new Date(value).toISOString().slice(0,23).replace('T',' ');}
function clockMinute(value){const match=String(value||'').trim().match(/^(\d{1,2}):(\d{2})$/);if(!match||Number(match[1])>23||Number(match[2])>59)return null;return Number(match[1])*60+Number(match[2]);}
function number(value){const result=Number(value);return Number.isFinite(result)?result:0;}
function sum(rows,selector){return (rows||[]).reduce((total,row)=>total+number(selector(row)),0);}
function rate(value,total){return Number(total)>0?Math.round(number(value)/Number(total)*1000)/10:null;}
function perHour(value,minutes){return Number(minutes)>0?Math.round(number(value)/(Number(minutes)/60)*100)/100:null;}
function hours(minutes){return Math.round(number(minutes)/60*10)/10;}
function earliest(left,right){if(!left)return right||null;if(!right)return left;return new Date(left)<=new Date(right)?left:right;}
function required(value,label){const text=String(value||'').trim();if(!text)throw Object.assign(new Error(`${label} is required`),{status:400});return text;}

module.exports={CALL_CENTER_CONTRACT_VERSION,CALL_CENTER_METRIC_VERSION,CALL_CENTER_METRIC_DEFINITIONS,CALL_CENTER_MINIMUM_SAMPLE,CALL_CENTER_ELIGIBILITY,buildCallCenterPeriod,calculateExpectedMinutesElapsed,buildCallCenterContract,getCallCenter};
