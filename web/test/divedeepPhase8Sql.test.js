'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'sql/schema.sql'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
const release = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE.json'), 'utf8'));
for (const table of [
  'divedeep_crm_contact_links', 'divedeep_crm_webhook_endpoints',
  'divedeep_crm_inbound_events', 'divedeep_crm_outbound_events', 'divedeep_crm_dead_letters',
]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`), `Missing ${table}`);
assert.match(sql, /UNIQUE KEY uq_divedeep_crm_external_contact \(integration_id,external_contact_id\)/);
assert.match(sql, /UNIQUE KEY uq_divedeep_crm_outbound_idempotency \(integration_id,idempotency_key\)/);
assert.match(sql, /UNIQUE KEY uq_divedeep_crm_inbound_event \(integration_id,event_key\)/);
assert.match(sql, /ENUM\('queued','processing','retry','completed','dead_letter','ignored'\)/);
assert.match(config, /SCHEMA_VERSION:\s*'64'/);
assert.equal(release.version, '1.16.0');
assert.ok(Number(release.phase) >= 8);
assert.ok(Number(release.schemaVersion) >= 63);
console.log('DiveDeep Phase 8 fresh-install SQL checks passed');
