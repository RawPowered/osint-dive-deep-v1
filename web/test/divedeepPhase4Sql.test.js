'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'sql/schema.sql'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src/services/diveDeepWorkerRuntime.js'), 'utf8');
for (const table of [
  'divedeep_worker_bootstrap_tokens', 'divedeep_worker_instances', 'divedeep_job_leases',
  'divedeep_job_checkpoints', 'divedeep_source_attempts', 'divedeep_recon_candidates',
  'divedeep_recon_job_completions',
]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
assert.match(sql, /payload_expires_at\s+TIMESTAMP\(3\)/);
assert.match(runtime, /INTERVAL 24 HOUR/);
assert.match(runtime, /INTERVAL 30 DAY/);
assert.match(sql, /cleanup_status\s+ENUM\('pending','confirmed','failed'\)/);
assert.match(config, /SCHEMA_VERSION:\s*'64'/);
assert.match(sql, /\"maxRetries\":0/);
assert.match(sql, /\"workerVersion\":\"5\.29\.0\"/);
assert.match(sql, /\"workerProtocolVersion\":1/);
console.log('DiveDeep Phase 4 fresh-install SQL checks passed');
