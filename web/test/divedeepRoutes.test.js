const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { createDiveDeepRouter } = require('../src/routes/diveDeep');

const customer = {
  id: 'customer-1', email: 'alpha@example.com', firstName: 'Alpha', lastName: 'Tester',
  displayName: 'Alpha Tester', planTier: 'deep', status: 'active', workflowStatus: 'onboarding',
};
const dashboard = {
  customer, authorization: null, profile: null, connections: [], photos: [], exposures: [], cases: [], events: [],
  stats: { found: 0, stillPresent: 0, requestsSent: 0, removed: 0 },
};
const calls = [];
const authorization = { id: 'authorization-1', customerId: customer.id, status: 'active', signerName: 'Alpha Tester', signedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
const authorizationService = {
  getLatestAuthorization: async () => null,
  signAuthorization: async (id, body, context) => { calls.push(['authorization.sign', id, body, context]); return authorization; },
  revokeAuthorization: async (id, body, context) => { calls.push(['authorization.revoke', id, body, context]); return { ...authorization, status: 'revoked' }; },
  readAuthorizationDocument: async () => ({ id: authorization.id, html: '<!doctype html><title>Executed authorization</title>', sha256: 'a'.repeat(64) }),
};
const service = {
  registerCustomer: async (body) => { calls.push(['signup', body]); return customer; },
  authenticateCustomer: async (email) => { calls.push(['login', email]); return customer; },
  getCustomerById: async () => customer,
  getCustomerDashboard: async () => dashboard,
  completeOnboarding: async (id, body) => { calls.push(['onboarding', id, body]); return { ...dashboard, profile: { id: 'profile-1', identifiers: [], policies: [] } }; },
  addIdentifier: async () => ({ id: 'identifier-1' }),
  setVisibilityPolicy: async () => ({ id: 'policy-1' }),
  createSocialConnection: async () => ({ id: 'connection-1' }),
  setSocialConnectionProtection: async () => ({ connection: { id: 'connection-1', protectedFromRemoval: true }, policy: { id: 'policy-social-1' } }),
  disconnectSocialConnection: async () => ({ id: 'connection-1', status: 'disconnected' }),
  listSocialMediaItems: async () => [{ id: 'media-1', provider: 'facebook', itemType: 'image' }],
  updateCustomerPlan: async () => customer,
  addProfilePhoto: async () => ({ id: 'photo-1' }),
  readProfilePhoto: async () => ({ photo: { id: 'photo-1', mimeType: 'image/jpeg' }, buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }),
  removeProfilePhoto: async () => ({ ok: true }),
  saveFacebookConnection: async () => ({ id: 'facebook-1' }),
};

async function request(base, pathname, options = {}, cookie = '') {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(base + pathname, { ...options, headers, redirect: 'manual' });
  return response;
}

async function run() {
  process.env.DIVEDEEP_SIGNUPS_ENABLED = 'true';
  process.env.DIVEDEEP_AUTO_APPROVE = 'true';
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'divedeep-route-test-secret-000000000000', resave: false, saveUninitialized: false }));
  app.get('/test/set-admin', (req, res) => { req.session.admin = { id: 'admin-keep' }; req.session.save(() => res.json({ ok: true })); });
  app.get('/test/session', (req, res) => res.json({ admin: req.session.admin || null, customer: req.session.diveDeepCustomer || null }));
  app.use('/divedeep', createDiveDeepRouter({ service, authorizationService }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const configResponse = await request(base, '/divedeep/api/config');
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.equal(config.config.plans.length, 4);
    assert.equal(config.config.plans[2].id, 'sensitive');
    assert.equal(config.config.plans[3].id, 'image');
    assert.equal(config.config.plans[3].monthlyPrice, 0);

    const signupResponse = await request(base, '/divedeep/api/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alpha@example.com', password: 'long-password-value', termsAccepted: true, noticeAcknowledged: true }),
    });
    assert.equal(signupResponse.status, 201);
    assert.equal(signupResponse.headers.get('cache-control'), 'no-store, max-age=0');
    const setCookie = signupResponse.headers.get('set-cookie');
    assert.ok(setCookie);
    const cookie = setCookie.split(';')[0];
    const signup = await signupResponse.json();
    assert.ok(signup.csrfToken);

    const sessionResponse = await request(base, '/divedeep/api/session', {}, cookie);
    assert.equal(sessionResponse.status, 200);
    assert.equal((await sessionResponse.json()).authenticated, true);

    const signed = await request(base, '/divedeep/api/authorization', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DiveDeep-CSRF': signup.csrfToken, 'User-Agent': 'DiveDeep route test' },
      body: JSON.stringify({ legalName: 'Alpha Tester', typedSignature: 'Alpha Tester', signatureIntent: true }),
    }, cookie);
    assert.equal(signed.status, 201);
    assert.equal((await signed.json()).authorization.id, authorization.id);
    const signedCall = calls.find((item) => item[0] === 'authorization.sign');
    assert.equal(signedCall[1], customer.id);
    assert.equal(signedCall[2].legalName, 'Alpha Tester');
    assert.equal(signedCall[3].userAgent, 'DiveDeep route test');

    const documentResponse = await request(base, `/divedeep/api/authorization/${authorization.id}/document`, {}, cookie);
    assert.equal(documentResponse.status, 200);
    assert.match(documentResponse.headers.get('content-disposition'), /divedeep-authorization-authorization-1\.html/);
    assert.match(await documentResponse.text(), /Executed authorization/);

    const denied = await request(base, '/divedeep/api/onboarding', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ legalName: 'Alpha Tester' }),
    }, cookie);
    assert.equal(denied.status, 403);

    const onboarded = await request(base, '/divedeep/api/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DiveDeep-CSRF': signup.csrfToken },
      body: JSON.stringify({ legalName: 'Alpha Tester', usernames: 'alpha' }),
    }, cookie);
    assert.equal(onboarded.status, 201);
    assert.equal((await onboarded.json()).dashboard.profile.id, 'profile-1');
    assert.equal(calls.find((item) => item[0] === 'onboarding')[1], customer.id);

    const mediaResponse = await request(base, '/divedeep/api/connections/media?provider=facebook&itemType=image', {}, cookie);
    assert.equal(mediaResponse.status, 200);
    assert.equal((await mediaResponse.json()).items[0].id, 'media-1');

    const protectionResponse = await request(base, '/divedeep/api/connections/connection-1/protection', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-DiveDeep-CSRF': signup.csrfToken },
      body: JSON.stringify({ protected: true }),
    }, cookie);
    assert.equal(protectionResponse.status, 200);
    assert.equal((await protectionResponse.json()).connection.protectedFromRemoval, true);

    const setAdmin = await request(base, '/test/set-admin', {}, cookie);
    assert.equal(setAdmin.status, 200);
    const logout = await request(base, '/divedeep/api/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DiveDeep-CSRF': signup.csrfToken }, body: '{}',
    }, cookie);
    assert.equal(logout.status, 200);
    const afterLogout = await request(base, '/test/session', {}, cookie);
    const after = await afterLogout.json();
    assert.equal(after.customer, null);
    assert.equal(after.admin.id, 'admin-keep', 'customer logout must not destroy an administrator session sharing the cookie');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('DiveDeep customer route tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
