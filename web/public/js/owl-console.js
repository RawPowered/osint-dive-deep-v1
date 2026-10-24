(function () {
  'use strict';

  const base = location.pathname.replace(/\/owl\/?$/, '') || '';
  const el = (id) => document.getElementById(id);
  let sources = [];
  let leads = [];
  let users = [];
  let schedules = [];
  let scheduleSessions = [];
  let scheduleCanEdit = false;
  let complianceChecks = [];
  let complianceAttempts = [];
  let auditEvents = [];
  let leadSources = [];
  let crmUsers = [];
  let assignmentPolicy = null;
  let poolRules = [];
  let channelPools = [];
  let servicePools = [];
  let access = {};
  let dncScrubConfigured = false;
  let dncQueueLeadLabels = new Map();
  let dncPendingCutoff = null;
  let dncPendingTotal = 0;
  let dncReviewCutoff = null;
  let dncReviewTotal = 0;
  let dncReviewReleasable = 0;
  let dncRescrubCutoff = null;
  let dncRescrubPoolTotal = 0;
  let leadOffset = 0;
  let activeTab = 'pools';
  let owlWebhookEndpoint = null;
  const selectedLeads = new Set();

  const nav = { navDash: '', navKeys: '/keys', navSql: '/connections', navCrm: '/crm-integrations', navEagle: '/eagle', navSong:'/song', navHawk:'/hawk', navParrot:'/parrot', navSentinel: '/sentinel', navDocs: '/docs' };
  Object.entries(nav).forEach(([id, suffix]) => { el(id).href = base + suffix; });

  async function api(path, options = {}) {
    const response = await fetch(base + path, {
      ...options,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'OWL request failed');
    return data;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showAlert(type, message) {
    const box = el('alert');
    box.hidden = !message;
    box.className = message ? 'alert alert-' + type : '';
    box.textContent = message || '';
  }

  function context() {
    return { apiKeyId: el('apiKey').value, source: el('source').value || 'core', locationId: el('location').value };
  }

  function query(extra = {}) {
    const params = new URLSearchParams({ ...context(), ...extra });
    for (const [key, value] of [...params.entries()]) if (!value) params.delete(key);
    return params.toString();
  }

  function body(extra = {}) { return JSON.stringify({ ...context(), ...extra }); }
  function sourceInfo() { return sources.find((item) => item.slug === el('source').value) || null; }
  function can(table, operation) { const info = sourceInfo(); return Boolean(info && info.tables[table] && info.tables[table][operation]); }

  function applyAccessUi() {
    if (access.principalType !== 'tenant') return;
    ['navDash','navKeys','navSql','navCrm','navEagle','navSentinel'].forEach((id) => { el(id).hidden = true; });
  }

  async function bootstrap(apiKeyId) {
    const data = await api('/api/owl/bootstrap' + (apiKeyId ? '?' + new URLSearchParams({ apiKeyId }) : ''));
    if (!apiKeyId) {
      el('apiKey').innerHTML = data.keys.map((key) => `<option value="${escapeHtml(key.id)}">${escapeHtml(key.name)} (${escapeHtml(key.keyPrefix)})</option>`).join('');
    }
    sources = data.sources || [];
    access = data.access || {};
    dncScrubConfigured = Boolean(data.dncScrub?.configured);
    applyAccessUi();
    el('source').innerHTML = sources.map((source) => `<option value="${escapeHtml(source.slug)}">${escapeHtml(source.name)}</option>`).join('');
    await loadLocations();
  }

  async function reloadKeyContext() {
    const data = await api('/api/owl/bootstrap?' + new URLSearchParams({ apiKeyId: el('apiKey').value }));
    sources = data.sources || [];
    access = data.access || access;
    dncScrubConfigured = Boolean(data.dncScrub?.configured);
    applyAccessUi();
    el('source').innerHTML = sources.map((source) => `<option value="${escapeHtml(source.slug)}">${escapeHtml(source.name)}</option>`).join('');
    await loadLocations();
  }

  async function loadLocations() {
    const data = await api('/api/owl/locations?' + query({ locationId: '' }));
    const previous = el('location').value;
    const contexts = new Map((data.locationContexts || []).map((item) => [item.locationId,item]));
    el('location').innerHTML = (data.locations || []).map((locationId) => {
      const item=contexts.get(locationId);const suffix=item?.databaseDiscovered&&item?.integrationGranted?'API + database':item?.integrationGranted?'API-bound':'database only';
      return `<option value="${escapeHtml(locationId)}">${escapeHtml(locationId)} · ${escapeHtml(suffix)}</option>`;
    }).join('');
    if (data.locations.includes(previous)) el('location').value = previous;
    const selected=contexts.get(el('location').value);const bridge=el('scopeBridge');
    bridge.classList.toggle('warning',Boolean(data.databaseStatus?.error)||Boolean(selected?.integrationGranted&&!selected?.databaseDiscovered));
    bridge.textContent=data.databaseStatus?.error
      ? `The API-key location remains available, but ${data.databaseStatus.source} could not be queried: ${data.databaseStatus.error}`
      : selected?.integrationGranted&&!selected?.databaseDiscovered
        ? 'This location is authorized by the CRM API integration. The selected database contains no discoverable location rows, so database-backed panels may be empty until its grants or data are corrected.'
        : selected ? 'Location scope is connected across the API integration and selected database.' : 'No location is assigned to this API-key context.';
    resetLeadSources();
    updateScope();
    await refreshAll();
  }

  function resetLeadSources() {
    leadSources = [];
    poolRules = [];
    servicePools = [];
    el('leadSource').innerHTML = '<option value="">Open Leads to load sources</option>';
    el('movePool').innerHTML = '<option value="">Move to pool</option>';
    el('moveService').innerHTML = '<option value="">Move to service</option>';
    el('leadService').innerHTML = '<option value="">All services</option>';
    el('pullStatus').hidden = true;
    updateActionAvailability();
  }

  function lockContext(locked) {
    ['apiKey', 'source', 'location', 'refreshButton'].forEach((id) => { el(id).disabled = locked; });
  }

  function updateScope() {
    const keyLabel = el('apiKey').selectedOptions[0]?.textContent || 'No key';
    const sourceLabel = el('source').selectedOptions[0]?.textContent || 'No source';
    el('scopeState').textContent = `${keyLabel} / ${sourceLabel} / ${el('location').value || 'No location'}`;
  }

  async function loadSummary() {
    if (!el('location').value) return setSummary({});
    const data = await api('/api/owl/summary?' + query());
    setSummary(data.summary || {});
  }

  function setSummary(summary) {
    el('kpiLeads').textContent = summary.leads == null ? '-' : summary.leads;
    el('kpiUsers').textContent = summary.users == null ? '-' : summary.users;
    el('kpiDialers').textContent = summary.dialers == null ? '-' : summary.dialers;
    el('kpiSchedules').textContent = summary.schedules == null ? '-' : summary.schedules;
  }

  async function loadPools() {
    if (!can('leads', 'select') || !el('location').value) return renderUnavailable('poolRows', 6, 'Lead table is not selectable for this context.');
    const [management, distribution, serviceManagement] = await Promise.all([
      api('/api/owl/pool-management?' + query()),
      api('/api/owl/pools?' + query()),
      api('/api/owl/service-pools?' + query()),
    ]);
    renderPoolManagement(management);
    renderServiceManagement(serviceManagement);
    const rows = distribution.pools || [];
    el('poolRows').innerHTML = rows.length ? rows.map((row) => `<tr><td>${escapeHtml(row.serviceType)}</td><td><span class="owl-badge">${escapeHtml(row.status)}</span></td><td>${row.total}</td><td>${row.available}</td><td>${row.assigned}</td><td>${formatDate(row.newestLead)}</td></tr>`).join('') : emptyRow(6, 'No leads in this location.');
  }

  function renderServiceManagement(data) {
    servicePools = data.services || [];
    assignmentPolicy = data.assignmentPolicy || assignmentPolicy;
    renderAssignmentPolicy();
    const unmapped = data.unmappedServices || [];
    const enabled = servicePools.filter((service) => service.isEnabled);
    el('servicePoolCount').textContent = `${enabled.length} enabled service pool(s)`;
    el('serviceConfigured').textContent = enabled.length;
    el('serviceLeads').textContent = servicePools.reduce((sum, service) => sum + service.total, 0);
    el('serviceAvailable').textContent = servicePools.reduce((sum, service) => sum + service.available, 0);
    el('serviceUnmapped').textContent = unmapped.reduce((sum, service) => sum + service.total, 0);
    el('servicePoolBoard').innerHTML = servicePools.map((service) => `<article class="owl-pool-card ${service.isEnabled ? '' : 'disabled'}" style="--pool-color:${escapeHtml(service.color)}">
      <div class="owl-pool-card-head"><h3>${escapeHtml(service.serviceType)}</h3><div class="owl-pool-flags">${service.isFallback ? '<span class="owl-flag">Fallback</span>' : ''}${service.calendarIds.length ? '<span class="owl-flag">Calendar ready</span>' : '<span class="owl-flag">No calendar</span>'}${service.isEnabled ? '' : '<span class="owl-flag">Disabled</span>'}</div></div>
      <strong class="owl-pool-total">${service.total}</strong>
      <div class="owl-service-metrics"><span>Available<strong>${service.available}</strong></span><span>Active<strong>${service.active}</strong></span><span>Outcomes<strong>${service.terminal}</strong></span></div>
      <div class="muted small">${service.defaultCalendarId ? `Default calendar: ${escapeHtml(service.defaultCalendarId)}` : 'Calendar not assigned'}<br>${service.fallbackUserId ? `Fallback dialer: ${escapeHtml(users.find((user) => user.id === service.fallbackUserId)?.crmUserName || users.find((user) => user.id === service.fallbackUserId)?.username || service.fallbackUserId)}` : 'Fallback dialer not assigned'}</div>
      <div class="owl-pool-dialers">${(service.dialers || []).length ? service.dialers.map((dialer) => `<div class="owl-pool-dialer"><strong>${escapeHtml(dialer.crmUserName || dialer.username || dialer.crmUserId)}</strong><span>${Number(dialer.callCount) || 0} calls</span><span>${dialer.scheduleRate == null ? 'no rate' : `${dialer.scheduleRate}% set`}</span></div>`).join('') : '<span class="muted small">No round-robin dialers enabled</span>'}</div>
      <div class="owl-pool-card-actions"><button class="btn btn-primary btn-sm" data-recheck-service="${escapeHtml(service.serviceType)}">Queue missing</button><button class="btn btn-secondary btn-sm" data-view-service="${escapeHtml(service.serviceType)}">View leads</button><button class="btn btn-secondary btn-sm" data-edit-service="${escapeHtml(service.serviceType)}">Edit pool</button></div>
    </article>`).join('');
    el('serviceRuleRows').innerHTML = servicePools.map((service) => `<tr><td><div class="owl-pool-name"><span class="owl-color-swatch" style="--pool-color:${escapeHtml(service.color)}"></span><strong>${escapeHtml(service.serviceType)}</strong></div></td>
      <td><div class="owl-keywords">${service.tagKeywords.length ? service.tagKeywords.map((keyword) => `<span class="owl-badge">${escapeHtml(keyword)}</span>`).join('') : '<span class="muted">Unmatched tags</span>'}</div></td>
      <td>${service.defaultCalendarId ? `<strong>${escapeHtml(service.defaultCalendarId)}</strong><div class="muted small">${service.calendarIds.length} configured</div>` : '<span class="muted">Not assigned</span>'}</td>
      <td>${service.isFallback ? 'Yes' : '-'}</td><td>${service.total}</td><td>${service.available}</td><td>${service.terminal}</td>
      <td><button class="btn btn-secondary btn-sm" data-edit-service="${escapeHtml(service.serviceType)}">Edit</button></td></tr>`).join('');
    el('unmappedServices').hidden = !unmapped.length;
    el('unmappedServices').textContent = unmapped.length ? `Lead service values without rules: ${unmapped.map((item) => `${item.serviceType} (${item.total})`).join(', ')}` : '';
    document.querySelectorAll('[data-edit-service]').forEach((button) => { button.onclick = () => openService(button.dataset.editService); });
    document.querySelectorAll('[data-view-service]').forEach((button) => { button.onclick = () => viewServiceLeads(button.dataset.viewService); });
    document.querySelectorAll('[data-recheck-service]').forEach((button) => { button.onclick = () => recheckServicePool(button.dataset.recheckService, button); });
    syncServiceOptions();
  }

  function renderAssignmentPolicy() {
    const policy = assignmentPolicy || {};
    el('requireAssignmentSchedule').checked = Boolean(policy.requireSubmittedSchedule);
    el('assignmentLanguageFieldId').value = policy.languageFieldId || '';
    el('assignmentLanguageFieldKey').value = policy.languageFieldKey || '';
    el('assignmentLanguageRules').value = (policy.languageRules || []).map((rule) => `${rule.code} | ${rule.label} | ${(rule.values || []).join(', ')}`).join('\n');
    if (el('schedulePolicyNote')) el('schedulePolicyNote').innerHTML = policy.requireSubmittedSchedule
      ? '<strong>Enforced mode</strong>A submitted weekly plan is required for automatic assignment and lead pulls.'
      : '<strong>Planning mode</strong>Schedules are informational and do not block assignment.';
  }

  async function saveAssignmentPolicy() {
    try {
      const languageRules = el('assignmentLanguageRules').value.split(/\r?\n/).map((line) => {
        const [code, label, values] = line.split('|').map((part) => part.trim());
        return { code, label, values:String(values || '').split(',').map((value) => value.trim()).filter(Boolean) };
      }).filter((rule) => rule.code && rule.label && rule.values.length);
      if (!languageRules.length) return showAlert('warning', 'Add at least one valid language rule.');
      const data = await api('/api/owl/assignment-policy', { method:'PUT', body:body({
        requireSubmittedSchedule:el('requireAssignmentSchedule').checked,
        languageFieldId:el('assignmentLanguageFieldId').value.trim() || null,
        languageFieldKey:el('assignmentLanguageFieldKey').value.trim() || null,
        defaultLanguageCode:assignmentPolicy?.defaultLanguageCode || 'en',
        languageRules,
      }) });
      assignmentPolicy = data.policy; renderAssignmentPolicy();
      showAlert('success', 'Assignment policy saved and audited. HAWK will use it on the next execution.');
    } catch (error) { showAlert('error', error.message); }
  }

  async function recheckServicePool(serviceType, button) {
    const original = button.textContent;
    try {
      button.disabled = true; button.textContent = 'Checking...';
      const preview = await runRecheckPages(serviceType, true, button);
      if (!preview.candidates) {
        showAlert('success', `${serviceType}: no missing queue signals. ${preview.skipped} lead(s) safely skipped.`);
        return;
      }
      const approved = window.confirm(`${serviceType}: ${preview.candidates} lead(s) are missing their proper queue tag across ${preview.pages} batch(es).\n\nRemove any stale cc-recheck and send a fresh cc-recheck signal now?\n\n${preview.skipped} skipped; ${preview.failed} lookup failure(s).`);
      if (!approved) return;
      button.textContent = 'Queueing...';
      const result = await runRecheckPages(serviceType, false, button);
      showAlert(result.failed ? 'error' : 'success', `${serviceType}: ${result.queued} fresh recheck(s) queued, ${result.cleared} stale signal(s) cleared, ${result.skipped} skipped, ${result.failed} failed.`);
      await refreshAll();
    } catch (error) { showAlert('error', error.message); }
    finally { button.disabled = false; button.textContent = original; }
  }

  async function runRecheckPages(serviceType, dryRun, button) {
    const total = { scanned:0, candidates:0, cleared:0, queued:0, skipped:0, failed:0, pages:0 };
    let afterLeadId = '';
    for (let page = 1; page <= 100; page += 1) {
      button.textContent = `${dryRun ? 'Checking' : 'Queueing'} ${page}...`;
      const result = await api('/api/owl/service-pools/recheck', {
        method:'POST', body:body({ serviceType, dryRun, confirm:!dryRun, limit:100, afterLeadId:afterLeadId || undefined }),
      });
      total.pages += 1;
      for (const key of ['scanned','candidates','cleared','queued','skipped','failed']) total[key] += Number(result[key] || 0);
      if (!result.hasMore || !result.nextCursor || result.nextCursor === afterLeadId) return total;
      afterLeadId = result.nextCursor;
    }
    throw new Error(`${serviceType}: queue scan exceeded 100 safe batches.`);
  }

  function syncServiceOptions() {
    const enabled = servicePools.filter((service) => service.isEnabled);
    const options = enabled.map((service) => `<option value="${escapeHtml(service.serviceType)}">${escapeHtml(service.serviceType)}</option>`).join('');
    const filterValue = el('leadService').value;
    el('leadService').innerHTML = '<option value="">All services</option>' + options;
    if ([...el('leadService').options].some((option) => option.value === filterValue)) el('leadService').value = filterValue;
    el('moveService').innerHTML = '<option value="">Move to service</option>' + options;
  }

  async function openService(serviceType) {
    await ensureUsers();
    const service = servicePools.find((item) => item.serviceType === serviceType) || null;
    el('serviceDialogTitle').textContent = service ? `Edit ${service.serviceType}` : 'New service pool';
    el('editServiceName').value = service?.serviceType || '';
    el('editServiceName').disabled = Boolean(service);
    el('editServiceKeywords').value = service?.tagKeywords.join(', ') || '';
    el('editServiceCalendarIds').value = service?.calendarIds.join(', ') || '';
    el('editServiceDefaultCalendar').value = service?.defaultCalendarId || '';
    const mappedUsers = users.filter((user) => user.crmUserId);
    el('editServiceFallbackUser').innerHTML = '<option value="">No fallback dialer</option>' + mappedUsers.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.crmUserName || user.username || user.crmUserId)}</option>`).join('');
    el('editServiceFallbackUser').value = service?.fallbackUserId || '';
    el('editServiceColor').value = service?.color || '#64748b';
    el('editServiceSort').value = service?.sortOrder ?? 100;
    el('editServiceFallback').checked = Boolean(service?.isFallback);
    el('editServiceEnabled').checked = service ? service.isEnabled : true;
    el('serviceDialog').showModal();
  }

  async function saveService() {
    try {
      await api('/api/owl/service-pools', { method: 'PUT', body: body({
        serviceType: el('editServiceName').value,
        tagKeywords: el('editServiceKeywords').value.split(',').map((value) => value.trim()).filter(Boolean),
        calendarIds: el('editServiceCalendarIds').value.split(',').map((value) => value.trim()).filter(Boolean),
        defaultCalendarId: el('editServiceDefaultCalendar').value.trim(),
        fallbackUserId: el('editServiceFallbackUser').value || null,
        color: el('editServiceColor').value,
        sortOrder: Number(el('editServiceSort').value),
        isFallback: el('editServiceFallback').checked,
        isEnabled: el('editServiceEnabled').checked,
      }) });
      el('serviceDialog').close(); showAlert('success', 'Service pool mapping saved and audited.'); await refreshAll();
    } catch (error) { showAlert('error', error.message); }
  }

  async function previewServiceSync() {
    try {
      const data = await api('/api/owl/service-pools/reclassify', { method: 'POST', body: body({ dryRun: true }) });
      el('serviceSyncDialog').dataset.changed = String(data.changed);
      el('serviceSyncSummary').textContent = `${data.scanned} leads scanned; ${data.changed} would change. ${data.truncated ? 'Preview limited to 5,000 leads.' : ''}`;
      el('serviceSyncRows').innerHTML = data.samples.length ? data.samples.map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.before || '-')}</td><td>${escapeHtml(item.after)}</td></tr>`).join('') : emptyRow(3, 'All scanned leads already match their CRM tags.');
      el('applyServicesButton').disabled = !data.changed;
      el('serviceSyncDialog').showModal();
    } catch (error) { showAlert('error', error.message); }
  }

  async function applyServiceSync() {
    try {
      const data = await api('/api/owl/service-pools/reclassify', { method: 'POST', body: body({ dryRun: false }) });
      el('serviceSyncDialog').close(); showAlert('success', `${data.updated} lead service assignment(s) updated and audited.`); await refreshAll();
    } catch (error) { showAlert('error', error.message); }
  }

  async function viewServiceLeads(serviceType) {
    el('leadService').value = serviceType; leadOffset = 0; await activateTab('leads');
  }

  async function loadPoolManagement() {
    if (!can('leads', 'select') || !el('location').value) return;
    renderPoolManagement(await api('/api/owl/pool-management?' + query()));
  }

  async function loadServiceManagement() {
    if (!can('leads', 'select') || !el('location').value) return;
    renderServiceManagement(await api('/api/owl/service-pools?' + query()));
  }

  function renderPoolManagement(data) {
    poolRules = data.pools || [];
    channelPools = data.channelPools || [];
    const unmapped = data.unmapped || [];
    el('poolCount').textContent = `${poolRules.length} governed destination pool(s)`;
    el('poolAssignable').textContent = sumPools((pool) => pool.isEnabled && pool.isAssignable);
    el('poolTerminal').textContent = sumPools((pool) => pool.isEnabled && pool.isTerminal);
    el('poolActive').textContent = sumPools((pool) => pool.isEnabled && !pool.isTerminal && !pool.isAssignable);
    el('poolUnmapped').textContent = unmapped.reduce((sum, row) => sum + row.total, 0);
    const lifecycleCards = poolRules.map((pool) => `<article class="owl-pool-card ${pool.isEnabled ? '' : 'disabled'}" style="--pool-color:${escapeHtml(pool.color)}">
      <div class="owl-pool-card-head"><h3>${escapeHtml(pool.label)}</h3><div class="owl-pool-flags">${pool.isAssignable ? '<span class="owl-flag assignable">Dialer</span>' : ''}${pool.isTerminal ? '<span class="owl-flag terminal">Terminal</span>' : ''}${pool.isEnabled ? '' : '<span class="owl-flag">Disabled</span>'}</div></div>
      <strong class="owl-pool-total">${pool.total}</strong>
      <div class="owl-pool-split"><span>${pool.assigned} owned</span><span>${pool.unassigned} unowned</span></div>
      <div class="owl-pool-card-actions">${pool.poolKey === 'dnc_pending' ? '<button class="btn btn-primary btn-sm" data-open-dnc-screening>Screen leads</button>' : ''}${pool.poolKey === 'no_phone' ? '<button class="btn btn-primary btn-sm" data-refresh-no-phone>Check for phones</button>' : ''}<button class="btn btn-secondary btn-sm" data-view-pool="${escapeHtml(pool.poolKey)}">View leads</button><button class="btn btn-secondary btn-sm" data-edit-pool="${escapeHtml(pool.poolKey)}">Edit</button></div>
    </article>`).join('');
    const channelCards = channelPools.map((pool) => `<article class="owl-pool-card" style="--pool-color:${escapeHtml(pool.color)}">
      <div class="owl-pool-card-head"><h3>${escapeHtml(pool.label)}</h3><div class="owl-pool-flags"><span class="owl-flag assignable">Channel</span><span class="owl-flag">Multi-pool</span></div></div>
      <strong class="owl-pool-total">${pool.total}</strong>
      <div class="owl-pool-split"><span>available records</span><span>not send authorization</span></div>
      <div class="owl-pool-card-actions"><button class="btn btn-secondary btn-sm" data-view-channel="${escapeHtml(pool.channel)}">View leads</button></div>
    </article>`).join('');
    el('poolBoard').innerHTML = lifecycleCards + channelCards;
    el('poolRuleRows').innerHTML = poolRules.map((pool) => `<tr>
      <td><div class="owl-pool-name"><span class="owl-color-swatch" style="--pool-color:${escapeHtml(pool.color)}"></span><div><strong>${escapeHtml(pool.label)}</strong><div class="muted small">${escapeHtml(pool.poolKey)}</div></div></div></td>
      <td>${pool.statusValues.map((status) => `<span class="owl-badge">${escapeHtml(status)}</span>`).join(' ')}</td>
      <td><code>${escapeHtml(pool.destinationStatus)}</code></td><td>${escapeHtml(policyLabel(pool.assignmentPolicy))}</td>
      <td>${pool.isAssignable ? 'Eligible' : '-'}</td><td>${pool.isTerminal ? 'Terminal' : 'Active'}</td>
      <td><button class="btn btn-secondary btn-sm" data-edit-pool="${escapeHtml(pool.poolKey)}">Edit</button></td></tr>`).join('');
    el('unmappedPools').hidden = !unmapped.length;
    el('unmappedPools').textContent = unmapped.length
      ? `Unmapped statuses: ${unmapped.map((row) => `${row.status} (${row.total})`).join(', ')}` : '';
    bindPoolActions();
    syncPoolOptions();
  }

  function sumPools(predicate) { return poolRules.filter(predicate).reduce((sum, pool) => sum + pool.total, 0); }
  function policyLabel(policy) { return policy === 'require_user' ? 'Require owner' : policy === 'preserve' ? 'Keep owner' : 'Clear owner'; }

  function bindPoolActions() {
    document.querySelectorAll('[data-edit-pool]').forEach((button) => { button.onclick = () => openPool(button.dataset.editPool); });
    document.querySelectorAll('[data-view-pool]').forEach((button) => { button.onclick = () => viewPoolLeads(button.dataset.viewPool); });
    document.querySelectorAll('[data-open-dnc-screening]').forEach((button) => { button.onclick = openDncScreening; });
    document.querySelectorAll('[data-refresh-no-phone]').forEach((button) => { button.onclick = () => refreshNoPhonePool(button); });
    document.querySelectorAll('[data-view-channel]').forEach((button) => { button.onclick = () => viewChannelLeads(button.dataset.viewChannel); });
  }

  async function refreshNoPhonePool(button) {
    button.disabled = true;
    button.textContent = 'Checking CRM...';
    try {
      const data = await api('/api/owl/no-phone/refresh', { method:'POST', body:body({ limit:500 }) });
      showAlert(data.failed ? 'warning' : 'success',
        `No Phone check complete: ${data.processed} refreshed, ${data.failed} unresolved, ${data.remaining} remain without a routable phone.`);
      await Promise.all([loadPoolManagement(), loadSummary(), loadLeads()]);
    } catch (error) {
      showAlert('error', error.message);
    } finally {
      button.textContent = 'Check for phones';
      button.disabled = false;
    }
  }

  async function openDncScreening() {
    el('dncScreenDialog').showModal();
    setDncScreenStatus('', '');
    el('dncRunResultsPanel').hidden = true;
    el('dncRunResultRows').innerHTML = '';
    await loadDncScreening();
  }

  function dncEvidenceHtml(item, fallbackState = 'pending') {
    const state = item.dncStatus || fallbackState;
    const code = item.resultCode || item.dncResultCode || '';
    const label = item.resultLabel || state;
    const reason = item.reason || item.dncReason || item.error || '';
    const category = item.decisionCategory || item.dncDecisionCategory || '';
    const review = item.reviewRequired === true || Number(item.dncReviewRequired) === 1;
    return `<span class="owl-badge dnc-${escapeHtml(state)}">${escapeHtml(label)}</span>` +
      (code ? `<span class="owl-dnc-code">${escapeHtml(code)}</span>` : '') +
      (review ? '<span class="owl-review-flag">review</span>' : '') +
      (category ? `<div class="owl-dnc-reason">${escapeHtml(category.replace(/_/g, ' '))}</div>` : '') +
      (reason ? `<div class="owl-dnc-reason">${escapeHtml(reason)}</div>` : '');
  }

  function renderDncRunResults(results) {
    const rows = Array.isArray(results) ? results : [];
    el('dncRunResultsPanel').hidden = !rows.length;
    if (!rows.length) return;
    el('dncRunResultsCount').textContent = `${rows.length} lead result(s); review holds remain non-callable until a clean result resolves them.`;
    el('dncRunResultRows').innerHTML = rows.map((result) => {
      const lead = dncQueueLeadLabels.get(String(result.leadId)) || {};
      const name = lead.name || result.leadId;
      const reason = result.reason || result.error || 'No provider reason returned.';
      const review = Boolean(result.reviewRequired);
      return `<tr><td><strong>${escapeHtml(name)}</strong><div class="muted small">${escapeHtml(result.leadId)}</div></td>` +
        `<td>${dncEvidenceHtml({ ...result, reason:'', error:'' })}</td>` +
        `<td><div class="owl-dnc-reason">${escapeHtml(reason)}</div></td>` +
        `<td>${review ? '<span class="owl-review-flag">required</span>' : '<span class="muted">—</span>'}</td></tr>`;
    }).join('');
  }

  async function loadDncScreening() {
    el('dncScreenRows').innerHTML = emptyRow(5, 'Loading DNC screening queue...');
    try {
      const [data, rescrub] = await Promise.all([
        api('/api/owl/dnc-screening?' + query({ limit: 40 })),
        api('/api/owl/dnc-rescrub?' + query()),
      ]);
      const rows = data.rows || [];
      dncQueueLeadLabels = new Map(rows.map((lead) => {
        const name = lead.contactName || lead.id;
        return [String(lead.id), { name, serviceType:lead.serviceType }];
      }));
      const pendingTotal = Number(data.counts?.pending) || 0;
      dncPendingTotal = pendingTotal;
      dncReviewTotal = Number(data.counts?.review) || 0;
      dncReviewReleasable = Number(data.counts?.releasable) || 0;
      el('dncScreenCount').textContent = `${pendingTotal} pending · ${dncReviewTotal} held for review`;
      el('dncRefreshAllButton').disabled = !pendingTotal || !dncScrubConfigured;
      el('dncReviewRescrubButton').disabled = !dncReviewTotal || !dncScrubConfigured;
      el('dncReviewReleaseButton').disabled = !dncReviewReleasable;
      el('dncReviewCount').textContent = `${dncReviewTotal} review hold(s); ${dncReviewReleasable} B hold(s) releasable`;
      dncRescrubPoolTotal = Number(rescrub.total) || 0;
      el('dncRescrubPoolButton').disabled = !rescrub.total || !dncScrubConfigured;
      el('dncRescrubCount').textContent = `${rescrub.total} lead(s) in the true DNC pool` +
        (rescrub.lastRescrubAt ? `; last re-scrub ${formatDate(rescrub.lastRescrubAt)}` : '');
      if (!dncScrubConfigured) {
        setDncScreenStatus('error', 'DNCScrub is not configured. Add DNC_SCRUB_KEY to the server environment and restart Node.');
      }
      el('dncScreenRows').innerHTML = rows.length ? rows.map((lead) => {
        const name = lead.contactName || lead.id;
        return `<tr><td><strong>${escapeHtml(name)}</strong><div class="muted small">${escapeHtml(lead.id)}</div></td><td>${escapeHtml(lead.serviceType || 'Other')}</td><td>${formatDate(lead.dateAdded)}</td><td>${dncEvidenceHtml(lead)}</td><td><div class="owl-screen-actions"><button type="button" class="btn btn-primary btn-sm" data-dnc-refresh="${escapeHtml(lead.id)}" ${dncScrubConfigured ? '' : 'disabled'}>Scrub lead</button></div></td></tr>`;
      }).join('') : emptyRow(5, 'No leads are waiting for DNC screening.');
      document.querySelectorAll('[data-dnc-refresh]').forEach((button) => {
        button.onclick = () => refreshDncLead(button.dataset.dncRefresh, button);
      });
    } catch (error) {
      el('dncScreenRows').innerHTML = emptyRow(5, error.message);
      el('dncRefreshAllButton').disabled = true;
      el('dncReviewRescrubButton').disabled = true;
      el('dncReviewReleaseButton').disabled = true;
      el('dncRescrubPoolButton').disabled = true;
      setDncScreenStatus('error', error.message);
    }
  }

  async function refreshDncLead(leadId, button) {
    button.disabled = true;
    try {
      const data = await api('/api/owl/dnc-screening/' + encodeURIComponent(leadId) + '/scrub', {
        method: 'POST', body: body(),
      });
      const result = data.lead;
      renderDncRunResults([result]);
      const crmNote = result.crmSync?.status === 'synced'
        ? ' CRM contact updated.'
        : result.crmSync?.status === 'failed' ? ` CRM update failed (${result.crmSync.error}).` : '';
      setDncScreenStatus(['pending', 'review'].includes(result.dncStatus) || result.crmSync?.status === 'failed' ? '' : 'success',
        result.dncStatus === 'pending'
          ? 'DNCScrub did not return a definitive result. Lead remains in screening.'
          : result.dncStatus === 'review'
            ? `DNCScrub returned a non-DNC compliance hold${result.reason ? ` (${result.reason})` : ''}. The lead is not counted as DNC and remains non-callable pending a clean re-scrub.${crmNote}`
          : `DNCScrub screened this lead as ${result.dncStatus}${result.reason ? ` (${result.reason})` : ''}.${crmNote}`);
      await Promise.all([loadDncScreening(), loadPoolManagement(), loadSummary()]);
    } catch (error) {
      setDncScreenStatus('error', error.message);
      await loadDncScreening().catch(() => {});
    } finally {
      button.disabled = !dncPendingCutoff && (!dncPendingTotal || !dncScrubConfigured);
    }
  }

  async function refreshAllDncLeads() {
    const button = el('dncRefreshAllButton');
    button.disabled = true;
    button.textContent = dncPendingCutoff ? 'Resuming pending scrub...' : 'Scrubbing pending leads...';
    const aggregate = { processed:0, clean:0, blocked:0, review:0, failed:0, crmSynced:0, crmFailed:0 };
    const displayedResults = [];
    try {
      for (let batch = 0; batch < 100; batch += 1) {
        const data = await api('/api/owl/dnc-screening/scrub', {
          method:'POST',
          body:body({ limit:500, cutoff:dncPendingCutoff || undefined }),
        });
        dncPendingCutoff = data.cutoff;
        for (const key of ['processed','clean','blocked','review','failed']) aggregate[key] += Number(data[key]) || 0;
        aggregate.crmSynced += Number(data.crmSync?.synced) || 0;
        aggregate.crmFailed += Number(data.crmSync?.failed) || 0;
        displayedResults.push(...(data.results || []));
        if (displayedResults.length > 2000) displayedResults.splice(0, displayedResults.length - 2000);
        renderDncRunResults(displayedResults);
        setDncScreenStatus(data.failed ? 'error' : 'success',
          `Pending scrub in progress: ${aggregate.clean} clean, ${aggregate.blocked} true DNC, ${aggregate.review} moved to review, ` +
          `${aggregate.failed} unresolved; ${data.remaining} remain in this run. Provider batch ` +
          `${data.providerBatchSize || 0}/${data.providerBatchLimit || 0}, throttled to ${data.providerRequestsPerMinute || 0}/minute.`);
        if (!data.remaining) {
          dncPendingCutoff = null;
          setDncScreenStatus(aggregate.failed || aggregate.crmFailed ? 'error' : 'success',
            `Pending scrub complete: every selected lead was attempted once. ${aggregate.clean} clean, ${aggregate.blocked} true DNC, ` +
            `${aggregate.review} moved to review, ${aggregate.failed} unresolved. ${data.reviewRemaining || 0} review holds await explicit re-scrub. ` +
            `CRM write-back: ${aggregate.crmSynced} updated, ${aggregate.crmFailed} failed.`);
          break;
        }
      }
      if (dncPendingCutoff) {
        setDncScreenStatus('error', 'The safety batch limit was reached. Use Resume pending scrub to continue this run.');
      }
      await Promise.all([loadDncScreening(), loadPoolManagement(), loadSummary()]);
    } catch (error) {
      setDncScreenStatus('error', `${error.message} Completed pending batches remain saved; use Resume pending scrub to continue.`);
    } finally {
      button.textContent = dncPendingCutoff ? 'Resume pending scrub' : 'Scrub all pending leads';
      button.disabled = !dncScrubConfigured || (!dncPendingCutoff && !dncPendingTotal);
    }
  }

  async function rescrubDncReviews() {
    const button = el('dncReviewRescrubButton');
    if (!dncReviewCutoff && !window.confirm(
      'Re-scrub every DNC review hold once? These leads remain non-callable unless DNCScrub returns a clean result.'
    )) return;
    button.disabled = true;
    button.textContent = dncReviewCutoff ? 'Resuming review re-scrub...' : 'Re-scrubbing reviews...';
    const aggregate = { processed:0, released:0, movedToDnc:0, stillReview:0, failed:0, changed:0, crmSynced:0, crmFailed:0 };
    const displayedResults = [];
    try {
      for (let batch = 0; batch < 100; batch += 1) {
        const data = await api('/api/owl/dnc-review-rescrub', {
          method:'POST',
          body:body({
            limit:500,
            cutoff:dncReviewCutoff || undefined,
            confirm:'RESCRUB_DNC_REVIEWS',
          }),
        });
        dncReviewCutoff = data.cutoff;
        for (const key of ['processed','released','movedToDnc','stillReview','failed','changed']) {
          aggregate[key] += Number(data[key]) || 0;
        }
        aggregate.crmSynced += Number(data.crmSync?.synced) || 0;
        aggregate.crmFailed += Number(data.crmSync?.failed) || 0;
        displayedResults.push(...(data.results || []));
        if (displayedResults.length > 2000) displayedResults.splice(0, displayedResults.length - 2000);
        renderDncRunResults(displayedResults);
        setDncScreenStatus(data.failed ? 'error' : 'success',
          `Review re-scrub in progress: ${aggregate.released} released, ${aggregate.movedToDnc} true DNC, ` +
          `${aggregate.stillReview} still held, ${aggregate.failed} unresolved; ${data.remaining} remain in this run. ` +
          `Provider batch ${data.providerBatchSize || 0}/${data.providerBatchLimit || 0}, throttled to ${data.providerRequestsPerMinute || 0}/minute.`);
        if (!data.remaining) {
          dncReviewCutoff = null;
          setDncScreenStatus(aggregate.failed || aggregate.crmFailed ? 'error' : 'success',
            `Review re-scrub complete: every selected hold was checked once. ${aggregate.released} released, ` +
            `${aggregate.movedToDnc} moved to true DNC, ${aggregate.stillReview} still held, ${aggregate.failed} unresolved. ` +
            `CRM write-back: ${aggregate.crmSynced} updated, ${aggregate.crmFailed} failed.`);
          break;
        }
      }
      if (dncReviewCutoff) {
        setDncScreenStatus('error', 'The safety batch limit was reached. Use Resume review re-scrub to continue this run.');
      }
      await Promise.all([loadDncScreening(), loadPoolManagement(), loadSummary(), loadLeads()]);
    } catch (error) {
      setDncScreenStatus('error', `${error.message} Completed review batches remain saved; use Resume review re-scrub to continue.`);
    } finally {
      button.textContent = dncReviewCutoff ? 'Resume review re-scrub' : 'Re-scrub review holds';
      button.disabled = !dncScrubConfigured || (!dncReviewCutoff && !dncReviewTotal);
    }
  }

  async function releaseDncReviewHolds() {
    const button = el('dncReviewReleaseButton');
    if (!window.confirm(
      `Release ${dncReviewReleasable} provider B configuration/coverage hold(s) into the dial population? ` +
      'This is an administrative override. Original B evidence remains recorded; true DNC and other review codes are excluded. ' +
      'Normal consent, calling-time, attempt-limit, and channel-preference checks still apply.'
    )) return;
    button.disabled = true;
    button.textContent = 'Releasing B holds...';
    const aggregate = { released:0, crmSynced:0, crmFailed:0, crmSkipped:0 };
    const releaseReason = 'Florida provider B configuration/coverage hold released by administrator';
    try {
      for (let batch = 0; batch < 100; batch += 1) {
        const data = await api('/api/owl/dnc-review-release', {
          method:'POST',
          body:body({
            limit:50,
            confirm:'RELEASE_DNC_B_REVIEWS',
            releaseReason,
          }),
        });
        aggregate.released += Number(data.released) || 0;
        aggregate.crmSynced += Number(data.crmSync?.synced) || 0;
        aggregate.crmFailed += Number(data.crmSync?.failed) || 0;
        aggregate.crmSkipped += Number(data.crmSync?.skipped) || 0;
        setDncScreenStatus(data.crmSync?.failed ? 'error' : 'success',
          `Administrative B-hold release in progress: ${aggregate.released} moved to ${data.destinationPool || 'the dial population'}; ` +
          `${data.remaining || 0} eligible B hold(s) remain. CRM: ${aggregate.crmSynced} updated, ${aggregate.crmFailed} failed.`);
        if (!data.remaining) break;
      }
      setDncScreenStatus(aggregate.crmFailed ? 'error' : 'success',
        `Administrative B-hold release complete: ${aggregate.released} moved into the dial population. ` +
        `CRM write-back: ${aggregate.crmSynced} updated, ${aggregate.crmFailed} failed, ${aggregate.crmSkipped} skipped. ` +
        'Provider B evidence and the administrative override remain audited.');
      await Promise.all([loadDncScreening(), loadPoolManagement(), loadSummary(), loadLeads()]);
    } catch (error) {
      setDncScreenStatus('error', `${error.message} Completed release batches remain saved; run the release again to continue.`);
      await loadDncScreening().catch(() => {});
    } finally {
      button.textContent = 'Release B holds to dial population';
      button.disabled = !dncReviewReleasable;
    }
  }

  async function syncDncCrmBacklog() {
    const button = el('dncCrmSyncButton');
    button.disabled = true;
    button.textContent = 'Syncing saved results...';
    try {
      const data = await api('/api/owl/dnc-crm-sync', {
        method:'POST', body:body({ limit:500 }),
      });
      setDncScreenStatus(data.crmSync?.failed ? 'error' : 'success',
        `Saved DNC results synchronized to GHL: ${data.crmSync?.synced || 0} updated, ` +
        `${data.crmSync?.failed || 0} failed, ${data.crmSync?.skipped || 0} skipped; ${data.remaining || 0} remain.`);
    } catch (error) {
      setDncScreenStatus('error', error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Sync saved results to GHL';
    }
  }

  async function rescrubDncPool() {
    const button = el('dncRescrubPoolButton');
    if (!dncRescrubCutoff && !window.confirm(
      'Re-scrub every lead currently in the DNC pool? True DNC matches remain blocked; configuration, coverage, invalid-data, and jurisdiction results move to non-callable review.'
    )) return;
    button.disabled = true;
    button.textContent = dncRescrubCutoff ? 'Resuming DNC re-scrub...' : 'Re-scrubbing DNC pool...';
    const aggregate = { processed:0, released:0, stillBlocked:0, heldForReview:0, failed:0, changed:0, crmSynced:0, crmFailed:0 };
    const displayedResults = [];
    try {
      for (let batch = 0; batch < 100; batch += 1) {
        const data = await api('/api/owl/dnc-rescrub', {
          method:'POST',
          body:body({
            limit:500,
            cutoff:dncRescrubCutoff || undefined,
            confirm:'RESCRUB_DNC_POOL',
          }),
        });
        dncRescrubCutoff = data.cutoff;
        for (const key of ['processed','released','stillBlocked','heldForReview','failed','changed']) aggregate[key] += Number(data[key]) || 0;
        aggregate.crmSynced += Number(data.crmSync?.synced) || 0;
        aggregate.crmFailed += Number(data.crmSync?.failed) || 0;
        displayedResults.push(...(data.results || []));
        if (displayedResults.length > 2000) displayedResults.splice(0, displayedResults.length - 2000);
        renderDncRunResults(displayedResults);
        setDncScreenStatus(data.failed ? 'error' : 'success',
          `DNC pool re-scrub in progress: ${aggregate.released} released, ${aggregate.stillBlocked} true DNC, ${aggregate.heldForReview} moved to review, ` +
          `${aggregate.failed} unresolved, ${data.remaining} remaining in this run. ` +
          `Provider batch ${data.providerBatchSize || 0}/${data.providerBatchLimit || 0}, throttled to ${data.providerRequestsPerMinute || 0}/minute.`);
        if (!data.remaining) {
          dncRescrubCutoff = null;
          setDncScreenStatus(aggregate.failed || aggregate.crmFailed ? 'error' : 'success',
            `DNC pool re-scrub complete: ${aggregate.processed} definitive result(s), ${aggregate.released} released, ` +
            `${aggregate.stillBlocked} true DNC, ${aggregate.heldForReview} moved to review, ${aggregate.failed} unresolved, ${aggregate.changed} decision(s) changed. ` +
            `CRM write-back: ${aggregate.crmSynced} updated, ${aggregate.crmFailed} failed.`);
          break;
        }
      }
      if (dncRescrubCutoff) {
        setDncScreenStatus('error', 'The safety batch limit was reached. Use Resume DNC re-scrub to continue this run.');
      }
      await Promise.all([loadDncScreening(), loadPoolManagement(), loadSummary(), loadLeads()]);
    } catch (error) {
      setDncScreenStatus('error', `${error.message} The completed batches remain saved; use Resume DNC re-scrub to continue.`);
    } finally {
      button.textContent = dncRescrubCutoff ? 'Resume DNC re-scrub' : 'Re-scrub DNC pool';
      button.disabled = !dncRescrubPoolTotal || !dncScrubConfigured;
    }
  }

  function setDncScreenStatus(type, message) {
    const status = el('dncScreenStatus');
    status.hidden = !message;
    status.className = message ? `owl-sync-summary ${type ? 'is-' + type : ''}` : 'owl-sync-summary';
    status.textContent = message || '';
  }

  function syncPoolOptions() {
    const enabled = poolRules.filter((pool) => pool.isEnabled);
    el('movePool').innerHTML = '<option value="">Move to pool</option>' + enabled.map((pool) => `<option value="${escapeHtml(pool.poolKey)}">${escapeHtml(pool.label)}</option>`).join('');
    const statuses = [...new Set(enabled.flatMap((pool) => pool.statusValues))];
    const filter = el('leadStatus'); const previousFilter = filter.value;
    filter.innerHTML = '<option value="">All pools / statuses</option>' + enabled.map((pool) => `<option value="pool:${escapeHtml(pool.poolKey)}">${escapeHtml(pool.label)}</option>`).join('');
    if ([...filter.options].some((option) => option.value === previousFilter)) filter.value = previousFilter;
    const edit = el('editLeadStatus'); const previousEdit = edit.value;
    edit.innerHTML = statuses.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join('');
    if (statuses.includes(previousEdit)) edit.value = previousEdit;
  }

  function openPool(poolKey) {
    const pool = poolRules.find((item) => item.poolKey === poolKey) || null;
    el('poolDialogTitle').textContent = pool ? `Edit ${pool.label}` : 'New pool rule';
    el('editPoolKey').value = pool?.poolKey || ''; el('editPoolKey').disabled = Boolean(pool);
    el('editPoolLabel').value = pool?.label || ''; el('editPoolStatuses').value = pool?.statusValues.join(', ') || '';
    el('editPoolDestination').value = pool?.destinationStatus || ''; el('editPoolAssignment').value = pool?.assignmentPolicy || 'clear';
    el('editPoolColor').value = pool?.color || '#64748b'; el('editPoolSort').value = pool?.sortOrder ?? 100;
    el('editPoolAssignable').checked = Boolean(pool?.isAssignable); el('editPoolTerminal').checked = Boolean(pool?.isTerminal);
    el('editPoolEnabled').checked = pool ? pool.isEnabled : true; el('poolDialog').showModal();
  }

  async function savePool() {
    const poolKey = el('editPoolKey').value.trim().toLowerCase();
    try {
      await api('/api/owl/pool-rules/' + encodeURIComponent(poolKey), { method: 'PUT', body: body({
        label: el('editPoolLabel').value,
        statusValues: el('editPoolStatuses').value.split(',').map((value) => value.trim()).filter(Boolean),
        destinationStatus: el('editPoolDestination').value,
        assignmentPolicy: el('editPoolAssignment').value,
        color: el('editPoolColor').value,
        sortOrder: Number(el('editPoolSort').value),
        isAssignable: el('editPoolAssignable').checked,
        isTerminal: el('editPoolTerminal').checked,
        isEnabled: el('editPoolEnabled').checked,
      }) });
      el('poolDialog').close(); showAlert('success', 'Pool routing rule saved and audited.'); await refreshAll();
    } catch (error) { showAlert('error', error.message); }
  }

  async function viewPoolLeads(poolKey) {
    const pool = poolRules.find((item) => item.poolKey === poolKey); if (!pool) return;
    el('leadStatus').value = `pool:${pool.poolKey}`; leadOffset = 0; await activateTab('leads');
  }

  async function viewChannelLeads(channel) {
    el('leadChannel').value = channel;
    leadOffset = 0;
    await activateTab('leads');
  }

  function channelEvidenceHtml(lead) {
    if (lead.phoneMarketingStatus == null && lead.emailMarketingStatus == null && lead.smsMarketingStatus == null) return '';
    const channels = [
      ['Phone', lead.phoneMarketingStatus], ['Email', lead.emailMarketingStatus], ['SMS', lead.smsMarketingStatus],
    ];
    return `<div class="owl-channel-badges">${channels.map(([label, status]) =>
      `<span class="owl-badge channel-${escapeHtml(status || 'unavailable')}">${escapeHtml(label)}: ${escapeHtml(status || 'unavailable')}</span>`
    ).join(' ')}</div>`;
  }

  async function loadLeads() {
    selectedLeads.clear(); el('leadCheckAll').checked = false; updateSelectedCount();
    if (!can('leads', 'select') || !el('location').value) return renderUnavailable('leadRows', 8, 'Lead table is not selectable for this context.');
    await Promise.all([loadPoolManagement(), loadServiceManagement()]);
    const extra = { offset: leadOffset, limit: 50, search: el('leadSearch').value, serviceType: el('leadService').value, status: el('leadStatus').value, dncStatus: el('leadDnc').value, marketingChannel: el('leadChannel').value, dncReviewRequired: el('leadDncReview').value };
    const data = await api('/api/owl/leads?' + query(extra));
    leads = data.rows || [];
    el('leadTotal').textContent = `${data.total} lead(s), showing ${data.offset + 1}-${Math.min(data.offset + data.rows.length, data.total)}`;
    el('leadPrev').disabled = data.offset <= 0;
    el('leadNext').disabled = data.offset + data.limit >= data.total;
    el('leadRows').innerHTML = leads.length ? leads.map((lead) => {
      const contact = lead.contactData && typeof lead.contactData === 'object' ? lead.contactData : {};
      const name = contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || contact.phone || lead.id;
      return `<tr><td><input type="checkbox" data-lead-check="${escapeHtml(lead.id)}" /></td><td><strong>${escapeHtml(name)}</strong><div class="muted small">${escapeHtml(lead.id)}</div></td><td>${escapeHtml(lead.serviceType)}</td><td><span class="owl-badge">${escapeHtml(lead.status)}</span></td><td>${channelEvidenceHtml(lead)}${dncEvidenceHtml(lead, lead.dncStatus || 'pending')}</td><td>${escapeHtml(lead.assignedTo || '-')}</td><td>${formatDate(lead.dateAdded)}</td><td><button class="btn btn-secondary btn-sm" data-edit-lead="${escapeHtml(lead.id)}" ${can('leads', 'update') ? '' : 'disabled'}>Edit</button></td></tr>`;
    }).join('') : emptyRow(8, 'No matching leads.');
    bindLeadRows();
    await ensureUsers();
    await loadLeadSources();
    updateActionAvailability();
  }

  async function loadLeadSources() {
    const select = el('leadSource');
    if (!el('location').value) {
      leadSources = [];
      select.innerHTML = '<option value="">Select a location</option>';
      return;
    }
    const data = await api('/api/owl/lead-sources?' + query());
    leadSources = data.sources || [];
    select.innerHTML = leadSources.length
      ? leadSources.map((source) => {
        const lastSync = source.lastSyncAt ? ` · checked ${formatDate(source.lastSyncAt)}` : ' · first sync pending';
        return `<option value="${escapeHtml(source.id)}">${escapeHtml(source.name + lastSync)}</option>`;
      }).join('')
      : '<option value="">No granted CRM source</option>';
  }

  async function pullLeads(full = false) {
    if (!el('leadSource').value) return showAlert('warning', 'No granted CRM lead source is available for this key and location.');
    try {
      lockContext(true);
      el('pullLeadsButton').disabled = true;
      el('fullPullLeadsButton').disabled = true;
      const data = await api('/api/owl/leads/pull', {
        method: 'POST',
        body: body({ integrationId: el('leadSource').value, full, pageSize: 100 }),
      });
      el('pullStatus').hidden = false;
      el('pullStatus').textContent = `${full ? 'Full reconciliation' : 'CRM changes'} ${data.runId}: queued`;
      showAlert('success', `${full ? 'Full reconciliation' : 'Incremental CRM sync'} queued and audited.`);
      await pollLeadPull(data.runId);
    } catch (error) {
      showAlert('error', error.message);
    } finally {
      lockContext(false);
      updateActionAvailability();
    }
  }

  async function pollLeadPull(runId) {
    for (let attempt = 0; attempt < 1800; attempt += 1) {
      const data = await api('/api/owl/leads/pulls/' + encodeURIComponent(runId) + '?' + query());
      const run = data.run;
      const mode = run.syncMode === 'incremental'
        ? 'Incremental sync'
        : run.syncMode === 'bootstrap'
          ? 'Initial sync'
          : 'Full reconciliation';
      const expected = run.expectedRecords == null ? '' : ` / expected ${run.expectedRecords}`;
      const completion = run.completionReason ? ` | ${run.completionReason}` : '';
      el('pullStatus').textContent = `${mode} ${run.id}: ${run.status} | fetched ${run.recordsFetched}${expected} | pages ${run.pagesProcessed} | inserted ${run.recordsInserted} | linked ${run.recordsLinked} | updated ${run.recordsSkipped} | conflicts ${run.recordsConflicted} | failed ${run.recordsFailed}${completion}`;
      if (['completed', 'partial', 'failed'].includes(run.status)) {
        if (run.status === 'failed') showAlert('error', run.errorSummary || 'CRM lead pull failed.');
        else showAlert(run.status === 'partial' ? 'warning' : 'success',
          run.errorSummary || `CRM pull ${run.status}. Lead pools refreshed.`);
        await Promise.all([loadSummary(), loadPools(), loadLeads()]);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    showAlert('warning', 'Lead pull is still running. Refresh OWL to review imported leads.');
  }

  function bindLeadRows() {
    document.querySelectorAll('[data-lead-check]').forEach((box) => box.onchange = () => { box.checked ? selectedLeads.add(box.dataset.leadCheck) : selectedLeads.delete(box.dataset.leadCheck); updateSelectedCount(); });
    document.querySelectorAll('[data-edit-lead]').forEach((button) => button.onclick = () => openLead(button.dataset.editLead));
  }

  async function ensureUsers() {
    if (!el('location').value) { users = []; el('assignUser').innerHTML = '<option value="">Select a location</option>'; el('moveUser').innerHTML = '<option value="">Select a location</option>'; return; }
    const data = await api('/api/owl/users?' + query()); users = data.users || [];
    const options = users.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.username || user.crmUserName || user.id)}</option>`).join('');
    el('assignUser').innerHTML = '<option value="">Select user</option>' + options;
    el('moveUser').innerHTML = '<option value="">No owner selected</option>' + options;
  }

  function updateActionAvailability() {
    const selectedRows = leads.filter((lead) => selectedLeads.has(String(lead.id)));
    const hasUnsafeDnc = selectedRows.some((lead) => (lead.dncStatus || 'pending') !== 'clean');
    const selectedPool = poolRules.find((pool) => pool.poolKey === el('movePool').value);
    const assignmentMove = selectedPool && (selectedPool.isAssignable || selectedPool.poolKey === 'assigned' || selectedPool.assignmentPolicy === 'require_user');
    el('assignButton').disabled = !can('leads', 'update') || !users.length || hasUnsafeDnc;
    el('unassignButton').disabled = !can('leads', 'update') || hasUnsafeDnc;
    el('newUserButton').disabled = !can('users', 'insert');
    el('pullLeadsButton').disabled = !el('leadSource').value;
    el('fullPullLeadsButton').disabled = !el('leadSource').value;
    el('movePoolButton').disabled = !can('leads', 'update') || !selectedLeads.size || !el('movePool').value || (assignmentMove && hasUnsafeDnc);
    el('moveServiceButton').disabled = !can('leads', 'update') || !selectedLeads.size || !el('moveService').value;
    el('newServiceButton').disabled = false;
    el('previewServicesButton').disabled = !can('leads', 'select');
  }

  function updateSelectedCount() {
    el('selectedLeadCount').textContent = `${selectedLeads.size} selected`;
    updateActionAvailability();
  }

  async function moveSelectedToPool() {
    const pool = poolRules.find((item) => item.poolKey === el('movePool').value);
    if (!selectedLeads.size || !pool) return showAlert('warning', 'Select leads and a destination pool.');
    if (pool.assignmentPolicy === 'require_user' && !el('moveUser').value) {
      return showAlert('warning', `${pool.label} requires a selected owner.`);
    }
    try {
      const data = await api('/api/owl/pools/move', { method: 'POST', body: body({
        leadIds: [...selectedLeads], poolKey: pool.poolKey,
        userId: el('moveUser').value || undefined,
      }) });
      showAlert('success', `${data.affected} lead(s) moved to ${data.pool.label} and audited.`);
      await Promise.all([loadSummary(), loadLeads()]);
    } catch (error) { showAlert('error', error.message); }
  }

  async function moveSelectedToService() {
    if (!selectedLeads.size || !el('moveService').value) return showAlert('warning', 'Select leads and a destination service.');
    try {
      const data = await api('/api/owl/service-pools/move', { method: 'POST', body: body({ leadIds: [...selectedLeads], serviceType: el('moveService').value }) });
      showAlert('success', `${data.affected} lead(s) moved to ${data.service.serviceType} and audited.`);
      await Promise.all([loadSummary(), loadLeads()]);
    } catch (error) { showAlert('error', error.message); }
  }

  function openLead(id) {
    const lead = leads.find((item) => item.id === id); if (!lead) return;
    el('editLeadId').value = lead.id; el('editLeadService').value = lead.serviceType || '';
    el('editLeadStatus').value = lead.status || 'uncontacted'; el('editLeadAssigned').value = lead.assignedTo || '';
    el('editLeadContact').value = JSON.stringify(lead.contactData, null, 2);
    el('scheduledReleaseReason').value = '';
    el('scheduledReleaseMinutes').value = '30';
    el('scheduledReleaseUses').value = '1';
    el('scheduledReleaseButton').disabled = el('source').value !== 'core';
    el('leadDialog').showModal();
  }

  async function saveLead() {
    try {
      const contactData = JSON.parse(el('editLeadContact').value || '{}');
      await api('/api/owl/leads/' + encodeURIComponent(el('editLeadId').value), { method: 'PATCH', body: body({ serviceType: el('editLeadService').value, status: el('editLeadStatus').value, assignedTo: el('editLeadAssigned').value || null, contactData }) });
      el('leadDialog').close(); showAlert('success', 'Lead updated and audited.'); await refreshAll();
    } catch (error) { showAlert('error', error.message); }
  }

  async function createScheduledRelease() {
    const reason = el('scheduledReleaseReason').value.trim();
    if (reason.length < 10) return showAlert('warning', 'Enter a troubleshooting reason of at least 10 characters.');
    try {
      const data = await api('/api/owl/leads/' + encodeURIComponent(el('editLeadId').value) + '/scheduled-call-release', {
        method:'POST',
        body:body({
          reason,
          minutes:Number(el('scheduledReleaseMinutes').value) || 30,
          uses:Number(el('scheduledReleaseUses').value) || 1,
        }),
      });
      el('scheduledReleaseReason').value = '';
      showAlert('success', `Scheduled restriction released for ${data.release.remainingUses} call(s) within ${data.release.minutes} minute(s). The action was audited.`);
      await loadAudit();
    } catch (error) { showAlert('error', error.message); }
  }

  async function changeAssignment(assigned) {
    if (!selectedLeads.size) return showAlert('warning', 'Select at least one lead.');
    if (assigned && !el('assignUser').value) return showAlert('warning', 'Select an assignment user.');
    try {
      const route = assigned ? 'assign' : 'unassign';
      const data = await api('/api/owl/leads/' + route, { method: 'POST', body: body({ leadIds: [...selectedLeads], userId: assigned ? el('assignUser').value : undefined }) });
      showAlert('success', `${data.affected} lead(s) ${assigned ? 'assigned' : 'unassigned'} and audited.`); await refreshAll();
    } catch (error) { showAlert('error', error.message); }
  }

  async function loadUsers() {
    if (!el('location').value) return renderUnavailable('userRows', 9, 'Select a location to view users.');
    await ensureUsers();
    if (!servicePools.length) {
      const serviceData = await api('/api/owl/service-pools?' + query());
      servicePools = serviceData.services || [];
    }
    el('userRows').innerHTML = users.length ? users.map((user) => {
      const credential = user.credentialScheme === 'bcrypt'
        ? 'bcrypt'
        : user.credentialScheme === 'missing' ? 'Missing' : 'Legacy — rotate';
      const permissions = (user.poolPermissions || []).map((pool) => `<span class="owl-badge">${escapeHtml(titleCase(pool))}</span>`).join('') || '<span class="muted">None</span>';
      const languages = (user.languagePermissions || []).map((code) => `<span class="owl-badge">${escapeHtml(String(code).toUpperCase())}</span>`).join('');
      return `<tr><td>${escapeHtml(user.username || '-')}</td><td class="small">${escapeHtml(user.id)}</td><td>${escapeHtml(user.role === 'supervisor' ? 'Dialer Lead' : 'Dialer Operator')}</td><td><span class="owl-badge">${escapeHtml(credential)}</span></td><td>${escapeHtml(user.crmUserName || user.crmUserId || '-')}</td><td><div class="owl-keywords">${permissions}${languages ? `<span class="muted small">Languages</span>${languages}` : ''}</div></td><td>${escapeHtml(user.email || '-')}</td><td>${escapeHtml(user.phone || '-')}</td><td><div class="owl-row-actions"><button class="btn btn-secondary btn-sm" data-edit-user="${escapeHtml(user.id)}" ${can('users', 'update') ? '' : 'disabled'}>Edit profile</button><button class="btn btn-secondary btn-sm" data-password-user="${escapeHtml(user.id)}" ${can('users', 'update') ? '' : 'disabled'}>Change password</button></div></td></tr>`;
    }).join('') : emptyRow(9, 'No users in this location.');
    document.querySelectorAll('[data-edit-user]').forEach((button) => button.onclick = () => openUser(button.dataset.editUser));
    document.querySelectorAll('[data-password-user]').forEach((button) => button.onclick = () => openPassword(button.dataset.passwordUser)); updateActionAvailability();
    await loadAccessAccounts();
  }

  async function loadCrmUsers() {
    const data = await api('/api/owl/crm-users?' + query({ integrationId:el('leadSource').value || '' }));
    crmUsers = data.users || [];
  }

  async function ensureAssignmentPolicy() {
    if (assignmentPolicy) return assignmentPolicy;
    const data = await api('/api/owl/assignment-policy?' + query());
    assignmentPolicy = data.policy || null; renderAssignmentPolicy();
    return assignmentPolicy;
  }

  async function openUser(id) {
    const user = id ? users.find((item) => item.id === id) : null;
    await ensureAssignmentPolicy();
    try { await loadCrmUsers(); } catch (error) { crmUsers = []; showAlert('warning', `CRM users could not be refreshed: ${error.message}`); }
    el('userDialogTitle').textContent = user ? 'Edit dialer user' : 'New dialer user'; el('editUserId').value = user?.id || crypto.randomUUID();
    el('editUsername').value = user?.username || ''; el('editUserRole').value = String(user?.role || '').toLowerCase() === 'supervisor' ? 'supervisor' : 'agent';
    const crmOptions = [...crmUsers];
    if (user?.crmUserId && !crmOptions.some((item) => item.id === user.crmUserId)) crmOptions.unshift({ id:user.crmUserId, name:user.crmUserName || `${user.crmUserId} (saved mapping)` });
    el('editCrmUser').innerHTML = '<option value="">No CRM user linked</option>' + crmOptions.map((item) => `<option value="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">${escapeHtml(item.name)}${item.email ? ` · ${escapeHtml(item.email)}` : ''}</option>`).join('');
    el('editCrmUser').value = user?.crmUserId || '';
    el('editUserEmail').value = user?.email || ''; el('editUserPhone').value = user?.phone || '';
    el('editUserPassword').value = ''; el('editUserPasswordConfirm').value = '';
    const selectedPools = new Set((user?.poolPermissions || []).map(servicePoolKey));
    const enabledPools = servicePools.filter((service) => service.isEnabled);
    el('editUserPoolPermissions').innerHTML = enabledPools.length
      ? enabledPools.map((service) => `<label><input type="checkbox" value="${escapeHtml(service.serviceType)}" ${selectedPools.has(servicePoolKey(service.serviceType)) ? 'checked' : ''} />${escapeHtml(service.serviceType)}</label>`).join('')
      : '<span class="muted">Configure an enabled OWL service pool first.</span>';
    const selectedLanguages = new Set(user?.languagePermissions || []);
    const languages = assignmentPolicy?.languageRules || [{ code:'en', label:'English' }, { code:'es', label:'Spanish' }];
    el('editUserLanguagePermissions').innerHTML = languages.map((language) => `<label><input type="checkbox" value="${escapeHtml(language.code)}" ${selectedLanguages.has(language.code) ? 'checked' : ''} />${escapeHtml(language.label)}</label>`).join('');
    el('editUserPassword').required = !user; el('editUserPasswordConfirm').required = !user;
    el('createUserPasswordFields').hidden = Boolean(user);
    el('userDialog').dataset.mode = user ? 'edit' : 'create'; el('userDialog').showModal();
  }

  async function saveUser() {
    if (!el('userForm').reportValidity()) return;
    const editing = el('userDialog').dataset.mode === 'edit';
    const password = editing ? '' : el('editUserPassword').value;
    if (!editing && password !== el('editUserPasswordConfirm').value) return showAlert('warning', 'Passwords do not match.');
    const crmOption = el('editCrmUser').selectedOptions[0];
    const data = { id: el('editUserId').value, username: el('editUsername').value, role: el('editUserRole').value, crmUserId: el('editCrmUser').value || null, crmUserName: el('editCrmUser').value ? crmOption?.dataset.name || crmOption?.textContent || null : null, email: el('editUserEmail').value || null, phone: el('editUserPhone').value || null, poolPermissions:[...el('editUserPoolPermissions').querySelectorAll('input:checked')].map((input) => input.value), languagePermissions:[...el('editUserLanguagePermissions').querySelectorAll('input:checked')].map((input) => input.value) };
    if (password) data.password = password;
    try {
      const path = editing ? '/api/owl/users/' + encodeURIComponent(data.id) : '/api/owl/users';
      await api(path, { method: editing ? 'PATCH' : 'POST', body: body(data) }); el('userDialog').close(); showAlert('success', 'User saved and audited.'); await refreshAll();
    } catch (error) { showAlert('error', error.message); }
    finally { el('editUserPassword').value = ''; el('editUserPasswordConfirm').value = ''; }
  }

  function openPassword(id) {
    const user = users.find((item) => item.id === id);
    if (!user) return showAlert('error', 'User is no longer available. Refresh OWL and try again.');
    el('passwordUserId').value = user.id;
    el('passwordUserLabel').textContent = user.username || user.id;
    el('newUserPassword').value = ''; el('newUserPasswordConfirm').value = '';
    el('passwordDialog').showModal();
    el('newUserPassword').focus();
  }

  async function changePassword() {
    if (!el('passwordForm').reportValidity()) return;
    const password = el('newUserPassword').value;
    if (password !== el('newUserPasswordConfirm').value) return showAlert('warning', 'Passwords do not match.');
    const userId = el('passwordUserId').value;
    try {
      const result = await api('/api/owl/users/' + encodeURIComponent(userId) + '/password', {
        method: 'PATCH', body: body({ password }),
      });
      el('passwordDialog').close();
      showAlert('success', `Password changed, ${Number(result.sessionsRevoked) || 0} active session(s) revoked, and Sentinel notified.`);
      await refreshAll();
    } catch (error) { showAlert('error', error.message); }
    finally { el('newUserPassword').value = ''; el('newUserPasswordConfirm').value = ''; }
  }

  async function loadAccessAccounts() {
    const visible = Boolean(access.canCreatePlatformAdmin || access.canCreateTenantAdmin);
    el('accessHeading').hidden = !visible; el('accessTable').hidden = !visible;
    if (!visible) return;
    const data = await api('/api/owl/access/accounts');
    const rows = data.accounts || [];
    el('accessRows').innerHTML = rows.length ? rows.map((row) => `<tr><td>${escapeHtml(row.username)}</td><td>${escapeHtml(row.displayRole)}</td><td>${escapeHtml(row.apiKeyName ? `${row.apiKeyName} (${row.keyPrefix})` : 'All tenants')}</td><td>${escapeHtml(row.email || '-')}</td><td><span class="owl-badge ${row.mfaEnrolled ? 'active' : 'inactive'}">${row.mfaEnrolled ? 'enrolled' : 'pending first login'}</span></td><td><span class="owl-badge ${row.isEnabled ? 'active' : 'inactive'}">${row.isEnabled ? 'active' : 'disabled'}</span></td><td>${formatDate(row.createdAt)}</td></tr>`).join('') : emptyRow(7, 'No delegated administrators.');
  }

  function openAccess() {
    el('editAccessType').innerHTML = `${access.canCreateTenantAdmin ? '<option value="tenant">Workspace Custodian</option>' : ''}${access.canCreatePlatformAdmin ? '<option value="platform">System Steward</option>' : ''}`;
    el('editAccessKey').innerHTML = [...el('apiKey').options].map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.textContent)}</option>`).join('');
    el('editAccessKey').value = el('apiKey').value;
    ['editAccessUsername','editAccessEmail','editAccessPassword','editAccessPasswordConfirm'].forEach((id) => { el(id).value = ''; });
    updateAccessType(); el('accessDialog').showModal();
  }

  function updateAccessType() { el('accessKeyLabel').hidden = el('editAccessType').value === 'platform'; }

  async function saveAccess() {
    const password = el('editAccessPassword').value;
    if (password !== el('editAccessPasswordConfirm').value) return showAlert('warning', 'Passwords do not match.');
    if (!el('editAccessEmail').value.trim()) return showAlert('warning', 'A Google account email is required for MFA.');
    try {
      await api('/api/owl/access/accounts', { method:'POST', body:JSON.stringify({
        accountType:el('editAccessType').value,
        apiKeyId:el('editAccessType').value === 'tenant' ? el('editAccessKey').value : el('apiKey').value,
        username:el('editAccessUsername').value, email:el('editAccessEmail').value || null, password,
      }) });
      el('accessDialog').close(); showAlert('success', 'Administrative account created and audited.'); await loadAccessAccounts();
    } catch (error) { showAlert('error', error.message); }
  }

  async function loadDialers() {
    if (!el('location').value) return renderUnavailable('dialerRows', 7, 'Select a location to view dialers.');
    const data = await api('/api/owl/dialers?' + query()); const rows = data.dialers || [];
    el('dialerRows').innerHTML = rows.length ? rows.map((row) => { const active = row.workspace?.lease_until && new Date(row.workspace.lease_until) > new Date(); return `<tr><td>${escapeHtml(row.username || row.crmUserName || '-')}</td><td class="small">${escapeHtml(row.id)}</td><td><span class="owl-badge ${active ? 'active' : 'inactive'}">${active ? 'active' : 'offline'}</span></td><td>${escapeHtml(row.workspace?.crm_contact_id || '-')}</td><td>${formatDate(row.workspace?.updated_at)}</td><td>${formatDate(row.lastLogin?.created_at)}</td><td>${escapeHtml(row.lastLogin?.ip || '-')}</td></tr>`; }).join('') : emptyRow(7, 'No dialer users found.');
  }

  async function loadSchedules() {
    await ensureAssignmentPolicy();
    if (!el('location').value) {
      schedules = []; scheduleSessions = []; ['scheduleUsers','scheduleSubmitted','scheduleAttention','schedulePlanned','scheduleActual','scheduleActive'].forEach((id) => { el(id).textContent = '-'; });
      el('scheduleVisible').textContent = 'Unavailable in this context';
      renderUnavailable('scheduleRows', 8, 'Weekly schedules, verified activity, or users are not selectable for this context.');
      renderUnavailable('workSessionRows', 6, 'Work-session reporting is unavailable for this context.');
      return;
    }
    const data = await api('/api/owl/schedules?' + query());
    schedules = data.schedules || [];
    const week = data.week || {};
    const summary = data.summary || {};
    el('scheduleWeekLabel').textContent = week.weekStart && week.weekEnd
      ? `${week.weekStart} through ${week.weekEnd} · ${week.timeZone || 'America/New_York'}`
      : 'Current Eastern week';
    el('scheduleUsers').textContent = Number(summary.users) || 0;
    el('scheduleSubmitted').textContent = Number(summary.submitted) || 0;
    el('scheduleAttention').textContent = (Number(summary.draft) || 0) + (Number(summary.missing) || 0);
    el('schedulePlanned').textContent = formatHours((Number(summary.scheduledMinutes) || 0) * 60);
    el('scheduleActual').textContent = formatHours(summary.actualSeconds);
    el('scheduleActive').textContent = Number(summary.activeSessions) || 0;
    scheduleCanEdit = can('user_schedule_weeks', 'update') && can('user_schedule_weeks', 'insert') && can('user_schedules', 'update');
    renderScheduleRows();
    scheduleSessions = data.sessions || [];
    el('workSessionRows').innerHTML = scheduleSessions.length ? scheduleSessions.map((row) => `<tr>
      <td><strong>${escapeHtml(row.username || row.crmUserName || row.userId)}</strong></td>
      <td>${formatDate(row.startedAt)}</td><td>${row.endedAt ? formatDate(row.endedAt) : '-'}</td>
      <td>${formatDuration(row.durationSeconds)}</td><td><span class="owl-badge ${row.endedAt ? 'schedule-submitted' : 'active'}">${row.endedAt ? 'complete' : 'active'}</span></td>
      <td>${escapeHtml(row.source || 'dialer')}</td></tr>`).join('') : emptyRow(6, 'No work sessions recorded for this week.');
  }

  function scheduleGap(row) { return (Number(row.verifiedMinutes) || 0) - (Number(row.expectedMinutes) || 0); }

  function renderScheduleRows() {
    const term = el('scheduleSearch').value.trim().toLowerCase(); const filter = el('scheduleStateFilter').value;
    const priority = { missing:0, draft:1, submitted:2 };
    const rows = schedules.filter((row) => {
      const state = row.state || 'missing';
      const matchesTerm = !term || [row.username,row.crmUserName,row.userId].some((value) => String(value || '').toLowerCase().includes(term));
      const matchesState = !filter || (filter === 'attention' ? state !== 'submitted' : filter === 'working' ? row.isWorkingNow : state === filter);
      return matchesTerm && matchesState;
    }).sort((a,b) => {
      const mode = el('scheduleSort').value;
      if (mode === 'name') return String(a.username || a.crmUserName || '').localeCompare(String(b.username || b.crmUserName || ''));
      if (mode === 'gap') return scheduleGap(a) - scheduleGap(b);
      if (mode === 'confirmed') return (Number(b.confirmedDialResults) || 0) - (Number(a.confirmedDialResults) || 0);
      return (priority[a.state || 'missing'] - priority[b.state || 'missing']) || scheduleGap(a) - scheduleGap(b);
    });
    el('scheduleVisible').textContent = `${rows.length} of ${schedules.length} team members`;
    el('scheduleRows').innerHTML = rows.length ? rows.map((row) => {
      const planned = (Number(row.scheduledMinutes) || 0) * 60;
      const actual = (Number(row.verifiedMinutes) || 0) * 60;
      const expected = (Number(row.expectedMinutes) || 0) * 60;
      const variance = actual - expected;
      const state = row.state || 'missing';
      const adherence = expected > 0 ? Math.max(0, Math.min(100, Math.round(actual / expected * 100))) : 0;
      const confirmed = Number(row.confirmedDialResults) || 0;
      const pendingEvidence = Number(row.pendingDialEvidence) || 0;
      return `<tr>
        <td><strong>${escapeHtml(row.username || row.crmUserName || '-')}</strong><div class="muted small">${escapeHtml(row.userId)}</div><div class="owl-agent-state"><span class="owl-badge schedule-${escapeHtml(state)}">${escapeHtml(state)}</span><span class="owl-badge ${row.isWorkingNow ? 'active' : 'inactive'}">${row.isWorkingNow ? 'on shift' : 'offline'}</span></div></td>
        <td>${scheduleWeekStrip(row.scheduleData)}</td>
        <td><div class="owl-metric-stack"><strong>${formatHours(actual)}h <span class="muted">/ ${formatHours(planned)}h</span></strong><div class="owl-progress" title="${adherence}% of expected time verified"><span style="width:${adherence}%"></span></div><small>${formatHours(expected)}h expected by now · <span class="${variance < 0 ? 'owl-negative' : 'owl-positive'}">${variance > 0 ? '+' : ''}${formatHours(variance)}h gap</span></small></div></td>
        <td><div class="owl-metric-stack"><strong>${Number(row.contactsWorked) || 0} contacts</strong><small>${Number(row.engagedMinutes) || 0} engaged min · ${Number(row.loginCount) || 0} logins</small></div></td>
        <td><div class="owl-call-metric confirmed"><strong>${confirmed} CRM-confirmed</strong><small>${pendingEvidence} authorized call${pendingEvidence === 1 ? '' : 's'} awaiting CRM evidence</small></div></td>
        <td><strong>${Number(row.appointments) || 0}</strong></td><td>${formatDate(row.lastHeartbeat || row.lastLogin)}</td>
        <td><div class="owl-row-actions"><button class="btn btn-secondary btn-sm" data-view-performance="${escapeHtml(row.userId)}">Details</button><button class="btn btn-secondary btn-sm" data-edit-schedule="${escapeHtml(row.userId)}" ${scheduleCanEdit ? '' : 'disabled'}>${row.scheduleData == null ? 'Create plan' : 'Edit plan'}</button></div></td>
      </tr>`;
    }).join('') : emptyRow(8, schedules.length ? 'No team members match these filters.' : 'No dialer users found in this location.');
    document.querySelectorAll('[data-view-performance]').forEach((button) => button.onclick = () => openPerformance(button.dataset.viewPerformance));
    document.querySelectorAll('[data-edit-schedule]').forEach((button) => button.onclick = () => openSchedule(button.dataset.editSchedule));
  }

  const scheduleDays = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

  function dayShifts(scheduleData, day) {
    const days = scheduleData?.days && typeof scheduleData.days === 'object' ? scheduleData.days : (scheduleData || {});
    const value = days[day] ?? days[day.slice(0, 3)] ?? days[day[0].toUpperCase() + day.slice(1)];
    if (!value) return [];
    return (Array.isArray(value) ? value : [value]).filter((shift) => shift && typeof shift === 'object');
  }

  function shiftMinutesUi(shift) {
    if (Number.isFinite(Number(shift?.minutes))) return Math.max(0, Number(shift.minutes));
    const parse = (value) => { const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };
    const start = parse(shift?.start || shift?.startTime); const end = parse(shift?.end || shift?.endTime);
    if (start == null || end == null) return 0;
    const elapsed = end >= start ? end - start : 1440 - start + end;
    return Math.max(0, elapsed - (Number(shift.breakMinutes) || 0));
  }

  function scheduleWeekStrip(scheduleData) {
    return `<div class="owl-week-strip" aria-label="Weekly schedule">${scheduleDays.map((day) => {
      const minutes = dayShifts(scheduleData, day).reduce((sum, shift) => sum + shiftMinutesUi(shift), 0);
      return `<span class="owl-day-chip ${minutes ? 'on' : ''}" title="${escapeHtml(day)}: ${formatMinutes(minutes)}"><b>${day.slice(0,1).toUpperCase()}</b><small>${minutes ? Math.round(minutes / 60 * 10) / 10 + 'h' : '—'}</small></span>`;
    }).join('')}</div>`;
  }

  function humanTime(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return String(value || '-');
    const hours = Number(match[1]); const suffix = hours >= 12 ? 'PM' : 'AM';
    return `${hours % 12 || 12}:${match[2]} ${suffix}`;
  }

  function shiftLabel(shift) {
    if (shift.start || shift.startTime) {
      const start = shift.start || shift.startTime; const end = shift.end || shift.endTime;
      return `${humanTime(start)}–${humanTime(end)}${Number(shift.breakMinutes) ? ` · ${Number(shift.breakMinutes)}m break` : ''}`;
    }
    return Number.isFinite(Number(shift.minutes)) ? `${formatMinutes(shift.minutes)} promised` : 'Schedule details unavailable';
  }

  function openPerformance(userId) {
    const row = schedules.find((item) => String(item.userId) === String(userId));
    if (!row) return;
    const plannedMinutes = Number(row.scheduledMinutes) || 0; const verifiedMinutes = Number(row.verifiedMinutes) || 0;
    const expectedMinutes = Number(row.expectedMinutes) || 0; const confirmed = Number(row.confirmedDialResults) || 0;
    const pending = Number(row.pendingDialEvidence) || 0; const appointments = Number(row.appointments) || 0; const contacts = Number(row.contactsWorked) || 0;
    const adherence = expectedMinutes ? Math.round(verifiedMinutes / expectedMinutes * 100) : 0;
    const evidenceCoverage = confirmed + pending ? Math.round(confirmed / (confirmed + pending) * 100) : 0;
    const appointmentConversion = confirmed ? Math.round(appointments / confirmed * 100) : 0;
    el('performanceTitle').textContent = row.username || row.crmUserName || 'Weekly performance';
    el('performanceWeek').textContent = `${el('scheduleWeekLabel').textContent} · ${row.userId}`;
    el('performanceState').innerHTML = `<span class="owl-badge schedule-${escapeHtml(row.state || 'missing')}">${escapeHtml(row.state || 'missing')} plan</span><span class="owl-badge ${row.isWorkingNow ? 'active' : 'inactive'}">${row.isWorkingNow ? 'on shift now' : 'offline'}</span><span class="muted small">Last activity: ${formatDate(row.lastHeartbeat || row.lastLogin)}</span>`;
    el('performancePromised').textContent = formatMinutes(plannedMinutes);
    el('performanceVerified').textContent = formatMinutes(verifiedMinutes);
    el('performanceAdherence').textContent = expectedMinutes ? `${adherence}% of ${formatMinutes(expectedMinutes)} due so far` : 'No promised time due yet';
    el('performanceConfirmed').textContent = confirmed;
    el('performanceEvidence').textContent = confirmed + pending ? `${evidenceCoverage}% evidence coverage · ${pending} awaiting CRM` : 'No call evidence recorded';
    el('performanceAppointments').textContent = appointments;
    el('performanceConversion').textContent = confirmed ? `${appointmentConversion}% of confirmed calls` : 'No confirmed calls to convert';
    el('performanceWeekRows').innerHTML = scheduleDays.map((day) => {
      const shifts = dayShifts(row.scheduleData, day); const minutes = shifts.reduce((sum, shift) => sum + shiftMinutesUi(shift), 0);
      return `<div class="owl-detail-day ${shifts.length ? '' : 'off'}"><strong>${titleCase(day)}</strong><span>${shifts.length ? shifts.map((shift) => escapeHtml(shiftLabel(shift))).join('<br>') : 'Off'}</span><small>${minutes ? formatMinutes(minutes) : '—'}</small></div>`;
    }).join('');
    const confirmedWidth = contacts ? Math.min(100, confirmed / contacts * 100) : 0; const appointmentWidth = contacts ? Math.min(100, appointments / contacts * 100) : 0;
    el('performanceFunnel').innerHTML = `<div class="owl-funnel-step"><div class="owl-funnel-step-head"><span>Contacts worked</span><strong>${contacts}</strong></div><div class="owl-funnel-track"><span style="width:${contacts ? 100 : 0}%"></span></div><small>${Number(row.engagedMinutes) || 0} contact-engaged minutes</small></div><div class="owl-funnel-step confirmed"><div class="owl-funnel-step-head"><span>CRM-confirmed calls</span><strong>${confirmed}</strong></div><div class="owl-funnel-track"><span style="width:${confirmedWidth}%"></span></div><small>${pending} authorized call${pending === 1 ? '' : 's'} still awaiting evidence</small></div><div class="owl-funnel-step appointments"><div class="owl-funnel-step-head"><span>Appointments</span><strong>${appointments}</strong></div><div class="owl-funnel-track"><span style="width:${appointmentWidth}%"></span></div><small>${confirmed ? appointmentConversion : 0}% of CRM-confirmed calls produced appointments</small></div>`;
    const sessions = scheduleSessions.filter((session) => String(session.userId) === String(row.userId));
    el('performanceSessionRows').innerHTML = sessions.length ? sessions.map((session) => `<tr><td>${formatDate(session.startedAt)}</td><td>${session.endedAt ? formatDate(session.endedAt) : '-'}</td><td>${formatDuration(session.durationSeconds)}</td><td><span class="owl-badge ${session.endedAt ? 'schedule-submitted' : 'active'}">${session.endedAt ? 'complete' : 'active'}</span></td><td>${escapeHtml(session.source || 'dialer')}</td></tr>`).join('') : emptyRow(5, 'No work sessions recorded for this team member this week.');
    el('detailEditPlanButton').dataset.userId = row.userId; el('detailEditPlanButton').disabled = !scheduleCanEdit;
    el('performanceDialog').showModal();
  }

  function openSchedule(userId) {
    const row = schedules.find((item) => String(item.userId) === String(userId));
    el('editScheduleUserId').value = userId;
    el('editScheduleTitle').textContent = `Plan for ${row?.username || row?.crmUserName || 'team member'}`;
    el('editScheduleWeek').textContent = el('scheduleWeekLabel').textContent;
    el('scheduleDayRows').innerHTML = scheduleDays.map((day) => {
      const shifts = dayShifts(row?.scheduleData, day);
      return `<section class="owl-day-editor" data-schedule-day="${day}"><div class="owl-day-editor-label"><strong>${day[0].toUpperCase() + day.slice(1)}</strong><small data-day-total>Off</small></div><div class="owl-shift-list">${(shifts.length ? shifts : []).map(scheduleShiftEditor).join('')}<button type="button" class="btn btn-secondary btn-sm owl-add-shift" data-add-shift="${day}">+ Add shift</button></div></section>`;
    }).join('');
    bindScheduleEditor(); updateScheduleTotal(); el('scheduleDialog').showModal();
  }

  function scheduleShiftEditor(shift = { start:'09:00', end:'17:00', breakMinutes:30 }) {
    return `<div class="owl-shift-row"><label>Start<input type="time" data-shift-start value="${escapeHtml(shift.start || shift.startTime || '09:00')}" /></label><label>End<input type="time" data-shift-end value="${escapeHtml(shift.end || shift.endTime || '17:00')}" /></label><label>Unpaid break<input type="number" data-shift-break min="0" max="480" step="5" value="${Number(shift.breakMinutes) || 0}" /></label><button type="button" class="btn btn-secondary btn-sm" data-remove-shift aria-label="Remove shift">Remove</button></div>`;
  }

  function addScheduleShift(day) {
    const list = document.querySelector(`[data-schedule-day="${day}"] .owl-shift-list`);
    const add = list.querySelector('[data-add-shift]'); add.insertAdjacentHTML('beforebegin', scheduleShiftEditor());
    bindScheduleEditor(); updateScheduleTotal();
  }

  function bindScheduleEditor() {
    document.querySelectorAll('[data-add-shift]').forEach((button) => { button.onclick = () => addScheduleShift(button.dataset.addShift); });
    document.querySelectorAll('#scheduleDayRows input').forEach((input) => { input.oninput = updateScheduleTotal; });
    document.querySelectorAll('[data-remove-shift]').forEach((button) => { button.onclick = () => { button.closest('.owl-shift-row').remove(); updateScheduleTotal(); }; });
  }

  function setEditorDay(day, shifts) {
    const list = document.querySelector(`[data-schedule-day="${day}"] .owl-shift-list`);
    if (!list) return;
    list.innerHTML = shifts.map(scheduleShiftEditor).join('') + `<button type="button" class="btn btn-secondary btn-sm owl-add-shift" data-add-shift="${day}">+ Add shift</button>`;
  }

  function applyStandardWeek() {
    scheduleDays.forEach((day, index) => setEditorDay(day, index < 5 ? [{ start:'09:00', end:'17:00', breakMinutes:30 }] : []));
    bindScheduleEditor(); updateScheduleTotal();
  }

  function clearScheduleWeek() {
    scheduleDays.forEach((day) => setEditorDay(day, [])); bindScheduleEditor(); updateScheduleTotal();
  }

  function scheduleDataFromEditor() {
    const days = {};
    document.querySelectorAll('[data-schedule-day]').forEach((section) => {
      const shifts = [...section.querySelectorAll('.owl-shift-row')].map((shift) => ({
        start:shift.querySelector('[data-shift-start]').value,
        end:shift.querySelector('[data-shift-end]').value,
        breakMinutes:Number(shift.querySelector('[data-shift-break]').value) || 0,
      })).filter((shift) => shift.start && shift.end);
      if (shifts.length) days[section.dataset.scheduleDay] = shifts.length === 1 ? shifts[0] : shifts;
    });
    return { days };
  }

  function updateScheduleTotal() {
    const scheduleData = scheduleDataFromEditor();
    const total = scheduleDays.reduce((sum, day) => {
      const minutes = dayShifts(scheduleData, day).reduce((dayTotal, shift) => dayTotal + shiftMinutesUi(shift), 0);
      const label = document.querySelector(`[data-schedule-day="${day}"] [data-day-total]`);
      if (label) label.textContent = minutes ? formatMinutes(minutes) : 'Off';
      return sum + minutes;
    }, 0);
    el('editScheduleTotal').textContent = formatMinutes(total);
  }

  function validateScheduleEditor(scheduleData) {
    for (const day of scheduleDays) {
      for (const shift of dayShifts(scheduleData, day)) {
        const minutes = shiftMinutesUi(shift);
        if (shift.start === shift.end) throw new Error(`${titleCase(day)} has the same start and end time.`);
        if (minutes <= 0) throw new Error(`${titleCase(day)} has a break that is as long as, or longer than, the shift.`);
      }
    }
  }

  async function saveSchedule(submit) {
    try {
      const scheduleData = scheduleDataFromEditor();
      if (!Object.keys(scheduleData.days).length) throw new Error('Add at least one shift before saving the weekly plan.');
      validateScheduleEditor(scheduleData);
      await api('/api/owl/schedules/' + encodeURIComponent(el('editScheduleUserId').value), {
        method: 'PUT', body: body({ scheduleData, submit: submit === true }),
      });
      el('scheduleDialog').close();
      showAlert('success', submit ? 'Weekly schedule saved, submitted, and audited.' : 'Schedule saved as a draft. Lead pulls remain locked until submission.');
      await refreshAll();
    } catch (error) { showAlert('error', error.message); }
  }

  async function loadCompliance() {
    if (el('source').value !== 'core' || !can('lead_compliance_checks', 'select') || !can('lead_call_attempts', 'select') || !el('location').value) {
      complianceChecks = []; complianceAttempts = [];
      ['complianceScreened','complianceAllowed','complianceBlocked','complianceAttempts','complianceConfirmed'].forEach((id) => { el(id).textContent = '-'; });
      el('complianceReleaseRate').textContent = 'Unavailable in this context'; el('complianceEvidenceRate').textContent = 'Unavailable in this context';
      el('complianceVisible').textContent = 'Unavailable in this context'; el('evidenceVisible').textContent = 'Unavailable in this context';
      renderUnavailable('complianceRows', 6, 'Compliance reporting is available from the Core database context.');
      renderUnavailable('callEvidenceRows', 6, 'Call evidence is available from the Core database context.');
      el('complianceReasons').innerHTML = '';
      return;
    }
    const data = await api('/api/owl/compliance?' + query());
    const summary = data.summary || {};
    el('complianceScreened').textContent = Number(summary.screened) || 0;
    el('complianceAllowed').textContent = Number(summary.allowed) || 0;
    el('complianceBlocked').textContent = Number(summary.blocked) || 0;
    el('complianceAttempts').textContent = Number(summary.authorizedAttempts) || 0;
    el('complianceConfirmed').textContent = Number(summary.confirmedAttempts) || 0;
    const screened = Number(summary.screened) || 0; const allowed = Number(summary.allowed) || 0;
    const confirmed = Number(summary.confirmedAttempts) || 0; const attributed = Number(summary.attributedConfirmedAttempts) || 0;
    el('complianceReleaseRate').textContent = screened ? `${Math.round(allowed / screened * 100)}% of decisions released` : 'No decisions in this window';
    el('complianceEvidenceRate').textContent = confirmed ? `${Math.round(attributed / confirmed * 100)}% mapped to a dialer user` : 'No final CRM call results in this window';
    el('complianceReasons').innerHTML = (data.reasons || []).length
      ? data.reasons.map((row) => `<button type="button" data-compliance-reason="${escapeHtml(row.reason)}"><strong>${Number(row.total) || 0} · ${escapeHtml(complianceReason(row.reason))}</strong><span>${escapeHtml(complianceExplanation(row.reason))}</span></button>`).join('')
      : '<span class="muted">No blocked decisions in the last 24 hours.</span>';
    complianceChecks = data.checks || []; complianceAttempts = data.attempts || [];
    const reasons = [...new Set(complianceChecks.map((row) => row.reason).filter(Boolean))].sort();
    const previousReason = el('complianceReasonFilter').value;
    el('complianceReasonFilter').innerHTML = '<option value="">All reasons</option>' + reasons.map((reason) => `<option value="${escapeHtml(reason)}">${escapeHtml(complianceReason(reason))}</option>`).join('');
    if (reasons.includes(previousReason)) el('complianceReasonFilter').value = previousReason;
    document.querySelectorAll('[data-compliance-reason]').forEach((button) => { button.onclick = () => { el('complianceDecisionFilter').value = 'blocked'; el('complianceReasonFilter').value = button.dataset.complianceReason; renderComplianceLedgers(); }; });
    renderComplianceLedgers();
  }

  function complianceSearchText(row) {
    const contact = row.contactData && typeof row.contactData === 'object' ? row.contactData : {};
    return [row.leadName,row.leadId,row.username,row.userId,row.serviceType,row.stateCode,row.timeZone,contact.name,contact.firstName,contact.lastName].join(' ').toLowerCase();
  }

  function renderComplianceLedgers() {
    const term = el('complianceSearch').value.trim().toLowerCase(); const decision = el('complianceDecisionFilter').value; const reason = el('complianceReasonFilter').value;
    const rows = complianceChecks.filter((row) => (!term || complianceSearchText(row).includes(term)) && (!decision || row.decision === decision) && (!reason || row.reason === reason));
    el('complianceVisible').textContent = `${rows.length} of ${complianceChecks.length} decisions`;
    el('complianceRows').innerHTML = rows.length ? rows.map((row) => {
      const contact = row.contactData && typeof row.contactData === 'object' ? row.contactData : {};
      const name = contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || row.leadId;
      const market = [row.stateCode, row.timeZone].filter(Boolean).join(' · ') || 'Unresolved';
      return `<tr><td>${formatDate(row.checkedAt)}</td><td><strong>${escapeHtml(name)}</strong><div class="muted small">${escapeHtml(row.serviceType || 'Other')} · user ${escapeHtml(row.username || row.userId || 'unassigned')}</div></td><td><strong>${escapeHtml(market)}</strong><div class="muted small">Lead-local: ${escapeHtml(row.localTime || 'unknown')}</div></td><td><strong>${Number(row.attempts24h) || 0}</strong><div class="muted small">outbound · rolling 24h</div></td><td><div class="owl-decision-copy"><strong><span class="owl-badge compliance-${escapeHtml(row.decision)}">${escapeHtml(row.decision === 'allowed' ? 'released' : 'filtered')}</span> ${escapeHtml(complianceReason(row.reason))}</strong><small>${escapeHtml(complianceExplanation(row.reason))}</small></div></td><td>${row.nextEligibleAt ? formatDate(row.nextEligibleAt) : '<span class="muted">Not restricted</span>'}</td></tr>`;
    }).join('') : emptyRow(6, complianceChecks.length ? 'No decisions match these filters.' : 'No compliance decisions have been recorded for this location.');
    const evidence = el('evidenceFilter').value;
    const attempts = complianceAttempts.filter((row) => (!term || complianceSearchText(row).includes(term)) && (!evidence || (evidence === 'unattributed' ? !row.userId : row.source === evidence)));
    el('evidenceVisible').textContent = `${attempts.length} of ${complianceAttempts.length} records`;
    el('callEvidenceRows').innerHTML = attempts.length ? attempts.map((row) => `<tr><td>${formatDate(row.occurredAt)}</td><td><strong>${escapeHtml(row.username || row.userId || (row.externalUserId ? 'Unmapped CRM user' : 'Unattributed'))}</strong><div class="muted small">${escapeHtml(row.userId || row.externalUserId || 'CRM did not identify a caller')}</div></td><td><strong>${escapeHtml(row.leadName || row.leadId)}</strong><div class="muted small">${escapeHtml(row.serviceType || 'Other')}</div></td><td><span class="owl-badge evidence-${row.source === 'crm' ? 'crm' : 'authorized'}">${row.source === 'crm' ? 'CRM-confirmed' : 'authorization intent'}</span></td><td>${escapeHtml(row.callStatus || 'unknown')}</td><td>${formatDate(row.syncedAt)}</td></tr>`).join('') : emptyRow(6, complianceAttempts.length ? 'No call records match these filters.' : 'No outbound call evidence has been recorded for this location.');
  }

  function complianceReason(value) {
    return ({
      eligible:'Eligible', outside_marketing_hours:'Outside marketing hours',
      florida_attempt_limit:'Florida 24-hour attempt limit', timezone_unknown:'Timezone unavailable',
      state_unknown:'State unavailable', crm_call_history_unavailable:'CRM call history unavailable',
    })[value] || String(value || 'Unknown').replace(/_/g, ' ');
  }

  function complianceExplanation(value) {
    return ({
      eligible:'The lead-local time and applicable attempt rules permit an outbound call.',
      outside_marketing_hours:'The lead-local time falls outside the company calling window, so OWL withholds the lead.',
      florida_attempt_limit:'The CRM ledger already shows three outbound attempts in the preceding 24 hours.',
      timezone_unknown:'OWL cannot safely determine the lead-local calling window without a timezone.',
      state_unknown:'OWL cannot determine which jurisdictional rules apply without a state.',
      crm_call_history_unavailable:'OWL could not verify recent CRM calls, so it fails closed instead of risking an excess attempt.',
    })[value] || 'The policy engine recorded this decision reason for review.';
  }

  async function loadAudit() {
    const data = await api('/api/owl/audit?' + query({ limit: 200 })); auditEvents = data.events || [];
    el('auditTotal').textContent = auditEvents.length;
    el('auditActors').textContent = new Set(auditEvents.map((row) => row.admin_username).filter(Boolean)).size;
    el('auditActions').textContent = new Set(auditEvents.map((row) => row.action).filter(Boolean)).size;
    const previous = el('auditActionFilter').value;
    const actions = [...new Set(auditEvents.map((row) => row.action).filter(Boolean))].sort();
    el('auditActionFilter').innerHTML = '<option value="">All actions</option>' + actions.map((action) => `<option value="${escapeHtml(action)}">${escapeHtml(auditActionLabel(action))}</option>`).join('');
    if (actions.includes(previous)) el('auditActionFilter').value = previous;
    renderAudit();
  }

  function renderAudit() {
    const rows = filteredAuditEvents();
    el('auditVisible').textContent = `${rows.length} of ${auditEvents.length} events`;
    el('auditExportButton').disabled = !rows.length;
    el('auditRows').innerHTML = rows.length ? rows.map((row) => `<tr><td><strong>${formatDate(row.created_at)}</strong><div class="muted small">by ${escapeHtml(row.admin_username || 'system')}</div></td><td><strong>${escapeHtml(row.location_id || 'All locations')}</strong><div class="muted small">${escapeHtml(row.source_slug || 'core')}</div></td><td><span class="owl-audit-action">${escapeHtml(auditActionLabel(row.action))}</span><span class="owl-audit-action-code">${escapeHtml(row.action)}</span></td><td><strong>${escapeHtml(titleCase(row.entity_type))}</strong><div class="muted small">${escapeHtml(row.entity_id || 'No entity ID')}</div></td><td>${escapeHtml(row.detail || 'No additional detail recorded.')}</td></tr>`).join('') : emptyRow(5, auditEvents.length ? 'No events match these filters.' : 'No OWL mutations recorded.');
  }

  function filteredAuditEvents() {
    const term = el('auditSearch').value.trim().toLowerCase(); const action = el('auditActionFilter').value;
    return auditEvents.filter((row) => (!action || row.action === action) && (!term || [row.admin_username,row.action,row.entity_type,row.entity_id,row.detail,row.source_slug,row.location_id].some((value) => String(value || '').toLowerCase().includes(term))));
  }

  function safeCsvCell(value) {
    let text = String(value == null ? '' : value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportAuditCsv() {
    const headers = ['Time','Administrator','Source','Location','Action','Entity type','Entity ID','Detail'];
    const lines = [headers.map(safeCsvCell).join(',')];
    for (const row of filteredAuditEvents()) lines.push([row.created_at,row.admin_username,row.source_slug,row.location_id,row.action,row.entity_type,row.entity_id,row.detail].map(safeCsvCell).join(','));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `owl-audit-${new Date().toISOString().slice(0,10)}.csv`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }

  function auditActionLabel(value) {
    const parts = String(value || 'change').split('.');
    return parts.map(titleCase).join(' · ');
  }

  function titleCase(value) { return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
  function servicePoolKey(value) {
    const text = String(value || '').trim().toLowerCase();
    if (/roof/.test(text)) return 'roofing'; if (/mold/.test(text)) return 'mold';
    if (/solar/.test(text)) return 'solar'; if (/kitchen/.test(text)) return 'kitchen';
    if (/bath/.test(text)) return 'bathroom'; if (/addition/.test(text)) return 'home_addition';
    return text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  async function loadAssignmentLogic() {
    if (!el('location').value) {
      el('logicUserQueue').innerHTML = 'Select a location to view assignment logic.';
      return;
    }
    // /api/owl/service-pools already returns { services, assignmentPolicy }.
    // Avoids 404 from the nonexistent /api/owl/assignment-policies route.
    // Force source=core — service-pools, assignment-policy and dialer permissions
    // all live on the core (legacy) database regardless of which source is selected.
    const poolsData = await api('/api/owl/service-pools?' + query({ source: 'core' }));
    servicePools = poolsData.services || [];
    assignmentPolicy = poolsData.assignmentPolicy || {};

    // Build user list from dialer metrics already embedded in each service pool.
    // Works under any source (VibeDialer or Legacy) without a separate /users call.
    const seenIds = new Set();
    users = servicePools.flatMap(p => (p.dialers || []).map(d => ({
      id: d.userId,
      name: d.crmUserName || d.username || d.userId,
      crmUserId: d.crmUserId,
      isAvailable: true,
      calendarId: null,
    }))).filter(u => u.id && !seenIds.has(u.id) && seenIds.add(u.id));

    const poolSelect = el('logicPoolSelect');
    poolSelect.innerHTML = '<option value="">All Services</option>' +
      servicePools.map(p => `<option value="${escapeHtml(p.serviceType)}">${escapeHtml(p.serviceType || 'Other')}</option>`).join('');

    poolSelect.onchange = renderAssignmentLogicPreview;
    renderAssignmentLogicPreview();
  }

  function renderAssignmentLogicPreview() {
    const serviceType = el('logicPoolSelect').value;
    const pool = servicePools.find(p => p.serviceType === serviceType) || servicePools[0];

    if (!pool) return;

    el('previewLeadService').textContent = pool.serviceType || 'Unknown';

    // Use only the dialers assigned to this specific pool for queue display
    const poolDialers = pool.dialers || [];
    const eligibleUsers = poolDialers.filter(d => d.userId);

    el('logicEligibleUsers').textContent = eligibleUsers.length;
    el('logicAvailableUsers').textContent = eligibleUsers.length;
    el('logicCalendars').textContent = `${eligibleUsers.filter(d => d.calendarId).length}/${eligibleUsers.length}`;


    function initials(d) {
      const name = d.crmUserName || d.username || d.userId || '';
      return escapeHtml(name.substring(0, 2).toUpperCase() || '??');
    }
    function displayName(d) { return escapeHtml(d.crmUserName || d.username || d.userId || '-'); }

    el('logicUserQueue').innerHTML = eligibleUsers.length ? eligibleUsers.map((d, i) => `
      <div class="logic-queue-card ${i === 0 ? 'next' : ''}">
        <div class="card-head">
          <span class="pos">${i === 0 ? 'NEXT' : ''}</span>
          <span class="pos">#${i + 1}</span>
        </div>
        <div style="display:flex; align-items:center; margin-bottom:12px;">
          <div class="avatar">${initials(d)}</div>
          <div class="user-info">
            <strong>${displayName(d)}</strong>
            <small><span class="dot available"></span> Active</small>
          </div>
        </div>
        <div class="tags">
          <span class="tag primary">HAWK Agent</span>
          <span class="tag">${escapeHtml(pool.serviceType)}</span>
        </div>
        <div class="metrics">
          <span>${d.assignmentCount || 0} assigned</span>
          <span>${d.lastAssignedAt ? 'Recently active' : 'Not yet assigned'}</span>
        </div>
      </div>
    `).join('') : '<div class="muted">No agents assigned to this service pool.</div>';

    el('logicMatrixRows').innerHTML = eligibleUsers.map((d, i) => `
      <tr>
        <td>#${i + 1}</td>
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            <div class="avatar" style="width:24px; height:24px; font-size:0.6rem;">${initials(d)}</div>
            ${displayName(d)}
          </div>
        </td>
        <td><span class="dot available"></span> Active</td>
        <td>${escapeHtml(pool.serviceType)}</td>
        <td>${d.assignmentCount || 0}</td>
        <td>${i === 0 ? 'Now' : 'Waiting'}</td>
      </tr>
    `).join('');

    el('previewMatchedCount').textContent = eligibleUsers.length;
    el('previewMatchedList').innerHTML = eligibleUsers.map((d) => `
      <div class="logic-match-row">
        <div>
          <div class="avatar-small">${initials(d)}</div>
          <span>${displayName(d)}</span>
        </div>
        <span class="green-text">● Eligible</span>
      </div>
    `).join('') || '<div class="muted">No matched agents.</div>';

    el('previewNextMatch').innerHTML = eligibleUsers.length ? `
      <div class="logic-match-row">
        <div>
          <div class="avatar-small">${initials(eligibleUsers[0])}</div>
          <span>${displayName(eligibleUsers[0])}</span>
        </div>
        <span class="muted">HAWK will assign next</span>
      </div>
    ` : '<div class="muted">None</div>';

    el('previewFallbackMatch').innerHTML = eligibleUsers.length > 1 ? `
      <div class="logic-match-row">
        <div>
          <div class="avatar-small">${initials(eligibleUsers[1])}</div>
          <span>${displayName(eligibleUsers[1])}</span>
        </div>
        <span class="muted">HAWK Fallback target</span>
      </div>
    ` : '<div class="muted">None</div>';

    // Dynamic Eligibility Rules from real assignmentPolicy
    const hasLang = assignmentPolicy.languageRules && assignmentPolicy.languageRules.length > 0;
    const hasSched = assignmentPolicy.requireSubmittedSchedule;
    const critBox = document.querySelector('.logic-criteria');
    if (critBox) {
      critBox.innerHTML = `
        <h3>HAWK Eligibility Criteria</h3>
        <small>Users must meet these criteria for HAWK to assign leads.</small>
        <label class="logic-criteria-row"><input type="checkbox" checked disabled> Active user in OWL for this pool</label>
        <label class="logic-criteria-row"><input type="checkbox" checked disabled> Assigned to service pool / tag keyword</label>
        <label class="logic-criteria-row"><input type="checkbox" ${hasLang ? 'checked' : ''} disabled> Language rules match required</label>
        <label class="logic-criteria-row"><input type="checkbox" ${hasSched ? 'checked' : ''} disabled> Submitted weekly schedule required</label>
        <label class="logic-criteria-row"><input type="checkbox" checked disabled> HAWK CRM Calendar connected</label>
      `;
    }
  }

  function snakeToTitle(text) {
    return text.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function titleToSnake(text) {
    return text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  async function loadWebhooks() {
    if (!el('location').value) return;
    el('owlWebhookSource').value = el('source').value || 'core';
    el('owlWebhookSecret').value = '';
    const [sourcesData, webhookData] = await Promise.all([
      api('/api/owl/lead-sources?' + query()),
      api('/api/owl/intake-webhook?' + query()),
    ]);
    const integrations = sourcesData.sources || [];
    owlWebhookEndpoint = webhookData.endpoint || null;
    el('owlWebhookIntegration').innerHTML = '<option value="">Select a GHL connection</option>' + integrations.map((item) =>
      `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.ready ? '' : ' (credential missing)'}</option>`
    ).join('');
    if (owlWebhookEndpoint?.integrationId) el('owlWebhookIntegration').value = owlWebhookEndpoint.integrationId;
    el('owlWebhookContactCreated').checked = owlWebhookEndpoint ? owlWebhookEndpoint.allowContactCreated : true;
    el('owlWebhookContactUpdated').checked = owlWebhookEndpoint ? owlWebhookEndpoint.allowContactUpdated : true;
    el('owlWebhookUrl').value = owlWebhookEndpoint?.url || '';
    el('owlWebhookState').textContent = owlWebhookEndpoint?.enabled ? 'Enabled' : owlWebhookEndpoint ? 'Disabled' : 'Not configured';
    el('owlWebhookLastSuccess').textContent = owlWebhookEndpoint?.lastSuccessAt ? `Last success ${formatDate(owlWebhookEndpoint.lastSuccessAt)}` : '';
    el('owlWebhookExample').textContent = JSON.stringify({
      eventName:'contact_created',
      contactId:'{{contact.id}}',
      locationId:el('location').value,
    }, null, 2) + '\n\n' + JSON.stringify({
      eventName:'contact_updated',
      contactId:'{{contact.id}}',
      locationId:el('location').value,
    }, null, 2);
    const deliveries = webhookData.deliveries || [];
    el('owlWebhookDeliveryRows').innerHTML = deliveries.length ? deliveries.map((item) => `<tr>
      <td>${formatDate(item.receivedAt)}</td><td>${escapeHtml(item.eventName)}</td><td>${escapeHtml(item.contactId)}</td>
      <td><span class="owl-badge">${escapeHtml(item.status)}</span></td><td>${escapeHtml(item.outcome || '-')}</td>
      <td>${item.durationMs == null ? '-' : `${item.durationMs} ms`}</td><td>${escapeHtml(item.errorCode || item.errorMessage || '-')}</td>
    </tr>`).join('') : emptyRow(7, 'No OWL webhook deliveries yet.');
  }

  async function saveOwlWebhook(rotate) {
    try {
      const integrationId = el('owlWebhookIntegration').value;
      if (!integrationId) return showAlert('warning', 'Select the GHL connection OWL should use.');
      const data = await api('/api/owl/intake-webhook', { method:'PUT', body:body({
        integrationId,
        allowContactCreated:el('owlWebhookContactCreated').checked,
        allowContactUpdated:el('owlWebhookContactUpdated').checked,
        rotate:Boolean(rotate),
      }) });
      await loadWebhooks();
      if (data.secret) el('owlWebhookSecret').value = data.secret;
      showAlert('success', data.secret ? 'OWL webhook saved. Copy the secret now; it will not be shown again.' : 'OWL webhook settings saved.');
    } catch (error) { showAlert('error', error.message); }
  }

  async function disableOwlWebhook() {
    if (!window.confirm('Disable this OWL intake webhook? Existing HAWK flows will not be changed.')) return;
    try {
      await api('/api/owl/intake-webhook', { method:'DELETE', body:body() });
      showAlert('success', 'OWL intake webhook disabled.');
      await loadWebhooks();
    } catch (error) { showAlert('error', error.message); }
  }

  async function testOwlContactSync() {
    const contactId = el('owlWebhookTestContact').value.trim();
    if (!contactId) return showAlert('warning', 'Enter a GHL Contact ID.');
    try {
      el('owlWebhookTestResult').textContent = 'Synchronizing...';
      const data = await api('/api/owl/intake-webhook/test-sync', { method:'POST', body:body({
        contactId,
        integrationId:el('owlWebhookIntegration').value || owlWebhookEndpoint?.integrationId,
      }) });
      el('owlWebhookTestResult').textContent = `Ready: ${data.leadId} · ${data.outcome} · ${data.serviceType}`;
      showAlert('success', 'Live GHL contact synchronized into OWL.');
    } catch (error) { el('owlWebhookTestResult').textContent = ''; showAlert('error', error.message); }
  }

  async function loadActiveTab() {
    const loaders = { pools: loadPools, assignment: loadAssignmentLogic, webhooks: loadWebhooks, leads: loadLeads, users: loadUsers, dialers: loadDialers, schedules: loadSchedules, compliance: loadCompliance, audit: loadAudit };
    await loaders[activeTab]();
  }
  async function activateTab(tab) { document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item.dataset.tab === tab)); document.querySelectorAll('.owl-panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'panel-' + tab)); activeTab = tab; await refreshAll(); }
  async function refreshAll() { updateScope(); showAlert('', ''); if (!el('location').value && activeTab !== 'audit') { setSummary({}); return; } try { await Promise.all([loadSummary(), loadActiveTab()]); } catch (error) { showAlert('error', error.message); } }
  function renderUnavailable(id, colspan, message) { el(id).innerHTML = emptyRow(colspan, message); }
  function emptyRow(colspan, message) { return `<tr><td colspan="${colspan}" class="muted">${escapeHtml(message)}</td></tr>`; }
  function formatDate(value) { if (!value) return '-'; const date = new Date(value); return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString(); }
  function formatHours(seconds) { const value = Number(seconds) || 0; return (value / 3600).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function formatMinutes(minutes) { const value = Math.max(0, Math.round(Number(minutes) || 0)); return `${Math.floor(value / 60)}h ${value % 60}m`; }
  function formatDuration(seconds) { const value = Math.max(0, Number(seconds) || 0); const hours = Math.floor(value / 3600); const minutes = Math.floor((value % 3600) / 60); return `${hours}h ${minutes}m`; }

  document.querySelectorAll('[data-tab]').forEach((button) => button.onclick = () => activateTab(button.dataset.tab));
  el('apiKey').onchange = () => { dncPendingCutoff = null; dncReviewCutoff = null; dncRescrubCutoff = null; reloadKeyContext().catch((error) => showAlert('error', error.message)); };
  el('source').onchange = () => { dncPendingCutoff = null; dncReviewCutoff = null; dncRescrubCutoff = null; loadLocations().catch((error) => showAlert('error', error.message)); };
  el('location').onchange = () => { dncPendingCutoff = null; dncReviewCutoff = null; dncRescrubCutoff = null; leadOffset = 0; resetLeadSources(); refreshAll(); };
  el('refreshButton').onclick = refreshAll; el('leadFilterButton').onclick = () => { leadOffset = 0; loadLeads().catch((error) => showAlert('error', error.message)); };
  el('leadPrev').onclick = () => { leadOffset = Math.max(0, leadOffset - 50); loadLeads(); }; el('leadNext').onclick = () => { leadOffset += 50; loadLeads(); };
  el('leadCheckAll').onchange = () => { document.querySelectorAll('[data-lead-check]').forEach((box) => { box.checked = el('leadCheckAll').checked; box.checked ? selectedLeads.add(box.dataset.leadCheck) : selectedLeads.delete(box.dataset.leadCheck); }); updateSelectedCount(); };
  el('assignButton').onclick = () => changeAssignment(true); el('unassignButton').onclick = () => changeAssignment(false); el('saveLeadButton').onclick = saveLead;
  el('scheduledReleaseButton').onclick = createScheduledRelease;
  el('pullLeadsButton').onclick = () => pullLeads(false);
  el('fullPullLeadsButton').onclick = () => pullLeads(true);
  el('movePool').onchange = updateActionAvailability; el('movePoolButton').onclick = moveSelectedToPool;
  el('moveService').onchange = updateActionAvailability; el('moveServiceButton').onclick = moveSelectedToService;
  el('newServiceButton').onclick = () => openService(null); el('saveServiceButton').onclick = saveService;
  el('previewServicesButton').onclick = previewServiceSync; el('applyServicesButton').onclick = applyServiceSync;
  el('newPoolButton').onclick = () => openPool(null); el('savePoolButton').onclick = savePool;
  el('dncRefreshAllButton').onclick = refreshAllDncLeads;
  el('dncReviewRescrubButton').onclick = rescrubDncReviews;
  el('dncReviewReleaseButton').onclick = releaseDncReviewHolds;
  el('dncCrmSyncButton').onclick = syncDncCrmBacklog;
  el('dncRescrubPoolButton').onclick = rescrubDncPool;
  el('newUserButton').onclick = () => openUser(null); el('saveUserButton').onclick = saveUser; el('changePasswordButton').onclick = changePassword; el('saveScheduleButton').onclick = () => saveSchedule(false); el('submitScheduleButton').onclick = () => saveSchedule(true);
  el('saveAssignmentPolicyButton').onclick = saveAssignmentPolicy;
  el('scheduleSearch').oninput = renderScheduleRows; el('scheduleStateFilter').onchange = renderScheduleRows; el('scheduleSort').onchange = renderScheduleRows;
  el('standardWeekButton').onclick = applyStandardWeek; el('clearWeekButton').onclick = clearScheduleWeek;
  el('detailEditPlanButton').onclick = () => { const userId = el('detailEditPlanButton').dataset.userId; el('performanceDialog').close(); openSchedule(userId); };
  el('complianceSearch').oninput = renderComplianceLedgers; el('complianceDecisionFilter').onchange = renderComplianceLedgers; el('complianceReasonFilter').onchange = renderComplianceLedgers; el('evidenceFilter').onchange = renderComplianceLedgers;
  el('newAccessButton').onclick = openAccess; el('editAccessType').onchange = updateAccessType; el('saveAccessButton').onclick = saveAccess;
  el('auditSearch').oninput = renderAudit; el('auditActionFilter').onchange = renderAudit;
  el('auditExportButton').onclick = exportAuditCsv;
  el('owlWebhookProvision').onclick = () => saveOwlWebhook(false);
  el('owlWebhookRotate').onclick = () => saveOwlWebhook(true);
  el('owlWebhookDisable').onclick = disableOwlWebhook;
  el('owlWebhookTest').onclick = testOwlContactSync;
  el('logout').onclick = async (event) => { event.preventDefault(); await fetch(base + '/logout', { method: 'POST' }); location.href = base + '/login'; };

  (async function init() { try { const me = await fetch(base + '/me', { headers: { Accept: 'application/json' } }); if (!me.ok) { location.href = base + '/login?next=' + encodeURIComponent(location.pathname); return; } await bootstrap(); updateActionAvailability(); } catch (error) { showAlert('error', error.message); } })();
})();
