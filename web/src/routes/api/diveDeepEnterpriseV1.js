const express = require('express');
const externalApi = require('../../services/diveDeepExternalApi');
const { requireServiceIdentity, requireEnterpriseOrganization, requireScopes } = require('../../middleware/diveDeepExternalApiAuth');
const { apiVersion, identityRateLimit } = require('../../middleware/diveDeepExternalApiControls');

function sendError(res, error) {
  return res.status(error.status || 500).json({
    error: error.status ? error.message : 'Enterprise API operation failed',
    code: error.code || 'DIVEDEEP_ENTERPRISE_API_ERROR',
  });
}

function createDiveDeepEnterpriseV1Router(dependencies = {}) {
  const service = dependencies.service || externalApi;
  const router = express.Router();
  router.use(apiVersion);
  router.use(requireServiceIdentity({ identityTypes: ['enterprise'] }, { service }));
  router.use(identityRateLimit({ service }));
  router.use(requireEnterpriseOrganization);

  router.get('/', requireScopes('enterprise:read'), async (req, res) => {
    try {
      return res.json({
        ok: true,
        api: 'DiveDeep Enterprise API',
        version: externalApi.API_VERSION,
        organization: await service.getOrganization(req.diveDeepOrganizationId),
        resources: ['coverage', 'customers', 'customers/:customerId/jobs', 'reports/removals', 'reports/monitoring'],
      });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/coverage', requireScopes('coverage:read'), async (req, res) => {
    try { return res.json({ ok: true, coverage: await service.enterpriseCoverageSummary(req.diveDeepOrganizationId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/customers', requireScopes('customers:read'), async (req, res) => {
    try { return res.json({ ok: true, customers: await service.listEnterpriseCustomers(req.diveDeepOrganizationId, req.query || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/customers/:customerId/jobs', requireScopes('jobs:read'), async (req, res) => {
    try {
      await service.assertOrganizationCustomer(req.diveDeepOrganizationId, req.params.customerId);
      return res.json({ ok: true, customerId: req.params.customerId, jobs: await service.listSafeJobs(req.params.customerId, req.query || {}) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/customers/:customerId/jobs/:jobId', requireScopes('jobs:read'), async (req, res) => {
    try {
      await service.assertOrganizationCustomer(req.diveDeepOrganizationId, req.params.customerId);
      return res.json({ ok: true, job: await service.getSafeJob(req.params.customerId, req.params.jobId) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/reports/removals', requireScopes('reports:read'), async (req, res) => {
    try { return res.json({ ok: true, report: await service.enterpriseRemovalReport(req.diveDeepOrganizationId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/reports/monitoring', requireScopes('reports:read'), async (req, res) => {
    try { return res.json({ ok: true, report: await service.enterpriseMonitoringReport(req.diveDeepOrganizationId) }); }
    catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = { createDiveDeepEnterpriseV1Router };
