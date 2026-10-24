const express = require('express');
const path = require('path');
const { ROOT } = require('../config');
const { requireAdminSession, requireOwlAccess, assertAdminApiKeyScope } = require('../middleware/sessionAuth');
const { listTenantLocationIds } = require('../services/adminUsers');
const owl = require('../services/owl');
const hawk = require('../services/hawk');
const hawkWebhooks = require('../services/hawkWebhooks');
const parrot = require('../services/parrot');
const parrotStudio = require('../services/parrotStudio');
const { getParrotConfig } = require('../config');
const { getInstanceIdentity } = require('../instanceIdentity');

function createAdminHawkRouter() {
  const router = express.Router();
  router.use(requireAdminSession);

  router.get('/hawk', requireOwlAccess, (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'hawk.html'));
  });

  router.use('/api/hawk', requireOwlAccess);

  router.get('/api/hawk/bootstrap', async (req, res) => {
    try {
      const bootstrap = await owl.bootstrapOwl(req.query.apiKeyId || null, req.session.admin);
      const apiKeyId = bootstrap.selectedKey?.id || null;
      const requestedSource = String(req.query.dataSourceSlug || req.query.source || '');
      const selectedSource = bootstrap.sources.find((item) => item.slug === requestedSource)
        || bootstrap.sources.find((item) => item.type === 'sql-connection')
        || bootstrap.sources.find((item) => item.slug === 'core') || null;
      const integrationLocations = apiKeyId ? await listTenantLocationIds(apiKeyId) : [];
      let databaseLocations = [];
      let databaseError = null;
      if (apiKeyId) {
        try {
          const context = await owl.resolveContext({ apiKeyId, source:selectedSource?.slug || 'core' });
          databaseLocations = await owl.listLocations(context);
        } catch (error) { databaseError = error.message || 'Selected database could not be queried'; }
      }
      const locationContexts = owl.buildLocationContexts(databaseLocations, integrationLocations);
      const locations = locationContexts.map((item) => item.locationId);
      const requested = String(req.query.locationId || '');
      const locationId = locations.includes(requested) ? requested : (locations[0] || null);
      const connections = apiKeyId && locationId
        ? await hawk.listConnections({ apiKeyId, locationId })
        : [];
      const requestedIntegrationId = String(req.query.integrationId || '');
      const integrationId = connections.some((item) => item.id === requestedIntegrationId)
        ? requestedIntegrationId
        : (connections[0]?.id || null);
      const fieldCatalog = apiKeyId && locationId
        ? await hawk.listFieldCatalog({ apiKeyId, locationId, integrationId })
        : { fields: hawk.STANDARD_FIELD_CATALOG, objects: [], total: hawk.STANDARD_FIELD_CATALOG.length };
      const parrotConfig = getParrotConfig();
      let parrotCatalog = { scripts:[] }, parrotError = null;
      if (parrotConfig.enabled) {
        try {
          parrotCatalog = await parrot.getCatalog();
          if (apiKeyId && selectedSource?.slug) {
            parrotCatalog.scripts = [
              ...(parrotCatalog.scripts || []),
              ...await parrotStudio.listCatalog({ apiKeyId, dataSourceSlug:selectedSource.slug }),
            ];
          }
        }
        catch (error) { parrotError = error.message || 'PARROT catalog unavailable'; }
      }
      const actionDefinitions = hawk.ACTION_DEFINITIONS.map((definition) => {
        if (definition.id !== 'parrot.run') return definition;
        return {
          ...definition,
          ready:parrotConfig.enabled && !parrotError,
          fields:definition.fields.map((field) => field.key === 'scriptId'
            ? { ...field, options:parrotCatalog.scripts.map((script) => script.id) }
            : field),
        };
      });
      res.json({
        ok: true,
        keys: bootstrap.keys,
        selectedKey: bootstrap.selectedKey,
        access: bootstrap.access,
        dataSources:bootstrap.sources,
        dataSourceSlug:selectedSource?.slug || null,
        databaseStatus:{ connected:!databaseError, error:databaseError },
        locations,
        locationContexts,
        locationId,
        connections,
        fieldCatalog,
        codeRunner: { enabled: hawk.getCodeRunnerConfig().enabled },
        parrotRunner:{ enabled:parrotConfig.enabled, error:parrotError || parrotConfig.error || null, scripts:parrotCatalog.scripts },
        nodeTypes: hawk.NODE_TYPES,
        actionTypes: hawk.ACTION_TYPES,
        actionDefinitions,
        triggerTypes: hawk.TRIGGER_TYPES,
        triggerDefinitions: hawk.TRIGGER_DEFINITIONS,
        conditionOperators: hawk.CONDITION_OPERATORS,
        replayDefaults: { dryRun: true, liveRequiresConfirmation: true },
      });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/catalog', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const catalog = await hawk.listFieldCatalog({ ...scope, integrationId: req.query.integrationId || null });
      res.json({ ok: true, catalog });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/catalog/refresh', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const result = await hawk.refreshFieldCatalog({ ...scope, integrationId: req.body?.integrationId });
      setControl(req, scope, 'hawk.catalog.refresh', 'crm_integration', req.body?.integrationId);
      await audit(req, scope, 'hawk.catalog.refresh', 'crm_integration', req.body?.integrationId,
        null, { total: result.catalog.total, customFields: result.sync.total, objects: result.sync.objects?.total || 0,
          objectFields: result.sync.objects?.fields || 0 }, 'Refreshed live GoHighLevel object and custom-field catalog');
      res.json({ ok: true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/test-records', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const result = await hawk.searchTestRecords({ ...req.query, ...scope });
      res.json({ ok:true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/imports/schema', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const catalog = await hawk.listFieldCatalog({ ...scope, integrationId: req.query.integrationId || null });
      const schema = hawk.buildImportSchema(catalog);
      res.setHeader('Content-Disposition', 'attachment; filename="hawk-live-automation.schema.json"');
      res.json(schema);
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/imports/preview', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const integrationId = req.body?.integrationId || null;
      const catalog = await hawk.listFieldCatalog({ ...scope, integrationId });
      const imports = hawk.buildImportPreview(req.body?.automationPackage, catalog);
      setControl(req, scope, 'hawk.import.preview', 'hawk_import', 'preview');
      res.json({ ok: true, imports, catalog: { total: catalog.total, lastSeenAt: catalog.lastSeenAt } });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/imports/apply', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const defaultIntegrationId = req.body?.integrationId || null;
      const folderId = req.body?.folderId || null;
      const color = req.body?.color || null;
      const catalog = await hawk.listFieldCatalog({ ...scope, integrationId: defaultIntegrationId });
      const imports = hawk.buildImportPreview(req.body?.automationPackage, catalog);
      const invalid = imports.filter((item) => !item.validation.valid);
      if (invalid.length) throw Object.assign(new Error('HAWK import contains validation errors'), {
        status: 409, code: 'HAWK_IMPORT_INVALID', details: invalid,
      });
      const policy = String(req.body?.conflictPolicy || 'skip');
      if (!['skip', 'clone', 'replace_draft'].includes(policy)) {
        throw Object.assign(new Error('conflictPolicy must be skip, clone, or replace_draft'), { status: 400, code: 'HAWK_IMPORT_POLICY_INVALID' });
      }
      const existing = await hawk.listFlows(scope);
      const results = [];
      for (const item of imports) {
        if (item.integrationId && item.integrationId !== defaultIntegrationId) {
          throw Object.assign(new Error('Imported integrationId must match the selected granted connection'), {
            status: 409, code: 'HAWK_IMPORT_CONNECTION_MISMATCH',
          });
        }
        const match = existing.find((flow) => flow.name === item.name);
        if (match && policy === 'skip') {
          results.push({ name: item.name, action: 'skipped', flowId: match.id });
          continue;
        }
        const integrationId = item.integrationId || defaultIntegrationId;
        if (match && policy === 'replace_draft') {
          const current = await hawk.getFlow(match.id, scope);
          const saved = await hawk.saveDraft(match.id, {
            ...scope, expectedRevision: current.draftRevision, name: item.name,
            description: item.description, integrationId, graph: item.graph,
          }, req.session.admin);
          if (folderId || color) await hawk.updateFlowOrganization(match.id, { ...scope, folderId, color }, req.session.admin);
          await audit(req, scope, 'hawk.import.replace_draft', 'hawk_flow', match.id,
            summarizeFlow(saved.before), summarizeFlow(saved.after), `Replaced draft from HAWK JSON import: ${item.name}`);
          results.push({ name: item.name, action: 'updated_draft', flowId: match.id });
          continue;
        }
        const name = match && policy === 'clone' ? uniqueImportName(item.name, existing, results) : item.name;
        const flow = await hawk.createFlow({ ...scope, name, description: item.description, integrationId, folderId, color, graph: item.graph }, req.session.admin);
        await audit(req, scope, 'hawk.import.create', 'hawk_flow', flow.id, null, summarizeFlow(flow), `Created draft from HAWK JSON import: ${name}`);
        results.push({ name, action: 'created', flowId: flow.id });
      }
      setControl(req, scope, 'hawk.import.apply', 'hawk_import', 'batch');
      res.status(201).json({ ok: true, conflictPolicy: policy, results });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/folders', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      res.json({ ok: true, folders: await hawk.listFlowFolders(scope) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/folders', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const folder = await hawk.createFlowFolder({ ...req.body, ...scope }, req.session.admin);
      setControl(req, scope, 'hawk.folder.create', 'hawk_flow_folder', folder.id);
      await audit(req, scope, 'hawk.folder.create', 'hawk_flow_folder', folder.id, null, folder, `Created flow folder ${folder.name}`);
      res.status(201).json({ ok: true, folder });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/hawk/folders/:id', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const before = (await hawk.listFlowFolders(scope)).find((item) => item.id === req.params.id) || null;
      const folder = await hawk.updateFlowFolder(req.params.id, { ...req.body, ...scope }, req.session.admin);
      setControl(req, scope, 'hawk.folder.update', 'hawk_flow_folder', folder.id);
      await audit(req, scope, 'hawk.folder.update', 'hawk_flow_folder', folder.id, before, folder, `Updated flow folder ${folder.name}`);
      res.json({ ok: true, folder });
    } catch (error) { sendError(res, error); }
  });

  router.delete('/api/hawk/folders/:id', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const folder = await hawk.deleteFlowFolder(req.params.id, scope, req.session.admin);
      setControl(req, scope, 'hawk.folder.delete', 'hawk_flow_folder', req.params.id);
      await audit(req, scope, 'hawk.folder.delete', 'hawk_flow_folder', req.params.id, folder, null, `Removed flow folder ${folder.name}; flows moved to Unfiled`);
      res.json({ ok: true, folder });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/flows', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      res.json({ ok: true, flows: await hawk.listFlows(scope, null, { includeArchived: req.query.includeArchived === 'true' }) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/flows', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const flow = await hawk.createFlow({ ...req.body, ...scope }, req.session.admin);
      setControl(req, scope, 'hawk.flow.create', 'hawk_flow', flow.id);
      await audit(req, scope, 'hawk.flow.create', 'hawk_flow', flow.id, null, summarizeFlow(flow), `Created ${flow.name}`);
      res.status(201).json({ ok: true, flow, validation: hawk.validateGraph(flow.graph) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/flows/:id', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      res.json({ ok: true, flow: await hawk.getFlow(req.params.id, scope) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/flows/:id/export', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const flow = await hawk.getFlow(req.params.id, scope);
      const automationPackage = hawk.buildExportPackage(flow);
      const filename = `${String(flow.name || 'hawk-flow').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'hawk-flow'}.json`;
      setControl(req, scope, 'hawk.flow.export', 'hawk_flow', flow.id);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.json(automationPackage);
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/hawk/flows/:id/source', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const current = await hawk.getFlow(req.params.id, scope);
      const automationPackage = req.body?.automationPackage;
      const sourceFlowId = String(automationPackage?.generatedFor?.flowId || '').trim();
      if (sourceFlowId && sourceFlowId !== current.id) {
        throw Object.assign(new Error('This JSON was exported from a different flow'), {
          status: 409, code: 'HAWK_SOURCE_FLOW_MISMATCH',
        });
      }
      const catalog = await hawk.listFieldCatalog({ ...scope, integrationId: current.integrationId || null });
      const imports = hawk.buildImportPreview(automationPackage, catalog);
      if (imports.length !== 1) {
        throw Object.assign(new Error('Flow Code accepts exactly one automation'), {
          status: 400, code: 'HAWK_SOURCE_FLOW_COUNT_INVALID',
        });
      }
      const item = imports[0];
      if (!item.validation.valid) {
        throw Object.assign(new Error('Flow Code contains validation errors'), {
          status: 409, code: 'HAWK_IMPORT_INVALID', details: item.validation,
        });
      }
      if (item.integrationId && item.integrationId !== current.integrationId) {
        throw Object.assign(new Error('Flow Code cannot change the granted GoHighLevel connection'), {
          status: 409, code: 'HAWK_SOURCE_CONNECTION_MISMATCH',
        });
      }
      const saved = await hawk.saveDraft(req.params.id, {
        ...scope,
        expectedRevision: req.body?.expectedRevision,
        name: item.name,
        description: item.description,
        integrationId: current.integrationId,
        graph: item.graph,
      }, req.session.admin);
      setControl(req, scope, 'hawk.flow.source.update', 'hawk_flow', req.params.id);
      await audit(req, scope, 'hawk.flow.source.update', 'hawk_flow', req.params.id,
        summarizeFlow(saved.before), summarizeFlow(saved.after), `Updated draft revision ${saved.after.draftRevision} from Flow Code`);
      res.json({
        ok: true,
        flow: saved.after,
        validation: saved.validation,
        automationPackage: hawk.buildExportPackage(saved.after),
      });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/hawk/flows/:id/draft', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const result = await hawk.saveDraft(req.params.id, { ...req.body, ...scope }, req.session.admin);
      setControl(req, scope, 'hawk.flow.save', 'hawk_flow', req.params.id);
      await audit(req, scope, 'hawk.flow.save', 'hawk_flow', req.params.id,
        summarizeFlow(result.before), summarizeFlow(result.after), `Saved draft revision ${result.after.draftRevision}`);
      res.json({ ok: true, flow: result.after, validation: result.validation });
    } catch (error) { sendError(res, error); }
  });

  router.put('/api/hawk/flows/:id/organization', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const result = await hawk.updateFlowOrganization(req.params.id, { ...req.body, ...scope }, req.session.admin);
      setControl(req, scope, 'hawk.flow.organize', 'hawk_flow', req.params.id);
      await audit(req, scope, 'hawk.flow.organize', 'hawk_flow', req.params.id,
        summarizeFlow(result.before), summarizeFlow(result.after), `Organized ${result.after.name}`);
      res.json({ ok: true, flow: result.after });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/flows/:id/archive', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const archived = req.body?.archived !== false;
      const result = await hawk.setFlowArchived(req.params.id, scope, archived, req.session.admin);
      setControl(req, scope, archived ? 'hawk.flow.archive' : 'hawk.flow.restore', 'hawk_flow', req.params.id);
      await audit(req, scope, archived ? 'hawk.flow.archive' : 'hawk.flow.restore', 'hawk_flow', req.params.id,
        summarizeFlow(result.before), summarizeFlow(result.after), archived ? 'Archived flow' : 'Restored flow');
      res.json({ ok: true, flow: result.after });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/flows/:id/validate', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const flow = await hawk.getFlow(req.params.id, scope);
      const validation = hawk.validateGraph(req.body?.graph || flow.graph);
      setControl(req, scope, 'hawk.flow.validate', 'hawk_flow', req.params.id);
      res.status(validation.valid ? 200 : 409).json({ ok: validation.valid, validation });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/flows/:id/publish', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const before = await hawk.getFlow(req.params.id, scope);
      const result = await hawk.publishFlow(req.params.id, scope, req.session.admin);
      setControl(req, scope, 'hawk.flow.publish', 'hawk_flow', req.params.id);
      await audit(req, scope, 'hawk.flow.publish', 'hawk_flow', req.params.id,
        summarizeFlow(before), { ...summarizeFlow(result.flow), version: result.version },
        `Published version ${result.version.number}`);
      res.json({ ok: true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/flows/:id/state', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const result = await hawk.setFlowState(req.params.id, scope, req.body?.state, req.session.admin);
      setControl(req, scope, `hawk.flow.${req.body?.state}`, 'hawk_flow', req.params.id);
      await audit(req, scope, `hawk.flow.${req.body?.state}`, 'hawk_flow', req.params.id,
        summarizeFlow(result.before), summarizeFlow(result.after), `Flow ${result.after.status}`);
      res.json({ ok: true, flow: result.after });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/flows/:id/webhook', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const endpoint = await hawkWebhooks.getFlowWebhook(req.params.id, scope);
      res.json({ ok:true, endpoint:endpoint ? withWebhookUrl(req, endpoint) : null });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/flows/:id/webhook', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const before = await hawkWebhooks.getFlowWebhook(req.params.id, scope);
      const result = await hawkWebhooks.provisionFlowWebhook(
        req.params.id, scope, req.session.admin, { rotate:req.body?.rotate === true }
      );
      const endpoint = withWebhookUrl(req, result.endpoint);
      setControl(req, scope, result.rotated ? 'hawk.webhook.rotate' : 'hawk.webhook.provision', 'hawk_webhook_endpoint', endpoint.id);
      await audit(req, scope, result.rotated ? 'hawk.webhook.rotate' : 'hawk.webhook.provision', 'hawk_webhook_endpoint', endpoint.id,
        before, endpoint, result.rotated ? 'Rotated HAWK webhook signing secret' : 'Provisioned HAWK webhook endpoint');
      res.status(result.secret ? 201 : 200).json({ ok:true, endpoint, secret:result.secret, rotated:result.rotated });
    } catch (error) { sendError(res, error); }
  });

  router.delete('/api/hawk/flows/:id/webhook', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      const before = await hawkWebhooks.getFlowWebhook(req.params.id, scope);
      const endpoint = await hawkWebhooks.disableFlowWebhook(req.params.id, scope, req.session.admin);
      setControl(req, scope, 'hawk.webhook.disable', 'hawk_webhook_endpoint', endpoint?.id || req.params.id);
      await audit(req, scope, 'hawk.webhook.disable', 'hawk_webhook_endpoint', endpoint?.id || req.params.id,
        before, endpoint, 'Disabled HAWK webhook endpoint');
      res.json({ ok:true, endpoint:endpoint ? withWebhookUrl(req, endpoint) : null });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/flows/:id/versions', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      res.json({ ok: true, versions: await hawk.listVersions(req.params.id, scope) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/flows/:id/test', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const execution = await hawk.executeFlow(req.params.id, scope, req.body?.input || {}, {
        dryRun: true,
        useDraft: true,
        requestId: req.sentinelRequestId,
      }, req.session.admin);
      setControl(req, scope, 'hawk.execution.test', 'hawk_execution', execution.id);
      await audit(req, scope, 'hawk.execution.test', 'hawk_execution', execution.id,
        null, summarizeExecution(execution), `Dry-run ${execution.status} for ${execution.flowName}`);
      res.status(201).json({ ok: true, execution });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/flows/:id/webhook-sample', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      if (req.body?.confirmSend !== true) {
        throw Object.assign(new Error('Live webhook sample requires explicit confirmation'), {
          status:400, code:'HAWK_WEBHOOK_SAMPLE_CONFIRMATION_REQUIRED',
        });
      }
      const flow = await hawk.getFlow(req.params.id, scope);
      const nodeId = String(req.body?.nodeId || '').trim();
      const node = flow.graph?.nodes?.find((item) => item.id === nodeId);
      if (!node || node.type !== 'action' || node.action !== 'webhook.send') {
        throw Object.assign(new Error('Selected draft step is not a Send Webhook action'), {
          status:409, code:'HAWK_WEBHOOK_SAMPLE_NODE_INVALID',
        });
      }
      const config = req.body?.config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw Object.assign(new Error('Webhook sample configuration is required'), {
          status:400, code:'HAWK_WEBHOOK_SAMPLE_CONFIG_REQUIRED',
        });
      }
      const result = await hawk.runOutboundWebhook(config);
      setControl(req, scope, 'hawk.webhook.sample.send', 'hawk_flow', flow.id);
      await audit(req, scope, 'hawk.webhook.sample.send', 'hawk_flow', flow.id,
        null, { nodeId, status:result.status }, `Sent one live webhook mapping sample from ${node.name || node.id}`);
      res.status(201).json({ ok:true, nodeId, result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/flows/:id/execute', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const execution = await hawk.executeFlow(req.params.id, scope, req.body?.input || {}, {
        dryRun: false,
        confirmLive: req.body?.confirmLive === true,
        useDraft: false,
        idempotencyKey: req.body?.idempotencyKey,
        requestId: req.sentinelRequestId,
      }, req.session.admin);
      setControl(req, scope, 'hawk.execution.live', 'hawk_execution', execution.id);
      await audit(req, scope, 'hawk.execution.live', 'hawk_execution', execution.id,
        null, summarizeExecution(execution), `Live execution ${execution.status} for ${execution.flowName}`);
      res.status(201).json({ ok: execution.status === 'successful', execution });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/executions', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      res.json({ ok: true, executions: await hawk.listExecutions(scope, req.query) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/hawk/executions/:id', async (req, res) => {
    try {
      const scope = await assertScope(req, req.query);
      res.json({ ok: true, execution: await hawk.getExecution(req.params.id, scope) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/hawk/executions/:id/replay', async (req, res) => {
    try {
      const scope = await assertScope(req, req.body || {});
      const execution = await hawk.replayExecution(req.params.id, scope, {
        dryRun: req.body?.dryRun !== false,
        confirmLive: req.body?.confirmLive === true,
        requestId: req.sentinelRequestId,
      }, req.session.admin);
      setControl(req, scope, 'hawk.execution.replay', 'hawk_execution', execution.id);
      await audit(req, scope, 'hawk.execution.replay', 'hawk_execution', execution.id,
        { replayOfExecutionId: req.params.id }, summarizeExecution(execution),
        `Safe replay ${execution.status} for ${execution.flowName}`);
      res.status(201).json({ ok: true, execution });
    } catch (error) { sendError(res, error); }
  });

  return router;
}

async function assertScope(req, input) {
  const apiKeyId = String(input.apiKeyId || '').trim();
  const locationId = String(input.locationId || '').trim();
  const dataSourceSlug = String(input.dataSourceSlug || input.source || 'core').trim().toLowerCase();
  assertAdminApiKeyScope(req.session.admin, apiKeyId);
  if (!apiKeyId || !locationId) throw Object.assign(new Error('apiKeyId and locationId are required'), { status: 400 });
  const context = await owl.resolveContext({ apiKeyId, source:dataSourceSlug });
  const granted = await listTenantLocationIds(apiKeyId);
  let operational = [];
  try { operational = await owl.listLocations(context); } catch {}
  const allowed = owl.buildLocationContexts(operational, granted).map((item) => item.locationId);
  if (!allowed.includes(locationId)) {
    throw Object.assign(new Error('Selected location is outside this API-key and database context'), { status: 403 });
  }
  return { apiKeyId, locationId, dataSourceSlug };
}

function setControl(req, scope, action, entityType, entityId) {
  req.sentinelControl = { apiKeyId: scope.apiKeyId, locationId: scope.locationId, action, entityType, entityId };
}

async function audit(req, scope, action, entityType, entityId, before, after, detail) {
  const context = await owl.resolveContext({ apiKeyId: scope.apiKeyId, source: 'core' });
  return owl.recordAudit({
    admin: req.session.admin, context, locationId: scope.locationId,
    action, entityType, entityId, before, after, detail,
  });
}

function summarizeFlow(flow) {
  return flow ? {
    id: flow.id, name: flow.name, status: flow.status, integrationId: flow.integrationId,
    dataSourceSlug:flow.dataSourceSlug,
    folderId: flow.folderId, color: flow.color, draftRevision: flow.draftRevision, publishedVersionId: flow.publishedVersionId,
    publishedVersionNumber: flow.publishedVersionNumber,
  } : null;
}

function summarizeExecution(execution) {
  return execution ? {
    id: execution.id, flowId: execution.flowId, versionId: execution.versionId,
    status: execution.status, mode: execution.mode, triggerType: execution.triggerType,
    stepsTotal: execution.stepsTotal, stepsCompleted: execution.stepsCompleted,
    replayOfExecutionId: execution.replayOfExecutionId || null,
    errorCode: execution.errorCode || null,
  } : null;
}

function withWebhookUrl(req, endpoint) {
  if (!endpoint) return null;
  return { ...endpoint, url:`${req.protocol}://${req.get('host')}${getInstanceIdentity().webhookBasePath}/hawk/${endpoint.publicId}` };
}

function uniqueImportName(name, existing, results) {
  const used = new Set([...existing.map((item) => item.name), ...results.map((item) => item.name)]);
  let index = 2;
  let candidate = `${name} (Imported)`;
  while (used.has(candidate)) candidate = `${name} (Imported ${index++})`;
  return candidate.slice(0, 191);
}

function sendError(res, error) {
  res.status(error.status || 500).json({
    ok: false,
    error: error.message || 'HAWK operation failed',
    code: error.code || 'HAWK_OPERATION_FAILED',
    details: error.details || undefined,
  });
}

module.exports = { createAdminHawkRouter };
