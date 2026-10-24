'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
for (const table of ['divedeep_artifacts','divedeep_artifact_upload_sessions','divedeep_artifact_events','divedeep_retention_actions']) {
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`), `Missing ${table}`);
}
for (const retention of ['transient_nonmatch','failed_upload','pending_review','confirmed_relevant','removal_evidence','deletion_pending','audit_metadata']) assert.match(sql, new RegExp(retention));
assert.match(sql, /legal_hold\s+TINYINT\(1\)/);
assert.match(sql, /lifecycle_exempt\s+TINYINT\(1\)/);
assert.match(sql, /expected_sha256\s+CHAR\(64\)/);
assert.match(sql, /object_key\s+VARCHAR\(1024\)/);
assert.match(sql, /artifact_id\s+CHAR\(36\)\s+NULL/);
const config = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
assert.match(config, /SCHEMA_VERSION: '64'/);
console.log('DiveDeep Phase 3 fresh-install SQL contract checks passed');
