const express = require('express');
const { getPool } = require('../../db/pool');
const { requireOperatorSession } = require('../../services/operatorSessions');
const { requireLocationGrant } = require('./leads');
const song = require('../../services/song');

function createSongRuntimeRouter() {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  router.get('/runtime', async (req, res) => {
    try {
      const serviceType = String(req.query.serviceType || '').trim();
      if (!serviceType) return res.status(400).json({ error:'serviceType is required', code:'SONG_SERVICE_REQUIRED' });
      const suppliedLocation = String(req.query.locationId || '').trim();
      const operator = await requireOperatorSession(req, { locationId:suppliedLocation || undefined });
      await requireLocationGrant(req.apiKey.id, operator.locationId, 'allow_read', null, { allowLegacyRead:true });
      const runtime = await song.getRuntimeScript({
        apiKeyId:req.apiKey.id,
        locationId:operator.locationId,
        serviceType,
        scriptId:req.query.scriptId,
        languageCode:req.query.languageCode,
      });
      runtime.variableValues = await song.resolveRuntimeVariables({
        variables:runtime.variables,
        leadId:req.query.leadId,
        locationId:operator.locationId,
        operator,
      });
      res.json({ success:true, runtime });
    } catch (error) { sendError(res, error); }
  });

  router.get('/scripts', async (req, res) => {
    try {
      const suppliedLocation = String(req.query.locationId || '').trim();
      const operator = await requireOperatorSession(req, { locationId:suppliedLocation || undefined });
      await requireLocationGrant(req.apiKey.id, operator.locationId, 'allow_read', null, { allowLegacyRead:true });
      const scripts = await song.listRuntimeScripts({
        apiKeyId:req.apiKey.id,
        locationId:operator.locationId,
        serviceType:req.query.serviceType,
        languageCode:req.query.languageCode,
        query:req.query.q,
        limit:req.query.limit,
      });
      res.json({ success:true, scripts });
    } catch (error) { sendError(res, error); }
  });

  router.post('/runtime/resolve', async (req, res) => {
    try {
      const serviceType = String(req.body?.serviceType || '').trim();
      if (!serviceType) return res.status(400).json({ error:'serviceType is required', code:'SONG_SERVICE_REQUIRED' });
      const suppliedLocation = String(req.body?.locationId || '').trim();
      const operator = await requireOperatorSession(req, { locationId:suppliedLocation || undefined });
      await requireLocationGrant(req.apiKey.id, operator.locationId, 'allow_read', null, { allowLegacyRead:true });
      const runtime = await song.getRuntimeScript({
        apiKeyId:req.apiKey.id, locationId:operator.locationId, serviceType,
        scriptId:req.body?.scriptId,
        languageCode:req.body?.languageCode,
      });
      runtime.variableValues = await song.resolveRuntimeVariables({
        variables:runtime.variables,
        leadId:req.body?.leadId,
        locationId:operator.locationId,
        operator,
        runtimeContext:req.body?.runtimeContext,
      });
      res.json({ success:true, runtime });
    } catch (error) { sendError(res, error); }
  });

  router.post('/events', async (req, res) => {
    try {
      const suppliedLocation = String(req.body?.locationId || '').trim();
      const suppliedUser = String(req.body?.userId || '').trim();
      const operator = await requireOperatorSession(req, {
        locationId:suppliedLocation || undefined,
        userId:suppliedUser || undefined,
      });
      await requireLocationGrant(req.apiKey.id, operator.locationId, 'allow_read', null, { allowLegacyRead:true });
      const event = await song.recordRuntimeEvent({
        apiKeyId:req.apiKey.id,
        locationId:operator.locationId,
        operatorUserId:operator.userId,
        scriptId:req.body?.scriptId,
        versionId:req.body?.versionId,
        leadId:req.body?.leadId,
        nodeId:req.body?.nodeId,
        branchId:req.body?.branchId,
        eventType:req.body?.eventType,
        outcome:req.body?.outcome,
        metadata:req.body?.metadata,
      });
      res.status(201).json({ success:true, eventId:event.id });
    } catch (error) { sendError(res, error); }
  });

  return router;
}

function sendError(res, error) {
  res.status(error.status || 500).json({
    success:false,
    error:error.message || 'SONG runtime operation failed',
    code:error.code || 'SONG_RUNTIME_FAILED',
  });
}

module.exports = { createSongRuntimeRouter };
