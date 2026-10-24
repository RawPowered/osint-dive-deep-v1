const express = require('express');
const crm = require('../services/diveDeepCrmIntegration');
const { newRequestId, recordEvent } = require('../services/sentinel');
const { getInstanceIdentity } = require('../instanceIdentity');

function createCrmWebhookRouter(dependencies = {}) {
  const service = { ...crm, ...(dependencies.service || {}) };
  const router = express.Router();

  router.post('/:publicId', async (req, res) => {
    const started = Date.now();
    const requestId = String(req.get('x-request-id') || newRequestId()).slice(0, 64);
    let status = 202;
    let outcome = 'success';
    let errorClass = null;
    try {
      const result = await service.acceptInboundWebhook({
        publicId: req.params.publicId,
        headers: req.headers,
        body: req.body,
        rawBody: req.rawBody,
        requestId,
      });
      return res.status(202).json({ ok: true, accepted: true, duplicate: result.duplicate, eventId: result.eventId, requestId });
    } catch (error) {
      status = error.status || 500;
      outcome = 'failure';
      errorClass = error.code || 'DIVEDEEP_CRM_WEBHOOK_FAILED';
      return res.status(status).json({
        ok: false,
        error: status === 404 ? 'Webhook endpoint not found' : error.message,
        code: errorClass,
        requestId,
      });
    } finally {
      recordEvent({
        method: req.method,
        path: `${getInstanceIdentity().webhookBasePath}/crm/:endpoint`,
        status_code: status,
        duration_ms: Date.now() - started,
        ip: req.ip,
        user_agent: req.get('user-agent'),
        request_id: requestId,
        surface: 'divedeep',
        actor_type: 'webhook',
        action: 'divedeep.crm.webhook.receive',
        entity_type: 'divedeep_crm_webhook_endpoint',
        entity_id: String(req.params.publicId || '').slice(0, 12),
        outcome,
        error_class: errorClass,
      });
    }
  });

  return router;
}

module.exports = { createCrmWebhookRouter };
