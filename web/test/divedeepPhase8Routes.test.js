'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'src/routes/adminDiveDeep.js'), 'utf8');
const customer = fs.readFileSync(path.join(root, 'src/routes/diveDeep.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'src/routes/api/crm.js'), 'utf8');
const webhook = fs.readFileSync(path.join(root, 'src/routes/crmWebhooks.js'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'src/services/diveDeepCrmIntegration.js'), 'utf8');
const hawk = fs.readFileSync(path.join(root, 'src/services/hawk.js'), 'utf8');

assert.match(app, /webhookRouter\.use\('\/crm'.*createCrmWebhookRouter/);
assert.match(server, /runCrmSweep/);
assert.match(server, /DIVEDEEP_CRM_SWEEP_ENABLED/);
assert.match(webhook, /acceptInboundWebhook/);
assert.match(customer, /claimSignupContact/);
assert.match(integration, /divedeep\.customer\.created/);
assert.match(integration, /divedeep\.crm\.contact_link\.verified/);
assert.match(customer, /divedeep\.crm\.signup_link_failed/);
for (const route of ['crm/contact-links', 'crm/events/:direction', 'crm/integrations/:integrationId/webhook', 'crm/customers/:customerId/enqueue', 'crm/sweep']) {
  assert.ok(admin.includes(route), `Missing admin CRM route ${route}`);
}
assert.match(api, /divedeep\/contact-links/);
assert.match(api, /divedeep\/customers\/:customerId\/lifecycle/);
assert.match(integration, /DIVEDEEP_CRM_CONTACT_ALREADY_LINKED/);
assert.match(integration, /DIVEDEEP_CRM_STALE_LOCK_RECOVERED/);
assert.doesNotMatch(integration, /ON DUPLICATE KEY UPDATE customer_id=VALUES\(customer_id\)/);
for (const event of ['divedeep.customer.linked', 'divedeep.customer.created', 'divedeep.lifecycle.updated', 'divedeep.onboarding.completed']) assert.ok(hawk.includes(event));
for (const field of ['customerStatus', 'workflowStatus', 'onboardingComplete', 'communicationKey']) assert.ok(hawk.includes(field));
console.log('DiveDeep Phase 8 CRM route and ownership checks passed');
