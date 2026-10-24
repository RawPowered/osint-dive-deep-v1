const fs = require('fs');
const path = require('path');
const { ROOT, SCHEMA_VERSION, loadEnv, getDbConfig } = require('../config');
const { getPool, createPool, setPool } = require('./pool');
const { EAGLE_METRIC_DEFINITIONS } = require('../services/eagle');
const { CALL_CENTER_METRIC_DEFINITIONS } = require('../services/eagleCallCenter');

async function runSchemaOnConnection(connection) {
  const schemaPath = path.join(ROOT, 'sql', 'schema.sql');
  let sql = fs.readFileSync(schemaPath, 'utf8');
  // Strip full-line SQL comments
  sql = sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await connection.query(statement);
  }

  // CREATE TABLE IF NOT EXISTS does not add columns to existing installations.
  await ensureColumn(connection, 'system_errors', 'userId', 'VARCHAR(128) NULL AFTER locationId');
  await ensureColumn(connection, 'auth_logs', 'userId', 'VARCHAR(128) NULL AFTER locationId');
  await ensureColumn(connection, 'auth_logs', 'email', 'VARCHAR(255) NULL AFTER username');
  await ensureColumn(
    connection,
    'crm_integrations',
    'credential_updated_at',
    'TIMESTAMP NULL AFTER credential_enc'
  );
  await ensureColumn(connection, 'leads', 'dncStatus', "VARCHAR(16) NOT NULL DEFAULT 'pending' AFTER lastContacted");
  await ensureColumn(connection, 'leads', 'dncCheckedAt', 'DATETIME NULL AFTER dncStatus');
  await ensureColumn(connection, 'leads', 'dncSource', 'VARCHAR(32) NULL AFTER dncCheckedAt');
  await ensureColumn(connection, 'leads', 'dncResultCode', 'VARCHAR(8) NULL AFTER dncSource');
  await ensureColumn(connection, 'leads', 'dncReason', 'VARCHAR(255) NULL AFTER dncResultCode');
  await ensureColumn(connection, 'leads', 'dncDecisionCategory', 'VARCHAR(48) NULL AFTER dncReason');
  await ensureColumn(connection, 'leads', 'dncReviewRequired', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER dncDecisionCategory');
  await ensureColumn(connection, 'leads', 'dncLastRescrubAt', 'DATETIME NULL AFTER dncReviewRequired');
  await ensureColumn(connection, 'leads', 'phoneMarketingStatus', "VARCHAR(16) NOT NULL DEFAULT 'pending' AFTER dncLastRescrubAt");
  await ensureColumn(connection, 'leads', 'emailMarketingStatus', "VARCHAR(16) NOT NULL DEFAULT 'unavailable' AFTER phoneMarketingStatus");
  await ensureColumn(connection, 'leads', 'smsMarketingStatus', "VARCHAR(16) NOT NULL DEFAULT 'unavailable' AFTER emailMarketingStatus");
  await ensureColumn(connection, 'leads', 'marketingChannelSource', 'VARCHAR(32) NULL AFTER smsMarketingStatus');
  await ensureColumn(connection, 'leads', 'marketingChannelTags', 'VARCHAR(255) NULL AFTER marketingChannelSource');
  await ensureColumn(connection, 'leads', 'marketingChannelsCheckedAt', 'DATETIME NULL AFTER marketingChannelTags');
  await ensureColumn(connection, 'lead_call_attempts', 'user_id', 'VARCHAR(128) NULL AFTER lead_id');
  await ensureColumn(connection, 'lead_call_attempts', 'external_user_id', 'VARCHAR(128) NULL AFTER user_id');
  await ensureColumn(connection, 'crm_import_runs', 'expected_records', 'INT UNSIGNED NULL AFTER pages_processed');
  await ensureColumn(connection, 'crm_import_runs', 'completion_reason', 'VARCHAR(64) NULL AFTER expected_records');
  await ensureColumn(connection, 'crm_import_runs', 'is_full_sync', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER completion_reason');
  await ensureColumn(connection, 'lead_import_values', 'last_seen_run_id', 'CHAR(36) NULL AFTER last_seen_at');
  await ensureColumn(connection, 'lead_import_values', 'is_current', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER last_seen_run_id');
  await ensureColumn(connection, 'eagle_lead_facts', 'demographics_json', 'TEXT NULL AFTER crm_updated_at');
  await ensureColumn(connection, 'eagle_snapshots', 'events_synced_at', 'TIMESTAMP NULL DEFAULT NULL AFTER completed_at');
  await ensureColumn(connection, 'eagle_metric_targets', 'period_days', 'SMALLINT UNSIGNED NULL AFTER metric_id');
  await ensureColumn(connection, 'owl_service_pools', 'calendar_ids_json', 'TEXT NULL AFTER tag_keywords_json');
  await ensureColumn(connection, 'owl_service_pools', 'default_calendar_id', 'VARCHAR(191) NULL AFTER calendar_ids_json');
  await ensureColumn(connection, 'owl_service_pools', 'fallback_user_id', 'VARCHAR(128) NULL AFTER default_calendar_id');
  await ensureColumn(connection, 'appointments', 'calendarId', 'VARCHAR(191) NULL AFTER userId');
  await ensureColumn(connection, 'appointments', 'externalEventId', 'VARCHAR(191) NULL AFTER calendarId');
  await ensureColumn(connection, 'appointments', 'externalContactId', 'VARCHAR(191) NULL AFTER externalEventId');
  await ensureColumn(connection, 'appointments', 'source', "VARCHAR(32) NOT NULL DEFAULT 'divedeep' AFTER externalContactId");
  await ensureColumn(connection, 'appointments', 'syncedAt', 'DATETIME NULL AFTER status');
  await ensureColumn(connection, 'song_scripts', 'language_code', "VARCHAR(35) NOT NULL DEFAULT 'en-US' AFTER service_type");
  await ensureColumn(connection, 'api_sentinel_events', 'surface', "VARCHAR(32) NOT NULL DEFAULT 'api' AFTER request_id");
  await ensureColumn(connection, 'api_sentinel_events', 'actor_type', 'VARCHAR(32) NULL AFTER surface');
  await ensureColumn(connection, 'api_sentinel_events', 'actor_id', 'VARCHAR(128) NULL AFTER actor_type');
  await ensureColumn(connection, 'api_sentinel_events', 'actor_username', 'VARCHAR(128) NULL AFTER actor_id');
  await ensureColumn(connection, 'api_sentinel_events', 'action', 'VARCHAR(128) NULL AFTER actor_username');
  await ensureColumn(connection, 'api_sentinel_events', 'entity_type', 'VARCHAR(64) NULL AFTER action');
  await ensureColumn(connection, 'api_sentinel_events', 'entity_id', 'VARCHAR(191) NULL AFTER entity_type');
  await ensureColumn(connection, 'api_sentinel_events', 'outcome', 'VARCHAR(16) NULL AFTER entity_id');
  await ensureColumn(connection, 'sentinel_threat_cases', 'owner_admin_id', 'VARCHAR(64) NULL AFTER status');
  await ensureColumn(connection, 'sentinel_threat_cases', 'priority', "VARCHAR(16) NOT NULL DEFAULT 'normal' AFTER owner_admin_id");
  await ensureColumn(connection, 'sentinel_threat_cases', 'confidence', 'VARCHAR(16) NULL AFTER priority');
  await ensureColumn(connection, 'sentinel_threat_cases', 'disposition', 'VARCHAR(32) NULL AFTER confidence');
  await ensureColumn(connection, 'sentinel_threat_cases', 'due_at', 'TIMESTAMP(3) NULL DEFAULT NULL AFTER disposition');
  await ensureColumn(connection, 'sentinel_threat_cases', 'resolution_summary', 'TEXT NULL AFTER review_note');
  await ensureColumn(connection, 'sentinel_threat_cases', 'validation_summary', 'TEXT NULL AFTER resolution_summary');
  await ensureColumn(connection, 'sentinel_threat_cases', 'triaged_by', 'VARCHAR(64) NULL AFTER validation_summary');
  await ensureColumn(connection, 'sentinel_threat_cases', 'triaged_at', 'TIMESTAMP(3) NULL DEFAULT NULL AFTER triaged_by');
  await ensureColumn(connection, 'sentinel_threat_cases', 'contained_by', 'VARCHAR(64) NULL AFTER triaged_at');
  await ensureColumn(connection, 'sentinel_threat_cases', 'contained_at', 'TIMESTAMP(3) NULL DEFAULT NULL AFTER contained_by');
  await ensureColumn(connection, 'sentinel_threat_cases', 'validated_by', 'VARCHAR(64) NULL AFTER resolved_at');
  await ensureColumn(connection, 'sentinel_threat_cases', 'validated_at', 'TIMESTAMP(3) NULL DEFAULT NULL AFTER validated_by');
  await ensureColumn(connection, 'sentinel_threat_cases', 'closed_by', 'VARCHAR(64) NULL AFTER validated_at');
  await ensureColumn(connection, 'sentinel_threat_cases', 'closed_at', 'TIMESTAMP(3) NULL DEFAULT NULL AFTER closed_by');
  await ensureColumn(connection, 'sentinel_threat_cases', 'reopen_count', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER closed_at');
  await ensureColumn(connection, 'sentinel_validation_runs', 'detection_window_minutes', 'SMALLINT UNSIGNED NOT NULL DEFAULT 15 AFTER objective');
  await ensureColumn(connection, 'sentinel_validation_observations', 'evaluated_at', 'TIMESTAMP(3) NULL DEFAULT NULL AFTER detected_at');
  await ensureColumn(connection, 'sentinel_validation_observations', 'evaluation_source', 'VARCHAR(24) NULL AFTER evaluated_at');
  await ensureColumn(connection, 'sentinel_validation_observations', 'remediation_case_id', 'CHAR(36) NULL AFTER evaluation_source');
  await ensureColumn(connection, 'hawk_flows', 'folder_id', 'CHAR(36) NULL AFTER description');
  await ensureColumn(connection, 'hawk_flow_folders', 'data_source_slug', "VARCHAR(63) NOT NULL DEFAULT 'core' AFTER location_id");
  await ensureColumn(connection, 'hawk_flows', 'data_source_slug', "VARCHAR(63) NOT NULL DEFAULT 'core' AFTER location_id");
  await ensureColumn(connection, 'hawk_flows', 'color', 'CHAR(7) NULL AFTER folder_id');
  await ensureColumn(connection, 'hawk_flows', 'sort_order', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER color');
  await ensureColumn(connection, 'hawk_executions', 'data_source_slug', "VARCHAR(63) NOT NULL DEFAULT 'core' AFTER location_id");
  await ensureColumn(connection, 'parrot_script_versions', 'manifest_sha256', 'CHAR(64) NULL AFTER source_sha256');
  await ensureColumn(connection, 'divedeep_exposures', 'publication_status', "ENUM('staged','approved','published','rejected') NOT NULL DEFAULT 'published' AFTER status");
  await ensureColumn(connection, 'divedeep_import_batches', 'bundle_storage_ref', 'VARCHAR(512) NULL AFTER error_count');
  await ensureColumn(connection, 'divedeep_import_batches', 'bundle_sha256', 'CHAR(64) NULL AFTER bundle_storage_ref');
  await ensureColumn(connection, 'divedeep_import_batches', 'bundle_byte_size', 'INT UNSIGNED NULL AFTER bundle_sha256');
  await ensureColumn(connection, 'divedeep_import_batches', 'job_phase', 'VARCHAR(32) NULL AFTER bundle_byte_size');
  await ensureColumn(connection, 'divedeep_import_batches', 'job_current', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER job_phase');
  await ensureColumn(connection, 'divedeep_import_batches', 'job_total', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER job_current');
  await ensureColumn(connection, 'divedeep_import_batches', 'job_message', 'VARCHAR(500) NULL AFTER job_total');
  await ensureColumn(connection, 'divedeep_import_batches', 'job_started_at', 'TIMESTAMP(3) NULL DEFAULT NULL AFTER job_message');
  await ensureColumn(connection, 'divedeep_import_batches', 'job_heartbeat_at', 'TIMESTAMP(3) NULL DEFAULT NULL AFTER job_started_at');
  await ensureColumn(connection, 'divedeep_import_batches', 'job_completed_at', 'TIMESTAMP(3) NULL DEFAULT NULL AFTER job_heartbeat_at');
  await connection.query("ALTER TABLE divedeep_customers MODIFY plan_tier VARCHAR(64) NOT NULL DEFAULT 'standard'");
  await ensureColumn(connection, 'divedeep_customers', 'package_price_cents', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER plan_tier');
  await ensureColumn(connection, 'divedeep_customers', 'discount_percent', 'DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER package_price_cents');
  await ensureColumn(connection, 'divedeep_customers', 'pilot_code_id', 'CHAR(36) NULL DEFAULT NULL AFTER discount_percent');
  await ensureColumn(connection, 'divedeep_customers', 'notice_version', "VARCHAR(64) NOT NULL DEFAULT 'divedeep-notice-at-collection-v1' AFTER authorization_affirmed_at");
  await ensureColumn(connection, 'divedeep_customers', 'notice_acknowledged_at', 'TIMESTAMP(3) NULL DEFAULT NULL AFTER notice_version');
  await connection.query('ALTER TABLE divedeep_customers MODIFY authorization_affirmed_at TIMESTAMP(3) NULL DEFAULT NULL');
  await connection.query(
    "ALTER TABLE divedeep_visibility_policies MODIFY scope_type " +
    "ENUM('default','domain','source','category','identifier_type','profile_url') NOT NULL"
  );
  await connection.query('UPDATE parrot_script_versions SET manifest_sha256=source_sha256 WHERE manifest_sha256 IS NULL');
  await connection.query("UPDATE sentinel_threat_cases SET status='investigating',triaged_at=COALESCE(triaged_at,updated_at) WHERE status='under_review'");
  await connection.query("UPDATE sentinel_threat_cases SET status='monitoring' WHERE status='watching'");
  await connection.query("UPDATE sentinel_threat_cases SET status='contained',contained_at=COALESCE(contained_at,resolved_at,updated_at),contained_by=COALESCE(contained_by,resolved_by) WHERE status='blocked'");
  await connection.query(`UPDATE sentinel_threat_cases SET status='closed',
    disposition=COALESCE(disposition,'insufficient_evidence'),
    resolution_summary=COALESCE(resolution_summary,review_note,'Migrated legacy dismissal'),
    validation_summary=COALESCE(validation_summary,'Migrated legacy closure'),
    resolved_at=COALESCE(resolved_at,updated_at),validated_at=COALESCE(validated_at,resolved_at,updated_at),
    closed_at=COALESCE(closed_at,resolved_at,updated_at),closed_by=COALESCE(closed_by,resolved_by)
    WHERE status='dismissed'`);
  await ensureIndex(
    connection,
    'leads',
    'idx_leads_dnc_pull',
    '(locationId, serviceType, status, dncStatus, assignedTo)'
  );
  await ensureIndex(connection, 'appointments', 'idx_appointments_lead_status', '(locationId, leadId, status, appointmentDate)');
  await ensureIndex(connection, 'appointments', 'uq_appointments_external_event', '(locationId, externalEventId)', true);
  await ensureDncScreeningMigration(connection);
  await ensureIndex(
    connection,
    'system_errors',
    'idx_errors_user',
    '(locationId, userId, timestamp)'
  );
  await ensureIndex(
    connection,
    'auth_logs',
    'idx_auth_logs_user',
    '(locationId, userId, timestamp)'
  );
  await ensureIndex(
    connection,
    'users',
    'idx_users_location_username',
    '(locationId, username)'
  );
  await ensureIndex(
    connection,
    'users',
    'idx_users_location_email',
    '(locationId, email)'
  );
  await ensureIndex(connection, 'api_sentinel_events', 'idx_sentinel_surface', '(surface, created_at)');
  await ensureIndex(connection, 'api_sentinel_events', 'idx_sentinel_action', '(action, created_at)');
  await ensureIndex(connection, 'api_sentinel_events', 'idx_sentinel_actor', '(actor_id, created_at)');
  await ensureIndex(connection, 'song_scripts', 'idx_song_script_language', '(api_key_id,location_id,service_type,language_code,status)');
  await ensureIndex(connection, 'hawk_flows', 'idx_hawk_flow_folder', '(api_key_id,location_id,folder_id,sort_order)');
  await ensureIndex(connection, 'hawk_flows', 'idx_hawk_flow_data_source', '(api_key_id,location_id,data_source_slug,status,updated_at)');
  await ensureIndex(connection, 'hawk_executions', 'idx_hawk_execution_data_source', '(api_key_id,location_id,data_source_slug,created_at)');
  await ensureIndex(connection, 'hawk_flow_folders', 'idx_hawk_folder_data_source', '(api_key_id,location_id,data_source_slug,sort_order,name)');
  await dropIndexIfExists(connection, 'hawk_flow_folders', 'uq_hawk_folder_name');
  await ensureIndex(connection, 'hawk_flow_folders', 'uq_hawk_folder_source_name', '(api_key_id,location_id,data_source_slug,name)', true);
  await ensureIndex(connection, 'hawk_webhook_endpoints', 'uq_hawk_webhook_flow', '(flow_id)', true);
  await ensureIndex(connection, 'hawk_webhook_endpoints', 'uq_hawk_webhook_public', '(public_id)', true);
  await ensureIndex(connection, 'hawk_webhook_deliveries', 'uq_hawk_webhook_event', '(endpoint_id,event_key)', true);
  await ensureIndex(connection, 'hawk_webhook_deliveries', 'idx_hawk_webhook_delivery_flow', '(flow_id,received_at)');
  await dropIndexIfExists(connection, 'parrot_script_versions', 'uq_parrot_script_hash');
  await ensureIndex(connection, 'parrot_script_versions', 'uq_parrot_script_manifest', '(script_id,manifest_sha256)', true);
  await ensureIndex(connection, 'parrot_script_versions', 'idx_parrot_script_source_hash', '(script_id,source_sha256)');
  await ensureIndex(connection, 'divedeep_import_batches', 'idx_divedeep_import_job', '(job_phase,job_heartbeat_at)');
  await ensureSongLanguageAssignments(connection);
  await ensureEagleMetricDefinitions(connection);
  await ensureIndex(connection, 'lead_call_attempts', 'idx_call_attempt_user', '(location_id, user_id, occurred_at)');
}

async function ensureColumn(connection, table, column, definition) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  if (!rows.length) {
    await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function ensureIndex(connection, table, indexName, columnsSql, unique = false) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, indexName]
  );
  if (!rows.length) {
    await connection.query(`ALTER TABLE \`${table}\` ADD ${unique ? 'UNIQUE ' : ''}INDEX \`${indexName}\` ${columnsSql}`);
  }
}

async function dropIndexIfExists(connection, table, indexName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, indexName]
  );
  if (rows.length) await connection.query(`ALTER TABLE \`${table}\` DROP INDEX \`${indexName}\``);
}

async function ensureDncScreeningMigration(connection) {
  const marker = 'migration_dnc_screening_v13';
  const [rows] = await connection.query(
    'SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1',
    [marker]
  );
  if (rows.length) return;
  await connection.beginTransaction();
  try {
    await connection.query(
      `UPDATE leads SET status = 'dnc_pending', assignedTo = NULL
       WHERE dncStatus = 'pending' AND status IN ('uncontacted', 'assigned')`
    );
    await connection.query(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, 'complete')`,
      [marker]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function ensureSongLanguageAssignments(connection) {
  await connection.query(
    `INSERT IGNORE INTO song_service_language_assignments
       (api_key_id,location_id,service_type,language_code,script_id,version_id,updated_by,updated_at)
     SELECT a.api_key_id,a.location_id,a.service_type,
            COALESCE(NULLIF(s.language_code,''),'en-US'),a.script_id,a.version_id,a.updated_by,a.updated_at
     FROM song_service_assignments a
     INNER JOIN song_scripts s ON s.id=a.script_id`
  );
}

async function ensureEagleMetricDefinitions(connection) {
  for (const definition of [...EAGLE_METRIC_DEFINITIONS,...CALL_CENTER_METRIC_DEFINITIONS]) {
    await connection.query(
      `INSERT INTO eagle_metric_definitions
         (metric_id,definition_version,label,description,unit,numerator_label,denominator_label,time_basis,business_owner,is_active)
       VALUES (?,?,?,?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE definition_version=VALUES(definition_version),label=VALUES(label),
         description=VALUES(description),unit=VALUES(unit),numerator_label=VALUES(numerator_label),
         denominator_label=VALUES(denominator_label),time_basis=VALUES(time_basis),
         business_owner=VALUES(business_owner),is_active=1`,
      [definition.metricId, definition.definitionVersion, definition.label, definition.description,
        definition.unit, definition.numeratorLabel, definition.denominatorLabel,
        definition.timeBasis, definition.businessOwner]
    );
  }
}

async function applySchema(pool = null) {
  const p = pool || getPool();
  const conn = await p.getConnection();
  try {
    await runSchemaOnConnection(conn);
    await conn.query(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES ('schema_version', ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [SCHEMA_VERSION]
    );
  } finally {
    conn.release();
  }
}

async function isInstalled(pool = null) {
  try {
    const p = pool || getPool();
    const [rows] = await p.query(
      `SELECT setting_value FROM app_settings WHERE setting_key = 'installed' LIMIT 1`
    );
    return rows.length > 0 && rows[0].setting_value === 'true';
  } catch {
    return false;
  }
}

async function markInstalled(pool = null) {
  const p = pool || getPool();
  await p.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES ('installed', 'true')
     ON DUPLICATE KEY UPDATE setting_value = 'true'`
  );
  await p.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES ('installed_at', ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [new Date().toISOString()]
  );
}

/**
 * Bootstrap pool after .env exists. Returns { installed }.
 */
async function initDatabase() {
  loadEnv();
  const cfg = getDbConfig();
  if (!cfg.user || !cfg.database) {
    return { installed: false, configured: false };
  }
  try {
    const pool = createPool();
    setPool(pool);
    const installed = await isInstalled(pool);
    return { installed, configured: true };
  } catch (err) {
    console.error('Database init error:', err.message);
    return { installed: false, configured: true, error: err.message };
  }
}

// CLI: npm run migrate
if (require.main === module) {
  (async () => {
    loadEnv();
    const pool = createPool();
    setPool(pool);
    await applySchema(pool);
    console.log('Schema applied. version=', SCHEMA_VERSION);
    await pool.end();
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  applySchema,
  isInstalled,
  markInstalled,
  initDatabase,
  runSchemaOnConnection,
  ensureColumn,
  ensureIndex,
  ensureDncScreeningMigration,
  ensureSongLanguageAssignments,
  ensureEagleMetricDefinitions,
};
