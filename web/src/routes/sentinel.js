const express = require('express');
const path = require('path');
const { ROOT } = require('../config');
const { requireAdminSession, requireAdminRole, requireRootRole, principalType } = require('../middleware/sessionAuth');
const { listEvents, purgeOldEvents } = require('../services/sentinel');
const {
  listLoginEvents,
  getLoginSummary,
  purgeOldLoginEvents,
} = require('../services/loginSecurity');
const {
  computeThreats,
  getPostureBundle,
  getTimeline,
  getInvestigationProfile,
} = require('../services/sentinelThreats');
const {
  listBlocks,
  createBlock,
  revokeBlock,
  normalizeIp,
} = require('../services/sentinelBlocks');
const {
  listCases,
  getCaseOperationsReport,
  getCaseById,
  listActions,
  listNotes,
  listStatusHistory,
  transitionCase,
  transitionCaseLifecycle,
  setCaseNote,
  assignCaseOwner,
  countOpenCases,
  recordAction,
} = require('../services/sentinelCases');
const {
  listRules,
  createRule,
  updateRule,
  deleteRule,
} = require('../services/sentinelRules');
const { listNewAuthFailIps } = require('../services/sentinelSightings');
const { lookupIpIntel } = require('../services/sentinelIntel');
const {
  revealForensicEvidence,
  listForensicAccess,
  purgeExpiredForensics,
} = require('../services/sentinelForensics');
const { buildDailySocReport, formatDailySocMarkdown } = require('../services/sentinelReports');
const {
  createValidationRun,listValidationRuns,getValidationRun,setValidationRunStatus,
  recordValidationObservation,evaluateValidationRun,mapRuleTechnique,getValidationCoverage,
} = require('../services/sentinelValidation');
const { runDailyProtectionRoutine,listRoutineRuns }=require('../services/sentinelRoutines');
const {getSentinelControlHealth}=require('../services/sentinelHealth');
const {listRetentionPolicies,saveRetentionPolicy,previewRetention,executeRetention}=require('../services/sentinelRetention');
const {createFindingDisposition,listFindingDispositions,revokeFindingDisposition}=require('../services/sentinelFindingDispositions');
const {listPlaybooks,getPlaybook,startManualRun,getRun,listRuns,completeStep,cancelRun,createPlaybookDraft,transitionPlaybook}=require('../services/sentinelPlaybooks');
const {previewPlaybook,dryRunPlaybook,listSimulations}=require('../services/sentinelPlaybookActions');
const {getCaseResponseWorkspace,startCasePlaybook}=require('../services/sentinelPlaybookRecommendations');
const {recordValidation,getPlaybookValidation}=require('../services/sentinelPlaybookValidation');
const {listResources,getResource,reviewResource,createInternalResource}=require('../services/sentinelResources');

function adminId(req) {
  return (req.session && req.session.admin && req.session.admin.id) || null;
}

