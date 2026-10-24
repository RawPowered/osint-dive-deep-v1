const tokens = require('../services/diveDeepWorkerTokens');
const runtime = require('../services/diveDeepWorkerRuntime');

function sendError(res, error) {
  return res.status(error.status || 401).json({
    error: error.status ? error.message : 'Worker authentication failed',
    code: error.code || 'DIVEDEEP_WORKER_AUTH_FAILED',
  });
}

async function requireDiveDeepWorker(req, res, next) {
  try {
    const token = tokens.bearerToken(req);
    if (!token) throw Object.assign(new Error('Worker bearer token is required'), { status: 401, code: 'DIVEDEEP_WORKER_TOKEN_REQUIRED' });
    const claims = tokens.verifyWorkerToken(token);
    req.diveDeepWorker = await runtime.authenticateClaims(claims);
    req.sentinelApi = {
      action: `divedeep.worker.${String(req.method || 'GET').toLowerCase()}`,
      entityType: 'recon_job',
      entityId: claims.jobId,
    };
    req.sentinelOmitBodies = true;
    return next();
  } catch (error) { return sendError(res, error); }
}

module.exports = { requireDiveDeepWorker };
