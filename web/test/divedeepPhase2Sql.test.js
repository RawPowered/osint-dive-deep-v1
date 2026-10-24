'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
for (const table of ['divedeep_customer_workflow_gates','divedeep_worker_pools','divedeep_worker_pool_versions','divedeep_recon_jobs','divedeep_recon_job_executions','divedeep_recon_job_events']) {
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`), `Missing ${table}`);
}
assert.match(sql, /provider\s+ENUM\('google_cloud_run_jobs'\)/);
assert.match(sql, /'cloud-run-primary'/);
assert.match(sql, /"dispatchEnabled":false/);
assert.match(sql, /workflow_status\s+ENUM\([^\n]*'awaiting_dispatch'[^\n]*'dispatched'[^\n]*'awaiting_review'/);
assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS divedeep_divedeep_nodes/);
console.log('DiveDeep Phase 2 fresh-install SQL contract checks passed');
