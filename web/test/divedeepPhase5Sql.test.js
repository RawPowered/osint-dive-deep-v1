'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'sql/schema.sql'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
for (const table of [
  'divedeep_workflow_runs', 'divedeep_workflow_gate_events', 'divedeep_review_tasks',
  'divedeep_customer_action_requests', 'divedeep_request_deliveries',
  'divedeep_request_delivery_attempts', 'divedeep_monitoring_schedules', 'divedeep_monitoring_checks',
]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`), `Missing ${table}`);
assert.match(sql, /workflow_status\s+ENUM\([^\n]*'awaiting_customer_validation'[^\n]*'disposition_required'[^\n]*'closure_ready'/);
assert.match(sql, /status\s+ENUM\('active','blocked','monitoring','completed','closed','withdrawn'\)/);
assert.match(sql, /result\s+ENUM\('removed','still_present','changed','reappeared','unreachable','blocked','needs_review'\)/);
assert.match(config, /SCHEMA_VERSION:\s*'64'/);
assert.match(sql, /CREATE TABLE IF NOT EXISTS owl_service_pools/);
assert.match(sql, /CREATE TABLE IF NOT EXISTS eagle_/);
assert.doesNotMatch(sql, /DROP TABLE\s+owl_service_pools/i);
console.log('DiveDeep Phase 5 fresh-install SQL checks passed');
