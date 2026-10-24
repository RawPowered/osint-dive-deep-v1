const externalApi = require('../services/diveDeepExternalApi');

function apiVersion(req, res, next) {
  res.setHeader('X-DiveDeep-API-Version', externalApi.API_VERSION);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Authorization');
  return next();
}

function identityRateLimit(dependencies = {}) {
  const service = dependencies.service || externalApi;
  return async function phase9RateLimit(req, res, next) {
    try {
      const identity = req.serviceIdentity;
      if (!identity) return res.status(500).json({ error: 'Rate limit identity is unavailable', code: 'DIVEDEEP_RATE_IDENTITY_MISSING' });
      const result = await service.consumeRateLimit(identity);
      res.setHeader('RateLimit-Limit', String(result.limit));
      res.setHeader('RateLimit-Remaining', String(result.remaining));
      res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetAt.getTime() / 1000)));
      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.max(Math.ceil((result.resetAt.getTime() - Date.now()) / 1000), 1)));
        return res.status(429).json({ error: 'Rate limit exceeded', code: 'DIVEDEEP_RATE_LIMIT_EXCEEDED' });
      }
      return next();
    } catch (error) {
      return res.status(503).json({ error: 'Rate limit service is temporarily unavailable', code: 'DIVEDEEP_RATE_LIMIT_UNAVAILABLE' });
    }
  };
}

function requireIdempotency(dependencies = {}) {
  const service = dependencies.service || externalApi;
  return async function phase9Idempotency(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    try {
      const scope = `${req.method} ${req.baseUrl || ''}${req.path || '/'}`;
      const record = await service.beginIdempotency(
        req.serviceIdentity.id,
        scope,
        req.get('idempotency-key'),
        req.body == null ? null : req.body
      );
      if (record.replay) {
        res.setHeader('Idempotency-Replayed', 'true');
        return res.status(record.status).json(record.response);
      }
      req.idempotencyRecord = record;
      const originalJson = res.json.bind(res);
      let completed = false;
      res.json = function idempotentJson(body) {
        if (completed) return originalJson(body);
        completed = true;
        Promise.resolve(service.completeIdempotency(record.id, res.statusCode, body))
          .catch(() => {})
          .finally(() => originalJson(body));
        return res;
      };
      return next();
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Idempotency control failed', code: error.code || 'DIVEDEEP_IDEMPOTENCY_ERROR' });
    }
  };
}

module.exports = { apiVersion, identityRateLimit, requireIdempotency };
