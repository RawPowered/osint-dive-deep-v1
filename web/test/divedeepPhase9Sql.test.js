'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'sql/schema.sql'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
const release = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

for (const table of [
  'divedeep_organizations',
  'divedeep_organization_customers',
  'divedeep_service_identities',
  'divedeep_oauth_access_tokens',
  'divedeep_api_idempotency',
  'divedeep_api_rate_windows',
  'divedeep_webhook_subscriptions',
  'divedeep_webhook_deliveries',
  'divedeep_external_api_events',
]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`), `Missing ${table}`);

assert.match(sql, /identity_type\s+ENUM\('customer','enterprise','integration'\)/);
assert.match(sql, /auth_method\s+ENUM\('api_key','oauth_client'\)/);
assert.match(sql, /UNIQUE KEY uq_divedeep_api_idempotency \(service_identity_id,request_scope,idempotency_key\)/);
assert.match(sql, /signing_secret_enc\s+TEXT\s+NOT NULL/);
assert.match(sql, /status\s+ENUM\('queued','processing','retry','completed','dead_letter'\)/);
assert.match(config, /SCHEMA_VERSION:\s*'64'/);
assert.equal(packageJson.version, '1.16.0');
assert.equal(release.version, '1.16.0');
assert.ok(Number(release.phase) >= 9);
assert.ok(Number(release.schemaVersion) >= 63);
console.log('DiveDeep Phase 9 fresh-install SQL checks passed');
