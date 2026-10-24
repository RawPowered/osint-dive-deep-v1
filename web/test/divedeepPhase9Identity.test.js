'use strict';
const assert = require('assert/strict');
const externalApi = require('../src/services/diveDeepExternalApi');
const { requireServiceIdentity, requireScopes } = require('../src/middleware/diveDeepExternalApiAuth');

assert.deepEqual(
  externalApi.normalizeScopes('customer', ['reports:read', 'jobs:read', 'jobs:read']),
  ['jobs:read', 'reports:read']
);
assert.throws(
  () => externalApi.normalizeScopes('enterprise', ['integrations:events:write']),
  (error) => error.code === 'DIVEDEEP_SCOPE_NOT_ALLOWED'
);
assert.throws(
  () => externalApi.normalizeScopes('customer', ['worker:write']),
  (error) => error.code === 'DIVEDEEP_SCOPE_NOT_ALLOWED'
);

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

(async () => {
  const enterpriseIdentity = {
    id: 'identity-1', identityType: 'enterprise', organizationId: 'org-1', customerId: null,
    scopes: ['enterprise:read'], rateLimitPerMinute: 100, keyPrefix: 'fidk_test',
  };
  const middleware = requireServiceIdentity({ identityTypes: ['customer'] }, {
    service: { verifyBearerCredential: async () => enterpriseIdentity },
  });
  const req = { method: 'GET', get: (name) => name.toLowerCase() === 'authorization' ? 'Bearer test' : '' };
  const res = responseRecorder();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'DIVEDEEP_API_SURFACE_DENIED');

  const signature = externalApi.webhookSignature('secret', '1700000000', '{"ok":true}');
  assert.match(signature, /^v1=[a-f0-9]{64}$/);

  for (const address of ['127.0.0.1', '10.20.30.40', '169.254.169.254', '192.168.1.2', '::1', 'fd00::1', '2001:db8::1']) {
    assert.equal(externalApi.isPublicIpAddress(address), false, `${address} must be blocked`);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(externalApi.isPublicIpAddress(address), true, `${address} must be public`);
  }
  assert.equal(externalApi.blockedWebhookHostname('localhost'), true);
  assert.equal(externalApi.blockedWebhookHostname('service.internal'), true);
  assert.equal(externalApi.blockedWebhookHostname('hooks.example.com'), false);
  await assert.rejects(
    () => externalApi.assertPublicWebhookEndpoint('https://webhook.example.test/events', async () => [{ address: '127.0.0.1', family: 4 }]),
    (error) => error.code === 'DIVEDEEP_WEBHOOK_ENDPOINT_BLOCKED'
  );
  assert.equal(
    await externalApi.assertPublicWebhookEndpoint('https://webhook.example.test/events', async () => [{ address: '8.8.8.8', family: 4 }]),
    'https://webhook.example.test/events'
  );

  const webhookQueries = [];
  const webhookPool = {
    async query(sql, params) {
      webhookQueries.push({ sql, params });
      if (/SELECT \* FROM divedeep_webhook_subscriptions/.test(sql)) return [[{ id: 'subscription-1', event_types_json: '["integration.sync.completed"]' }]];
      if (/INSERT INTO divedeep_webhook_deliveries/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const queued = await externalApi.enqueueWebhookEvent({
    eventType: 'integration.sync.completed',
    customerId: 'customer-1',
    payload: { status: 'complete' },
  }, webhookPool);
  assert.equal(queued.queued, 1);
  assert.match(webhookQueries[0].sql, /organization_id IS NULL AND customer_id=\?/);
  assert.deepEqual(webhookQueries[0].params, ['customer-1']);

  const scopeReq = { serviceIdentity: { scopes: ['jobs:read'] } };
  const scopeRes = responseRecorder();
  requireScopes('reports:read')(scopeReq, scopeRes, () => { throw new Error('next should not be called'); });
  assert.equal(scopeRes.statusCode, 403);
  assert.equal(scopeRes.body.code, 'DIVEDEEP_SCOPE_REQUIRED');
  console.log('DiveDeep Phase 9 service identity and scope checks passed');
})().catch((error) => { console.error(error); process.exit(1); });
