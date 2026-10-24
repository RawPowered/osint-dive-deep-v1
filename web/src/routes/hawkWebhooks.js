const express = require('express');
const { acceptWebhook, dispatchWebhook } = require('../services/hawkWebhooks');
const { newRequestId, recordEvent } = require('../services/sentinel');
const { getInstanceIdentity } = require('../instanceIdentity');

function createHawkWebhookRouter() {
  const router = express.Router();

  router.post('/:publicId', async (req, res) => {
    const started = Date.now();
    const requestId = String(req.get('x-request-id') || newRequestId()).slice(0, 64);
    let status = 202;
    let outcome = 'success';
    let errorClass = null;
    try {
      const result = await acceptWebhook({
        publicId:req.params.publicId,
        headers:req.headers,
        body:req.body,
        rawBody:req.rawBody,
        requestId,
      });
      if (result.dispatch) {
        setImmediate(() => dispatchWebhook(result.dispatch).catch((error) => {
          console.error('[hawk] webhook dispatch failed', error.code || error.message);
        }));
      }
      res.status(202).json({ ok:true, accepted:true, duplicate:result.duplicate, requestId });
    } catch (error) {
      status = error.status === 202 ? 202 : (error.status || 500);
      outcome = status === 202 ? 'success' : 'failure';
      errorClass = error.code || 'HAWK_WEBHOOK_FAILED';
      if (status === 202) res.status(202).json({
        ok:true,
        accepted:false,
        ignored:true,
        reason:error.message,
        code:error.code,
        requestId,
      });
      else res.status(status).json({ ok:false, error:status === 404 ? 'Webhook endpoint not found' : error.message, code:error.code, requestId });
    } finally {
      recordEvent({
        method:req.method,
        path:`${getInstanceIdentity().webhookBasePath}/hawk/:endpoint`,
        status_code:status,
        duration_ms:Date.now() - started,
        ip:req.ip,
        user_agent:req.get('user-agent'),
        request_id:requestId,
        surface:'hawk',
        actor_type:'webhook',
        action:'hawk.webhook.receive',
        entity_type:'hawk_webhook_endpoint',
        entity_id:String(req.params.publicId || '').slice(0, 12),
        outcome,
        error_class:errorClass,
      });
    }
  });

  return router;
}

module.exports = { createHawkWebhookRouter };
