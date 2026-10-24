'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root,'sql/schema.sql'),'utf8');
const config = fs.readFileSync(path.join(root,'src/config.js'),'utf8');
const release = JSON.parse(fs.readFileSync(path.join(root,'RELEASE.json'),'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
for (const table of ['divedeep_release_readiness_checks','divedeep_rollout_state','divedeep_rollout_events','divedeep_rollout_assignments','divedeep_disaster_recovery_rehearsals','divedeep_compute_provider_readiness']) {
  assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
}
assert.match(sql,/controlled_pilot','small_customer_cohort','normal_production','enterprise_clients','hourly_burst_capacity','multi_provider_capacity/);
assert.match(config,/SCHEMA_VERSION:\s*'64'/);
assert.equal(pkg.version,'1.16.0');
assert.equal(release.version,'1.16.0');
assert.equal(release.phase,'10');
assert.equal(release.schemaVersion,64);
console.log('DiveDeep Phase 10 fresh-install SQL checks passed');
