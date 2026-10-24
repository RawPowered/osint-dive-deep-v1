const express = require('express');
const externalApi = require('../../services/diveDeepExternalApi');
const { requireServiceIdentity, requireCustomerTenant, requireScopes } = require('../../middleware/diveDeepExternalApiAuth');
const { apiVersion, identityRateLimit } = require('../../middleware/diveDeepExternalApiControls');

function sendError(res, error) {
  return res.status(error.status || 500).json({
    error: error.status ? error.message : 'Customer API operation failed',
    code: error.code || 'DIVEDEEP_CUSTOMER_API_ERROR',
  });
}

function createDiveDeepCustomerV1Router(dependencies = {}) {
  const service = dependencies.service || externalApi;
  const router = express.Router();
  router.use(apiVersion);
  router.use(requireServiceIdentity({ identityTypes: ['customer'] }, { service }));
  router.use(identityRateLimit({ service }));
  router.use(requireCustomerTenant);

  router.get('/', (req, res) => res.json({
    ok: true,
    api: 'DiveDeep Customer API',
    version: externalApi.API_VERSION,
    tenantId: req.diveDeepTenantId,
    resources: ['me', 'jobs', 'reports/removals', 'reports/monitoring'],
  }));

  router.get('/me', requireScopes('customer:read'), async (req, res) => {
    try { return res.json({ ok: true, customer: await service.customerSummary(req.diveDeepTenantId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/jobs', requireScopes('jobs:read'), async (req, res) => {
    try { return res.json({ ok: true, jobs: await service.listSafeJobs(req.diveDeepTenantId, req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/jobs/:jobId', requireScopes('jobs:read'), async (req, res) => {
    try { return res.json({ ok: true, job: await service.getSafeJob(req.diveDeepTenantId, req.params.jobId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/reports/removals', requireScopes('reports:read'), async (req, res) => {
    try { return res.json({ ok: true, report: await service.removalReport(req.diveDeepTenantId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/reports/monitoring', requireScopes('reports:read'), async (req, res) => {
    try { return res.json({ ok: true, report: await service.monitoringReport(req.diveDeepTenantId) }); }
    catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = { createDiveDeepCustomerV1Router };
