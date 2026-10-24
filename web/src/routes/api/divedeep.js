const express = require('express');
const {
  templateCatalog,
  createProtectedProfile,
  listProtectedProfiles,
  getProtectedProfile,
  addProfileIdentifier,
  upsertVisibilityPolicy,
  listSources,
  enqueueScanJob,
  listJobs,
  claimJob,
  completeJob,
  upsertExposure,
  getExposure,
  listExposures,
  updateExposureStatus,
  createCaseFromExposure,
  getCase,
  listCases,
  transitionCase,
  addVerification,
  getCaseTimeline,
  exportProfilePacket,
} = require('../../services/divedeepPrivacy');

function tenantId(req) {
  return req.apiKey && req.apiKey.id;
}

function actorId(req) {
  return req.operatorSession?.userId || req.apiKey?.id || null;
}

function context(req, action, entityType = null, entityId = null) {
  req.sentinelApi = { action, entityType, entityId };
}

function sendError(res, error) {
  return res.status(error.status || 500).json({
    success: false,
    error: error.message,
    code: error.code,
  });
}

function createDiveDeepRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    // DiveDeep requests and responses are intentionally excluded from Sentinel
    // body capture. Metadata, status, timing, tenant, and action remain auditable.
    req.sentinelOmitBodies = true;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  router.get('/templates', (req, res) => {
    context(req, 'divedeep.templates.read');
    return res.json({ success: true, templates: templateCatalog() });
  });

  router.get('/sources', async (req, res) => {
    try {
      context(req, 'divedeep.sources.read');
      const sources = await listSources(tenantId(req));
      return res.json({ success: true, sources });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/profiles', async (req, res) => {
    try {
      context(req, 'divedeep.profile.create', 'protected_profile');
      const profile = await createProtectedProfile(req.body || {}, tenantId(req), actorId(req));
      req.sentinelApi.entityId = profile.id;
      return res.status(201).json({ success: true, profile });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/profiles', async (req, res) => {
    try {
      context(req, 'divedeep.profile.list', 'protected_profile');
      const profiles = await listProtectedProfiles(tenantId(req), req.query || {});
      return res.json({ success: true, profiles });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/profiles/:profileId', async (req, res) => {
    try {
      context(req, 'divedeep.profile.read', 'protected_profile', req.params.profileId);
      const profile = await getProtectedProfile(tenantId(req), req.params.profileId);
      return res.json({ success: true, profile });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/profiles/:profileId/identifiers', async (req, res) => {
    try {
      context(req, 'divedeep.profile.identifier.create', 'protected_profile', req.params.profileId);
      const identifier = await addProfileIdentifier(tenantId(req), req.params.profileId, req.body || {}, actorId(req));
      return res.status(201).json({ success: true, identifier });
    } catch (error) { return sendError(res, error); }
  });

  router.put('/profiles/:profileId/policies', async (req, res) => {
    try {
      context(req, 'divedeep.profile.policy.upsert', 'protected_profile', req.params.profileId);
      const policy = await upsertVisibilityPolicy(tenantId(req), req.params.profileId, req.body || {}, actorId(req));
      return res.json({ success: true, policy });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/profiles/:profileId/scans', async (req, res) => {
    try {
      context(req, 'divedeep.scan.enqueue', 'protected_profile', req.params.profileId);
      await getProtectedProfile(tenantId(req), req.params.profileId);
      const job = await enqueueScanJob({
        tenantId: tenantId(req),
        profileId: req.params.profileId,
        jobType: req.body?.jobType || 'rescan',
        idempotencyKey: req.body?.idempotencyKey,
        payload: req.body?.payload || {},
        maxAttempts: req.body?.maxAttempts,
        availableAt: req.body?.availableAt,
      });
      return res.status(202).json({ success: true, job });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/jobs', async (req, res) => {
    try {
      context(req, 'divedeep.scan.list', 'scan_job');
      const jobs = await listJobs(tenantId(req), req.query || {});
      return res.json({ success: true, jobs });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/claim', async (req, res) => {
    try {
      context(req, 'divedeep.scan.claim', 'scan_job');
      const job = await claimJob(tenantId(req), req.body || {});
      if (!job) return res.status(204).end();
      req.sentinelApi.entityId = job.id;
      return res.json({ success: true, job });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/:jobId/complete', async (req, res) => {
    try {
      context(req, 'divedeep.scan.complete', 'scan_job', req.params.jobId);
      const job = await completeJob(tenantId(req), req.params.jobId, req.body || {});
      return res.json({ success: true, job });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/profiles/:profileId/exposures', async (req, res) => {
    try {
      context(req, 'divedeep.exposure.upsert', 'protected_profile', req.params.profileId);
      const exposure = await upsertExposure(tenantId(req), req.params.profileId, req.body || {}, actorId(req));
      req.sentinelApi.entityType = 'exposure';
      req.sentinelApi.entityId = exposure.id;
      return res.status(201).json({ success: true, exposure });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/exposures', async (req, res) => {
    try {
      context(req, 'divedeep.exposure.list', 'exposure');
      const exposures = await listExposures(tenantId(req), req.query || {});
      return res.json({ success: true, exposures });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/exposures/:exposureId', async (req, res) => {
    try {
      context(req, 'divedeep.exposure.read', 'exposure', req.params.exposureId);
      const exposure = await getExposure(tenantId(req), req.params.exposureId);
      return res.json({ success: true, exposure });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/exposures/:exposureId/status', async (req, res) => {
    try {
      context(req, 'divedeep.exposure.status', 'exposure', req.params.exposureId);
      const exposure = await updateExposureStatus(tenantId(req), req.params.exposureId, req.body?.status, actorId(req));
      return res.json({ success: true, exposure });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/exposures/:exposureId/cases', async (req, res) => {
    try {
      context(req, 'divedeep.case.create', 'exposure', req.params.exposureId);
      const privacyCase = await createCaseFromExposure(tenantId(req), req.params.exposureId, req.body || {}, actorId(req));
      req.sentinelApi.entityType = 'privacy_case';
      req.sentinelApi.entityId = privacyCase.id;
      return res.status(201).json({ success: true, case: privacyCase });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/cases', async (req, res) => {
    try {
      context(req, 'divedeep.case.list', 'privacy_case');
      const cases = await listCases(tenantId(req), req.query || {});
      return res.json({ success: true, cases });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/cases/:caseId', async (req, res) => {
    try {
      context(req, 'divedeep.case.read', 'privacy_case', req.params.caseId);
      const privacyCase = await getCase(tenantId(req), req.params.caseId);
      return res.json({ success: true, case: privacyCase });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/cases/:caseId/status', async (req, res) => {
    try {
      context(req, 'divedeep.case.transition', 'privacy_case', req.params.caseId);
      const privacyCase = await transitionCase(tenantId(req), req.params.caseId, req.body || {}, actorId(req));
      return res.json({ success: true, case: privacyCase });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/cases/:caseId/verifications', async (req, res) => {
    try {
      context(req, 'divedeep.case.verify', 'privacy_case', req.params.caseId);
      const verification = await addVerification(tenantId(req), req.params.caseId, req.body || {}, actorId(req));
      return res.status(201).json({ success: true, verification });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/cases/:caseId/timeline', async (req, res) => {
    try {
      context(req, 'divedeep.case.timeline', 'privacy_case', req.params.caseId);
      const events = await getCaseTimeline(tenantId(req), req.params.caseId);
      return res.json({ success: true, events });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/profiles/:profileId/export', async (req, res) => {
    try {
      context(req, 'divedeep.profile.export', 'protected_profile', req.params.profileId);
      const packet = await exportProfilePacket(tenantId(req), req.params.profileId);
      return res.json({ success: true, packet });
    } catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = { createDiveDeepRouter };
