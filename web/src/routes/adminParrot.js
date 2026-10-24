const express = require('express');
const path = require('path');
const { ROOT, getParrotConfig } = require('../config');
const { requireAdminSession, requireOwlAccess, assertAdminApiKeyScope } = require('../middleware/sessionAuth');
const { listTenantLocationIds } = require('../services/adminUsers');
const owl = require('../services/owl');
const parrot = require('../services/parrot');
const studio = require('../services/parrotStudio');
const hawk = require('../services/hawk');

function createAdminParrotRouter() {
  const router = express.Router();
  router.use(requireAdminSession);

  router.get('/parrot', requireOwlAccess, (_req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'parrot.html'));
  });

  router.use('/api/parrot', requireOwlAccess);

  router.get('/api/parrot/bootstrap', async (req, res) => {
    try {
      const context = await resolveBootstrapContext(req);
      const config = getParrotConfig();
      let health = null, healthError = null, catalog = { scripts:[] }, catalogError = null, runs = [], studioScripts = [];
      if (config.enabled) {
        try { health = await parrot.checkHealth(); } catch (error) { healthError = error.message; }
        try { catalog = await parrot.getCatalog(); } catch (error) { catalogError = error.message; }
      }
      if (context.scope) {
        runs = await parrot.listRuns(context.scope, { limit:100 });
        studioScripts = await studio.listScripts(context.scope);
        const managedCatalog = await studio.listCatalog(context.scope);
        catalog = { ...catalog, scripts:[...(catalog.scripts || []), ...managedCatalog] };
      }
      res.json({
        ok:true,
        ...context.public,
        parrot:{ enabled:config.enabled, reason:config.error || null, health, healthError, catalog, catalogError },
        runs,
        studioScripts,
        contractVersion:parrot.CONTRACT_VERSION,
      });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/parrot/health', async (req, res) => {
    try {
      const health = await parrot.checkHealth();
      req.sentinelControl = { action:'parrot.health.read', entityType:'parrot_service', entityId:'parrot' };
      res.json({ ok:true, health });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/parrot/catalog', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const catalog = await parrot.getCatalog();
      catalog.scripts = [...(catalog.scripts || []), ...await studio.listCatalog(scope)];
      req.sentinelControl = { action:'parrot.catalog.read', entityType:'parrot_catalog', entityId:'registered_scripts' };
      res.json({ ok:true, catalog });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/parrot/scripts/validate', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const validation = await parrot.validateSource(req.body || {});
      setControl(req, scope, 'parrot.script.validate', 'parrot_script', req.body?.slug || null);
      res.json({ ok:true, validation });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/parrot/imports/schema', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const catalog = await hawk.listFieldCatalog(scope);
      setControl(req, scope, 'parrot.import.schema', 'parrot_import', 'live_crm_fields');
      res.setHeader('Content-Disposition', 'attachment; filename="parrot-live-python.schema.json"');
      res.json(studio.buildImportSchema(catalog));
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/parrot/imports/preview', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const scripts = await studio.previewImportPackage(req.body?.scriptPackage);
      setControl(req, scope, 'parrot.import.preview', 'parrot_import', 'preview');
      res.json({ ok:true, scripts });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/parrot/imports/apply', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const scripts = await studio.previewImportPackage(req.body?.scriptPackage);
      const invalid = scripts.filter((item) => item.validation?.valid !== true);
      if (invalid.length) throw Object.assign(new Error('PARROT import contains validation errors'), {
        status:409, code:'PARROT_IMPORT_INVALID', details:invalid,
      });
      const policy = String(req.body?.conflictPolicy || 'skip');
      if (!['skip','clone','replace_draft'].includes(policy)) {
        throw Object.assign(new Error('conflictPolicy must be skip, clone, or replace_draft'), {
          status:400, code:'PARROT_IMPORT_POLICY_INVALID',
        });
      }
      const existing = await studio.listScripts(scope);
      const occupied = new Set(existing.map((item) => item.slug));
      const results = [];
      for (const item of scripts) {
        const match = existing.find((script) => script.slug === item.slug);
        if (match && policy === 'skip') {
          results.push({ name:item.name, slug:item.slug, action:'skipped', scriptId:match.id });
          continue;
        }
        if (match && policy === 'replace_draft') {
          const script = await studio.saveDraft(match.id, { ...item, ...scope }, req.session.admin);
          results.push({ name:script.name, slug:script.slug, action:'replaced_draft', scriptId:script.id, version:script.latestVersion });
          continue;
        }
        const identity = match ? studio.uniqueImportIdentity(item, occupied) : { name:item.name, slug:item.slug };
        occupied.add(identity.slug);
        const script = await studio.createScript({ ...item, ...identity, ...scope }, req.session.admin);
        results.push({ name:script.name, slug:script.slug, action:match ? 'cloned' : 'created', scriptId:script.id, version:script.latestVersion });
      }
      setControl(req, scope, 'parrot.import.apply', 'parrot_import', 'batch');
      res.status(201).json({ ok:true, results });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/parrot/scripts', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      setControl(req, scope, 'parrot.script.list', 'parrot_script', null);
      res.json({ ok:true, scripts:await studio.listScripts(scope) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/parrot/scripts', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const script = await studio.createScript({ ...req.body, ...scope }, req.session.admin);
      setControl(req, scope, 'parrot.script.create', 'parrot_script', script.id);
      res.status(201).json({ ok:true, script });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/parrot/scripts/:id/export', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const script = await studio.getScript(req.params.id, scope);
      const scriptPackage = studio.buildExportPackage(script);
      const filename = `${script.slug.replace(/[^a-z0-9_.-]/gi, '-')}.json`;
      setControl(req, scope, 'parrot.script.export', 'parrot_script', script.id);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.json(scriptPackage);
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/parrot/scripts/:id', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const script = await studio.getScript(req.params.id, scope);
      setControl(req, scope, 'parrot.script.read', 'parrot_script', script.id);
      res.json({ ok:true, script });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/parrot/scripts/:id', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const script = await studio.saveDraft(req.params.id, { ...req.body, ...scope }, req.session.admin);
      setControl(req, scope, 'parrot.script.version.create', 'parrot_script', script.id);
      res.json({ ok:true, script });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/parrot/scripts/:id/dry-run', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const run = await studio.dryRunScript(req.params.id, { ...req.body, ...scope, requestId:req.sentinelRequestId }, req.session.admin);
      setControl(req, scope, 'parrot.script.dry_run', 'parrot_script', req.params.id);
      res.json({ ok:true, run });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/parrot/scripts/:id/deploy', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const script = await studio.deployScript(req.params.id, { ...req.body, ...scope }, req.session.admin);
      setControl(req, scope, 'parrot.script.deploy', 'parrot_script', script.id);
      res.json({ ok:true, script });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/parrot/scripts/:id/retire', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const script = await studio.retireScript(req.params.id, { ...req.body, ...scope }, req.session.admin);
      setControl(req, scope, 'parrot.script.retire', 'parrot_script', script.id);
      res.json({ ok:true, script });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/parrot/runs', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      setControl(req, scope, 'parrot.run.list', 'parrot_run', null);
      res.json({ ok:true, runs:await parrot.listRuns(scope, req.query) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/parrot/runs/:id', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      setControl(req, scope, 'parrot.run.read', 'parrot_run', req.params.id);
      res.json({ ok:true, run:await parrot.getRun(req.params.id, scope) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/parrot/runs', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const mode = req.body?.mode === 'live' ? 'live' : 'dry_run';
      if (mode === 'live' && req.body?.confirmLive !== true) {
        throw Object.assign(new Error('Live PARROT runs require explicit confirmation'), {
          status:409, code:'PARROT_LIVE_CONFIRMATION_REQUIRED',
        });
      }
      const managed = String(req.body?.scriptId || '').startsWith('custom.')
        ? await studio.resolveDeployedPackage(scope, req.body?.scriptId, req.body?.scriptVersion)
        : null;
      if (String(req.body?.scriptId || '').startsWith('custom.') && !managed) {
        throw Object.assign(new Error('Managed PARROT script is not deployed'), { status:409, code:'PARROT_SCRIPT_NOT_DEPLOYED' });
      }
      const run = await parrot.runScript({
        ...req.body,
        ...scope,
        source:'admin',
        mode,
        ...(managed || {}),
      }, {
        requestId:req.sentinelRequestId,
        actorType:req.session.admin?.principalType || req.session.admin?.role || 'admin',
        actorId:req.session.admin?.id || null,
      });
      setControl(req, scope, 'parrot.run.create', 'parrot_run', run.id);
      res.status(201).json({ ok:true, run });
    } catch (error) { sendError(res, error); }
  });

  return router;
}

async function resolveBootstrapContext(req) {
  const bootstrap = await owl.bootstrapOwl(req.query.apiKeyId || null, req.session.admin);
  const apiKeyId = bootstrap.selectedKey?.id || null;
  const requestedSource = String(req.query.dataSourceSlug || req.query.source || '');
  const selectedSource = bootstrap.sources.find((item) => item.slug === requestedSource)
    || bootstrap.sources.find((item) => item.type === 'sql-connection')
    || bootstrap.sources.find((item) => item.slug === 'core') || null;
  const integrationLocations = apiKeyId ? await listTenantLocationIds(apiKeyId) : [];
  let databaseLocations = [], databaseError = null;
  if (apiKeyId) {
    try {
      const sourceContext = await owl.resolveContext({ apiKeyId, source:selectedSource?.slug || 'core' });
      databaseLocations = await owl.listLocations(sourceContext);
    } catch (error) { databaseError = error.message || 'Selected database could not be queried'; }
  }
  const locationContexts = owl.buildLocationContexts(databaseLocations, integrationLocations);
  const locations = locationContexts.map((item) => item.locationId);
  const requested = String(req.query.locationId || '');
  const locationId = locations.includes(requested) ? requested : (locations[0] || null);
  const dataSourceSlug = selectedSource?.slug || 'core';
  return {
    scope:apiKeyId && locationId ? { apiKeyId, locationId, dataSourceSlug } : null,
    public:{
      keys:bootstrap.keys, selectedKey:bootstrap.selectedKey, access:bootstrap.access,
      dataSources:bootstrap.sources, dataSourceSlug,
      databaseStatus:{ connected:!databaseError, error:databaseError },
      locations, locationContexts, locationId,
    },
  };
}

async function assertScope(req, input) {
  const apiKeyId = String(input.apiKeyId || '').trim();
  const locationId = String(input.locationId || '').trim();
  const dataSourceSlug = String(input.dataSourceSlug || input.sourceSlug || 'core').trim().toLowerCase();
  assertAdminApiKeyScope(req.session.admin, apiKeyId);
  if (!apiKeyId || !locationId) throw Object.assign(new Error('apiKeyId and locationId are required'), { status:400, code:'PARROT_SCOPE_REQUIRED' });
  const context = await owl.resolveContext({ apiKeyId, source:dataSourceSlug });
  const granted = await listTenantLocationIds(apiKeyId);
  let operational = [];
  try { operational = await owl.listLocations(context); } catch {}
  const allowed = owl.buildLocationContexts(operational, granted).map((item) => item.locationId);
  if (!allowed.includes(locationId)) throw Object.assign(new Error('Selected location is outside this workspace'), { status:403, code:'PARROT_SCOPE_DENIED' });
  return { apiKeyId, locationId, dataSourceSlug };
}

function setControl(req, scope, action, entityType, entityId) {
  req.sentinelControl = { apiKeyId:scope.apiKeyId, locationId:scope.locationId, action, entityType, entityId };
}

function sendError(res, error) {
  res.status(error.status || 500).json({
    ok:false,
    error:error.message || 'PARROT operation failed',
    code:error.code || 'PARROT_OPERATION_FAILED',
    details:error.details || undefined,
  });
}

module.exports = { createAdminParrotRouter };
