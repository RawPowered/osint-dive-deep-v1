'use strict';
const assert = require('assert/strict');
const privacy = require('../src/services/diveDeepCrmPrivacy');

const safe = privacy.sanitizeOutboundPayload({
  eventName: 'divedeep.lifecycle.updated',
  customerId: 'customer-1',
  contactId: 'contact-1',
  customerStatus: 'active',
  workflowStatus: 'researching',
  onboardingComplete: true,
  communicationKey: 'divedeep.service_update',
  tags: ['divedeep-customer', 'divedeep-onboarding-complete'],
  lifecycle: { openCustomerActions: 0, pendingDeliveries: 1, activeMonitoring: 0 },
});
assert.equal(safe.workflowStatus, 'researching');
assert.doesNotMatch(JSON.stringify(safe), /sourceUrl|evidence/i);
assert.throws(
  () => privacy.sanitizeOutboundPayload({ ...safe, evidence: { sourceUrl: 'https://example.invalid/private.jpg' } }),
  (error) => error.code === 'DIVEDEEP_CRM_SENSITIVE_PAYLOAD_BLOCKED'
);

assert.equal(privacy.containsSensitiveEvidence({ candidate: { confidence: 0.97 } }), true);
assert.throws(
  () => privacy.assertNoSensitiveEvidence({ reviewer_note: 'private assessment' }),
  (error) => error.code === 'DIVEDEEP_CRM_SENSITIVE_PAYLOAD_BLOCKED'
);

const inbound = privacy.sanitizeInboundPayload({
  type: 'contact.updated',
  contact: { id: 'contact-1', locationId: 'location-1', tags: ['customer'] },
  message_body: 'private reply body',
  attachments: [{ url: 'https://example.invalid/evidence.png' }],
  opportunity: { id: 'opp-1', status: 'open', monetaryValue: 5000 },
});
assert.deepEqual(inbound.opportunity, { id: 'opp-1', status: 'open' });
assert.doesNotMatch(JSON.stringify(inbound), /private reply|evidence\.png|monetaryValue/i);
console.log('DiveDeep Phase 8 CRM privacy-boundary checks passed');
