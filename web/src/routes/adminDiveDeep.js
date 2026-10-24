const express = require('express');
const path = require('path');
const { ROOT } = require('../config');
const {
  requireAdminSession,
  requireAdminRole,
  requireRootRole,
  requireAdminCsrf,
} = require('../middleware/sessionAuth');
const service = require('../services/diveDeep');
const integrations = require('../services/diveDeepIntegrations');
const importService = require('../services/diveDeepImports');
const catalog = require('../services/platformCatalog');
const rekognition = require('../services/diveDeepRekognition');
const imageAnalysis = require('../services/diveDeepImageAnalysis');
const workflow = require('../services/diveDeepWorkflow');
const workerPools = require('../services/diveDeepWorkerPools');
const reconJobs = require('../services/diveDeepReconJobs');
const cloudRun = require('../services/diveDeepCloudRun');
const artifacts = require('../services/diveDeepArtifacts');
const objectStorage = require('../services/diveDeepObjectStorage');
const workerRuntime = require('../services/diveDeepWorkerRuntime');
const crmLifecycle = require('../services/diveDeepCrmIntegration');
const externalApi = require('../services/diveDeepExternalApi');
const productionReadiness = require('../services/diveDeepProductionReadiness');

function sendError(res, error) {
  const transientCodes = new Set([
    'POOL_ENQUEUELIMIT', 'POOL_CLOSED', 'ETIMEDOUT', 'ECONNRESET',
    'PROTOCOL_CONNECTION_LOST', 'ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK',
  ]);
  const transient = transientCodes.has(error.code);
  if (transient) res.setHeader('Retry-After', '3');
  const status = transient ? 503 : (error.status || 500);
  return res.status(status).json({
    error: transient
      ? 'DiveDeep is briefly busy completing protected work. Please retry in a few seconds.'
      : (error.status ? error.message : 'DiveDeep administrative operation failed'),
    code: transient ? 'DIVEDEEP_TEMPORARILY_BUSY' : (error.code || 'DIVEDEEP_ADMIN_ERROR'),
  });
}

function actorId(req) { return req.session?.admin?.id || 'admin'; }

