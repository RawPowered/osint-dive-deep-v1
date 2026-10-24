'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const routes = fs.readFileSync(path.join(root, 'src/routes/adminDiveDeep.js'), 'utf8');
const customerRoutes = fs.readFileSync(path.join(root, 'src/routes/diveDeep.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, 'src/services/diveDeepWorkflow.js'), 'utf8');
for (const route of [
  'privacy-workflows', 'privacy-workflow/reconcile', 'privacy-workflow/close', 'review-tasks',
  'request-deliveries', 'deliveries', 'monitoring-schedules', 'checks',
]) assert.ok(routes.includes(route), `Missing route contract: ${route}`);
for (const action of [
  'divedeep.workflow.reconcile', 'divedeep.workflow.close', 'divedeep.review_task.update',
  'divedeep.delivery.create', 'divedeep.delivery.attempt', 'divedeep.monitoring.create', 'divedeep.monitoring.check',
]) assert.ok(routes.includes(action), `Missing Sentinel action: ${action}`);
assert.match(routes, /privacy-workflow\/close', requireRootRole, requireAdminCsrf/);
assert.match(customerRoutes, /reconcileReviewTasks/);
assert.match(customerRoutes, /\/api\/workflow'/);
assert.match(customerRoutes, /workflow\/actions\/:actionId\/complete/);
assert.match(customerRoutes, /divedeep\.workflow\.customer_action\.complete/);
assert.match(workflow, /human review tasks remain open/i);
assert.match(workflow, /customer validation/i);
assert.match(workflow, /administrator must close/i);
assert.match(workflow, /continuing_monitoring/);
console.log('DiveDeep Phase 5 routes and Sentinel controls passed');
