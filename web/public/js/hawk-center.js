(() => {
  'use strict';

  const base = location.pathname.replace(/\/(?:hawk|admin\/hawk\.html)\/?$/, '') || '';
  const state = {
    bootstrap: null,
    flows: [],
    folders: [],
    libraryFolderId: 'all',
    current: null,
    selectedNodeId: null,
    selectedExecutionId: null,
    executions: [],
    scale: 1,
    dirty: false,
    executionStatus: '',
    fieldCatalog: { fields: [], objects: [], total: 0 },
    fieldPicker: null,
    importPackage: null,
    importPreview: null,
    paletteCollapsed: false,
    inspectorExpanded: false,
    executionCollapsed: false,
    testInputMode: 'guided',
    testRecords: [],
    selectedTestRecord: null,
    webhookEndpoint: null,
    webhookSecret: '',
    webhookSampleNodeId: null,
  };
  const el = (id) => document.getElementById(id);
  const typeLabels = { trigger: 'Trigger', condition: 'Condition', action: 'Action', end: 'End' };
  const actionLabels = { 'ghl.update_contact': 'Update Contact', 'ghl.add_tags': 'Add Tags', 'data.set': 'Set Flow Data', 'parrot.run':'Run PARROT Script', 'parrot.inline':'Bundle Python with HAWK', 'code.run': 'Custom Code' };
  const triggerLabels = {
    manual: 'Manual', 'contact.tag_added': 'Tag Added', 'contact.tag_removed': 'Tag Removed',
    'contact.field_changed': 'Field Updated', 'contact.created': 'New Contact',
    'contact.updated': 'Contact Updated', 'opportunity.created': 'New Opportunity',
    'opportunity.updated': 'Opportunity Updated', 'appointment.created': 'Appointment Created',
    'form.submitted': 'Form Submitted',
  };

  function wireNav() {
    const paths = { navHome: '', navOwl: '/owl', navEagle: '/eagle', navSong: '/song', navParrot:'/parrot', navSentinel: '/sentinel', navDocs: '/docs' };
    for (const [id, suffix] of Object.entries(paths)) el(id).href = base + suffix;
    el('logout').onclick = async (event) => {
      event.preventDefault();
      await fetch(base + '/logout', { method: 'POST' });
      location.href = base + '/login';
    };
  }

  function wireEvents() {
    el('apiKey').addEventListener('change', () => loadBootstrap(el('apiKey').value));
    el('dataSource').addEventListener('change', () => loadBootstrap(el('apiKey').value, '', el('dataSource').value));
    el('location').addEventListener('change', () => loadBootstrap(el('apiKey').value, el('location').value, el('dataSource').value));
    el('connection').addEventListener('change', () => {
      if (!state.current) return;
      state.current.integrationId = el('connection').value || null;
      el('planConnection').textContent = selectedOptionText(el('connection')) || 'No connection selected';
      markDirty();
      loadFieldCatalog().catch((error) => showAlert('error', error.message));
    });
    el('flowPicker').addEventListener('change', async () => {
      if (state.dirty && !window.confirm('Discard unsaved HAWK changes?')) {
        el('flowPicker').value = state.current?.id || '';
        return;
      }
      if (el('flowPicker').value) await loadFlow(el('flowPicker').value);
    });
    el('flowDescription').addEventListener('input', () => {
      if (!state.current) return;
      state.current.description = el('flowDescription').value;
      markDirty();
    });
    el('newFlowButton').onclick = openNewFlow;
    el('flowLibraryButton').onclick = openFlowLibrary;
    el('refreshCatalogButton').onclick = refreshFieldCatalog;
    el('importButton').onclick = openImport;
    el('exportButton').onclick = exportCurrentFlow;
    el('flowCodeButton').onclick = openFlowCode;
    el('newFlowForm').addEventListener('submit', createFlow);
    el('folderForm').addEventListener('submit', saveFolder);
    el('createFolderButton').onclick = () => openFolderDialog();
    el('deleteFolderButton').onclick = deleteFolder;
    el('flowLibrarySearch').addEventListener('input', renderFlowLibrary);
    el('showArchivedFlows').addEventListener('change', renderFlowLibrary);
    el('flowFolderList').addEventListener('click', handleFolderListClick);
    el('flowLibraryList').addEventListener('click', handleFlowLibraryClick);
    el('flowLibraryList').addEventListener('change', handleFlowLibraryChange);
    el('validateButton').onclick = validateCurrent;
    el('publishButton').onclick = publishCurrent;
    el('stateButton').onclick = toggleState;
    el('testButton').onclick = openTest;
    el('testStepButton').onclick = openTest;
    el('runTestButton').onclick = runTest;
    el('refreshExecutions').onclick = loadExecutions;
    el('togglePaletteButton').onclick = () => { state.paletteCollapsed = !state.paletteCollapsed; applyWorkspaceLayout(); };
    el('toggleInspectorButton').onclick = () => { state.inspectorExpanded = !state.inspectorExpanded; applyWorkspaceLayout(); };
    el('toggleExecutionConsole').onclick = () => { state.executionCollapsed = !state.executionCollapsed; applyWorkspaceLayout(); };
    el('replayButton').onclick = replaySelected;
    el('zoomIn').onclick = () => setZoom(state.scale + 0.1);
    el('zoomOut').onclick = () => setZoom(state.scale - 0.1);
    el('fitCanvas').onclick = fitCanvas;
    el('deleteNode').onclick = deleteSelectedNode;
    el('conditionFieldButton').onclick = () => openFieldPicker({ current: el('conditionField').value, onSelect: (field) => {
      updateNode((node) => { node.config.field = field.runtimePath; }, true);
      el('conditionField').value = field.runtimePath;
      setFieldButton(el('conditionFieldButton'), field.runtimePath);
      renderConditionValueHints(field.runtimePath);
    } });
    el('triggerFieldButton').onclick = () => openFieldPicker({ current: selectedNode()?.config?.fieldPath, onSelect: (field) => {
      updateNode((node) => { node.config.field = field.fieldId || field.fieldKey || field.runtimePath; node.config.fieldPath = field.runtimePath; }, true);
      setFieldButton(el('triggerFieldButton'), field.runtimePath);
    } });
    el('contactIdFieldButton').onclick = () => openTemplatePicker('contactId');
    el('dataValueFieldButton').onclick = () => openTemplatePicker('dataValue');
    el('browseCatalogButton').onclick = () => openFieldPicker({ onSelect: () => {} });
    el('addMappingButton').onclick = () => addMappingRow();
    el('addCodeInputButton').onclick = () => addCodeInputRow();
    el('expandCodeEditorButton').onclick = focusCodeEditor;
    el('addTestInputButton').onclick = () => addTestInputRow();
    el('searchTestRecordsButton').onclick = searchTestRecords;
    el('testRecordSearch').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); searchTestRecords(); } });
    el('testRecordSource').addEventListener('change', () => { state.testRecords = []; state.selectedTestRecord = null; renderTestRecordResults(); });
    el('testRecordResults').addEventListener('click', selectTestRecord);
    el('provisionWebhookButton').onclick = () => provisionWebhook(false);
    el('rotateWebhookButton').onclick = () => provisionWebhook(true);
    el('disableWebhookButton').onclick = disableWebhook;
    el('copyWebhookUrl').onclick = () => copyText(el('webhookUrl').value, 'Webhook URL copied.');
    el('copyWebhookSecret').onclick = () => copyText(el('webhookSecret').value, 'Webhook secret copied.');
    el('refreshWebhookSampleButton').onclick = resetWebhookSample;
    el('sendWebhookSampleButton').onclick = sendWebhookSample;
    el('actionTags').addEventListener('input', syncGuidedAction);
    el('dataKey').addEventListener('input', syncGuidedAction);
    el('codeLanguage').addEventListener('change', syncGuidedAction);
    el('codeSource').addEventListener('input', syncGuidedAction);
    el('runtimeSearch').addEventListener('input', renderRuntimeBrowser);
    el('runtimeObjectFilter').addEventListener('change', renderRuntimeBrowser);
    el('fieldSearch').addEventListener('input', renderFieldPicker);
    el('fieldObjectFilter').addEventListener('change', renderFieldPicker);
    el('importFile').addEventListener('change', readImportFile);
    el('previewImportButton').onclick = previewImport;
    el('applyImportButton').onclick = applyImport;
    el('downloadLiveSchema').onclick = downloadLiveSchema;
    el('copyFlowCodeButton').onclick = () => copyText(el('flowCodeSource').value, 'Flow JSON copied.');
    el('downloadFlowCodeButton').onclick = downloadFlowCode;
    el('formatFlowCodeButton').onclick = formatFlowCode;
    el('validateFlowCodeButton').onclick = validateFlowCode;
    el('saveFlowCodeButton').onclick = saveFlowCode;
    el('flowCodeSource').addEventListener('input', () => setFlowCodeStatus('JSON changed. Validate before saving.', ''));

    for (const button of document.querySelectorAll('.palette-tabs button')) {
      button.onclick = () => selectPalette(button.dataset.palette);
    }
    document.querySelector('.hawk-palette').addEventListener('click', (event) => {
      const button = event.target.closest('.palette-item');
      if (button) addNode(button.dataset.addType, button.dataset.event, button.dataset.action);
    });
    el('stepSearch').addEventListener('input', filterPalette);
    for (const button of document.querySelectorAll('.inspector-tabs button')) {
      button.onclick = () => selectInspectorTab(button.dataset.inspectorTab);
    }
    for (const button of document.querySelectorAll('[data-test-input-mode]')) {
      button.onclick = () => selectTestInputMode(button.dataset.testInputMode);
    }
    for (const button of document.querySelectorAll('.execution-detail>nav button')) {
      button.onclick = () => selectExecutionTab(button.dataset.executionTab);
    }
    for (const button of document.querySelectorAll('.execution-filters button')) {
      button.onclick = () => {
        state.executionStatus = button.dataset.status;
        document.querySelectorAll('.execution-filters button').forEach((item) => item.classList.toggle('active', item === button));
        loadExecutions();
      };
    }
    for (const button of document.querySelectorAll('.hawk-section-nav button')) {
      button.onclick = () => switchSection(button.dataset.view, button);
    }
    wireInspectorFields();
  }

  function wireInspectorFields() {
    el('nodeName').addEventListener('input', () => updateNode((node) => { node.name = el('nodeName').value; }, true));
    el('nodeType').addEventListener('change', () => updateNodeType(el('nodeType').value));
    el('triggerEvent').addEventListener('change', () => updateNode((node) => {
      node.config.event = el('triggerEvent').value;
      node.name = triggerLabels[node.config.event] || titleCase(node.config.event);
      delete node.config.tag; delete node.config.field; delete node.config.fieldPath; delete node.config.filter;
      delete node.config.objectKey; delete node.config.channel; delete node.config.eventName;
    }, false, true));
    el('triggerFilter').addEventListener('input', () => updateNode((node) => {
      const value = el('triggerFilter').value;
      const definition = triggerDefinitionFor(node.config.event);
      delete node.config.tag; delete node.config.filter; delete node.config.objectKey; delete node.config.channel; delete node.config.eventName;
      if (definition?.filterKey) node.config[definition.filterKey] = value;
      else node.config.filter = value;
    }));
    el('conditionOperator').addEventListener('change', () => updateNode((node) => {
      node.config.operator = el('conditionOperator').value;
      node.config.value = conditionInputValue();
    }));
    el('conditionValue').addEventListener('input', () => updateNode((node) => { node.config.value = conditionInputValue(); }));
    el('conditionYes').addEventListener('change', () => updateConditionRoute(true, el('conditionYes').value));
    el('conditionNo').addEventListener('change', () => updateConditionRoute(false, el('conditionNo').value));
    el('nodeAction').addEventListener('change', () => updateNode((node) => {
      node.action = el('nodeAction').value;
      node.name = actionLabels[node.action] || titleCase(node.action);
      node.config = defaultActionConfig(node.action);
    }, false, true));
    el('nodeConfig').addEventListener('change', () => {
      try {
        const parsed = JSON.parse(el('nodeConfig').value || '{}');
        updateNode((node) => { node.config = parsed; });
      } catch { showAlert('error', 'Action configuration must be valid JSON.'); }
    });
    el('nextNode').addEventListener('change', () => updateNode((node) => { node.nextNodeId = el('nextNode').value || undefined; }));
  }

  async function init() {
    wireNav();
    wireEvents();
    populateStaticCatalogs();
    try {
      await loadBootstrap();
    } catch (error) {
      if (error.status === 401) location.href = base + '/login?next=' + encodeURIComponent(location.pathname);
      else showAlert('error', error.message);
    }
  }

  function populateStaticCatalogs() {
    el('nodeType').innerHTML = Object.entries(typeLabels).map(([value, label]) => option(value, label)).join('');
    el('nodeAction').innerHTML = Object.entries(actionLabels).map(([value, label]) => option(value, label)).join('');
  }

  async function loadBootstrap(apiKeyId = '', locationId = '', dataSourceSlug = '') {
    const query = new URLSearchParams();
    if (apiKeyId) query.set('apiKeyId', apiKeyId);
    if (locationId) query.set('locationId', locationId);
    if (dataSourceSlug) query.set('dataSourceSlug', dataSourceSlug);
    state.bootstrap = await api('/api/hawk/bootstrap' + (query.size ? `?${query}` : ''));
    state.fieldCatalog = state.bootstrap.fieldCatalog || { fields: [], objects: [], total: 0 };
    const selectedKey = state.bootstrap.selectedKey?.id || '';
    fillSelect(el('apiKey'), state.bootstrap.keys || [], selectedKey, (item) => item.id, (item) => item.name || item.keyPrefix || item.id);
    fillSelect(el('dataSource'), state.bootstrap.dataSources || [], state.bootstrap.dataSourceSlug || '', (item) => item.slug, (item) => item.name);
    const locationContext=new Map((state.bootstrap.locationContexts||[]).map((item)=>[item.locationId,item]));
    fillSelect(el('location'), state.bootstrap.locations || [], state.bootstrap.locationId || '', (item) => item, (item) => {
      const context=locationContext.get(item);const suffix=context?.databaseDiscovered&&context?.integrationGranted?'API + database':context?.integrationGranted?'API-bound':'database only';
      return `${item} · ${suffix}`;
    });
    fillConnections();
    applyCapabilityCatalogs();
    fillTriggerCatalogs();
    renderCatalogSummary();
    await loadFlows();
  }

  function fillTriggerCatalogs() {
    const triggerTypes = state.bootstrap?.triggerTypes || Object.keys(triggerLabels);
    el('triggerEvent').innerHTML = triggerTypes.map((value) => option(value, triggerLabels[value] || titleCase(value))).join('');
    const operators = state.bootstrap?.conditionOperators || [];
    el('conditionOperator').innerHTML = operators.map((value) => option(value, titleCase(value))).join('');
  }

  function applyCapabilityCatalogs() {
    for (const definition of state.bootstrap?.actionDefinitions || []) actionLabels[definition.id] = definition.label;
    for (const definition of state.bootstrap?.triggerDefinitions || []) triggerLabels[definition.id] = definition.label;
    const actionTypes = state.bootstrap?.actionTypes || Object.keys(actionLabels);
    el('nodeAction').innerHTML = actionTypes.map((value) => option(value, actionLabels[value] || titleCase(value))).join('');
    renderCapabilityPalettes();
  }

  function renderCapabilityPalettes() {
    const triggers = state.bootstrap?.triggerDefinitions || [];
    el('triggerPalette').innerHTML = triggers.map((item) => `<button type="button" class="palette-item" data-add-type="trigger" data-event="${escapeHtml(item.id)}"><i class="green">${triggerGlyph(item.object)}</i><span>${escapeHtml(item.label)}<small>${escapeHtml(item.description)}</small></span>${item.id === 'manual' ? '' : '<b class="adapter-badge">Webhook</b>'}</button>`).join('');
    const actions = state.bootstrap?.actionDefinitions || [];
    const groups = [...new Set(actions.map((item) => item.group))];
    el('actionPalette').innerHTML = groups.map((group) => `<span class="palette-label split">${escapeHtml(group)}</span>${actions.filter((item) => item.group === group).map((item) => `<button type="button" class="palette-item" data-add-type="action" data-action="${escapeHtml(item.id)}"><i class="${item.group === 'HAWK' ? 'purple' : 'blue'}">${actionGlyph(item.group)}</i><span>${escapeHtml(item.label)}<small>${escapeHtml(item.description)}</small></span></button>`).join('')}`).join('');
  }

  function triggerGlyph(object) {
    return ({ Contact: '●', Opportunity: '◫', Appointment: '◷', Task: '✓', Conversation: '✉', Form: '▧', Object: '⬡', HAWK: '▶' })[object] || '◆';
  }

  function actionGlyph(group) {
    return ({ Contacts: '●', Opportunities: '◫', Conversations: '✉', Calendars: '◷', Objects: '⬡', HAWK: '{ }', PARROT:'P' })[group] || '◆';
  }

  function triggerDefinitionFor(id) { return (state.bootstrap?.triggerDefinitions || []).find((item) => item.id === id); }
  function actionDefinitionFor(id) { return (state.bootstrap?.actionDefinitions || []).find((item) => item.id === id); }

  function fillConnections() {
    const connections = state.bootstrap?.connections || [];
    const html = `<option value="">Select connection</option>` + connections.map((item) => option(item.id, `${item.name} · ${item.provider}${item.capabilities?.manageLeads ? '' : ' · read only'}`)).join('');
    el('connection').innerHTML = html;
    el('newFlowConnection').innerHTML = html;
    if (state.current?.integrationId) el('connection').value = state.current.integrationId;
    el('planConnection').textContent = selectedOptionText(el('connection')) || 'No connection selected';
  }

  async function loadFlows(preferredId = null) {
    if (!scopeReady()) {
      state.flows = []; state.current = null; renderAll(); return;
    }
    const [data, folderData] = await Promise.all([
      api('/api/hawk/flows?' + scopeQuery() + '&includeArchived=true'),
      api('/api/hawk/folders?' + scopeQuery()),
    ]);
    state.flows = data.flows || [];
    state.folders = folderData.folders || [];
    const available = state.flows.filter((item) => item.status !== 'archived');
    const id = preferredId || (state.current && available.some((item) => item.id === state.current.id) ? state.current.id : available[0]?.id);
    renderFlowPicker(id);
    fillFolderSelects();
    if (id) await loadFlow(id);
    else { state.current = null; state.selectedNodeId = null; renderAll(); await loadExecutions(); }
  }

  function renderFlowPicker(selectedId) {
    const active = state.flows.filter((flow) => flow.status !== 'archived');
    const groups = [{ id: '', name: 'Unfiled', flows: active.filter((flow) => !flow.folderId) },
      ...state.folders.map((folder) => ({ ...folder, flows: active.filter((flow) => flow.folderId === folder.id) }))];
    el('flowPicker').innerHTML = `<option value="">${active.length ? 'Select a flow' : 'No flows yet'}</option>` + groups
      .filter((group) => group.flows.length)
      .map((group) => `<optgroup label="${escapeHtml(group.name)}">${group.flows.map((flow) => option(flow.id, `${flow.color || group.color ? '● ' : ''}${flow.name}`)).join('')}</optgroup>`).join('');
    el('flowPicker').value = selectedId || '';
  }

  function fillFolderSelects() {
    const html = '<option value="">Unfiled</option>' + state.folders.map((folder) => option(folder.id, `● ${folder.name}`)).join('');
    for (const id of ['newFlowFolder', 'importFolder']) {
      const select = el(id); const current = select.value; select.innerHTML = html; select.value = current;
    }
  }

  async function loadFlow(id) {
    const data = await api(`/api/hawk/flows/${encodeURIComponent(id)}?${scopeQuery()}`);
    state.current = data.flow;
    state.selectedNodeId = state.current.graph.nodes[0]?.id || null;
    state.webhookEndpoint = null;
    state.webhookSecret = '';
    await loadWebhookEndpoint();
    setDirty(false);
    renderAll();
    requestAnimationFrame(fitCanvas);
    await loadExecutions();
  }

  function renderAll() {
    renderCommandbar();
    renderCanvas();
    renderInspector();
    applyWorkspaceLayout();
  }

  function renderCommandbar() {
    const flow = state.current;
    el('flowDescription').value = flow?.description || '';
    el('flowDescription').disabled = !flow;
    el('flowStatus').textContent = flow?.status || 'No flow';
    el('flowStatus').className = `flow-status ${flow?.status || 'draft'}`;
    el('dirtyState').hidden = !state.dirty;
    el('connection').value = flow?.integrationId || '';
    el('planConnection').textContent = selectedOptionText(el('connection')) || 'No connection selected';
    for (const id of ['validateButton', 'testButton', 'publishButton', 'exportButton', 'flowCodeButton']) el(id).disabled = !flow;
    el('stateButton').disabled = !flow?.publishedVersionId;
    el('stateButton').textContent = flow?.status === 'active' ? 'Pause' : 'Activate';
  }

  function renderCanvas() {
    const graph = state.current?.graph;
    el('canvasEmpty').hidden = Boolean(graph?.nodes?.length);
    if (!graph) { el('nodeLayer').innerHTML = ''; el('edgeLayer').innerHTML = ''; return; }
    el('nodeLayer').innerHTML = graph.nodes.map((node) => {
      const detail = nodeDetail(node);
      const glyph = node.type === 'trigger' ? '◆' : node.type === 'condition' ? '◇' : node.type === 'end' ? '■' : '●';
      return `<article class="hawk-node ${escapeHtml(node.type)}${node.id === state.selectedNodeId ? ' selected' : ''}" data-node-id="${escapeHtml(node.id)}" style="left:${node.position.x}px;top:${node.position.y}px">
        <header><span>${escapeHtml(typeLabels[node.type] || node.type)}</span><span>•••</span></header>
        <div class="node-body"><span class="node-glyph">${glyph}</span><span><strong>${escapeHtml(node.name || node.id)}</strong><small>${escapeHtml(detail)}</small></span></div>
        ${node.type === 'end' ? '' : '<span class="node-port"></span>'}
      </article>`;
    }).join('');
    for (const card of el('nodeLayer').querySelectorAll('.hawk-node')) {
      card.addEventListener('pointerdown', beginNodeDrag);
      card.addEventListener('click', () => { state.selectedNodeId = card.dataset.nodeId; renderCanvas(); renderInspector(); });
    }
    renderEdges();
    el('canvasSurface').style.transform = `scale(${state.scale})`;
    el('zoomValue').textContent = `${Math.round(state.scale * 100)}%`;
  }

  function renderEdges() {
    const graph = state.current?.graph;
    if (!graph) return;
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const pieces = [`<defs><marker id="hawkArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#8ba0b1"/></marker></defs>`];
    for (const source of graph.nodes) {
      const links = source.type === 'condition'
        ? (source.routes || []).map((route) => ({ target: route.targetNodeId, label: route.label || (route.when ? 'Yes' : 'No') }))
        : source.nextNodeId ? [{ target: source.nextNodeId, label: '' }] : [];
      for (const link of links) {
        const target = byId.get(link.target); if (!target) continue;
        const x1 = source.position.x + 96, y1 = source.position.y + 73;
        const x2 = target.position.x + 96, y2 = target.position.y;
        const middle = y1 + Math.max(28, (y2 - y1) / 2);
        const d = `M${x1},${y1} C${x1},${middle} ${x2},${middle} ${x2},${y2}`;
        const active = source.id === state.selectedNodeId || target.id === state.selectedNodeId ? ' active' : '';
        pieces.push(`<path class="hawk-edge${active}" d="${d}" marker-end="url(#hawkArrow)"/>`);
        if (link.label) pieces.push(`<text class="hawk-edge-label" x="${(x1 + x2) / 2}" y="${middle - 5}" text-anchor="middle">${escapeHtml(link.label)}</text>`);
      }
    }
    el('edgeLayer').innerHTML = pieces.join('');
  }

  function beginNodeDrag(event) {
    if (event.button !== 0) return;
    const card = event.currentTarget;
    const node = nodeById(card.dataset.nodeId); if (!node) return;
    state.selectedNodeId = node.id;
    const startX = event.clientX, startY = event.clientY;
    const initial = { ...node.position };
    let moved = false;
    card.setPointerCapture(event.pointerId);
    card.onpointermove = (move) => {
      const dx = (move.clientX - startX) / state.scale, dy = (move.clientY - startY) / state.scale;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      node.position.x = Math.max(0, Math.min(4800, Math.round(initial.x + dx)));
      node.position.y = Math.max(0, Math.min(4800, Math.round(initial.y + dy)));
      card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px`;
      renderEdges();
    };
    card.onpointerup = () => {
      card.onpointermove = null; card.onpointerup = null;
      if (moved) markDirty();
      renderCanvas(); renderInspector();
    };
  }

  function renderInspector() {
    const node = selectedNode();
    el('nodeEmpty').hidden = Boolean(node);
    el('nodeFields').hidden = !node;
    el('deleteNode').disabled = !node;
    el('inspectorTitle').textContent = node?.name || 'Select a step';
    el('inspectorSubtitle').textContent = node ? nodeDetail(node) : 'Choose a card on the canvas';
    el('inspectorIcon').textContent = node?.type === 'trigger' ? '◆' : node?.type === 'condition' ? '◇' : node?.type === 'end' ? '■' : '●';
    if (!node) { el('nodeDataPreview').textContent = '{}'; renderRuntimeBrowser(); return; }
    el('nodeName').value = node.name || '';
    el('nodeType').value = node.type;
    el('triggerFields').hidden = node.type !== 'trigger';
    el('conditionFields').hidden = node.type !== 'condition';
    el('actionFields').hidden = node.type !== 'action';
    el('nextField').hidden = ['condition', 'end'].includes(node.type);
    fillNodeTargets(node);
    if (node.type === 'trigger') {
      el('triggerEvent').value = node.config.event || 'manual';
      const definition = triggerDefinitionFor(node.config.event);
      const filterKey = definition?.filterKey;
      el('triggerFilter').value = filterKey ? (node.config[filterKey] || '') : (node.config.filter || '');
      const isFieldEvent = filterKey === 'fieldPath';
      el('triggerTextFilterLabel').hidden = isFieldEvent || !filterKey;
      el('triggerFieldFilterLabel').hidden = !isFieldEvent;
      el('triggerFilterText').textContent = ({ tag: 'Tag', objectKey: 'Object schema key', channel: 'Message channel', eventName: 'Event name' })[filterKey] || 'Filter';
      el('triggerFilter').placeholder = filterKey === 'objectKey' ? 'custom_objects.dials' : filterKey === 'channel' ? 'SMS' : filterKey === 'eventName' ? 'call_center.requested' : 'new-lead';
      setFieldButton(el('triggerFieldButton'), node.config.fieldPath || node.config.field || '');
      el('triggerCapabilityNote').textContent = definition?.readiness === 'ready'
        ? 'Ready for direct execution.'
        : 'Definition ready. Automatic runs require the signed webhook or polling adapter.';
      el('triggerCapabilityNote').classList.toggle('ready', definition?.readiness === 'ready');
      renderWebhookTrigger(node);
    }
    if (node.type === 'condition') {
      el('conditionField').value = node.config.field || 'trigger.source';
      setFieldButton(el('conditionFieldButton'), el('conditionField').value);
      el('conditionOperator').value = node.config.operator || 'equals';
      el('conditionValue').value = Array.isArray(node.config.value) ? node.config.value.join(', ') : node.config.value ?? '';
      renderConditionValueHints(node.config.field);
      el('conditionYes').value = node.routes?.find((route) => route.when)?.targetNodeId || '';
      el('conditionNo').value = node.routes?.find((route) => !route.when)?.targetNodeId || '';
    }
    if (node.type === 'action') {
      el('nodeAction').value = node.action || 'data.set';
      el('nodeConfig').value = JSON.stringify(node.config || {}, null, 2);
      renderGuidedAction(node);
    }
    el('nextNode').value = node.nextNodeId || '';
    el('nodeDataPreview').textContent = JSON.stringify({
      input: node.config,
      selectedConnection: state.current?.integrationId || null,
      liveCatalogFields: state.fieldCatalog.total || state.fieldCatalog.fields.length,
      available: ['Use the field picker for trigger and CRM fields', 'data.*', 'steps.<node_id>.response.*'],
    }, null, 2);
    renderRuntimeBrowser();
    renderTestInputSummary();
  }

  async function loadWebhookEndpoint() {
    if (!state.current || !scopeReady()) return;
    try {
      const data = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/webhook?${scopeQuery()}`);
      state.webhookEndpoint = data.endpoint || null;
    } catch (error) {
      state.webhookEndpoint = null;
      showAlert('error', error.message);
    }
  }

  function renderWebhookTrigger(node) {
    const event = node?.config?.event || 'manual';
    const automatic = event !== 'manual';
    const endpoint = state.webhookEndpoint;
    el('webhookTriggerFields').hidden = !automatic;
    if (!automatic) return;
    el('webhookEndpointStatus').textContent = endpoint
      ? `${endpoint.enabled ? 'Listening' : 'Disabled'}${endpoint.lastReceivedAt ? ` · last event ${formatDate(endpoint.lastReceivedAt)}` : ''}`
      : 'Not connected';
    el('webhookStatusDot').classList.toggle('ready', Boolean(endpoint?.enabled));
    el('webhookUrl').value = endpoint?.url || '';
    el('copyWebhookUrl').disabled = !endpoint?.url;
    el('webhookSecretPanel').hidden = !state.webhookSecret;
    el('webhookSecret').value = state.webhookSecret || '';
    el('provisionWebhookButton').hidden = Boolean(endpoint?.enabled);
    el('provisionWebhookButton').textContent = endpoint ? 'Re-enable endpoint' : 'Generate endpoint';
    el('rotateWebhookButton').hidden = !endpoint?.enabled;
    el('disableWebhookButton').hidden = !endpoint?.enabled;
    el('webhookTriggerHelp').textContent = event === 'webhook.received'
      ? 'External systems can start this flow by sending an authenticated event to this endpoint.'
      : `Deliver ${triggerLabels[event] || titleCase(event)} events here. HAWK validates the flow filter before queueing a live execution.`;
    el('triggerCapabilityNote').textContent = endpoint?.enabled
      ? 'Webhook adapter ready. Matching authenticated events will run the active published flow.'
      : 'Generate a signed webhook endpoint to run this trigger automatically.';
    el('triggerCapabilityNote').classList.toggle('ready', Boolean(endpoint?.enabled));
  }

  async function provisionWebhook(rotate) {
    if (!state.current) return;
    if (rotate && !window.confirm('Rotate this webhook secret? The old secret will stop working immediately.')) return;
    try {
      await saveCurrent();
      const data = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/webhook`, {
        method:'POST', body:JSON.stringify({ ...scope(), rotate:Boolean(rotate) }),
      });
      state.webhookEndpoint = data.endpoint;
      state.webhookSecret = data.secret || '';
      renderInspector();
      showAlert('success', `${rotate ? 'Webhook secret rotated' : 'Webhook endpoint ready'}. Copy the secret before leaving this flow.`);
    } catch (error) { showAlert('error', error.message); }
  }

  async function disableWebhook() {
    if (!state.current || !window.confirm('Disable inbound events for this flow?')) return;
    try {
      const data = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/webhook?${scopeQuery()}`, { method:'DELETE' });
      state.webhookEndpoint = data.endpoint;
      state.webhookSecret = '';
      renderInspector();
      showAlert('success', 'Webhook endpoint disabled.');
    } catch (error) { showAlert('error', error.message); }
  }

  async function copyText(value, successMessage) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showAlert('success', successMessage);
    } catch { showAlert('error', 'Clipboard access was blocked. Select and copy the value manually.'); }
  }

  function fillNodeTargets(node) {
    const targetOptions = `<option value="">Select next step</option>` + state.current.graph.nodes
      .filter((item) => item.id !== node.id && item.type !== 'trigger')
      .map((item) => option(item.id, item.name || item.id)).join('');
    el('nextNode').innerHTML = targetOptions;
    el('conditionYes').innerHTML = targetOptions;
    el('conditionNo').innerHTML = targetOptions;
  }

  function addNode(type, event, action) {
    if (!state.current) return showAlert('warning', 'Create or select a flow first.');
    if (type === 'trigger' && state.current.graph.nodes.some((node) => node.type === 'trigger')) {
      return showAlert('warning', 'A HAWK flow has one trigger. Select the trigger card to change its event.');
    }
    const count = state.current.graph.nodes.length + 1;
    const id = uniqueNodeId(type === 'action' ? (action || 'action').split('.').pop() : type);
    const lastY = Math.max(0, ...state.current.graph.nodes.map((node) => Number(node.position?.y || 0)));
    const end = state.current.graph.nodes.find((node) => node.type === 'end');
    const node = { id, type, name: typeLabels[type] || 'Step', config: {}, position: { x: 390 + ((count % 2) * 220), y: Math.min(4600, lastY + 140) } };
    if (type === 'trigger') { node.name = triggerLabels[event] || 'Trigger'; node.config = { event: event || 'manual' }; node.nextNodeId = end?.id; }
    if (type === 'condition') {
      node.name = 'New condition'; node.config = { field: 'trigger.source', operator: 'equals', value: '' };
      node.routes = [{ label: 'Yes', when: true, targetNodeId: end?.id || '' }, { label: 'No', when: false, targetNodeId: end?.id || '' }];
    }
    if (type === 'action') { node.action = action || 'data.set'; node.name = actionLabels[node.action]; node.config = defaultActionConfig(node.action); node.nextNodeId = end?.id; }
    if (type === 'end') { node.name = 'Complete'; }
    state.current.graph.nodes.push(node);
    state.selectedNodeId = id;
    markDirty(); renderCanvas(); renderInspector();
  }

  function updateNode(mutator, canvasOnly = false, inspectorToo = false) {
    const node = selectedNode(); if (!node) return;
    mutator(node); markDirty(); renderCanvas();
    if (!canvasOnly || inspectorToo) renderInspector();
  }

  function updateNodeType(type) {
    const node = selectedNode(); if (!node || node.type === type) return;
    if (type === 'trigger' && state.current.graph.nodes.some((item) => item.type === 'trigger' && item.id !== node.id)) {
      el('nodeType').value = node.type;
      return showAlert('warning', 'A flow can contain only one trigger.');
    }
    node.type = type; node.config = {};
    delete node.action; delete node.routes; delete node.nextNodeId;
    if (type === 'trigger') { node.config = { event: 'manual' }; node.nextNodeId = firstTarget(node.id); }
    if (type === 'condition') {
      node.config = { field: 'trigger.source', operator: 'equals', value: '' };
      const target = firstTarget(node.id);
      node.routes = [{ label: 'Yes', when: true, targetNodeId: target }, { label: 'No', when: false, targetNodeId: target }];
    }
    if (type === 'action') { node.action = 'data.set'; node.config = defaultActionConfig(node.action); node.nextNodeId = firstTarget(node.id); }
    if (type !== 'end' && !node.nextNodeId && type !== 'condition') node.nextNodeId = firstTarget(node.id);
    node.name = typeLabels[type];
    markDirty(); renderCanvas(); renderInspector();
  }

  function updateConditionRoute(value, targetNodeId) {
    updateNode((node) => {
      const route = node.routes.find((item) => item.when === value);
      if (route) route.targetNodeId = targetNodeId;
    });
  }

  function deleteSelectedNode() {
    const node = selectedNode(); if (!node) return;
    if (node.type === 'trigger') return showAlert('warning', 'Every flow needs its trigger. Change the trigger instead of deleting it.');
    state.current.graph.nodes = state.current.graph.nodes.filter((item) => item.id !== node.id);
    for (const item of state.current.graph.nodes) {
      if (item.nextNodeId === node.id) delete item.nextNodeId;
      for (const route of item.routes || []) if (route.targetNodeId === node.id) route.targetNodeId = '';
    }
    state.selectedNodeId = state.current.graph.startNodeId;
    markDirty(); renderCanvas(); renderInspector();
  }

  async function validateCurrent() {
    if (!state.current) return;
    try {
      const data = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/validate`, {
        method: 'POST', body: JSON.stringify({ ...scope(), graph: state.current.graph }),
      });
      showValidation(data.validation);
    } catch (error) {
      const validation = error.payload?.validation || error.payload?.details;
      if (validation) showValidation(validation); else showAlert('error', error.message);
    }
  }

  function showValidation(validation) {
    if (validation.valid) showAlert('success', `Flow is valid · ${validation.stats.nodes} steps · ${validation.stats.actions} actions.`);
    else showAlert('error', validation.errors.slice(0, 3).map((item) => `${item.nodeId ? item.nodeId + ': ' : ''}${item.message}`).join(' · '));
  }

  async function saveCurrent() {
    if (!state.current || !state.dirty) return state.current;
    const data = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ ...scope(), expectedRevision: state.current.draftRevision, name: state.current.name,
        description: state.current.description, integrationId: state.current.integrationId, graph: state.current.graph }),
    });
    state.current = data.flow; setDirty(false); renderAll();
    return state.current;
  }

  async function publishCurrent() {
    if (!state.current) return;
    try {
      await saveCurrent();
      const data = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/publish`, {
        method: 'POST', body: JSON.stringify(scope()),
      });
      state.current = data.flow;
      await loadFlows(state.current.id);
      showAlert('success', `Published version ${data.version.number}. Activate it when you are ready for live events.`);
    } catch (error) { showAlert('error', error.message); }
  }

  async function toggleState() {
    if (!state.current) return;
    const next = state.current.status === 'active' ? 'paused' : 'active';
    try {
      const data = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/state`, {
        method: 'POST', body: JSON.stringify({ ...scope(), state: next }),
      });
      state.current = data.flow; renderAll();
      showAlert('success', `Flow is now ${next}.`);
    } catch (error) { showAlert('error', error.message); }
  }

  function openFlowLibrary() {
    if (!scopeReady()) return showAlert('warning', 'Select a portfolio and location first.');
    renderFlowLibrary();
    el('flowLibraryDialog').showModal();
    setTimeout(() => el('flowLibrarySearch').focus(), 0);
  }

  function renderFlowLibrary() {
    const search = String(el('flowLibrarySearch')?.value || '').trim().toLowerCase();
    const showArchived = Boolean(el('showArchivedFlows')?.checked);
    const visible = state.flows.filter((flow) => {
      if (!showArchived && flow.status === 'archived') return false;
      if (state.libraryFolderId === 'unfiled' && flow.folderId) return false;
      if (!['all', 'unfiled'].includes(state.libraryFolderId) && flow.folderId !== state.libraryFolderId) return false;
      return !search || `${flow.name} ${flow.description || ''} ${flow.folderName || ''}`.toLowerCase().includes(search);
    });
    const live = state.flows.filter((flow) => flow.status !== 'archived');
    const folderButton = (id, name, color, count) => `<button type="button" class="folder-filter${state.libraryFolderId === id ? ' active' : ''}" data-folder-filter="${escapeHtml(id)}"><i style="--folder-color:${escapeHtml(color)}"></i><span>${escapeHtml(name)}</span><b>${count}</b></button>`;
    el('flowFolderList').innerHTML = folderButton('all', 'All flows', '#ffd000', live.length) +
      folderButton('unfiled', 'Unfiled', '#70869a', live.filter((flow) => !flow.folderId).length) +
      state.folders.map((folder) => `<div class="folder-nav-row">${folderButton(folder.id, folder.name, folder.color, live.filter((flow) => flow.folderId === folder.id).length)}<button type="button" class="folder-edit" data-edit-folder="${escapeHtml(folder.id)}" title="Edit folder">•••</button></div>`).join('');
    el('flowLibraryList').innerHTML = visible.length ? visible.map(flowLibraryCard).join('') : '<div class="library-empty"><strong>No matching flows</strong><span>Change the folder, search, or archived filter.</span></div>';
    el('flowLibraryCount').textContent = `${visible.length} flow${visible.length === 1 ? '' : 's'} shown`;
  }

  function flowLibraryCard(flow) {
    const effectiveColor = flow.color || flow.folderColor || '#2f85de';
    const folderOptions = '<option value="">Unfiled</option>' + state.folders.map((folder) => option(folder.id, folder.name, flow.folderId === folder.id)).join('');
    return `<article class="flow-library-card${flow.status === 'archived' ? ' archived' : ''}" style="--flow-color:${escapeHtml(effectiveColor)}" data-flow-id="${escapeHtml(flow.id)}">
      <div class="flow-card-main"><i></i><div><input class="flow-card-title" data-flow-name value="${escapeHtml(flow.name)}" maxlength="191" aria-label="Flow title" /><p>${escapeHtml(flow.description || 'No description yet.')}</p><span>${escapeHtml(flow.status)} · Updated ${escapeHtml(formatLibraryDate(flow.updatedAt))}</span></div></div>
      <div class="flow-card-controls"><select data-flow-folder aria-label="Flow folder">${folderOptions}</select><input data-flow-color type="color" value="${escapeHtml(effectiveColor)}" aria-label="Flow color" /><button type="button" class="hawk-button ghost" data-open-flow>Open</button><button type="button" class="hawk-button ${flow.status === 'archived' ? 'ghost' : 'danger'}" data-archive-flow>${flow.status === 'archived' ? 'Restore' : 'Archive'}</button></div>
    </article>`;
  }

  function handleFolderListClick(event) {
    const filter = event.target.closest('[data-folder-filter]');
    if (filter) { state.libraryFolderId = filter.dataset.folderFilter; renderFlowLibrary(); return; }
    const edit = event.target.closest('[data-edit-folder]');
    if (edit) openFolderDialog(state.folders.find((folder) => folder.id === edit.dataset.editFolder));
  }

  async function handleFlowLibraryClick(event) {
    const card = event.target.closest('[data-flow-id]'); if (!card) return;
    const flowId = card.dataset.flowId;
    if (event.target.closest('[data-open-flow]')) {
      if (state.dirty && !window.confirm('Discard unsaved HAWK changes?')) return;
      el('flowLibraryDialog').close(); await loadFlow(flowId); renderFlowPicker(flowId); return;
    }
    if (event.target.closest('[data-archive-flow]')) {
      const flow = state.flows.find((item) => item.id === flowId); const archived = flow.status !== 'archived';
      if (archived && !window.confirm(`Archive “${flow.name}”? Execution history will be retained.`)) return;
      try {
        await api(`/api/hawk/flows/${encodeURIComponent(flowId)}/archive`, { method: 'POST', body: JSON.stringify({ ...scope(), archived }) });
        if (archived && state.current?.id === flowId) state.current = null;
        await loadFlows(); renderFlowLibrary(); showAlert('success', archived ? 'Flow archived. It remains available in the library.' : 'Flow restored as a draft or paused published flow.');
      } catch (error) { showAlert('error', error.message); }
    }
  }

  async function handleFlowLibraryChange(event) {
    const card = event.target.closest('[data-flow-id]'); if (!card) return;
    const patch = event.target.matches('[data-flow-name]') ? { name: event.target.value }
      : event.target.matches('[data-flow-folder]') ? { folderId: event.target.value || null }
        : event.target.matches('[data-flow-color]') ? { color: event.target.value } : null;
    if (!patch) return;
    try {
      const data = await api(`/api/hawk/flows/${encodeURIComponent(card.dataset.flowId)}/organization`, { method: 'PUT', body: JSON.stringify({ ...scope(), ...patch }) });
      const index = state.flows.findIndex((flow) => flow.id === data.flow.id); if (index >= 0) state.flows[index] = data.flow;
      if (state.current?.id === data.flow.id) state.current = { ...state.current, ...data.flow };
      renderFlowPicker(state.current?.id); renderFlowLibrary(); renderCommandbar();
    } catch (error) { showAlert('error', error.message); await loadFlows(state.current?.id); renderFlowLibrary(); }
  }

  function openFolderDialog(folder = null) {
    el('folderId').value = folder?.id || '';
    el('folderDialogTitle').textContent = folder ? 'Edit folder' : 'Create folder';
    el('folderName').value = folder?.name || '';
    el('folderDescription').value = folder?.description || '';
    el('folderColor').value = folder?.color || '#2f85de';
    el('deleteFolderButton').hidden = !folder;
    el('folderDialog').showModal(); setTimeout(() => el('folderName').focus(), 0);
  }

  async function saveFolder(event) {
    event.preventDefault();
    const id = el('folderId').value; const method = id ? 'PUT' : 'POST'; const path = id ? `/api/hawk/folders/${encodeURIComponent(id)}` : '/api/hawk/folders';
    try {
      await api(path, { method, body: JSON.stringify({ ...scope(), name: el('folderName').value, description: el('folderDescription').value, color: el('folderColor').value }) });
      el('folderDialog').close(); await loadFlows(state.current?.id); renderFlowLibrary(); showAlert('success', id ? 'Folder updated.' : 'Folder created.');
    } catch (error) { showAlert('error', error.message); }
  }

  async function deleteFolder() {
    const id = el('folderId').value; const folder = state.folders.find((item) => item.id === id); if (!folder) return;
    if (!window.confirm(`Delete “${folder.name}”? Its flows will move to Unfiled.`)) return;
    try {
      await api(`/api/hawk/folders/${encodeURIComponent(id)}?${scopeQuery()}`, { method: 'DELETE' });
      state.libraryFolderId = 'unfiled'; el('folderDialog').close(); await loadFlows(state.current?.id); renderFlowLibrary(); showAlert('success', 'Folder deleted; its flows are now Unfiled.');
    } catch (error) { showAlert('error', error.message); }
  }

  function formatLibraryDate(value) {
    if (!value) return 'unknown';
    const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function openNewFlow() {
    if (!scopeReady()) return showAlert('warning', 'Select a portfolio and location first.');
    el('newFlowName').value = '';
    el('newFlowDescription').value = '';
    el('newFlowFolder').value = state.libraryFolderId !== 'all' && state.libraryFolderId !== 'unfiled' ? state.libraryFolderId : '';
    el('newFlowColor').value = '#2f85de';
    el('newFlowConnection').value = el('connection').value || state.bootstrap.connections[0]?.id || '';
    el('newFlowDialog').showModal();
    setTimeout(() => el('newFlowName').focus(), 0);
  }

  async function createFlow(event) {
    event.preventDefault();
    try {
      const data = await api('/api/hawk/flows', {
        method: 'POST', body: JSON.stringify({ ...scope(), name: el('newFlowName').value,
          description: el('newFlowDescription').value, integrationId: el('newFlowConnection').value || null,
          folderId: el('newFlowFolder').value || null, color: el('newFlowColor').value }),
      });
      el('newFlowDialog').close();
      await loadFlows(data.flow.id);
      showAlert('success', 'HAWK flow created. Configure the starter steps, then test and publish.');
    } catch (error) { showAlert('error', error.message); }
  }

  function openTest() {
    if (!state.current) return;
    renderTestRecordSources();
    if (!el('testInputRows').children.length) {
      try { loadGuidedTestInput(JSON.parse(el('testInput').value || '{}')); }
      catch { loadGuidedTestInput({}); }
    }
    selectTestInputMode(state.testInputMode);
    renderTestRecordResults();
    el('testDialog').showModal();
  }

  function renderTestRecordSources() {
    const current = el('testRecordSource').value || 'lead';
    const fixed = [
      ['lead', 'Contacts / leads (selected database)'], ['contact_cache', 'Synced CRM contacts (core database)'],
      ['contact', 'Contacts (live CRM)'], ['opportunity', 'Opportunities (live CRM)'],
      ['appointment', 'Appointments (core database)'],
    ];
    const reserved = new Set(['contact', 'opportunity', 'appointment', 'form']);
    const custom = (state.fieldCatalog?.objects || []).filter((item) => !reserved.has(item.id))
      .map((item) => [`object:${item.id}`, `${item.label} (live CRM)`]);
    el('testRecordSource').innerHTML = [...fixed, ...custom].map(([value, label]) => option(value, label)).join('');
    el('testRecordSource').value = [...fixed, ...custom].some(([value]) => value === current) ? current : 'lead';
  }

  async function searchTestRecords() {
    const button = el('searchTestRecordsButton'); const source = el('testRecordSource').value;
    if (!source) return;
    const live = !['lead', 'contact_cache', 'appointment'].includes(source);
    if (live && !el('connection').value) return showAlert('warning', 'Select a GoHighLevel connection before searching live records.');
    button.disabled = true; button.textContent = 'Searching…';
    el('testRecordResults').innerHTML = '<div class="test-record-empty">Searching authorized records…</div>';
    try {
      const query = new URLSearchParams({ ...scope(), integrationId:el('connection').value || '', source,
        query:el('testRecordSearch').value.trim(), limit:'12' });
      const data = await api('/api/hawk/test-records?' + query);
      state.testRecords = data.records || []; state.selectedTestRecord = null; renderTestRecordResults();
    } catch (error) { state.testRecords = []; renderTestRecordResults(error.message); }
    finally { button.disabled = false; button.textContent = 'Search'; }
  }

  function renderTestRecordResults(error = '') {
    const records = state.testRecords || [];
    el('testRecordSelection').textContent = state.selectedTestRecord ? `Using ${state.selectedTestRecord.title}` : 'No record selected';
    el('testRecordResults').innerHTML = error ? `<div class="test-record-empty error">${escapeHtml(error)}</div>`
      : records.length ? records.map((record, index) => `<button type="button" data-test-record-index="${index}" class="${state.selectedTestRecord?.id === record.id ? 'selected' : ''}"><i>${recordGlyph(record.source)}</i><span><strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(record.subtitle || record.id)}</small></span><code>${escapeHtml(record.id)}</code></button>`).join('')
        : '<div class="test-record-empty">Choose a record type and search to load real test data.</div>';
  }

  function selectTestRecord(event) {
    const button = event.target.closest('[data-test-record-index]'); if (!button) return;
    const record = state.testRecords[Number(button.dataset.testRecordIndex)]; if (!record) return;
    state.selectedTestRecord = record; loadGuidedTestInput(record.payload || {}); renderTestRecordResults();
    showAlert('success', `Loaded ${record.title} into the safe test payload.`);
  }

  function recordGlyph(source) { return source === 'contact' ? 'C' : source === 'opportunity' ? 'O' : source === 'appointment' ? 'A' : 'R'; }

  async function runTest() {
    try {
      let input;
      if (state.testInputMode === 'guided') input = buildGuidedTestInput();
      else {
        try { input = JSON.parse(el('testInput').value || '{}'); }
        catch { throw new Error('Trigger input must be valid JSON.'); }
      }
      await saveCurrent();
      el('runTestButton').disabled = true; el('runTestButton').textContent = 'Running…';
      const data = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/test`, {
        method: 'POST', body: JSON.stringify({ ...scope(), input }),
      });
      el('testDialog').close();
      await loadExecutions();
      await selectExecution(data.execution.id);
      selectExecutionTab('details');
      showAlert(data.execution.status === 'successful' ? 'success' : 'error',
        data.execution.status === 'successful' ? 'Safe test completed. No upstream changes were made.' : 'Test failed. Review the step log.');
    } catch (error) { showAlert('error', error.message); }
    finally { el('runTestButton').disabled = false; el('runTestButton').textContent = 'Run safe test'; }
  }

  async function loadExecutions() {
    if (!scopeReady()) return;
    const query = new URLSearchParams(scope());
    if (state.executionStatus) query.set('status', state.executionStatus);
    const data = await api('/api/hawk/executions?' + query);
    state.executions = data.executions || [];
    renderExecutions();
  }

  function renderExecutions() {
    const rows = state.executions;
    el('executionRows').innerHTML = rows.length ? rows.map((item) => {
      const progress = item.stepsTotal ? Math.round((item.stepsCompleted / item.stepsTotal) * 100) : 0;
      return `<tr data-execution-id="${escapeHtml(item.id)}" class="${item.id === state.selectedExecutionId ? 'selected' : ''}">
        <td class="execution-id">#_${escapeHtml(item.id.slice(0, 10))}</td>
        <td><span class="execution-badge ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
        <td>${formatDate(item.createdAt)}</td><td>${formatDuration(item.durationMs)}</td>
        <td><div class="execution-progress ${item.status === 'failed' ? 'failed' : ''}"><i style="width:${progress}%"></i></div> ${item.stepsCompleted}/${item.stepsTotal}</td>
        <td>${escapeHtml(item.mode)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-row">No executions match this filter.</td></tr>';
    for (const row of el('executionRows').querySelectorAll('tr[data-execution-id]')) row.onclick = () => selectExecution(row.dataset.executionId);
  }

  async function selectExecution(id) {
    const data = await api(`/api/hawk/executions/${encodeURIComponent(id)}?${scopeQuery()}`);
    state.selectedExecutionId = id;
    renderExecutions(); renderExecutionDetail(data.execution);
  }

  function renderExecutionDetail(execution) {
    const successful = execution.status === 'successful';
    el('executionSummary').className = '';
    el('executionSummary').innerHTML = `<div class="execution-summary-card">
      <strong>${successful ? '✓ Completed successfully' : execution.status === 'failed' ? '× Execution failed' : '◌ Execution in progress'}</strong>
      <p>${escapeHtml(execution.flowName || 'HAWK flow')} · ${escapeHtml(execution.triggerType)}${execution.errorMessage ? ` · ${escapeHtml(execution.errorMessage)}` : ''}</p>
      <div class="execution-summary-grid"><span>Execution ID<b>#_${escapeHtml(execution.id.slice(0, 12))}</b></span><span>Mode<b>${escapeHtml(execution.mode)}</b></span><span>Duration<b>${formatDuration(execution.durationMs)}</b></span><span>Steps<b>${execution.stepsCompleted}/${execution.stepsTotal}</b></span></div>
    </div>`;
    el('executionSteps').className = '';
    el('executionSteps').innerHTML = execution.steps.length ? execution.steps.map((step) => `<div class="step-log-row"><span><strong>${escapeHtml(step.nodeId)}</strong><small>${escapeHtml(step.actionType || step.nodeType)}${step.errorMessage ? ` · ${escapeHtml(step.errorMessage)}` : ''}</small></span><span class="execution-badge ${escapeHtml(step.status)}">${escapeHtml(step.status)} · ${formatDuration(step.durationMs)}</span></div>`).join('') : '<div class="execution-empty">No step records.</div>';
    el('executionData').textContent = JSON.stringify({ input: execution.input, output: execution.output }, null, 2);
    el('replayButton').disabled = false;
  }

  async function replaySelected() {
    if (!state.selectedExecutionId) return;
    try {
      el('replayButton').disabled = true;
      const data = await api(`/api/hawk/executions/${encodeURIComponent(state.selectedExecutionId)}/replay`, {
        method: 'POST', body: JSON.stringify({ ...scope(), dryRun: true }),
      });
      await loadExecutions();
      await selectExecution(data.execution.id);
      selectExecutionTab('details');
      showAlert('success', 'Safe replay completed as a new linked execution.');
    } catch (error) { showAlert('error', error.message); }
    finally { el('replayButton').disabled = false; }
  }

  function selectPalette(name) {
    document.querySelectorAll('.palette-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.palette === name));
    document.querySelectorAll('.palette-pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.palettePane === name));
  }
  function selectInspectorTab(name) {
    document.querySelectorAll('.inspector-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.inspectorTab === name));
    document.querySelectorAll('.inspector-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.inspectorPanel === name));
    if (name === 'data') renderRuntimeBrowser();
  }
  function selectExecutionTab(name) {
    document.querySelectorAll('.execution-detail>nav button').forEach((button) => button.classList.toggle('active', button.dataset.executionTab === name));
    document.querySelectorAll('.execution-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.executionPanel === name));
  }
  function filterPalette() {
    const q = el('stepSearch').value.trim().toLowerCase();
    document.querySelectorAll('.palette-item').forEach((button) => { button.hidden = q && !button.textContent.toLowerCase().includes(q); });
  }
  function switchSection(view, button) {
    document.querySelectorAll('.hawk-section-nav button').forEach((item) => item.classList.toggle('active', item === button));
    if (view === 'executions') document.querySelector('.execution-console').scrollIntoView({ behavior: 'smooth', block: 'center' });
    else if (view === 'connections') location.href = base + '/crm-integrations';
    else if (view === 'data') showAlert('warning', 'Data Explorer is planned for the OWL/EAGLE metric phase. Execution data is available below now.');
    else if (view === 'overview') showAlert('success', `${state.flows.length} flows · ${state.executions.length} recent executions · Sentinel monitoring active.`);
  }

  async function loadFieldCatalog() {
    if (!scopeReady()) return;
    const query = new URLSearchParams({ ...scope(), integrationId: el('connection').value || state.current?.integrationId || '' });
    const data = await api('/api/hawk/catalog?' + query);
    state.fieldCatalog = data.catalog || { fields: [], objects: [], total: 0 };
    renderCatalogSummary();
    if (selectedNode()) renderInspector();
  }

  async function refreshFieldCatalog() {
    const integrationId = el('connection').value || state.current?.integrationId;
    if (!integrationId) return showAlert('warning', 'Select a GoHighLevel connection first.');
    try {
      el('refreshCatalogButton').disabled = true;
      el('refreshCatalogButton').textContent = 'Refreshing…';
      const data = await api('/api/hawk/catalog/refresh', {
        method: 'POST', body: JSON.stringify({ ...scope(), integrationId }),
      });
      state.fieldCatalog = data.catalog;
      renderCatalogSummary(); renderInspector();
      showAlert('success', `Loaded ${data.catalog.total} live CRM fields and runtime values.`);
    } catch (error) { showAlert('error', error.message); }
    finally { el('refreshCatalogButton').disabled = false; el('refreshCatalogButton').textContent = 'Refresh CRM fields'; }
  }

  function renderCatalogSummary() {
    const catalog = state.fieldCatalog || { fields: [], objects: [], total: 0 };
    el('catalogSummary').textContent = `${catalog.total || catalog.fields.length} fields across ${(catalog.objects || []).length || 1} CRM objects`;
    const choices = '<option value="">All objects</option>' + (catalog.objects || []).map((item) => option(item.id, `${item.label} (${item.fieldCount})`)).join('');
    const pickerValue = el('fieldObjectFilter').value, runtimeValue = el('runtimeObjectFilter').value;
    el('fieldObjectFilter').innerHTML = choices; el('fieldObjectFilter').value = pickerValue;
    el('runtimeObjectFilter').innerHTML = choices; el('runtimeObjectFilter').value = runtimeValue;
    renderRuntimeBrowser();
  }

  function openFieldPicker(options = {}) {
    state.fieldPicker = options;
    el('fieldSearch').value = '';
    el('fieldObjectFilter').value = options.objectModel || '';
    renderFieldPicker();
    el('fieldPickerDialog').showModal();
    setTimeout(() => el('fieldSearch').focus(), 0);
  }

  function renderFieldPicker() {
    const q = el('fieldSearch').value.trim().toLowerCase();
    const model = el('fieldObjectFilter').value;
    const fields = (state.fieldCatalog.fields || []).filter((field) => {
      if (model && field.objectModel !== model) return false;
      if (state.fieldPicker?.writableOnly && !field.writable) return false;
      return !q || [field.label, field.objectModel, field.fieldId, field.fieldKey, field.runtimePath, field.dataType].join(' ').toLowerCase().includes(q);
    }).slice(0, 500);
    el('fieldPickerCount').textContent = `${fields.length}${fields.length === 500 ? '+' : ''} matching fields`;
    el('fieldPickerList').innerHTML = fields.length ? fields.map((field) => `<button type="button" data-field-path="${escapeHtml(field.runtimePath)}" class="${field.runtimePath === state.fieldPicker?.current ? 'selected' : ''}">
      <span><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(field.objectModel)} · ${escapeHtml(field.dataType)}${field.allowedValues?.length ? ` · ${field.allowedValues.length} allowed values` : ''}</small></span>
      <code>${escapeHtml(field.runtimePath)}</code>
    </button>`).join('') : '<div class="field-picker-empty">No fields match. Refresh the CRM catalog if fields changed in GoHighLevel.</div>';
    for (const button of el('fieldPickerList').querySelectorAll('button[data-field-path]')) {
      button.onclick = () => {
        const field = (state.fieldCatalog.fields || []).find((item) => item.runtimePath === button.dataset.fieldPath);
        if (!field) return;
        el('fieldPickerDialog').close();
        state.fieldPicker?.onSelect?.(field);
      };
    }
  }

  function setFieldButton(button, value) {
    const path = String(value || '').replace(/^\{\{\s*|\s*\}\}$/g, '');
    const field = (state.fieldCatalog.fields || []).find((item) => item.runtimePath === path);
    button.textContent = field ? `${field.label} · ${field.objectModel}` : (path || 'Select a live CRM field');
    button.title = path;
  }

  function openTemplatePicker(target, row = null) {
    const node = selectedNode(); if (!node) return;
    const current = target === 'contactId' ? node.config.contactId : target === 'dataValue' ? node.config.value : row?.querySelector('.dynamic-value')?.value;
    openFieldPicker({ current: String(current || '').replace(/^\{\{\s*|\s*\}\}$/g, ''), onSelect: (field) => {
      if (target === 'contactId') {
        updateNode((item) => { item.config.contactId = field.template; }, true);
        setFieldButton(el('contactIdFieldButton'), field.runtimePath);
      } else if (target === 'dataValue') {
        updateNode((item) => { item.config.value = field.template; }, true);
        setFieldButton(el('dataValueFieldButton'), field.runtimePath);
      } else if (row) {
        setComposerField(row, field); syncGuidedAction();
      }
    } });
  }

  function renderGuidedAction(node) {
    const action = node.action || 'data.set';
    const definition = actionDefinitionFor(action);
    const editor = definition?.editor || 'catalog';
    el('contactActionFields').hidden = !['ghl.update_contact', 'ghl.add_tags', 'ghl.remove_tags'].includes(action);
    el('updateContactFields').hidden = !['ghl.update_contact', 'ghl.upsert_contact'].includes(action);
    el('tagActionFields').hidden = !['ghl.add_tags', 'ghl.remove_tags'].includes(action);
    el('dataActionFields').hidden = action !== 'data.set';
    const codeAction = ['code.run', 'parrot.inline'].includes(action);
    el('codeActionFields').hidden = !codeAction;
    el('catalogActionFields').hidden = editor !== 'catalog';
    if (!el('contactActionFields').hidden) setFieldButton(el('contactIdFieldButton'), node.config.contactId || '{{trigger.contactId}}');
    if (['ghl.update_contact', 'ghl.upsert_contact'].includes(action)) renderMappingRows(node.config.fields || {});
    if (['ghl.add_tags', 'ghl.remove_tags'].includes(action)) el('actionTags').value = Array.isArray(node.config.tags) ? node.config.tags.join(', ') : '';
    if (action === 'data.set') { el('dataKey').value = node.config.key || ''; setFieldButton(el('dataValueFieldButton'), node.config.value || ''); }
    if (codeAction) {
      const bundled = action === 'parrot.inline';
      el('codeLanguage').value = bundled ? 'python' : (node.config.language || 'javascript');
      el('codeLanguage').disabled = bundled;
      el('codeSource').value = node.config.code || '';
      renderCodeInputRows(node.config.inputs || {});
      updateCodeStats();
      const enabled = bundled ? Boolean(state.bootstrap?.parrotRunner?.enabled) : Boolean(state.bootstrap?.codeRunner?.enabled);
      el('codeRunnerBadge').textContent = enabled ? (bundled ? 'PARROT ready' : 'Runner ready') : 'Runner unavailable';
      el('codeRunnerBadge').classList.toggle('ready', enabled);
      el('codeWarning').textContent = bundled
        ? 'HAWK sends this source to PARROT for restricted dry-runs. Publishing pins its validated SHA-256; live runs never accept unreviewed source.'
        : 'Custom code runs only in the isolated HAWK runner. It receives mapped inputs, never PIT credentials, SQL, or host access.';
      el('codeHint').innerHTML = bundled ? 'Define <code>run(inputs, context)</code> and return a JSON-safe value.' : 'Return a value or assign it to <code>output</code>.';
    }
    if (editor === 'catalog') renderCatalogActionFields(definition, node.config || {});
    renderWebhookSamplePanel(node);
  }

  function renderWebhookSamplePanel(node) {
    const visible = node?.type === 'action' && node.action === 'webhook.send';
    el('webhookSamplePanel').hidden = !visible;
    if (!visible) return;
    const sampleKey = `${state.current?.id || ''}:${node.id}`;
    if (state.webhookSampleNodeId !== sampleKey) {
      state.webhookSampleNodeId = sampleKey;
      resetWebhookSample();
    }
  }

  function resetWebhookSample() {
    const node = selectedNode();
    if (!node || node.action !== 'webhook.send') return;
    el('webhookSampleBody').value = JSON.stringify(sampleValue(node.config?.body || {}), null, 2);
    el('webhookSampleStatus').className = 'webhook-sample-status';
    el('webhookSampleStatus').textContent = 'Ready to send. Edit these values if GHL should match a real test contact.';
  }

  function sampleValue(value) {
    if (Array.isArray(value)) return value.map(sampleValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sampleValue(item)]));
    if (typeof value !== 'string') return value;
    const samples = {
      'trigger.contactId':'HAWK_TEST_CONTACT_ID', 'trigger.name':'HAWK Test Contact',
      'trigger.firstName':'HAWK', 'trigger.lastName':'Test Contact',
      'trigger.email':'hawk-webhook-test@example.com', 'trigger.phone':'+15555550100',
      'trigger.serviceType':'Roofing', 'data.servicePool':'roofing',
    };
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path) => samples[path] || `sample_${String(path).split('.').pop()}`);
  }

  async function sendWebhookSample() {
    const node = selectedNode();
    if (!state.current || !node || node.action !== 'webhook.send') return showAlert('warning', 'Select a Send Webhook action first.');
    let body;
    try { body = JSON.parse(el('webhookSampleBody').value || '{}'); }
    catch { return showAlert('error', 'Sample JSON body must be valid JSON.'); }
    const button = el('sendWebhookSampleButton');
    const status = el('webhookSampleStatus');
    button.disabled = true;
    status.className = 'webhook-sample-status sending';
    status.textContent = 'Sending one live webhook sample…';
    try {
      const data = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/webhook-sample`, {
        method:'POST',
        body:JSON.stringify({ ...scope(), nodeId:node.id, config:{ ...structuredClone(node.config || {}), body }, confirmSend:true }),
      });
      status.className = 'webhook-sample-status success';
      status.textContent = `Delivered HTTP ${data.result.status}. Return to GoHighLevel and click Check for new requests.`;
      showAlert('success', 'Webhook sample delivered. Select it as the GoHighLevel mapping reference.');
    } catch (error) {
      status.className = 'webhook-sample-status error';
      status.textContent = error.message;
      showAlert('error', error.message);
    } finally { button.disabled = false; }
  }

  function renderCatalogActionFields(definition, config) {
    const container = el('catalogActionFields');
    if (!definition) { container.innerHTML = '<div class="runtime-empty">This action has no guided definition.</div>'; return; }
    container.innerHTML = `<div class="catalog-action-summary"><strong>${escapeHtml(definition.label)}</strong><span>${escapeHtml(definition.description)}</span><small>${escapeHtml(definition.scope || 'No external scope required')}</small></div>`;
    for (const field of definition.fields || []) {
      const row = document.createElement('div'); row.className = 'catalog-action-row'; row.dataset.key = field.key; row.dataset.kind = field.kind;
      const required = field.required ? ' <b>Required</b>' : '';
      row.innerHTML = `<label>${escapeHtml(field.label)}${required}</label>${catalogFieldMarkup(field)}`;
      const value = config[field.key] ?? field.defaultValue ?? '';
      if (['runtime', 'text', 'textarea', 'number'].includes(field.kind)) wireValueComposer(row, value, syncGuidedAction);
      else if (field.kind === 'boolean') row.querySelector('.catalog-boolean').checked = Boolean(value);
      else if (field.kind === 'object') row.querySelector('.catalog-object').value = JSON.stringify(value && typeof value === 'object' ? value : {}, null, 2);
      else row.querySelector('.catalog-value').value = value ?? '';
      row.querySelectorAll('input,select,textarea').forEach((control) => {
        if (!control.classList.contains('value-mode') && !control.classList.contains('value-raw')) control.addEventListener('input', syncGuidedAction);
      });
      container.appendChild(row);
    }
  }

  function catalogFieldMarkup(field) {
    if (field.kind === 'select') return `<select class="catalog-value">${(field.options || []).map((value) => option(value, value || 'Not set')).join('')}</select>`;
    if (field.kind === 'boolean') return '<label class="boolean-control"><input class="catalog-boolean" type="checkbox" /> Enabled</label>';
    if (field.kind === 'object') return '<textarea class="catalog-object" rows="6" spellcheck="false">{}</textarea>';
    if (field.kind === 'object_schema') {
      const objects = (state.fieldCatalog.objects || []).filter((item) => /^(custom_objects|business)\./.test(item.id));
      return `<select class="catalog-value"><option value="">Select a discovered object</option>${objects.map((item) => option(item.id, item.label || item.id)).join('')}</select>`;
    }
    return valueComposerMarkup(field.kind === 'textarea');
  }

  function syncCatalogActionConfig(node) {
    const next = { ...node.config };
    for (const row of el('catalogActionFields').querySelectorAll('.catalog-action-row')) {
      const key = row.dataset.key, kind = row.dataset.kind;
      let value;
      if (['runtime', 'text', 'textarea', 'number'].includes(kind)) value = composerValue(row);
      else if (kind === 'boolean') value = row.querySelector('.catalog-boolean').checked;
      else if (kind === 'object') {
        try { value = JSON.parse(row.querySelector('.catalog-object').value || '{}'); }
        catch { throw new Error(`${row.querySelector('label').textContent.replace('Required', '').trim()} must be valid JSON.`); }
      } else value = row.querySelector('.catalog-value').value;
      if (kind === 'number' && value !== '' && value != null && !String(value).includes('{{')) value = Number(value);
      if (value === '' || value == null) delete next[key]; else next[key] = value;
    }
    node.config = next;
  }

  function renderMappingRows(fields) {
    el('mappingRows').innerHTML = '';
    for (const [target, value] of Object.entries(fields || {})) if (target !== 'customFields') addMappingRow(target, value, false);
    for (const custom of Array.isArray(fields?.customFields) ? fields.customFields : []) {
      addMappingRow(`customFields:${custom.id || custom.fieldId || ''}`, custom.field_value ?? custom.value ?? '', false);
    }
    if (!el('mappingRows').children.length) addMappingRow('', '', false);
  }

  function addMappingRow(target = '', value = '', sync = true) {
    const row = document.createElement('div'); row.className = 'mapping-row';
    const targets = (state.fieldCatalog.fields || []).filter((field) => field.writable && field.targetPath);
    row.innerHTML = `<select class="mapping-target"><option value="">Select CRM field</option>${targets.map((field) => option(field.targetPath, `${field.label} · ${field.objectModel}`)).join('')}</select>
      <button type="button" class="mapping-delete" title="Remove mapping">×</button>${valueComposerMarkup()}`;
    row.querySelector('.mapping-target').value = target;
    row.querySelector('.mapping-target').onchange = syncGuidedAction;
    wireValueComposer(row, value, syncGuidedAction);
    row.querySelector('.mapping-delete').onclick = () => { row.remove(); syncGuidedAction(); };
    el('mappingRows').appendChild(row);
    if (sync) syncGuidedAction();
  }

  function valueComposerMarkup(multiline = false) {
    const raw = multiline ? '<textarea class="value-raw" rows="4" placeholder="Enter a value" hidden></textarea>' : '<input class="value-raw" type="text" placeholder="Enter a value" hidden />';
    return `<div class="value-composer"><select class="value-mode" aria-label="Value source"><option value="field">CRM / runtime field</option><option value="literal">Fixed value</option><option value="template">Template</option></select><button type="button" class="value-field field-picker-button">Select a runtime field</button>${raw}<input class="dynamic-value" type="hidden" /></div>`;
  }

  function inferValueMode(value) {
    const text = typeof value === 'string' ? value : '';
    if (/^\{\{\s*[^}]+\s*\}\}$/.test(text)) return 'field';
    if (text.includes('{{')) return 'template';
    return 'literal';
  }

  function wireValueComposer(row, value, onSync) {
    const mode = row.querySelector('.value-mode'), raw = row.querySelector('.value-raw'), hidden = row.querySelector('.dynamic-value');
    mode.value = inferValueMode(value);
    hidden.value = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
    raw.value = hidden.value;
    const update = (notify = true) => {
      const fieldMode = mode.value === 'field';
      row.querySelector('.value-field').hidden = !fieldMode;
      raw.hidden = fieldMode;
      raw.placeholder = mode.value === 'template' ? 'Hello {{trigger.firstName}}' : 'Enter a fixed value';
      if (!fieldMode) hidden.value = raw.value;
      if (notify) onSync?.();
    };
    mode.onchange = update;
    raw.oninput = () => { hidden.value = raw.value; onSync?.(); };
    row.querySelector('.value-field').onclick = () => openTemplatePicker('composer', row);
    setFieldButton(row.querySelector('.value-field'), hidden.value);
    update(false);
  }

  function setComposerField(row, field) {
    row.querySelector('.value-mode').value = 'field';
    row.querySelector('.dynamic-value').value = field.template;
    row.querySelector('.value-raw').value = field.template;
    row.querySelector('.value-field').hidden = false;
    row.querySelector('.value-raw').hidden = true;
    setFieldButton(row.querySelector('.value-field'), field.runtimePath);
  }

  function composerValue(row) {
    const text = row.querySelector('.dynamic-value').value;
    if (row.querySelector('.value-mode').value !== 'literal') return text;
    try { return JSON.parse(text); } catch { return text; }
  }

  function renderCodeInputRows(inputs) {
    el('codeInputRows').innerHTML = '';
    for (const [key, value] of Object.entries(inputs || {})) addCodeInputRow(key, value, false);
    if (!el('codeInputRows').children.length) addCodeInputRow('', '', false);
  }

  function addCodeInputRow(key = '', value = '', sync = true) {
    const row = document.createElement('div'); row.className = 'code-input-row';
    row.innerHTML = `<input class="code-input-key" type="text" maxlength="64" placeholder="Input name" /><button type="button" class="mapping-delete" title="Remove input">×</button>${valueComposerMarkup()}`;
    row.querySelector('.code-input-key').value = key;
    row.querySelector('.code-input-key').oninput = syncGuidedAction;
    wireValueComposer(row, value, syncGuidedAction);
    row.querySelector('.mapping-delete').onclick = () => { row.remove(); syncGuidedAction(); };
    el('codeInputRows').appendChild(row);
    if (sync) syncGuidedAction();
  }

  function syncGuidedAction() {
    const node = selectedNode(); if (!node || node.type !== 'action') return;
    try {
      if (['ghl.update_contact', 'ghl.upsert_contact'].includes(node.action)) {
        const fields = {}, customFields = [];
        for (const row of el('mappingRows').querySelectorAll('.mapping-row')) {
          const target = row.querySelector('.mapping-target').value, value = composerValue(row);
          if (!target) continue;
          if (target.startsWith('customFields:')) customFields.push({ id: target.slice(13), field_value: value });
          else fields[target] = value;
        }
        if (customFields.length) fields.customFields = customFields;
        node.config.fields = fields;
      } else if (['ghl.add_tags', 'ghl.remove_tags'].includes(node.action)) node.config.tags = el('actionTags').value.split(',').map((item) => item.trim()).filter(Boolean);
      else if (node.action === 'data.set') node.config.key = el('dataKey').value;
      else if (['code.run', 'parrot.inline'].includes(node.action)) {
        const inputs = {};
        for (const row of el('codeInputRows').querySelectorAll('.code-input-row')) {
          const key = row.querySelector('.code-input-key').value.trim();
          if (key) inputs[key] = composerValue(row);
        }
        node.config = {
          language:node.action === 'parrot.inline' ? 'python' : el('codeLanguage').value,
          inputs, code:el('codeSource').value, timeoutMs:Number(node.config?.timeoutMs) || 5000,
          ...(node.action === 'parrot.inline' ? { capabilities:Array.isArray(node.config?.capabilities) ? node.config.capabilities : [] } : {}),
        };
        updateCodeStats();
      } else syncCatalogActionConfig(node);
      el('nodeConfig').value = JSON.stringify(node.config || {}, null, 2);
      markDirty(); renderCanvas();
    } catch (error) { showAlert('error', error.message); }
  }

  function updateCodeStats() {
    const code = el('codeSource').value || '';
    const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(code).length : code.length;
    el('codeStats').textContent = `${code ? code.split(/\r?\n/).length : 0} lines · ${bytes} bytes`;
  }

  function focusCodeEditor() {
    const focused = state.inspectorExpanded && state.paletteCollapsed && state.executionCollapsed;
    state.inspectorExpanded = !focused;
    state.paletteCollapsed = !focused;
    state.executionCollapsed = !focused;
    applyWorkspaceLayout();
    if (!focused) el('codeSource').focus();
  }

  function applyWorkspaceLayout() {
    const workspace = document.querySelector('.hawk-workspace');
    const consolePanel = document.querySelector('.execution-console');
    workspace?.classList.toggle('palette-collapsed', state.paletteCollapsed);
    workspace?.classList.toggle('inspector-expanded', state.inspectorExpanded);
    consolePanel?.classList.toggle('collapsed', state.executionCollapsed);
    el('togglePaletteButton').textContent = state.paletteCollapsed ? 'Show step library' : 'Hide step library';
    el('toggleInspectorButton').textContent = state.inspectorExpanded ? 'Compact editor' : 'Expand editor';
    el('toggleExecutionConsole').textContent = state.executionCollapsed ? 'Expand history' : 'Collapse';
    el('expandCodeEditorButton').textContent = state.inspectorExpanded && state.paletteCollapsed && state.executionCollapsed ? 'Exit focus' : 'Focus code';
    requestAnimationFrame(renderEdges);
  }

  function renderConditionValueHints(runtimePath) {
    const field = (state.fieldCatalog.fields || []).find((item) => item.runtimePath === runtimePath);
    const values = Array.isArray(field?.allowedValues) ? field.allowedValues : [];
    el('conditionAllowedValues').innerHTML = values.map((value) => `<option value="${escapeHtml(value.value ?? value.label ?? value)}"></option>`).join('');
    el('conditionValueHints').hidden = !values.length;
    el('conditionValueHints').innerHTML = values.slice(0, 12).map((value) => {
      const choice = String(value.value ?? value.label ?? value);
      return `<button type="button" data-condition-value="${escapeHtml(choice)}">${escapeHtml(value.label ?? choice)}</button>`;
    }).join('');
    for (const button of el('conditionValueHints').querySelectorAll('button')) button.onclick = () => {
      el('conditionValue').value = button.dataset.conditionValue;
      updateNode((node) => { node.config.value = conditionInputValue(); }, true);
    };
  }

  function renderRuntimeBrowser() {
    if (!el('runtimeFieldList')) return;
    const q = el('runtimeSearch').value.trim().toLowerCase();
    const model = el('runtimeObjectFilter').value;
    const fields = (state.fieldCatalog.fields || []).filter((field) => {
      if (model && field.objectModel !== model) return false;
      return !q || [field.label, field.objectModel, field.runtimePath, field.dataType].join(' ').toLowerCase().includes(q);
    }).slice(0, 100);
    el('runtimeFieldList').innerHTML = fields.length ? fields.map((field) => runtimeVariableMarkup(field.label, `${field.objectModel} · ${field.dataType}`, field.runtimePath)).join('') : '<div class="runtime-empty">No matching fields. Refresh the CRM catalog if the schema changed.</div>';
    const node = selectedNode();
    const steps = (state.current?.graph?.nodes || []).filter((item) => item.id !== node?.id && item.type !== 'end');
    el('runtimeStepList').innerHTML = steps.length ? steps.map((item) => runtimeVariableMarkup(item.name || item.id, typeLabels[item.type] || 'Step', `steps.${item.id}.response.*`, true)).join('') : '<div class="runtime-empty">Previous step outputs will appear as the flow grows.</div>';
    for (const button of document.querySelectorAll('.runtime-variable-list button[data-runtime-path]')) button.onclick = () => {
      const path = button.dataset.runtimePath;
      const field = (state.fieldCatalog.fields || []).find((item) => item.runtimePath === path) || { label: path, runtimePath: path, template: `{{${path}}}` };
      useRuntimeField(field);
    };
  }

  function runtimeVariableMarkup(label, meta, path, wildcard = false) {
    return `<article><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(meta)}</span><code>${escapeHtml(path)}</code></div><button type="button" data-runtime-path="${escapeHtml(path)}">Use</button>${wildcard ? '<small>Choose a concrete response property in Advanced JSON when needed.</small>' : ''}</article>`;
  }

  function useRuntimeField(field) {
    const node = selectedNode();
    if (!node) return showAlert('warning', 'Select a step before inserting a runtime value.');
    const template = field.template || `{{${field.runtimePath}}}`;
    if (node.type === 'condition') {
      node.config.field = field.runtimePath; markDirty(); renderInspector(); selectInspectorTab('setup');
    } else if (node.type === 'trigger' && (node.config.event || '').includes('field_')) {
      node.config.field = field.fieldId || field.fieldKey || field.runtimePath; node.config.fieldPath = field.runtimePath; markDirty(); renderInspector(); selectInspectorTab('setup');
    } else if (node.type === 'action' && node.action === 'data.set') {
      node.config.value = template; markDirty(); renderInspector(); selectInspectorTab('setup');
    } else if (node.type === 'action' && ['code.run', 'parrot.inline'].includes(node.action)) {
      selectInspectorTab('setup'); addCodeInputRow(suggestInputKey(field.runtimePath), template);
    } else if (node.type === 'action' && ['ghl.update_contact', 'ghl.upsert_contact'].includes(node.action)) {
      selectInspectorTab('setup'); addMappingRow('', template);
    } else if (node.type === 'action' && !el('catalogActionFields').hidden) {
      const row = [...el('catalogActionFields').querySelectorAll('.catalog-action-row')].find((item) => item.querySelector('.dynamic-value') && !item.querySelector('.dynamic-value').value)
        || [...el('catalogActionFields').querySelectorAll('.catalog-action-row')].find((item) => item.querySelector('.dynamic-value'));
      if (!row) return showAlert('warning', 'This action has no compatible variable input.');
      selectInspectorTab('setup'); setComposerField(row, { ...field, template }); syncGuidedAction();
    } else {
      showAlert('warning', 'This step has no variable slot. Choose an action mapping, condition, or custom code step.');
    }
  }

  function suggestInputKey(path) {
    const part = String(path || 'value').replace(/\.\*$/, '').split('.').pop() || 'value';
    return part.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^\d/, '_$&');
  }

  function selectTestInputMode(mode) {
    if (mode === 'guided' && state.testInputMode === 'json') {
      try { loadGuidedTestInput(JSON.parse(el('testInput').value || '{}')); }
      catch { return showAlert('error', 'Fix the JSON before returning to guided input.'); }
    }
    if (mode === 'json' && state.testInputMode === 'guided') syncGuidedTestInput();
    state.testInputMode = mode;
    document.querySelectorAll('[data-test-input-mode]').forEach((button) => button.classList.toggle('active', button.dataset.testInputMode === mode));
    el('guidedTestPanel').hidden = mode !== 'guided';
    el('jsonTestPanel').hidden = mode !== 'json';
  }

  function loadGuidedTestInput(input) {
    el('testInputRows').innerHTML = '';
    for (const [path, value] of flattenObject(input)) addTestInputRow(`trigger.${path}`, value, false);
    if (!el('testInputRows').children.length) addTestInputRow('trigger.contactId', '', false);
    syncGuidedTestInput();
  }

  function flattenObject(value, prefix = '') {
    const rows = [];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) rows.push(...flattenObject(child, prefix ? `${prefix}.${key}` : key));
    } else if (prefix) rows.push([prefix, value]);
    return rows;
  }

  function addTestInputRow(path = '', value = '', sync = true) {
    const row = document.createElement('div'); row.className = 'test-input-row';
    row.innerHTML = `<button type="button" class="test-field field-picker-button">Select trigger field</button><input class="test-path" type="hidden" /><input class="test-value" type="text" placeholder="Sample value" /><button type="button" class="mapping-delete" title="Remove value">×</button>`;
    row.querySelector('.test-path').value = path;
    row.querySelector('.test-value').value = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    setFieldButton(row.querySelector('.test-field'), path);
    row.querySelector('.test-field').onclick = () => openFieldPicker({ current: path, onSelect: (field) => { row.querySelector('.test-path').value = field.runtimePath; setFieldButton(row.querySelector('.test-field'), field.runtimePath); syncGuidedTestInput(); } });
    row.querySelector('.test-value').oninput = syncGuidedTestInput;
    row.querySelector('.mapping-delete').onclick = () => { row.remove(); syncGuidedTestInput(); };
    el('testInputRows').appendChild(row);
    if (sync) syncGuidedTestInput();
  }

  function buildGuidedTestInput() {
    const output = {};
    for (const row of el('testInputRows').querySelectorAll('.test-input-row')) {
      const path = row.querySelector('.test-path').value.replace(/^trigger\.?/, '');
      if (!path || path.includes('*')) continue;
      setNested(output, path.split('.'), parseSampleValue(row.querySelector('.test-value').value));
    }
    return output;
  }

  function setNested(target, parts, value) {
    let cursor = target;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) cursor[part] = value;
      else cursor = cursor[part] && typeof cursor[part] === 'object' ? cursor[part] : (cursor[part] = {});
    });
  }

  function parseSampleValue(value) {
    try { return JSON.parse(value); } catch { return value; }
  }

  function syncGuidedTestInput() {
    const input = buildGuidedTestInput();
    const json = JSON.stringify(input, null, 2);
    el('testInputPreview').textContent = json;
    el('testInput').value = json;
    renderTestInputSummary();
  }

  function renderTestInputSummary() {
    const count = el('testInputRows')?.querySelectorAll('.test-input-row').length || 0;
    el('testInputSummary').textContent = count ? `${count} guided trigger value${count === 1 ? '' : 's'} ready. JSON mode remains available.` : 'Open the test runner to build representative trigger data.';
  }

  async function exportCurrentFlow() {
    if (!state.current) return;
    try {
      await saveCurrent();
      const automationPackage = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/export?${scopeQuery()}`);
      downloadJsonFile(automationPackage, flowJsonFilename(state.current.name));
      showAlert('success', `Exported draft revision ${state.current.draftRevision}.`);
    } catch (error) { showAlert('error', error.message); }
  }

  async function openFlowCode() {
    if (!state.current) return;
    try {
      await saveCurrent();
      const automationPackage = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/export?${scopeQuery()}`);
      el('flowCodeSource').value = JSON.stringify(automationPackage, null, 2);
      el('flowCodeName').textContent = state.current.name;
      el('flowCodeMeta').textContent = `Draft revision ${state.current.draftRevision} · ${state.current.status} · ${state.current.dataSourceSlug || 'core'}`;
      setFlowCodeStatus('Loaded from the current saved draft. Changes remain drafts until separately published.', 'valid');
      el('flowCodeDialog').showModal();
      setTimeout(() => el('flowCodeSource').focus(), 0);
    } catch (error) { showAlert('error', error.message); }
  }

  function parseFlowCode() {
    let automationPackage;
    try { automationPackage = JSON.parse(el('flowCodeSource').value || '{}'); }
    catch (error) { throw new Error(`Flow Code is not valid JSON: ${error.message}`); }
    if (automationPackage?.format !== 'hawk-automation-1') throw new Error('Flow Code format must be hawk-automation-1.');
    if (!Array.isArray(automationPackage.flows) || automationPackage.flows.length !== 1) throw new Error('Flow Code must contain exactly one flow.');
    const sourceFlowId = String(automationPackage.generatedFor?.flowId || '');
    if (sourceFlowId && sourceFlowId !== state.current?.id) throw new Error('This JSON was exported from a different HAWK flow. Use Import / Re-import instead.');
    return automationPackage;
  }

  function formatFlowCode() {
    try {
      const automationPackage = parseFlowCode();
      el('flowCodeSource').value = JSON.stringify(automationPackage, null, 2);
      setFlowCodeStatus('JSON formatted. Validate it against the live CRM schema before saving.', '');
    } catch (error) { setFlowCodeStatus(error.message, 'invalid'); }
  }

  async function validateFlowCode() {
    try {
      const automationPackage = parseFlowCode();
      const data = await api('/api/hawk/imports/preview', {
        method:'POST',
        body:JSON.stringify({ ...scope(), integrationId:state.current?.integrationId || null, automationPackage }),
      });
      const validation = data.imports?.[0]?.validation;
      if (!validation?.valid) {
        const message = validation?.errors?.slice(0, 5).map((item) => `${item.nodeId ? item.nodeId + ': ' : ''}${item.message}`).join(' · ') || 'Flow Code is invalid.';
        setFlowCodeStatus(message, 'invalid');
        return false;
      }
      setFlowCodeStatus(`Valid · ${validation.stats.nodes} steps · ${validation.stats.actions} actions · live CRM references verified.`, 'valid');
      return true;
    } catch (error) {
      const validation = error.payload?.details || error.payload?.validation;
      const message = validation?.errors?.slice(0, 5).map((item) => item.message).join(' · ') || error.message;
      setFlowCodeStatus(message, 'invalid');
      return false;
    }
  }

  async function saveFlowCode() {
    if (!state.current) return;
    const valid = await validateFlowCode();
    if (!valid) return;
    try {
      const automationPackage = parseFlowCode();
      el('saveFlowCodeButton').disabled = true;
      const data = await api(`/api/hawk/flows/${encodeURIComponent(state.current.id)}/source`, {
        method:'PUT',
        body:JSON.stringify({ ...scope(), expectedRevision:state.current.draftRevision, automationPackage }),
      });
      state.current = data.flow;
      state.selectedNodeId = state.current.graph.nodes.some((node) => node.id === state.selectedNodeId)
        ? state.selectedNodeId
        : state.current.graph.startNodeId;
      setDirty(false);
      el('flowCodeSource').value = JSON.stringify(data.automationPackage, null, 2);
      el('flowCodeName').textContent = state.current.name;
      el('flowCodeMeta').textContent = `Draft revision ${state.current.draftRevision} · ${state.current.status} · ${state.current.dataSourceSlug || 'core'}`;
      setFlowCodeStatus(`Saved draft revision ${state.current.draftRevision}. Publish separately when ready.`, 'valid');
      renderAll();
      await loadFlows(state.current.id);
    } catch (error) {
      const details = error.payload?.details;
      const message = details?.errors?.slice(0, 5).map((item) => item.message).join(' · ') || error.message;
      setFlowCodeStatus(message, 'invalid');
    } finally { el('saveFlowCodeButton').disabled = false; }
  }

  function downloadFlowCode() {
    try {
      const automationPackage = parseFlowCode();
      downloadJsonFile(automationPackage, flowJsonFilename(automationPackage.flows[0].name));
      setFlowCodeStatus('Downloaded the current editor contents.', 'valid');
    } catch (error) { setFlowCodeStatus(error.message, 'invalid'); }
  }

  function downloadJsonFile(value, filename) {
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type:'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function flowJsonFilename(name) {
    const stem = String(name || 'hawk-flow').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'hawk-flow';
    return `${stem}.json`;
  }

  function setFlowCodeStatus(message, stateName) {
    el('flowCodeStatus').textContent = message;
    el('flowCodeStatus').className = `flow-code-status${stateName ? ` ${stateName}` : ''}`;
  }

  function openImport() {
    if (!scopeReady()) return showAlert('warning', 'Select a portfolio and location first.');
    state.importPackage = null; state.importPreview = null;
    el('importFile').value = ''; el('importJson').value = '';
    el('importFolder').value = state.libraryFolderId !== 'all' && state.libraryFolderId !== 'unfiled' ? state.libraryFolderId : '';
    el('importColor').value = '#2f85de';
    el('importConflictPolicy').value = 'skip';
    el('importPreview').textContent = 'Choose or paste a package, then preview it.';
    el('applyImportButton').disabled = true; el('importDialog').showModal();
  }

  async function readImportFile() {
    const file = el('importFile').files[0]; if (!file) return;
    if (file.size > 1024 * 1024) return showAlert('error', 'HAWK import files may not exceed 1 MB.');
    el('importJson').value = await file.text(); state.importPackage = null; state.importPreview = null; el('applyImportButton').disabled = true;
  }

  function parseImportPackage() {
    let source = String(el('importJson').value || '{}').trim().replace(/^\uFEFF/, '');
    if (source.startsWith('```')) source = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(source); } catch (error) {
      throw new Error(`Automation package must be valid JSON. ${error.message}`);
    }
  }

  async function previewImport() {
    try {
      const automationPackage = parseImportPackage();
      const data = await api('/api/hawk/imports/preview', { method: 'POST', body: JSON.stringify({ ...scope(), integrationId: el('connection').value || null, automationPackage }) });
      state.importPackage = automationPackage; state.importPreview = data.imports;
      const valid = data.imports.every((item) => item.validation.valid);
      el('importPreview').innerHTML = data.imports.map((item) => `<article class="${item.validation.valid ? 'valid' : 'invalid'}"><strong>${escapeHtml(item.name)}</strong><span>${item.validation.stats.nodes} steps · ${item.validation.valid ? 'Ready to import' : `${item.validation.errors.length} errors`}</span>${item.validation.valid ? '' : `<small>${escapeHtml(item.validation.errors.slice(0, 3).map((error) => error.message).join(' · '))}</small>`}</article>`).join('');
      el('applyImportButton').disabled = !valid;
    } catch (error) { el('applyImportButton').disabled = true; showAlert('error', error.message); }
  }

  async function applyImport() {
    if (!state.importPackage || !state.importPreview?.every((item) => item.validation.valid)) return;
    try {
      el('applyImportButton').disabled = true;
      const data = await api('/api/hawk/imports/apply', { method: 'POST', body: JSON.stringify({ ...scope(), integrationId: el('connection').value || null, folderId: el('importFolder').value || null, color: el('importColor').value, conflictPolicy: el('importConflictPolicy').value, automationPackage: state.importPackage }) });
      el('importDialog').close(); await loadFlows(data.results.find((item) => item.flowId)?.flowId || null);
      showAlert('success', `Imported ${data.results.filter((item) => item.action !== 'skipped').length} draft flows; ${data.results.filter((item) => item.action === 'skipped').length} skipped.`);
    } catch (error) { el('applyImportButton').disabled = false; showAlert('error', error.message); }
  }

  async function downloadLiveSchema() {
    try {
      const query = new URLSearchParams({ ...scope(), integrationId: el('connection').value || '' });
      const response = await fetch(base + '/api/hawk/imports/schema?' + query, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Could not generate live CRM schema.');
      const blob = await response.blob(), link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = 'hawk-live-automation.schema.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) { showAlert('error', error.message); }
  }

  function setZoom(value) {
    state.scale = Math.min(1.5, Math.max(0.5, Math.round(value * 10) / 10));
    el('canvasSurface').style.transform = `scale(${state.scale})`;
    el('zoomValue').textContent = `${Math.round(state.scale * 100)}%`;
  }
  function fitCanvas() {
    const nodes = state.current?.graph?.nodes || []; if (!nodes.length) return;
    const minX = Math.min(...nodes.map((node) => node.position.x));
    const maxX = Math.max(...nodes.map((node) => node.position.x + 192));
    const minY = Math.min(...nodes.map((node) => node.position.y));
    const maxY = Math.max(...nodes.map((node) => node.position.y + 80));
    const viewport = el('canvasViewport');
    setZoom(Math.min(1, (viewport.clientWidth - 80) / Math.max(300, maxX - minX), (viewport.clientHeight - 80) / Math.max(220, maxY - minY)));
    viewport.scrollLeft = Math.max(0, ((minX + maxX) / 2) * state.scale - viewport.clientWidth / 2);
    viewport.scrollTop = Math.max(0, ((minY + maxY) / 2) * state.scale - viewport.clientHeight / 2);
  }

  function conditionInputValue() {
    const value = el('conditionValue').value;
    return el('conditionOperator').value === 'in' ? value.split(',').map((item) => item.trim()).filter(Boolean) : value;
  }
  function defaultActionConfig(action) {
    if (action === 'ghl.update_contact') return { contactId: '{{trigger.contactId}}', fields: { firstName: '{{trigger.firstName}}', lastName: '{{trigger.lastName}}', email: '{{trigger.email}}' } };
    if (action === 'ghl.upsert_contact') return { fields: { firstName: '{{trigger.firstName}}', lastName: '{{trigger.lastName}}', email: '{{trigger.email}}', phone: '{{trigger.phone}}' } };
    if (['ghl.add_tags', 'ghl.remove_tags'].includes(action)) return { contactId: '{{trigger.contactId}}', tags: action === 'ghl.add_tags' ? ['lead-processed'] : [] };
    if (action === 'code.run') return { language: 'javascript', inputs: { contactId: '{{trigger.contactId}}' }, code: 'return { contactId: inputs.contactId };', timeoutMs: 5000 };
    if (action === 'parrot.inline') return { language:'python', inputs:{ contactId:'{{trigger.contactId}}' }, code:'def run(inputs, context):\n    return {"contactId": inputs.get("contactId"), "dryRun": context.get("dryRun")}\n', capabilities:[], timeoutMs:5000 };
    if (action === 'data.set') return { key: 'result', value: '{{trigger.contactId}}' };
    const definition = actionDefinitionFor(action);
    return Object.fromEntries((definition?.fields || []).filter((field) => field.defaultValue !== '' && field.defaultValue != null)
      .map((field) => [field.key, structuredClone(field.defaultValue)]));
  }
  function nodeDetail(node) {
    if (node.type === 'trigger') return triggerLabels[node.config?.event] || node.config?.event || 'Manual';
    if (node.type === 'condition') return `${node.config?.field || 'field'} ${titleCase(node.config?.operator || '')}`;
    if (node.type === 'action') return actionLabels[node.action] || node.action || 'Action';
    return 'Flow completed';
  }
  function firstTarget(excludeId) { return state.current.graph.nodes.find((node) => node.id !== excludeId && node.type !== 'trigger')?.id || ''; }
  function uniqueNodeId(seed) {
    const baseId = String(seed || 'step').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]+/, '') || 'step';
    const used = new Set(state.current.graph.nodes.map((node) => node.id));
    let id = baseId, index = 2; while (used.has(id)) id = `${baseId}_${index++}`; return id.slice(0, 64);
  }
  function nodeById(id) { return state.current?.graph?.nodes?.find((node) => node.id === id); }
  function selectedNode() { return nodeById(state.selectedNodeId); }
  function markDirty() { setDirty(true); }
  function setDirty(value) { state.dirty = value; el('dirtyState').hidden = !value; }
  function scope() { return { apiKeyId: el('apiKey').value, locationId: el('location').value, dataSourceSlug:el('dataSource').value || 'core' }; }
  function scopeReady() { const value = scope(); return Boolean(value.apiKeyId && value.locationId); }
  function scopeQuery() { return new URLSearchParams(scope()).toString(); }

  async function api(path, options = {}) {
    const response = await fetch(base + path, { headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status})`);
      error.status = response.status; error.code = payload.code; error.payload = payload;
      throw error;
    }
    return payload;
  }
  function fillSelect(select, items, selected, valueFn, labelFn) {
    select.innerHTML = items.map((item) => option(valueFn(item), labelFn(item))).join('');
    select.value = selected || '';
  }
  function option(value, label, selected = false) { return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`; }
  function selectedOptionText(select) { return select.selectedOptions[0]?.value ? select.selectedOptions[0].textContent : ''; }
  function showAlert(type, message) {
    const box = el('hawkAlert'); box.className = `hawk-alert ${type}`; box.textContent = message; box.hidden = false;
    clearTimeout(showAlert.timer); showAlert.timer = setTimeout(() => { box.hidden = true; }, 8000);
  }
  function formatDate(value) { if (!value) return '—'; return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
  function formatDuration(ms) { if (ms == null) return '—'; return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`; }
  function titleCase(value) { return String(value || '').replace(/[._-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

  init();
})();
