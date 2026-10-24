const externalApi = require('../services/diveDeepExternalApi');

function bearerToken(req) {
  const value = String(req.get('authorization') || '').trim();
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

function sendError(res, error) {
  return res.status(error.status || 500).json({
    error: error.status ? error.message : 'External API authentication failed',
    code: error.code || 'DIVEDEEP_EXTERNAL_API_AUTH_FAILED',
  });
}

function requireServiceIdentity(options = {}, dependencies = {}) {
  const service = dependencies.service || externalApi;
  const allowedTypes = new Set(options.identityTypes || []);
  const requiredScopes = new Set(options.scopes || []);
  return async function serviceIdentityMiddleware(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    try {
      const token = bearerToken(req);
      if (!token) throw Object.assign(new Error('Bearer credential is required'), { status: 401, code: 'DIVEDEEP_SERVICE_CREDENTIAL_REQUIRED' });
      const identity = await service.verifyBearerCredential(token);
      if (!identity) throw Object.assign(new Error('Service credential is invalid or expired'), { status: 401, code: 'DIVEDEEP_SERVICE_CREDENTIAL_INVALID' });
      if (allowedTypes.size && !allowedTypes.has(identity.identityType)) {
        throw Object.assign(new Error('Service identity is not permitted on this API surface'), { status: 403, code: 'DIVEDEEP_API_SURFACE_DENIED' });
      }
      const scopes = new Set(identity.scopes || []);
      for (const scope of requiredScopes) {
        if (!scopes.has(scope)) throw Object.assign(new Error(`Missing required scope: ${scope}`), { status: 403, code: 'DIVEDEEP_SCOPE_REQUIRED' });
      }
      req.serviceIdentity = identity;
      req.apiKey = { id: identity.id, key_prefix: identity.keyPrefix || identity.oauthClientId || null };
      req.sentinelOmitBodies = true;
      return next();
    } catch (error) {
      return sendError(res, error);
    }
  };
}

function requireScopes(...scopes) {
  return (req, res, next) => {
    const granted = new Set(req.serviceIdentity?.scopes || []);
    const missing = scopes.filter((scope) => !granted.has(scope));
    if (missing.length) return res.status(403).json({ error: `Missing required scope: ${missing[0]}`, code: 'DIVEDEEP_SCOPE_REQUIRED' });
    return next();
  };
}

function requireCustomerTenant(req, res, next) {
  const customerId = req.serviceIdentity?.customerId;
  if (!customerId) return res.status(403).json({ error: 'Customer tenant scope is required', code: 'DIVEDEEP_TENANT_SCOPE_REQUIRED' });
  req.diveDeepTenantId = customerId;
  return next();
}

function requireEnterpriseOrganization(req, res, next) {
  const organizationId = req.serviceIdentity?.organizationId;
  if (!organizationId) return res.status(403).json({ error: 'Enterprise organization scope is required', code: 'DIVEDEEP_ORGANIZATION_SCOPE_REQUIRED' });
  req.diveDeepOrganizationId = organizationId;
  return next();
}

module.exports = { bearerToken, requireServiceIdentity, requireScopes, requireCustomerTenant, requireEnterpriseOrganization };
