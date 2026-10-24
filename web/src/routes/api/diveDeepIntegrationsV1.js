const express = require('express');
const externalApi = require('../../services/diveDeepExternalApi');
const { requireServiceIdentity, requireScopes } = require('../../middleware/diveDeepExternalApiAuth');
const { apiVersion, identityRateLimit, requireIdempotency } = require('../../middleware/diveDeepExternalApiControls');
const { externalOAuthLimiter } = require('../../middleware/rateLimit');

function oauthCredentials(req) {
  const authorization = String(req.get('authorization') || '');
  if (/^Basic\s+/i.test(authorization)) {
    try {
      const decoded = Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
    } catch { /* body credentials may still be present */ }
  }
  return {
    clientId: req.body?.client_id || req.body?.clientId,
    clientSecret: req.body?.client_secret || req.body?.clientSecret,
  };
}

function sendError(res, error) {
  return res.status(error.status || 500).json({
    error: error.status ? error.message : 'Integration API operation failed',
    code: error.code || 'DIVEDEEP_INTEGRATION_API_ERROR',
  });
}

function createDiveDeepIntegrationsV1Router(dependencies = {}) {
  const service = dependencies.service || externalApi;
  const router = express.Router();
  router.use(apiVersion);

  router.post('/oauth/token', externalOAuthLimiter, async (req, res) => {
    req.sentinelOmitBodies = true;
    try {
      const grantType = String(req.body?.grant_type || req.body?.grantType || '').trim();
      if (grantType !== 'client_credentials') return res.status(400).json({ error: 'grant_type must be client_credentials', code: 'DIVEDEEP_OAUTH_GRANT_UNSUPPORTED' });
      const credentials = oauthCredentials(req);
      const token = await service.exchangeOAuthClient({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        scope: req.body?.scope,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ access_token: token.accessToken, token_type: token.tokenType, expires_in: token.expiresIn, scope: token.scope });
    } catch (error) { return sendError(res, error); }
  });

  router.use(requireServiceIdentity({ identityTypes: ['integration'] }, { service }));
  router.use(identityRateLimit({ service }));

  router.get('/', (req, res) => res.json({
    ok: true,
    api: 'DiveDeep Integrations API',
    version: externalApi.API_VERSION,
    identity: req.serviceIdentity,
    resources: ['events', 'webhooks'],
  }));

  router.get('/webhooks', requireScopes('webhooks:read'), async (req, res) => {
    try {
      const filters = req.serviceIdentity.organizationId
        ? { organizationId: req.serviceIdentity.organizationId }
        : { customerId: req.serviceIdentity.customerId };
      return res.json({ ok: true, webhooks: await service.listWebhookSubscriptions(filters) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/events', requireScopes('integrations:events:write'), requireIdempotency({ service }), async (req, res) => {
    try {
      const event = await service.acceptExternalEvent(req.serviceIdentity, req.body || {});
      return res.status(202).json({ ok: true, event });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/webhooks', requireScopes('webhooks:write'), requireIdempotency({ service }), async (req, res) => {
    try {
      const subscriptionInput = req.serviceIdentity.organizationId
        ? { ...req.body, organizationId: req.serviceIdentity.organizationId }
        : { ...req.body, organizationId: null, customerId: req.serviceIdentity.customerId };
      const created = await service.createWebhookSubscription(subscriptionInput, req.serviceIdentity.id);
      return res.status(201).json({
        ok: true,
        webhook: created.subscription,
        signingSecret: created.signingSecret,
        warning: 'Copy this signing secret now. It will not be shown again.',
      });
    } catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = { createDiveDeepIntegrationsV1Router };