function createAdminDiveDeepRouter(dependencies = {}) {
  const svc = { ...service, ...(dependencies.service || {}) };
  const integrationSvc = { ...integrations, ...(dependencies.integrationService || {}) };
  const importSvc = { ...importService, ...(dependencies.importService || {}) };
  const catalogSvc = { ...catalog, ...(dependencies.catalogService || {}) };
  const rekognitionSvc = { ...rekognition, ...(dependencies.rekognitionService || {}) };
  const imageAnalysisSvc = { ...imageAnalysis, ...(dependencies.imageAnalysisService || {}) };
  const workflowSvc = { ...workflow, ...(dependencies.workflowService || {}) };
  const workerPoolSvc = { ...workerPools, ...(dependencies.workerPoolService || {}) };
  const reconJobSvc = { ...reconJobs, ...(dependencies.reconJobService || {}) };
  const cloudRunSvc = { ...cloudRun, ...(dependencies.cloudRunService || {}) };
  const artifactSvc = { ...artifacts, ...(dependencies.artifactService || {}) };
  const objectStorageSvc = { ...objectStorage, ...(dependencies.objectStorageService || {}) };
  const workerRuntimeSvc = { ...workerRuntime, ...(dependencies.workerRuntimeService || {}) };
  const crmLifecycleSvc = { ...crmLifecycle, ...(dependencies.crmLifecycleService || {}) };
  const externalApiSvc = { ...externalApi, ...(dependencies.externalApiService || {}) };
  const productionReadinessSvc = { ...productionReadiness, ...(dependencies.productionReadinessService || {}) };
  const router = express.Router();
  router.use(requireAdminSession);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    if (req.path.startsWith('/api/divedeep')) req.sentinelOmitBodies = true;
    next();
  });

  router.get('/divedeep', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'divedeep.html'));
  });

  router.get('/api/divedeep/customers', requireAdminRole, async (req, res) => {
    try {
      const customers = await svc.listCustomers(req.query || {});
      return res.json({ ok: true, customers });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/overview', requireAdminRole, async (req, res) => {
    try {
      return res.json({ ok: true, overview: await svc.getAdminOverview() });
    } catch (error) { return sendError(res, error); }
  });

  // Phase 9 organization, service-identity, and signed-webhook control plane.
  // These routes remain behind the hidden admin base, admin session, IP gate, CSRF, and Sentinel.
  router.get('/api/divedeep/organizations', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, organizations: await externalApiSvc.listOrganizations(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/organizations', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.organization.create', entityType: 'divedeep_organization', entityId: 'new' };
      const organization = await externalApiSvc.createOrganization(req.body || {}, actorId(req));
      req.sentinelControl.entityId = organization.id;
      return res.status(201).json({ ok: true, organization });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/organizations/:organizationId/customers', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.organization.customer.add', entityType: 'divedeep_organization', entityId: req.params.organizationId };
      const membership = await externalApiSvc.addOrganizationCustomer(req.params.organizationId, req.body?.customerId, req.body || {}, actorId(req));
      return res.status(201).json({ ok: true, membership });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/service-identities', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, identities: await externalApiSvc.listServiceIdentities(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/service-identities', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.service_identity.create', entityType: 'divedeep_service_identity', entityId: 'new' };
      const created = await externalApiSvc.createServiceIdentity(req.body || {}, actorId(req));
      req.sentinelControl.entityId = created.identity.id;
      return res.status(201).json({
        ok: true,
        identity: created.identity,
        apiKey: created.apiKey || undefined,
        oauthClientId: created.oauthClientId || undefined,
        oauthClientSecret: created.oauthClientSecret || undefined,
        warning: 'Copy the returned credential now. Secret values are not stored in retrievable form.',
      });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/service-identities/:identityId/revoke', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.service_identity.revoke', entityType: 'divedeep_service_identity', entityId: req.params.identityId };
      return res.json({ ok: true, identity: await externalApiSvc.revokeServiceIdentity(req.params.identityId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/webhook-subscriptions', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, webhooks: await externalApiSvc.listWebhookSubscriptions(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/webhook-subscriptions', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.webhook_subscription.create', entityType: 'divedeep_webhook_subscription', entityId: 'new' };
      const created = await externalApiSvc.createWebhookSubscription(req.body || {}, actorId(req));
      req.sentinelControl.entityId = created.subscription.id;
      return res.status(201).json({ ok: true, webhook: created.subscription, signingSecret: created.signingSecret, warning: 'Copy this signing secret now. It will not be shown again.' });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/webhook-subscriptions/:subscriptionId/test', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      const subscriptions = await externalApiSvc.listWebhookSubscriptions({ limit: 500 });
      const subscription = subscriptions.find((item) => item.id === req.params.subscriptionId);
      if (!subscription) return res.status(404).json({ error: 'Webhook subscription not found', code: 'DIVEDEEP_WEBHOOK_NOT_FOUND' });
      req.sentinelControl = { action: 'divedeep.webhook.test', entityType: 'divedeep_webhook_subscription', entityId: subscription.id };
      const result = await externalApiSvc.enqueueWebhookForSubscription(subscription.id, {
        eventType: 'webhook.test',
        payload: { subscriptionId: subscription.id, message: 'DiveDeep signed webhook verification event' },
      });
      return res.status(202).json({ ok: true, event: result });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/webhook-deliveries', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, deliveries: await externalApiSvc.listWebhookDeliveries(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/webhook-deliveries/:deliveryId/replay', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.webhook.replay', entityType: 'divedeep_webhook_delivery', entityId: req.params.deliveryId };
      return res.json({ ok: true, delivery: await externalApiSvc.replayWebhookDelivery(req.params.deliveryId) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/webhooks/sweep', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.webhook.sweep', entityType: 'divedeep_webhook_delivery', entityId: 'queue' };
      return res.json({ ok: true, result: await externalApiSvc.runWebhookSweep({ limit: req.body?.limit || 100, workerId: `admin:${actorId(req)}` }) });
    } catch (error) { return sendError(res, error); }
  });


  router.get('/api/divedeep/operations/overview', requireAdminRole, async (req, res) => {
    try {
      const [overview, pools, workers, privacyWorkflow, crmLifecycle] = await Promise.all([
        reconJobSvc.operationsOverview(),
        workerPoolSvc.getPoolSummary(),
        workerRuntimeSvc.getWorkerOperations(),
        workflowSvc.operationsOverview(),
        crmLifecycleSvc.operationsOverview(),
      ]);
      return res.json({ ok: true, overview: { ...overview, pools, workers, privacyWorkflow, crmLifecycle } });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/crm/overview', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, overview: await crmLifecycleSvc.operationsOverview() }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/crm/contact-links', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, links: await crmLifecycleSvc.listContactLinks(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/crm/contact-links', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.crm.contact_link.create', entityType: 'divedeep_crm_contact_link', entityId: 'new' };
      const link = await crmLifecycleSvc.createContactLink(req.body || {}, actorId(req));
      req.sentinelControl.entityId = link.id;
      return res.status(201).json({ ok: true, link });
    } catch (error) { return sendError(res, error); }
  });

  router.delete('/api/divedeep/crm/contact-links/:linkId', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.crm.contact_link.unlink', entityType: 'divedeep_crm_contact_link', entityId: req.params.linkId };
      await crmLifecycleSvc.unlinkContactLink(req.params.linkId, actorId(req));
      return res.json({ ok: true });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/crm/events/:direction', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, events: await crmLifecycleSvc.listQueueEvents(req.params.direction, req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/crm/events/:direction/:eventId/retry', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.crm.dead_letter.retry', entityType: 'divedeep_crm_queue_event', entityId: req.params.eventId };
      await crmLifecycleSvc.retryDeadLetter(req.params.direction, req.params.eventId, actorId(req));
      return res.json({ ok: true });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/crm/integrations/:integrationId/webhook', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, endpoint: await crmLifecycleSvc.getWebhookEndpoint(req.params.integrationId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/crm/integrations/:integrationId/webhook', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.crm.webhook.provision', entityType: 'divedeep_crm_webhook_endpoint', entityId: req.params.integrationId };
      return res.status(201).json({ ok: true, ...(await crmLifecycleSvc.provisionWebhookEndpoint(req.params.integrationId, { rotate: req.body?.rotate === true })) });
    } catch (error) { return sendError(res, error); }
  });

  router.delete('/api/divedeep/crm/integrations/:integrationId/webhook', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.crm.webhook.disable', entityType: 'divedeep_crm_webhook_endpoint', entityId: req.params.integrationId };
      return res.json({ ok: true, endpoint: await crmLifecycleSvc.disableWebhookEndpoint(req.params.integrationId) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/crm/customers/:customerId/enqueue', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.crm.lifecycle.enqueue', entityType: 'divedeep_customer', entityId: req.params.customerId };
      const result = await crmLifecycleSvc.enqueueCustomerLifecycle(req.params.customerId, req.body?.eventType || 'divedeep.lifecycle.updated', { force: req.body?.force === true });
      return res.status(202).json({ ok: true, result });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/crm/sweep', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.crm.sweep', entityType: 'divedeep_crm_queue', entityId: 'all' };
      return res.json({ ok: true, result: await crmLifecycleSvc.runCrmSweep(req.body || {}) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/work-queue', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, queue: await workflowSvc.workQueue() }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/review-queue', requireAdminRole, async (req, res) => {
    try {
      const [queue, reviewTasks] = await Promise.all([reconJobSvc.reviewQueue(), workflowSvc.listReviewTasks(req.query || {})]);
      return res.json({ ok: true, queue: { ...queue, reviewTasks } });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/retention-queue', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, queue: await artifactSvc.retentionQueue(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/artifacts', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, artifacts: await artifactSvc.listArtifacts(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/artifacts/:artifactId', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, artifact: await artifactSvc.getArtifact(req.params.artifactId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/artifacts/upload-authorizations', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.artifact.upload_authorize', entityType: 'artifact', entityId: 'new' };
      const result = await artifactSvc.reserveUpload(req.body || {}, actorId(req));
      req.sentinelControl.entityId = result.artifact.id;
      return res.status(201).json({ ok: true, ...result });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/artifacts/:artifactId/finalize', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.artifact.finalize', entityType: 'artifact', entityId: req.params.artifactId };
      return res.json({ ok: true, artifact: await artifactSvc.finalizeUpload(req.params.artifactId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/artifacts/:artifactId/access', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.artifact.access', entityType: 'artifact', entityId: req.params.artifactId };
      return res.json({ ok: true, grant: await artifactSvc.createAccessGrant(req.params.artifactId, actorId(req), req.body?.purpose) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/artifacts/:artifactId/disposition', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.artifact.disposition', entityType: 'artifact', entityId: req.params.artifactId };
      return res.json({ ok: true, artifact: await artifactSvc.updateDisposition(req.params.artifactId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/artifacts/:artifactId/retention/extend', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.artifact.retention_extend', entityType: 'artifact', entityId: req.params.artifactId };
      return res.json({ ok: true, artifact: await artifactSvc.extendRetention(req.params.artifactId, req.body?.days, req.body?.reason, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/artifacts/:artifactId/hold', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.artifact.hold', entityType: 'artifact', entityId: req.params.artifactId };
      return res.json({ ok: true, artifact: await artifactSvc.setHold(req.params.artifactId, true, req.body?.reason, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.delete('/api/divedeep/artifacts/:artifactId/hold', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.artifact.hold_release', entityType: 'artifact', entityId: req.params.artifactId };
      return res.json({ ok: true, artifact: await artifactSvc.setHold(req.params.artifactId, false, req.body?.reason, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/retention/run', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.retention.run', entityType: 'retention', entityId: 'artifact_sweep' };
      return res.json({ ok: true, result: await artifactSvc.runRetentionSweep({ limit: req.body?.limit }) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/storage/lifecycle-template', requireRootRole, async (req, res) => {
    try {
      const runtime = await integrationSvc.getRuntimeIntegration('object_storage');
      const config = runtime?.config || { driver: 's3', bucket: 'PRIVATE_BUCKET' };
      return res.json({ ok: true, template: objectStorageSvc.lifecyclePolicyTemplate(config) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/monitoring-queue', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, queue: await reconJobSvc.monitoringQueue() }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/case-queue', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, cases: await reconJobSvc.caseQueue() }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/worker-pools', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, pools: await workerPoolSvc.listPools(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/worker-pools', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.worker_pool.create', entityType: 'worker_pool', entityId: 'new' };
      const pool = await workerPoolSvc.createPool(req.body || {}, actorId(req));
      req.sentinelControl.entityId = pool.id;
      return res.status(201).json({ ok: true, pool });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/worker-pools/:poolId/versions', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.worker_pool.version.create', entityType: 'worker_pool', entityId: req.params.poolId };
      return res.status(201).json({ ok: true, version: await workerPoolSvc.createVersion(req.params.poolId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/worker-pool-versions/:versionId', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.worker_pool.version.update', entityType: 'worker_pool_version', entityId: req.params.versionId };
      return res.json({ ok: true, version: await workerPoolSvc.updateVersion(req.params.versionId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/worker-pool-versions/:versionId/publish', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.worker_pool.version.publish', entityType: 'worker_pool_version', entityId: req.params.versionId };
      return res.json({ ok: true, version: await workerPoolSvc.publishVersion(req.params.versionId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/workers', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, workers: await workerRuntimeSvc.listWorkers(req.query || {}), operations: await workerRuntimeSvc.getWorkerOperations() }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/workers/lease-sweep', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.worker.lease_sweep', entityType: 'worker_pool', entityId: 'ephemeral_workers' };
      return res.json({ ok: true, result: await workerRuntimeSvc.sweepExpiredLeases({ limit: req.body?.limit }) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/recon-jobs', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, jobs: await reconJobSvc.listJobs(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/recon-jobs/:jobId', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, job: await reconJobSvc.getJob(req.params.jobId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/workflow-gates/evaluate', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.workflow_gates.evaluate', entityType: 'customer', entityId: req.params.customerId };
      return res.json({ ok: true, evaluation: await workflowSvc.evaluateCustomer(req.params.customerId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/customers/:customerId/workflow-gates', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, gates: await workflowSvc.getCustomerGates(req.params.customerId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/privacy-workflows', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, workflows: await workflowSvc.listWorkflowSummaries(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/customers/:customerId/privacy-workflow', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, workflow: await workflowSvc.getCustomerWorkflow(req.params.customerId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/privacy-workflow/reconcile', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.workflow.reconcile', entityType: 'customer', entityId: req.params.customerId };
      return res.json({ ok: true, result: await workflowSvc.reconcileReviewTasks(req.params.customerId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/privacy-workflow/close', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.workflow.close', entityType: 'customer', entityId: req.params.customerId };
      return res.json({ ok: true, evaluation: await workflowSvc.closeWorkflow(req.params.customerId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/review-tasks', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, tasks: await workflowSvc.listReviewTasks(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/review-tasks/:taskId', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.review_task.update', entityType: 'review_task', entityId: req.params.taskId };
      return res.json({ ok: true, task: await workflowSvc.updateReviewTask(req.params.taskId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/request-deliveries', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, deliveries: await workflowSvc.listDeliveries(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/cases/:caseId/deliveries', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.delivery.create', entityType: 'removal_case', entityId: req.params.caseId };
      return res.status(201).json({ ok: true, delivery: await workflowSvc.createDelivery(req.params.caseId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/request-deliveries/:deliveryId/attempts', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.delivery.attempt', entityType: 'request_delivery', entityId: req.params.deliveryId };
      return res.json({ ok: true, delivery: await workflowSvc.recordDeliveryAttempt(req.params.deliveryId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/monitoring-schedules', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, schedules: await workflowSvc.listMonitoringSchedules(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/monitoring-schedules', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.monitoring.create', entityType: 'customer', entityId: req.params.customerId };
      return res.status(201).json({ ok: true, schedule: await workflowSvc.createMonitoringSchedule(req.params.customerId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/monitoring-schedules/:scheduleId/checks', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.monitoring.check', entityType: 'monitoring_schedule', entityId: req.params.scheduleId };
      return res.status(201).json({ ok: true, result: await workflowSvc.recordMonitoringCheck(req.params.scheduleId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/recon-jobs', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.recon_job.create', entityType: 'customer', entityId: req.params.customerId };
      const job = await reconJobSvc.createJob(req.params.customerId, actorId(req));
      req.sentinelControl = { action: 'divedeep.recon_job.created', entityType: 'recon_job', entityId: job.id };
      return res.status(201).json({ ok: true, job });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/recon-jobs/:jobId/dispatch', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.recon_job.dispatch', entityType: 'recon_job', entityId: req.params.jobId };
      return res.json({ ok: true, job: await reconJobSvc.dispatchJob(req.params.jobId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/recon-jobs/:jobId/sync', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.recon_job.sync', entityType: 'recon_job', entityId: req.params.jobId };
      return res.json({ ok: true, job: await reconJobSvc.syncExecution(req.params.jobId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/recon-jobs/:jobId/cancel', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.recon_job.cancel', entityType: 'recon_job', entityId: req.params.jobId };
      return res.json({ ok: true, job: await reconJobSvc.cancelJob(req.params.jobId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/packages', requireRootRole, async (req, res) => {
    try { return res.json({ ok: true, packages: await svc.listPackages({}, undefined) }); }
    catch (error) { return sendError(res, error); }
  });

  router.put('/api/divedeep/packages/:packageId', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.package.update', entityType: 'package', entityId: req.params.packageId };
      return res.json({ ok: true, package: await svc.updatePackage(req.params.packageId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/pilot-codes', requireRootRole, async (req, res) => {
    try { return res.json({ ok: true, codes: await svc.listPilotCodes() }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/pilot-codes', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.pilot_code.create', entityType: 'pilot_code', entityId: 'new' };
      return res.status(201).json({ ok: true, ...(await svc.createPilotCode(req.body || {}, actorId(req))) });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/pilot-codes/:codeId', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.pilot_code.update', entityType: 'pilot_code', entityId: req.params.codeId };
      return res.json({ ok: true, pilotCode: await svc.updatePilotCode(req.params.codeId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/integrations', requireRootRole, async (req, res) => {
    try {
      return res.json({ ok: true, integrations: await integrationSvc.listIntegrations() });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/integration-events', requireRootRole, async (req, res) => {
    try {
      return res.json({ ok: true, events: await integrationSvc.listIntegrationEvents(req.query.limit) });
    } catch (error) { return sendError(res, error); }
  });

  router.put('/api/divedeep/integrations/:provider', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.integration.update', entityType: 'integration', entityId: req.params.provider };
      const integration = await integrationSvc.saveIntegration(req.params.provider, req.body || {}, actorId(req));
      return res.json({ ok: true, integration });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/integrations/object_storage/verify-access', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.integration.object_storage.verify_access', entityType: 'integration', entityId: 'object_storage' };
      const result = await objectStorageSvc.verifyAccess();
      const integration = await integrationSvc.recordVerification('object_storage', { ...result, eventType: 'integration.object_storage.verified', operation: 'HeadBucket', message: `Private bucket ${result.bucket} is accessible.` }, actorId(req));
      return res.json({ ok: true, result, integration });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/integrations/:provider/verify', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.integration.verify', entityType: 'integration', entityId: req.params.provider };
      const integration = await integrationSvc.verifyIntegration(req.params.provider, actorId(req));
      return res.json({ ok: true, integration });
    } catch (error) { return sendError(res, error); }
  });

  router.delete('/api/divedeep/integrations/:provider', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.integration.disconnect', entityType: 'integration', entityId: req.params.provider };
      const integration = await integrationSvc.disableIntegration(req.params.provider, actorId(req));
      return res.json({ ok: true, integration });
    } catch (error) { return sendError(res, error); }
  });



  router.get('/api/divedeep/integrations/google_cloud_run/status', requireRootRole, async (req, res) => {
    try {
      const all = await integrationSvc.listIntegrations();
      const integration = all.find((item) => item.provider === 'google_cloud_run') || null;
      return res.json({ ok: true, integration, pools: await workerPoolSvc.listPools() });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/integrations/google_cloud_run/verify-access', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.integration.cloud_run.verify_access', entityType: 'integration', entityId: 'google_cloud_run' };
      const result = await cloudRunSvc.verifyAccess();
      const integration = await integrationSvc.recordVerification('google_cloud_run', {
        ...result,
        eventType: 'integration.cloud_run.access_verified',
        message: 'Google Cloud Run Job access verified without executing customer work.',
      }, actorId(req));
      return res.json({ ok: true, result, integration });
    } catch (error) {
      await integrationSvc.recordVerification('google_cloud_run', {
        ok: false,
        eventType: 'integration.cloud_run.access_failed',
        operation: 'GetJob',
        message: 'Google Cloud Run Job verification failed.',
      }, actorId(req)).catch(() => {});
      return sendError(res, error);
    }
  });

  router.get('/api/divedeep/integrations/aws_rekognition/status', requireRootRole, async (req, res) => {
    try {
      const all = await integrationSvc.listIntegrations();
      const integration = all.find((item) => item.provider === 'aws_rekognition') || null;
      let usage = { today: { calls: 0, operations: [] }, month: { calls: 0, successes: 0, failures: 0, estimatedUnits: 0 } };
      try { usage = await rekognitionSvc.getUsageStatus(); } catch (_error) { /* fresh install may not have recorded usage yet */ }
      return res.json({ ok: true, integration, usage, presentationContract: imageAnalysisSvc.presentationContract() });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/integrations/aws_rekognition/verify-identity', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.integration.rekognition.verify_identity', entityType: 'integration', entityId: 'aws_rekognition' };
      const result = await rekognitionSvc.verifyIdentity();
      const integration = await integrationSvc.recordVerification('aws_rekognition', { ...result, eventType: 'integration.rekognition.identity_verified', operation: 'GetCallerIdentity', message: `AWS identity verified for ${result.arn || result.account || 'configured principal'}.` }, actorId(req));
      return res.json({ ok: true, result, integration });
    } catch (error) {
      await integrationSvc.recordVerification('aws_rekognition', { ok: false, eventType: 'integration.rekognition.identity_failed', operation: 'GetCallerIdentity', message: 'AWS identity verification failed.' }, actorId(req)).catch(() => {});
      return sendError(res, error);
    }
  });

  router.post('/api/divedeep/integrations/aws_rekognition/verify-access', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.integration.rekognition.verify_access', entityType: 'integration', entityId: 'aws_rekognition' };
      const result = await rekognitionSvc.verifyAccess();
      const integration = await integrationSvc.recordVerification('aws_rekognition', { ...result, eventType: 'integration.rekognition.access_verified', message: 'Amazon Rekognition access verified with the built-in non-customer fixture.' }, actorId(req));
      return res.json({ ok: true, result, integration });
    } catch (error) {
      await integrationSvc.recordVerification('aws_rekognition', { ok: false, eventType: 'integration.rekognition.access_failed', message: 'Amazon Rekognition access verification failed.' }, actorId(req)).catch(() => {});
      return sendError(res, error);
    }
  });

  router.get('/api/divedeep/image-analysis/profiles', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, profiles: await imageAnalysisSvc.listProfiles(), presentationContract: imageAnalysisSvc.presentationContract() }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/image-analysis/profiles', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.image_analysis.profile.create', entityType: 'image_analysis_profile', entityId: 'new' };
      const profile = await imageAnalysisSvc.createProfile(req.body || {}, actorId(req));
      req.sentinelControl.entityId = profile.id;
      return res.status(201).json({ ok: true, profile });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/image-analysis/profiles/:profileId/versions', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.image_analysis.version.create', entityType: 'image_analysis_profile', entityId: req.params.profileId };
      return res.status(201).json({ ok: true, version: await imageAnalysisSvc.createProfileVersion(req.params.profileId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/image-analysis/profile-versions/:versionId', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.image_analysis.version.update', entityType: 'image_analysis_profile_version', entityId: req.params.versionId };
      return res.json({ ok: true, version: await imageAnalysisSvc.updateProfileVersion(req.params.versionId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/image-analysis/profile-versions/:versionId/publish', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.image_analysis.version.publish', entityType: 'image_analysis_profile_version', entityId: req.params.versionId };
      return res.json({ ok: true, version: await imageAnalysisSvc.publishProfileVersion(req.params.versionId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/catalog/package-versions/:versionId/image-analysis', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, imageAnalysis: await imageAnalysisSvc.getPackageProfile(req.params.versionId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.put('/api/divedeep/catalog/package-versions/:versionId/image-analysis', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.image_analysis.package_link.update', entityType: 'package_version', entityId: req.params.versionId };
      const imageAnalysis = await imageAnalysisSvc.setPackageProfile(req.params.versionId, req.body?.profileVersionId, req.body?.required, actorId(req));
      return res.json({ ok: true, imageAnalysis });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/image-analysis/preview-manifest', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.image_analysis.manifest.preview', entityType: 'image_analysis_profile', entityId: 'preview' };
      return res.json({ ok: true, manifest: imageAnalysisSvc.previewManifest(req.body || {}) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/image-analysis/presentation-contract', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, contract: imageAnalysisSvc.presentationContract() }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/image-analysis/sessions', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.image_analysis.session.create', entityType: 'image_analysis_session', entityId: 'new' };
      const session = await imageAnalysisSvc.createSession(req.body || {}, actorId(req));
      req.sentinelControl.entityId = session.id;
      return res.status(201).json({ ok: true, session });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/image-analysis/sessions/:sessionId/items', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.image_analysis.item.ingest', entityType: 'image_analysis_session', entityId: req.params.sessionId };
      const item = await imageAnalysisSvc.upsertAnalysisItem(req.params.sessionId, req.body || {}, { type: 'system', id: actorId(req) });
      return res.status(201).json({ ok: true, item });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/image-analysis/sessions/:sessionId/presentation', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, feed: await imageAnalysisSvc.getPresentationFeed(req.params.sessionId, { customerSafe: req.query.customerSafe === 'true' }) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/image-analysis/items/:itemId/disposition', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: `divedeep.image_analysis.item.${String(req.body?.action || 'review')}`, entityType: 'image_analysis_item', entityId: req.params.itemId };
      const item = await imageAnalysisSvc.reviewItem(req.params.itemId, req.body?.action, req.body || {}, actorId(req));
      const session = await imageAnalysisSvc.getSession(item.sessionId);
      if (session.customerId) await workflowSvc.reconcileReviewTasks(session.customerId, actorId(req));
      return res.json({ ok: true, item });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/catalog', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, catalog: await catalogSvc.getCatalogBundle(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/catalog/resources/:resourceId/revisions', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, revisions: await catalogSvc.listResourceRevisions(req.params.resourceId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/packages/:packageId/source-manifest', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, manifest: await catalogSvc.resolvePackageSourceManifest(req.params.packageId, req.query.version) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/catalog/schemas', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.schema.create', entityType: 'metadata_schema', entityId: 'new' };
      const schema = await catalogSvc.createMetadataSchema(req.body || {}, actorId(req));
      req.sentinelControl.entityId = schema.id;
      return res.status(201).json({ ok: true, schema });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/catalog/schemas/:schemaId', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.schema.update', entityType: 'metadata_schema', entityId: req.params.schemaId };
      return res.json({ ok: true, schema: await catalogSvc.updateMetadataSchema(req.params.schemaId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/catalog/resources', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.resource.create', entityType: 'catalog_resource', entityId: 'new' };
      const resource = await catalogSvc.createResource(req.body || {}, actorId(req));
      req.sentinelControl.entityId = resource.id;
      return res.status(201).json({ ok: true, resource });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/catalog/resources/:resourceId', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.resource.update', entityType: 'catalog_resource', entityId: req.params.resourceId };
      return res.json({ ok: true, resource: await catalogSvc.updateResource(req.params.resourceId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/catalog/pools', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.pool.create', entityType: 'catalog_pool', entityId: 'new' };
      const pool = await catalogSvc.createPool(req.body || {}, actorId(req));
      req.sentinelControl.entityId = pool.id;
      return res.status(201).json({ ok: true, pool });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/catalog/pools/:poolId/versions', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.pool_version.create', entityType: 'catalog_pool', entityId: req.params.poolId };
      return res.status(201).json({ ok: true, version: await catalogSvc.createPoolVersion(req.params.poolId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/catalog/pool-versions/:versionId', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.pool_version.update', entityType: 'catalog_pool_version', entityId: req.params.versionId };
      return res.json({ ok: true, version: await catalogSvc.updatePoolVersion(req.params.versionId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.put('/api/divedeep/catalog/pool-versions/:versionId/members', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.pool_members.replace', entityType: 'catalog_pool_version', entityId: req.params.versionId };
      return res.json({ ok: true, result: await catalogSvc.replacePoolMembers(req.params.versionId, req.body?.members || [], actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/catalog/pool-versions/:versionId/publish', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.pool_version.publish', entityType: 'catalog_pool_version', entityId: req.params.versionId };
      return res.json({ ok: true, version: await catalogSvc.publishPoolVersion(req.params.versionId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/catalog/source-sets', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.source_set.create', entityType: 'source_set', entityId: 'new' };
      const sourceSet = await catalogSvc.createSourceSet(req.body || {}, actorId(req));
      req.sentinelControl.entityId = sourceSet.id;
      return res.status(201).json({ ok: true, sourceSet });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/catalog/source-sets/:sourceSetId/versions', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.source_set_version.create', entityType: 'source_set', entityId: req.params.sourceSetId };
      return res.status(201).json({ ok: true, version: await catalogSvc.createSourceSetVersion(req.params.sourceSetId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/catalog/source-set-versions/:versionId', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.source_set_version.update', entityType: 'source_set_version', entityId: req.params.versionId };
      return res.json({ ok: true, version: await catalogSvc.updateSourceSetVersion(req.params.versionId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.put('/api/divedeep/catalog/source-set-versions/:versionId/links', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.source_set_links.replace', entityType: 'source_set_version', entityId: req.params.versionId };
      return res.json({ ok: true, result: await catalogSvc.replaceSourceSetLinks(req.params.versionId, req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/catalog/source-set-versions/:versionId/publish', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.source_set_version.publish', entityType: 'source_set_version', entityId: req.params.versionId };
      return res.json({ ok: true, version: await catalogSvc.publishSourceSetVersion(req.params.versionId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/catalog/packages/:packageId/versions', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.package_version.create', entityType: 'package', entityId: req.params.packageId };
      const version = await catalogSvc.createPackageVersion(req.params.packageId, req.body || {}, actorId(req));
      return res.status(201).json({ ok: true, version });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/catalog/package-versions/:versionId/publish', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.catalog.package_version.publish', entityType: 'package_version', entityId: req.params.versionId };
      return res.json({ ok: true, version: await catalogSvc.publishPackageVersion(req.params.versionId, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/customers/:customerId', requireAdminRole, async (req, res) => {
    try {
      const dashboard = await svc.getCustomerDashboard(req.params.customerId, null, { includeUnpublished: true });
      return res.json({ ok: true, dashboard });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/customers/:customerId', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      const customer = await svc.adminUpdateCustomer(req.params.customerId, req.body || {}, actorId(req));
      return res.json({ ok: true, customer });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/customers/:customerId/export', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      let configuredFormat = 'json';
      try {
        const exportIntegration = await integrationSvc.getRuntimeIntegration('divedeep_export');
        configuredFormat = exportIntegration?.config?.defaultFormat || configuredFormat;
      } catch { /* deployment may be waiting for schema migration */ }
      const format = String(req.query.format || configuredFormat).toLowerCase();
      const file = await svc.exportCustomerPacket(req.params.customerId, format);
      const customer = await svc.getCustomerById(req.params.customerId);
      const slug = String(customer.displayName || customer.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || customer.id;
      res.type(file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="divedeep-${slug}.${file.extension}"`);
      return res.send(file.body);
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/customers/:customerId/import-batches', requireRootRole, async (req, res) => {
    try { return res.json({ ok: true, batches: await importSvc.listImportBatches(req.params.customerId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post(
    '/api/divedeep/customers/:customerId/import-batches/upload',
    requireRootRole, requireAdminCsrf,
    express.raw({ type: () => true, limit: '150mb' }),
    async (req, res) => {
      try {
        req.sentinelOmitBodies = true;
        req.sentinelControl = { action: 'divedeep.segmented_import.bundle_queued', entityType: 'customer', entityId: req.params.customerId };
        const batch = await importSvc.enqueueImportBundle(req.params.customerId, req.body, actorId(req));
        return res.status(202).json({ ok: true, batch, message: 'Package uploaded. Background import has started.' });
      } catch (error) { return sendError(res, error); }
    }
  );

  router.post('/api/divedeep/customers/:customerId/import-batches', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelOmitBodies = true;
      req.sentinelControl = { action: 'divedeep.segmented_import.create', entityType: 'customer', entityId: req.params.customerId };
      const batch = await importSvc.createImportBatch(req.params.customerId, req.body?.manifest, req.body?.manifestSha256, actorId(req));
      return res.status(201).json({ ok: true, batch });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/customers/:customerId/import-batches/:batchId', requireRootRole, async (req, res) => {
    try { return res.json({ ok: true, batch: await importSvc.batchDetail(req.params.customerId, req.params.batchId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/customers/:customerId/import-batches/:batchId/status', requireRootRole, async (req, res) => {
    try { return res.json({ ok: true, batch: await importSvc.importBatchStatus(req.params.customerId, req.params.batchId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/import-batches/:batchId/parts/:partNumber', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelOmitBodies = true;
      req.sentinelControl = { action: 'divedeep.segmented_import.part', entityType: 'import_batch', entityId: req.params.batchId };
      const result = await importSvc.importBatchPart(
        req.params.customerId, req.params.batchId, req.params.partNumber, req.body || {}, req.rawBody, req.get('x-divedeep-file-sha256'), actorId(req)
      );
      const errorCount = Number(result.result?.errorCount ?? result.result?.errors?.length) || 0;
      const importedCount = Array.isArray(result.result?.imported) ? result.result.imported.length : 0;
      const status = errorCount ? (importedCount ? 207 : 422) : 200;
      const error = errorCount
        ? importedCount
          ? `${errorCount} finding${errorCount === 1 ? '' : 's'} failed while ${importedCount} imported`
          : `All ${errorCount} findings in this result part failed`
        : undefined;
      const code = errorCount ? (importedCount ? 'DIVEDEEP_IMPORT_PART_PARTIAL_FAILURE' : 'DIVEDEEP_IMPORT_PART_FINDINGS_FAILED') : undefined;
      return res.status(status).json({ ok: errorCount === 0, ...(error ? { error, code } : {}), ...result });
    } catch (error) { return sendError(res, error); }
  });

  router.post(
    '/api/divedeep/customers/:customerId/import-batches/:batchId/evidence/:evidenceId',
    requireRootRole, requireAdminCsrf,
    express.raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      try {
        req.sentinelOmitBodies = true;
        req.sentinelControl = { action: 'divedeep.segmented_import.evidence', entityType: 'import_batch', entityId: req.params.batchId };
        const batch = await importSvc.uploadBatchEvidence(req.params.customerId, req.params.batchId, req.params.evidenceId, {
          buffer: req.body,
          mimeType: req.get('content-type'),
          sha256: req.get('x-divedeep-file-sha256'),
          originalName: req.get('x-divedeep-file-name'),
          capturedAt: req.get('x-divedeep-captured-at'),
          label: req.get('x-divedeep-evidence-type'),
        }, actorId(req));
        return res.status(201).json({ ok: true, batch });
      } catch (error) { return sendError(res, error); }
    }
  );

  router.post('/api/divedeep/customers/:customerId/import-batches/:batchId/resume', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.segmented_import.resume', entityType: 'import_batch', entityId: req.params.batchId };
      const batch = await importSvc.resumeImportBundleJob(req.params.customerId, req.params.batchId, actorId(req));
      return res.status(202).json({ ok: true, batch });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/import-batches/:batchId/finalize', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      const batch = await importSvc.finalizeImportBatch(req.params.customerId, req.params.batchId, actorId(req));
      return res.json({ ok: true, batch });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/import-batches/:batchId/publish', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      const batch = await importSvc.publishImportBatch(req.params.customerId, req.params.batchId, req.body || {}, actorId(req));
      return res.json({ ok: true, batch });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/import-batches/:batchId/cancel', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      const batch = await importSvc.cancelImportBatch(req.params.customerId, req.params.batchId, actorId(req));
      return res.json({ ok: true, batch });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/customers/:customerId/findings/publication', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      const result = await importSvc.setFindingsPublication(req.params.customerId, req.body?.exposureIds, req.body?.publicationStatus, actorId(req));
      return res.json({ ok: true, ...result });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/customers/:customerId/findings/:exposureId/publication', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      const result = await importSvc.setFindingPublication(req.params.customerId, req.params.exposureId, req.body?.publicationStatus, actorId(req));
      return res.json({ ok: true, ...result });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/customers/:customerId/evidence/:evidenceId', requireRootRole, async (req, res) => {
    try {
      const { evidence, buffer } = await importSvc.readEvidenceFile(req.params.customerId, req.params.evidenceId, { includeUnpublished: true });
      res.type(evidence.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="divedeep-evidence-${evidence.id}"`);
      return res.send(buffer);
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/import-batches/cleanup', requireRootRole, requireAdminCsrf, async (req, res) => {
    try { return res.json({ ok: true, cleanup: await importSvc.cleanupExpiredImports() }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/divedeep-results', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelOmitBodies = true;
      req.sentinelControl = { action: 'divedeep.divedeep_results.import', entityType: 'customer', entityId: req.params.customerId };
      const result = await svc.importDiveDeepResultPacket(req.params.customerId, req.body || {}, actorId(req));
      return res.status(result.errors.length ? 207 : 200).json({ ok: result.errors.length === 0, ...result });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/findings', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      const result = await svc.adminAddFinding(req.params.customerId, req.body || {}, actorId(req));
      return res.status(201).json({ ok: true, ...result });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/customers/:customerId/findings/:exposureId', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      const exposure = await svc.adminUpdateFinding(
        req.params.customerId, req.params.exposureId, req.body || {}, actorId(req)
      );
      await workflowSvc.reconcileReviewTasks(req.params.customerId, actorId(req));
      return res.json({ ok: true, exposure });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/divedeep/customers/:customerId/cases/:caseId', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      const privacyCase = await svc.adminTransitionPrivacyCase(
        req.params.customerId, req.params.caseId, req.body || {}, actorId(req)
      );
      await workflowSvc.evaluateCustomer(req.params.customerId, actorId(req));
      return res.json({ ok: true, case: privacyCase });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/customers/:customerId/cases/:caseId/verifications', requireAdminRole, requireAdminCsrf, async (req, res) => {
    try {
      const verification = await svc.adminVerifyPrivacyCase(
        req.params.customerId, req.params.caseId, req.body || {}, actorId(req)
      );
      await workflowSvc.evaluateCustomer(req.params.customerId, actorId(req));
      return res.status(201).json({ ok: true, verification });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/customers/:customerId/photos/:photoId', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      const { photo, buffer } = await svc.readProfilePhoto(req.params.customerId, req.params.photoId);
      res.type(photo.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="divedeep-${photo.id}"`);
      return res.send(buffer);
    } catch (error) { return sendError(res, error); }
  });


  // Phase 10 production readiness and controlled rollout control plane.
  // These endpoints expose operational metadata only; no evidence, raw artifacts,
  // worker payloads, credentials, or customer-private case content are returned.
  router.get('/api/divedeep/production-readiness', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, readiness: await productionReadinessSvc.getProductionReadinessOverview() }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/production-readiness/checks', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, checks: await productionReadinessSvc.listReadinessChecks(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/production-readiness/checks', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelOmitBodies = true;
      req.sentinelControl = { action: 'divedeep.production_readiness.check.record', entityType: 'divedeep_release_check', entityId: 'new' };
      const check = await productionReadinessSvc.recordReadinessCheck(req.body || {}, actorId(req));
      req.sentinelControl.entityId = check.id;
      return res.status(201).json({ ok: true, check });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/production-readiness/rollout', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelOmitBodies = true;
      req.sentinelControl = { action: 'divedeep.rollout.stage.change', entityType: 'divedeep_rollout', entityId: String(req.body?.stage || 'unknown') };
      return res.json({ ok: true, rollout: await productionReadinessSvc.setRolloutStage(req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/production-readiness/assignments', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelOmitBodies = true;
      req.sentinelControl = { action: 'divedeep.rollout.customer.assign', entityType: 'customer', entityId: String(req.body?.customerId || 'unknown') };
      return res.status(201).json({ ok: true, assignment: await productionReadinessSvc.assignCustomerToRollout(req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/production-readiness/disaster-recovery', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelOmitBodies = true;
      req.sentinelControl = { action: 'divedeep.disaster_recovery.rehearsal.record', entityType: 'divedeep_dr_rehearsal', entityId: 'new' };
      const rehearsal = await productionReadinessSvc.recordDisasterRecoveryRehearsal(req.body || {}, actorId(req));
      req.sentinelControl.entityId = rehearsal.id;
      return res.status(201).json({ ok: true, rehearsal });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/divedeep/production-readiness/providers', requireRootRole, requireAdminCsrf, async (req, res) => {
    try {
      req.sentinelOmitBodies = true;
      req.sentinelControl = { action: 'divedeep.example.invalidpute_provider.readiness.record', entityType: 'compute_provider', entityId: String(req.body?.provider || 'unknown') };
      return res.json({ ok: true, provider: await productionReadinessSvc.recordProviderReadiness(req.body || {}, actorId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/divedeep/production-readiness/throughput-cost', requireAdminRole, async (req, res) => {
    try { return res.json({ ok: true, review: await productionReadinessSvc.throughputAndCostReview(req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = { createAdminDiveDeepRouter };
