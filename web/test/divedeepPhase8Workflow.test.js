'use strict';
const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (parent?.filename?.endsWith('diveDeepCrmIntegration.js')) {
    if (request === '../db/pool') return { getPool() { throw new Error('Database not expected'); } };
    if (request === '../instanceIdentity') return { getInstanceIdentity: () => ({ webhookBasePath: '/hooks/test' }) };
    if (request === './secretBox') return { encryptSecret: (v) => `enc:${v}`, decryptSecret: (v) => String(v).replace(/^enc:/, '') };
    if (request === './divedeepPii') return { decryptPii: (v) => v };
    if (request === './crmIntegrations') return { getIntegrationById: async () => null, integrationCredential: () => '', LEADCONNECTOR_PROVIDER: 'leadconnector-pit' };
    if (request === './hawk') return { executeFlow: async () => ({}), runGhlAction: async () => ({}) };
    if (request === './sentinel') return { recordEvent() {}, newRequestId: () => 'request-1' };
  }
  return originalLoad(request, parent, isMain);
};
const crm = require('../src/services/diveDeepCrmIntegration');

assert.equal(crm.communicationKeyFor({ customerStatus: 'active', workflowStatus: 'intake', openCustomerActions: 0, activeMonitoring: 0, onboardingComplete: false }), 'divedeep.welcome');
assert.equal(crm.communicationKeyFor({ customerStatus: 'active', workflowStatus: 'researching', openCustomerActions: 0, activeMonitoring: 0, onboardingComplete: true }), 'divedeep.service_update');
assert.equal(crm.communicationKeyFor({ customerStatus: 'active', workflowStatus: 'researching', openCustomerActions: 1, activeMonitoring: 0, onboardingComplete: true }), 'divedeep.action_required');
assert.equal(crm.communicationKeyFor({ customerStatus: 'closed', workflowStatus: 'complete', openCustomerActions: 0, activeMonitoring: 0, onboardingComplete: true }), 'divedeep.example.invalidplete');

const tags = crm.milestoneTags({ workflowStatus: 'monitoring', onboardingComplete: true, openCustomerActions: 0, activeMonitoring: 1, customerStatus: 'active' });
assert.deepEqual(tags, ['divedeep-customer', 'divedeep-onboarding-complete', 'divedeep-monitoring']);
assert.equal(crm.triggerMatches(JSON.stringify({ nodes: [{ type: 'trigger', config: { event: 'divedeep.lifecycle.updated' } }] }), 'divedeep.lifecycle.updated'), true);
assert.equal(crm.triggerMatches(JSON.stringify({ nodes: [{ type: 'trigger', config: { event: 'webhook.received', eventName: 'contact.updated' } }] }), 'contact.updated'), true);
assert.equal(crm.triggerMatches(JSON.stringify({ nodes: [{ type: 'trigger', config: { event: 'contact.created' } }] }), 'divedeep.lifecycle.updated'), false);
Module._load = originalLoad;
console.log('DiveDeep Phase 8 HAWK lifecycle contract checks passed');
