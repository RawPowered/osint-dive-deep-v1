'use strict';
const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;

function routerStub() {
  const routes = [];
  return {
    routes,
    use(...args) { routes.push(['use', ...args]); return this; },
    get(...args) { routes.push(['get', ...args]); return this; },
    post(...args) { routes.push(['post', ...args]); return this; },
    put(...args) { routes.push(['put', ...args]); return this; },
    patch(...args) { routes.push(['patch', ...args]); return this; },
    delete(...args) { routes.push(['delete', ...args]); return this; },
  };
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'express') return { Router: routerStub };
  if (request === 'express-rate-limit') {
    return { rateLimit: (options) => function limiter(req, res, next) { return next(); }, ipKeyGenerator: (ip) => String(ip || '') };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { createDiveDeepCustomerV1Router } = require('../src/routes/api/diveDeepCustomerV1');
  const { createDiveDeepEnterpriseV1Router } = require('../src/routes/api/diveDeepEnterpriseV1');
  const { createDiveDeepIntegrationsV1Router } = require('../src/routes/api/diveDeepIntegrationsV1');
  const mock = {
    verifyBearerCredential: async () => null,
    consumeRateLimit: async () => ({ allowed: true, limit: 1, remaining: 0, resetAt: new Date() }),
  };
  const customer = createDiveDeepCustomerV1Router({ service: mock });
  const enterprise = createDiveDeepEnterpriseV1Router({ service: mock });
  const integrations = createDiveDeepIntegrationsV1Router({ service: mock });
  assert.ok(customer.routes.some((route) => route[0] === 'get' && route[1] === '/jobs'));
  assert.ok(enterprise.routes.some((route) => route[0] === 'get' && route[1] === '/coverage'));
  assert.ok(integrations.routes.some((route) => route[0] === 'post' && route[1] === '/oauth/token'));
  assert.ok(integrations.routes.some((route) => route[0] === 'post' && route[1] === '/events'));
  console.log('DiveDeep Phase 9 router construction checks passed');
} finally {
  Module._load = originalLoad;
}
