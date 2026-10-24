(() => {
  'use strict';
  const base = location.pathname.replace(/\/(?:parrot|admin\/parrot\.html)\/?$/, '') || '';
  const state = { bootstrap:null, scripts:[], runs:[], selectedScriptId:null, studioScripts:[], selectedStudioId:null, studioDetail:null, importPackage:null, importPreview:null };
  const el = (id) => document.getElementById(id);

  function wireNav() {
    const paths = { navHome:'', navOwl:'/owl', navEagle:'/eagle', navSong:'/song', navHawk:'/hawk', navSentinel:'/sentinel', navDocs:'/docs' };
    for (const [id, suffix] of Object.entries(paths)) el(id).href = base + suffix;
    el('logout').onclick = async (event) => { event.preventDefault(); await fetch(base + '/logout', { method:'POST' }); location.href = base + '/login'; };
  }

  function wireEvents() {
    el('apiKey').onchange = () => loadBootstrap(el('apiKey').value, '', el('dataSource').value);
    el('dataSource').onchange = () => loadBootstrap(el('apiKey').value, '', el('dataSource').value);
    el('location').onchange = () => loadBootstrap(el('apiKey').value, el('location').value, el('dataSource').value);
    el('refreshButton').onclick = () => loadBootstrap(el('apiKey').value, el('location').value, el('dataSource').value);
    el('scriptSearch').oninput = renderScripts;
    el('statusFilter').onchange = renderRuns;
    el('runButton').onclick = runSelected;
    el('scriptList').onclick = (event) => { const button = event.target.closest('[data-script-id]'); if (button) selectScript(button.dataset.scriptId); };
    el('runRows').onclick = (event) => { const row = event.target.closest('[data-run-id]'); if (row) showRun(row.dataset.runId); };
    el('consoleTab').onclick = () => switchView('console');
    el('studioTab').onclick = () => switchView('studio');
    el('newStudioScript').onclick = newStudioScript;
    el('studioScriptList').onclick = (event) => { const button = event.target.closest('[data-studio-id]'); if (button) loadStudioScript(button.dataset.studioId); };
    el('studioSource').oninput = updateStudioSourceStats;
    el('validateStudioScript').onclick = validateStudioScript;
    el('saveStudioScript').onclick = () => saveStudioDraft();
    el('dryRunStudioScript').onclick = dryRunStudioScript;
    el('deployStudioScript').onclick = deployStudioScript;
    el('retireStudioScript').onclick = retireStudioScript;
    el('downloadParrotCrmFields').onclick = downloadParrotCrmFields;
    el('importStudioJson').onclick = openStudioImport;
    el('exportStudioJson').onclick = exportStudioJson;
    el('studioImportFile').onchange = readStudioImportFile;
    el('previewStudioImport').onclick = previewStudioImport;
    el('applyStudioImport').onclick = applyStudioImport;
  }

  async function loadBootstrap(apiKeyId = '', locationId = '', dataSourceSlug = '') {
    const query = new URLSearchParams();
    if (apiKeyId) query.set('apiKeyId', apiKeyId);
    if (locationId) query.set('locationId', locationId);
    if (dataSourceSlug) query.set('dataSourceSlug', dataSourceSlug);
    try {
      const data = await api('/api/parrot/bootstrap?' + query);
      state.bootstrap = data;
      state.scripts = data.parrot?.catalog?.scripts || [];
      state.runs = data.runs || [];
      state.studioScripts = data.studioScripts || [];
      fillScope(); renderHealth(); renderScripts(); renderRuns(); renderKpis();
      renderStudioList();
      const current = state.scripts.some((script) => script.id === state.selectedScriptId) ? state.selectedScriptId : state.scripts[0]?.id;
      selectScript(current || null);
      if (data.parrot?.catalogError || data.parrot?.healthError) showAlert('error', data.parrot.catalogError || data.parrot.healthError);
      else hideAlert();
    } catch (error) { showAlert('error', error.message); }
  }

  function switchView(view) {
    document.querySelectorAll('[data-parrot-view]').forEach((item) => { item.hidden = item.dataset.parrotView !== view; });
    el('consoleTab').classList.toggle('active', view === 'console');
    el('studioTab').classList.toggle('active', view === 'studio');
    if (view === 'studio' && !state.studioDetail) newStudioScript();
  }

  function renderStudioList() {
    el('studioScriptList').innerHTML = state.studioScripts.length
      ? state.studioScripts.map((script) => `<button type="button" data-studio-id="${escapeHtml(script.id)}" class="${script.id === state.selectedStudioId ? 'active' : ''}"><strong>${escapeHtml(script.name)}</strong><small>${escapeHtml(script.slug)} · ${escapeHtml(script.status)}</small><small>Draft v${escapeHtml(script.latestVersion || '—')}${script.deployedVersion ? ` · deployed v${escapeHtml(script.deployedVersion)}` : ''}</small></button>`).join('')
      : '<p>No Studio scripts yet.</p>';
  }

  function newStudioScript() {
    state.selectedStudioId = null;
    state.studioDetail = null;
    el('studioTitle').textContent = 'New managed script';
    el('studioStatus').textContent = 'Draft';
    el('studioStatus').className = 'studio-status draft';
    el('studioName').value = '';
    el('studioSlug').value = '';
    el('studioSlug').disabled = false;
    el('studioDescription').value = '';
    el('capabilityHttp').checked = false;
    el('capabilityDns').checked = false;
    el('studioSource').value = 'def run(inputs, context):\n    """Return JSON-safe reconnaissance results."""\n    return {\n        "received": inputs,\n        "dryRun": context.get("dryRun"),\n    }\n';
    el('studioInputSchema').value = JSON.stringify({ type:'object', properties:{} }, null, 2);
    el('studioChangeNote').value = '';
    el('studioValidation').textContent = 'Validate the draft to inspect its source hash and policy findings.';
    el('studioDryInputs').value = '{}';
    el('studioDryResult').textContent = 'Dry-run output will appear here.';
    el('deployStudioScript').disabled = true;
    el('retireStudioScript').disabled = true;
    el('exportStudioJson').disabled = true;
    updateStudioSourceStats();
    renderStudioList();
  }

  async function loadStudioScript(id) {
    try {
      const data = await api(`/api/parrot/scripts/${encodeURIComponent(id)}?${new URLSearchParams(scope())}`);
      const script = data.script;
      state.selectedStudioId = script.id;
      state.studioDetail = script;
      const version = (script.versions || []).find((item) => item.id === script.latestVersionId) || script.versions?.[0];
      el('studioTitle').textContent = script.name;
      el('studioStatus').textContent = script.status;
      el('studioStatus').className = `studio-status ${script.status}`;
      el('studioName').value = script.name || '';
      el('studioSlug').value = script.slug || '';
      el('studioSlug').disabled = true;
      el('studioDescription').value = script.description || '';
      el('capabilityHttp').checked = (version?.capabilities || []).includes('network.http');
      el('capabilityDns').checked = (version?.capabilities || []).includes('network.dns');
      el('studioSource').value = version?.source || '';
      el('studioInputSchema').value = JSON.stringify(version?.inputSchema || { type:'object', properties:{} }, null, 2);
      el('studioChangeNote').value = '';
      el('studioValidation').textContent = JSON.stringify(version?.validation || {}, null, 2);
      el('studioDryResult').textContent = version?.lastDryRunAt ? `Last dry-run: ${formatDate(version.lastDryRunAt)}` : 'This version has not been dry-run yet.';
      el('deployStudioScript').disabled = version?.validation?.valid !== true || version?.status === 'deployed';
      el('retireStudioScript').disabled = script.status === 'retired';
      el('exportStudioJson').disabled = false;
      updateStudioSourceStats();
      renderStudioList();
    } catch (error) { showAlert('error', error.message); }
  }

  function studioCapabilities() {
    return [el('capabilityHttp').checked ? 'network.http' : null, el('capabilityDns').checked ? 'network.dns' : null].filter(Boolean);
  }

  function studioPayload() {
    let inputSchema;
    try { inputSchema = JSON.parse(el('studioInputSchema').value || '{}'); }
    catch { throw new Error('Input contract must be valid JSON.'); }
    return {
      ...scope(), name:el('studioName').value.trim(), slug:el('studioSlug').value.trim(),
      description:el('studioDescription').value.trim(), source:el('studioSource').value,
      capabilities:studioCapabilities(), inputSchema, changeNote:el('studioChangeNote').value.trim(),
    };
  }

  async function validateStudioScript() {
    try {
      const data = await api('/api/parrot/scripts/validate', { method:'POST', body:JSON.stringify(studioPayload()) });
      el('studioValidation').textContent = JSON.stringify(data.validation, null, 2);
      showAlert(data.validation.valid ? 'success' : 'error', data.validation.valid ? `Valid source · ${data.validation.sha256.slice(0, 12)}` : `${data.validation.errors.length} validation issue(s)`);
      return data.validation;
    } catch (error) { showAlert('error', error.message); return null; }
  }

  async function saveStudioDraft(options = {}) {
    try {
      const payload = studioPayload();
      if (!payload.name) throw new Error('Script name is required.');
      const path = state.selectedStudioId ? `/api/parrot/scripts/${encodeURIComponent(state.selectedStudioId)}` : '/api/parrot/scripts';
      const data = await api(path, { method:state.selectedStudioId ? 'PUT' : 'POST', body:JSON.stringify(payload) });
      state.selectedStudioId = data.script.id;
      state.studioDetail = data.script;
      upsertStudioSummary(data.script);
      await loadStudioScript(data.script.id);
      if (!options.quiet) showAlert('success', `Draft v${data.script.latestVersion} saved.`);
      return data.script;
    } catch (error) { showAlert('error', error.message); return null; }
  }

  function upsertStudioSummary(script) {
    const index = state.studioScripts.findIndex((item) => item.id === script.id);
    if (index >= 0) state.studioScripts[index] = script; else state.studioScripts.unshift(script);
    renderStudioList();
  }

  async function dryRunStudioScript() {
    let inputs;
    try { inputs = JSON.parse(el('studioDryInputs').value || '{}'); }
    catch { return showAlert('error', 'Dry-run inputs must be valid JSON.'); }
    const script = await saveStudioDraft({ quiet:true });
    if (!script) return;
    try {
      const data = await api(`/api/parrot/scripts/${encodeURIComponent(script.id)}/dry-run`, {
        method:'POST', body:JSON.stringify({ ...scope(), versionId:script.latestVersionId, inputs }),
      });
      el('studioDryResult').textContent = JSON.stringify(data.run, null, 2);
      showAlert('success', `Dry-run completed · request ${data.run.requestId}`);
      await loadBootstrap(scope().apiKeyId, scope().locationId, scope().dataSourceSlug);
      await loadStudioScript(script.id);
    } catch (error) { showAlert('error', error.message); }
  }

  async function deployStudioScript() {
    const script = await saveStudioDraft({ quiet:true });
    if (!script) return;
    if (!window.confirm(`Deploy ${script.name} v${script.latestVersion} for live HAWK selection?`)) return;
    try {
      const data = await api(`/api/parrot/scripts/${encodeURIComponent(script.id)}/deploy`, {
        method:'POST', body:JSON.stringify({ ...scope(), confirmDeploy:true, reason:el('studioChangeNote').value.trim() || 'Approved in PARROT Script Studio' }),
      });
      upsertStudioSummary(data.script);
      showAlert('success', `${data.script.slug} v${data.script.deployedVersion} deployed and available to HAWK.`);
      await loadBootstrap(scope().apiKeyId, scope().locationId, scope().dataSourceSlug);
      await loadStudioScript(script.id);
    } catch (error) { showAlert('error', error.message); }
  }

  async function retireStudioScript() {
    if (!state.selectedStudioId || !window.confirm('Retire this script from future HAWK selection? Existing immutable flow versions remain auditable.')) return;
    try {
      const data = await api(`/api/parrot/scripts/${encodeURIComponent(state.selectedStudioId)}/retire`, {
        method:'POST', body:JSON.stringify({ ...scope(), reason:'Retired in PARROT Script Studio' }),
      });
      upsertStudioSummary(data.script);
      await loadStudioScript(data.script.id);
      showAlert('success', 'Script retired.');
    } catch (error) { showAlert('error', error.message); }
  }

  function updateStudioSourceStats() {
    const source = el('studioSource').value || '';
    const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(source).length : source.length;
    el('studioSourceStats').textContent = `${source ? source.split(/\r?\n/).length : 0} lines · ${bytes} bytes`;
  }

  async function exportStudioJson() {
    if (!state.selectedStudioId) return;
    try {
      const value = await api(`/api/parrot/scripts/${encodeURIComponent(state.selectedStudioId)}/export?${new URLSearchParams(scope())}`);
      downloadJson(value, `${el('studioSlug').value || 'parrot-script'}.json`);
      showAlert('success', 'Exported the latest governed draft as PARROT JSON.');
    } catch (error) { showAlert('error', error.message); }
  }

  async function downloadParrotCrmFields() {
    try {
      const response = await fetch(base + `/api/parrot/imports/schema?${new URLSearchParams(scope())}`, { credentials:'same-origin', headers:{ Accept:'application/json' } });
      if (!response.ok) throw new Error('Could not export the live PARROT CRM field schema.');
      const value = await response.json();
      downloadJson(value, 'parrot-live-python.schema.json');
      showAlert('success', `Exported ${value['x-parrot-catalog']?.crmFields?.length || 0} CRM fields for AI authoring.`);
    } catch (error) { showAlert('error', error.message); }
  }

  function openStudioImport() {
    state.importPackage = null;
    state.importPreview = null;
    el('studioImportFile').value = '';
    el('studioImportJson').value = '';
    el('studioImportPolicy').value = 'skip';
    el('studioImportPreview').textContent = 'Choose or paste a package, then preview it.';
    el('applyStudioImport').disabled = true;
    el('studioImportDialog').showModal();
  }

  async function readStudioImportFile() {
    const file = el('studioImportFile').files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) return showAlert('error', 'PARROT import files may not exceed 1 MB.');
    el('studioImportJson').value = await file.text();
    state.importPackage = null;
    state.importPreview = null;
    el('applyStudioImport').disabled = true;
  }

  function parseStudioImport() {
    let source = String(el('studioImportJson').value || '{}').trim().replace(/^\uFEFF/, '');
    if (source.startsWith('```')) source = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let value;
    try { value = JSON.parse(source); }
    catch (error) { throw new Error(`Script package must be valid JSON. ${error.message}`); }
    if (value?.format !== 'parrot-script-1') throw new Error('Script package format must be parrot-script-1.');
    return value;
  }

  async function previewStudioImport() {
    try {
      const scriptPackage = parseStudioImport();
      const data = await api('/api/parrot/imports/preview', { method:'POST', body:JSON.stringify({ ...scope(), scriptPackage }) });
      state.importPackage = scriptPackage;
      state.importPreview = data.scripts;
      const valid = data.scripts.every((item) => item.validation?.valid);
      el('studioImportPreview').innerHTML = data.scripts.map((item) => `<article class="${item.validation?.valid ? 'valid' : 'invalid'}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.slug)} · ${item.validation?.valid ? 'Ready to import as draft' : `${item.validation?.errors?.length || 0} validation issue(s)`}</span>${item.validation?.valid ? `<small>${escapeHtml(item.validation.sha256.slice(0, 12))} · ${(item.capabilities || []).map(escapeHtml).join(', ') || 'transform only'}</small>` : `<small>${escapeHtml((item.validation?.errors || []).slice(0, 4).map((issue) => issue.message).join(' · '))}</small>`}</article>`).join('');
      el('applyStudioImport').disabled = !valid;
    } catch (error) {
      el('applyStudioImport').disabled = true;
      showAlert('error', error.message);
    }
  }

  async function applyStudioImport() {
    if (!state.importPackage || !state.importPreview?.every((item) => item.validation?.valid)) return;
    try {
      el('applyStudioImport').disabled = true;
      const data = await api('/api/parrot/imports/apply', {
        method:'POST',
        body:JSON.stringify({ ...scope(), conflictPolicy:el('studioImportPolicy').value, scriptPackage:state.importPackage }),
      });
      el('studioImportDialog').close();
      await loadBootstrap(scope().apiKeyId, scope().locationId, scope().dataSourceSlug);
      const selected = data.results.find((item) => item.action !== 'skipped') || data.results[0];
      if (selected?.scriptId) await loadStudioScript(selected.scriptId);
      showAlert('success', `Imported ${data.results.filter((item) => item.action !== 'skipped').length} draft script(s); ${data.results.filter((item) => item.action === 'skipped').length} skipped.`);
    } catch (error) {
      el('applyStudioImport').disabled = false;
      showAlert('error', error.message);
    }
  }

  function downloadJson(value, filename) {
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type:'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = String(filename || 'parrot-script.json').replace(/[^A-Za-z0-9._-]+/g, '-');
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function fillScope() {
    const data = state.bootstrap;
    fillSelect(el('apiKey'), data.keys || [], data.selectedKey?.id, (item) => item.name || item.keyPrefix || item.id, (item) => item.id);
    fillSelect(el('dataSource'), data.dataSources || [], data.dataSourceSlug, (item) => item.name || item.slug, (item) => item.slug);
    fillSelect(el('location'), data.locations || [], data.locationId, (item) => item, (item) => item);
  }

  function renderHealth() {
    const bridge = state.bootstrap?.parrot || {};
    const health = bridge.health;
    el('healthStatus').textContent = bridge.enabled && health?.ready ? 'Operational' : bridge.enabled ? 'Degraded' : 'Not configured';
    el('healthDetail').textContent = health?.ready ? `${health.contractVersion} · Passenger ready` : bridge.healthError || bridge.reason || 'Set PARROT configuration';
  }

  function renderKpis() {
    el('scriptCount').textContent = String(state.scripts.length);
    el('completedCount').textContent = String(state.runs.filter((run) => run.status === 'completed').length);
    el('failedCount').textContent = String(state.runs.filter((run) => run.status === 'failed').length);
  }

  function renderScripts() {
    const q = el('scriptSearch').value.trim().toLowerCase();
    const scripts = state.scripts.filter((script) => !q || `${script.id} ${script.name} ${script.description}`.toLowerCase().includes(q));
    el('scriptList').innerHTML = scripts.length ? scripts.map((script) => `<button type="button" class="parrot-script ${script.id === state.selectedScriptId ? 'active' : ''}" data-script-id="${escapeHtml(script.id)}"><strong>${escapeHtml(script.name)}</strong><small>${escapeHtml(script.id)} · v${escapeHtml(script.version || 'unversioned')}</small><small>${escapeHtml(script.description || '')}</small></button>`).join('') : '<p>No registered scripts match.</p>';
  }

  function selectScript(id) {
    state.selectedScriptId = id;
    const script = state.scripts.find((item) => item.id === id);
    el('runButton').disabled = !script;
    el('scriptTitle').textContent = script?.name || 'Select a script';
    el('scriptDescription').textContent = script?.description || 'Choose a registered handler from the catalog.';
    el('scriptMeta').innerHTML = script ? [`v${script.version}`, script.owner, script.dataSensitivity, `${script.timeoutMs} ms`, ...(script.sources || [])].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join('') : '';
    el('inputSchema').textContent = JSON.stringify(script?.inputSchema || {}, null, 2);
    if (script) el('runInputs').value = JSON.stringify(sampleFromSchema(script.inputSchema), null, 2);
    renderScripts();
  }

  function sampleFromSchema(schema) {
    const output = {};
    for (const key of schema?.required || []) {
      const field = schema.properties?.[key] || {};
      output[key] = field.type === 'array' ? [] : field.type === 'object' ? {} : field.type === 'number' ? 0 : field.type === 'boolean' ? false : '';
    }
    return output;
  }

  async function runSelected() {
    const script = state.scripts.find((item) => item.id === state.selectedScriptId);
    if (!script) return;
    let inputs;
    try { inputs = JSON.parse(el('runInputs').value || '{}'); }
    catch { return showAlert('error', 'Inputs must be valid JSON.'); }
    const mode = el('runMode').value;
    if (mode === 'live' && !window.confirm(`Run ${script.name} in live mode?`)) return;
    el('runButton').disabled = true;
    try {
      const data = await api('/api/parrot/runs', { method:'POST', body:JSON.stringify({ ...scope(), scriptId:script.id, scriptVersion:script.version, mode, inputs, idempotencyKey:el('idempotencyKey').value.trim() || undefined, confirmLive:mode === 'live' }) });
      el('runResult').textContent = JSON.stringify(data.run, null, 2);
      state.runs.unshift(data.run); renderRuns(); renderKpis();
      showAlert('success', `PARROT run ${data.run.status}. Request ID ${data.run.requestId}.`);
    } catch (error) { showAlert('error', error.message); }
    finally { el('runButton').disabled = false; }
  }

  function renderRuns() {
    const status = el('statusFilter').value;
    const runs = state.runs.filter((run) => !status || run.status === status);
    el('runRows').innerHTML = runs.length ? runs.map((run) => `<tr data-run-id="${escapeHtml(run.id)}"><td>${formatDate(run.createdAt || run.startedAt)}</td><td><strong>${escapeHtml(run.scriptId)}</strong><br><small>${escapeHtml(run.scriptVersion || '')}</small></td><td>${escapeHtml(run.source)}</td><td>${escapeHtml(run.mode)}</td><td class="run-status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</td><td>${run.durationMs == null ? '—' : `${Number(run.durationMs).toLocaleString()} ms`}</td><td><code>${escapeHtml(run.requestId || '')}</code></td></tr>`).join('') : '<tr><td colspan="7">No PARROT runs in this workspace.</td></tr>';
  }

  function showRun(id) { const run = state.runs.find((item) => item.id === id); if (run) el('runResult').textContent = JSON.stringify(run, null, 2); }
  function scope() { return { apiKeyId:el('apiKey').value, dataSourceSlug:el('dataSource').value || 'core', locationId:el('location').value }; }
  function fillSelect(select, items, selected, label, value) { select.innerHTML = items.map((item) => `<option value="${escapeHtml(value(item))}">${escapeHtml(label(item))}</option>`).join(''); select.value = selected || ''; }
  async function api(path, options = {}) { const response = await fetch(base + path, { credentials:'same-origin', headers:{ Accept:'application/json', ...(options.body ? { 'Content-Type':'application/json' } : {}) }, ...options }); const data = await response.json().catch(() => ({})); if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`); return data; }
  function showAlert(type, message) { el('parrotAlert').hidden = false; el('parrotAlert').className = `parrot-alert ${type}`; el('parrotAlert').textContent = message; }
  function hideAlert() { el('parrotAlert').hidden = true; }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]); }
  function formatDate(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '—'; }

  wireNav(); wireEvents(); loadBootstrap();
})();
