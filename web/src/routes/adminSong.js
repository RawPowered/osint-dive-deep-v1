const express = require('express');
const path = require('path');
const { ROOT } = require('../config');
const {
  requireAdminSession,
  requireOwlAccess,
  assertAdminApiKeyScope,
} = require('../middleware/sessionAuth');
const { listTenantLocationIds } = require('../services/adminUsers');
const { listServicePools } = require('../services/servicePools');
const { getPool } = require('../db/pool');
const owl = require('../services/owl');
const song = require('../services/song');

function createAdminSongRouter() {
  const router = express.Router();
  router.use(requireAdminSession);

  router.get('/song', requireOwlAccess, (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'song.html'));
  });

  router.use('/api/song', requireOwlAccess);

  router.get('/api/song/bootstrap', async (req, res) => {
    try {
      const bootstrap = await owl.bootstrapOwl(req.query.apiKeyId || null, req.session.admin);
      const apiKeyId = bootstrap.selectedKey?.id || null;
      let locations = apiKeyId ? await listTenantLocationIds(apiKeyId) : [];
      if (apiKeyId) {
        const context = await owl.resolveContext({ apiKeyId, source:'core' });
        const operational = await owl.listLocations(context);
        locations = [...new Set([...locations, ...operational])].sort();
      }
      const requestedLocation = String(req.query.locationId || '');
      const locationId = locations.includes(requestedLocation) ? requestedLocation : (locations[0] || null);
      const services = locationId
        ? await listServicePools(getPool(), 'core', locationId)
        : [];
      const variableCatalog = apiKeyId && locationId
        ? await song.listVariableCatalog({ apiKeyId, locationId })
        : song.STANDARD_VARIABLE_CATALOG;
      res.json({
        ok:true,
        keys:bootstrap.keys,
        selectedKey:bootstrap.selectedKey,
        access:bootstrap.access,
        locations,
        locationId,
        services:services.filter((item) => item.isEnabled),
        nodeTypes:[...song.NODE_TYPES],
        actionTypes:[...song.ACTION_TYPES],
        defaultVariables:song.DEFAULT_VARIABLES,
        variableCatalog,
      });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/song/scripts', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      res.json({ ok:true, scripts:await song.listScripts({ ...scope, includeArchived:req.query.includeArchived === 'true' }) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/song/imports/vibe/preview', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const imports = buildVibeImports(req.body?.services);
      res.json({ ok:true, scope, imports });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/song/imports/vibe/apply', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const imports = buildVibeImports(req.body?.services);
      const invalid = imports.filter((item) => !item.validation.valid);
      if (invalid.length) {
        throw Object.assign(new Error('Vibe scripts contain SONG validation errors'), {
          status:409, code:'SONG_VIBE_IMPORT_INVALID', details:invalid,
        });
      }
      const policy = String(req.body?.conflictPolicy || 'skip');
      if (!['skip','clone','replace_draft'].includes(policy)) {
        throw Object.assign(new Error('conflictPolicy must be skip, clone, or replace_draft'), {
          status:400, code:'SONG_VIBE_CONFLICT_POLICY_INVALID',
        });
      }
      const existing = await song.listScripts({ ...scope, includeArchived:true });
      const results = [];
      for (const item of imports) {
        const match = existing.find((script) => script.name === item.name
          && script.serviceType === item.serviceType && script.languageCode === item.languageCode);
        if (match && policy === 'skip') {
          results.push({ serviceType:item.serviceType, name:item.name, action:'skipped', scriptId:match.id });
          continue;
        }
        if (match && policy === 'replace_draft') {
          const current = await song.getScript(match.id, scope);
          const saved = await song.saveDraft(match.id, {
            ...scope, expectedRevision:current.draftRevision, name:item.name,
            description:item.description, serviceType:item.serviceType,
            languageCode:item.languageCode, graph:item.graph,
          }, req.session.admin);
          await audit(req, scope, 'song.vibe_import.replace_draft', 'song_script', match.id,
            summarize(saved.before), summarize(saved.after), `Replaced draft from Vibe flow for ${item.serviceType}`);
          results.push({ serviceType:item.serviceType, name:item.name, action:'updated_draft', scriptId:match.id });
          continue;
        }
        const name = match && policy === 'clone' ? uniqueImportName(item.name, existing, results) : item.name;
        const script = await song.createScript({
          ...scope, name, description:item.description, serviceType:item.serviceType,
          languageCode:item.languageCode, graph:item.graph,
        }, req.session.admin);
        await audit(req, scope, 'song.vibe_import.create', 'song_script', script.id,
          null, summarize(script), `Imported Vibe flow for ${item.serviceType}`);
        results.push({ serviceType:item.serviceType, name, action:'created', scriptId:script.id });
      }
      res.status(201).json({ ok:true, conflictPolicy:policy, results });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/song/scripts', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const script = await song.createScript({ ...req.body, ...scope }, req.session.admin);
      await audit(req, scope, 'song.script.create', 'song_script', script.id, null, script, `Created ${script.name}`);
      res.status(201).json({ ok:true, script });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/song/scripts/:id', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      res.json({ ok:true, script:await song.getScript(req.params.id, scope) });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/song/scripts/:id/draft', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const result = await song.saveDraft(req.params.id, { ...req.body, ...scope }, req.session.admin);
      await audit(req, scope, 'song.script.save', 'song_script', req.params.id,
        summarize(result.before), summarize(result.after), `Saved draft revision ${result.after.draftRevision}`);
      res.json({ ok:true, script:result.after, validation:song.validateGraph(result.after.graph) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/song/scripts/:id/validate', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const script = await song.getScript(req.params.id, scope);
      res.json({ ok:true, validation:song.validateGraph(req.body?.graph || script.graph) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/song/scripts/:id/publish', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const before = await song.getScript(req.params.id, scope);
      const result = await song.publishScript(req.params.id, { ...req.body, ...scope }, req.session.admin);
      await audit(req, scope, 'song.script.publish', 'song_script', req.params.id,
        summarize(before), { ...summarize(result.script), version:result.version },
        `Published version ${result.version.number} for ${result.script.serviceType}`);
      res.json({ ok:true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/song/scripts/:id/language', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const before = await song.getScript(req.params.id, scope);
      const result = await song.changeScriptLanguage(
        req.params.id, { ...req.body, ...scope }, req.session.admin
      );
      await audit(req, scope, 'song.script.language_change', 'song_script', req.params.id,
        summarize(before), { ...summarize(result.script), version:result.version },
        result.changed
          ? `Changed script language from ${before.languageCode} to ${result.script.languageCode}`
          : `Script language remains ${result.script.languageCode}`);
      res.json({ ok:true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/song/scripts/:id/clone', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const script = await song.cloneScript(req.params.id, { ...req.body, ...scope }, req.session.admin);
      await audit(req, scope, 'song.script.clone', 'song_script', script.id, null, summarize(script), `Cloned from ${req.params.id}`);
      res.status(201).json({ ok:true, script });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/song/scripts/:id/archive', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const result = await song.archiveScript(req.params.id, scope, req.session.admin);
      await audit(req, scope, 'song.script.archive', 'song_script', req.params.id,
        summarize(result.before), summarize(result.after), 'Archived script and removed active assignment');
      res.json({ ok:true, script:result.after });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/song/scripts/:id/versions', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      res.json({ ok:true, versions:await song.listVersions(req.params.id, scope) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/song/scripts/:id/analytics', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      res.json({ ok:true, ...(await song.getAnalytics(req.params.id, scope)) });
    } catch (error) { sendError(res, error); }
  });

  return router;
}

async function assertScope(req, input) {
  const apiKeyId = String(input.apiKeyId || '').trim();
  const locationId = String(input.locationId || '').trim();
  assertAdminApiKeyScope(req.session.admin, apiKeyId);
  if (!apiKeyId || !locationId) throw Object.assign(new Error('apiKeyId and locationId are required'), { status:400 });
  const allowed = await listTenantLocationIds(apiKeyId);
  if (!allowed.includes(locationId)) {
    const context = await owl.resolveContext({ apiKeyId, source:'core' });
    const operational = await owl.listLocations(context);
    if (!operational.includes(locationId)) {
      throw Object.assign(new Error('Selected location is outside this API-key tenant'), { status:403 });
    }
  }
  return { apiKeyId, locationId };
}

function buildVibeImports(services) {
  if (!Array.isArray(services) || !services.length) {
    throw Object.assign(new Error('services must contain at least one Vibe service definition'), {
      status:400, code:'SONG_VIBE_SERVICES_REQUIRED',
    });
  }
  if (services.length > 50) {
    throw Object.assign(new Error('A Vibe import may contain at most 50 services'), {
      status:413, code:'SONG_VIBE_SERVICE_LIMIT',
    });
  }
  return services.map((service) => {
    const graph = song.vibeServiceToGraph(service);
    const validation = song.validateGraph(graph);
    const serviceType = String(service.serviceType || service.name || '').trim().slice(0, 128);
    return {
      serviceType,
      languageCode:song.normalizeLanguageCode(service.languageCode || service.language || 'en-US'),
      name:String(service.scriptName || `${serviceType} - Vibe Legacy Flow`).trim().slice(0, 191),
      description:String(service.description || `Imported from the VibeDialer static eight-stage flow for ${serviceType}.`).trim().slice(0, 1000),
      graph,
      validation,
    };
  });
}

function uniqueImportName(baseName, existing, results) {
  const used = new Set([...existing.map((item) => item.name), ...results.map((item) => item.name)]);
  let index = 2;
  let value = `${baseName} Import`;
  while (used.has(value)) value = `${baseName} Import ${index++}`;
  return value.slice(0, 191);
}

async function audit(req, scope, action, entityType, entityId, before, after, detail) {
  const context = await owl.resolveContext({ apiKeyId:scope.apiKeyId, source:'core' });
  return owl.recordAudit({
    admin:req.session.admin, context, locationId:scope.locationId,
    action, entityType, entityId, before, after, detail,
  });
}

function summarize(script) {
  if (!script) return null;
  return {
    id:script.id, name:script.name, serviceType:script.serviceType,
    languageCode:script.languageCode, status:script.status,
    draftRevision:script.draftRevision, publishedVersionId:script.publishedVersionId,
    publishedVersionNumber:script.publishedVersionNumber, isAssigned:script.isAssigned,
  };
}

function sendError(res, error) {
  res.status(error.status || 500).json({
    ok:false,
    error:error.message || 'SONG operation failed',
    code:error.code || 'SONG_OPERATION_FAILED',
    details:error.details || undefined,
  });
}

module.exports = { createAdminSongRouter };
