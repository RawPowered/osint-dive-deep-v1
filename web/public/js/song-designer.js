(() => {
  'use strict';

  const base = location.pathname.replace(/\/(?:song|admin\/song\.html)\/?$/, '') || '';
  const el = (id) => document.getElementById(id);
  const state = {
    bootstrap:null, scripts:[], current:null, selectedNodeId:null,
    dirty:false, zoom:1, activeTab:'node', testNodeId:null, testSteps:0,
    variablePickerMode:'insert', variableInsertion:null, variablePickerResults:[],
  };
  const nodeTypeLabels = {
    prompt:'Prompt', question:'Question', qualification:'Qualification', value:'Needs / Value',
    objection:'Objection', action:'Action', appointment:'Appointment', voicemail:'Voicemail',
    disposition:'Disposition', confirmation:'Confirmation', end:'End',
  };
  const actionLabels = {
    none:'No action', authorize_call:'Authorize call', set_disposition:'Set disposition',
    book_appointment:'Book appointment', release_lead:'Release lead', set_variable:'Set variable',
    capture_input:'Capture operator input', emit_event:'Emit event', complete_script:'Complete script',
  };
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    setNav();
    populateStaticSelects();
    bindEvents();
    await loadBootstrap();
  }

  function setNav() {
  const nav = { navHome:'', navOwl:'/owl', navEagle:'/eagle', navHawk:'/hawk', navParrot:'/parrot', navCrm:'/crm-integrations', navDocs:'/docs' };
    for (const [id, suffix] of Object.entries(nav)) el(id).href = base + suffix;
    el('logout').href = base + '/logout';
  }

  function populateStaticSelects() {
    el('nodeType').innerHTML = Object.entries(nodeTypeLabels).map(([value,label]) => option(value,label)).join('');
    const actions = Object.entries(actionLabels).map(([value,label]) => option(value,label)).join('');
    el('nodeAction').innerHTML = actions;
  }

  function bindEvents() {
    el('apiKey').addEventListener('change', () => loadBootstrap(el('apiKey').value));
    el('location').addEventListener('change', async () => {
      await loadBootstrap(el('apiKey').value, el('location').value);
    });
    el('scriptSearch').addEventListener('input', renderScriptList);
    el('serviceFilter').addEventListener('change', renderScriptList);
    el('languageFilter').addEventListener('change', renderScriptList);
    el('newScriptButton').addEventListener('click', openNewScript);
    el('newScriptForm').addEventListener('submit', createNewScript);
    el('saveButton').addEventListener('click', () => saveDraft(true));
    el('validateButton').addEventListener('click', validateCurrent);
    el('publishButton').addEventListener('click', publishCurrent);
    el('applyScriptLanguage').addEventListener('click', applyScriptLanguage);
    el('testButton').addEventListener('click', openTestFlow);
    el('restartTest').addEventListener('click', restartTest);
    el('scriptActions').addEventListener('change', runScriptAction);
    el('addNodeButton').addEventListener('click', addNode);
    el('zoomIn').addEventListener('click', () => setZoom(state.zoom + .1));
    el('zoomOut').addEventListener('click', () => setZoom(state.zoom - .1));
    el('fitCanvas').addEventListener('click', fitCanvas);
    el('deleteNodeButton').addEventListener('click', deleteSelectedNode);
    el('setStartButton').addEventListener('click', setSelectedStart);
    el('insertVariable').addEventListener('click', () => openVariablePicker('insert'));
    el('addBranchButton').addEventListener('click', addBranch);
    el('addVariableButton').addEventListener('click', () => openVariablePicker('manage'));
    el('variableSearch').addEventListener('input', renderVariablePicker);
    el('variableGroup').addEventListener('change', renderVariablePicker);
    el('manageVariablesButton').addEventListener('click', () => {
      el('variablePickerDialog').close(); switchTab('variables');
    });
    el('previewVibeImport').addEventListener('click', previewVibeImport);
    el('applyVibeImport').addEventListener('click', applyVibeImport);
    el('loadVibeSample').addEventListener('click', loadVibeSample);
    el('refreshVersions').addEventListener('click', loadVersions);
    el('refreshAnalytics').addEventListener('click', loadAnalytics);
    el('validationPanel').addEventListener('click', () => { el('validationPanel').hidden = true; });
    for (const button of document.querySelectorAll('.song-property-tabs button')) {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
    }
    bindNodeForm();
    bindScriptSettings();
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); saveDraft(true);
      }
      if (event.key === 'Delete' && state.selectedNodeId && !isTypingTarget(event.target)) deleteSelectedNode();
    });
    window.addEventListener('beforeunload', (event) => {
      if (!state.dirty) return;
      event.preventDefault(); event.returnValue = '';
    });
  }

  function bindNodeForm() {
    const fields = [
      ['nodeTitle','title'],['nodeType','type'],['nodeGoal','goal'],['nodePrompt','prompt'],
      ['nodeHelper','helperText'],['nodeRequired','required'],['nodeAnalytics','trackAnalytics'],
    ];
    for (const [id,key] of fields) {
      const input = el(id);
      input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input', () => {
        const node = selectedNode(); if (!node) return;
        node[key] = input.type === 'checkbox' ? input.checked : input.value;
        markDirty(); renderCanvas(); renderPreview();
        if (key === 'type') renderNodeProperties();
      });
    }
    el('nodeAction').addEventListener('change', () => {
      const node = selectedNode(); if (!node) return;
      const config = node.actions?.[0]?.config || {};
      node.actions = el('nodeAction').value === 'none' ? [] : [{ type:el('nodeAction').value, config }];
      markDirty(); renderNodeProperties(); renderCanvas();
    });
    el('nodeActionConfig').addEventListener('change', () => {
      const node = selectedNode();
      if (!node || !node.actions?.length) return;
      const parsed = parseJsonInput(el('nodeActionConfig').value);
      if (parsed == null) return;
      node.actions[0].config = parsed; markDirty();
    });
  }

  function bindScriptSettings() {
    el('scriptName').addEventListener('input', () => {
      if (!state.current) return; state.current.name = el('scriptName').value; markDirty(); renderHeader(); renderScriptList();
    });
    el('scriptDescription').addEventListener('input', () => {
      if (!state.current) return; state.current.description = el('scriptDescription').value; markDirty();
    });
    el('scriptService').addEventListener('change', () => {
      if (!state.current) return; state.current.serviceType = el('scriptService').value; markDirty(); renderHeader(); renderScriptList();
    });
    el('scriptLanguage').addEventListener('input', () => {
      if (!state.current) return;
      if (state.current.publishedVersionId) return renderLanguageAction();
      state.current.languageCode = el('scriptLanguage').value.trim(); markDirty(); renderHeader(); renderScriptList();
    });
  }

  async function api(path, options = {}) {
    const response = await fetch(base + path, {
      credentials:'same-origin',
      headers:{ Accept:'application/json', ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(options.headers || {}) },
      ...options,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Request failed with HTTP ${response.status}`);
      error.code = body.code; error.details = body.details; error.status = response.status;
      throw error;
    }
    return body;
  }

  async function loadBootstrap(apiKeyId = '', locationId = '') {
    try {
      const query = new URLSearchParams();
      if (apiKeyId) query.set('apiKeyId', apiKeyId);
      if (locationId) query.set('locationId', locationId);
      state.bootstrap = await api('/api/song/bootstrap' + (query.size ? `?${query}` : ''));
      fillContext();
      await loadScripts();
    } catch (error) { showError(error); }
  }

  function fillContext() {
    const data = state.bootstrap;
    el('apiKey').innerHTML = (data.keys || []).map((key) => option(key.id, `${key.name} (${key.keyPrefix})`, key.id === data.selectedKey?.id)).join('');
    el('location').innerHTML = (data.locations || []).map((value) => option(value,value,value === data.locationId)).join('') || option('','No granted locations');
    const services = data.services || [];
    el('serviceFilter').innerHTML = option('','All services') + services.map((item) => option(item.serviceType,item.serviceType)).join('');
    el('newScriptService').innerHTML = services.map((item) => option(item.serviceType,item.serviceType)).join('');
    el('scriptService').innerHTML = services.map((item) => option(item.serviceType,item.serviceType)).join('');
  }

  function scope() {
    return { apiKeyId:el('apiKey').value, locationId:el('location').value };
  }

  function scopeQuery(extra = {}) {
    return new URLSearchParams({ ...scope(), ...extra });
  }

  async function loadScripts(preferredId = null) {
    state.current = null; state.selectedNodeId = null; state.dirty = false;
    renderCurrent();
    if (!scope().apiKeyId || !scope().locationId) {
      state.scripts = []; renderScriptList(); return;
    }
    try {
      const data = await api('/api/song/scripts?' + scopeQuery());
      state.scripts = data.scripts || [];
      const selectedLanguage = el('languageFilter').value;
      const languages = [...new Set(state.scripts.map((item) => item.languageCode || 'en-US'))].sort();
      el('languageFilter').innerHTML = option('','All languages')
        + languages.map((value) => option(value,languageLabel(value),value === selectedLanguage)).join('');
      renderScriptList();
      const target = state.scripts.find((item) => item.id === preferredId) || state.scripts[0];
      if (target) await selectScript(target.id);
    } catch (error) { showError(error); }
  }

  async function selectScript(id) {
    if (state.dirty && !confirm('Discard unsaved changes and load another script?')) return;
    try {
      const data = await api(`/api/song/scripts/${encodeURIComponent(id)}?${scopeQuery()}`);
      state.current = data.script;
      state.selectedNodeId = state.current.graph.startNodeId || state.current.graph.nodes[0]?.id || null;
      state.dirty = false;
      renderCurrent();
      centerSelectedNode();
    } catch (error) { showError(error); }
  }

  function renderCurrent() {
    renderHeader(); renderScriptList(); renderCanvas(); renderNodeProperties(); renderVariables(); renderPreview();
    const enabled = Boolean(state.current);
    for (const id of ['saveButton','validateButton','testButton','publishButton','addNodeButton']) el(id).disabled = !enabled;
    el('scriptActions').disabled = !scope().apiKeyId || !scope().locationId;
  }

  function renderHeader() {
    const script = state.current;
    el('scriptTitle').textContent = script?.name || 'SONG';
    el('scriptStatus').textContent = script ? `${script.status}${script.publishedVersionNumber ? ` v${script.publishedVersionNumber}` : ''}` : 'No script selected';
    el('scriptStatus').className = `song-status ${script?.status || 'draft'}`;
    el('scriptMeta').textContent = script
      ? `${script.serviceType} | ${script.languageCode || 'en-US'} | Draft revision ${script.draftRevision} | Updated ${formatDate(script.updatedAt)}`
      : 'Select a script or create a new flow.';
    el('dirtyState').hidden = !state.dirty;
  }

  function renderScriptList() {
    const search = el('scriptSearch').value.trim().toLowerCase();
    const service = el('serviceFilter').value;
    const language = el('languageFilter').value;
    const rows = state.scripts.filter((item) =>
      (!search || `${item.name} ${item.serviceType} ${item.languageCode || ''}`.toLowerCase().includes(search))
      && (!service || item.serviceType === service)
      && (!language || (item.languageCode || 'en-US') === language));
    el('scriptList').innerHTML = rows.length ? rows.map((item) => `
      <button type="button" class="song-script-item ${item.id === state.current?.id ? 'active' : ''}" data-script-id="${escapeHtml(item.id)}">
        <strong>${escapeHtml(item.name)}</strong>
        <small>${item.publishedVersionNumber ? `Published v${item.publishedVersionNumber}` : 'No published version'} | Rev ${item.draftRevision}</small>
        <span class="song-script-line"><span class="song-script-badge ${item.status}">${escapeHtml(item.status)}</span><span class="song-script-service">${escapeHtml(item.serviceType)} | ${escapeHtml(languageLabel(item.languageCode || 'en-US'))}</span></span>
      </button>`).join('') : '<div class="song-empty-list">No scripts in this location.</div>';
    for (const button of el('scriptList').querySelectorAll('[data-script-id]')) button.addEventListener('click', () => selectScript(button.dataset.scriptId));
  }

  function renderCanvas() {
    const graph = state.current?.graph;
    el('canvasEmpty').hidden = Boolean(graph?.nodes?.length);
    if (!graph) { el('nodeLayer').innerHTML = ''; el('edgeLayer').innerHTML = ''; return; }
    el('nodeLayer').innerHTML = graph.nodes.map((node,index) => `
      <article class="song-node ${node.id === state.selectedNodeId ? 'selected' : ''} ${node.id === graph.startNodeId ? 'start' : ''}"
        data-node-id="${escapeHtml(node.id)}" data-type="${escapeHtml(node.type)}" style="left:${node.position.x}px;top:${node.position.y}px">
        <div class="song-node-head"><span class="song-node-index">${node.id === graph.startNodeId ? 'S' : index + 1}</span><h3>${escapeHtml(node.title || node.id)}</h3></div>
        <p>${escapeHtml(node.goal || node.prompt || 'No prompt configured')}</p>
        <div class="song-node-foot"><span>${escapeHtml(nodeTypeLabels[node.type] || node.type)}</span><span>${node.branches.length} branch${node.branches.length === 1 ? '' : 'es'}</span></div>
      </article>`).join('');
    for (const card of el('nodeLayer').querySelectorAll('.song-node')) {
      card.addEventListener('click', () => selectNode(card.dataset.nodeId));
      bindNodeDrag(card);
    }
    requestAnimationFrame(renderEdges);
  }

  function renderEdges() {
    const graph = state.current?.graph;
    if (!graph) return;
    const nodes = new Map(graph.nodes.map((node) => [node.id,node]));
    const svg = el('edgeLayer');
    const pieces = [];
    for (const node of graph.nodes) {
      const sourceCard = el('nodeLayer').querySelector(`[data-node-id="${cssEscape(node.id)}"]`);
      const sourceHeight = sourceCard?.offsetHeight || 112;
      for (const branch of node.branches) {
        const target = nodes.get(branch.targetNodeId);
        if (!target) continue;
        const x1 = node.position.x + 109;
        const y1 = node.position.y + sourceHeight;
        const x2 = target.position.x + 109;
        const y2 = target.position.y;
        const bend = Math.max(45, Math.abs(y2 - y1) * .45);
        const path = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
        const active = node.id === state.selectedNodeId ? 'active' : '';
        pieces.push(`<path class="song-edge-path ${active}" d="${path}" marker-end="url(#songArrow)"/>`);
        pieces.push(`<text class="song-edge-label" x="${(x1+x2)/2}" y="${(y1+y2)/2 - 5}" text-anchor="middle">${escapeHtml(branch.label)}</text>`);
      }
    }
    svg.innerHTML = `<defs><marker id="songArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#9ca8b8"/></marker></defs>${pieces.join('')}`;
  }

  function bindNodeDrag(card) {
    card.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const node = nodeById(card.dataset.nodeId); if (!node) return;
      selectNode(node.id);
      const start = { x:event.clientX, y:event.clientY, left:node.position.x, top:node.position.y };
      card.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        node.position.x = Math.max(0, Math.round(start.left + (moveEvent.clientX - start.x) / state.zoom));
        node.position.y = Math.max(0, Math.round(start.top + (moveEvent.clientY - start.y) / state.zoom));
        card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px`;
        markDirty(); renderEdges();
      };
      const up = () => { card.removeEventListener('pointermove', move); card.removeEventListener('pointerup', up); };
      card.addEventListener('pointermove', move); card.addEventListener('pointerup', up);
    });
  }

  function selectNode(id) {
    state.selectedNodeId = id; switchTab('node'); renderCanvas(); renderNodeProperties(); renderPreview();
  }

  function renderNodeProperties() {
    const node = selectedNode();
    el('noNodeProperties').hidden = Boolean(node); el('nodeForm').hidden = !node;
    if (!node) return;
    el('nodeTypeBadge').textContent = nodeTypeLabels[node.type] || node.type;
    el('nodePropertyTitle').textContent = node.title || node.id;
    el('nodeTitle').value = node.title || ''; el('nodeType').value = node.type;
    el('nodeGoal').value = node.goal || ''; el('nodePrompt').value = node.prompt || '';
    el('nodeHelper').value = node.helperText || ''; el('nodeRequired').checked = node.required !== false;
    el('nodeAnalytics').checked = node.trackAnalytics !== false;
    el('nodeAction').innerHTML = Object.entries(actionLabels).map(([value,label]) => option(value,label)).join('');
    el('nodeAction').value = node.actions?.[0]?.type || 'none';
    el('nodeActionConfig').value = node.actions?.[0] ? JSON.stringify(node.actions[0].config || {}, null, 2) : '{}';
    el('nodeActionConfig').disabled = !node.actions?.length;
    el('setStartButton').disabled = node.id === state.current.graph.startNodeId;
    renderBranches(node);
  }

  function renderBranches(node) {
    const targets = state.current.graph.nodes.map((item) => option(item.id,item.title || item.id)).join('');
    el('branchList').innerHTML = node.branches.length ? node.branches.map((branch,index) => {
      const action = branch.actions?.[0] || { type:'none', config:{} };
      const condition = branch.condition || { mode:'all', rules:[] };
      return `<section class="song-branch" data-branch-index="${index}" style="--branch-color:${branch.color}">
        <div class="song-branch-top"><strong>${escapeHtml(branch.label || `Branch ${index+1}`)}</strong><button type="button" data-remove-branch="${index}" title="Remove branch">x</button></div>
        <div class="song-branch-grid">
          <label>Label<input data-branch-field="label" value="${escapeHtml(branch.label)}" /></label>
          <label>Outcome<input data-branch-field="outcome" value="${escapeHtml(branch.outcome)}" /></label>
        </div>
        <label>Agent response after selection<textarea rows="2" data-branch-field="agentResponse" placeholder="Optional response or rebuttal shown before the next step">${escapeHtml(branch.agentResponse || '')}</textarea></label>
        <label>Next step<select data-branch-field="targetNodeId">${targets}</select></label>
        <details ${condition.rules.length ? 'open' : ''}><summary>Condition and actions</summary>
          <label>Match<select data-condition-mode><option value="all" ${condition.mode === 'all' ? 'selected' : ''}>All conditions</option><option value="any" ${condition.mode === 'any' ? 'selected' : ''}>Any condition</option></select></label>
          <div class="song-condition-rules">${condition.rules.map((rule,ruleIndex) => conditionRuleHtml(rule,ruleIndex)).join('')}</div>
          <button type="button" class="song-text-button" data-add-condition>Add condition</button>
          <label>Branch action<select data-branch-action>${Object.entries(actionLabels).map(([value,label]) => option(value,label,value === action.type)).join('')}</select></label>
          <label>Action configuration<textarea rows="2" data-branch-config>${escapeHtml(JSON.stringify(action.config || {}))}</textarea></label>
        </details>
      </section>`;
    }).join('') : '<div class="song-property-empty">This step has no branches.</div>';
    for (const section of el('branchList').querySelectorAll('.song-branch')) bindBranchEditor(section,node);
  }

  function conditionRuleHtml(rule,index) {
    const operators = ['equals','not_equals','contains','not_contains','exists','not_exists','greater_than','less_than','in'];
    return `<div class="song-branch-grid song-condition-rule" data-rule-index="${index}">
      <label>Field<input data-rule-field="field" value="${escapeHtml(rule.field || '')}" placeholder="runtime.answer" /></label>
      <label>Operator<select data-rule-field="operator">${operators.map((value) => option(value,value.replaceAll('_',' '),value === rule.operator)).join('')}</select></label>
      <label>Value<input data-rule-field="value" value="${escapeHtml(rule.value ?? '')}" /></label>
      <button type="button" class="song-text-button danger" data-remove-condition="${index}">Remove</button>
    </div>`;
  }

  function bindBranchEditor(section,node) {
    const index = Number(section.dataset.branchIndex);
    const branch = node.branches[index];
    const target = section.querySelector('[data-branch-field="targetNodeId"]'); target.value = branch.targetNodeId;
    for (const input of section.querySelectorAll('[data-branch-field]')) input.addEventListener('input', () => {
      branch[input.dataset.branchField] = input.value; markDirty(); renderCanvas(); renderPreview();
    });
    section.querySelector('[data-remove-branch]').addEventListener('click', () => {
      node.branches.splice(index,1); markDirty(); renderNodeProperties(); renderCanvas(); renderPreview();
    });
    section.querySelector('[data-condition-mode]').addEventListener('change', (event) => {
      branch.condition ||= { mode:'all', rules:[] }; branch.condition.mode = event.target.value; markDirty();
    });
    for (const ruleElement of section.querySelectorAll('.song-condition-rule')) bindConditionRule(ruleElement,branch,node);
    section.querySelector('[data-add-condition]').addEventListener('click', () => {
      branch.condition ||= { mode:'all', rules:[] };
      branch.condition.rules.push({ field:'runtime.answer', operator:'equals', value:'' });
      markDirty(); renderNodeProperties();
    });
    section.querySelector('[data-branch-action]').addEventListener('change', (event) => {
      const config = branch.actions?.[0]?.config || {};
      branch.actions = event.target.value === 'none' ? [] : [{ type:event.target.value, config }];
      markDirty(); renderNodeProperties();
    });
    section.querySelector('[data-branch-config]').addEventListener('change', (event) => {
      if (!branch.actions?.length) return;
      const parsed = parseJsonInput(event.target.value); if (parsed == null) return;
      branch.actions[0].config = parsed; markDirty();
    });
  }

  function bindConditionRule(element,branch) {
    const index = Number(element.dataset.ruleIndex);
    for (const input of element.querySelectorAll('[data-rule-field]')) input.addEventListener('input', () => {
      branch.condition.rules[index][input.dataset.ruleField] = input.value; markDirty();
    });
    element.querySelector('[data-remove-condition]').addEventListener('click', () => {
      branch.condition.rules.splice(index,1);
      if (!branch.condition.rules.length) branch.condition = null;
      markDirty(); renderNodeProperties();
    });
  }

  function renderVariables() {
    const script = state.current;
    el('scriptName').value = script?.name || '';
    el('scriptDescription').value = script?.description || '';
    el('scriptLanguage').value = script?.languageCode || 'en-US';
    el('scriptService').disabled = false;
    el('scriptLanguage').disabled = false;
    el('applyScriptLanguage').hidden = true;
    if (script) {
      el('scriptService').value = script.serviceType;
      el('scriptService').disabled = Boolean(script.publishedVersionId);
      renderLanguageAction();
    }
    const variables = script?.graph?.variables || [];
    el('variableList').innerHTML = variables.length ? variables.map((item,index) => `<section class="song-variable" data-variable-index="${index}">
      <div class="song-variable-grid">
        <label>Key<input data-variable-field="key" value="${escapeHtml(item.key)}" /></label>
        <label>Label<input data-variable-field="label" value="${escapeHtml(item.label)}" /></label>
      </div>
      <label>Source<input data-variable-field="source" value="${escapeHtml(item.source)}" readonly title="Choose fields through the variable picker" /></label>
      <label>Default<input data-variable-field="defaultValue" value="${escapeHtml(item.defaultValue || '')}" /></label>
      <footer><button type="button" class="song-text-button danger" data-remove-variable="${index}">Remove</button></footer>
    </section>`).join('') : '<div class="song-property-empty">No variables configured.</div>';
    for (const section of el('variableList').querySelectorAll('.song-variable')) {
      const index = Number(section.dataset.variableIndex);
      for (const input of section.querySelectorAll('[data-variable-field]')) input.addEventListener('input', () => {
        variables[index][input.dataset.variableField] = input.value; markDirty(); renderPreview();
      });
      section.querySelector('[data-remove-variable]').addEventListener('click', () => {
        variables.splice(index,1); markDirty(); renderVariables(); renderPreview();
      });
    }
  }

  function renderLanguageAction() {
    const button = el('applyScriptLanguage');
    const current = state.current;
    button.hidden = !current?.publishedVersionId
      || el('scriptLanguage').value.trim() === current.languageCode;
  }

  async function applyScriptLanguage() {
    if (!state.current?.publishedVersionId) return;
    if (state.dirty) return showAlert('error','Save or discard draft changes before changing the published language.');
    const languageCode = el('scriptLanguage').value.trim();
    if (!languageCode || languageCode === state.current.languageCode) return renderLanguageAction();
    if (!confirm(`Change this published script from ${state.current.languageCode} to ${languageCode}? A new immutable version will be created.`)) {
      el('scriptLanguage').value = state.current.languageCode;
      return renderLanguageAction();
    }
    try {
      const data = await api(`/api/song/scripts/${encodeURIComponent(state.current.id)}/language`, {
        method:'POST', body:JSON.stringify({ ...scope(), languageCode }),
      });
      state.current = data.script;
      const index = state.scripts.findIndex((item) => item.id === state.current.id);
      if (index >= 0) state.scripts[index] = { ...state.scripts[index], ...state.current, graph:undefined };
      renderCurrent();
      showAlert('success', data.version
        ? `Language changed to ${state.current.languageCode}. Published version ${data.version.number} is now active.`
        : `Language changed to ${state.current.languageCode}.`);
    } catch (error) {
      el('scriptLanguage').value = state.current.languageCode;
      renderLanguageAction();
      showError(error);
    }
  }

  function renderPreview() {
    const node = selectedNode();
    if (!node) { el('previewStep').textContent = 'No step selected'; el('previewContent').textContent = 'Select a node to preview the agent experience.'; return; }
    el('previewStep').textContent = node.title;
    const prompt = interpolate(node.prompt || 'No prompt configured.', sampleVariables());
    el('previewContent').innerHTML = `<h3>${escapeHtml(node.title)}</h3><p>${escapeHtml(prompt)}</p>${node.helperText ? `<p class="muted">${escapeHtml(node.helperText)}</p>` : ''}<div class="song-preview-branches">${node.branches.map((branch) => `<span>${escapeHtml(branch.label)} -> ${escapeHtml(nodeById(branch.targetNodeId)?.title || 'Missing target')}</span>`).join('')}</div>`;
  }

  function addNode() {
    if (!state.current) return;
    const type = el('newNodeType').value;
    const id = uniqueId(type);
    const viewport = el('canvasViewport');
    const node = {
      id, type, title:nodeTypeLabels[type] || 'Step', goal:'', prompt:'', helperText:'',
      required:true, trackAnalytics:true,
      position:{ x:Math.round((viewport.scrollLeft + viewport.clientWidth/2) / state.zoom - 109), y:Math.round((viewport.scrollTop + 100) / state.zoom) },
      actions:type === 'end' ? [{ type:'complete_script', config:{} }] : [], branches:[],
    };
    state.current.graph.nodes.push(node); state.selectedNodeId = id; markDirty(); renderCurrent();
  }

  function deleteSelectedNode() {
    const graph = state.current?.graph; const id = state.selectedNodeId;
    if (!graph || !id) return;
    if (graph.nodes.length === 1) return showAlert('warning','A script must keep at least one step.');
    if (!confirm(`Delete ${nodeById(id)?.title || id}? Incoming branches will be cleared.`)) return;
    graph.nodes = graph.nodes.filter((node) => node.id !== id);
    for (const node of graph.nodes) for (const branch of node.branches) if (branch.targetNodeId === id) branch.targetNodeId = '';
    if (graph.startNodeId === id) graph.startNodeId = graph.nodes[0]?.id || '';
    state.selectedNodeId = graph.startNodeId; markDirty(); renderCurrent();
  }

  function setSelectedStart() {
    if (!state.current || !state.selectedNodeId) return;
    state.current.graph.startNodeId = state.selectedNodeId; markDirty(); renderCanvas(); renderNodeProperties();
  }

  function addBranch() {
    const node = selectedNode(); if (!node) return;
    const target = state.current.graph.nodes.find((item) => item.id !== node.id)?.id || '';
    node.branches.push({
      id:uniqueBranchId(node), label:'Next', outcome:'next', targetNodeId:target,
      color:'#5f6b7a', condition:null, actions:[],
    });
    markDirty(); renderNodeProperties(); renderCanvas(); renderPreview();
  }

  function openVariablePicker(mode) {
    if (!state.current) return;
    if (mode === 'insert' && !selectedNode()) return;
    state.variablePickerMode = mode;
    const textarea = el('nodePrompt');
    state.variableInsertion = mode === 'insert' ? {
      nodeId:state.selectedNodeId,
      start:textarea.selectionStart ?? textarea.value.length,
      end:textarea.selectionEnd ?? textarea.value.length,
    } : null;
    el('variablePickerTitle').textContent = mode === 'insert' ? 'Insert variable' : 'Add script variable';
    el('variableSearch').value = '';
    const groups = [...new Set(variableCatalog().map((item) => item.group || 'Other'))].sort();
    el('variableGroup').innerHTML = option('','All categories') + groups.map((group) => option(group,group)).join('');
    renderVariablePicker();
    el('variablePickerDialog').showModal();
    setTimeout(() => el('variableSearch').focus(), 0);
  }

  function variableCatalog() {
    const catalog = [...(state.bootstrap?.variableCatalog || [])];
    const seen = new Set(catalog.map((item) => item.source));
    for (const item of state.current?.graph?.variables || []) {
      if (seen.has(item.source)) continue;
      catalog.push({ key:item.key, label:item.label || item.key, source:item.source, group:'Script variables', dataType:'runtime' });
      seen.add(item.source);
    }
    return catalog;
  }

  function renderVariablePicker() {
    const search = el('variableSearch').value.trim().toLowerCase();
    const group = el('variableGroup').value;
    const declared = state.current?.graph?.variables || [];
    const matches = variableCatalog().filter((item) => {
      if (group && item.group !== group) return false;
      if (!search) return true;
      return [item.label,item.key,item.source,item.group,item.dataType].some((value) => String(value || '').toLowerCase().includes(search));
    });
    state.variablePickerResults = matches.slice(0,200);
    el('variablePickerSummary').textContent = `${matches.length} field${matches.length === 1 ? '' : 's'} found${matches.length > 200 ? ' | showing first 200' : ''} | ${declared.length} of 50 declared`;
    el('variablePickerList').innerHTML = state.variablePickerResults.length
      ? state.variablePickerResults.map((item,index) => {
        const existing = declared.find((variable) => variable.source === item.source);
        return `<button type="button" class="song-variable-choice${existing ? ' declared' : ''}" data-picker-index="${index}">
          <span class="song-variable-choice-main"><strong>${escapeHtml(item.label || item.key)}</strong><small>${escapeHtml(item.group || 'Other')} | ${escapeHtml(item.dataType || 'string')}</small></span>
          <code>{{${escapeHtml(existing?.key || item.key || 'field')}}}</code>
          <span class="song-variable-choice-state">${existing ? 'Added' : 'Add'}</span>
        </button>`;
      }).join('')
      : '<div class="song-property-empty song-variable-picker-empty">No fields match this search.</div>';
    for (const button of el('variablePickerList').querySelectorAll('[data-picker-index]')) {
      button.addEventListener('click', () => chooseVariable(Number(button.dataset.pickerIndex)));
    }
  }

  function chooseVariable(index) {
    const field = state.variablePickerResults[index];
    if (!field || !state.current) return;
    const variables = state.current.graph.variables;
    let variable = variables.find((item) => item.source === field.source);
    if (!variable) {
      if (variables.length >= 50) return showAlert('warning','This script already has the maximum 50 variables.');
      variable = {
        key:uniqueVariableKey(field.key || field.label),
        label:field.label || field.key || 'Variable',
        source:field.source,
        defaultValue:'',
      };
      variables.push(variable);
      markDirty();
    }
    el('variablePickerDialog').close();
    if (state.variablePickerMode === 'insert') insertVariableToken(variable.key);
    else { switchTab('variables'); renderVariables(); renderPreview(); }
  }

  function insertVariableToken(key) {
    const insertion = state.variableInsertion;
    const node = insertion ? nodeById(insertion.nodeId) : selectedNode();
    if (!node) return;
    const token = `{{${key}}}`;
    const start = insertion?.start ?? node.prompt.length;
    const end = insertion?.end ?? start;
    node.prompt = String(node.prompt || '').slice(0,start) + token + String(node.prompt || '').slice(end);
    state.selectedNodeId = node.id;
    markDirty(); renderNodeProperties(); renderCanvas(); renderPreview();
    const textarea = el('nodePrompt');
    const cursor = start + token.length;
    textarea.focus(); textarea.setSelectionRange(cursor,cursor);
  }

  function markDirty() { state.dirty = true; renderHeader(); }

  async function saveDraft(notify = false) {
    if (!state.current) return false;
    try {
      const data = await api(`/api/song/scripts/${encodeURIComponent(state.current.id)}/draft`, {
        method:'PUT',
        body:JSON.stringify({
          ...scope(), expectedRevision:state.current.draftRevision,
          name:state.current.name, description:state.current.description,
          serviceType:state.current.serviceType, languageCode:state.current.languageCode,
          graph:state.current.graph,
        }),
      });
      state.current = data.script; state.dirty = false;
      const index = state.scripts.findIndex((item) => item.id === state.current.id);
      if (index >= 0) state.scripts[index] = { ...state.scripts[index], ...state.current, graph:undefined };
      renderCurrent(); showValidation(data.validation);
      if (notify) showAlert('success',`Draft revision ${state.current.draftRevision} saved.`);
      return true;
    } catch (error) { showError(error); return false; }
  }

  async function validateCurrent() {
    if (!state.current) return;
    try {
      const data = await api(`/api/song/scripts/${encodeURIComponent(state.current.id)}/validate`, {
        method:'POST', body:JSON.stringify({ ...scope(), graph:state.current.graph }),
      });
      showValidation(data.validation, true);
    } catch (error) { showError(error); }
  }

  function showValidation(validation, notify = false) {
    if (!validation) return;
    const panel = el('validationPanel');
    const issues = [...(validation.errors || []), ...(validation.warnings || [])];
    panel.className = `song-validation ${validation.valid ? '' : 'error'}`;
    panel.innerHTML = `<strong>${validation.valid ? 'Ready to publish' : `${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'}`}</strong><div>${issues.length ? `<ul>${issues.slice(0,8).map((item) => `<li>${escapeHtml(item.message)}${item.nodeId ? ` (${escapeHtml(item.nodeId)})` : ''}</li>`).join('')}</ul>` : `${validation.stats.nodes} steps and ${validation.stats.branches} branches validated.`}</div><button type="button" aria-label="Close">x</button>`;
    panel.hidden = false;
    if (notify && validation.valid) showAlert('success','Script validation passed.');
  }

  async function publishCurrent() {
    if (!state.current) return;
    if (state.dirty && !(await saveDraft(false))) return;
    try {
      const data = await api(`/api/song/scripts/${encodeURIComponent(state.current.id)}/publish`, {
        method:'POST', body:JSON.stringify({ ...scope(), expectedRevision:state.current.draftRevision }),
      });
      state.current = data.script; state.dirty = false;
      showValidation(data.validation);
      showAlert('success',`Published version ${data.version.number}. ${state.current.serviceType} now resolves to this exact snapshot.`);
      await loadScripts(state.current.id);
    } catch (error) {
      if (error.details) showValidation(error.details);
      showError(error);
    }
  }

  async function runScriptAction() {
    const action = el('scriptActions').value; el('scriptActions').value = '';
    if (!action) return;
    if (action === 'import_vibe') {
      el('vibeImportJson').value = '';
      el('vibeImportPreview').hidden = true;
      el('applyVibeImport').disabled = true;
      return el('vibeImportDialog').showModal();
    }
    if (!state.current) return;
    if (action === 'clone') {
      const name = prompt('Name for the cloned script', `${state.current.name} Copy`); if (!name) return;
      try {
        const data = await api(`/api/song/scripts/${encodeURIComponent(state.current.id)}/clone`, {
          method:'POST', body:JSON.stringify({ ...scope(), name }),
        });
        showAlert('success','Script cloned as an independent draft.'); await loadScripts(data.script.id);
      } catch (error) { showError(error); }
    }
    if (action === 'archive') {
      if (!confirm('Archive this script and remove its active service assignment?')) return;
      try {
        await api(`/api/song/scripts/${encodeURIComponent(state.current.id)}/archive`, {
          method:'POST', body:JSON.stringify(scope()),
        });
        showAlert('success','Script archived.'); await loadScripts();
      } catch (error) { showError(error); }
    }
  }

  function parsedVibeServices() {
    let value;
    try { value = JSON.parse(el('vibeImportJson').value); }
    catch { throw new Error('Vibe import must be valid JSON.'); }
    const services = Array.isArray(value) ? value : value?.services;
    if (!Array.isArray(services) || !services.length) throw new Error('Vibe import JSON must contain a non-empty services array.');
    return services;
  }

  async function loadVibeSample() {
    try {
      const response = await fetch('/data/song-vibe-template.json', { cache:'no-store' });
      if (!response.ok) throw new Error(`Sample template could not be loaded (${response.status}).`);
      el('vibeImportJson').value = JSON.stringify(await response.json(), null, 2);
      el('vibeImportPreview').hidden = true;
      el('applyVibeImport').disabled = true;
      showAlert('success','Sample template loaded. Edit it, then preview the generated flows.');
    } catch (error) { showError(error); }
  }

  async function previewVibeImport() {
    try {
      const data = await api('/api/song/imports/vibe/preview', {
        method:'POST', body:JSON.stringify({ ...scope(), services:parsedVibeServices() }),
      });
      const box = el('vibeImportPreview');
      box.hidden = false;
      box.innerHTML = `<strong>${data.imports.length} script${data.imports.length === 1 ? '' : 's'} prepared</strong><ul>${data.imports.map((item) => {
        const errors = item.validation.errors || [];
        return `<li class="${errors.length ? 'invalid' : ''}">${escapeHtml(item.serviceType)} | ${item.validation.stats.nodes} steps, ${item.validation.stats.branches} branches | ${errors.length ? `${errors.length} errors` : 'valid'}</li>`;
      }).join('')}</ul>`;
      el('applyVibeImport').disabled = data.imports.some((item) => !item.validation.valid);
    } catch (error) { showError(error); el('applyVibeImport').disabled = true; }
  }

  async function applyVibeImport() {
    try {
      const data = await api('/api/song/imports/vibe/apply', {
        method:'POST', body:JSON.stringify({
          ...scope(), services:parsedVibeServices(), conflictPolicy:el('vibeConflictPolicy').value,
        }),
      });
      el('vibeImportDialog').close();
      const created = data.results.filter((item) => item.action === 'created').length;
      const updated = data.results.filter((item) => item.action === 'updated_draft').length;
      const skipped = data.results.filter((item) => item.action === 'skipped').length;
      showAlert('success',`Vibe import complete: ${created} created, ${updated} updated, ${skipped} skipped.`);
      await loadScripts(data.results.find((item) => item.scriptId)?.scriptId || null);
    } catch (error) { showError(error); }
  }

  function openNewScript() {
    if (!scope().locationId) return showAlert('warning','Select a location first.');
    el('newScriptName').value = ''; el('newScriptDescription').value = '';
    el('newScriptLanguage').value = 'en-US';
    el('newScriptDialog').showModal(); el('newScriptName').focus();
  }

  async function createNewScript(event) {
    event.preventDefault();
    try {
      const data = await api('/api/song/scripts', {
        method:'POST', body:JSON.stringify({
          ...scope(), name:el('newScriptName').value,
          serviceType:el('newScriptService').value,
          languageCode:el('newScriptLanguage').value,
          description:el('newScriptDescription').value,
        }),
      });
      el('newScriptDialog').close(); showAlert('success','Script draft created.'); await loadScripts(data.script.id);
    } catch (error) { showError(error); }
  }

  async function openTestFlow() {
    if (!state.current) return;
    try {
      const data = await api(`/api/song/scripts/${encodeURIComponent(state.current.id)}/validate`, {
        method:'POST', body:JSON.stringify({ ...scope(), graph:state.current.graph }),
      });
      if (!data.validation.valid) {
        showValidation(data.validation);
        return showAlert('warning','Resolve validation errors before testing the flow.');
      }
      el('testTitle').textContent = state.current.name; el('testFlowDialog').showModal(); restartTest();
    } catch (error) { showError(error); }
  }

  function restartTest() {
    state.testNodeId = state.current?.graph?.startNodeId || null; state.testSteps = 0; renderTestStep();
  }

  function renderTestStep() {
    const node = nodeById(state.testNodeId);
    if (!node) { el('testPrompt').textContent = 'Test flow has no valid next step.'; el('testBranches').innerHTML = ''; return; }
    state.testSteps += 1;
    el('testProgress').textContent = `Step ${state.testSteps} of maximum 100 | ${nodeTypeLabels[node.type] || node.type}`;
    el('testPrompt').innerHTML = `<h3>${escapeHtml(node.title)}</h3>${escapeHtml(interpolate(node.prompt || node.helperText || 'Complete this step.', sampleVariables()))}`;
    if (state.testSteps >= 100) {
      el('testBranches').innerHTML = '<button type="button" disabled>Transition ceiling reached</button>'; return;
    }
    el('testBranches').innerHTML = node.branches.length
      ? node.branches.map((branch) => `<button type="button" data-test-target="${escapeHtml(branch.targetNodeId)}">${escapeHtml(branch.label)}</button>`).join('')
      : '<button type="button" disabled>End of flow</button>';
    for (const button of el('testBranches').querySelectorAll('[data-test-target]')) button.addEventListener('click', () => {
      state.testNodeId = button.dataset.testTarget; renderTestStep();
    });
  }

  async function loadVersions() {
    if (!state.current) return;
    try {
      const data = await api(`/api/song/scripts/${encodeURIComponent(state.current.id)}/versions?${scopeQuery()}`);
      el('versionList').innerHTML = data.versions.length ? data.versions.map((item) => `<div class="song-version-row"><div><strong>Version ${item.versionNumber}</strong><small>${formatDate(item.publishedAt)}</small></div><code>${escapeHtml(item.checksum.slice(0,12))}</code></div>`).join('') : '<div class="song-property-empty">No published versions.</div>';
    } catch (error) { showError(error); }
  }

  async function loadAnalytics() {
    if (!state.current) return;
    try {
      const data = await api(`/api/song/scripts/${encodeURIComponent(state.current.id)}/analytics?${scopeQuery()}`);
      const summary = data.summary;
      el('analyticsSummary').innerHTML = [['Events',summary.events],['Leads',summary.leads],['Completed',summary.completions],['Abandoned',summary.abandoned]].map(([label,value]) => `<div><span>${label}</span><strong>${formatNumber(value)}</strong></div>`).join('');
      el('analyticsRows').innerHTML = data.nodes.length ? data.nodes.slice(0,40).map((item) => `<div class="song-analytics-row"><span>${escapeHtml(item.nodeId || 'Script')} | ${escapeHtml(item.eventType)}${item.outcome ? ` | ${escapeHtml(item.outcome)}` : ''}</span><strong>${formatNumber(item.total)}</strong></div>`).join('') : '<div class="song-property-empty">No runtime events yet.</div>';
    } catch (error) { showError(error); }
  }

  function switchTab(tab) {
    state.activeTab = tab;
    for (const button of document.querySelectorAll('.song-property-tabs button')) button.classList.toggle('active', button.dataset.tab === tab);
    for (const panel of document.querySelectorAll('.song-property-panel')) panel.classList.toggle('active', panel.dataset.panel === tab);
    if (tab === 'variables') renderVariables();
    if (tab === 'versions') loadVersions();
    if (tab === 'analytics') loadAnalytics();
  }

  function setZoom(value) {
    state.zoom = Math.min(Math.max(Math.round(value * 10) / 10,.5),1.5);
    el('canvasSurface').style.transform = `scale(${state.zoom})`;
    el('zoomValue').textContent = `${Math.round(state.zoom*100)}%`;
  }

  function fitCanvas() {
    const nodes = state.current?.graph?.nodes || []; if (!nodes.length) return;
    const minX = Math.min(...nodes.map((node) => node.position.x));
    const maxX = Math.max(...nodes.map((node) => node.position.x + 218));
    const minY = Math.min(...nodes.map((node) => node.position.y));
    const maxY = Math.max(...nodes.map((node) => node.position.y + 130));
    const viewport = el('canvasViewport');
    setZoom(Math.min(1.2, Math.max(.5, Math.min((viewport.clientWidth-80)/(maxX-minX || 1),(viewport.clientHeight-80)/(maxY-minY || 1)))));
    viewport.scrollLeft = Math.max(0,minX*state.zoom-40); viewport.scrollTop = Math.max(0,minY*state.zoom-40);
  }

  function centerSelectedNode() {
    const node = selectedNode(); if (!node) return;
    const viewport = el('canvasViewport');
    viewport.scrollLeft = Math.max(0,node.position.x*state.zoom-viewport.clientWidth/2+109);
    viewport.scrollTop = Math.max(0,node.position.y*state.zoom-80);
  }

  function selectedNode() { return nodeById(state.selectedNodeId); }
  function nodeById(id) { return state.current?.graph?.nodes?.find((node) => node.id === id) || null; }
  function uniqueId(prefix) {
    let value = `${prefix}_${Date.now().toString(36)}`; let index = 2;
    while (nodeById(value)) value = `${prefix}_${Date.now().toString(36)}_${index++}`;
    return value.slice(0,64);
  }
  function uniqueBranchId(node) { let index=node.branches.length+1,id=`option_${index}`; while(node.branches.some((branch)=>branch.id===id))id=`option_${++index}`; return id; }
  function uniqueVariableKey(input = 'runtimeValue') {
    const words = String(input || '').replace(/[^A-Za-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
    let baseKey = words.map((word,index) => index ? word[0].toUpperCase()+word.slice(1) : word.toLowerCase()).join('');
    if (!/^[a-z]/.test(baseKey)) baseKey = `field${baseKey ? baseKey[0].toUpperCase()+baseKey.slice(1) : ''}`;
    baseKey = (baseKey || 'runtimeValue').slice(0,48);
    let key=baseKey,index=2; const values=state.current.graph.variables;
    while(values.some((item)=>item.key===key)) key=`${baseKey.slice(0,Math.max(1,48-String(index).length))}${index++}`;
    return key;
  }

  function sampleVariables() {
    const defaults = { firstName:'Marcus', lastName:'Customer', phone:'(813) 555-0100', city:'Tampa', state:'FL', agentName:'Joseph' };
    for (const item of state.current?.graph?.variables || []) if (item.defaultValue) defaults[item.key] = item.defaultValue;
    return defaults;
  }
  function interpolate(text,values) { return String(text || '').replace(/{{\s*([a-z][a-zA-Z0-9_.]*)\s*}}/g,(_,key)=>values[key] ?? `{{${key}}}`); }

  function parseJsonInput(value) {
    try { const parsed=JSON.parse(value || '{}'); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; }
    catch { showAlert('warning','Action configuration must be a JSON object.'); return null; }
  }
  function showAlert(type,message) { const box=el('alert'); box.className=`song-alert ${type === 'error' ? 'error' : type === 'warning' ? 'warning' : ''}`; box.textContent=message; box.hidden=false; clearTimeout(showAlert.timer); showAlert.timer=setTimeout(()=>{box.hidden=true;},6000); }
  function showError(error) {
    const path = error.details?.path ? ` at ${error.details.path}` : '';
    showAlert(error.status === 409 ? 'warning' : 'error', `${error.message}${path}${error.code ? ` (${error.code})` : ''}`);
    if (error.details?.errors || error.details?.warnings) showValidation(error.details);
  }
  function formatDate(value) { if (!value) return 'never'; const date=new Date(String(value).includes('T')?value:String(value).replace(' ','T')+'Z'); return Number.isNaN(date.getTime())?'unknown':date.toLocaleString(); }
  function formatNumber(value) { return new Intl.NumberFormat().format(Number(value)||0); }
  function languageLabel(value) {
    const code = String(value || 'en-US');
    try {
      const locale = new Intl.Locale(code);
      const name = new Intl.DisplayNames([navigator.language || 'en'], { type:'language' }).of(locale.language);
      return `${name || code} (${code})`;
    } catch { return code; }
  }
  function option(value,label,selected=false) { return `<option value="${escapeHtml(value)}" ${selected?'selected':''}>${escapeHtml(label)}</option>`; }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g,(char)=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }
  function cssEscape(value) { return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^A-Za-z0-9_-]/g,'\\$&'); }
  function isTypingTarget(target) { return target && ['INPUT','TEXTAREA','SELECT'].includes(target.tagName); }
})();
