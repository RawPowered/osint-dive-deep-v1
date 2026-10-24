const express = require('express');
const runtime = require('../../services/diveDeepWorkerRuntime');
const { requireDiveDeepWorker } = require('../../middleware/diveDeepWorkerAuth');

function sendError(res, error) {
  return res.status(error.status || 500).json({
    error: error.status ? error.message : 'DiveDeep worker operation failed',
    code: error.code || 'DIVEDEEP_WORKER_ERROR',
  });
}

function context(req) {
  return {
    ip: String(req.ip || req.socket?.remoteAddress || '').slice(0, 255),
    userAgent: String(req.get('user-agent') || '').slice(0, 500),
  };
}

function assertJob(req) {
  if (req.diveDeepWorker && req.params.jobId !== req.diveDeepWorker.jobId) {
    throw Object.assign(new Error('Worker token does not belong to this recon job'), { status: 403, code: 'DIVEDEEP_WORKER_JOB_MISMATCH' });
  }
}

function createDiveDeepWorkersRouter(dependencies = {}) {
  const router = express.Router();
  const service = { ...runtime, ...(dependencies.runtimeService || {}) };

  router.post('/register', async (req, res) => {
    try {
      req.sentinelApi = { action: 'divedeep.worker.register', entityType: 'recon_job', entityId: String(req.body?.jobId || '').slice(0, 191) };
      req.sentinelOmitBodies = true;
      const result = await service.registerWorker(req.body || {}, context(req));
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return res.status(201).json({ ok: true, ...result });
    } catch (error) { return sendError(res, error); }
  });

  router.use(requireDiveDeepWorker);

  router.get('/jobs/:jobId/manifest', async (req, res) => {
    try { assertJob(req); res.setHeader('Cache-Control', 'no-store, max-age=0'); return res.json({ ok: true, manifest: await service.getManifest(req.diveDeepWorker) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/:jobId/heartbeat', async (req, res) => {
    try { assertJob(req); return res.json(await service.heartbeat(req.diveDeepWorker, req.body || {})); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/:jobId/events', async (req, res) => {
    try { assertJob(req); return res.json({ ok: true, ...(await service.recordEvents(req.diveDeepWorker, req.body?.events || [])) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/:jobId/source-attempts', async (req, res) => {
    try { assertJob(req); return res.json({ ok: true, ...(await service.recordSourceAttempts(req.diveDeepWorker, req.body?.attempts || [])) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/jobs/:jobId/checkpoints', async (req, res) => {
    try { assertJob(req); res.setHeader('Cache-Control', 'no-store, max-age=0'); return res.json({ ok: true, ...(await service.getCheckpoints(req.diveDeepWorker)) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/:jobId/checkpoints', async (req, res) => {
    try { assertJob(req); return res.json({ ok: true, checkpoint: await service.recordCheckpoint(req.diveDeepWorker, req.body || {}) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/:jobId/candidates', async (req, res) => {
    try { assertJob(req); return res.json({ ok: true, ...(await service.submitCandidates(req.diveDeepWorker, req.body?.candidates || [])) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/jobs/:jobId/artifacts/:artifactId/download-authorization', async (req, res) => {
    try { assertJob(req); res.setHeader('Cache-Control', 'no-store, max-age=0'); return res.json({ ok: true, ...(await service.authorizeArtifactDownload(req.diveDeepWorker, req.params.artifactId)) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/:jobId/artifacts/upload-authorizations', async (req, res) => {
    try { assertJob(req); return res.status(201).json({ ok: true, ...(await service.reserveArtifact(req.diveDeepWorker, req.body || {})) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/:jobId/artifacts/:artifactId/finalize', async (req, res) => {
    try { assertJob(req); return res.json({ ok: true, artifact: await service.finalizeArtifact(req.diveDeepWorker, req.params.artifactId) }); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/:jobId/complete', async (req, res) => {
    try { assertJob(req); return res.json(await service.completeJob(req.diveDeepWorker, req.body || {})); }
    catch (error) { return sendError(res, error); }
  });

  router.post('/jobs/:jobId/cleanup', async (req, res) => {
    try { assertJob(req); return res.json(await service.acknowledgeCleanup(req.diveDeepWorker, req.body || {})); }
    catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = { createDiveDeepWorkersRouter };
