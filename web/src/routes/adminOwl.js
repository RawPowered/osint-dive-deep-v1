const express = require('express');
const { getInstanceIdentity } = require('../instanceIdentity');
const path = require('path');
const { ROOT } = require('../config');
const { requireAdminSession, requireOwlAccess, assertAdminApiKeyScope } = require('../middleware/sessionAuth');
const { listDelegatedAdmins, createDelegatedAdmin, listTenantLocationIds } = require('../services/adminUsers');
const owl = require('../services/owl');
const { createScheduledCallRelease } = require('../services/calendarAppointments');
const owlWebhooks = require('../services/owlWebhooks');
const { syncContactIntoOwl } = require('../services/owlContactSync');

function createAdminOwlRouter() {
  const router = express.Router();
  router.use(requireAdminSession);

  router.get('/owl', requireOwlAccess, (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'owl.html'));
  });

  router.use('/api/owl', requireOwlAccess);

  router.get('/api/owl/bootstrap', async (req, res) => {
    try {
      res.json({ ok: true, ...(await owl.bootstrapOwl(req.query.apiKeyId, req.session.admin)) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/locations', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const integrationLocations = await listTenantLocationIds(context.apiKeyId);
      let databaseLocations = [];
      let databaseError = null;
      try { databaseLocations = await owl.listLocations(context); }
      catch (error) { databaseError = error.message || 'Selected database could not be queried'; }
      let locationContexts = owl.buildLocationContexts(databaseLocations, integrationLocations);
      if (req.session.admin.principalType === 'tenant') {
        const granted = new Set(integrationLocations.map(String));
        locationContexts = locationContexts.filter((item) => granted.has(item.locationId));
      }
      res.json({
        ok:true,
        locations:locationContexts.map((item) => item.locationId),
        locationContexts,
        databaseStatus:{ source:context.source, connected:!databaseError, error:databaseError },
      });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/summary', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, summary: await owl.getSummary(context, req.query.locationId) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/intake-webhook', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const scope = webhookScope(context, req.query.locationId);
      const result = await owlWebhooks.getEndpoint(scope, context.corePool);
      res.json({ ok:true, ...withWebhookUrl(req, result) });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/owl/intake-webhook', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.intake_webhook.provision',
      entityType:'owl_webhook_endpoint',
    };
    try {
      const context = await contextFrom(req);
      const scope = webhookScope(context, req.body.locationId);
      const result = await owlWebhooks.provisionEndpoint(scope, req.session.admin, req.body || {}, context.corePool);
      await owl.recordAudit(auditInput(req, context, {
        locationId:scope.locationId,
        action:req.body?.rotate ? 'intake_webhook.rotate' : 'intake_webhook.provision',
        entityType:'owl_webhook_endpoint',
        entityId:result.endpoint?.id,
        after:{
          dataSourceSlug:scope.dataSourceSlug,
          integrationId:result.endpoint?.integrationId,
          allowContactCreated:result.endpoint?.allowContactCreated,
          allowContactUpdated:result.endpoint?.allowContactUpdated,
          enabled:result.endpoint?.enabled,
        },
        detail:'OWL contact intake endpoint configured; secret value excluded from audit',
      }));
      res.status(result.endpoint?.createdAt === result.endpoint?.updatedAt ? 201 : 200).json({ ok:true, ...withWebhookUrl(req, result) });
    } catch (error) { sendError(res, error); }
  });

  router.delete('/api/owl/intake-webhook', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.intake_webhook.disable',
      entityType:'owl_webhook_endpoint',
    };
    try {
      const context = await contextFrom(req);
      const scope = webhookScope(context, req.body.locationId);
      const result = await owlWebhooks.disableEndpoint(scope, req.session.admin, context.corePool);
      await owl.recordAudit(auditInput(req, context, {
        locationId:scope.locationId,
        action:'intake_webhook.disable',
        entityType:'owl_webhook_endpoint',
        entityId:result.endpoint?.id,
        after:{ enabled:false, dataSourceSlug:scope.dataSourceSlug },
      }));
      res.json({ ok:true, ...withWebhookUrl(req, result) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/intake-webhook/test-sync', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.contact_sync.test',
      entityType:'contact',
      entityId:req.body?.contactId,
    };
    try {
      const context = await contextFrom(req);
      const scope = webhookScope(context, req.body.locationId);
      const configured = await owlWebhooks.getEndpoint(scope, context.corePool);
      const integrationId = String(req.body.integrationId || configured.endpoint?.integrationId || '').trim();
      const result = await syncContactIntoOwl({
        corePool:context.corePool,
        apiKeyId:scope.apiKeyId,
        locationId:scope.locationId,
        dataSourceSlug:scope.dataSourceSlug,
        integrationId,
        contactId:req.body.contactId,
      });
      await owl.recordAudit(auditInput(req, context, {
        locationId:scope.locationId,
        action:'contact_sync.test',
        entityType:'contact',
        entityId:result.contactId,
        after:{ ready:result.ready, leadId:result.leadId, outcome:result.outcome, serviceType:result.serviceType },
      }));
      res.json({ ok:true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/pools', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, pools: await owl.listPools(context, req.query.locationId) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/service-pools', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, ...(await owl.getServicePoolManagement(context, req.query.locationId)) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/assignment-policy', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok:true, policy:await owl.getAssignmentPolicyManagement(context, req.query.locationId) });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/owl/assignment-policy', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.putAssignmentPolicy(context, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId:req.body.locationId, action:'assignment.policy.put', entityType:'assignment_policy',
        entityId:req.body.locationId, before:result.before, after:result.after,
      }));
      res.json({ ok:true, policy:result.after });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/owl/service-pools', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.saveServicePool(context, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'service.rule.put', entityType: 'service_pool',
        entityId: result.after.serviceType, before: result.before, after: result.after,
      }));
      res.json({ ok: true, service: result.after });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/owl/service-pool-calendars', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.saveServiceCalendars(context, req.body.serviceType, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'service.calendars.put', entityType: 'service_pool',
        entityId: result.after.serviceType, before: result.before, after: result.after,
      }));
      res.json({ ok: true, service: result.after });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/service-pools/move', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.moveLeadsToService(context, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'leads.service.move', entityType: 'lead_batch',
        entityId: result.service.serviceType, before: result.before, after: result.after,
        detail: `${result.affected} lead(s) moved to service ${result.service.serviceType}`,
      }));
      res.json({ ok: true, affected: result.affected, service: result.service });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/service-pools/reclassify', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.reclassifyServices(context, req.body || {});
      if (!result.dryRun) {
        await owl.recordAudit(auditInput(req, context, {
          locationId: req.body.locationId, action: 'services.reclassify', entityType: 'lead_batch',
          after: result, detail: `${result.updated} lead service assignment(s) updated from CRM tags`,
        }));
      }
      res.json({ ok: true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/service-pools/recheck', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.recheckServicePool(context, req.body || {});
      if (!result.dryRun) {
        await owl.recordAudit(auditInput(req, context, {
          locationId:req.body.locationId, action:'service.recheck.queue', entityType:'lead_batch',
          entityId:String(req.body.serviceType || ''), after:result,
          detail:`${result.queued} cc-recheck signal(s) queued; ${result.skipped} skipped; ${result.failed} failed`,
        }));
      }
      res.json({ ok:true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/dnc-review-rescrub', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.dnc.api.review_rescrub',
      entityType:'lead_batch',
    };
    try {
      const context = await contextFrom(req);
      const result = await owl.rescrubDncReviews(context, req.body || {});
      const transitions = result.results.filter((item) => item.changed).map((item) => ({
        leadId:item.leadId,
        before:item.previous,
        after:{
          dncStatus:item.dncStatus,
          source:item.source,
          resultCode:item.resultCode,
          reason:item.reason,
          decisionCategory:item.decisionCategory,
          reviewRequired:item.reviewRequired,
        },
      }));
      const auditResult = { ...result, provider:'dncscrub', transitions };
      delete auditResult.results;
      await owl.recordAudit(auditInput(req, context, {
        locationId:req.body.locationId,
        action:'dnc.api.review_rescrub.batch',
        entityType:'lead_batch',
        before:{ pool:'dnc_pending', state:'review', cutoff:result.cutoff },
        after:auditResult,
        detail:`DNC review holds re-scrubbed: ${result.released} released, ${result.movedToDnc} moved to true DNC, ${result.stillReview} still in review, ${result.failed} unresolved; ${result.remaining} remain in run`,
      }));
      res.json({ ok:true, ...compactDncBatchResult(result) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/dnc-review-release', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.dnc.review.release',
      entityType:'lead_batch',
    };
    try {
      const context = await contextFrom(req);
      const result = await owl.releaseDncReviews(context, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId:req.body.locationId,
        action:'dnc.review.release.batch',
        entityType:'lead_batch',
        before:{
          pool:'dnc_pending', dncStatus:'review', resultCode:'B',
          decisionCategory:'configuration_or_coverage',
        },
        after:result,
        detail:`Administrative DNC B-review release: ${result.released} moved to ${result.destinationPool}; ${result.remaining} eligible B hold(s) remain. Reason: ${result.releaseReason}`,
      }));
      res.json({ ok:true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/pool-management', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, ...(await owl.getPoolManagement(context, req.query.locationId)) });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/owl/pool-rules/:poolKey', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.savePoolRule(context, req.params.poolKey, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'pool.rule.put', entityType: 'lead_pool_rule',
        entityId: req.params.poolKey, before: result.before, after: result.after,
      }));
      res.json({ ok: true, rule: result.after });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/pools/move', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.moveLeadsToPool(context, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'leads.pool.move', entityType: 'lead_batch',
        entityId: result.pool.poolKey, before: result.before, after: result.after,
        detail: `${result.affected} lead(s) moved to ${result.pool.label}`,
      }));
      res.json({ ok: true, affected: result.affected, pool: result.pool });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/leads', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, ...(await owl.listLeads(context, req.query)) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/lead-sources', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, sources: await owl.listLeadSources(context, req.query.locationId) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/leads/pull', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.pullLeadSource(context, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'leads.pull.queue', entityType: 'crm_import_run',
        entityId: result.runId, after: {
          status: result.status, integrationId: result.integration.id,
          syncMode: result.options.full ? 'full' : 'incremental_or_bootstrap',
        },
        detail: `CRM lead pull queued from ${result.integration.name}`,
      }));
      res.status(202).json({ ok: true, runId: result.runId, status: result.status });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/leads/pulls/:runId', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, run: await owl.getLeadPull(context, req.params.runId, req.query.locationId) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/dnc-screening', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, ...(await owl.listDncScreening(context, req.query)) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/no-phone/refresh', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.channels.no_phone_refresh',
      entityType:'lead_batch',
    };
    try {
      const context = await contextFrom(req);
      const result = await owl.refreshNoPhonePool(context, req.body || {});
      const auditResult = { ...result };
      delete auditResult.results;
      await owl.recordAudit(auditInput(req, context, {
        locationId:req.body.locationId,
        action:'channels.no_phone.refresh',
        entityType:'lead_batch',
        after:auditResult,
        detail:`No Phone pool checked: ${result.processed} refreshed, ${result.failed} unresolved; ${result.remaining} still without a routable phone`,
      }));
      res.json({ ok:true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/dnc-screening/scrub', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.dnc.api.batch_scrub',
      entityType:'lead_batch',
    };
    try {
      const context = await contextFrom(req);
      const result = await owl.scrubDncScreening(context, req.body || {});
      const auditResult = { ...result, provider:'dncscrub' };
      delete auditResult.results;
      await owl.recordAudit(auditInput(req, context, {
        locationId:req.body.locationId,
        action:'dnc.api.scrub.batch',
        entityType:'lead_batch',
        after:auditResult,
        detail:`${result.processed} lead(s) screened through DNCScrub; ${result.blocked} true DNC; ${result.review} held for review; ${result.failed} unresolved; ${result.crmSync?.synced || 0} CRM contact(s) updated; ${result.crmSync?.failed || 0} CRM write(s) failed`,
      }));
      res.json({ ok:true, ...compactDncBatchResult(result) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/dnc-rescrub', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok:true, ...(await owl.getDncRescrubStatus(context, req.query)) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/dnc-rescrub', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.dnc.api.pool_rescrub',
      entityType:'lead_batch',
    };
    try {
      const context = await contextFrom(req);
      const result = await owl.rescrubDncPool(context, req.body || {});
      const transitions = result.results.filter((item) => item.changed).map((item) => ({
        leadId:item.leadId,
        before:item.previous,
        after:{
          dncStatus:item.dncStatus,
          source:item.source,
          resultCode:item.resultCode,
          reason:item.reason,
          decisionCategory:item.decisionCategory,
          reviewRequired:item.reviewRequired,
        },
      }));
      const auditResult = { ...result, provider:'dncscrub', transitions };
      delete auditResult.results;
      await owl.recordAudit(auditInput(req, context, {
        locationId:req.body.locationId,
        action:'dnc.api.rescrub.batch',
        entityType:'lead_batch',
        before:{ pool:'dnc', cutoff:result.cutoff },
        after:auditResult,
        detail:`DNC pool re-scrubbed: ${result.released} released, ${result.stillBlocked} true DNC, ${result.heldForReview} moved to review, ${result.failed} unresolved; ${result.crmSync?.synced || 0} CRM contact(s) updated; ${result.crmSync?.failed || 0} CRM write(s) failed; ${result.remaining} remain in run`,
      }));
      res.json({ ok:true, ...compactDncBatchResult(result) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/dnc-crm-sync', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.dnc.crm_sync',
      entityType:'lead_batch',
    };
    try {
      const context = await contextFrom(req);
      const result = await owl.syncDncCrmBacklog(context, req.body || {});
      const auditResult = { ...result };
      delete auditResult.results;
      await owl.recordAudit(auditInput(req, context, {
        locationId:req.body.locationId,
        action:'dnc.crm.sync.batch',
        entityType:'lead_batch',
        after:auditResult,
        detail:`DNC CRM backlog synchronized: ${result.crmSync.synced} updated, ${result.crmSync.failed} failed, ${result.crmSync.skipped} skipped; ${result.remaining} remain`,
      }));
      res.json({ ok:true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/dnc-screening/:leadId/scrub', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.dnc.api.lead_scrub',
      entityType:'lead',
      entityId:req.params.leadId,
    };
    try {
      const context = await contextFrom(req);
      const result = await owl.scrubDncScreeningLead(context, {
        ...(req.body || {}), leadId:req.params.leadId,
      });
      await owl.recordAudit(auditInput(req, context, {
        locationId:req.body.locationId,
        action:'dnc.api.scrub',
        entityType:'lead',
        entityId:req.params.leadId,
        after:{
          dncStatus:result.dncStatus,
          resultCode:result.resultCode,
          reason:result.reason,
          decisionCategory:result.decisionCategory,
          reviewRequired:result.reviewRequired,
          source:result.source,
          crmSync:result.crmSync,
        },
        detail:`DNCScrub screened lead as ${result.dncStatus}; CRM write-back ${result.crmSync?.status || 'not_applicable'}`,
      }));
      res.json({ ok:true, lead:result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/dnc-screening/tag-check', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.refreshDncScreening(context, req.body || {});
      const auditResult = { ...result };
      delete auditResult.results;
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'dnc.tags.check.batch', entityType: 'lead_batch',
        after: auditResult, detail: `${result.processed} CRM tag result(s) checked; ${result.remaining} pending`,
      }));
      res.json({ ok: true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/dnc-screening/:leadId/tag-check', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.refreshDncScreeningLead(context, {
        ...(req.body || {}), leadId: req.params.leadId,
      });
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'dnc.tags.check', entityType: 'lead',
        entityId: req.params.leadId, after: result,
        detail: `CRM DNC tags checked as ${result.dncStatus}`,
      }));
      res.json({ ok: true, lead: result });
    } catch (error) { sendError(res, error); }
  });

  router.patch('/api/owl/leads/:id', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.updateLead(context, req.params.id, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'lead.update', entityType: 'lead',
        entityId: req.params.id, before: result.before, after: result.after,
      }));
      res.json({ ok: true, lead: result.after });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/leads/assign', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.assignLeads(context, req.body || {}, true);
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'leads.assign', entityType: 'lead_batch',
        entityId: req.body.userId, before: result.before, after: result.after,
        detail: `${result.affected} lead(s) assigned`,
      }));
      res.json({ ok: true, affected: result.affected });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/leads/unassign', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.assignLeads(context, req.body || {}, false);
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'leads.unassign', entityType: 'lead_batch',
        before: result.before, after: result.after, detail: `${result.affected} lead(s) unassigned`,
      }));
      res.json({ ok: true, affected: result.affected });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/leads/:id/scheduled-call-release', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      locationId:req.body?.locationId,
      action:'owl.lead.scheduled_call_release',
      entityType:'lead',
      entityId:req.params.id,
    };
    try {
      const context = await contextFrom(req);
      if (context.source !== 'core') {
        throw Object.assign(new Error('Scheduled call releases are available only for the core lead store'), { status:409 });
      }
      const release = await createScheduledCallRelease(context.corePool, {
        ...(req.body || {}),
        leadId:req.params.id,
        adminId:req.session.admin?.id,
        adminUsername:req.session.admin?.username,
      });
      await owl.recordAudit(auditInput(req, context, {
        locationId:req.body.locationId,
        action:'lead.scheduled_call_release',
        entityType:'lead',
        entityId:req.params.id,
        after:{
          releaseId:release.id,
          restrictionCode:release.restrictionCode,
          minutes:release.minutes,
          remainingUses:release.remainingUses,
        },
        detail:`Temporary scheduled-call release created: ${release.remainingUses} use(s), ${release.minutes} minute(s); reason recorded`,
      }));
      res.status(201).json({ ok:true, release });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/users', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, users: await owl.listUsers(context, req.query.locationId) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/crm-users', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok:true, ...(await owl.listCrmUsers(context, req.query)) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/access/accounts', async (req, res) => {
    try {
      res.json({ ok: true, accounts: await listDelegatedAdmins(req.session.admin) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/access/accounts', async (req, res) => {
    try {
      if (!req.body?.apiKeyId) throw Object.assign(new Error('apiKeyId is required for administrative audit scope'), { status: 400 });
      assertAdminApiKeyScope(req.session.admin, req.body.apiKeyId);
      const account = await createDelegatedAdmin(req.body || {}, req.session.admin);
      await owl.recordAudit({
        admin: req.session.admin,
        context: { apiKeyId: req.body.apiKeyId, source: 'core' },
        locationId: null,
        action: 'access.account.create',
        entityType: `${account.accountType}_administrator`,
        entityId: account.id,
        after: account,
        detail: `${account.displayRole} account created`,
      });
      res.status(201).json({ ok: true, account });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/users', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const user = await owl.createUser(context, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'user.create', entityType: 'user',
        entityId: user.id, after: user,
      }));
      res.status(201).json({ ok: true, user });
    } catch (error) { sendError(res, error); }
  });

  router.patch('/api/owl/users/:id', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.updateUser(context, req.params.id, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'user.update', entityType: 'user',
        entityId: req.params.id, before: result.before, after: result.after,
      }));
      res.json({ ok: true, user: result.after });
    } catch (error) { sendError(res, error); }
  });

  router.patch('/api/owl/users/:id/password', async (req, res) => {
    req.sentinelControl = {
      apiKeyId: req.body?.apiKeyId,
      locationId: req.body?.locationId,
      action: 'owl.user.password_change',
      entityType: 'user',
      entityId: req.params.id,
    };
    try {
      const context = await contextFrom(req);
      const result = await owl.changeUserPassword(context, req.params.id, req.body || {});
      const evidence = {
        credentialChanged: true,
        persistenceVerified: result.credentialVerified,
        activeSessionsRevoked: result.sessionsRevoked,
      };
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId,
        action: 'user.password_change',
        entityType: 'user',
        entityId: req.params.id,
        after: evidence,
        detail: `Dialer password changed; ${result.sessionsRevoked} active operator session(s) revoked`,
      }));
      res.json({
        ok: true,
        userId: result.user.id,
        credentialVerified: result.credentialVerified,
        sessionsRevoked: result.sessionsRevoked,
      });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/dialers', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, dialers: await owl.listDialers(context, req.query.locationId) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/schedules', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok: true, ...(await owl.listSchedules(context, req.query.locationId)) });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/owl/schedules/:userId', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.putSchedule(context, req.params.userId, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'schedule.put', entityType: 'schedule',
        entityId: req.params.userId, before: result.before, after: result.after,
      }));
      res.json({ ok: true, schedule: result.after });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/owl/schedules/:userId/submit', async (req, res) => {
    try {
      const context = await contextFrom(req);
      const result = await owl.submitSchedule(context, req.params.userId, req.body || {});
      await owl.recordAudit(auditInput(req, context, {
        locationId: req.body.locationId, action: 'schedule.submit', entityType: 'schedule',
        entityId: req.params.userId, before: result.before, after: result.after,
        detail: `Weekly schedule submitted for ${result.week.weekStart}`,
      }));
      res.json({ ok: true, schedule: result.after, week: result.week });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/compliance', async (req, res) => {
    try {
      const context = await contextFrom(req);
      res.json({ ok:true, ...(await owl.getComplianceReport(context, req.query.locationId)) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/owl/audit', async (req, res) => {
    try {
      const input = { ...req.query };
      if ((req.session.admin.principalType || 'root') === 'tenant') input.apiKeyId = req.session.admin.apiKeyId;
      res.json({ ok: true, events: await owl.listAudit(input) });
    }
    catch (error) { sendError(res, error); }
  });

  return router;
}

async function contextFrom(req) {
  const source = (req.body && req.body.source) || req.query.source || 'core';
  const apiKeyId = (req.body && req.body.apiKeyId) || req.query.apiKeyId;
  assertAdminApiKeyScope(req.session.admin, apiKeyId);
  const locationId = (req.body && req.body.locationId) || req.query.locationId;
  if (req.session.admin.principalType === 'tenant' && locationId) {
    const allowed = await listTenantLocationIds(apiKeyId);
    if (!allowed.includes(String(locationId))) {
      throw Object.assign(new Error('Selected location is outside this administrator tenant'), { status: 403 });
    }
  }
  return owl.resolveContext({ apiKeyId, source });
}

function webhookScope(context, locationId) {
  const selectedLocation = String(locationId || '').trim();
  if (!selectedLocation) throw Object.assign(new Error('locationId is required'), { status:400 });
  return {
    apiKeyId:context.apiKeyId,
    locationId:selectedLocation,
    dataSourceSlug:context.source,
  };
}

function withWebhookUrl(req, result) {
  const endpoint = result.endpoint ? {
    ...result.endpoint,
    url:`${req.protocol}://${req.get('host')}${getInstanceIdentity().webhookBasePath}/owl/${result.endpoint.publicId}`,
  } : null;
  return { ...result, endpoint };
}

function auditInput(req, context, details) {
  return { admin: req.session.admin, context, ...details };
}

function compactDncBatchResult(result) {
  const compactText = (value) => value == null ? null : String(value).slice(0, 160);
  return {
    ...result,
    reasonSummary:(result.reasonSummary || []).slice(0, 10).map((item) => ({
      resultCode:item.resultCode,
      decisionCategory:item.decisionCategory,
      reason:compactText(item.reason),
      reviewRequired:Boolean(item.reviewRequired),
      count:Number(item.count) || 0,
    })),
    results:(result.results || []).map((item) => ({
      leadId:item.leadId,
      dncStatus:item.dncStatus,
      resultCode:item.resultCode,
      resultLabel:item.resultLabel,
      reason:compactText(item.reason),
      decisionCategory:item.decisionCategory,
      reviewRequired:Boolean(item.reviewRequired),
      error:compactText(item.error),
      code:item.code,
    })),
  };
}

function sendError(res, error) {
  res.status(error.status || 500).json({ ok: false, error: error.message || 'OWL operation failed' });
}

module.exports = { createAdminOwlRouter, compactDncBatchResult };
