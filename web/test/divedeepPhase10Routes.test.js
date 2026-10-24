'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname,'..','src/routes/adminDiveDeep.js'),'utf8');
for (const route of [
  '/api/divedeep/production-readiness',
  '/api/divedeep/production-readiness/checks',
  '/api/divedeep/production-readiness/rollout',
  '/api/divedeep/production-readiness/assignments',
  '/api/divedeep/production-readiness/disaster-recovery',
  '/api/divedeep/production-readiness/providers',
  '/api/divedeep/production-readiness/throughput-cost',
]) assert.ok(source.includes(route), `Missing ${route}`);
assert.match(source,/requireRootRole, requireAdminCsrf/);
assert.match(source,/sentinelOmitBodies = true/);
console.log('DiveDeep Phase 10 administrative route checks passed');