function sentinelNoStore(req, res, next) {
  if (/^\/(?:api\/sentinel(?:\/|$)|sentinel\/?$)/.test(req.path || '')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
}

function createSentinelRouter() {
  const router = express.Router();
  router.use(sentinelNoStore);
  router.use(requireAdminSession);

  router.get('/sentinel', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'sentinel.html'));
  });

  router.get('/api/sentinel/summary', requireAdminRole, async (req, res) => {
    try {
      const hours = req.query.hours || 24;
      const bundle = await getPostureBundle({ sinceHours: hours });
      res.json({
        ok: true,
        sinceHours: bundle.sinceHours,
        posture: bundle.posture,
        summary: bundle.apiSummary,
        loginSummary: bundle.loginSummary,
        threats: bundle.threats,
        response: bundle.response,
        comparison: bundle.comparison,
        freshness: bundle.freshness,
      });
    } catch (err) {
      console.error('sentinel summary', err);
      res.status(500).json({ error: 'Error' });
    }
  });
  router.get('/api/sentinel/resources',requireAdminRole,async(req,res)=>{try{res.json({ok:true,resources:await listResources({itemType:req.query.itemType,status:req.query.status,priority:req.query.priority,q:req.query.q,limit:req.query.limit})});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/resources',requireRootRole,async(req,res)=>{try{res.status(201).json({ok:true,resource:await createInternalResource(req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.get('/api/sentinel/resources/:id',requireAdminRole,async(req,res)=>{try{res.json({ok:true,resource:await getResource(req.params.id)});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/resources/:id/review',requireAdminRole,async(req,res)=>{try{res.json({ok:true,resource:await reviewResource(req.params.id,req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});

  router.get('/api/sentinel/playbooks',requireAdminRole,async(req,res)=>{try{res.json({ok:true,playbooks:await listPlaybooks({status:req.query.status})});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/playbooks',requireAdminRole,async(req,res)=>{try{res.status(201).json({ok:true,playbook:await createPlaybookDraft(req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.get('/api/sentinel/playbooks/runs',requireAdminRole,async(req,res)=>{try{res.json({ok:true,runs:await listRuns({limit:req.query.limit})});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.get('/api/sentinel/playbooks/simulations',requireAdminRole,async(req,res)=>{try{res.json({ok:true,simulations:await listSimulations({limit:req.query.limit})});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.get('/api/sentinel/playbooks/runs/:id',requireAdminRole,async(req,res)=>{try{res.json({ok:true,run:await getRun(req.params.id)});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/playbooks/runs/:id/steps/:stepId',requireAdminRole,async(req,res)=>{try{res.json({ok:true,run:await completeStep(req.params.id,req.params.stepId,req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/playbooks/runs/:id/cancel',requireAdminRole,async(req,res)=>{try{res.json({ok:true,run:await cancelRun(req.params.id,req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/playbooks/:id/submit',requireAdminRole,async(req,res)=>{try{res.json({ok:true,playbook:await transitionPlaybook(req.params.id,{toStatus:'peer_review',reason:req.body?.reason},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/playbooks/:id/governance',requireRootRole,async(req,res)=>{try{res.json({ok:true,playbook:await transitionPlaybook(req.params.id,req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/playbooks/:id/preview',requireAdminRole,async(req,res)=>{try{res.json({ok:true,simulation:await previewPlaybook(req.params.id,req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/playbooks/:id/dry-run',requireAdminRole,async(req,res)=>{try{res.json({ok:true,simulation:await dryRunPlaybook(req.params.id,req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.get('/api/sentinel/playbooks/:id',requireAdminRole,async(req,res)=>{try{const playbook=await getPlaybook(req.params.id);playbook.validation=await getPlaybookValidation(playbook.id,playbook.currentVersionId);res.json({ok:true,playbook});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/playbooks/:id/validation',requireAdminRole,async(req,res)=>{try{res.json({ok:true,validation:await recordValidation(req.params.id,req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});
  router.post('/api/sentinel/playbooks/:id/runs',requireAdminRole,async(req,res)=>{try{res.status(201).json({ok:true,run:await startManualRun(req.params.id,req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});

  router.get('/api/sentinel/reports/daily', requireAdminRole, async (req, res) => {
    try {
      const report = await buildDailySocReport({ sinceHours:req.query.hours || 24 });
      if (req.query.format === 'markdown') {
        res.type('text/markdown').send(formatDailySocMarkdown(report));
        return;
      }
      res.json({ ok:true, report, markdown:formatDailySocMarkdown(report) });
    } catch (err) {
      res.status(500).json({ error:'Error' });
    }
  });
  router.get('/api/sentinel/routines/daily',requireAdminRole,async(req,res)=>{
    try{res.json({ok:true,runs:await listRoutineRuns({limit:req.query.limit})});}catch{res.status(500).json({error:'Error'});}
  });
  router.post('/api/sentinel/routines/daily',requireAdminRole,async(req,res)=>{
    try{res.json({ok:true,...await runDailyProtectionRoutine({hours:req.body?.hours||24,force:req.body?.force===true},adminId(req))});}
    catch(err){res.status(500).json({error:err.message||'Routine failed'});}
  });

  router.get('/api/sentinel/validation/coverage', requireAdminRole, async (req,res) => {
    try { res.json({ ok:true,coverage:await getValidationCoverage({ sinceDays:req.query.days }) }); }
    catch { res.status(500).json({ error:'Error' }); }
  });
  router.get('/api/sentinel/validation/runs', requireAdminRole, async (req,res) => {
    try { res.json({ ok:true,runs:await listValidationRuns({ limit:req.query.limit }) }); }
    catch { res.status(500).json({ error:'Error' }); }
  });
  router.post('/api/sentinel/validation/runs', requireAdminRole, async (req,res) => {
    try { res.status(201).json({ ok:true,run:await createValidationRun(req.body||{},adminId(req)) }); }
    catch(err) { res.status(err.status||500).json({ error:err.message||'Error' }); }
  });
  router.get('/api/sentinel/validation/runs/:id', requireAdminRole, async (req,res) => {
    try { const run=await getValidationRun(req.params.id); if(!run)return res.status(404).json({error:'Validation run not found'}); res.json({ok:true,run}); }
    catch { res.status(500).json({ error:'Error' }); }
  });
  router.post('/api/sentinel/validation/runs/:id/status', requireAdminRole, async (req,res) => {
    try { res.json({ok:true,run:await setValidationRunStatus(req.params.id,req.body?.status,adminId(req))}); }
    catch(err) { res.status(err.status||500).json({error:err.message||'Error'}); }
  });
  router.post('/api/sentinel/validation/runs/:id/observations', requireAdminRole, async (req,res) => {
    try { res.status(201).json({ok:true,run:await recordValidationObservation(req.params.id,req.body||{},adminId(req))}); }
    catch(err) { res.status(err.status||500).json({error:err.message||'Error'}); }
  });
  router.post('/api/sentinel/validation/runs/:id/evaluate', requireAdminRole, async (req,res) => {
    try { res.json({ok:true,...await evaluateValidationRun(req.params.id,{
      createRemediation:req.body?.createRemediation===true,forceMissed:req.body?.forceMissed===true,
    },adminId(req))}); }
    catch(err) { res.status(err.status||500).json({error:err.message||'Error'}); }
  });
  router.post('/api/sentinel/validation/rule-techniques', requireAdminRole, async (req,res) => {
    try { res.json({ok:true,mapping:await mapRuleTechnique(req.body||{},adminId(req))}); }
    catch(err) { res.status(err.status||500).json({error:err.message||'Error'}); }
  });

  router.get('/api/sentinel/events', requireAdminRole, async (req, res) => {
    try {
      const result = await listEvents({
        limit: req.query.limit,
        offset: req.query.offset,
        apiKeyId: req.query.apiKeyId,
        statusCode: req.query.status,
        pathContains: req.query.path,
        sinceHours: req.query.hours || 24,
        ip: req.query.ip,
        errorClass: req.query.errorClass,
        method: req.query.method,
        locationId: req.query.locationId,
        keyPrefix: req.query.keyPrefix,
        surface: req.query.surface,
        action: req.query.action,
        actorId: req.query.actorId,
        outcome: req.query.outcome,
        q: req.query.q,
      });
      res.json({ ok: true, events: result.events, total: result.total });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.get('/api/sentinel/capabilities', requireAdminRole, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({ ok: true, canRevealForensics: principalType(req.session.admin) === 'root' });
  });
  router.get('/api/sentinel/health',requireAdminRole,async(req,res)=>{
    try{res.json({ok:true,health:await getSentinelControlHealth()});}catch(err){res.status(500).json({error:'Control health check failed'});}
  });
  router.get('/api/sentinel/retention',requireAdminRole,async(req,res)=>{
    try{res.json({ok:true,policies:await listRetentionPolicies(),preview:await previewRetention()});}catch{res.status(500).json({error:'Retention preview failed'});}
  });
  router.put('/api/sentinel/retention/:dataClass',requireRootRole,async(req,res)=>{
    try{res.json({ok:true,policies:await saveRetentionPolicy({dataClass:req.params.dataClass,...(req.body||{})},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}
  });
  router.post('/api/sentinel/retention/execute',requireRootRole,async(req,res)=>{
    try{res.json({ok:true,result:await executeRetention(req.body||{},adminId(req))});}catch(err){res.status(err.status||500).json({error:err.message||'Error',code:err.code});}
  });

  router.post('/api/sentinel/events/:id/evidence', requireRootRole, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      const result = await revealForensicEvidence({
        eventId: req.params.id,
        admin: req.session.admin,
        reason: req.body?.reason,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Error', code: err.code });
    }
  });

  router.get('/api/sentinel/forensic-access', requireRootRole, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.json({ ok: true, access: await listForensicAccess({ limit: req.query.limit }) });
    } catch {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.get('/api/sentinel/logins', requireAdminRole, async (req, res) => {
    try {
      const result = await listLoginEvents({
        limit: req.query.limit,
        offset: req.query.offset,
        outcome: req.query.outcome,
        eventType: req.query.eventType,
        locationId: req.query.locationId,
        username: req.query.username,
        cursor: req.query.cursor,
        sinceHours: req.query.hours || 24,
        ip: req.query.ip,
        email: req.query.email,
        detail: req.query.detail,
        q: req.query.q,
        userId: req.query.userId,
      });
      res.json({ ok: true, logins: result.logins, total: result.total });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.get('/api/sentinel/investigations/entity', requireAdminRole, async (req, res) => {
    try {
      res.json({ ok:true, investigation:await getInvestigationProfile({
        entityType:req.query.entityType, entity:req.query.entity,
        sinceHours:req.query.hours || 24, cursor:req.query.cursor, limit:req.query.limit,
      }) });
    } catch (err) {
      res.status(err.status || 500).json({ error:err.status ? err.message : 'Error' });
    }
  });

  router.get('/api/sentinel/logins/summary', requireAdminRole, async (req, res) => {
    try {
      const loginSummary = await getLoginSummary({ sinceHours: req.query.hours || 24 });
      res.json({ ok: true, loginSummary });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.get('/api/sentinel/threats', requireAdminRole, async (req, res) => {
    try {
      const threats = await computeThreats({
        sinceHours: req.query.hours || 24,
        syncCases: req.query.sync !== '0',
      });
      res.json({ ok: true, threats });
    } catch (err) {
      console.error('sentinel threats', err);
      res.status(500).json({ error: 'Error' });
    }
  });

  router.post('/api/sentinel/threats/sync', requireAdminRole, async (req, res) => {
    try {
      const threats = await computeThreats({
        sinceHours: req.body?.hours || req.query.hours || 24,
        syncCases: true,
      });
      res.json({ ok: true, threats, caseSync: threats.caseSync });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });
  router.get('/api/sentinel/threats/dispositions',requireAdminRole,async(req,res)=>{
    try{res.json({ok:true,dispositions:await listFindingDispositions({activeOnly:req.query.all!=='1'})});}catch{res.status(500).json({error:'Error'});}
  });
  router.post('/api/sentinel/threats/dispositions',requireAdminRole,async(req,res)=>{
    try{const threats=await computeThreats({sinceHours:req.body?.hours||24,syncCases:false});const finding=(threats.findings||[]).find((item)=>item.id===req.body?.findingId);if(!finding)return res.status(404).json({error:'Active finding not found or already resolved'});const disposition=await createFindingDisposition(finding,req.body||{},adminId(req));res.status(201).json({ok:true,disposition});}
    catch(err){res.status(err.status||500).json({error:err.message||'Error'});}
  });
  router.delete('/api/sentinel/threats/dispositions/:id',requireAdminRole,async(req,res)=>{
    try{res.json({ok:true,...await revokeFindingDisposition(req.params.id,{adminId:adminId(req),reason:req.body?.reason})});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}
  });

  router.get('/api/sentinel/timeline', requireAdminRole, async (req, res) => {
    try {
      const timeline = await getTimeline({
        sinceHours: req.query.hours || 24,
        limit: req.query.limit,
        ip: req.query.ip,
        locationId: req.query.locationId,
        q: req.query.q,
        pathContains: req.query.path,
        username: req.query.username,
      });
      res.json({ ok: true, timeline });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  // ——— Blocks ———
  router.get('/api/sentinel/blocks', requireAdminRole, async (req, res) => {
    try {
      const activeOnly = req.query.all !== '1' && req.query.active !== '0';
      const result = await listBlocks({
        activeOnly,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.post('/api/sentinel/blocks', requireAdminRole, async (req, res) => {
    try {
      const body = req.body || {};
      const block = await createBlock({
        ip: body.ip,
        reason: body.reason,
        source: body.source || 'manual',
        caseId: body.caseId || body.case_id || null,
        expiresAt: body.expiresAt || body.expires_at || null,
        createdBy: adminId(req),
        cidr: body.cidr || null,
      });
      res.status(201).json({ ok: true, block });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.delete('/api/sentinel/blocks/:id', requireAdminRole, async (req, res) => {
    try {
      const block = await revokeBlock(req.params.id, {
        revokedBy: adminId(req),
        reason: (req.body && req.body.reason) || 'revoked by admin',
      });
      res.json({ ok: true, block });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  // ——— Cases / Review ———
  router.get('/api/sentinel/cases', requireAdminRole, async (req, res) => {
    try {
      const result = await listCases({
        status: req.query.status,
        severity: req.query.severity,
        owner: req.query.owner,
        disposition: req.query.disposition,
        sla: req.query.sla,
        q: req.query.q,
        limit: req.query.limit,
        offset: req.query.offset,
        openOnly: req.query.open === '1',
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.get('/api/sentinel/cases/operations', requireAdminRole, async (req, res) => {
    try {
      res.json({ ok:true, report:await getCaseOperationsReport({ sinceHours:req.query.hours || 24 }) });
    } catch (err) {
      res.status(500).json({ error:'Error' });
    }
  });

  router.get('/api/sentinel/cases/stats', requireAdminRole, async (req, res) => {
    try {
      const stats = await countOpenCases();
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.get('/api/sentinel/cases/:id', requireAdminRole, async (req, res) => {
    try {
      const c = await getCaseById(req.params.id);
      if (!c) return res.status(404).json({ error: 'Case not found' });
      const actions = await listActions(req.params.id);
      const notes = await listNotes(req.params.id);
      const statusHistory = await listStatusHistory(req.params.id);
      const response = await getCaseResponseWorkspace(c);
      let intel = null;
      if (c.entityType === 'ip' && c.entity) {
        try {
          intel = await lookupIpIntel(c.entity);
        } catch {
          intel = null;
        }
      }
      res.json({ ok: true, case: c, actions, notes, statusHistory, intel, response });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.post('/api/sentinel/cases/:id/playbooks/:playbookId/runs',requireAdminRole,async(req,res)=>{try{const c=await getCaseById(req.params.id);if(!c)return res.status(404).json({error:'Case not found'});const run=await startCasePlaybook(c,req.params.playbookId,req.body||{},adminId(req));await recordAction(c.id,'playbook_started',{adminId:adminId(req),detail:`${run.playbookName} v${run.version} · run ${run.id}`});res.status(201).json({ok:true,run});}catch(err){res.status(err.status||500).json({error:err.message||'Error'});}});

  router.post('/api/sentinel/cases/:id/review', requireAdminRole, async (req, res) => {
    try {
      const c = await transitionCase(req.params.id, 'under_review', {
        adminId: adminId(req),
        note: req.body?.note,
        action: 'review',
      });
      res.json({ ok: true, case: c });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.post('/api/sentinel/cases/:id/dismiss', requireAdminRole, async (req, res) => {
    try {
      const c = await transitionCase(req.params.id, 'dismissed', {
        adminId: adminId(req),
        note: req.body?.note,
        action: 'dismiss',
        detail: req.body?.note || 'dismissed',
      });
      res.json({ ok: true, case: c });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.post('/api/sentinel/cases/:id/watch', requireAdminRole, async (req, res) => {
    try {
      const c = await transitionCase(req.params.id, 'watching', {
        adminId: adminId(req),
        note: req.body?.note,
        action: 'watch',
      });
      res.json({ ok: true, case: c });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.post('/api/sentinel/cases/:id/block', requireAdminRole, async (req, res) => {
    try {
      const c = await getCaseById(req.params.id);
      if (!c) return res.status(404).json({ error: 'Case not found' });
      if (c.entityType !== 'ip' || !normalizeIp(c.entity)) {
        return res.status(400).json({ error: 'Case entity is not a blockable IP' });
      }
      const reason =
        (req.body && req.body.reason) ||
        `Blocked from case ${c.id}: ${c.title}`.slice(0, 512);
      const block = await createBlock({
        ip: c.entity,
        reason,
        source: 'threat_case',
        caseId: c.id,
        expiresAt: req.body?.expiresAt || null,
        createdBy: adminId(req),
      });
      const updated = await transitionCaseLifecycle(req.params.id, {
        status:'contained', note:req.body?.note || reason,
      }, adminId(req));
      res.json({ ok: true, case: updated, block });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.post('/api/sentinel/cases/:id/note', requireAdminRole, async (req, res) => {
    try {
      const c = await setCaseNote(req.params.id, req.body?.note || '', adminId(req));
      res.json({ ok: true, case: c });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.post('/api/sentinel/cases/:id/transition', requireAdminRole, async (req, res) => {
    try {
      const c = await transitionCaseLifecycle(req.params.id, req.body || {}, adminId(req));
      res.json({ ok:true, case:c });
    } catch (err) {
      res.status(err.status || 500).json({ error:err.message || 'Error', code:err.code });
    }
  });

  router.post('/api/sentinel/cases/:id/assign', requireAdminRole, async (req, res) => {
    try {
      const owner = req.body?.ownerAdminId === 'me' ? adminId(req) : req.body?.ownerAdminId;
      res.json({ ok:true, case:await assignCaseOwner(req.params.id, owner, adminId(req)) });
    } catch (err) {
      res.status(err.status || 500).json({ error:err.message || 'Error' });
    }
  });

  // ——— Custom rules ———
  router.get('/api/sentinel/rules', requireAdminRole, async (req, res) => {
    try {
      const rules = await listRules();
      res.json({ ok: true, rules });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  router.post('/api/sentinel/rules', requireAdminRole, async (req, res) => {
    try {
      const body = req.body || {};
      const rule = await createRule({
        name: body.name,
        description: body.description,
        isEnabled: body.isEnabled !== false,
        priority: body.priority,
        severity: body.severity,
        condition: body.condition,
        actions: body.actions,
        createdBy: adminId(req),
      });
      res.status(201).json({ ok: true, rule });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.put('/api/sentinel/rules/:id', requireAdminRole, async (req, res) => {
    try {
      const rule = await updateRule(req.params.id, req.body || {});
      res.json({ ok: true, rule });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.delete('/api/sentinel/rules/:id', requireAdminRole, async (req, res) => {
    try {
      await deleteRule(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  // ——— New IPs radar ———
  router.get('/api/sentinel/new-ips', requireAdminRole, async (req, res) => {
    try {
      const result = await listNewAuthFailIps({
        sinceHours: req.query.hours || 24,
        limit: req.query.limit,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  // ——— IP intel (RDAP) ———
  router.get('/api/sentinel/intel/:ip', requireAdminRole, async (req, res) => {
    try {
      const force = req.query.force === '1';
      const result = await lookupIpIntel(req.params.ip, { force });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Error' });
    }
  });

  router.get('/api/sentinel/export', requireAdminRole, async (req, res) => {
    try {
      const type = String(req.query.type || 'logins');
      const hours = req.query.hours || 24;
      let filename = 'sentinel-export.csv';
      let csv = '';

      if (type === 'threats') {
        const threats = await computeThreats({ sinceHours: hours });
        csv = toCsv(
          [
            'severity',
            'ruleId',
            'title',
            'summary',
            'entityType',
            'entity',
            'count',
            'windowHours',
            'lastSeen',
            'caseId',
            'caseStatus',
            'recommendedAction',
          ],
          (threats.findings || []).map((f) => [
            f.severity,
            f.ruleId,
            f.title,
            f.summary,
            f.entityType,
            f.entity,
            f.count,
            f.windowHours,
            f.lastSeen,
            f.caseId,
            f.caseStatus,
            f.recommendedAction,
          ])
        );
        filename = `sentinel-threats-${hours}h.csv`;
      } else if (type === 'cases') {
        const result = await listCases({ limit: 1000, openOnly: false });
        csv = toCsv(
          [
            'id',
            'status',
            'severity',
            'ruleId',
            'title',
            'entityType',
            'entity',
            'count',
            'lastSeen',
            'createdAt',
          ],
          result.cases.map((c) => [
            c.id,
            c.status,
            c.severity,
            c.ruleId,
            c.title,
            c.entityType,
            c.entity,
            c.count,
            c.lastSeen,
            c.createdAt,
          ])
        );
        filename = `sentinel-cases.csv`;
      } else if (type === 'blocks') {
        const result = await listBlocks({ activeOnly: false, limit: 1000 });
        csv = toCsv(
          [
            'id',
            'ip',
            'reason',
            'source',
            'isActive',
            'expiresAt',
            'createdAt',
            'revokedAt',
          ],
          result.blocks.map((b) => [
            b.id,
            b.ip,
            b.reason,
            b.source,
            b.isActive,
            b.expiresAt,
            b.createdAt,
            b.revokedAt,
          ])
        );
        filename = `sentinel-blocks.csv`;
      } else if (type === 'new-ips') {
        const result = await listNewAuthFailIps({ sinceHours: hours, limit: 1000 });
        csv = toCsv(
          [
            'ip',
            'firstSeen',
            'firstStatusCode',
            'firstPath',
            'authFailCount',
            'successCount',
            'totalRequests',
            'isBlocked',
            'openCases',
          ],
          result.ips.map((r) => [
            r.ip,
            r.firstSeen,
            r.firstStatusCode,
            r.firstPath,
            r.authFailCount,
            r.successCount,
            r.totalRequests,
            r.isBlocked,
            r.openCases,
          ])
        );
        filename = `sentinel-new-ips-${hours}h.csv`;
      } else if (type === 'events') {
        const result = await listEvents({
          sinceHours: hours,
          limit: 1000,
          offset: 0,
          ip: req.query.ip,
          statusCode: req.query.status,
          pathContains: req.query.path,
          locationId: req.query.locationId,
          surface: req.query.surface,
          action: req.query.action,
          actorId: req.query.actorId,
          outcome: req.query.outcome,
          q: req.query.q,
        });
        csv = toCsv(
          [
            'created_at',
            'method',
            'path',
            'status_code',
            'duration_ms',
            'ip',
            'key_prefix',
            'location_id',
            'error_class',
            'request_id',
            'surface',
            'actor_type',
            'actor_id',
            'actor_username',
            'action',
            'entity_type',
            'entity_id',
            'outcome',
          ],
          result.events.map((e) => [
            e.created_at,
            e.method,
            e.path,
            e.status_code,
            e.duration_ms,
            e.ip,
            e.key_prefix,
            e.location_id,
            e.error_class,
            e.request_id,
            e.surface,
            e.actor_type,
            e.actor_id,
            e.actor_username,
            e.action,
            e.entity_type,
            e.entity_id,
            e.outcome,
          ])
        );
        filename = `sentinel-api-events-${hours}h.csv`;
      } else {
        const result = await listLoginEvents({
          sinceHours: hours,
          limit: 1000,
          offset: 0,
          outcome: req.query.outcome,
          eventType: req.query.eventType,
          locationId: req.query.locationId,
          ip: req.query.ip,
          q: req.query.q,
          username: req.query.username,
        });
        csv = toCsv(
          [
            'created_at',
            'event_type',
            'outcome',
            'username',
            'email',
            'user_id',
            'location_id',
            'ip',
            'detail',
            'key_prefix',
            'request_id',
          ],
          result.logins.map((e) => [
            e.created_at,
            e.event_type,
            e.outcome,
            e.username,
            e.email,
            e.user_id,
            e.location_id,
            e.ip,
            e.detail,
            e.key_prefix,
            e.request_id,
          ])
        );
        filename = `sentinel-logins-${hours}h.csv`;
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      console.error('sentinel export', err);
      res.status(500).json({ error: 'Error' });
    }
  });

  router.post('/api/sentinel/purge', requireAdminRole, async (req, res) => {
    try {
      await Promise.all([purgeOldEvents(), purgeOldLoginEvents(), purgeExpiredForensics()]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Error' });
    }
  });

  return router;
}

function toCsv(headers, rows) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const row of rows) {
    lines.push(row.map(esc).join(','));
  }
  return lines.join('\n');
}

module.exports = { createSentinelRouter, sentinelNoStore };
