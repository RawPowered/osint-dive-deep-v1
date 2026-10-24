const express = require('express');
const { getPool } = require('../../db/pool');
const {
  publicIntegration,
  getAuthorizedIntegration,
} = require('../../services/crmIntegrations');
const {
  testIntegration,
  createImportRun,
  getImportRun,
  executeImportRun,
  backfillExistingLeads,
} = require('../../services/crmImporter');
const diveDeepCrm = require('../../services/diveDeepCrmIntegration');

function createCrmRouter() {
  const router = express.Router();

  router.get('/integrations', async (req, res) => {
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT i.*, g.allow_read, g.allow_import, g.allow_manage_leads
         FROM crm_integrations i
         INNER JOIN crm_integration_grants g ON g.integration_id = i.id
         WHERE g.api_key_id = ? AND i.is_enabled = 1 ORDER BY i.name`,
        [req.apiKey.id]
      );
      res.json({
        success: true,
        integrations: rows.map((row) => ({
          ...publicIntegration(row),
          permissions: {
            read: Boolean(row.allow_read),
            import: Boolean(row.allow_import),
            manageLeads: Boolean(row.allow_manage_leads),
          },
        })),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/integrations/:id/test', async (req, res) => {
    try {
      const integration = await getAuthorizedIntegration(
        req.params.id,
        req.apiKey.id,
        'allow_import'
      );
      res.json({ success: true, ...(await testIntegration(integration)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/integrations/:id/fields', async (req, res) => {
    try {
      await getAuthorizedIntegration(req.params.id, req.apiKey.id, 'allow_read');
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT field_key, field_label, data_type, first_seen_at, last_seen_at
         FROM crm_field_definitions WHERE integration_id = ? ORDER BY field_key`,
        [req.params.id]
      );
      const [objectFields] = await pool.query(
        `SELECT field_id AS fieldId, object_model AS objectModel, field_key AS fieldKey,
                field_name AS fieldName, data_type AS dataType, metadata_json AS metadata,
                first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
         FROM crm_object_field_definitions
         WHERE integration_id = ? AND is_current = 1
         ORDER BY object_model, field_name, field_id`,
        [req.params.id]
      );
      res.json({
        success: true,
        fields: rows,
        objectFields: objectFields.map((row) => ({ ...row, metadata: safeJson(row.metadata) })),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/integrations/:id/contact-records', async (req, res) => {
    try {
      await getAuthorizedIntegration(req.params.id, req.apiKey.id, 'allow_read');
      const pool = getPool();
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const afterId = String(req.query.afterId || '').slice(0, 191);
      const includeInactive = req.query.includeInactive === 'true';
      const [rows] = await pool.query(
        `SELECT external_record_id AS externalRecordId, location_id AS locationId,
                lead_id AS leadId, payload_hash AS payloadHash, payload_json AS payload,
                external_updated_at AS externalUpdatedAt, first_seen_at AS firstSeenAt,
                last_seen_at AS lastSeenAt, is_current AS isCurrent
         FROM crm_contact_records
         WHERE integration_id = ? AND external_record_id > ?${includeInactive ? '' : ' AND is_current = 1'}
         ORDER BY external_record_id ASC LIMIT ?`,
        [req.params.id, afterId, limit]
      );
      const records = rows.map((row) => ({
        ...row,
        isCurrent: Boolean(row.isCurrent),
        payload: safeJson(row.payload),
      }));
      res.json({
        success: true,
        records,
        nextAfterId: records.length === limit ? records[records.length - 1].externalRecordId : null,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/integrations/:id/imports', async (req, res) => {
    try {
      const integration = await getAuthorizedIntegration(
        req.params.id,
        req.apiKey.id,
        'allow_import'
      );
      const input = req.body || {};
      const options = {
        dryRun: Boolean(input.dryRun),
        full: Boolean(input.full),
        pageSize: Math.min(Math.max(Number(input.pageSize) || 100, 1), 500),
        maxPages: Math.min(Math.max(Number(input.maxPages) || 1000, 1), 100000),
        defaultServiceType: input.defaultServiceType
          ? String(input.defaultServiceType).slice(0, 128)
          : undefined,
      };
      const runId = await createImportRun(integration, req.apiKey.id, options);
      setImmediate(() => {
        executeImportRun(integration, runId).catch((error) => {
          console.error(`CRM import ${runId} failed:`, error.message);
        });
      });
      res.status(202).json({ success: true, runId, status: 'queued' });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/integrations/:id/backfill', async (req, res) => {
    try {
      const integration = await getAuthorizedIntegration(
        req.params.id,
        req.apiKey.id,
        'allow_import'
      );
      const run = await backfillExistingLeads(integration, req.apiKey.id);
      res.json({ success: true, run });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/integrations/:id/imports', async (req, res) => {
    try {
      await getAuthorizedIntegration(req.params.id, req.apiKey.id, 'allow_read');
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id FROM crm_import_runs WHERE integration_id = ? ORDER BY created_at DESC LIMIT ?`,
        [req.params.id, limit]
      );
      const runs = [];
      for (const row of rows) runs.push(await getImportRun(row.id, pool));
      res.json({ success: true, runs });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/imports/:runId', async (req, res) => {
    try {
      const run = await getImportRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Import run not found' });
      await getAuthorizedIntegration(run.integrationId, req.apiKey.id, 'allow_read');
      res.json({ success: true, run });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/imports/:runId/conflicts', async (req, res) => {
    try {
      const run = await getImportRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Import run not found' });
      await getAuthorizedIntegration(run.integrationId, req.apiKey.id, 'allow_read');
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id, external_record_id, candidate_lead_id, conflict_type, detail_json,
                status, created_at, resolved_at
         FROM lead_import_conflicts WHERE run_id = ? ORDER BY created_at DESC LIMIT 500`,
        [req.params.runId]
      );
      res.json({
        success: true,
        conflicts: rows.map((row) => ({
          ...row,
          detail: safeParse(row.detail_json),
          detail_json: undefined,
        })),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/integrations/:id/divedeep/contact-links', async (req, res) => {
    try {
      await getAuthorizedIntegration(req.params.id, req.apiKey.id, 'allow_manage_leads');
      const link = await diveDeepCrm.createContactLink({
        customerId: req.body?.customerId,
        integrationId: req.params.id,
        externalContactId: req.body?.externalContactId || req.body?.contactId,
        linkSource: 'api_verified_email_match',
      }, `api-key:${req.apiKey.id}`);
      return res.status(201).json({ success: true, link });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/integrations/:id/divedeep/customers/:customerId/lifecycle', async (req, res) => {
    try {
      await getAuthorizedIntegration(req.params.id, req.apiKey.id, 'allow_manage_leads');
      const links = await diveDeepCrm.listContactLinks({ customerId: req.params.customerId, integrationId: req.params.id, status: 'active', limit: 2 });
      if (!links.length) return res.status(404).json({ error: 'DiveDeep customer is not linked to this integration' });
      const result = await diveDeepCrm.enqueueCustomerLifecycle(
        req.params.customerId,
        req.body?.eventType || 'divedeep.lifecycle.updated',
        { force: req.body?.force === true }
      );
      return res.status(202).json({ success: true, result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sendError(res, error) {
  res.status(error.status || 500).json({ error: error.message || 'CRM operation failed' });
}

function safeJson(value) {
  if (value == null || typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

module.exports = { createCrmRouter };
