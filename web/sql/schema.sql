-- DiveDeep Custom API — MySQL schema (platform + operational)

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key   VARCHAR(64)  NOT NULL PRIMARY KEY,
  setting_value TEXT         NOT NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_users (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL,
  email         VARCHAR(255) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','viewer') NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Delegated platform administrators. Root identities remain exclusively in admin_users.
CREATE TABLE IF NOT EXISTS platform_administrators (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  username       VARCHAR(100) NOT NULL UNIQUE,
  email          VARCHAR(255) NULL,
  password_hash  VARCHAR(255) NOT NULL,
  is_enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  created_by     CHAR(36)     NOT NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_platform_admin_enabled (is_enabled, username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tenant administrators are fail-closed to one API-key portfolio.
CREATE TABLE IF NOT EXISTS tenant_administrators (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  api_key_id     CHAR(36)     NOT NULL,
  username       VARCHAR(100) NOT NULL UNIQUE,
  email          VARCHAR(255) NULL,
  password_hash  VARCHAR(255) NOT NULL,
  is_enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  created_by     CHAR(36)     NOT NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tenant_admin_scope (api_key_id, is_enabled, username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cross-table uniqueness guard for delegated login names.
CREATE TABLE IF NOT EXISTS admin_login_names (
  username        VARCHAR(100) NOT NULL PRIMARY KEY,
  principal_type  ENUM('platform','tenant') NOT NULL,
  principal_id    CHAR(36)     NOT NULL UNIQUE,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-principal Google step-up binding. A Google subject may protect only one administrator.
CREATE TABLE IF NOT EXISTS admin_mfa_identities (
  principal_type   ENUM('root','platform','tenant') NOT NULL,
  principal_id     CHAR(36)     NOT NULL,
  provider         ENUM('google') NOT NULL DEFAULT 'google',
  provider_subject VARCHAR(191) NOT NULL,
  email            VARCHAR(255) NOT NULL,
  enrolled_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (principal_type, principal_id),
  UNIQUE KEY uq_admin_mfa_provider_subject (provider, provider_subject),
  KEY idx_admin_mfa_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_keys (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  name          VARCHAR(128) NOT NULL,
  key_prefix    VARCHAR(16)  NOT NULL,
  key_hash      CHAR(64)     NOT NULL,
  created_by    CHAR(36)     NULL,
  last_used_at  TIMESTAMP    NULL DEFAULT NULL,
  revoked_at    TIMESTAMP    NULL DEFAULT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_api_keys_prefix (key_prefix),
  KEY idx_api_keys_active (revoked_at),
  KEY idx_api_keys_hash (key_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wiki_pages (
  slug          VARCHAR(128) NOT NULL PRIMARY KEY,
  title         VARCHAR(255) NOT NULL,
  body_md       MEDIUMTEXT   NOT NULL,
  is_published  TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_sentinel_events (
  id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  api_key_id    CHAR(36)     NULL,
  key_prefix    VARCHAR(16)  NULL,
  method        VARCHAR(10)  NOT NULL,
  path          VARCHAR(255) NOT NULL,
  status_code   SMALLINT     NOT NULL,
  duration_ms   INT          NULL,
  ip            VARCHAR(45)  NULL,
  user_agent    VARCHAR(512) NULL,
  location_id   VARCHAR(128) NULL,
  error_class   VARCHAR(64)  NULL,
  request_id    CHAR(36)     NOT NULL,
  surface       VARCHAR(32)  NOT NULL DEFAULT 'api',
  actor_type    VARCHAR(32)  NULL,
  actor_id      VARCHAR(128) NULL,
  actor_username VARCHAR(128) NULL,
  action        VARCHAR(128) NULL,
  entity_type   VARCHAR(64)  NULL,
  entity_id     VARCHAR(191) NULL,
  outcome       VARCHAR(16)  NULL,
  KEY idx_sentinel_created (created_at),
  KEY idx_sentinel_key (api_key_id, created_at),
  KEY idx_sentinel_status (status_code, created_at),
  KEY idx_sentinel_path (path, created_at),
  KEY idx_sentinel_ip (ip, created_at),
  KEY idx_sentinel_surface (surface, created_at),
  KEY idx_sentinel_action (action, created_at),
  KEY idx_sentinel_actor (actor_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Short-lived, encrypted and redacted HTTP evidence. Secrets are never stored in plaintext.
CREATE TABLE IF NOT EXISTS sentinel_http_envelopes (
  request_id       CHAR(36)      NOT NULL PRIMARY KEY,
  captured_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  envelope_enc     MEDIUMTEXT    NOT NULL,
  integrity_hmac   CHAR(64)      NOT NULL,
  capture_reason   VARCHAR(64)   NOT NULL DEFAULT 'standard',
  expires_at       TIMESTAMP(3)  NOT NULL,
  KEY idx_forensic_expiry (expires_at),
  KEY idx_forensic_captured (captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable reveal ledger for need-to-know review of forensic HTTP evidence.
CREATE TABLE IF NOT EXISTS sentinel_forensic_access (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  accessed_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  request_id       CHAR(36)      NOT NULL,
  event_id         BIGINT        NULL,
  admin_id         VARCHAR(64)   NULL,
  admin_username   VARCHAR(128)  NULL,
  purpose          VARCHAR(512)  NOT NULL,
  ip               VARCHAR(45)   NULL,
  user_agent       VARCHAR(512)  NULL,
  fields_viewed    VARCHAR(255)  NOT NULL,
  integrity_ok     TINYINT(1)    NOT NULL DEFAULT 0,
  outcome          VARCHAR(32)   NOT NULL,
  KEY idx_forensic_access_request (request_id, accessed_at),
  KEY idx_forensic_access_admin (admin_id, accessed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dialer / operator login security events (never store passwords)
CREATE TABLE IF NOT EXISTS api_login_events (
  id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  event_type    VARCHAR(32)  NOT NULL DEFAULT 'login',
  outcome       VARCHAR(32)  NOT NULL,
  username      VARCHAR(128) NULL,
  email         VARCHAR(255) NULL,
  user_id       VARCHAR(128) NULL,
  location_id   VARCHAR(128) NULL,
  ip            VARCHAR(45)  NULL,
  user_agent    VARCHAR(512) NULL,
  api_key_id    CHAR(36)     NULL,
  key_prefix    VARCHAR(16)  NULL,
  detail        VARCHAR(255) NULL,
  request_id    CHAR(36)     NULL,
  KEY idx_login_created (created_at),
  KEY idx_login_outcome (outcome, created_at),
  KEY idx_login_user (username, created_at),
  KEY idx_login_email (email, created_at),
  KEY idx_login_ip (ip, created_at),
  KEY idx_login_location (location_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Operational tables (ported from SQLite)

CREATE TABLE IF NOT EXISTS location_data (
  locationId    VARCHAR(128) NOT NULL PRIMARY KEY,
  payload       LONGTEXT     NULL,
  updatedAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leads (
  id            VARCHAR(128) NOT NULL PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  serviceType   VARCHAR(128) NULL,
  status        VARCHAR(64)  NOT NULL DEFAULT 'uncontacted',
  contactData   LONGTEXT     NULL,
  assignedTo    VARCHAR(128) NULL,
  lastContacted DATETIME     NULL,
  dncStatus     VARCHAR(16)  NOT NULL DEFAULT 'pending',
  dncCheckedAt  DATETIME     NULL,
  dncSource     VARCHAR(32)  NULL,
  dncResultCode VARCHAR(8)   NULL,
  dncReason     VARCHAR(255) NULL,
  dncDecisionCategory VARCHAR(48) NULL,
  dncReviewRequired TINYINT(1) NOT NULL DEFAULT 0,
  dncLastRescrubAt DATETIME NULL,
  phoneMarketingStatus VARCHAR(16) NOT NULL DEFAULT 'pending',
  emailMarketingStatus VARCHAR(16) NOT NULL DEFAULT 'unavailable',
  smsMarketingStatus VARCHAR(16) NOT NULL DEFAULT 'unavailable',
  marketingChannelSource VARCHAR(32) NULL,
  marketingChannelTags VARCHAR(255) NULL,
  marketingChannelsCheckedAt DATETIME NULL,
  dateAdded     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_leads_pull (locationId, serviceType, status, assignedTo),
  KEY idx_leads_dnc_pull (locationId, serviceType, status, dncStatus, assignedTo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Minimal outbound-call ledger used for rolling jurisdictional attempt limits.
CREATE TABLE IF NOT EXISTS lead_call_attempts (
  id                CHAR(36)      NOT NULL PRIMARY KEY,
  location_id       VARCHAR(128)  NOT NULL,
  lead_id           VARCHAR(128)  NOT NULL,
  user_id           VARCHAR(128)  NULL,
  external_user_id  VARCHAR(128)  NULL,
  integration_id    CHAR(36)      NULL,
  external_event_id VARCHAR(191)  NOT NULL,
  subject_key       VARCHAR(128)  NOT NULL DEFAULT 'general',
  occurred_at       DATETIME(3)   NOT NULL,
  direction         VARCHAR(16)   NOT NULL DEFAULT 'outbound',
  call_status       VARCHAR(32)   NULL,
  source            VARCHAR(16)   NOT NULL,
  synced_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_call_attempt_source (source, integration_id, external_event_id),
  KEY idx_call_attempt_limit (lead_id, direction, occurred_at),
  KEY idx_call_attempt_location (location_id, occurred_at),
  KEY idx_call_attempt_user (location_id, user_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Decision ledger contains compliance metadata only; CRM message bodies are never retained.
CREATE TABLE IF NOT EXISTS lead_compliance_checks (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  location_id      VARCHAR(128)  NOT NULL,
  lead_id          VARCHAR(128)  NOT NULL,
  user_id          VARCHAR(128)  NULL,
  state_code       CHAR(2)       NULL,
  time_zone        VARCHAR(64)   NULL,
  local_time       DATETIME      NULL,
  attempts_24h     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  decision         VARCHAR(16)   NOT NULL,
  reason           VARCHAR(64)   NOT NULL,
  next_eligible_at DATETIME(3)   NULL,
  checked_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_compliance_location (location_id, checked_at),
  KEY idx_compliance_lead (lead_id, checked_at),
  KEY idx_compliance_decision (location_id, decision, reason, checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Server-resolved timezone cache. Only coordinates and the validated IANA zone are retained.
CREATE TABLE IF NOT EXISTS lead_timezone_cache (
  location_id VARCHAR(128) NOT NULL,
  lead_id      VARCHAR(128) NOT NULL,
  latitude     DECIMAL(9,6) NOT NULL,
  longitude    DECIMAL(10,6) NOT NULL,
  time_zone    VARCHAR(64)  NOT NULL,
  resolver     VARCHAR(32)  NOT NULL,
  resolved_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at   DATETIME(3)  NOT NULL,
  PRIMARY KEY (location_id,lead_id),
  KEY idx_lead_timezone_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- CRM ingestion control plane. Existing lead rows remain the dialer's operational queue.
CREATE TABLE IF NOT EXISTS crm_integrations (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  name                VARCHAR(128)  NOT NULL,
  provider            VARCHAR(64)   NOT NULL DEFAULT 'generic',
  location_id         VARCHAR(128)  NOT NULL,
  base_url            VARCHAR(512)  NOT NULL,
  credential_enc      TEXT          NULL,
  credential_updated_at TIMESTAMP   NULL,
  auth_scheme         VARCHAR(32)   NOT NULL DEFAULT 'Bearer',
  config_json         MEDIUMTEXT    NULL,
  is_enabled          TINYINT(1)    NOT NULL DEFAULT 1,
  last_cursor         VARCHAR(512)  NULL,
  last_sync_at        TIMESTAMP     NULL DEFAULT NULL,
  created_by          CHAR(36)      NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_crm_provider_location (provider, location_id),
  KEY idx_crm_integrations_enabled (is_enabled, location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- API keys must be explicitly granted access to a CRM integration.
CREATE TABLE IF NOT EXISTS crm_integration_grants (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  allow_read          TINYINT(1)    NOT NULL DEFAULT 1,
  allow_import        TINYINT(1)    NOT NULL DEFAULT 0,
  allow_manage_leads  TINYINT(1)    NOT NULL DEFAULT 0,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_crm_grant (integration_id, api_key_id),
  KEY idx_crm_grant_key (api_key_id),
  KEY idx_crm_grant_integration (integration_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_field_definitions (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  field_key           VARCHAR(191)  NOT NULL,
  field_label         VARCHAR(255)  NULL,
  data_type           VARCHAR(32)   NOT NULL DEFAULT 'string',
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_crm_field (integration_id, field_key),
  KEY idx_crm_field_integration (integration_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_field_mappings (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  field_key           VARCHAR(191)  NOT NULL,
  target_field        VARCHAR(64)   NOT NULL,
  is_enabled          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_crm_mapping (integration_id, field_key, target_field),
  KEY idx_crm_mapping_integration (integration_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_import_runs (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  requested_by_key_id CHAR(36)      NULL,
  status              VARCHAR(32)   NOT NULL DEFAULT 'queued',
  dry_run             TINYINT(1)    NOT NULL DEFAULT 0,
  start_cursor        VARCHAR(512)  NULL,
  current_cursor      VARCHAR(512)  NULL,
  records_fetched     INT UNSIGNED  NOT NULL DEFAULT 0,
  records_inserted    INT UNSIGNED  NOT NULL DEFAULT 0,
  records_linked      INT UNSIGNED  NOT NULL DEFAULT 0,
  records_skipped     INT UNSIGNED  NOT NULL DEFAULT 0,
  records_conflicted  INT UNSIGNED  NOT NULL DEFAULT 0,
  records_failed      INT UNSIGNED  NOT NULL DEFAULT 0,
  pages_processed     INT UNSIGNED  NOT NULL DEFAULT 0,
  expected_records    INT UNSIGNED  NULL,
  completion_reason   VARCHAR(64)   NULL,
  is_full_sync        TINYINT(1)    NOT NULL DEFAULT 0,
  error_summary       VARCHAR(1000) NULL,
  options_json        TEXT          NULL,
  started_at          TIMESTAMP     NULL DEFAULT NULL,
  completed_at        TIMESTAMP     NULL DEFAULT NULL,
  events_synced_at    TIMESTAMP     NULL DEFAULT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_crm_runs_integration (integration_id, created_at),
  KEY idx_crm_runs_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_import_staging (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id              CHAR(36)      NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  external_record_id  VARCHAR(191)  NOT NULL,
  payload_hash        CHAR(64)      NOT NULL,
  payload_json        LONGTEXT      NOT NULL,
  processing_status   VARCHAR(32)   NOT NULL DEFAULT 'pending',
  lead_id             VARCHAR(128)  NULL,
  error_message       VARCHAR(1000) NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at        TIMESTAMP     NULL DEFAULT NULL,
  UNIQUE KEY uq_crm_stage_run_record (run_id, external_record_id),
  KEY idx_crm_stage_status (run_id, processing_status),
  KEY idx_crm_stage_external (integration_id, external_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_source_links (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  lead_id             VARCHAR(128)  NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  external_record_id  VARCHAR(191)  NOT NULL,
  external_updated_at DATETIME      NULL,
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lead_source_record (integration_id, external_record_id),
  KEY idx_lead_source_lead (lead_id),
  KEY idx_lead_source_location (location_id, external_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_import_values (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id             VARCHAR(128)  NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  field_key           VARCHAR(191)  NOT NULL,
  data_type           VARCHAR(32)   NOT NULL DEFAULT 'string',
  value_text          TEXT          NULL,
  value_number        DECIMAL(30,8) NULL,
  value_datetime      DATETIME      NULL,
  value_boolean       TINYINT(1)    NULL,
  value_json          LONGTEXT      NULL,
  value_hash          CHAR(64)      NOT NULL,
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_run_id    CHAR(36)      NULL,
  is_current          TINYINT(1)    NOT NULL DEFAULT 1,
  UNIQUE KEY uq_lead_import_value (lead_id, integration_id, field_key),
  KEY idx_lead_value_field (integration_id, field_key),
  KEY idx_lead_value_hash (integration_id, field_key, value_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Complete current CRM contact payloads. Operational leads remain separate and are never replaced.
CREATE TABLE IF NOT EXISTS crm_contact_records (
  integration_id      CHAR(36)      NOT NULL,
  external_record_id  VARCHAR(191)  NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  lead_id             VARCHAR(128)  NULL,
  payload_hash        CHAR(64)      NOT NULL,
  payload_json        LONGTEXT      NOT NULL,
  external_updated_at DATETIME      NULL,
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_run_id    CHAR(36)      NULL,
  is_current          TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (integration_id, external_record_id),
  KEY idx_crm_contact_location (location_id, is_current, last_seen_at),
  KEY idx_crm_contact_lead (lead_id),
  KEY idx_crm_contact_run (last_seen_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Provider-defined custom field catalog for contact, opportunity, and custom object models.
CREATE TABLE IF NOT EXISTS crm_object_definitions (
  integration_id          CHAR(36)      NOT NULL,
  object_id               VARCHAR(191)  NOT NULL,
  location_id             VARCHAR(128)  NOT NULL,
  object_key              VARCHAR(191)  NOT NULL,
  singular_label          VARCHAR(255)  NULL,
  plural_label            VARCHAR(255)  NULL,
  is_standard             TINYINT(1)    NOT NULL DEFAULT 0,
  primary_display_property VARCHAR(191) NULL,
  metadata_json           LONGTEXT      NOT NULL,
  first_seen_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_current              TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (integration_id, object_id),
  KEY idx_crm_objects_location (integration_id, location_id, is_current),
  KEY idx_crm_object_key (integration_id, object_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_object_field_definitions (
  integration_id      CHAR(36)      NOT NULL,
  field_id            VARCHAR(191)  NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  object_model        VARCHAR(64)   NOT NULL DEFAULT 'contact',
  field_key           VARCHAR(191)  NULL,
  field_name          VARCHAR(255)  NULL,
  data_type           VARCHAR(64)   NULL,
  metadata_json       LONGTEXT      NOT NULL,
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_current          TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (integration_id, field_id),
  KEY idx_crm_object_fields (integration_id, object_model, is_current),
  KEY idx_crm_field_key (integration_id, field_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_import_conflicts (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  run_id              CHAR(36)      NULL,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  external_record_id  VARCHAR(191)  NOT NULL,
  candidate_lead_id   VARCHAR(128)  NULL,
  conflict_type       VARCHAR(64)   NOT NULL,
  detail_json         TEXT          NULL,
  status              VARCHAR(32)   NOT NULL DEFAULT 'open',
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at         TIMESTAMP     NULL DEFAULT NULL,
  KEY idx_lead_conflicts_status (integration_id, status, created_at),
  KEY idx_lead_conflicts_external (integration_id, external_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appointments (
  id              INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  locationId      VARCHAR(128) NULL,
  leadId          VARCHAR(128) NULL,
  userId          VARCHAR(128) NULL,
  calendarId      VARCHAR(191) NULL,
  externalEventId VARCHAR(191) NULL,
  externalContactId VARCHAR(191) NULL,
  source          VARCHAR(32)  NOT NULL DEFAULT 'divedeep',
  appointmentDate DATETIME     NULL,
  status          VARCHAR(64)  NOT NULL DEFAULT 'scheduled',
  syncedAt        DATETIME     NULL,
  createdAt       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_appointments_user (locationId, userId),
  KEY idx_appointments_lead_status (locationId, leadId, status, appointmentDate),
  UNIQUE KEY uq_appointments_external_event (locationId, externalEventId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_calendar_sync_state (
  location_id       VARCHAR(128) NOT NULL,
  lead_id           VARCHAR(128) NOT NULL,
  integration_id    CHAR(36)     NULL,
  result             VARCHAR(24)  NOT NULL DEFAULT 'unknown',
  external_event_id VARCHAR(191) NULL,
  last_checked_at   TIMESTAMP(3) NULL DEFAULT NULL,
  retry_after_at    TIMESTAMP(3) NULL DEFAULT NULL,
  last_error_code   VARCHAR(64)  NULL,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (location_id, lead_id),
  KEY idx_calendar_sync_retry (retry_after_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_call_restriction_overrides (
  id                 CHAR(36)      NOT NULL PRIMARY KEY,
  location_id        VARCHAR(128)  NOT NULL,
  lead_id            VARCHAR(128)  NOT NULL,
  restriction_code   VARCHAR(64)   NOT NULL,
  reason             VARCHAR(255)  NOT NULL,
  remaining_uses     SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  expires_at         TIMESTAMP(3)  NOT NULL,
  created_by_admin_id VARCHAR(64)  NULL,
  created_by_username VARCHAR(128) NULL,
  consumed_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  revoked_at         TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_call_override_active (location_id, lead_id, restriction_code, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rewards (
  id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  userId        VARCHAR(128) NULL,
  leadId        VARCHAR(128) NULL,
  amount        DOUBLE       NULL,
  type          VARCHAR(64)  NULL,
  createdAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rewards_user (locationId, userId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(128) NOT NULL PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  username      VARCHAR(128) NULL,
  passwordHash  VARCHAR(255) NULL,
  role          VARCHAR(64)  NULL,
  crmUserId     VARCHAR(128) NULL,
  crmUserName   VARCHAR(255) NULL,
  email         VARCHAR(255) NULL,
  phone         VARCHAR(64)  NULL,
  createdAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_users_location (locationId),
  KEY idx_users_location_username (locationId, username),
  KEY idx_users_location_email (locationId, email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OWL authority for which CRM users may receive each HAWK service-pool assignment.
CREATE TABLE IF NOT EXISTS owl_user_pool_permissions (
  location_id       VARCHAR(128) NOT NULL,
  user_id           VARCHAR(128) NOT NULL,
  service_pool      VARCHAR(64)  NOT NULL,
  is_enabled        TINYINT(1)   NOT NULL DEFAULT 1,
  assignment_count  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_assigned_at  DATETIME(3)  NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (location_id,user_id,service_pool),
  KEY idx_owl_pool_round_robin (location_id,service_pool,is_enabled,last_assigned_at,assignment_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Location-scoped assignment policy. Schedule enforcement is deliberately opt-in.
CREATE TABLE IF NOT EXISTS owl_assignment_policies (
  location_id                VARCHAR(128) NOT NULL PRIMARY KEY,
  require_submitted_schedule TINYINT(1)   NOT NULL DEFAULT 0,
  language_field_id          VARCHAR(191) NULL,
  language_field_key         VARCHAR(191) NULL,
  default_language_code      VARCHAR(35)  NOT NULL DEFAULT 'en',
  language_rules_json        TEXT         NOT NULL,
  created_at                 DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS owl_user_language_permissions (
  location_id   VARCHAR(128) NOT NULL,
  user_id       VARCHAR(128) NOT NULL,
  language_code VARCHAR(35)  NOT NULL,
  is_enabled    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (location_id,user_id,language_code),
  KEY idx_owl_language_assignment (location_id,language_code,is_enabled,user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable assignment evidence for HAWK execution history and Sentinel review.
CREATE TABLE IF NOT EXISTS hawk_dialer_assignment_events (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  api_key_id         CHAR(36)     NULL,
  location_id        VARCHAR(128) NOT NULL,
  contact_id         VARCHAR(191) NOT NULL,
  service_pool       VARCHAR(64)  NOT NULL,
  user_id            VARCHAR(128) NULL,
  crm_user_id        VARCHAR(128) NOT NULL,
  assignment_source  VARCHAR(32)  NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_hawk_assignment_contact (location_id,contact_id,created_at),
  KEY idx_hawk_assignment_user (location_id,crm_user_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_schedules (
  userId        VARCHAR(128) NOT NULL PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  scheduleData  LONGTEXT     NULL,
  updatedAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_schedules_location (locationId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Short-lived Dialer operator sessions. Raw tokens are returned once and never stored.
CREATE TABLE IF NOT EXISTS api_operator_sessions (
  token_hash   CHAR(64)      NOT NULL PRIMARY KEY,
  api_key_id   CHAR(36)      NULL,
  user_id      VARCHAR(128)  NOT NULL,
  location_id  VARCHAR(128)  NOT NULL,
  is_admin     TINYINT(1)    NOT NULL DEFAULT 0,
  expires_at   DATETIME(3)   NOT NULL,
  created_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at   DATETIME(3)   NULL,
  KEY idx_operator_session_user (location_id,user_id,expires_at),
  KEY idx_operator_session_expiry (expires_at,revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Weekly dialer schedule ledger. A saved draft is intentionally distinct from submission.
CREATE TABLE IF NOT EXISTS user_schedule_weeks (
  locationId       VARCHAR(128) NOT NULL,
  userId           VARCHAR(128) NOT NULL,
  weekStart        DATE         NOT NULL,
  weekEnd          DATE         NOT NULL,
  scheduleData     LONGTEXT     NULL,
  scheduledMinutes INT UNSIGNED NOT NULL DEFAULT 0,
  submittedAt      DATETIME(3)  NULL,
  createdAt        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (locationId, userId, weekStart),
  KEY idx_schedule_weeks_status (locationId, weekStart, submittedAt),
  KEY idx_schedule_weeks_user (userId, weekStart)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only work sessions provide actual time for OWL schedule reporting.
CREATE TABLE IF NOT EXISTS dialer_work_sessions (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  locationId      VARCHAR(128) NOT NULL,
  userId          VARCHAR(128) NOT NULL,
  weekStart       DATE         NOT NULL,
  startedAt       DATETIME(3)  NOT NULL,
  endedAt         DATETIME(3)  NULL,
  durationSeconds INT UNSIGNED NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'active',
  source          VARCHAR(32)  NOT NULL DEFAULT 'dialer',
  createdAt       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_work_sessions_report (locationId, weekStart, userId),
  KEY idx_work_sessions_active (locationId, userId, endedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_errors (
  id            VARCHAR(128) NOT NULL PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  userId        VARCHAR(128) NULL,
  username      VARCHAR(128) NULL,
  type          VARCHAR(128) NULL,
  message       TEXT         NULL,
  details       LONGTEXT     NULL,
  url           TEXT         NULL,
  timestamp     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_errors_location (locationId, timestamp),
  KEY idx_errors_user (locationId, userId, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_logs (
  id            VARCHAR(128) NOT NULL PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  userId        VARCHAR(128) NULL,
  username      VARCHAR(128) NULL,
  email         VARCHAR(255) NULL,
  status        VARCHAR(64)  NULL,
  userAgent     TEXT         NULL,
  timestamp     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_auth_logs_location (locationId, timestamp),
  KEY idx_auth_logs_user (locationId, userId, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OWL super-admin domain operations audit (no raw SQL or secrets)
CREATE TABLE IF NOT EXISTS owl_audit_events (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  admin_id        CHAR(36)      NULL,
  admin_username  VARCHAR(128)  NULL,
  api_key_id      CHAR(36)      NOT NULL,
  source_slug     VARCHAR(64)   NOT NULL DEFAULT 'core',
  location_id     VARCHAR(128)  NULL,
  action          VARCHAR(64)   NOT NULL,
  entity_type     VARCHAR(64)   NOT NULL,
  entity_id       VARCHAR(128)  NULL,
  before_json     MEDIUMTEXT    NULL,
  after_json      MEDIUMTEXT    NULL,
  detail          VARCHAR(512)  NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_owl_audit_created (created_at),
  KEY idx_owl_audit_key (api_key_id, created_at),
  KEY idx_owl_audit_source (source_slug, location_id, created_at),
  KEY idx_owl_audit_entity (entity_type, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OWL lead routing definitions. Rules are scoped to a database source and location.
CREATE TABLE IF NOT EXISTS owl_lead_pool_rules (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  source_slug           VARCHAR(64)   NOT NULL DEFAULT 'core',
  location_id           VARCHAR(128)  NOT NULL,
  pool_key              VARCHAR(64)   NOT NULL,
  label                 VARCHAR(128)  NOT NULL,
  status_values_json    TEXT          NOT NULL,
  destination_status    VARCHAR(64)   NOT NULL,
  assignment_policy     VARCHAR(32)   NOT NULL DEFAULT 'clear',
  is_assignable         TINYINT(1)    NOT NULL DEFAULT 0,
  is_terminal           TINYINT(1)    NOT NULL DEFAULT 0,
  color                 CHAR(7)       NOT NULL DEFAULT '#64748b',
  sort_order            INT           NOT NULL DEFAULT 100,
  is_enabled            TINYINT(1)    NOT NULL DEFAULT 1,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_owl_pool_context (source_slug, location_id, pool_key),
  KEY idx_owl_pool_location (source_slug, location_id, is_enabled, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dialer service pools: maps CRM tag keywords to the leads.serviceType contract.
CREATE TABLE IF NOT EXISTS owl_service_pools (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  source_slug         VARCHAR(64)   NOT NULL DEFAULT 'core',
  location_id         VARCHAR(128)  NOT NULL,
  service_type        VARCHAR(128)  NOT NULL,
  tag_keywords_json   TEXT          NOT NULL,
  calendar_ids_json   TEXT          NOT NULL,
  default_calendar_id VARCHAR(191)  NULL,
  fallback_user_id    VARCHAR(128)  NULL,
  is_fallback         TINYINT(1)    NOT NULL DEFAULT 0,
  color               CHAR(7)       NOT NULL DEFAULT '#64748b',
  sort_order          INT           NOT NULL DEFAULT 100,
  is_enabled          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_owl_service_context (source_slug, location_id, service_type),
  KEY idx_owl_service_location (source_slug, location_id, is_enabled, sort_order),
  KEY idx_owl_service_fallback_user (location_id, fallback_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SONG script definitions. Drafts are mutable with optimistic revision control.
CREATE TABLE IF NOT EXISTS song_scripts (
  id                   CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id           CHAR(36)      NOT NULL,
  location_id          VARCHAR(128)  NOT NULL,
  service_type         VARCHAR(128)  NOT NULL,
  language_code        VARCHAR(35)   NOT NULL DEFAULT 'en-US',
  name                 VARCHAR(191)  NOT NULL,
  description          VARCHAR(1000) NULL,
  status               ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  draft_revision       INT UNSIGNED  NOT NULL DEFAULT 1,
  draft_graph_json     MEDIUMTEXT    NOT NULL,
  published_version_id CHAR(36)      NULL,
  created_by           CHAR(36)      NULL,
  updated_by           CHAR(36)      NULL,
  created_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_song_script_scope (api_key_id,location_id,status,updated_at),
  KEY idx_song_script_service (api_key_id,location_id,service_type,status),
  KEY idx_song_script_language (api_key_id,location_id,service_type,language_code,status),
  KEY idx_song_script_published (published_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Published SONG versions are immutable snapshots consumed by Dialer runtime.
CREATE TABLE IF NOT EXISTS song_script_versions (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  script_id       CHAR(36)      NOT NULL,
  version_number  INT UNSIGNED  NOT NULL,
  graph_json      MEDIUMTEXT    NOT NULL,
  compiled_json   MEDIUMTEXT    NOT NULL,
  checksum        CHAR(64)      NOT NULL,
  validation_json TEXT          NOT NULL,
  published_by    CHAR(36)      NULL,
  published_at    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_song_script_version (script_id,version_number),
  KEY idx_song_version_checksum (checksum)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One active published script version per tenant/location/service pool.
CREATE TABLE IF NOT EXISTS song_service_assignments (
  api_key_id  CHAR(36)      NOT NULL,
  location_id VARCHAR(128)  NOT NULL,
  service_type VARCHAR(128) NOT NULL,
  script_id   CHAR(36)      NOT NULL,
  version_id  CHAR(36)      NOT NULL,
  updated_by  CHAR(36)      NULL,
  updated_at  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (api_key_id,location_id,service_type),
  KEY idx_song_assignment_script (script_id,version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One active published script version per tenant/location/service/language.
CREATE TABLE IF NOT EXISTS song_service_language_assignments (
  api_key_id   CHAR(36)      NOT NULL,
  location_id  VARCHAR(128)  NOT NULL,
  service_type VARCHAR(128)  NOT NULL,
  language_code VARCHAR(35)  NOT NULL,
  script_id    CHAR(36)      NOT NULL,
  version_id   CHAR(36)      NOT NULL,
  updated_by   CHAR(36)      NULL,
  updated_at   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (api_key_id,location_id,service_type,language_code),
  KEY idx_song_language_assignment_script (script_id,version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only runtime analytics. Metadata is size-limited and secret-filtered by the API.
CREATE TABLE IF NOT EXISTS song_runtime_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  api_key_id       CHAR(36)      NOT NULL,
  location_id      VARCHAR(128)  NOT NULL,
  script_id        CHAR(36)      NOT NULL,
  version_id       CHAR(36)      NOT NULL,
  operator_user_id VARCHAR(128)  NOT NULL,
  lead_id          VARCHAR(128)  NULL,
  node_id          VARCHAR(64)   NULL,
  branch_id        VARCHAR(64)   NULL,
  event_type       VARCHAR(32)   NOT NULL,
  outcome          VARCHAR(64)   NULL,
  metadata_json    TEXT          NULL,
  occurred_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_song_event_scope (api_key_id,location_id,occurred_at),
  KEY idx_song_event_script (script_id,version_id,occurred_at),
  KEY idx_song_event_node (script_id,node_id,event_type,occurred_at),
  KEY idx_song_event_operator (operator_user_id,occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- HAWK: independently versioned automations and append-only execution evidence.
CREATE TABLE IF NOT EXISTS hawk_flow_folders (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id            CHAR(36)      NOT NULL,
  location_id           VARCHAR(128)  NOT NULL,
  data_source_slug      VARCHAR(63)   NOT NULL DEFAULT 'core',
  name                  VARCHAR(191)  NOT NULL,
  description           VARCHAR(500)  NULL,
  color                 CHAR(7)       NOT NULL DEFAULT '#2f85de',
  sort_order            INT UNSIGNED  NOT NULL DEFAULT 0,
  created_by            CHAR(36)      NULL,
  updated_by            CHAR(36)      NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_hawk_folder_source_name (api_key_id,location_id,data_source_slug,name),
  KEY idx_hawk_folder_scope (api_key_id,location_id,data_source_slug,sort_order,name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hawk_flows (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id            CHAR(36)      NOT NULL,
  location_id           VARCHAR(128)  NOT NULL,
  data_source_slug      VARCHAR(63)   NOT NULL DEFAULT 'core',
  integration_id        CHAR(36)      NULL,
  name                  VARCHAR(191)  NOT NULL,
  description           VARCHAR(1000) NULL,
  folder_id             CHAR(36)      NULL,
  color                 CHAR(7)       NULL,
  sort_order            INT UNSIGNED  NOT NULL DEFAULT 0,
  status                VARCHAR(16)   NOT NULL DEFAULT 'draft',
  draft_revision        INT UNSIGNED  NOT NULL DEFAULT 1,
  draft_graph_json      MEDIUMTEXT    NOT NULL,
  published_version_id  CHAR(36)      NULL,
  created_by            CHAR(36)      NULL,
  updated_by            CHAR(36)      NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_hawk_flow_scope (api_key_id,location_id,status,updated_at),
  KEY idx_hawk_flow_data_source (api_key_id,location_id,data_source_slug,status,updated_at),
  KEY idx_hawk_flow_folder (api_key_id,location_id,folder_id,sort_order),
  KEY idx_hawk_flow_integration (integration_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hawk_flow_versions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  flow_id               CHAR(36)      NOT NULL,
  version_number        INT UNSIGNED  NOT NULL,
  graph_json            MEDIUMTEXT    NOT NULL,
  checksum              CHAR(64)      NOT NULL,
  published_by          CHAR(36)      NULL,
  published_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_hawk_flow_version (flow_id,version_number),
  KEY idx_hawk_version_checksum (checksum)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hawk_executions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  flow_id               CHAR(36)      NOT NULL,
  version_id            CHAR(36)      NULL,
  api_key_id            CHAR(36)      NOT NULL,
  location_id           VARCHAR(128)  NOT NULL,
  data_source_slug      VARCHAR(63)   NOT NULL DEFAULT 'core',
  trigger_type          VARCHAR(64)   NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'queued',
  mode                  VARCHAR(16)   NOT NULL DEFAULT 'dry_run',
  idempotency_key       VARCHAR(191)  NULL,
  replay_of_execution_id CHAR(36)     NULL,
  request_id            VARCHAR(64)   NULL,
  input_json            MEDIUMTEXT    NULL,
  output_json           MEDIUMTEXT    NULL,
  error_code            VARCHAR(64)   NULL,
  error_message         VARCHAR(1000) NULL,
  steps_total           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  steps_completed       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  initiated_by_type     VARCHAR(32)   NOT NULL DEFAULT 'admin',
  initiated_by_id       VARCHAR(128)  NULL,
  started_at            TIMESTAMP(3)  NULL,
  completed_at          TIMESTAMP(3)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_hawk_idempotency (flow_id,idempotency_key),
  KEY idx_hawk_execution_scope (api_key_id,location_id,created_at),
  KEY idx_hawk_execution_data_source (api_key_id,location_id,data_source_slug,created_at),
  KEY idx_hawk_execution_flow (flow_id,status,created_at),
  KEY idx_hawk_execution_replay (replay_of_execution_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hawk_execution_steps (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  execution_id          CHAR(36)      NOT NULL,
  node_id               VARCHAR(64)   NOT NULL,
  node_type             VARCHAR(24)   NOT NULL,
  action_type           VARCHAR(64)   NULL,
  attempt_number        SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  status                VARCHAR(24)   NOT NULL DEFAULT 'running',
  input_json            MEDIUMTEXT    NULL,
  output_json           MEDIUMTEXT    NULL,
  error_code            VARCHAR(64)   NULL,
  error_message         VARCHAR(1000) NULL,
  duration_ms           INT UNSIGNED  NULL,
  started_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at          TIMESTAMP(3)  NULL,
  UNIQUE KEY uq_hawk_execution_node_attempt (execution_id,node_id,attempt_number),
  KEY idx_hawk_step_execution (execution_id,started_at),
  KEY idx_hawk_step_status (status,started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Public, flow-scoped webhook adapters. Secrets are encrypted at rest and are
-- returned only when an endpoint is first provisioned or rotated.
CREATE TABLE IF NOT EXISTS hawk_webhook_endpoints (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  flow_id               CHAR(36)      NOT NULL,
  public_id             VARCHAR(64)   NOT NULL,
  secret_enc            TEXT          NOT NULL,
  secret_hint           VARCHAR(12)   NOT NULL,
  is_enabled            TINYINT(1)    NOT NULL DEFAULT 1,
  created_by            CHAR(36)      NULL,
  rotated_by            CHAR(36)      NULL,
  last_received_at      TIMESTAMP(3)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_hawk_webhook_flow (flow_id),
  UNIQUE KEY uq_hawk_webhook_public (public_id),
  KEY idx_hawk_webhook_enabled (is_enabled,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Payload bodies are not duplicated here. Redacted trigger data and full step
-- evidence remain in hawk_executions; this table tracks delivery/auth status.
CREATE TABLE IF NOT EXISTS hawk_webhook_deliveries (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  endpoint_id           CHAR(36)      NOT NULL,
  flow_id               CHAR(36)      NOT NULL,
  request_id            VARCHAR(64)   NULL,
  event_key             VARCHAR(191)  NOT NULL,
  payload_sha256        CHAR(64)      NOT NULL,
  auth_mode             VARCHAR(16)   NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'accepted',
  execution_id          CHAR(36)      NULL,
  error_code            VARCHAR(64)   NULL,
  received_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at          TIMESTAMP(3)  NULL,
  UNIQUE KEY uq_hawk_webhook_event (endpoint_id,event_key),
  KEY idx_hawk_webhook_delivery_flow (flow_id,received_at),
  KEY idx_hawk_webhook_delivery_status (status,received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PARROT registered Python bridge runs. Business payloads are redacted and
-- bounded before storage; Sentinel separately records the security lifecycle.
CREATE TABLE IF NOT EXISTS parrot_scripts (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id            CHAR(36)      NOT NULL,
  data_source_slug      VARCHAR(63)   NOT NULL DEFAULT 'core',
  slug                  VARCHAR(96)   NOT NULL,
  name                  VARCHAR(191)  NOT NULL,
  description           VARCHAR(1000) NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'draft',
  latest_version_id     CHAR(36)      NULL,
  deployed_version_id   CHAR(36)      NULL,
  created_by            VARCHAR(64)   NULL,
  updated_by            VARCHAR(64)   NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_parrot_script_slug (api_key_id,data_source_slug,slug),
  KEY idx_parrot_script_scope (api_key_id,data_source_slug,status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parrot_script_versions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  script_id             CHAR(36)      NOT NULL,
  version_number        INT UNSIGNED  NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'draft',
  source_code           MEDIUMTEXT    NOT NULL,
  source_sha256         CHAR(64)      NOT NULL,
  manifest_sha256       CHAR(64)      NOT NULL,
  capabilities_json     TEXT          NULL,
  input_schema_json     TEXT          NULL,
  validation_json       MEDIUMTEXT    NULL,
  change_note           VARCHAR(1000) NULL,
  created_by            VARCHAR(64)   NULL,
  approved_by           VARCHAR(64)   NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  approved_at           TIMESTAMP(3)  NULL,
  last_dry_run_at       TIMESTAMP(3)  NULL,
  UNIQUE KEY uq_parrot_script_version (script_id,version_number),
  UNIQUE KEY uq_parrot_script_manifest (script_id,manifest_sha256),
  KEY idx_parrot_script_source_hash (script_id,source_sha256),
  KEY idx_parrot_version_status (script_id,status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parrot_runs (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  request_id            VARCHAR(64)   NOT NULL,
  api_key_id             CHAR(36)      NOT NULL,
  location_id            VARCHAR(128)  NOT NULL,
  data_source_slug       VARCHAR(63)   NOT NULL DEFAULT 'core',
  source                 VARCHAR(16)   NOT NULL,
  script_id              VARCHAR(96)   NOT NULL,
  script_version         VARCHAR(32)   NULL,
  mode                   VARCHAR(16)   NOT NULL DEFAULT 'dry_run',
  status                 VARCHAR(24)   NOT NULL DEFAULT 'running',
  idempotency_key        VARCHAR(191)  NULL,
  input_json             MEDIUMTEXT    NULL,
  output_json            MEDIUMTEXT    NULL,
  error_code             VARCHAR(64)   NULL,
  error_message          VARCHAR(1000) NULL,
  duration_ms            INT UNSIGNED  NULL,
  initiated_by_type      VARCHAR(32)   NULL,
  initiated_by_id        VARCHAR(128)  NULL,
  started_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at           TIMESTAMP(3)  NULL,
  created_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_parrot_idempotency (api_key_id,location_id,source,script_id,idempotency_key),
  KEY idx_parrot_scope (api_key_id,location_id,created_at),
  KEY idx_parrot_script (script_id,status,created_at),
  KEY idx_parrot_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audits DNC screening activity. Vendor tokens and CRM credentials are never stored here.
CREATE TABLE IF NOT EXISTS dnc_pulse_events (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id          CHAR(36)      NOT NULL,
  lead_id             VARCHAR(128)  NOT NULL,
  external_contact_id VARCHAR(191)  NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  action              VARCHAR(32)   NOT NULL DEFAULT 'url_issued',
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_dnc_pulse_location (location_id, created_at),
  KEY idx_dnc_pulse_lead (lead_id, created_at),
  KEY idx_dnc_pulse_key (api_key_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- EAGLE executive reporting snapshots. CRM facts are immutable per snapshot; dialer fields are overlays.
CREATE TABLE IF NOT EXISTS eagle_snapshots (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  status              VARCHAR(24)   NOT NULL DEFAULT 'queued',
  total_contacts      INT UNSIGNED  NOT NULL DEFAULT 0,
  pages_processed     INT UNSIGNED  NOT NULL DEFAULT 0,
  error_summary       VARCHAR(1000) NULL,
  requested_by        CHAR(36)      NULL,
  started_at          TIMESTAMP     NULL DEFAULT NULL,
  completed_at        TIMESTAMP     NULL DEFAULT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_snapshot_context (integration_id, location_id, status, created_at),
  KEY idx_eagle_snapshot_key (api_key_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eagle_lead_facts (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  snapshot_id         CHAR(36)      NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  external_contact_id VARCHAR(191)  NOT NULL,
  lead_id             VARCHAR(128)  NULL,
  full_name           VARCHAR(255)  NULL,
  email               VARCHAR(255)  NULL,
  phone               VARCHAR(64)   NULL,
  city                VARCHAR(128)  NULL,
  state_code          CHAR(2)       NULL,
  postal_code         VARCHAR(24)   NULL,
  country             VARCHAR(64)   NULL,
  marketing_source    VARCHAR(191)  NULL,
  campaign            VARCHAR(191)  NULL,
  medium              VARCHAR(128)  NULL,
  service_type        VARCHAR(128)  NULL,
  crm_disposition     VARCHAR(64)   NOT NULL DEFAULT 'New / Unworked',
  crm_assigned_to     VARCHAR(191)  NULL,
  dial_status         VARCHAR(64)   NULL,
  dial_assigned_to    VARCHAR(128)  NULL,
  dnc_status          VARCHAR(16)   NULL,
  tags_json           TEXT          NULL,
  crm_date_added      DATETIME      NULL,
  crm_updated_at      DATETIME      NULL,
  demographics_json   TEXT          NULL,
  captured_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_eagle_snapshot_contact (snapshot_id, external_contact_id),
  KEY idx_eagle_geo (snapshot_id, state_code, city),
  KEY idx_eagle_marketing (snapshot_id, marketing_source, campaign),
  KEY idx_eagle_funnel (snapshot_id, crm_disposition, service_type),
  KEY idx_eagle_date (snapshot_id, crm_date_added),
  KEY idx_eagle_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Versioned business definitions used by EAGLE semantic metric responses.
CREATE TABLE IF NOT EXISTS eagle_metric_definitions (
  metric_id          VARCHAR(64)   NOT NULL PRIMARY KEY,
  definition_version VARCHAR(16)   NOT NULL,
  label              VARCHAR(128)  NOT NULL,
  description        VARCHAR(1000) NOT NULL,
  unit               VARCHAR(24)   NOT NULL,
  numerator_label    VARCHAR(255)  NULL,
  denominator_label  VARCHAR(255)  NULL,
  time_basis         VARCHAR(64)   NOT NULL,
  business_owner     VARCHAR(128)  NOT NULL DEFAULT 'Revenue Operations',
  is_active          TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Integration-scoped aliases for governed source and campaign dimensions.
CREATE TABLE IF NOT EXISTS eagle_attribution_mappings (
  id                 BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  integration_id     CHAR(36)      NOT NULL,
  dimension_type     VARCHAR(16)   NOT NULL,
  raw_value          VARCHAR(255)  NOT NULL,
  canonical_value    VARCHAR(255)  NULL,
  channel            VARCHAR(64)   NULL,
  mapping_status     VARCHAR(16)   NOT NULL DEFAULT 'active',
  unknown_reason     VARCHAR(32)   NULL,
  created_by         CHAR(36)      NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_eagle_attribution_mapping (integration_id, dimension_type, raw_value),
  KEY idx_eagle_attribution_canonical (integration_id, dimension_type, canonical_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Authoritative, deduplicated lifecycle events used by EAGLE historical cohorts.
CREATE TABLE IF NOT EXISTS eagle_lead_events (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  external_contact_id VARCHAR(191)  NOT NULL,
  lead_id             VARCHAR(128)  NULL,
  event_type          VARCHAR(40)   NOT NULL,
  event_at            DATETIME      NOT NULL,
  source_type         VARCHAR(32)   NOT NULL,
  source_event_id     VARCHAR(191)  NOT NULL,
  event_status        VARCHAR(32)   NULL,
  metadata_json       TEXT          NULL,
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_eagle_lead_event (integration_id, source_type, source_event_id, event_type),
  KEY idx_eagle_event_contact (integration_id, external_contact_id, event_type, event_at),
  KEY idx_eagle_event_time (integration_id, event_type, event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Manifests make opportunity completeness explicit before win metrics become available.
CREATE TABLE IF NOT EXISTS eagle_outcome_imports (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  snapshot_id         CHAR(36)      NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  source_system       VARCHAR(64)   NOT NULL,
  is_complete         TINYINT(1)    NOT NULL DEFAULT 0,
  records_received    INT UNSIGNED  NOT NULL DEFAULT 0,
  records_with_won_at INT UNSIGNED  NOT NULL DEFAULT 0,
  error_summary       VARCHAR(1000) NULL,
  imported_by         CHAR(36)      NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_outcome_import_snapshot (snapshot_id, is_complete, created_at),
  KEY idx_eagle_outcome_import_context (integration_id, api_key_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Opportunity state at an EAGLE snapshot. Won/lost dates must come from the upstream source.
CREATE TABLE IF NOT EXISTS eagle_opportunity_snapshots (
  snapshot_id         CHAR(36)      NOT NULL,
  import_id           CHAR(36)      NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  opportunity_id      VARCHAR(191)  NOT NULL,
  external_contact_id VARCHAR(191)  NOT NULL,
  pipeline_id         VARCHAR(191)  NULL,
  stage_id            VARCHAR(191)  NULL,
  stage_name          VARCHAR(255)  NULL,
  opportunity_status  VARCHAR(24)   NOT NULL,
  monetary_value      DECIMAL(18,2) NULL,
  opened_at           DATETIME      NULL,
  won_at              DATETIME      NULL,
  lost_at             DATETIME      NULL,
  upstream_updated_at DATETIME      NULL,
  metadata_json       TEXT          NULL,
  captured_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_id, opportunity_id),
  KEY idx_eagle_opportunity_contact (snapshot_id, external_contact_id, opportunity_status),
  KEY idx_eagle_opportunity_won (integration_id, won_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Frozen executive KPI reconciliations against an independently supplied reference report.
CREATE TABLE IF NOT EXISTS eagle_validation_runs (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  snapshot_id         CHAR(36)      NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  reference_system    VARCHAR(128)  NOT NULL,
  scope_json          TEXT          NOT NULL,
  status              VARCHAR(24)   NOT NULL,
  checks_total        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  checks_passed       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  checks_failed       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  checks_unavailable  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_by          CHAR(36)      NULL,
  completed_at        TIMESTAMP     NULL DEFAULT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_validation_context (integration_id, status, created_at),
  KEY idx_eagle_validation_snapshot (snapshot_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eagle_validation_checks (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id              CHAR(36)      NOT NULL,
  metric_id           VARCHAR(64)   NOT NULL,
  metric_label        VARCHAR(128)  NOT NULL,
  metric_unit         VARCHAR(24)   NOT NULL,
  eagle_value         DECIMAL(24,6) NULL,
  reference_value     DECIMAL(24,6) NOT NULL,
  absolute_difference DECIMAL(24,6) NULL,
  percent_difference  DECIMAL(18,6) NULL,
  tolerance_value     DECIMAL(18,6) NOT NULL,
  tolerance_type      VARCHAR(32)   NOT NULL,
  outcome             VARCHAR(24)   NOT NULL,
  evidence_reference  VARCHAR(512)  NOT NULL,
  note                VARCHAR(1000) NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_eagle_validation_metric (run_id, metric_id),
  KEY idx_eagle_validation_outcome (outcome, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-integration feature rollout plus an immutable mode-change audit trail.
CREATE TABLE IF NOT EXISTS eagle_rollout_states (
  integration_id      CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id          CHAR(36)      NOT NULL,
  rollout_mode        VARCHAR(16)   NOT NULL DEFAULT 'parallel',
  required_passes     TINYINT UNSIGNED NOT NULL DEFAULT 2,
  promoted_by         CHAR(36)      NULL,
  promoted_at         TIMESTAMP     NULL DEFAULT NULL,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_eagle_rollout_key (api_key_id, rollout_mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eagle_rollout_audit (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  actor_admin_id      CHAR(36)      NULL,
  from_mode           VARCHAR(16)   NULL,
  to_mode             VARCHAR(16)   NOT NULL,
  reason              VARCHAR(1000) NOT NULL,
  validation_run_id   CHAR(36)      NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_rollout_audit_context (integration_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Restricted EAGLE debugging actions. Payloads retain state summaries, never schedule bodies.
CREATE TABLE IF NOT EXISTS eagle_debug_actions (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  actor_admin_id      CHAR(36)      NULL,
  actor_username      VARCHAR(128)  NULL,
  action              VARCHAR(64)   NOT NULL,
  entity_type         VARCHAR(64)   NOT NULL,
  entity_id           VARCHAR(128)  NOT NULL,
  reason              VARCHAR(512)  NOT NULL,
  before_json         TEXT          NULL,
  after_json          TEXT          NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_eagle_debug_context (integration_id, location_id, created_at),
  KEY idx_eagle_debug_entity (entity_type, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Approved KPI targets are integration scoped; every change retains its governance reason.
CREATE TABLE IF NOT EXISTS eagle_metric_targets (
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  metric_id           VARCHAR(64)   NOT NULL,
  period_days         SMALLINT UNSIGNED NULL,
  target_value        DECIMAL(24,6) NOT NULL,
  target_direction    VARCHAR(16)   NOT NULL,
  warning_margin      DECIMAL(18,6) NOT NULL DEFAULT 0,
  business_owner      VARCHAR(128)  NOT NULL,
  is_active           TINYINT(1)    NOT NULL DEFAULT 1,
  updated_by          CHAR(36)      NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (integration_id, metric_id),
  KEY idx_eagle_target_key (api_key_id, is_active, metric_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eagle_metric_target_audit (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  metric_id           VARCHAR(64)   NOT NULL,
  actor_admin_id      CHAR(36)      NULL,
  reason              VARCHAR(1000) NOT NULL,
  before_json         TEXT          NULL,
  after_json          TEXT          NOT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_target_audit (integration_id, metric_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eagle_campaign_sync_runs (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id   CHAR(36)      NOT NULL,
  api_key_id       CHAR(36)      NOT NULL,
  location_id      VARCHAR(128)  NOT NULL,
  status           VARCHAR(24)   NOT NULL DEFAULT 'queued',
  pages_processed  INT UNSIGNED  NOT NULL DEFAULT 0,
  events_received  INT UNSIGNED  NOT NULL DEFAULT 0,
  expected_events  INT UNSIGNED  NULL,
  range_start      DATE          NOT NULL,
  range_end        DATE          NOT NULL,
  error_summary    VARCHAR(1000) NULL,
  requested_by     CHAR(36)      NULL,
  started_at       TIMESTAMP     NULL DEFAULT NULL,
  completed_at     TIMESTAMP     NULL DEFAULT NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_campaign_run_context (integration_id, status, created_at),
  KEY idx_eagle_campaign_run_key (api_key_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Attribution-only projection. Form answers and message content are intentionally excluded.
CREATE TABLE IF NOT EXISTS eagle_campaign_events (
  integration_id   CHAR(36)      NOT NULL,
  event_id          VARCHAR(191)  NOT NULL,
  location_id       VARCHAR(128)  NOT NULL,
  contact_id        VARCHAR(191)  NULL,
  form_id           VARCHAR(191)  NULL,
  form_name         VARCHAR(255)  NULL,
  event_type        VARCHAR(64)   NULL,
  event_at          DATETIME      NOT NULL,
  page_url          VARCHAR(1600) NULL,
  page_title        VARCHAR(500)  NULL,
  page_domain       VARCHAR(255)  NULL,
  page_path         VARCHAR(800)  NULL,
  referrer_url      VARCHAR(1600) NULL,
  referrer_host     VARCHAR(255)  NULL,
  source            VARCHAR(191)  NULL,
  medium            VARCHAR(128)  NULL,
  ad_source         VARCHAR(191)  NULL,
  utm_source        VARCHAR(191)  NULL,
  utm_medium        VARCHAR(191)  NULL,
  utm_campaign      VARCHAR(255)  NULL,
  utm_content       VARCHAR(255)  NULL,
  fbclid            VARCHAR(1024) NULL,
  fbc               VARCHAR(512)  NULL,
  fbp               VARCHAR(512)  NULL,
  fb_event_id       VARCHAR(512)  NULL,
  gclid             VARCHAR(1024) NULL,
  last_sync_run_id  CHAR(36)      NOT NULL,
  first_seen_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (integration_id, event_id),
  KEY idx_eagle_campaign_date (integration_id, location_id, event_at),
  KEY idx_eagle_campaign_contact (integration_id, contact_id),
  KEY idx_eagle_campaign_page (integration_id, page_domain, page_path(191)),
  KEY idx_eagle_campaign_form (integration_id, form_id, event_at),
  KEY idx_eagle_campaign_utm (integration_id, utm_source, utm_campaign)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Official U.S. Census ACS population reference used for EAGLE market-footprint metrics.
CREATE TABLE IF NOT EXISTS census_geography_reference (
  dataset_year       SMALLINT UNSIGNED NOT NULL,
  geography_type     VARCHAR(16)       NOT NULL,
  state_fips         CHAR(2)           NOT NULL DEFAULT '',
  place_fips         CHAR(5)           NOT NULL DEFAULT '',
  state_code         CHAR(2)           NULL,
  name               VARCHAR(255)      NOT NULL,
  normalized_name    VARCHAR(191)      NULL,
  population         BIGINT UNSIGNED   NOT NULL DEFAULT 0,
  source_url         VARCHAR(500)      NOT NULL,
  fetched_at         TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_year, geography_type, state_fips, place_fips),
  KEY idx_census_place_match (dataset_year, geography_type, state_code, normalized_name),
  KEY idx_census_population (dataset_year, geography_type, population)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SQL Connection Hub: secondary MySQL targets (passwords encrypted at rest)
CREATE TABLE IF NOT EXISTS sql_connections (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  slug            VARCHAR(64)  NOT NULL,
  name            VARCHAR(128) NOT NULL,
  host            VARCHAR(255) NOT NULL,
  port            INT          NOT NULL DEFAULT 3306,
  database_name   VARCHAR(128) NOT NULL,
  username        VARCHAR(128) NOT NULL,
  password_enc    TEXT         NOT NULL,
  ssl_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  is_enabled      TINYINT(1)   NOT NULL DEFAULT 1,
  max_rows        INT          NOT NULL DEFAULT 500,
  notes           VARCHAR(512) NULL,
  created_by      CHAR(36)     NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sql_conn_slug (slug),
  KEY idx_sql_conn_enabled (is_enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which API keys may use which SQL connection
CREATE TABLE IF NOT EXISTS sql_connection_grants (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  connection_id   CHAR(36)     NOT NULL,
  api_key_id      CHAR(36)     NOT NULL,
  can_introspect  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sql_grant_key_conn (connection_id, api_key_id),
  KEY idx_sql_grant_key (api_key_id),
  KEY idx_sql_grant_conn (connection_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-grant table + operation allowlist (default deny)
CREATE TABLE IF NOT EXISTS sql_table_grants (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  grant_id        CHAR(36)     NOT NULL,
  table_name      VARCHAR(128) NOT NULL,
  allow_select    TINYINT(1)   NOT NULL DEFAULT 1,
  allow_insert    TINYINT(1)   NOT NULL DEFAULT 0,
  allow_update    TINYINT(1)   NOT NULL DEFAULT 0,
  allow_delete    TINYINT(1)   NOT NULL DEFAULT 0,
  primary_key     VARCHAR(64)  NOT NULL DEFAULT 'id',
  allowed_columns TEXT         NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sql_table_grant (grant_id, table_name),
  KEY idx_sql_table_grant (grant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dialer Session Harbor: per-operator workspace (CRM path + UI state; NOT CRM cookies)
CREATE TABLE IF NOT EXISTS dialer_workspaces (
  location_id     VARCHAR(128)  NOT NULL,
  user_id         VARCHAR(128)  NOT NULL,
  revision        INT UNSIGNED  NOT NULL DEFAULT 1,
  state_json      LONGTEXT      NOT NULL,
  crm_contact_id  VARCHAR(128)  NULL,
  crm_path        VARCHAR(512)  NULL,
  client_tab_id   VARCHAR(64)   NULL,
  lease_until     TIMESTAMP     NULL DEFAULT NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (location_id, user_id),
  KEY idx_workspace_updated (updated_at),
  KEY idx_workspace_contact (location_id, crm_contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per verified operator/activity minute. This is intentionally metadata-only:
-- no CRM payload, phone number, URL, cookie, token, or workspace state is retained.
CREATE TABLE IF NOT EXISTS dialer_activity_minutes (
  location_id    VARCHAR(128) NOT NULL,
  user_id        VARCHAR(128) NOT NULL,
  activity_minute DATETIME    NOT NULL,
  heartbeat_count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  crm_contact_id VARCHAR(128) NULL,
  client_tab_id  VARCHAR(64)  NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (location_id, user_id, activity_minute),
  KEY idx_activity_report (location_id, activity_minute, user_id),
  KEY idx_activity_contact (location_id, user_id, crm_contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sentinel OpSec Response: IP blocklist (enforced on /api/*)
CREATE TABLE IF NOT EXISTS sentinel_ip_blocks (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  ip             VARCHAR(45)   NOT NULL,
  cidr           VARCHAR(50)   NULL,
  reason         VARCHAR(512)  NOT NULL,
  source         VARCHAR(32)   NOT NULL DEFAULT 'manual',
  case_id        CHAR(36)      NULL,
  is_active      TINYINT(1)    NOT NULL DEFAULT 1,
  expires_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  created_by     VARCHAR(64)   NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  revoked_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  revoked_by     VARCHAR(64)   NULL,
  revoke_reason  VARCHAR(512)  NULL,
  KEY idx_ip_blocks_ip (ip),
  KEY idx_ip_blocks_active (is_active, expires_at),
  KEY idx_ip_blocks_case (case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Durable threat cases (review queue)
CREATE TABLE IF NOT EXISTS sentinel_threat_cases (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  fingerprint    VARCHAR(191)  NOT NULL,
  rule_id        VARCHAR(64)   NOT NULL,
  severity       VARCHAR(16)   NOT NULL,
  title          VARCHAR(255)  NOT NULL,
  summary        VARCHAR(512)  NOT NULL,
  entity_type    VARCHAR(32)   NOT NULL,
  entity         VARCHAR(255)  NOT NULL,
  status         VARCHAR(32)   NOT NULL DEFAULT 'open',
  owner_admin_id VARCHAR(64)   NULL,
  priority       VARCHAR(16)   NOT NULL DEFAULT 'normal',
  confidence     VARCHAR(16)   NULL,
  disposition    VARCHAR(32)   NULL,
  due_at         TIMESTAMP(3)  NULL DEFAULT NULL,
  evidence_json  MEDIUMTEXT    NULL,
  count          INT           NOT NULL DEFAULT 0,
  window_hours   INT           NULL,
  first_seen     TIMESTAMP(3)  NULL DEFAULT NULL,
  last_seen      TIMESTAMP(3)  NULL DEFAULT NULL,
  review_note    TEXT          NULL,
  resolution_summary TEXT      NULL,
  validation_summary TEXT      NULL,
  triaged_by     VARCHAR(64)   NULL,
  triaged_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  contained_by  VARCHAR(64)   NULL,
  contained_at  TIMESTAMP(3)  NULL DEFAULT NULL,
  resolved_by    VARCHAR(64)   NULL,
  resolved_at    TIMESTAMP(3)  NULL DEFAULT NULL,
  validated_by  VARCHAR(64)   NULL,
  validated_at  TIMESTAMP(3)  NULL DEFAULT NULL,
  closed_by      VARCHAR(64)   NULL,
  closed_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  reopen_count   INT UNSIGNED NOT NULL DEFAULT 0,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_case_fingerprint (fingerprint),
  KEY idx_cases_status (status, severity),
  KEY idx_cases_entity (entity_type, entity),
  KEY idx_cases_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Case action audit trail
CREATE TABLE IF NOT EXISTS sentinel_case_actions (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  case_id        CHAR(36)      NOT NULL,
  admin_id       VARCHAR(64)   NULL,
  action         VARCHAR(32)   NOT NULL,
  detail         VARCHAR(512)  NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_case_actions_case (case_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_case_notes (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  case_id        CHAR(36)      NOT NULL,
  admin_id       VARCHAR(64)   NULL,
  note_type      VARCHAR(32)   NOT NULL DEFAULT 'analyst',
  note           TEXT          NOT NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_case_notes_case (case_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_case_status_history (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  case_id        CHAR(36)      NOT NULL,
  admin_id       VARCHAR(64)   NULL,
  from_status    VARCHAR(32)   NULL,
  to_status      VARCHAR(32)   NOT NULL,
  reason         VARCHAR(512)  NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_case_history_case (case_id, created_at),
  KEY idx_case_history_status (to_status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Purple Team control validation. Stores metadata and outcomes only, never attack payloads.
CREATE TABLE IF NOT EXISTS sentinel_validation_runs (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  name           VARCHAR(128)  NOT NULL,
  objective      VARCHAR(512)  NULL,
  detection_window_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  status         VARCHAR(24)   NOT NULL DEFAULT 'planned',
  created_by     VARCHAR(64)   NULL,
  started_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  ended_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_validation_runs_status (status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_validation_observations (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  run_id           CHAR(36)      NOT NULL,
  technique_id     VARCHAR(32)   NOT NULL,
  tactic           VARCHAR(64)   NULL,
  expected_rule_id VARCHAR(64)   NULL,
  triggered_case_id CHAR(36)     NULL,
  outcome          VARCHAR(24)   NOT NULL,
  simulated_at     TIMESTAMP(3)  NOT NULL,
  detected_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  evaluated_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  evaluation_source VARCHAR(24)  NULL,
  remediation_case_id CHAR(36)   NULL,
  note             VARCHAR(1000) NULL,
  recorded_by      VARCHAR(64)   NULL,
  created_at       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_validation_observation_run (run_id,created_at),
  KEY idx_validation_observation_technique (technique_id,outcome),
  KEY idx_validation_observation_case (triggered_case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_rule_techniques (
  rule_id        VARCHAR(64)   NOT NULL,
  technique_id   VARCHAR(32)   NOT NULL,
  tactic         VARCHAR(64)   NULL,
  updated_by     VARCHAR(64)   NULL,
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (rule_id,technique_id),
  KEY idx_rule_technique (technique_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_routine_runs (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  routine_key    VARCHAR(64)   NOT NULL,
  routine_type   VARCHAR(32)   NOT NULL DEFAULT 'daily_protection',
  status         VARCHAR(24)   NOT NULL DEFAULT 'running',
  triggered_by   VARCHAR(64)   NULL,
  summary_json   MEDIUMTEXT    NULL,
  error_summary  VARCHAR(512)  NULL,
  started_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at   TIMESTAMP(3)  NULL DEFAULT NULL,
  UNIQUE KEY uq_sentinel_routine_key (routine_key),
  KEY idx_sentinel_routine_status (routine_type,status,started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_retention_policies (
  data_class     VARCHAR(64)   NOT NULL PRIMARY KEY,
  retention_days INT UNSIGNED NOT NULL,
  is_enabled     TINYINT(1)    NOT NULL DEFAULT 1,
  updated_by     VARCHAR(64)   NULL,
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_retention_runs (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  mode           VARCHAR(16)   NOT NULL,
  status         VARCHAR(24)   NOT NULL,
  executed_by    VARCHAR(64)   NULL,
  impact_json    MEDIUMTEXT    NULL,
  error_summary  VARCHAR(512)  NULL,
  started_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at   TIMESTAMP(3)  NULL DEFAULT NULL,
  KEY idx_retention_runs (status,started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_finding_dispositions (
  id                CHAR(36)      NOT NULL PRIMARY KEY,
  fingerprint       VARCHAR(191)  NOT NULL,
  rule_id           VARCHAR(64)   NOT NULL,
  entity_type       VARCHAR(32)   NOT NULL,
  entity            VARCHAR(255)  NOT NULL,
  disposition       VARCHAR(32)   NOT NULL,
  scope_json        TEXT          NULL,
  conditions_json   TEXT          NULL,
  reason            VARCHAR(1000) NOT NULL,
  baseline_count    INT           NULL,
  created_by        VARCHAR(64)   NULL,
  expires_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  created_at        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  revoked_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  revoked_by        VARCHAR(64)   NULL,
  revoke_reason     VARCHAR(512)  NULL,
  KEY idx_finding_disposition_fingerprint (fingerprint,is_active,expires_at),
  KEY idx_finding_disposition_rule (rule_id,is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Governed SOAR playbook library. Phase 1 supports analyst-controlled manual checklists only.
CREATE TABLE IF NOT EXISTS sentinel_playbooks (
  id CHAR(36) NOT NULL PRIMARY KEY,
  slug VARCHAR(96) NOT NULL,
  name VARCHAR(160) NOT NULL,
  purpose VARCHAR(512) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  owner_admin_id VARCHAR(64) NULL,
  current_version_id CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_playbook_slug (slug),
  KEY idx_sentinel_playbook_status (status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_versions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  playbook_id CHAR(36) NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  required_entities_json TEXT NULL,
  techniques_json TEXT NULL,
  preconditions_json TEXT NULL,
  rollback_plan TEXT NULL,
  created_by VARCHAR(64) NULL,
  approved_by VARCHAR(64) NULL,
  approved_at TIMESTAMP(3) NULL DEFAULT NULL,
  published_at TIMESTAMP(3) NULL DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_playbook_version (playbook_id,version_number),
  KEY idx_sentinel_playbook_version_status (status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_steps (
  id CHAR(36) NOT NULL PRIMARY KEY,
  version_id CHAR(36) NOT NULL,
  step_order SMALLINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  step_type VARCHAR(32) NOT NULL DEFAULT 'manual',
  risk_class VARCHAR(24) NOT NULL DEFAULT 'observe',
  is_required TINYINT(1) NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_playbook_step_order (version_id,step_order),
  KEY idx_sentinel_playbook_step_version (version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  playbook_id CHAR(36) NOT NULL,
  version_id CHAR(36) NOT NULL,
  case_id CHAR(36) NULL,
  finding_id VARCHAR(255) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'running',
  mode VARCHAR(24) NOT NULL DEFAULT 'manual',
  started_by VARCHAR(64) NULL,
  completed_by VARCHAR(64) NULL,
  analyst_note TEXT NULL,
  started_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at TIMESTAMP(3) NULL DEFAULT NULL,
  KEY idx_sentinel_playbook_run_status (status,started_at),
  KEY idx_sentinel_playbook_run_case (case_id,started_at),
  KEY idx_sentinel_playbook_run_book (playbook_id,started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_step_runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  step_id CHAR(36) NOT NULL,
  step_order SMALLINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  analyst_note VARCHAR(1000) NULL,
  evidence_reference VARCHAR(512) NULL,
  completed_by VARCHAR(64) NULL,
  completed_at TIMESTAMP(3) NULL DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_playbook_step_run (run_id,step_id),
  KEY idx_sentinel_playbook_step_run_status (run_id,status,step_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_reviews (
  id CHAR(36) NOT NULL PRIMARY KEY,
  playbook_id CHAR(36) NOT NULL,
  version_id CHAR(36) NOT NULL,
  actor_admin_id VARCHAR(64) NULL,
  action VARCHAR(32) NOT NULL,
  from_status VARCHAR(24) NULL,
  to_status VARCHAR(24) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_sentinel_playbook_review_book (playbook_id,created_at),
  KEY idx_sentinel_playbook_review_version (version_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_simulations (
  id CHAR(36) NOT NULL PRIMARY KEY,
  playbook_id CHAR(36) NOT NULL,
  version_id CHAR(36) NOT NULL,
  mode VARCHAR(24) NOT NULL,
  status VARCHAR(24) NOT NULL,
  context_hash CHAR(64) NOT NULL,
  context_summary_json TEXT NULL,
  action_plan_json MEDIUMTEXT NOT NULL,
  result_json MEDIUMTEXT NULL,
  executed_by VARCHAR(64) NULL,
  error_summary VARCHAR(512) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at TIMESTAMP(3) NULL DEFAULT NULL,
  KEY idx_sentinel_simulation_book (playbook_id,created_at),
  KEY idx_sentinel_simulation_mode (mode,status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_validation_results (
  id CHAR(36) NOT NULL PRIMARY KEY,
  playbook_id CHAR(36) NOT NULL,
  version_id CHAR(36) NOT NULL,
  gate_key VARCHAR(64) NOT NULL,
  outcome VARCHAR(24) NOT NULL,
  evidence_reference VARCHAR(512) NOT NULL,
  note VARCHAR(1000) NULL,
  tested_by VARCHAR(64) NULL,
  tested_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_playbook_validation_gate (version_id,gate_key),
  KEY idx_sentinel_playbook_validation_book (playbook_id,tested_at),
  KEY idx_sentinel_playbook_validation_outcome (outcome,tested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_resource_items (
  id CHAR(36) NOT NULL PRIMARY KEY,
  slug VARCHAR(128) NOT NULL,
  item_type VARCHAR(32) NOT NULL,
  category VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  summary VARCHAR(1000) NULL,
  publisher VARCHAR(128) NOT NULL,
  source_url VARCHAR(1000) NULL,
  source_domain VARCHAR(191) NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'normal',
  review_status VARCHAR(24) NOT NULL DEFAULT 'unreviewed',
  tags_json TEXT NULL,
  cves_json TEXT NULL,
  techniques_json TEXT NULL,
  assigned_to VARCHAR(64) NULL,
  linked_case_id CHAR(36) NULL,
  linked_playbook_id CHAR(36) NULL,
  analyst_note VARCHAR(1000) NULL,
  is_pinned TINYINT(1) NOT NULL DEFAULT 0,
  published_at TIMESTAMP(3) NULL DEFAULT NULL,
  reviewed_at TIMESTAMP(3) NULL DEFAULT NULL,
  reviewed_by VARCHAR(64) NULL,
  created_by VARCHAR(64) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_resource_slug (slug),
  KEY idx_sentinel_resource_review (review_status,priority,updated_at),
  KEY idx_sentinel_resource_type (item_type,category,is_pinned)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_resource_reviews (
  id CHAR(36) NOT NULL PRIMARY KEY,
  resource_id CHAR(36) NOT NULL,
  actor_admin_id VARCHAR(64) NULL,
  from_status VARCHAR(24) NULL,
  to_status VARCHAR(24) NOT NULL,
  note VARCHAR(1000) NULL,
  linked_case_id CHAR(36) NULL,
  linked_playbook_id CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_sentinel_resource_review_item (resource_id,created_at),
  KEY idx_sentinel_resource_review_actor (actor_admin_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin-defined flagging rules (safe JSON DSL, no raw SQL)
CREATE TABLE IF NOT EXISTS sentinel_custom_rules (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  name           VARCHAR(128)  NOT NULL,
  description    VARCHAR(512)  NULL,
  is_enabled     TINYINT(1)    NOT NULL DEFAULT 1,
  priority       INT           NOT NULL DEFAULT 100,
  severity       VARCHAR(16)   NOT NULL DEFAULT 'medium',
  condition_json TEXT          NOT NULL,
  actions_json   TEXT          NOT NULL,
  created_by     VARCHAR(64)   NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_custom_rules_enabled (is_enabled, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- First-contact IP radar
CREATE TABLE IF NOT EXISTS sentinel_ip_sightings (
  ip                   VARCHAR(45)   NOT NULL PRIMARY KEY,
  first_seen           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  first_status_code    SMALLINT      NULL,
  first_path           VARCHAR(255)  NULL,
  first_method         VARCHAR(10)   NULL,
  first_was_auth_fail  TINYINT(1)    NOT NULL DEFAULT 0,
  total_requests       INT           NOT NULL DEFAULT 0,
  auth_fail_count      INT           NOT NULL DEFAULT 0,
  success_count        INT           NOT NULL DEFAULT 0,
  last_status_code     SMALLINT      NULL,
  notes                VARCHAR(512)  NULL,
  KEY idx_sightings_first_fail (first_was_auth_fail, first_seen),
  KEY idx_sightings_first_seen (first_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- RDAP/WHOIS cache (server-side enrichment)
CREATE TABLE IF NOT EXISTS sentinel_ip_intel_cache (
  ip             VARCHAR(45)   NOT NULL PRIMARY KEY,
  payload_json   MEDIUMTEXT    NULL,
  provider       VARCHAR(32)   NOT NULL DEFAULT 'rdap',
  fetched_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at     TIMESTAMP(3)  NOT NULL,
  error          VARCHAR(255)  NULL,
  KEY idx_intel_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tenant-scoped OWL contact synchronization endpoints. Each endpoint is bound
-- server-side to one API key, location, operational SQL source, and CRM integration.
CREATE TABLE IF NOT EXISTS owl_webhook_endpoints (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id            CHAR(36)      NOT NULL,
  location_id           VARCHAR(128)  NOT NULL,
  data_source_slug      VARCHAR(63)   NOT NULL DEFAULT 'dial',
  integration_id        CHAR(36)      NOT NULL,
  public_id             VARCHAR(64)   NOT NULL,
  secret_enc            TEXT          NOT NULL,
  secret_hint           VARCHAR(12)   NOT NULL,
  allow_contact_created TINYINT(1)    NOT NULL DEFAULT 1,
  allow_contact_updated TINYINT(1)    NOT NULL DEFAULT 1,
  is_enabled            TINYINT(1)    NOT NULL DEFAULT 1,
  created_by            CHAR(36)      NULL,
  rotated_by            CHAR(36)      NULL,
  last_received_at      TIMESTAMP(3)  NULL,
  last_success_at       TIMESTAMP(3)  NULL,
  last_error_code       VARCHAR(64)   NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_owl_webhook_scope (api_key_id,location_id,data_source_slug),
  UNIQUE KEY uq_owl_webhook_public (public_id),
  KEY idx_owl_webhook_enabled (is_enabled,updated_at),
  KEY idx_owl_webhook_integration (integration_id,location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Delivery ledger stores bounded synchronization evidence, not credentials or
-- duplicated CRM payload bodies. Failed event IDs may be retried safely.
CREATE TABLE IF NOT EXISTS owl_webhook_deliveries (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  endpoint_id           CHAR(36)      NOT NULL,
  request_id            VARCHAR(64)   NULL,
  event_key             VARCHAR(191)  NOT NULL,
  event_name            VARCHAR(32)   NOT NULL,
  contact_id            VARCHAR(191)  NOT NULL,
  payload_sha256        CHAR(64)      NOT NULL,
  auth_mode             VARCHAR(16)   NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'accepted',
  lead_id               VARCHAR(128)  NULL,
  outcome               VARCHAR(48)   NULL,
  result_json           TEXT          NULL,
  error_code            VARCHAR(64)   NULL,
  error_message         VARCHAR(1000) NULL,
  duration_ms           INT UNSIGNED  NULL,
  received_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at          TIMESTAMP(3)  NULL,
  UNIQUE KEY uq_owl_webhook_event (endpoint_id,event_key),
  KEY idx_owl_webhook_delivery_status (endpoint_id,status,received_at),
  KEY idx_owl_webhook_delivery_contact (contact_id,received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DiveDeep Data Privacy SaaS foundation.
-- The existing API key is the tenant boundary. Sensitive identity and request fields are encrypted by the application.
CREATE TABLE IF NOT EXISTS divedeep_protected_profiles (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id             CHAR(36)      NOT NULL,
  display_name_enc      MEDIUMTEXT    NOT NULL,
  jurisdiction_country  VARCHAR(64)   NULL,
  jurisdiction_region   VARCHAR(128)  NULL,
  status                ENUM('active','paused','deletion_pending','deleted') NOT NULL DEFAULT 'active',
  scan_cadence_days     SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  next_scan_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  last_scan_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_by            VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_ng_profiles_tenant (tenant_id,status,updated_at),
  KEY idx_ng_profiles_scan (tenant_id,status,next_scan_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_profile_identifiers (
  id                CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id         CHAR(36)      NOT NULL,
  profile_id        CHAR(36)      NOT NULL,
  identifier_type   ENUM('name','alias','email','phone','address','username','domain','other') NOT NULL,
  label             VARCHAR(128)  NULL,
  value_enc         MEDIUMTEXT    NOT NULL,
  value_hash        CHAR(64)      NOT NULL,
  is_primary        TINYINT(1)    NOT NULL DEFAULT 0,
  status            ENUM('active','suppressed','deleted') NOT NULL DEFAULT 'active',
  created_at        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ng_identifier (tenant_id,profile_id,identifier_type,value_hash),
  KEY idx_ng_identifiers_profile (tenant_id,profile_id,status,is_primary),
  KEY idx_ng_identifiers_hash (tenant_id,identifier_type,value_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS research_authorizations (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id             CHAR(36)      NOT NULL,
  profile_id            CHAR(36)      NOT NULL,
  authorization_type    ENUM('self','authorized_agent','guardian') NOT NULL,
  requester_role        VARCHAR(64)   NOT NULL,
  requester_name_enc    MEDIUMTEXT    NOT NULL,
  requester_email_enc   MEDIUMTEXT    NOT NULL,
  scope_json            TEXT          NOT NULL,
  statement_version     VARCHAR(64)   NOT NULL,
  signed_at             TIMESTAMP(3)  NOT NULL,
  expires_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  revoked_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  status                ENUM('active','expired','revoked') NOT NULL DEFAULT 'active',
  verification_channel  VARCHAR(255)  NULL,
  proof_ref             VARCHAR(512)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ng_authorization_profile (tenant_id,profile_id,status,signed_at),
  KEY idx_ng_authorization_expiry (tenant_id,status,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_visibility_policies (
  id            CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id     CHAR(36)      NOT NULL,
  profile_id    CHAR(36)      NOT NULL,
  scope_type    ENUM('default','domain','source','category','identifier_type','profile_url') NOT NULL,
  scope_value   VARCHAR(255)  NOT NULL DEFAULT '',
  action        ENUM('remove','monitor','preserve','ignore','review') NOT NULL,
  priority      SMALLINT      NOT NULL DEFAULT 0,
  created_at    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ng_policy_scope (tenant_id,profile_id,scope_type,scope_value),
  KEY idx_ng_policy_profile (tenant_id,profile_id,priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_sources (
  id                                  CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id                           CHAR(36)      NULL,
  slug                                VARCHAR(128)  NOT NULL,
  name                                VARCHAR(255)  NOT NULL,
  domain                              VARCHAR(255)  NULL,
  category                            VARCHAR(64)   NOT NULL DEFAULT 'general',
  privacy_email                       VARCHAR(320)  NULL,
  privacy_form_url                    VARCHAR(2048) NULL,
  adapter_type                        ENUM('guidance','email','customer_form','api','browser') NOT NULL DEFAULT 'guidance',
  automation_level                    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  allowed_request_types_json          TEXT          NOT NULL,
  jurisdictions_json                  TEXT          NOT NULL,
  verification_requirements_json      TEXT          NOT NULL,
  rate_limit_json                     TEXT          NOT NULL,
  status                              ENUM('active','paused','retired') NOT NULL DEFAULT 'active',
  adapter_version                     VARCHAR(64)   NOT NULL DEFAULT '1',
  created_at                          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ng_source_slug (tenant_id,slug),
  KEY idx_ng_sources_tenant (tenant_id,status,category),
  KEY idx_ng_sources_domain (domain,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO divedeep_sources
  (id,tenant_id,slug,name,category,adapter_type,automation_level,allowed_request_types_json,
   jurisdictions_json,verification_requirements_json,rate_limit_json,status,adapter_version)
VALUES
  ('11111111-1111-4111-8111-111111111111',NULL,'manual-web-review','Manual web review','general','guidance',0,
   '["data-broker-deletion","people-search-removal","b2b-contact-removal","marketing-suppression","account-deletion","correction","access"]',
   '[]','{"humanReview":true}','{"requestsPerMinute":1}','active','1'),
  ('22222222-2222-4222-8222-222222222222',NULL,'verified-privacy-email','Verified privacy email','general','email',2,
   '["data-broker-deletion","people-search-removal","b2b-contact-removal","marketing-suppression","account-deletion","correction","access"]',
   '[]','{"verifiedDestinationRequired":true}','{"requestsPerMinute":6}','active','1'),
  ('33333333-3333-4333-8333-333333333333',NULL,'customer-assisted-form','Customer-assisted privacy form','general','customer_form',1,
   '["data-broker-deletion","people-search-removal","b2b-contact-removal","marketing-suppression","account-deletion","correction","access"]',
   '[]','{"customerActionRequired":true,"captchaBypassProhibited":true}','{"requestsPerMinute":2}','active','1');

CREATE TABLE IF NOT EXISTS divedeep_exposures (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id                CHAR(36)      NOT NULL,
  profile_id               CHAR(36)      NOT NULL,
  source_id                CHAR(36)      NULL,
  source_name              VARCHAR(255)  NOT NULL,
  domain                   VARCHAR(255)  NULL,
  listing_url              VARCHAR(2048) NOT NULL,
  listing_url_hash         CHAR(64)      NOT NULL,
  listing_identifier_enc   MEDIUMTEXT    NULL,
  subject_identifier_enc   MEDIUMTEXT    NULL,
  match_confidence         DECIMAL(5,4)  NOT NULL DEFAULT 0,
  content_category         VARCHAR(64)   NOT NULL DEFAULT 'standard',
  status                   ENUM('open','review','confirmed','preserved','ignored','removed','reappeared','false_positive') NOT NULL DEFAULT 'review',
  publication_status       ENUM('staged','approved','published','rejected') NOT NULL DEFAULT 'published',
  visibility_action        ENUM('remove','monitor','preserve','ignore','review') NOT NULL DEFAULT 'review',
  evidence_ref             VARCHAR(1024) NULL,
  evidence_sha256          CHAR(64)      NULL,
  metadata_enc             MEDIUMTEXT    NULL,
  discovered_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ng_exposure_url (tenant_id,profile_id,listing_url_hash),
  KEY idx_ng_exposure_profile (tenant_id,profile_id,status,last_seen_at),
  KEY idx_ng_exposure_source (tenant_id,source_id,status),
  KEY idx_ng_exposure_domain (tenant_id,domain,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_cases (
  id                        CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id                 CHAR(36)      NOT NULL,
  profile_id                CHAR(36)      NOT NULL,
  exposure_id               CHAR(36)      NOT NULL,
  source_id                 CHAR(36)      NULL,
  request_type              VARCHAR(64)   NOT NULL,
  template_key              VARCHAR(64)   NOT NULL,
  delivery_method           ENUM('email','customer_form','api','browser','guidance') NOT NULL DEFAULT 'email',
  state                     ENUM('draft','approved','queued','sent','acknowledged','needs_action','completed','denied','withdrawn','failed') NOT NULL DEFAULT 'draft',
  jurisdiction_basis        TEXT          NULL,
  recipient_email_enc       MEDIUMTEXT    NULL,
  email_subject_enc         MEDIUMTEXT    NOT NULL,
  email_body_enc            MEDIUMTEXT    NOT NULL,
  response_due_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  sent_at                   TIMESTAMP(3)  NULL DEFAULT NULL,
  confirmation_reference    VARCHAR(255)  NULL,
  notes_enc                 MEDIUMTEXT    NULL,
  idempotency_key           VARCHAR(191)  NULL,
  revision                  INT UNSIGNED  NOT NULL DEFAULT 1,
  created_at                TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ng_case_idempotency (tenant_id,idempotency_key),
  KEY idx_ng_cases_profile (tenant_id,profile_id,state,updated_at),
  KEY idx_ng_cases_exposure (tenant_id,exposure_id,created_at),
  KEY idx_ng_cases_due (tenant_id,state,response_due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_case_events (
  id            CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id     CHAR(36)      NOT NULL,
  profile_id    CHAR(36)      NULL,
  case_id       CHAR(36)      NULL,
  exposure_id   CHAR(36)      NULL,
  event_type    VARCHAR(96)   NOT NULL,
  actor_type    VARCHAR(32)   NOT NULL DEFAULT 'api_key',
  actor_id      VARCHAR(128)  NULL,
  details_json  TEXT          NOT NULL,
  created_at    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ng_events_case (tenant_id,case_id,created_at),
  KEY idx_ng_events_profile (tenant_id,profile_id,created_at),
  KEY idx_ng_events_exposure (tenant_id,exposure_id,created_at),
  KEY idx_ng_events_type (tenant_id,event_type,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_verifications (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id        CHAR(36)      NOT NULL,
  profile_id       CHAR(36)      NOT NULL,
  case_id          CHAR(36)      NOT NULL,
  exposure_id      CHAR(36)      NOT NULL,
  result           ENUM('removed','still_present','changed','unreachable','needs_review') NOT NULL,
  source_url       VARCHAR(2048) NULL,
  notes_enc        MEDIUMTEXT    NULL,
  checked_at       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  evidence_ref     VARCHAR(1024) NULL,
  evidence_sha256  CHAR(64)      NULL,
  created_at       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ng_verification_case (tenant_id,case_id,checked_at),
  KEY idx_ng_verification_exposure (tenant_id,exposure_id,checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_scan_jobs (
  id                CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id         CHAR(36)      NOT NULL,
  profile_id        CHAR(36)      NOT NULL,
  job_type          ENUM('initial_scan','rescan','verify','source_probe') NOT NULL,
  status            ENUM('queued','running','succeeded','failed','dead') NOT NULL DEFAULT 'queued',
  idempotency_key   VARCHAR(191)  NOT NULL,
  payload_json      TEXT          NOT NULL,
  result_json       TEXT          NULL,
  attempts          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts      TINYINT UNSIGNED NOT NULL DEFAULT 4,
  worker_id         VARCHAR(128)  NULL,
  lease_token_hash  CHAR(64)      NULL,
  lease_until       TIMESTAMP(3)  NULL DEFAULT NULL,
  available_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error        VARCHAR(2000) NULL,
  completed_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ng_job_idempotency (tenant_id,idempotency_key),
  KEY idx_ng_job_claim (tenant_id,status,available_at,lease_until),
  KEY idx_ng_job_profile (tenant_id,profile_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_subscriptions (
  tenant_id               CHAR(36)      NOT NULL PRIMARY KEY,
  provider                VARCHAR(32)   NOT NULL DEFAULT 'manual',
  customer_ref_enc        MEDIUMTEXT    NULL,
  subscription_ref_enc    MEDIUMTEXT    NULL,
  plan_code               VARCHAR(64)   NOT NULL DEFAULT 'privacy-core',
  status                  ENUM('trialing','active','past_due','paused','canceled') NOT NULL DEFAULT 'trialing',
  entitlements_json       TEXT          NOT NULL,
  current_period_end      TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_ng_subscription_status (status,current_period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Root-managed canonical packages and one-time/redeemable pilot codes.
CREATE TABLE IF NOT EXISTS divedeep_packages (
  id                  VARCHAR(64)   NOT NULL PRIMARY KEY,
  name                VARCHAR(120)  NOT NULL,
  description         VARCHAR(1000) NOT NULL,
  monthly_price_cents INT UNSIGNED  NOT NULL,
  stripe_price_id     VARCHAR(255)  NULL,
  is_restricted       TINYINT(1)    NOT NULL DEFAULT 0,
  is_active           TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order          SMALLINT      NOT NULL DEFAULT 0,
  current_version     INT UNSIGNED  NOT NULL DEFAULT 1,
  updated_by          VARCHAR(128)  NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_package_active (is_active,sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 1 shared resource catalog, metadata schemas, namespaced pools, and source-set versions.
-- These structures are a clean fresh-install foundation; no prior catalog data is assumed.
CREATE TABLE IF NOT EXISTS platform_metadata_schemas (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  namespace           VARCHAR(64)   NOT NULL,
  schema_key          VARCHAR(128)  NOT NULL,
  version             INT UNSIGNED  NOT NULL,
  resource_type       VARCHAR(64)   NOT NULL,
  name                VARCHAR(160)  NOT NULL,
  description         VARCHAR(1000) NOT NULL DEFAULT '',
  json_schema_json    LONGTEXT      NOT NULL,
  status              ENUM('draft','published','retired') NOT NULL DEFAULT 'draft',
  is_default          TINYINT(1)    NOT NULL DEFAULT 0,
  created_by          VARCHAR(128)  NULL,
  published_by        VARCHAR(128)  NULL,
  published_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_platform_metadata_schema (namespace,schema_key,version),
  KEY idx_platform_metadata_schema_type (namespace,resource_type,status,is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_resources (
  id                         CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id                  CHAR(36)      NULL,
  owner_scope                VARCHAR(80)   NOT NULL DEFAULT 'global',
  namespace                  VARCHAR(64)   NOT NULL,
  resource_type              VARCHAR(64)   NOT NULL,
  slug                       VARCHAR(128)  NOT NULL,
  name                       VARCHAR(255)  NOT NULL,
  description                VARCHAR(2000) NOT NULL DEFAULT '',
  primary_domain             VARCHAR(255)  NULL,
  service_type               VARCHAR(64)   NULL,
  category                   VARCHAR(64)   NULL,
  topic                      VARCHAR(128)  NULL,
  sensitivity_class          ENUM('standard','sensitive','restricted') NOT NULL DEFAULT 'standard',
  jurisdiction_country       VARCHAR(64)   NULL,
  jurisdiction_region        VARCHAR(128)  NULL,
  adapter_key                VARCHAR(128)  NULL,
  metadata_schema_id         CHAR(36)      NULL,
  metadata_json              LONGTEXT      NOT NULL,
  capabilities_json          LONGTEXT      NOT NULL,
  declarations_json          LONGTEXT      NOT NULL,
  limits_json                LONGTEXT      NOT NULL,
  removal_methods_json       LONGTEXT      NOT NULL,
  monitoring_support_json    LONGTEXT      NOT NULL,
  status                     ENUM('draft','active','paused','retired') NOT NULL DEFAULT 'draft',
  revision                   INT UNSIGNED  NOT NULL DEFAULT 1,
  created_by                 VARCHAR(128)  NULL,
  updated_by                 VARCHAR(128)  NULL,
  created_at                 TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_platform_resource_slug (owner_scope,namespace,slug),
  KEY idx_platform_resource_catalog (namespace,resource_type,status,category,topic),
  KEY idx_platform_resource_domain (primary_domain,status),
  KEY idx_platform_resource_schema (metadata_schema_id,status),
  KEY idx_platform_resource_tenant (tenant_id,namespace,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_resource_revisions (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  resource_id     CHAR(36)      NOT NULL,
  revision        INT UNSIGNED  NOT NULL,
  snapshot_json   LONGTEXT      NOT NULL,
  change_note     VARCHAR(1000) NULL,
  created_by      VARCHAR(128)  NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_platform_resource_revision (resource_id,revision),
  KEY idx_platform_resource_revision_created (resource_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_pools (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  tenant_id           CHAR(36)      NULL,
  owner_scope         VARCHAR(80)   NOT NULL DEFAULT 'global',
  namespace           VARCHAR(64)   NOT NULL,
  pool_type           VARCHAR(64)   NOT NULL,
  slug                VARCHAR(128)  NOT NULL,
  name                VARCHAR(255)  NOT NULL,
  description         VARCHAR(2000) NOT NULL DEFAULT '',
  metadata_schema_id  CHAR(36)      NULL,
  status              ENUM('draft','active','paused','retired') NOT NULL DEFAULT 'draft',
  current_version     INT UNSIGNED  NOT NULL DEFAULT 0,
  created_by          VARCHAR(128)  NULL,
  updated_by          VARCHAR(128)  NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_platform_pool_slug (owner_scope,namespace,slug),
  KEY idx_platform_pool_namespace (namespace,pool_type,status),
  KEY idx_platform_pool_tenant (tenant_id,namespace,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_pool_versions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  pool_id               CHAR(36)      NOT NULL,
  version               INT UNSIGNED  NOT NULL,
  status                ENUM('draft','published','retired') NOT NULL DEFAULT 'draft',
  label                 VARCHAR(160)  NOT NULL,
  description           VARCHAR(2000) NOT NULL DEFAULT '',
  selector_rules_json   LONGTEXT      NOT NULL,
  metadata_json         LONGTEXT      NOT NULL,
  member_count          INT UNSIGNED  NOT NULL DEFAULT 0,
  created_by            VARCHAR(128)  NULL,
  published_by          VARCHAR(128)  NULL,
  published_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_platform_pool_version (pool_id,version),
  KEY idx_platform_pool_version_status (pool_id,status,version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_pool_memberships (
  id                        CHAR(36)      NOT NULL PRIMARY KEY,
  pool_version_id           CHAR(36)      NOT NULL,
  resource_id               CHAR(36)      NOT NULL,
  membership_metadata_json  LONGTEXT      NOT NULL,
  priority                  SMALLINT      NOT NULL DEFAULT 0,
  enabled                   TINYINT(1)    NOT NULL DEFAULT 1,
  effective_at              TIMESTAMP(3)  NULL DEFAULT NULL,
  expires_at                TIMESTAMP(3)  NULL DEFAULT NULL,
  created_by                VARCHAR(128)  NULL,
  created_at                TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_platform_pool_membership (pool_version_id,resource_id),
  KEY idx_platform_pool_membership_resource (resource_id,enabled),
  KEY idx_platform_pool_membership_effective (pool_version_id,enabled,effective_at,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_source_sets (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  slug                VARCHAR(128)  NOT NULL,
  name                VARCHAR(255)  NOT NULL,
  description         VARCHAR(2000) NOT NULL DEFAULT '',
  status              ENUM('draft','active','retired') NOT NULL DEFAULT 'draft',
  current_version     INT UNSIGNED  NOT NULL DEFAULT 0,
  created_by          VARCHAR(128)  NULL,
  updated_by          VARCHAR(128)  NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_source_set_slug (slug),
  KEY idx_divedeep_source_set_status (status,current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_source_set_versions (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  source_set_id       CHAR(36)      NOT NULL,
  version             INT UNSIGNED  NOT NULL,
  status              ENUM('draft','published','retired') NOT NULL DEFAULT 'draft',
  selection_mode      ENUM('explicit','pools','rules','hybrid') NOT NULL DEFAULT 'pools',
  metadata_json       LONGTEXT      NOT NULL,
  resource_count      INT UNSIGNED  NOT NULL DEFAULT 0,
  pool_count          INT UNSIGNED  NOT NULL DEFAULT 0,
  created_by          VARCHAR(128)  NULL,
  published_by        VARCHAR(128)  NULL,
  published_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_source_set_version (source_set_id,version),
  KEY idx_divedeep_source_set_version_status (source_set_id,status,version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_source_set_pool_links (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  source_set_version_id CHAR(36)      NOT NULL,
  pool_version_id       CHAR(36)      NOT NULL,
  inclusion_mode        ENUM('include','exclude') NOT NULL DEFAULT 'include',
  priority              SMALLINT      NOT NULL DEFAULT 0,
  filter_json           LONGTEXT      NOT NULL,
  created_by            VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_source_set_pool (source_set_version_id,pool_version_id,inclusion_mode),
  KEY idx_divedeep_source_set_pool_version (pool_version_id,source_set_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_source_set_resource_links (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  source_set_version_id CHAR(36)      NOT NULL,
  resource_id           CHAR(36)      NOT NULL,
  inclusion_mode        ENUM('include','exclude') NOT NULL DEFAULT 'include',
  priority              SMALLINT      NOT NULL DEFAULT 0,
  metadata_json         LONGTEXT      NOT NULL,
  created_by            VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_source_set_resource (source_set_version_id,resource_id,inclusion_mode),
  KEY idx_divedeep_source_set_resource_resource (resource_id,source_set_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_package_versions (
  id                      CHAR(36)      NOT NULL PRIMARY KEY,
  package_id              VARCHAR(64)   NOT NULL,
  version                 INT UNSIGNED  NOT NULL,
  status                  ENUM('draft','published','retired') NOT NULL DEFAULT 'draft',
  source_set_version_id   CHAR(36)      NOT NULL,
  requirements_json       LONGTEXT      NOT NULL,
  execution_policy_json   LONGTEXT      NOT NULL,
  review_policy_json      LONGTEXT      NOT NULL,
  retention_policy_json   LONGTEXT      NOT NULL,
  created_by              VARCHAR(128)  NULL,
  published_by            VARCHAR(128)  NULL,
  published_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_package_version (package_id,version),
  KEY idx_divedeep_package_version_status (package_id,status,version),
  KEY idx_divedeep_package_version_source_set (source_set_version_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Default metadata schemas. New versions are added rather than editing published definitions.
INSERT IGNORE INTO platform_metadata_schemas
  (id,namespace,schema_key,version,resource_type,name,description,json_schema_json,status,is_default,published_by,published_at)
VALUES
  ('51000000-0000-4000-8000-000000000001','divedeep','website-source',1,'website','DiveDeep Website Source','Validated metadata for public websites and platforms checked by authorized privacy workflows.',
   '{"type":"object","required":["siteType"],"properties":{"siteType":{"type":"string","maxLength":64},"tags":{"type":"array","maxItems":50,"items":{"type":"string","maxLength":80}},"languages":{"type":"array","maxItems":30,"items":{"type":"string","maxLength":35}},"ownership":{"type":"string","maxLength":160},"notes":{"type":"string","maxLength":4000},"extensions":{"type":"object","additionalProperties":true}},"additionalProperties":false}',
   'published',1,'system',CURRENT_TIMESTAMP(3)),
  ('51000000-0000-4000-8000-000000000002','divedeep','api-source',1,'api','DiveDeep API Source','Validated metadata for provider APIs and structured privacy endpoints.',
   '{"type":"object","required":["apiType"],"properties":{"apiType":{"type":"string","maxLength":64},"documentationUrl":{"type":"string","maxLength":2048},"authentication":{"type":"string","enum":["none","api_key","oauth","service_identity","other"]},"version":{"type":"string","maxLength":64},"notes":{"type":"string","maxLength":4000},"extensions":{"type":"object","additionalProperties":true}},"additionalProperties":false}',
   'published',1,'system',CURRENT_TIMESTAMP(3)),
  ('51000000-0000-4000-8000-000000000003','platform','pool-definition',1,'pool','Platform Pool Definition','Metadata shared by namespaced service, topic, category, and source pools.',
   '{"type":"object","properties":{"labels":{"type":"array","maxItems":50,"items":{"type":"string","maxLength":80}},"owner":{"type":"string","maxLength":128},"purpose":{"type":"string","maxLength":1000},"extensions":{"type":"object","additionalProperties":true}},"additionalProperties":false}',
   'published',1,'system',CURRENT_TIMESTAMP(3));

-- Canonical source pools. Membership starts empty and is populated from the Source Catalog UI.
INSERT IGNORE INTO platform_pools
  (id,owner_scope,namespace,pool_type,slug,name,description,metadata_schema_id,status,current_version,created_by,updated_by)
VALUES
  ('52000000-0000-4000-8000-000000000001','global','divedeep.source','category','mainstream-social','Mainstream Social','Mainstream social networks and declared public profiles.','51000000-0000-4000-8000-000000000003','active',1,'system','system'),
  ('52000000-0000-4000-8000-000000000002','global','divedeep.source','category','declared-profiles','Declared Profiles','Customer-declared profiles and owned accounts that require preserve-aware handling.','51000000-0000-4000-8000-000000000003','active',1,'system','system'),
  ('52000000-0000-4000-8000-000000000003','global','divedeep.source','topic','identity-discovery','Identity Discovery','Public identity-discovery sources supported by approved tool adapters.','51000000-0000-4000-8000-000000000003','active',1,'system','system'),
  ('52000000-0000-4000-8000-000000000004','global','divedeep.source','category','people-search','People Search','People-search and data-broker sources used for authorized discovery and removal workflows.','51000000-0000-4000-8000-000000000003','active',1,'system','system'),
  ('52000000-0000-4000-8000-000000000005','global','divedeep.source','sensitivity','sensitive-exposure','Sensitive Exposure','Consent-gated sensitive and adult-content sources requiring restricted review.','51000000-0000-4000-8000-000000000003','active',1,'system','system'),
  ('52000000-0000-4000-8000-000000000006','global','divedeep.source','capability','image-discovery','Image Discovery','Reverse-image and likeness-discovery sources used with authorized reference images.','51000000-0000-4000-8000-000000000003','active',1,'system','system'),
  ('52000000-0000-4000-8000-000000000007','global','divedeep.source','purpose','monitoring','Monitoring','Known-URL and reappearance monitoring sources.','51000000-0000-4000-8000-000000000003','active',1,'system','system');

INSERT IGNORE INTO platform_pool_versions
  (id,pool_id,version,status,label,description,selector_rules_json,metadata_json,member_count,created_by,published_by,published_at)
VALUES
  ('52100000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',1,'published','Mainstream Social v1','Initial empty membership.','{}','{"purpose":"Mainstream public profile coverage"}',0,'system','system',CURRENT_TIMESTAMP(3)),
  ('52100000-0000-4000-8000-000000000002','52000000-0000-4000-8000-000000000002',1,'published','Declared Profiles v1','Initial empty membership.','{}','{"purpose":"Customer-declared profile handling"}',0,'system','system',CURRENT_TIMESTAMP(3)),
  ('52100000-0000-4000-8000-000000000003','52000000-0000-4000-8000-000000000003',1,'published','Identity Discovery v1','Initial empty membership.','{}','{"purpose":"Public identity discovery"}',0,'system','system',CURRENT_TIMESTAMP(3)),
  ('52100000-0000-4000-8000-000000000004','52000000-0000-4000-8000-000000000004',1,'published','People Search v1','Initial empty membership.','{}','{"purpose":"People-search and data-broker coverage"}',0,'system','system',CURRENT_TIMESTAMP(3)),
  ('52100000-0000-4000-8000-000000000005','52000000-0000-4000-8000-000000000005',1,'published','Sensitive Exposure v1','Initial empty membership.','{}','{"purpose":"Restricted consent-gated coverage"}',0,'system','system',CURRENT_TIMESTAMP(3)),
  ('52100000-0000-4000-8000-000000000006','52000000-0000-4000-8000-000000000006',1,'published','Image Discovery v1','Initial empty membership.','{}','{"purpose":"Authorized image and likeness discovery"}',0,'system','system',CURRENT_TIMESTAMP(3)),
  ('52100000-0000-4000-8000-000000000007','52000000-0000-4000-8000-000000000007',1,'published','Monitoring v1','Initial empty membership.','{}','{"purpose":"Known URL and reappearance monitoring"}',0,'system','system',CURRENT_TIMESTAMP(3));

INSERT IGNORE INTO divedeep_source_sets
  (id,slug,name,description,status,current_version,created_by,updated_by)
VALUES
  ('53000000-0000-4000-8000-000000000001','standard-coverage','Standard Coverage','Mainstream social and customer-declared profile coverage.','active',1,'system','system'),
  ('53000000-0000-4000-8000-000000000002','deep-coverage','Deep Coverage','Standard coverage plus identity-discovery and people-search sources.','active',1,'system','system'),
  ('53000000-0000-4000-8000-000000000003','sensitive-coverage','Sensitive Coverage','Deep coverage plus consent-gated sensitive exposure sources.','active',1,'system','system'),
  ('53000000-0000-4000-8000-000000000004','image-coverage','Image Coverage','Sensitive coverage plus authorized image and likeness discovery.','active',1,'system','system');

INSERT IGNORE INTO divedeep_source_set_versions
  (id,source_set_id,version,status,selection_mode,metadata_json,resource_count,pool_count,created_by,published_by,published_at)
VALUES
  ('53100000-0000-4000-8000-000000000001','53000000-0000-4000-8000-000000000001',1,'published','pools','{"serviceLevel":"standard"}',0,2,'system','system',CURRENT_TIMESTAMP(3)),
  ('53100000-0000-4000-8000-000000000002','53000000-0000-4000-8000-000000000002',1,'published','pools','{"serviceLevel":"deep"}',0,4,'system','system',CURRENT_TIMESTAMP(3)),
  ('53100000-0000-4000-8000-000000000003','53000000-0000-4000-8000-000000000003',1,'published','pools','{"serviceLevel":"sensitive","requiresSensitiveConsent":true}',0,5,'system','system',CURRENT_TIMESTAMP(3)),
  ('53100000-0000-4000-8000-000000000004','53000000-0000-4000-8000-000000000004',1,'published','pools','{"serviceLevel":"image","requiresSensitiveConsent":true,"requiresReferenceImages":true}',0,6,'system','system',CURRENT_TIMESTAMP(3));

INSERT IGNORE INTO divedeep_source_set_pool_links
  (id,source_set_version_id,pool_version_id,inclusion_mode,priority,filter_json,created_by)
VALUES
  ('53200000-0000-4000-8000-000000000001','53100000-0000-4000-8000-000000000001','52100000-0000-4000-8000-000000000001','include',10,'{}','system'),
  ('53200000-0000-4000-8000-000000000002','53100000-0000-4000-8000-000000000001','52100000-0000-4000-8000-000000000002','include',20,'{}','system'),
  ('53200000-0000-4000-8000-000000000003','53100000-0000-4000-8000-000000000002','52100000-0000-4000-8000-000000000001','include',10,'{}','system'),
  ('53200000-0000-4000-8000-000000000004','53100000-0000-4000-8000-000000000002','52100000-0000-4000-8000-000000000002','include',20,'{}','system'),
  ('53200000-0000-4000-8000-000000000005','53100000-0000-4000-8000-000000000002','52100000-0000-4000-8000-000000000003','include',30,'{}','system'),
  ('53200000-0000-4000-8000-000000000006','53100000-0000-4000-8000-000000000002','52100000-0000-4000-8000-000000000004','include',40,'{}','system'),
  ('53200000-0000-4000-8000-000000000007','53100000-0000-4000-8000-000000000003','52100000-0000-4000-8000-000000000001','include',10,'{}','system'),
  ('53200000-0000-4000-8000-000000000008','53100000-0000-4000-8000-000000000003','52100000-0000-4000-8000-000000000002','include',20,'{}','system'),
  ('53200000-0000-4000-8000-000000000009','53100000-0000-4000-8000-000000000003','52100000-0000-4000-8000-000000000003','include',30,'{}','system'),
  ('53200000-0000-4000-8000-000000000010','53100000-0000-4000-8000-000000000003','52100000-0000-4000-8000-000000000004','include',40,'{}','system'),
  ('53200000-0000-4000-8000-000000000011','53100000-0000-4000-8000-000000000003','52100000-0000-4000-8000-000000000005','include',50,'{}','system'),
  ('53200000-0000-4000-8000-000000000012','53100000-0000-4000-8000-000000000004','52100000-0000-4000-8000-000000000001','include',10,'{}','system'),
  ('53200000-0000-4000-8000-000000000013','53100000-0000-4000-8000-000000000004','52100000-0000-4000-8000-000000000002','include',20,'{}','system'),
  ('53200000-0000-4000-8000-000000000014','53100000-0000-4000-8000-000000000004','52100000-0000-4000-8000-000000000003','include',30,'{}','system'),
  ('53200000-0000-4000-8000-000000000015','53100000-0000-4000-8000-000000000004','52100000-0000-4000-8000-000000000004','include',40,'{}','system'),
  ('53200000-0000-4000-8000-000000000016','53100000-0000-4000-8000-000000000004','52100000-0000-4000-8000-000000000005','include',50,'{}','system'),
  ('53200000-0000-4000-8000-000000000017','53100000-0000-4000-8000-000000000004','52100000-0000-4000-8000-000000000006','include',60,'{}','system');

INSERT IGNORE INTO divedeep_packages
  (id,name,description,monthly_price_cents,is_restricted,is_active,sort_order,current_version,updated_by)
VALUES
  ('standard','Basic Privacy','Public-profile review, standard discovery, and removal-case tracking.',0,0,1,10,1,'system'),
  ('deep','Advanced Discovery','Broader identity discovery across supported people-search and public-profile sources.',0,0,1,20,1,'system'),
  ('sensitive','18+ Adult Site Scrubbing','Restricted adult-site review and removal-case support for adults protecting their own identity.',0,1,1,30,1,'system'),
  ('image','Advanced Image Scrubbing','Adult-site review plus authorized image-match review and image-removal case preparation.',0,1,1,40,1,'system');

INSERT IGNORE INTO divedeep_package_versions
  (id,package_id,version,status,source_set_version_id,requirements_json,execution_policy_json,review_policy_json,retention_policy_json,created_by,published_by,published_at)
VALUES
  ('54000000-0000-4000-8000-000000000001','standard',1,'published','53100000-0000-4000-8000-000000000001','{"authorizationRequired":true}','{"concurrency":1,"humanReview":true}','{"candidateReviewRequired":true}','{"nonmatchHours":24,"pendingReviewDays":30}','system','system',CURRENT_TIMESTAMP(3)),
  ('54000000-0000-4000-8000-000000000002','deep',1,'published','53100000-0000-4000-8000-000000000002','{"authorizationRequired":true}','{"concurrency":2,"humanReview":true}','{"candidateReviewRequired":true}','{"nonmatchHours":24,"pendingReviewDays":30}','system','system',CURRENT_TIMESTAMP(3)),
  ('54000000-0000-4000-8000-000000000003','sensitive',1,'published','53100000-0000-4000-8000-000000000003','{"authorizationRequired":true,"age18Required":true,"sensitiveConsentRequired":true}','{"concurrency":1,"humanReview":true}','{"candidateReviewRequired":true,"restrictedReviewerRequired":true}','{"nonmatchHours":24,"pendingReviewDays":30}','system','system',CURRENT_TIMESTAMP(3)),
  ('54000000-0000-4000-8000-000000000004','image',1,'published','53100000-0000-4000-8000-000000000004','{"authorizationRequired":true,"age18Required":true,"sensitiveConsentRequired":true,"referenceImagesRequired":true}','{"concurrency":1,"humanReview":true}','{"candidateReviewRequired":true,"restrictedReviewerRequired":true}','{"nonmatchHours":24,"pendingReviewDays":30}','system','system',CURRENT_TIMESTAMP(3));

-- Phase 1.1 provider-neutral image analysis profiles and customer-experience presentation contract.
-- Amazon Rekognition is an optional assisted-analysis provider. Face collections and persistent
-- provider-side face vectors are intentionally excluded from this release.
CREATE TABLE IF NOT EXISTS divedeep_image_analysis_profiles (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  slug                VARCHAR(128)  NOT NULL,
  name                VARCHAR(160)  NOT NULL,
  description         VARCHAR(2000) NOT NULL DEFAULT '',
  status              ENUM('draft','active','retired') NOT NULL DEFAULT 'draft',
  current_version     INT UNSIGNED  NOT NULL DEFAULT 0,
  created_by          VARCHAR(128)  NULL,
  updated_by          VARCHAR(128)  NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_image_analysis_profile_slug (slug),
  KEY idx_divedeep_image_analysis_profile_status (status,current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_image_analysis_profile_versions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  profile_id            CHAR(36)      NOT NULL,
  version               INT UNSIGNED  NOT NULL,
  status                ENUM('draft','published','retired') NOT NULL DEFAULT 'draft',
  provider              VARCHAR(64)   NOT NULL DEFAULT 'aws_rekognition',
  operations_json       LONGTEXT      NOT NULL,
  thresholds_json       LONGTEXT      NOT NULL,
  limits_json           LONGTEXT      NOT NULL,
  quality_rules_json    LONGTEXT      NOT NULL,
  review_policy_json    LONGTEXT      NOT NULL,
  retention_policy_json LONGTEXT      NOT NULL,
  created_by            VARCHAR(128)  NULL,
  published_by          VARCHAR(128)  NULL,
  published_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_image_analysis_profile_version (profile_id,version),
  KEY idx_divedeep_image_analysis_profile_version_status (profile_id,status,version),
  KEY idx_divedeep_image_analysis_provider (provider,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_package_image_analysis_links (
  package_version_id                CHAR(36)      NOT NULL PRIMARY KEY,
  image_analysis_profile_version_id CHAR(36)      NOT NULL,
  is_required                       TINYINT(1)    NOT NULL DEFAULT 0,
  created_by                        VARCHAR(128)  NULL,
  created_at                        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_package_image_profile (image_analysis_profile_version_id,package_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Durable API-side analysis and presentation records. These rows contain metadata and artifact
-- references only; image bytes remain outside the relational database.
CREATE TABLE IF NOT EXISTS divedeep_image_analysis_sessions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id           CHAR(36)      NULL,
  recon_job_id          CHAR(36)      NULL,
  package_version_id    CHAR(36)      NULL,
  profile_version_id    CHAR(36)      NOT NULL,
  status                ENUM('created','analyzing','awaiting_review','awaiting_customer_validation','completed','failed','expired') NOT NULL DEFAULT 'created',
  public_phase           VARCHAR(96)   NOT NULL DEFAULT 'analysis_and_validation',
  progress_percent      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  discovered_count      INT UNSIGNED  NOT NULL DEFAULT 0,
  analyzed_count        INT UNSIGNED  NOT NULL DEFAULT 0,
  review_count          INT UNSIGNED  NOT NULL DEFAULT 0,
  confirmed_count       INT UNSIGNED  NOT NULL DEFAULT 0,
  customer_action_count INT UNSIGNED  NOT NULL DEFAULT 0,
  presentation_json     LONGTEXT      NOT NULL,
  started_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  completed_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  expires_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_image_session_customer (customer_id,status,updated_at),
  KEY idx_divedeep_image_session_job (recon_job_id,status),
  KEY idx_divedeep_image_session_expiry (status,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_image_analysis_items (
  id                        CHAR(36)      NOT NULL PRIMARY KEY,
  session_id                CHAR(36)      NOT NULL,
  candidate_artifact_id     CHAR(36)      NULL,
  thumbnail_artifact_id     CHAR(36)      NULL,
  source_resource_id        CHAR(36)      NULL,
  state                     ENUM('discovered','analyzing','likely_match','reviewer_confirmed','customer_validation_requested','customer_confirmed','rejected','expired') NOT NULL DEFAULT 'discovered',
  visibility                ENUM('internal','review','customer_validation','published') NOT NULL DEFAULT 'internal',
  review_band               ENUM('low_priority','manual_review','high_priority') NOT NULL DEFAULT 'manual_review',
  provider_similarity       DECIMAL(6,3)  NULL,
  review_confidence         DECIMAL(6,3)  NULL,
  provider_result_enc       LONGTEXT      NOT NULL,
  presentation_json         LONGTEXT      NOT NULL,
  reviewer_id               VARCHAR(128)  NULL,
  reviewer_note             VARCHAR(2000) NULL,
  customer_disposition      ENUM('pending','confirmed','not_me','unsure') NOT NULL DEFAULT 'pending',
  customer_disposition_at   TIMESTAMP(3)  NULL DEFAULT NULL,
  retention_class           VARCHAR(64)   NOT NULL DEFAULT 'pending_review',
  expires_at                TIMESTAMP(3)  NULL DEFAULT NULL,
  dispositioned_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at                TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_image_item_session (session_id,state,visibility,updated_at),
  KEY idx_divedeep_image_item_customer_validation (visibility,customer_disposition,updated_at),
  KEY idx_divedeep_image_item_expiry (retention_class,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_image_analysis_events (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  session_id      CHAR(36)      NOT NULL,
  item_id         CHAR(36)      NULL,
  event_type      VARCHAR(96)   NOT NULL,
  actor_type      ENUM('system','worker','reviewer','customer') NOT NULL DEFAULT 'system',
  actor_id        VARCHAR(128)  NULL,
  details_json    TEXT          NOT NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_image_event_session (session_id,created_at),
  KEY idx_divedeep_image_event_item (item_id,created_at),
  KEY idx_divedeep_image_event_type (event_type,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_image_analysis_usage_daily (
  usage_date      DATE          NOT NULL,
  provider        VARCHAR(64)   NOT NULL,
  operation       VARCHAR(96)   NOT NULL,
  call_count      INT UNSIGNED  NOT NULL DEFAULT 0,
  success_count   INT UNSIGNED  NOT NULL DEFAULT 0,
  failure_count   INT UNSIGNED  NOT NULL DEFAULT 0,
  estimated_units DECIMAL(14,4) NOT NULL DEFAULT 0,
  updated_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (usage_date,provider,operation),
  KEY idx_divedeep_image_usage_provider (provider,usage_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


INSERT IGNORE INTO divedeep_image_analysis_profiles
  (id,slug,name,description,status,current_version,created_by,updated_by)
VALUES
  ('55000000-0000-4000-8000-000000000001','standard-image-safety','Standard Image Safety','Reference-image quality and conservative face-comparison assistance.','active',1,'system','system'),
  ('55000000-0000-4000-8000-000000000002','deep-image-discovery','Deep Image Discovery','Face comparison plus text and contextual extraction for broader recon review.','active',1,'system','system'),
  ('55000000-0000-4000-8000-000000000003','sensitive-exposure-review','Sensitive Exposure Review','Consent-gated image comparison, moderation triage, and restricted human review.','active',1,'system','system'),
  ('55000000-0000-4000-8000-000000000004','image-protection','Image Protection','High-capacity image comparison, text/context extraction, and customer-validation escalation.','active',1,'system','system');

INSERT IGNORE INTO divedeep_image_analysis_profile_versions
  (id,profile_id,version,status,provider,operations_json,thresholds_json,limits_json,quality_rules_json,review_policy_json,retention_policy_json,created_by,published_by,published_at)
VALUES
  ('55100000-0000-4000-8000-000000000001','55000000-0000-4000-8000-000000000001',1,'published','aws_rekognition','{"detectFaces":true,"compareFaces":true,"detectModerationLabels":false,"detectText":false,"detectLabels":false,"useCollections":false}','{"reviewFloor":78,"highPriorityThreshold":94,"minimumFaceConfidence":95,"minimumModerationConfidence":70}','{"maximumReferenceImages":3,"maximumCandidates":30,"maximumOperationsPerCandidate":4}','{"requireSinglePrimaryFace":false,"minimumBrightness":20,"minimumSharpness":20,"maximumAbsoluteYaw":45,"maximumAbsolutePitch":45}','{"humanReviewRequired":true,"autoConfirm":false,"autoRejectFromSimilarityOnly":false,"customerValidationAllowed":true,"customerValidationMinimumConfidence":65,"restrictedReviewerRequired":false,"blurUntilDisposition":true,"defaultBlurStrength":18}','{"nonmatchHours":24,"pendingReviewDays":30,"retainDetailedLandmarks":false}','system','system',CURRENT_TIMESTAMP(3)),
  ('55100000-0000-4000-8000-000000000002','55000000-0000-4000-8000-000000000002',1,'published','aws_rekognition','{"detectFaces":true,"compareFaces":true,"detectModerationLabels":false,"detectText":true,"detectLabels":true,"useCollections":false}','{"reviewFloor":75,"highPriorityThreshold":92,"minimumFaceConfidence":95,"minimumModerationConfidence":70}','{"maximumReferenceImages":5,"maximumCandidates":100,"maximumOperationsPerCandidate":8}','{"requireSinglePrimaryFace":false,"minimumBrightness":20,"minimumSharpness":20,"maximumAbsoluteYaw":45,"maximumAbsolutePitch":45}','{"humanReviewRequired":true,"autoConfirm":false,"autoRejectFromSimilarityOnly":false,"customerValidationAllowed":true,"customerValidationMinimumConfidence":60,"restrictedReviewerRequired":false,"blurUntilDisposition":true,"defaultBlurStrength":18}','{"nonmatchHours":24,"pendingReviewDays":30,"retainDetailedLandmarks":false}','system','system',CURRENT_TIMESTAMP(3)),
  ('55100000-0000-4000-8000-000000000003','55000000-0000-4000-8000-000000000003',1,'published','aws_rekognition','{"detectFaces":true,"compareFaces":true,"detectModerationLabels":true,"detectText":true,"detectLabels":false,"useCollections":false}','{"reviewFloor":75,"highPriorityThreshold":92,"minimumFaceConfidence":95,"minimumModerationConfidence":70}','{"maximumReferenceImages":5,"maximumCandidates":100,"maximumOperationsPerCandidate":8}','{"requireSinglePrimaryFace":false,"minimumBrightness":20,"minimumSharpness":20,"maximumAbsoluteYaw":45,"maximumAbsolutePitch":45}','{"humanReviewRequired":true,"autoConfirm":false,"autoRejectFromSimilarityOnly":false,"customerValidationAllowed":true,"customerValidationMinimumConfidence":60,"restrictedReviewerRequired":true,"blurUntilDisposition":true,"defaultBlurStrength":22}','{"nonmatchHours":24,"pendingReviewDays":30,"retainDetailedLandmarks":false}','system','system',CURRENT_TIMESTAMP(3)),
  ('55100000-0000-4000-8000-000000000004','55000000-0000-4000-8000-000000000004',1,'published','aws_rekognition','{"detectFaces":true,"compareFaces":true,"detectModerationLabels":true,"detectText":true,"detectLabels":true,"useCollections":false}','{"reviewFloor":72,"highPriorityThreshold":91,"minimumFaceConfidence":95,"minimumModerationConfidence":70}','{"maximumReferenceImages":8,"maximumCandidates":250,"maximumOperationsPerCandidate":10}','{"requireSinglePrimaryFace":false,"minimumBrightness":18,"minimumSharpness":18,"maximumAbsoluteYaw":50,"maximumAbsolutePitch":50}','{"humanReviewRequired":true,"autoConfirm":false,"autoRejectFromSimilarityOnly":false,"customerValidationAllowed":true,"customerValidationMinimumConfidence":58,"restrictedReviewerRequired":true,"blurUntilDisposition":true,"defaultBlurStrength":22}','{"nonmatchHours":24,"pendingReviewDays":30,"retainDetailedLandmarks":false}','system','system',CURRENT_TIMESTAMP(3));

INSERT IGNORE INTO divedeep_package_image_analysis_links
  (package_version_id,image_analysis_profile_version_id,is_required,created_by)
VALUES
  ('54000000-0000-4000-8000-000000000001','55100000-0000-4000-8000-000000000001',0,'system'),
  ('54000000-0000-4000-8000-000000000002','55100000-0000-4000-8000-000000000002',0,'system'),
  ('54000000-0000-4000-8000-000000000003','55100000-0000-4000-8000-000000000003',1,'system'),
  ('54000000-0000-4000-8000-000000000004','55100000-0000-4000-8000-000000000004',1,'system');

CREATE TABLE IF NOT EXISTS divedeep_pilot_codes (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  code_hash           CHAR(64)      NOT NULL,
  code_hint           VARCHAR(20)   NOT NULL,
  label               VARCHAR(160)  NOT NULL,
  package_id          VARCHAR(64)   NULL,
  discount_percent    DECIMAL(5,2)  NOT NULL DEFAULT 0,
  developer_test      TINYINT(1)    NOT NULL DEFAULT 0,
  max_redemptions     INT UNSIGNED  NULL DEFAULT NULL,
  redemption_count    INT UNSIGNED  NOT NULL DEFAULT 0,
  starts_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  expires_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  is_active           TINYINT(1)    NOT NULL DEFAULT 1,
  created_by          VARCHAR(128)  NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_pilot_code_hash (code_hash),
  KEY idx_divedeep_pilot_code_active (is_active,expires_at),
  KEY idx_divedeep_pilot_code_package (package_id,is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OSINT Dive Deep v1 customer-facing alpha portal.
-- Each customer UUID is also the DiveDeep tenant_id, preserving isolation without exposing API keys.
CREATE TABLE IF NOT EXISTS divedeep_customers (
  id                              CHAR(36)      NOT NULL PRIMARY KEY,
  email_enc                       MEDIUMTEXT    NOT NULL,
  email_hash                      CHAR(64)      NOT NULL,
  password_hash                   VARCHAR(255)  NOT NULL,
  first_name_enc                  MEDIUMTEXT    NOT NULL,
  last_name_enc                   MEDIUMTEXT    NOT NULL,
  plan_tier                       VARCHAR(64)   NOT NULL DEFAULT 'standard',
  package_price_cents             INT UNSIGNED  NOT NULL DEFAULT 0,
  discount_percent                DECIMAL(5,2)  NOT NULL DEFAULT 0,
  pilot_code_id                   CHAR(36)      NULL DEFAULT NULL,
  status                          ENUM('pending','active','paused','closed') NOT NULL DEFAULT 'pending',
  workflow_status                 ENUM('onboarding','intake_ready','awaiting_dispatch','dispatched','researching','awaiting_review','awaiting_customer_validation','disposition_required','evidence_ready','removal_preparation','requests_in_progress','monitoring','closure_ready','complete','blocked','exported','results_ready') NOT NULL DEFAULT 'onboarding',
  terms_version                   VARCHAR(64)   NOT NULL,
  privacy_version                 VARCHAR(64)   NOT NULL,
  terms_accepted_at               TIMESTAMP(3)  NOT NULL,
  authorization_affirmed_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  notice_version                  VARCHAR(64)   NOT NULL DEFAULT 'divedeep-notice-at-collection-v1',
  notice_acknowledged_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  age_18_affirmed_at              TIMESTAMP(3)  NULL DEFAULT NULL,
  sensitive_content_consent_at    TIMESTAMP(3)  NULL DEFAULT NULL,
  last_login_at                   TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at                      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_customer_email (email_hash),
  KEY idx_divedeep_customer_status (status,workflow_status,updated_at),
  KEY idx_divedeep_customer_plan (plan_tier,status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 2 customer workflow gates. These are API-owned evaluations, not worker state.
CREATE TABLE IF NOT EXISTS divedeep_customer_workflow_gates (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id     CHAR(36)      NOT NULL,
  gate_key        VARCHAR(64)   NOT NULL,
  status          ENUM('pending','pass','blocked','waived') NOT NULL DEFAULT 'pending',
  summary         VARCHAR(1000) NOT NULL DEFAULT '',
  details_json    LONGTEXT      NOT NULL,
  evaluated_at    TIMESTAMP(3)  NULL DEFAULT NULL,
  evaluated_by    VARCHAR(128)  NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_customer_gate (customer_id,gate_key),
  KEY idx_divedeep_gate_status (status,gate_key,updated_at),
  KEY idx_divedeep_gate_customer (customer_id,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Versioned execution pools. Phase 2 supports Google Cloud Run Jobs as disposable compute.
CREATE TABLE IF NOT EXISTS divedeep_worker_pools (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  slug            VARCHAR(128)  NOT NULL,
  name            VARCHAR(160)  NOT NULL,
  description     VARCHAR(2000) NOT NULL DEFAULT '',
  provider        ENUM('google_cloud_run_jobs') NOT NULL DEFAULT 'google_cloud_run_jobs',
  status          ENUM('draft','active','draining','maintenance','disabled') NOT NULL DEFAULT 'draft',
  is_default      TINYINT(1)    NOT NULL DEFAULT 0,
  current_version INT UNSIGNED  NOT NULL DEFAULT 0,
  created_by      VARCHAR(128)  NULL,
  updated_by      VARCHAR(128)  NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_worker_pool_slug (slug),
  KEY idx_divedeep_worker_pool_status (status,is_default,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_worker_pool_versions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  pool_id               CHAR(36)      NOT NULL,
  version               INT UNSIGNED  NOT NULL,
  status                ENUM('draft','published','retired') NOT NULL DEFAULT 'draft',
  provider_config_json  LONGTEXT      NOT NULL,
  capabilities_json     LONGTEXT      NOT NULL,
  package_ids_json      LONGTEXT      NOT NULL,
  source_set_ids_json   LONGTEXT      NOT NULL,
  limits_json           LONGTEXT      NOT NULL,
  health_policy_json    LONGTEXT      NOT NULL,
  created_by            VARCHAR(128)  NULL,
  published_by          VARCHAR(128)  NULL,
  published_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_worker_pool_version (pool_id,version),
  KEY idx_divedeep_worker_pool_version_status (pool_id,status,version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_recon_jobs (
  id                                CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id                       CHAR(36)      NOT NULL,
  profile_id                        CHAR(36)      NULL,
  package_id                        VARCHAR(64)   NOT NULL,
  package_version_id                CHAR(36)      NULL,
  package_version                   INT UNSIGNED  NOT NULL DEFAULT 0,
  source_set_version_id             CHAR(36)      NULL,
  image_analysis_profile_version_id CHAR(36)      NULL,
  authorization_id                  CHAR(36)      NULL,
  authorization_document_sha256     CHAR(64)      NULL,
  worker_pool_id                    CHAR(36)      NULL,
  worker_pool_version_id            CHAR(36)      NULL,
  status                            ENUM('created','blocked','ready','awaiting_capacity','dispatching','running','awaiting_review','evidence_ready','completed','failed','cancelled','expired') NOT NULL DEFAULT 'created',
  current_gate                      VARCHAR(64)   NULL,
  priority                          SMALLINT      NOT NULL DEFAULT 0,
  progress_percent                  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  source_count                      INT UNSIGNED  NOT NULL DEFAULT 0,
  source_completed_count            INT UNSIGNED  NOT NULL DEFAULT 0,
  candidate_count                   INT UNSIGNED  NOT NULL DEFAULT 0,
  review_count                      INT UNSIGNED  NOT NULL DEFAULT 0,
  confirmed_count                   INT UNSIGNED  NOT NULL DEFAULT 0,
  manifest_enc                      LONGTEXT      NOT NULL,
  external_execution_name           VARCHAR(1024) NULL,
  last_error_code                   VARCHAR(96)   NULL,
  last_error_message                VARCHAR(2000) NULL,
  requested_at                      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  dispatched_at                     TIMESTAMP(3)  NULL DEFAULT NULL,
  started_at                        TIMESTAMP(3)  NULL DEFAULT NULL,
  heartbeat_at                      TIMESTAMP(3)  NULL DEFAULT NULL,
  completed_at                      TIMESTAMP(3)  NULL DEFAULT NULL,
  expires_at                        TIMESTAMP(3)  NULL DEFAULT NULL,
  created_by                        VARCHAR(128)  NULL,
  created_at                        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_recon_customer (customer_id,status,created_at),
  KEY idx_divedeep_recon_queue (status,priority,requested_at),
  KEY idx_divedeep_recon_pool (worker_pool_id,status,updated_at),
  KEY idx_divedeep_recon_expiry (status,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_recon_job_executions (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  recon_job_id             CHAR(36)      NOT NULL,
  attempt_number           SMALLINT UNSIGNED NOT NULL,
  provider                 ENUM('google_cloud_run_jobs') NOT NULL DEFAULT 'google_cloud_run_jobs',
  status                   ENUM('requested','running','completed','failed','cancelled','lost') NOT NULL DEFAULT 'requested',
  external_operation_name  VARCHAR(1024) NULL,
  external_execution_name  VARCHAR(1024) NULL,
  provider_state_json      LONGTEXT      NOT NULL,
  started_at               TIMESTAMP(3)  NULL DEFAULT NULL,
  completed_at             TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_recon_attempt (recon_job_id,attempt_number),
  KEY idx_divedeep_execution_status (status,updated_at),
  KEY idx_divedeep_execution_external (external_execution_name(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_recon_job_events (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  recon_job_id    CHAR(36)      NOT NULL,
  event_type      VARCHAR(96)   NOT NULL,
  actor_type      VARCHAR(32)   NOT NULL DEFAULT 'system',
  actor_id        VARCHAR(128)  NULL,
  details_json    TEXT          NOT NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_recon_event_job (recon_job_id,created_at),
  KEY idx_divedeep_recon_event_type (event_type,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 4: disposable DiveDeep worker identity, leases, checkpoints, source accounting,
-- candidate intake, and cleanup confirmation. Worker data is job-scoped and expires with the
-- API-owned retention policy; completed case payloads never depend on the Cloud Run filesystem.
CREATE TABLE IF NOT EXISTS divedeep_worker_bootstrap_tokens (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  recon_job_id             CHAR(36)      NOT NULL,
  execution_id             CHAR(36)      NOT NULL,
  worker_pool_version_id   CHAR(36)      NOT NULL,
  worker_instance_id       CHAR(36)      NULL,
  token_hash               CHAR(64)      NOT NULL,
  status                   ENUM('issued','consumed','expired','revoked') NOT NULL DEFAULT 'issued',
  expires_at               TIMESTAMP(3)  NOT NULL,
  consumed_at              TIMESTAMP(3)  NULL DEFAULT NULL,
  revoked_reason           VARCHAR(255)  NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_worker_bootstrap_hash (token_hash),
  KEY idx_divedeep_worker_bootstrap_job (recon_job_id,status,expires_at),
  KEY idx_divedeep_worker_bootstrap_execution (execution_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_worker_instances (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  recon_job_id             CHAR(36)      NOT NULL,
  execution_id             CHAR(36)      NOT NULL,
  worker_pool_version_id   CHAR(36)      NOT NULL,
  provider_instance_id     VARCHAR(1024) NULL,
  status                   ENUM('registered','running','uploading','finalizing','wiping','terminated','failed','lost') NOT NULL DEFAULT 'registered',
  registered_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  heartbeat_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at             TIMESTAMP(3)  NULL DEFAULT NULL,
  cleanup_ack_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  metadata_json            LONGTEXT      NOT NULL,
  cleanup_details_json     LONGTEXT      NULL,
  request_ip_hash          CHAR(64)      NULL,
  last_error               VARCHAR(2000) NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_worker_instance_job (recon_job_id,status,created_at),
  KEY idx_divedeep_worker_instance_execution (execution_id,status),
  KEY idx_divedeep_worker_instance_pool (worker_pool_version_id,status,heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_job_leases (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  recon_job_id             CHAR(36)      NOT NULL,
  execution_id             CHAR(36)      NOT NULL,
  worker_instance_id       CHAR(36)      NOT NULL,
  status                   ENUM('active','released','expired','revoked') NOT NULL DEFAULT 'active',
  issued_at                TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at               TIMESTAMP(3)  NOT NULL,
  heartbeat_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  released_at              TIMESTAMP(3)  NULL DEFAULT NULL,
  release_reason           VARCHAR(255)  NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_active_worker_lease (worker_instance_id),
  KEY idx_divedeep_job_lease_job (recon_job_id,status,expires_at),
  KEY idx_divedeep_job_lease_expiry (status,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_job_checkpoints (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  recon_job_id             CHAR(36)      NOT NULL,
  worker_instance_id       CHAR(36)      NOT NULL,
  lease_id                 CHAR(36)      NOT NULL,
  checkpoint_key           VARCHAR(128)  NOT NULL,
  sequence_number          INT UNSIGNED  NOT NULL DEFAULT 0,
  state_enc                LONGTEXT      NOT NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_job_checkpoint (recon_job_id,checkpoint_key,sequence_number),
  KEY idx_divedeep_checkpoint_job (recon_job_id,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_source_attempts (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  recon_job_id             CHAR(36)      NOT NULL,
  worker_instance_id       CHAR(36)      NOT NULL,
  lease_id                 CHAR(36)      NOT NULL,
  client_attempt_id        VARCHAR(128)  NOT NULL,
  resource_id              CHAR(36)      NULL,
  source_pool_version_id   CHAR(36)      NULL,
  source_key               VARCHAR(191)  NULL,
  status                   ENUM('started','completed','no_result','candidate_found','blocked','rate_limited','timed_out','unsupported','failed','skipped') NOT NULL,
  started_at               TIMESTAMP(3)  NULL DEFAULT NULL,
  completed_at             TIMESTAMP(3)  NULL DEFAULT NULL,
  candidate_count          INT UNSIGNED  NOT NULL DEFAULT 0,
  relevant_count           INT UNSIGNED  NOT NULL DEFAULT 0,
  error_class              VARCHAR(96)   NULL,
  duration_ms              INT UNSIGNED  NOT NULL DEFAULT 0,
  metadata_enc             LONGTEXT      NULL,
  payload_expires_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_source_attempt_client (recon_job_id,client_attempt_id),
  KEY idx_divedeep_source_attempt_job (recon_job_id,status,completed_at),
  KEY idx_divedeep_source_attempt_resource (resource_id,status,completed_at),
  KEY idx_divedeep_source_attempt_pool (source_pool_version_id,status,completed_at),
  KEY idx_divedeep_source_attempt_expiry (payload_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_recon_candidates (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  recon_job_id             CHAR(36)      NOT NULL,
  worker_instance_id       CHAR(36)      NOT NULL,
  lease_id                 CHAR(36)      NOT NULL,
  source_attempt_id        CHAR(36)      NULL,
  resource_id              CHAR(36)      NULL,
  client_candidate_id      VARCHAR(128)  NULL,
  candidate_type           VARCHAR(64)   NOT NULL,
  source_key               VARCHAR(191)  NULL,
  source_url_hash          CHAR(64)      NULL,
  dedupe_hash              CHAR(64)      NOT NULL,
  title_enc                LONGTEXT      NULL,
  summary_enc              LONGTEXT      NULL,
  discovered_at            TIMESTAMP(3)  NOT NULL,
  confidence               DECIMAL(5,2)  NULL,
  review_band              ENUM('low_priority','manual_review','high_priority','customer_validation_eligible') NOT NULL DEFAULT 'manual_review',
  state                    ENUM('review_required','customer_validation_requested','confirmed','rejected','promoted','expired') NOT NULL DEFAULT 'review_required',
  sensitivity              ENUM('standard','sensitive','restricted') NOT NULL DEFAULT 'standard',
  artifact_ids_json        LONGTEXT      NOT NULL,
  normalized_result_enc    LONGTEXT      NOT NULL,
  retention_class          ENUM('transient_nonmatch','pending_review','confirmed_relevant','removal_evidence','deletion_pending') NOT NULL DEFAULT 'pending_review',
  expires_at               TIMESTAMP(3)  NULL DEFAULT NULL,
  reviewed_by              VARCHAR(128)  NULL,
  reviewed_at              TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_candidate_dedupe (recon_job_id,dedupe_hash),
  KEY idx_divedeep_candidate_review (state,review_band,created_at),
  KEY idx_divedeep_candidate_job (recon_job_id,state,created_at),
  KEY idx_divedeep_candidate_expiry (state,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_recon_job_completions (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  recon_job_id             CHAR(36)      NOT NULL,
  execution_id             CHAR(36)      NOT NULL,
  worker_instance_id       CHAR(36)      NOT NULL,
  lease_id                 CHAR(36)      NOT NULL,
  outcome                  ENUM('completed','partial','failed') NOT NULL,
  summary_enc              LONGTEXT      NOT NULL,
  source_attempt_count     INT UNSIGNED  NOT NULL DEFAULT 0,
  candidate_count          INT UNSIGNED  NOT NULL DEFAULT 0,
  cleanup_status           ENUM('pending','confirmed','failed') NOT NULL DEFAULT 'pending',
  cleanup_ack_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  cleanup_details_json     LONGTEXT      NULL,
  completed_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_job_completion_worker (recon_job_id,worker_instance_id),
  KEY idx_divedeep_job_completion_cleanup (cleanup_status,completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A safe draft pool is present on fresh install. Dispatch remains disabled until the
-- root administrator configures Google Cloud Run and publishes the version.
INSERT IGNORE INTO divedeep_worker_pools
  (id,slug,name,description,provider,status,is_default,current_version,created_by,updated_by)
VALUES
  ('56000000-0000-4000-8000-000000000001','cloud-run-primary','Cloud Run DiveDeep','Disposable DiveDeep recon executions on Google Cloud Run Jobs.','google_cloud_run_jobs','draft',1,0,'system','system');

INSERT IGNORE INTO divedeep_worker_pool_versions
  (id,pool_id,version,status,provider_config_json,capabilities_json,package_ids_json,source_set_ids_json,limits_json,health_policy_json,created_by)
VALUES
  ('56100000-0000-4000-8000-000000000001','56000000-0000-4000-8000-000000000001',1,'draft',
   '{"integrationProvider":"google_cloud_run","projectId":"","region":"us-east1","jobName":"divedeep-divedeep","serviceAccountEmail":"","workerVersion":"5.29.0","workerProtocolVersion":1,"dispatchEnabled":false,"taskCount":1,"parallelism":1,"taskTimeoutSeconds":1800,"maxRetries":0,"lifecycle":"single_execution","transport":"api_callback","dataResidency":"us"}',
   '{"recon":true,"imageAnalysis":true,"sensitiveSources":true,"browserAutomation":true,"sourceAttemptEvents":true,"incrementalResults":true}',
   '[]','[]',
   '{"maximumConcurrentExecutions":2,"maximumJobSeconds":1800,"maximumTemporaryStorageMb":4096}',
   '{"staleAfterSeconds":180,"failureThreshold":3}',
   'system');

CREATE TABLE IF NOT EXISTS divedeep_authorizations (
  id                          CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id                 CHAR(36)      NOT NULL,
  signer_type                 ENUM('self','parent_guardian','legal_representative') NOT NULL DEFAULT 'self',
  status                      ENUM('active','revoked','expired','superseded') NOT NULL DEFAULT 'active',
  authorization_version       VARCHAR(64)   NOT NULL,
  electronic_records_version VARCHAR(64)   NOT NULL,
  responsible_data_version    VARCHAR(64)   NOT NULL,
  terms_version               VARCHAR(64)   NOT NULL,
  privacy_version             VARCHAR(64)   NOT NULL,
  legal_entity_name           VARCHAR(255)  NOT NULL,
  signer_name_enc             MEDIUMTEXT    NOT NULL,
  signer_address_enc          MEDIUMTEXT    NOT NULL,
  signer_phone_enc            MEDIUMTEXT    NULL,
  jurisdiction_country        VARCHAR(64)   NOT NULL DEFAULT 'US',
  jurisdiction_region         VARCHAR(128)  NULL,
  scope_enc                   MEDIUMTEXT    NOT NULL,
  typed_signature_enc         MEDIUMTEXT    NOT NULL,
  consent_record_enc          MEDIUMTEXT    NOT NULL,
  ip_address_enc              MEDIUMTEXT    NULL,
  ip_hash                     CHAR(64)      NULL,
  ip_source                   VARCHAR(64)   NOT NULL DEFAULT 'express:req.ip',
  user_agent_enc              MEDIUMTEXT    NULL,
  session_hash                CHAR(64)      NULL,
  signed_at                   TIMESTAMP(3)  NOT NULL,
  effective_at                TIMESTAMP(3)  NOT NULL,
  expires_at                  TIMESTAMP(3)  NOT NULL,
  revoked_at                  TIMESTAMP(3)  NULL DEFAULT NULL,
  revocation_reason_enc       MEDIUMTEXT    NULL,
  document_html_enc           LONGTEXT      NOT NULL,
  document_sha256             CHAR(64)      NOT NULL,
  created_at                  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_authorization_customer (customer_id,status,expires_at,signed_at),
  KEY idx_divedeep_authorization_expiry (status,expires_at),
  KEY idx_divedeep_authorization_document (document_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_authorization_events (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  authorization_id    CHAR(36)      NOT NULL,
  customer_id         CHAR(36)      NOT NULL,
  event_type          VARCHAR(96)   NOT NULL,
  actor_type          VARCHAR(32)   NOT NULL,
  actor_id            VARCHAR(128)  NULL,
  occurred_at         TIMESTAMP(3)  NOT NULL,
  ip_address_enc      MEDIUMTEXT    NULL,
  ip_hash             CHAR(64)      NULL,
  user_agent_enc      MEDIUMTEXT    NULL,
  session_hash        CHAR(64)      NULL,
  metadata_enc        MEDIUMTEXT    NULL,
  previous_event_hash CHAR(64)      NOT NULL,
  event_hash          CHAR(64)      NOT NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_authorization_event_hash (authorization_id,event_hash),
  KEY idx_divedeep_authorization_event_customer (customer_id,occurred_at),
  KEY idx_divedeep_authorization_event_auth (authorization_id,occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_social_connections (
  id                      CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id             CHAR(36)      NOT NULL,
  profile_id              CHAR(36)      NOT NULL,
  provider                VARCHAR(32)   NOT NULL,
  connection_mode         ENUM('manual','oauth') NOT NULL DEFAULT 'manual',
  external_user_id_enc    MEDIUMTEXT    NULL,
  external_user_id_hash   CHAR(64)      NULL,
  username_enc            MEDIUMTEXT    NULL,
  username_hash           CHAR(64)      NULL,
  profile_url_enc         MEDIUMTEXT    NULL,
  display_name_enc        MEDIUMTEXT    NULL,
  scopes_json             TEXT          NOT NULL,
  access_token_enc        MEDIUMTEXT    NULL,
  refresh_token_enc       MEDIUMTEXT    NULL,
  token_expires_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  metadata_enc            MEDIUMTEXT    NULL,
  status                  ENUM('connected','expired','disconnected','error','deleted') NOT NULL DEFAULT 'connected',
  connected_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  disconnected_at         TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_connection_external (customer_id,provider,external_user_id_hash),
  UNIQUE KEY uq_divedeep_connection_username (customer_id,provider,username_hash),
  KEY idx_divedeep_connection_customer (customer_id,status,updated_at),
  KEY idx_divedeep_connection_profile (profile_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_social_media_items (
  id                      CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id             CHAR(36)      NOT NULL,
  connection_id           CHAR(36)      NOT NULL,
  provider                VARCHAR(32)   NOT NULL,
  item_type               VARCHAR(32)   NOT NULL,
  external_item_id_enc    MEDIUMTEXT    NOT NULL,
  external_item_id_hash   CHAR(64)      NOT NULL,
  caption_enc             MEDIUMTEXT    NULL,
  permalink_enc           MEDIUMTEXT    NULL,
  profile_photo_id        CHAR(36)      NULL DEFAULT NULL,
  selection_status        ENUM('available','whitelisted','excluded') NOT NULL DEFAULT 'available',
  status                  ENUM('active','unavailable','deleted') NOT NULL DEFAULT 'active',
  published_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  metadata_enc            MEDIUMTEXT    NULL,
  last_synced_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_social_media_item (customer_id,provider,external_item_id_hash),
  KEY idx_divedeep_social_media_customer (customer_id,provider,item_type,status,published_at),
  KEY idx_divedeep_social_media_connection (connection_id,status,last_synced_at),
  KEY idx_divedeep_social_media_photo (profile_photo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_profile_photos (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id         CHAR(36)      NOT NULL,
  profile_id          CHAR(36)      NOT NULL,
  label_enc           MEDIUMTEXT    NULL,
  original_name_enc   MEDIUMTEXT    NULL,
  mime_type           VARCHAR(64)   NOT NULL,
  byte_size           INT UNSIGNED  NOT NULL,
  sha256              CHAR(64)      NOT NULL,
  storage_ref         VARCHAR(512)  NOT NULL,
  artifact_id         CHAR(36)      NULL,
  purpose             ENUM('identity_search','sensitive_search','verification') NOT NULL DEFAULT 'identity_search',
  status              ENUM('active','deleted') NOT NULL DEFAULT 'active',
  metadata_enc        MEDIUMTEXT    NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_photo_hash (customer_id,sha256),
  KEY idx_divedeep_photo_customer (customer_id,status,created_at),
  KEY idx_divedeep_photo_profile (profile_id,status),
  KEY idx_divedeep_photo_artifact (artifact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_import_batches (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id           CHAR(36)      NOT NULL,
  profile_id            CHAR(36)      NOT NULL,
  source_batch_id       VARCHAR(64)   NOT NULL,
  manifest_sha256       CHAR(64)      NOT NULL,
  manifest_enc          MEDIUMTEXT    NOT NULL,
  status                ENUM('created','importing','ready_review','review','published','failed','cancelled','expired') NOT NULL DEFAULT 'created',
  part_count            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  evidence_count        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  finding_count         INT UNSIGNED  NOT NULL DEFAULT 0,
  imported_count        INT UNSIGNED  NOT NULL DEFAULT 0,
  error_count           INT UNSIGNED  NOT NULL DEFAULT 0,
  bundle_storage_ref    VARCHAR(512)  NULL,
  bundle_sha256         CHAR(64)      NULL,
  bundle_byte_size      INT UNSIGNED  NULL,
  job_phase             VARCHAR(32)   NULL,
  job_current           INT UNSIGNED  NOT NULL DEFAULT 0,
  job_total             INT UNSIGNED  NOT NULL DEFAULT 0,
  job_message           VARCHAR(500)  NULL,
  job_started_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  job_heartbeat_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  job_completed_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  expires_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  created_by            VARCHAR(128)  NULL,
  finalized_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  published_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_import_source (customer_id,source_batch_id),
  KEY idx_divedeep_import_customer (customer_id,status,updated_at),
  KEY idx_divedeep_import_expiry (status,expires_at),
  KEY idx_divedeep_import_job (job_phase,job_heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_import_parts (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  batch_id              CHAR(36)      NOT NULL,
  part_number           SMALLINT UNSIGNED NOT NULL,
  file_name             VARCHAR(255)  NOT NULL,
  sha256                CHAR(64)      NOT NULL,
  byte_size             INT UNSIGNED  NOT NULL,
  finding_count         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  status                ENUM('pending','importing','imported','failed') NOT NULL DEFAULT 'pending',
  imported_count        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  error_count           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_error            VARCHAR(2000) NULL,
  imported_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_import_part (batch_id,part_number),
  UNIQUE KEY uq_divedeep_import_part_file (batch_id,file_name),
  KEY idx_divedeep_import_part_status (batch_id,status,part_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_import_findings (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  batch_id              CHAR(36)      NOT NULL,
  part_number           SMALLINT UNSIGNED NOT NULL,
  finding_key           VARCHAR(128)  NOT NULL,
  exposure_id           CHAR(36)      NOT NULL,
  case_id               CHAR(36)      NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_import_finding (batch_id,finding_key),
  KEY idx_divedeep_import_exposure (batch_id,exposure_id),
  KEY idx_divedeep_import_case (case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_evidence_files (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id           CHAR(36)      NOT NULL,
  profile_id            CHAR(36)      NOT NULL,
  import_batch_id       CHAR(36)      NULL,
  external_evidence_id  VARCHAR(80)   NULL,
  evidence_type         VARCHAR(64)   NOT NULL DEFAULT 'candidate_image',
  label_enc             MEDIUMTEXT    NULL,
  original_name_enc     MEDIUMTEXT    NULL,
  mime_type             VARCHAR(64)   NOT NULL,
  byte_size             INT UNSIGNED  NOT NULL,
  sha256                CHAR(64)      NOT NULL,
  storage_ref           VARCHAR(512)  NOT NULL,
  artifact_id           CHAR(36)      NULL,
  sensitivity           ENUM('standard','sensitive') NOT NULL DEFAULT 'standard',
  publication_status    ENUM('staged','approved','published','rejected','deleted') NOT NULL DEFAULT 'staged',
  captured_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  metadata_enc          MEDIUMTEXT    NULL,
  created_by            VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_evidence_hash (customer_id,sha256),
  KEY idx_divedeep_evidence_customer (customer_id,publication_status,created_at),
  KEY idx_divedeep_evidence_batch (import_batch_id,publication_status),
  KEY idx_divedeep_evidence_external (import_batch_id,external_evidence_id),
  KEY idx_divedeep_evidence_artifact (artifact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_evidence_links (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  evidence_id           CHAR(36)      NOT NULL,
  exposure_id           CHAR(36)      NOT NULL,
  finding_key           VARCHAR(128)  NULL,
  relationship          VARCHAR(64)   NOT NULL DEFAULT 'supports',
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_evidence_link (evidence_id,exposure_id,relationship),
  KEY idx_divedeep_evidence_link_exposure (exposure_id,evidence_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_import_evidence (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  batch_id              CHAR(36)      NOT NULL,
  external_evidence_id  VARCHAR(80)   NOT NULL,
  file_name             VARCHAR(255)  NOT NULL,
  sha256                CHAR(64)      NOT NULL,
  byte_size             INT UNSIGNED  NOT NULL,
  mime_type             VARCHAR(64)   NOT NULL,
  evidence_type         VARCHAR(64)   NOT NULL,
  sensitivity           ENUM('standard','sensitive') NOT NULL DEFAULT 'standard',
  finding_keys_json     TEXT          NOT NULL,
  status                ENUM('pending','metadata_only','uploading','uploaded','failed') NOT NULL DEFAULT 'pending',
  evidence_file_id      CHAR(36)      NULL,
  last_error            VARCHAR(2000) NULL,
  uploaded_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_import_evidence (batch_id,external_evidence_id),
  UNIQUE KEY uq_divedeep_import_evidence_file (batch_id,file_name),
  KEY idx_divedeep_import_evidence_status (batch_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;



-- Phase 3: provider-neutral private artifact storage. Large images, screenshots,
-- captures, and result payloads live in private object storage while MySQL keeps
-- only encrypted metadata, integrity state, review state, and retention controls.
CREATE TABLE IF NOT EXISTS divedeep_artifacts (
  id                      CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id             CHAR(36)      NULL,
  profile_id              CHAR(36)      NULL,
  recon_job_id            CHAR(36)      NULL,
  image_analysis_item_id  CHAR(36)      NULL,
  parent_artifact_id      CHAR(36)      NULL,
  artifact_type           VARCHAR(64)   NOT NULL,
  storage_provider        ENUM('local','s3') NOT NULL DEFAULT 's3',
  storage_bucket          VARCHAR(255)  NULL,
  object_key              VARCHAR(1024) NULL,
  storage_version_id      VARCHAR(512)  NULL,
  storage_etag            VARCHAR(255)  NULL,
  status                  ENUM('reserved','uploading','verifying','available','quarantined','deletion_pending','deleted','failed') NOT NULL DEFAULT 'reserved',
  content_type            VARCHAR(128)  NOT NULL,
  expected_byte_size      BIGINT UNSIGNED NOT NULL,
  actual_byte_size        BIGINT UNSIGNED NULL,
  expected_sha256         CHAR(64)      NOT NULL,
  actual_sha256           CHAR(64)      NULL,
  sensitivity             ENUM('standard','sensitive','restricted') NOT NULL DEFAULT 'standard',
  retention_class         ENUM('transient_nonmatch','failed_upload','pending_review','confirmed_relevant','removal_evidence','deletion_pending','audit_metadata') NOT NULL DEFAULT 'pending_review',
  review_status           ENUM('not_required','pending','customer_validation','confirmed','rejected','expired') NOT NULL DEFAULT 'pending',
  publication_status      ENUM('staged','approved','published','rejected','deleted') NOT NULL DEFAULT 'staged',
  access_scope            ENUM('worker_only','admin_only','customer_after_publish') NOT NULL DEFAULT 'admin_only',
  legal_hold              TINYINT(1)    NOT NULL DEFAULT 0,
  lifecycle_exempt         TINYINT(1)    NOT NULL DEFAULT 0,
  hold_reason_enc         MEDIUMTEXT    NULL,
  hold_set_by             VARCHAR(128)  NULL,
  hold_set_at             TIMESTAMP(3)  NULL DEFAULT NULL,
  expires_at              TIMESTAMP(3)  NULL DEFAULT NULL,
  original_name_enc       MEDIUMTEXT    NULL,
  metadata_enc            MEDIUMTEXT    NULL,
  last_error_code         VARCHAR(96)   NULL,
  last_error_message      VARCHAR(2000) NULL,
  created_by              VARCHAR(128)  NULL,
  verified_at             TIMESTAMP(3)  NULL DEFAULT NULL,
  deleted_at              TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_artifact_object (storage_provider,storage_bucket,object_key),
  KEY idx_divedeep_artifact_customer (customer_id,status,created_at),
  KEY idx_divedeep_artifact_job (recon_job_id,status,created_at),
  KEY idx_divedeep_artifact_analysis (image_analysis_item_id,status),
  KEY idx_divedeep_artifact_retention (legal_hold,status,expires_at),
  KEY idx_divedeep_artifact_review (review_status,publication_status,created_at),
  KEY idx_divedeep_artifact_parent (parent_artifact_id,artifact_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_artifact_upload_sessions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  artifact_id           CHAR(36)      NOT NULL,
  status                ENUM('issuing','issued','uploading','finalized','expired','failed') NOT NULL DEFAULT 'issuing',
  method                ENUM('presigned_put','api_put') NOT NULL DEFAULT 'presigned_put',
  expected_headers_json TEXT          NOT NULL,
  expires_at            TIMESTAMP(3)  NOT NULL,
  finalized_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  last_error            VARCHAR(2000) NULL,
  created_by            VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_artifact_upload_artifact (artifact_id,status,created_at),
  KEY idx_divedeep_artifact_upload_expiry (status,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_artifact_events (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  artifact_id           CHAR(36)      NOT NULL,
  event_type            VARCHAR(96)   NOT NULL,
  actor_type            VARCHAR(32)   NOT NULL,
  actor_id              VARCHAR(128)  NULL,
  details_json          TEXT          NOT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_artifact_event_artifact (artifact_id,created_at),
  KEY idx_divedeep_artifact_event_type (event_type,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_retention_actions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  artifact_id           CHAR(36)      NOT NULL,
  action                ENUM('delete','extend','hold','release_hold','reclassify') NOT NULL,
  status                ENUM('pending','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'pending',
  reason                VARCHAR(1000) NOT NULL,
  execute_after         TIMESTAMP(3)  NOT NULL,
  next_attempt_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  attempt_count         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_error            VARCHAR(2000) NULL,
  requested_by          VARCHAR(128)  NULL,
  completed_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_retention_action_due (status,execute_after,next_attempt_at),
  KEY idx_divedeep_retention_action_artifact (artifact_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Phase 5: complete privacy workflow gate. The API owns the durable lifecycle,
-- human-review assignments, customer actions, removal-delivery tracking,
-- monitoring schedules, and explicit closure decisions.
CREATE TABLE IF NOT EXISTS divedeep_workflow_runs (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id           CHAR(36)      NOT NULL,
  profile_id            CHAR(36)      NULL,
  package_version_id    CHAR(36)      NULL,
  source_set_version_id CHAR(36)      NULL,
  authorization_id      CHAR(36)      NULL,
  active_recon_job_id   CHAR(36)      NULL,
  status                ENUM('active','blocked','monitoring','completed','closed','withdrawn') NOT NULL DEFAULT 'active',
  stage                 VARCHAR(64)   NOT NULL DEFAULT 'enrollment',
  outcome               ENUM('pending','completed','continuing_monitoring','withdrawn','failed') NOT NULL DEFAULT 'pending',
  summary_json          LONGTEXT      NOT NULL,
  started_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  closed_at             TIMESTAMP(3)  NULL DEFAULT NULL,
  closed_by             VARCHAR(128)  NULL,
  closure_reason        VARCHAR(2000) NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_workflow_customer (customer_id,status,updated_at),
  KEY idx_divedeep_workflow_stage (status,stage,updated_at),
  KEY idx_divedeep_workflow_job (active_recon_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_workflow_gate_events (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  workflow_run_id       CHAR(36)      NOT NULL,
  customer_id           CHAR(36)      NOT NULL,
  gate_key              VARCHAR(64)   NOT NULL,
  previous_status       ENUM('pending','pass','blocked','waived') NULL,
  new_status            ENUM('pending','pass','blocked','waived') NOT NULL,
  reason                VARCHAR(1000) NOT NULL,
  details_json          LONGTEXT      NOT NULL,
  actor_type            ENUM('system','admin','worker','customer') NOT NULL DEFAULT 'system',
  actor_id              VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_gate_event_run (workflow_run_id,created_at),
  KEY idx_divedeep_gate_event_customer (customer_id,created_at),
  KEY idx_divedeep_gate_event_gate (gate_key,new_status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_review_tasks (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id           CHAR(36)      NOT NULL,
  recon_job_id          CHAR(36)      NULL,
  entity_type           ENUM('recon_candidate','image_analysis_item','exposure','artifact','removal_case') NOT NULL,
  entity_id             CHAR(36)      NOT NULL,
  review_type           ENUM('identity_match','evidence_disposition','sensitive_review','removal_approval','quality_control') NOT NULL,
  status                ENUM('open','assigned','awaiting_customer','resolved','expired','cancelled') NOT NULL DEFAULT 'open',
  priority              ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  assigned_to           VARCHAR(128)  NULL,
  assigned_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  due_at                TIMESTAMP(3)  NULL DEFAULT NULL,
  disposition           VARCHAR(64)   NULL,
  confidence            DECIMAL(6,3)  NULL,
  note                  VARCHAR(2000) NULL,
  resolved_by           VARCHAR(128)  NULL,
  resolved_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_review_entity (entity_type,entity_id,review_type),
  KEY idx_divedeep_review_queue (status,priority,due_at,created_at),
  KEY idx_divedeep_review_customer (customer_id,status,updated_at),
  KEY idx_divedeep_review_job (recon_job_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_customer_action_requests (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id           CHAR(36)      NOT NULL,
  workflow_run_id       CHAR(36)      NULL,
  action_type           ENUM('image_validation','removal_form','identity_confirmation','additional_information') NOT NULL,
  entity_type           VARCHAR(64)   NOT NULL,
  entity_id             CHAR(36)      NOT NULL,
  status                ENUM('pending','viewed','completed','expired','cancelled') NOT NULL DEFAULT 'pending',
  title                 VARCHAR(255)  NOT NULL,
  instructions_enc      MEDIUMTEXT    NULL,
  response_enc          MEDIUMTEXT    NULL,
  due_at                TIMESTAMP(3)  NULL DEFAULT NULL,
  viewed_at             TIMESTAMP(3)  NULL DEFAULT NULL,
  completed_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_customer_action_entity (customer_id,action_type,entity_type,entity_id),
  KEY idx_divedeep_customer_action_queue (customer_id,status,due_at),
  KEY idx_divedeep_customer_action_run (workflow_run_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_request_deliveries (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id           CHAR(36)      NOT NULL,
  case_id               CHAR(36)      NOT NULL,
  delivery_method       ENUM('email','customer_form','api','browser','guidance') NOT NULL,
  provider              VARCHAR(64)   NULL,
  destination_enc       MEDIUMTEXT    NULL,
  status                ENUM('draft','approved','queued','sending','sent','acknowledged','customer_action','completed','failed','cancelled') NOT NULL DEFAULT 'draft',
  attempt_count         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts          SMALLINT UNSIGNED NOT NULL DEFAULT 4,
  next_attempt_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  sent_at               TIMESTAMP(3)  NULL DEFAULT NULL,
  acknowledged_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  completed_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  provider_message_id   VARCHAR(255)  NULL,
  confirmation_reference VARCHAR(255) NULL,
  last_error_code       VARCHAR(96)   NULL,
  last_error_message    VARCHAR(2000) NULL,
  created_by            VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_delivery_case_method (case_id,delivery_method),
  KEY idx_divedeep_delivery_queue (status,next_attempt_at,updated_at),
  KEY idx_divedeep_delivery_customer (customer_id,status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_request_delivery_attempts (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  delivery_id           CHAR(36)      NOT NULL,
  attempt_number        SMALLINT UNSIGNED NOT NULL,
  status                ENUM('started','sent','acknowledged','customer_action','failed') NOT NULL,
  provider_status       VARCHAR(96)   NULL,
  provider_message_id   VARCHAR(255)  NULL,
  response_enc          MEDIUMTEXT    NULL,
  error_code            VARCHAR(96)   NULL,
  error_message         VARCHAR(2000) NULL,
  started_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_delivery_attempt (delivery_id,attempt_number),
  KEY idx_divedeep_delivery_attempt_status (status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_monitoring_schedules (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id           CHAR(36)      NOT NULL,
  profile_id            CHAR(36)      NULL,
  exposure_id           CHAR(36)      NULL,
  case_id               CHAR(36)      NULL,
  monitor_type          ENUM('removal_verification','reappearance_check','known_url','package_rescan','sensitive_image_recheck','response_deadline') NOT NULL,
  cadence               ENUM('once','daily','weekly','monthly','quarterly') NOT NULL DEFAULT 'once',
  status                ENUM('draft','active','paused','completed','failed','cancelled') NOT NULL DEFAULT 'draft',
  next_run_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  last_run_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  failure_count         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  configuration_json    LONGTEXT      NOT NULL,
  created_by            VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_monitoring_due (status,next_run_at),
  KEY idx_divedeep_monitoring_customer (customer_id,status,updated_at),
  KEY idx_divedeep_monitoring_case (case_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_monitoring_checks (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  schedule_id           CHAR(36)      NOT NULL,
  customer_id           CHAR(36)      NOT NULL,
  result                ENUM('removed','still_present','changed','reappeared','unreachable','blocked','needs_review') NOT NULL,
  http_status           SMALLINT UNSIGNED NULL,
  content_fingerprint   CHAR(64)      NULL,
  artifact_id           CHAR(36)      NULL,
  notes_enc             MEDIUMTEXT    NULL,
  checked_by            VARCHAR(128)  NULL,
  checked_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_monitoring_check_schedule (schedule_id,checked_at),
  KEY idx_divedeep_monitoring_check_result (customer_id,result,checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_customer_events (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id     CHAR(36)      NOT NULL,
  event_type      VARCHAR(96)   NOT NULL,
  actor_type      VARCHAR(32)   NOT NULL,
  actor_id        VARCHAR(128)  NULL,
  details_enc     MEDIUMTEXT    NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_event_customer (customer_id,created_at),
  KEY idx_divedeep_event_type (event_type,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Persistent DiveDeep node orchestration was intentionally removed before first deployment.
-- Ephemeral worker pools and job leasing will be introduced in a later phase.

-- Root-owned integration vault for the DiveDeep SaaS control plane. Public
-- configuration and encrypted credentials are intentionally stored apart;
-- credential values are never returned by administrative APIs.
CREATE TABLE IF NOT EXISTS divedeep_integrations (
  provider                VARCHAR(64)   NOT NULL PRIMARY KEY,
  config_json             MEDIUMTEXT    NOT NULL,
  secrets_enc             MEDIUMTEXT    NULL,
  secret_hints_json       TEXT          NOT NULL,
  is_enabled              TINYINT(1)    NOT NULL DEFAULT 0,
  verification_status     ENUM('not_checked','configured','invalid','disconnected') NOT NULL DEFAULT 'not_checked',
  verification_message    VARCHAR(1000) NULL,
  last_verified_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  updated_by              VARCHAR(128)  NULL,
  created_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_integration_status (is_enabled,verification_status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_integration_events (
  id            CHAR(36)      NOT NULL PRIMARY KEY,
  provider      VARCHAR(64)   NOT NULL,
  event_type    VARCHAR(96)   NOT NULL,
  actor_id      VARCHAR(128)  NULL,
  details_json  TEXT          NOT NULL,
  created_at    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_integration_events (provider,created_at),
  KEY idx_divedeep_integration_actor (actor_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Phase 8: GoHighLevel lifecycle integration. These tables contain only CRM linkage,
-- normalized lifecycle state, queue control data, and bounded error metadata. Privacy
-- evidence, candidate images, findings, reviewer notes, authorization documents, and
-- removal destinations remain exclusively inside the DiveDeep privacy data model.
CREATE TABLE IF NOT EXISTS divedeep_crm_contact_links (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id           CHAR(36)      NOT NULL,
  integration_id        CHAR(36)      NOT NULL,
  location_id           VARCHAR(128)  NOT NULL,
  external_contact_id   VARCHAR(191)  NOT NULL,
  lead_id               VARCHAR(128)  NULL,
  status                ENUM('active','unlinked','suspended') NOT NULL DEFAULT 'active',
  link_source           VARCHAR(32)   NOT NULL DEFAULT 'verified_email_match',
  verified_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  last_inbound_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  last_outbound_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  last_queued_hash      CHAR(64)      NULL,
  last_delivered_hash   CHAR(64)      NULL,
  metadata_json         TEXT          NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_crm_customer_integration (customer_id,integration_id),
  UNIQUE KEY uq_divedeep_crm_external_contact (integration_id,external_contact_id),
  KEY idx_divedeep_crm_link_status (integration_id,status,updated_at),
  KEY idx_divedeep_crm_link_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_crm_webhook_endpoints (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id        CHAR(36)      NOT NULL,
  public_id             VARCHAR(64)   NOT NULL,
  secret_enc            TEXT          NOT NULL,
  secret_hint           VARCHAR(16)   NOT NULL,
  is_enabled            TINYINT(1)    NOT NULL DEFAULT 1,
  last_received_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_crm_webhook_integration (integration_id),
  UNIQUE KEY uq_divedeep_crm_webhook_public (public_id),
  KEY idx_divedeep_crm_webhook_enabled (is_enabled,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_crm_inbound_events (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  endpoint_id           CHAR(36)      NOT NULL,
  integration_id        CHAR(36)      NOT NULL,
  event_key             VARCHAR(191)  NOT NULL,
  event_type            VARCHAR(96)   NOT NULL,
  external_contact_id   VARCHAR(191)  NULL,
  payload_hash          CHAR(64)      NOT NULL,
  payload_json          MEDIUMTEXT    NOT NULL,
  status                ENUM('queued','processing','retry','completed','dead_letter','ignored') NOT NULL DEFAULT 'queued',
  auth_mode             VARCHAR(16)   NOT NULL,
  request_id            VARCHAR(64)   NULL,
  attempts              SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts          SMALLINT UNSIGNED NOT NULL DEFAULT 6,
  available_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_at             TIMESTAMP(3)  NULL DEFAULT NULL,
  locked_by             VARCHAR(128)  NULL,
  last_error_code       VARCHAR(96)   NULL,
  last_error_message    VARCHAR(1000) NULL,
  hawk_execution_ids_json TEXT        NULL,
  received_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  dead_lettered_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_crm_inbound_event (integration_id,event_key),
  KEY idx_divedeep_crm_inbound_queue (status,available_at,created_at),
  KEY idx_divedeep_crm_inbound_contact (integration_id,external_contact_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_crm_outbound_events (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  contact_link_id       CHAR(36)      NOT NULL,
  customer_id           CHAR(36)      NOT NULL,
  integration_id        CHAR(36)      NOT NULL,
  external_contact_id   VARCHAR(191)  NOT NULL,
  event_type            VARCHAR(96)   NOT NULL,
  idempotency_key       VARCHAR(191)  NOT NULL,
  payload_hash          CHAR(64)      NOT NULL,
  payload_json          MEDIUMTEXT    NOT NULL,
  status                ENUM('queued','processing','retry','completed','dead_letter','ignored') NOT NULL DEFAULT 'queued',
  attempts              SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts          SMALLINT UNSIGNED NOT NULL DEFAULT 6,
  available_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_at             TIMESTAMP(3)  NULL DEFAULT NULL,
  locked_by             VARCHAR(128)  NULL,
  last_error_code       VARCHAR(96)   NULL,
  last_error_message    VARCHAR(1000) NULL,
  hawk_execution_ids_json TEXT        NULL,
  processed_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  dead_lettered_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_crm_outbound_idempotency (integration_id,idempotency_key),
  KEY idx_divedeep_crm_outbound_queue (status,available_at,created_at),
  KEY idx_divedeep_crm_outbound_customer (customer_id,status,created_at),
  KEY idx_divedeep_crm_outbound_contact (integration_id,external_contact_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_crm_dead_letters (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  direction             ENUM('inbound','outbound') NOT NULL,
  source_event_id       CHAR(36)      NOT NULL,
  integration_id        CHAR(36)      NOT NULL,
  customer_id           CHAR(36)      NULL,
  external_contact_id   VARCHAR(191)  NULL,
  event_type            VARCHAR(96)   NOT NULL,
  payload_hash          CHAR(64)      NOT NULL,
  error_code            VARCHAR(96)   NOT NULL,
  error_message         VARCHAR(1000) NOT NULL,
  replay_count          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  resolved_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  resolved_by           VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_crm_dead_letter (direction,source_event_id),
  KEY idx_divedeep_crm_dead_unresolved (resolved_at,created_at),
  KEY idx_divedeep_crm_dead_integration (integration_id,direction,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 9: stable customer, integration, and enterprise API identities.
-- These tables intentionally reference customer and organization boundaries only.
-- They never grant access to worker credentials, raw object storage, evidence files,
-- import batches, review notes, or hidden administrative operations.
CREATE TABLE IF NOT EXISTS divedeep_organizations (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  slug                  VARCHAR(96)   NOT NULL,
  name                  VARCHAR(191)  NOT NULL,
  external_reference    VARCHAR(191)  NULL,
  status                ENUM('active','suspended','closed') NOT NULL DEFAULT 'active',
  created_by            VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_organization_slug (slug),
  KEY idx_divedeep_organization_status (status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_organization_customers (
  organization_id       CHAR(36)      NOT NULL,
  customer_id           CHAR(36)      NOT NULL,
  external_reference    VARCHAR(191)  NULL,
  status                ENUM('active','suspended','removed') NOT NULL DEFAULT 'active',
  created_by            VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (organization_id,customer_id),
  KEY idx_divedeep_org_customer_customer (customer_id,status),
  KEY idx_divedeep_org_customer_status (organization_id,status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_service_identities (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  name                  VARCHAR(191)  NOT NULL,
  identity_type         ENUM('customer','enterprise','integration') NOT NULL,
  auth_method           ENUM('api_key','oauth_client') NOT NULL,
  customer_id           CHAR(36)      NULL,
  organization_id       CHAR(36)      NULL,
  key_prefix            VARCHAR(24)   NULL,
  api_key_hash          CHAR(64)      NULL,
  oauth_client_id       VARCHAR(96)   NULL,
  oauth_client_secret_hash CHAR(64)   NULL,
  scopes_json           TEXT          NOT NULL,
  rate_limit_per_minute INT UNSIGNED  NOT NULL DEFAULT 120,
  status                ENUM('active','suspended','revoked') NOT NULL DEFAULT 'active',
  last_used_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_by            VARCHAR(128)  NULL,
  revoked_by            VARCHAR(128)  NULL,
  revoked_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_service_api_hash (api_key_hash),
  UNIQUE KEY uq_divedeep_service_oauth_client (oauth_client_id),
  KEY idx_divedeep_service_scope (identity_type,status,organization_id,customer_id),
  KEY idx_divedeep_service_prefix (key_prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_oauth_access_tokens (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  service_identity_id   CHAR(36)      NOT NULL,
  token_prefix          VARCHAR(24)   NOT NULL,
  token_hash            CHAR(64)      NOT NULL,
  scopes_json           TEXT          NOT NULL,
  expires_at            TIMESTAMP(3)  NOT NULL,
  last_used_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  revoked_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_oauth_token_hash (token_hash),
  KEY idx_divedeep_oauth_identity (service_identity_id,expires_at,revoked_at),
  KEY idx_divedeep_oauth_prefix (token_prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_api_idempotency (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  service_identity_id   CHAR(36)      NOT NULL,
  request_scope         VARCHAR(255)  NOT NULL,
  idempotency_key       VARCHAR(191)  NOT NULL,
  request_hash          CHAR(64)      NOT NULL,
  state                 ENUM('processing','completed','failed') NOT NULL DEFAULT 'processing',
  response_status       SMALLINT UNSIGNED NULL,
  response_json         MEDIUMTEXT    NULL,
  expires_at            TIMESTAMP(3)  NOT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_api_idempotency (service_identity_id,request_scope,idempotency_key),
  KEY idx_divedeep_api_idempotency_expiry (expires_at,state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_api_rate_windows (
  service_identity_id   CHAR(36)      NOT NULL,
  window_started_at     TIMESTAMP     NOT NULL,
  request_count         INT UNSIGNED  NOT NULL DEFAULT 0,
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (service_identity_id,window_started_at),
  KEY idx_divedeep_api_rate_cleanup (window_started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_webhook_subscriptions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  organization_id       CHAR(36)      NULL,
  customer_id           CHAR(36)      NULL,
  name                  VARCHAR(191)  NOT NULL,
  endpoint_url          VARCHAR(2048) NOT NULL,
  event_types_json      TEXT          NOT NULL,
  signing_secret_enc    TEXT          NOT NULL,
  secret_hint           VARCHAR(16)   NOT NULL,
  status                ENUM('active','paused','revoked') NOT NULL DEFAULT 'active',
  last_success_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  last_failure_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  created_by            VARCHAR(128)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_webhook_scope (organization_id,customer_id,status),
  KEY idx_divedeep_webhook_status (status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_webhook_deliveries (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  subscription_id       CHAR(36)      NOT NULL,
  event_id              CHAR(36)      NOT NULL,
  event_type            VARCHAR(96)   NOT NULL,
  organization_id       CHAR(36)      NULL,
  customer_id           CHAR(36)      NULL,
  payload_json          MEDIUMTEXT    NOT NULL,
  payload_hash          CHAR(64)      NOT NULL,
  status                ENUM('queued','processing','retry','completed','dead_letter') NOT NULL DEFAULT 'queued',
  attempts              SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts          SMALLINT UNSIGNED NOT NULL DEFAULT 6,
  available_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_at             TIMESTAMP(3)  NULL DEFAULT NULL,
  locked_by             VARCHAR(128)  NULL,
  response_status       SMALLINT UNSIGNED NULL,
  response_hash         CHAR(64)      NULL,
  last_error_code       VARCHAR(96)   NULL,
  last_error_message    VARCHAR(1000) NULL,
  delivered_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_webhook_event (subscription_id,event_id),
  KEY idx_divedeep_webhook_queue (status,available_at,created_at),
  KEY idx_divedeep_webhook_event_type (event_type,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_external_api_events (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  service_identity_id   CHAR(36)      NOT NULL,
  organization_id       CHAR(36)      NULL,
  customer_id           CHAR(36)      NULL,
  event_type            VARCHAR(96)   NOT NULL,
  external_event_id     VARCHAR(191)  NULL,
  payload_json          MEDIUMTEXT    NOT NULL,
  payload_hash          CHAR(64)      NOT NULL,
  received_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_external_event (service_identity_id,external_event_id),
  KEY idx_divedeep_external_event_scope (organization_id,customer_id,event_type,received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 10: production hardening, release readiness evidence, controlled rollout,
-- disaster-recovery rehearsal, and multi-provider readiness. These records contain
-- operational metadata only and never store customer evidence or raw worker payloads.
CREATE TABLE IF NOT EXISTS divedeep_release_readiness_checks (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  deployment_environment   ENUM('development','staging','production') NOT NULL,
  release_version          VARCHAR(64)   NOT NULL,
  check_type               ENUM('environment_separation','migration_dry_run','rollback_verification','storage_lifecycle','worker_loss','expired_lease_recovery','corrupt_upload','retention_deletion','sentinel_alert','ghl_webhook_replay','package_compatibility','disaster_recovery') NOT NULL,
  status                   ENUM('passed','failed','warning','skipped') NOT NULL,
  summary                  VARCHAR(1000) NOT NULL,
  details_json             LONGTEXT      NOT NULL,
  artifact_sha256          CHAR(64)      NULL,
  started_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  recorded_by              VARCHAR(128)  NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_readiness_latest (deployment_environment,check_type,completed_at),
  KEY idx_divedeep_readiness_release (release_version,status,completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_rollout_state (
  deployment_environment   ENUM('development','staging','production') NOT NULL PRIMARY KEY,
  stage                    ENUM('internal_test_records','controlled_pilot','small_customer_cohort','normal_production','enterprise_clients','hourly_burst_capacity','multi_provider_capacity') NOT NULL DEFAULT 'internal_test_records',
  status                   ENUM('held','active','completed','rolled_back') NOT NULL DEFAULT 'held',
  cohort_limit             INT UNSIGNED NOT NULL DEFAULT 0,
  decision_reason          VARCHAR(1000) NULL,
  updated_by               VARCHAR(128)  NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_rollout_stage (stage,status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_rollout_events (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  deployment_environment   ENUM('development','staging','production') NOT NULL,
  from_stage               VARCHAR(64)   NOT NULL,
  to_stage                 VARCHAR(64)   NOT NULL,
  direction                ENUM('same','forward','rollback') NOT NULL,
  reason                   VARCHAR(1000) NULL,
  actor_id                 VARCHAR(128)  NULL,
  details_json             TEXT          NOT NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_rollout_event_env (deployment_environment,created_at),
  KEY idx_divedeep_rollout_event_stage (to_stage,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_rollout_assignments (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  deployment_environment   ENUM('development','staging','production') NOT NULL,
  customer_id              CHAR(36)      NOT NULL,
  stage                    ENUM('internal_test_records','controlled_pilot','small_customer_cohort','normal_production','enterprise_clients','hourly_burst_capacity','multi_provider_capacity') NOT NULL,
  status                   ENUM('active','completed','removed','paused') NOT NULL DEFAULT 'active',
  assigned_by              VARCHAR(128)  NULL,
  notes                    VARCHAR(2000) NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_divedeep_rollout_customer (deployment_environment,customer_id),
  KEY idx_divedeep_rollout_assignment_stage (deployment_environment,stage,status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_disaster_recovery_rehearsals (
  id                       CHAR(36)      NOT NULL PRIMARY KEY,
  deployment_environment   ENUM('development','staging','production') NOT NULL,
  release_version          VARCHAR(64)   NOT NULL,
  status                   ENUM('passed','failed','partial') NOT NULL,
  rpo_minutes              INT UNSIGNED  NOT NULL DEFAULT 0,
  rto_minutes              INT UNSIGNED  NOT NULL DEFAULT 0,
  backup_sha256            CHAR(64)      NULL,
  restore_target           VARCHAR(255)  NULL,
  summary                  VARCHAR(2000) NOT NULL,
  details_json             LONGTEXT      NOT NULL,
  performed_by             VARCHAR(128)  NULL,
  started_at               TIMESTAMP(3)  NOT NULL,
  completed_at             TIMESTAMP(3)  NOT NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_divedeep_dr_environment (deployment_environment,completed_at),
  KEY idx_divedeep_dr_status (status,completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS divedeep_compute_provider_readiness (
  deployment_environment   ENUM('development','staging','production') NOT NULL,
  provider                 VARCHAR(64)   NOT NULL,
  status                   ENUM('not_configured','configured','validated','ready','blocked') NOT NULL DEFAULT 'not_configured',
  protocol_version         VARCHAR(64)   NULL,
  package_version          VARCHAR(64)   NULL,
  last_validation_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  details_json             LONGTEXT      NOT NULL,
  updated_by               VARCHAR(128)  NULL,
  created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (deployment_environment,provider),
  KEY idx_divedeep_provider_status (deployment_environment,status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO divedeep_rollout_state
  (deployment_environment,stage,status,cohort_limit,decision_reason,updated_by)
VALUES
  ('development','internal_test_records','held',0,'Fresh install default','system'),
  ('staging','internal_test_records','held',0,'Fresh install default','system'),
  ('production','internal_test_records','held',0,'Fresh install default','system');
