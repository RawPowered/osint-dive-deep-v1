const express = require('express');
const { receiveWebhook } = require('../services/owlWebhooks');
const { newRequestId, recordEvent } = require('../services/sentinel');
const { getInstanceIdentity } = require('../instanceIdentity');

function createOwlWebhookRouter() {
  const router = express.Router();
  router.post('/:publicId', async (req, res) => {
    const started = Date.now();
    const requestId = String(req.get('x-request-id') || newRequestId()).slice(0, 64);
    let status = 200;
    let outcome = 'success';
    let errorClass = null;
    try {
      const result = await receiveWebhook({
        publicId:req.params.publicId,
        headers:req.headers,
        body:req.body,
        rawBody:req.rawBody,
        requestId,
      });
      status = result.outcome === 'inserted' || result.outcome === 'inserted_with_collision' ? 201 : 200;
      res.status(status).json(result);
    } catch (error) {
      status = error.status || 500;
      outcome = 'failure';
      errorClass = error.code || 'OWL_WEBHOOK_FAILED';
      res.status(status).json({ ok:false, ready:false, error:status === 404 ? 'Webhook endpoint not found' : error.message, code:error.code, requestId });
    } finally {
      recordEvent({
        method:req.method,
        path:`${getInstanceIdentity().webhookBasePath}/owl/:endpoint`,
        status_code:status,
        duration_ms:Date.now()-started,
        ip:req.ip,
        user_agent:req.get('user-agent'),
        request_id:requestId,
        surface:'owl',
        actor_type:'webhook',
        action:'owl.webhook.receive',
        entity_type:'owl_webhook_endpoint',
        entity_id:String(req.params.publicId || '').slice(0,12),
        outcome,
        error_class:errorClass,
      });
    }
  });
  return router;
}

module.exports = { createOwlWebhookRouter };
