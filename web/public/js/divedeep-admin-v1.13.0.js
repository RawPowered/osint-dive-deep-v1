(() => {
  const base = location.pathname.split('/divedeep')[0];
  const state = {
    admin: null,
    csrfToken: '',
    root: false,
    customers: [],
    overview: null,
    operations: null,
    workQueue: null,
    privacyWorkflows: [],
    selectedWorkflow: null,
    reconJobs: [],
    workerPools: [],
    workerInstances: [],
    reviewQueue: { findings: [], imageItems: [], workerCandidates: [] },
    retentionQueue: { artifacts: [], counts: {} },
    monitoringQueue: [],
    caseQueue: [],
    selectedId: null,
    selected: null,
    queueWorkflow: '',
    search: '',
    detailTab: 'identity',
    integrations: [],
    packages: [],
    pilotCodes: [],
    resultImport: { files: new Map(), aliases: new Map(), digests: new Map(), manifest: null, manifestFile: null, archiveFile: null, batch: null, running: false, uploadProgress: 0, sourceLabel: '' },
    evidenceReview: { page: 1, pageSize: 20, filter: 'pending', selected: new Set(), busy: false },
    importPollTimer: null,
    catalog: { summary: {}, schemas: [], resources: [], pools: [], sourceSets: [], packageVersions: [], imageProfiles: [], presentationContract: null, tab: 'resources' },
  };

  const DIVEDEEP_RESULT_PACKET_MAX_BYTES = 5 * 1024 * 1024;
  const IMAGE_RECON_MAX_IMAGES = 20;
  const IMAGE_RECON_MAX_EXPANDED_BYTES = 75 * 1024 * 1024;

  const INTEGRATION_FIELDS = {
    stripe: {
      icon: '$',
      config: [
        { key: 'publishableKey', label: 'Publishable key', placeholder: 'pk_live_…' },
      ],
      secrets: [
        { key: 'secretKey', label: 'Secret key', placeholder: 'sk_live_…' },
        { key: 'webhookSecret', label: 'Webhook signing secret', placeholder: 'whsec_…' },
      ],
    },
    transactional_email: {
      icon: '✉',
      config: [
        { key: 'provider', label: 'Provider', placeholder: 'postmark, resend, or other' },
        { key: 'fromEmail', label: 'From address', type: 'email', placeholder: 'privacy@divedeep.example.invalid' },
        { key: 'replyTo', label: 'Reply-to address', type: 'email', placeholder: 'support@divedeep.example.invalid' },
      ],
      secrets: [{ key: 'apiKey', label: 'Provider API key' }],
    },
    meta: {
      icon: 'M',
      config: [
        { key: 'appId', label: 'Meta app ID' },
        { key: 'graphVersion', label: 'Graph API version', placeholder: 'v24.0' },
        { key: 'redirectUri', label: 'OAuth redirect URI · generated from this API domain', type: 'url', wide: true },
        { key: 'albumImportEnabled', label: 'Enable customer album selection (requires approved user_photos permission)', type: 'checkbox', wide: true },
        { key: 'postImportEnabled', label: 'Enable customer Facebook post ingestion (requires approved user_posts permission)', type: 'checkbox', wide: true },
        { key: 'instagramMediaImportEnabled', label: 'Enable linked Instagram media selection (requires Instagram Graph permissions)', type: 'checkbox', wide: true },
      ],
      secrets: [{ key: 'appSecret', label: 'Meta app secret' }],
    },
    object_storage: {
      icon: '▤',
      config: [
        { key: 'driver', label: 'Storage driver', type: 'select', options: ['s3'] },
        { key: 'credentialMode', label: 'Credential mode', type: 'select', options: ['default_provider_chain', 'assume_role', 'static_keys'] },
        { key: 'bucket', label: 'Private bucket' },
        { key: 'region', label: 'Region', placeholder: 'us-east-1 or auto' },
        { key: 'endpoint', label: 'S3-compatible endpoint', type: 'url', wide: true, placeholder: 'Optional for Cloudflare R2 or another S3-compatible provider' },
        { key: 'forcePathStyle', label: 'Use path-style addressing', type: 'checkbox' },
        { key: 'privatePrefix', label: 'Private object prefix', placeholder: 'divedeep-private/' },
        { key: 'roleArn', label: 'IAM role ARN', wide: true },
        { key: 'checksumMode', label: 'Upload integrity mode', type: 'select', options: ['sha256_header', 'metadata_only'] },
        { key: 'encryptionMode', label: 'Storage encryption mode', type: 'select', options: ['provider_managed', 'sse_s3', 'sse_kms'] },
        { key: 'kmsKeyId', label: 'KMS key ID', wide: true },
        { key: 'uploadUrlSeconds', label: 'Upload authorization seconds', type: 'number' },
        { key: 'downloadUrlSeconds', label: 'Download authorization seconds', type: 'number' },
        { key: 'maximumArtifactBytes', label: 'Maximum artifact bytes', type: 'number' },
        { key: 'objectTaggingEnabled', label: 'Enable provider object tags for lifecycle safety rules', type: 'checkbox', wide: true },
        { key: 'lifecycleSafetyNetEnabled', label: 'Use storage lifecycle rules as a deletion safety net', type: 'checkbox', wide: true },
      ],
      secrets: [
        { key: 'accessKeyId', label: 'Access key ID' },
        { key: 'secretAccessKey', label: 'Secret access key' },
        { key: 'sessionToken', label: 'Session token' },
        { key: 'externalId', label: 'Assume-role external ID' },
      ],
    },
    aws_rekognition: {
      icon: 'AI',
      config: [
        { key: 'credentialMode', label: 'Credential mode', type: 'select', options: ['default_provider_chain', 'assume_role', 'static_keys'] },
        { key: 'region', label: 'AWS Region', placeholder: 'us-east-1' },
        { key: 'roleArn', label: 'IAM role ARN', wide: true, placeholder: 'arn:aws:iam::123456789012:role/DiveDeepRekognition' },
        { key: 'inputMode', label: 'Image input mode', type: 'select', options: ['bytes', 's3_staging'] },
        { key: 'stagingBucket', label: 'Same-region S3 staging bucket' },
        { key: 'stagingPrefix', label: 'Staging prefix', placeholder: 'divedeep-rekognition/' },
        { key: 'defaultSimilarityThreshold', label: 'Default review threshold', type: 'number' },
        { key: 'highPriorityThreshold', label: 'High-priority threshold', type: 'number' },
        { key: 'minimumFaceConfidence', label: 'Minimum face confidence', type: 'number' },
        { key: 'minimumModerationConfidence', label: 'Minimum moderation confidence', type: 'number' },
        { key: 'maximumReferencesPerCandidate', label: 'Maximum references per candidate', type: 'number' },
        { key: 'maximumCandidatesPerRun', label: 'Maximum candidates per run', type: 'number' },
        { key: 'dailyCallBudget', label: 'Daily call ceiling', type: 'number' },
        { key: 'monthlyCallBudget', label: 'Monthly call ceiling', type: 'number' },
        { key: 'enableFaceDetection', label: 'Enable face quality detection', type: 'checkbox' },
        { key: 'enableFaceComparison', label: 'Enable assisted face comparison', type: 'checkbox' },
        { key: 'enableModeration', label: 'Enable consent-gated moderation triage', type: 'checkbox' },
        { key: 'enableTextDetection', label: 'Enable text and watermark detection', type: 'checkbox' },
        { key: 'enableLabelDetection', label: 'Enable contextual label detection', type: 'checkbox' },
      ],
      secrets: [
        { key: 'accessKeyId', label: 'AWS access key ID' },
        { key: 'secretAccessKey', label: 'AWS secret access key' },
        { key: 'sessionToken', label: 'AWS session token' },
        { key: 'externalId', label: 'Assume-role external ID' },
      ],
    },
    google_cloud_run: {
      icon: 'G',
      config: [
        { key: 'credentialMode', label: 'Credential mode', type: 'select', options: ['application_default', 'service_account_json'] },
        { key: 'projectId', label: 'Google Cloud project ID' },
        { key: 'region', label: 'Cloud Run region', placeholder: 'us-east1' },
        { key: 'jobName', label: 'Cloud Run Job name', placeholder: 'divedeep-divedeep' },
        { key: 'serviceAccountEmail', label: 'Worker service account', type: 'email', wide: true, placeholder: 'divedeep-worker@project.example.invalid' },
        { key: 'defaultTaskTimeoutSeconds', label: 'Task timeout seconds', type: 'number' },
        { key: 'defaultMaxRetries', label: 'Maximum retries', type: 'number' },
        { key: 'dispatchEnabled', label: 'Permit live Cloud Run Job dispatch', type: 'checkbox', wide: true },
      ],
      secrets: [
        { key: 'serviceAccountJson', label: 'Service account JSON', type: 'textarea', wide: true, placeholder: 'Prefer Application Default Credentials when possible.' },
      ],
    },
    divedeep_export: {
      icon: 'N',
      config: [
        { key: 'defaultFormat', label: 'Default export format', type: 'select', options: ['json', 'csv', 'md'] },
        { key: 'includePhotoManifest', label: 'Include photo manifest', type: 'checkbox' },
        { key: 'sensitiveAcknowledgement', label: 'Require sensitive export acknowledgement', type: 'checkbox', wide: true },
      ],
      secrets: [],
    },
  };

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const title = (value) => String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  function formatDate(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
    } catch (_error) {
      return parsed.toLocaleString();
    }
  }
  const date = formatDate;
  const shortDate = (value) => value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value)) : '—';
  const initials = (value) => String(value || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((item) => item[0]).join('').toUpperCase();

  function imageExtension(mimeType) {
    return mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function toast(message, error = false) {
    const el = $('adminToast');
    el.textContent = message;
    el.className = `fida-toast show${error ? ' error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.className = 'fida-toast'; }, 4200);
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body != null && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (state.csrfToken) headers['X-Admin-CSRF'] = state.csrfToken;
    const response = await fetch(base + path, { ...options, headers });
    if (response.status === 401) {
      location.href = `${base}/login?next=${encodeURIComponent(location.pathname)}`;
      throw new Error('Not authenticated');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function tone(value) {
    const status = String(value || '').toLowerCase();
    if (['active', 'removed', 'completed', 'closed', 'pass', 'connected', 'configured', 'intake_ready', 'results_ready', 'ready', 'imported'].includes(status)) return 'green';
    if (['pending', 'review', 'queued', 'running', 'sent', 'acknowledged', 'researching', 'needs_action', 'not_checked', 'awaiting_review', 'awaiting_customer_validation', 'disposition_required', 'closure_ready', 'exporting', 'importing', 'unverified', 'draining'].includes(status)) return 'amber';
    if (['closed', 'failed', 'denied', 'reappeared', 'invalid', 'disconnected', 'still_present', 'offline', 'incompatible', 'error', 'cancelled', 'disabled'].includes(status)) return 'red';
    if (['exported', 'monitoring', 'validated'].includes(status)) return 'purple';
    return 'blue';
  }

  function chip(value, label = null) {
    return `<span class="fida-chip ${tone(value)}">${esc(label || title(value || 'unknown'))}</span>`;
  }

  function isSensitive(customer) { return ['sensitive', 'image'].includes(customer?.planTier); }
  function planLabel(plan) { return plan === 'standard' ? 'Level 1' : plan === 'deep' ? 'Level 2' : plan === 'sensitive' ? 'Level 3' : 'Level 4'; }

  async function loadIdentity() {
    const response = await fetch(base + '/me', { headers: { Accept: 'application/json' } });
    if (!response.ok) return location.replace(`${base}/login?next=${encodeURIComponent(location.pathname)}`);
    const data = await response.json();
    state.admin = data.admin;
    state.csrfToken = data.csrfToken || '';
    state.root = (data.admin.principalType || (data.admin.role === 'admin' ? 'root' : 'viewer')) === 'root';
    $('who').textContent = data.admin.username;
    $('adminRole').textContent = state.root ? 'Root owner' : title(data.admin.role);
    $('adminInitials').textContent = initials(data.admin.username);
    $('controlPanelLink').href = base;
    document.querySelectorAll('.root-only').forEach((element) => { element.hidden = !state.root; });
  }

  async function loadDashboard({ preserveSelection = true } = {}) {
    const [customerData, overviewData, operationsData] = await Promise.all([
      api('/api/divedeep/customers?limit=500'),
      api('/api/divedeep/overview'),
      api('/api/divedeep/operations/overview'),
    ]);
    state.customers = customerData.customers || [];
    state.overview = overviewData.overview || {};
    state.operations = operationsData.overview || {};
    renderMetrics();
    renderQueueTabs();
    renderQueue();
    renderPipeline();
    renderExportStats();
    if (preserveSelection && state.selectedId && state.customers.some((item) => item.id === state.selectedId)) {
      await selectCustomer(state.selectedId);
    }
  }

  function renderMetrics() {
    const legacy = state.overview?.metrics || {};
    const operations = state.operations || {};
    const values = [
      Number(legacy.activeCustomers) || 0,
      Number(operations.jobs?.ready) || 0,
      Number(operations.jobs?.active) || 0,
      (Number(operations.jobs?.awaitingReview) || 0) + (Number(operations.review?.imageReview) || 0) + (Number(operations.review?.customerValidation) || 0) + (Number(operations.review?.findingReview) || 0),
      (Number(operations.retention?.expiring24h) || 0) + (Number(operations.retention?.overdue) || 0),
      (Number(operations.jobs?.failed) || 0) + (Number(operations.gates?.blocked) || 0),
    ];
    document.querySelectorAll('#metrics .fida-metric').forEach((card, index) => {
      card.querySelector('strong').textContent = values[index] || 0;
    });
  }

  function renderQueueTabs() {
    const counts = state.customers.reduce((out, item) => {
      out[item.workflowStatus] = (out[item.workflowStatus] || 0) + 1;
      return out;
    }, {});
    document.querySelectorAll('#queueTabs [data-workflow]').forEach((button) => {
      const workflow = button.dataset.workflow;
      button.classList.toggle('active', workflow === state.queueWorkflow);
      const count = workflow ? counts[workflow] || 0 : state.customers.length;
      button.querySelector('b').textContent = count;
    });
  }

  function visibleCustomers() {
    const query = state.search.toLowerCase();
    return state.customers.filter((customer) => {
      if (state.queueWorkflow && customer.workflowStatus !== state.queueWorkflow) return false;
      if (!query) return true;
      return `${customer.displayName} ${customer.email} ${customer.id}`.toLowerCase().includes(query);
    });
  }

  function renderQueue() {
    const customers = visibleCustomers();
    $('customerCount').textContent = customers.length;
    $('customerRows').innerHTML = customers.length ? customers.map((customer) => `
      <tr data-customer="${esc(customer.id)}" class="${customer.id === state.selectedId ? 'selected' : ''}">
        <td><div class="fida-customer-cell"><span class="fida-avatar">${esc(initials(customer.displayName))}</span><div><strong>${esc(customer.displayName)}</strong><small>${esc(customer.email)}</small></div></div></td>
        <td>${chip(customer.planTier, planLabel(customer.planTier))}${isSensitive(customer) ? ' <span title="Sensitive authorization required">▰</span>' : ''}</td>
        <td>${chip(customer.workflowStatus)}</td>
        <td>${esc(date(customer.updatedAt))}</td>
        <td>${Number(customer.profileCount) || 0}</td>
        <td><button class="fida-btn fida-btn-small" data-open-customer="${esc(customer.id)}">Open</button></td>
      </tr>`).join('') : '<tr><td colspan="6"><div class="fida-empty">No customers match this queue.</div></td></tr>';
    document.querySelectorAll('[data-customer], [data-open-customer]').forEach((element) => element.addEventListener('click', () => selectCustomer(element.dataset.customer || element.dataset.openCustomer)));
  }

  function renderPipeline() {
    const cases = state.overview?.cases || {};
    const sent = ['sent', 'acknowledged', 'needs_action'].reduce((sum, key) => sum + (Number(cases[key]) || 0), 0);
    const cards = [
      ['Prepared', Number(cases.draft) || 0, 'blue', 'Drafted'],
      ['Awaiting Approval', Number(cases.approved) || 0, 'amber', 'Root review'],
      ['Sent', sent, 'purple', 'In progress'],
      ['Verified Removed', Number(state.overview?.metrics?.confirmedRemoved) || 0, 'green', 'Confirmed'],
      ['Still Present', Number(state.overview?.metrics?.stillPresent) || 0, 'red', 'Follow-up'],
    ];
    $('pipeline').innerHTML = cards.map(([label, count, cardTone, note]) => `<article class="fida-pipeline-card ${cardTone}"><small>${esc(label)}</small><strong>${count}</strong><em>${esc(note)}</em></article>`).join('');
  }

  function renderExportStats() {
    const exports = state.overview?.exports || {};
    const values = [
      ['Total exports', Number(exports.total) || 0],
      ['This month', Number(exports.thisMonth) || 0],
      ['Removal rate', `${Number(exports.successRate) || 0}%`],
      ['Last export', shortDate(exports.lastExportAt)],
    ];
    $('exportStats').innerHTML = values.map(([label, value]) => `<div class="fida-export-stat"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join('');
  }

  async function selectCustomer(id) {
    if (!id) return;
    const customerChanged = state.selectedId && state.selectedId !== id;
    if (customerChanged) {
      stopImportPolling();
      state.evidenceReview = { page: 1, pageSize: 20, filter: 'pending', selected: new Set(), busy: false };
      state.resultImport = { files: new Map(), aliases: new Map(), digests: new Map(), manifest: null, manifestFile: null, archiveFile: null, batch: null, running: false, uploadProgress: 0, sourceLabel: '' };
    }
    state.selectedId = id;
    renderQueue();
    $('customerDetail').innerHTML = '<div class="fida-detail-empty"><p>Loading protected profile…</p></div>';
    try {
      const [data, gateData, jobData] = await Promise.all([
        api(`/api/divedeep/customers/${encodeURIComponent(id)}`),
        api(`/api/divedeep/customers/${encodeURIComponent(id)}/workflow-gates`).catch(() => ({ gates: [] })),
        api(`/api/divedeep/recon-jobs?customerId=${encodeURIComponent(id)}&limit=50`).catch(() => ({ jobs: [] })),
      ]);
      state.selected = { ...data.dashboard, workflowGates: gateData.gates || [], reconJobs: jobData.jobs || [] };
      const authorizationActive = state.selected.authorization?.status === 'active' && (!state.selected.authorization.expiresAt || new Date(state.selected.authorization.expiresAt) > new Date());
      $('exportSelected').disabled = !state.root || !state.selected.profile || !authorizationActive;
      $('exportImageBundle').disabled = !state.root || !state.selected.profile || !authorizationActive || !(state.selected.photos || []).length;
      $('importResults').disabled = !state.root || !state.selected.profile;
      $('importBundle').disabled = !state.root || !state.selected.profile;
      renderDetail();
      const activeBatch = (state.selected.importBatches || []).find((batch) => ['queued', 'parts', 'evidence', 'finalizing'].includes(batch.job?.phase));
      if (activeBatch && !state.importPollTimer) watchImportBatch(activeBatch.id);
    } catch (error) {
      $('customerDetail').innerHTML = `<div class="fida-detail-empty"><h2>Unable to open customer</h2><p>${esc(error.message)}</p></div>`;
    }
  }

  function renderDetail() {
    const dashboard = state.selected;
    const customer = dashboard.customer;
    $('customerDetail').innerHTML = `
      <div class="fida-detail-head">
        <div class="fida-detail-title"><div><h2>${esc(customer.displayName)}</h2><p>${esc(customer.email)} · ${esc(planLabel(customer.planTier))} · Customer ${esc(customer.id)}</p></div>${chip(customer.workflowStatus)}</div>
        <div class="fida-detail-tools">
          ${state.root && dashboard.profile ? '<button class="fida-btn fida-btn-small" data-export="json">Manual Export</button>' : ''}
          ${state.root && dashboard.photos?.length ? '<button class="fida-btn fida-btn-small" data-export-image-bundle>Image Recon Bundle</button>' : ''}
          <button class="fida-btn fida-btn-small" data-evaluate-gates>Evaluate gates</button>
          <button class="fida-btn fida-btn-primary fida-btn-small" data-create-recon-job>Create recon job</button>
          <button class="fida-btn fida-btn-small" data-detail-tab="evidence">Add finding</button>
          <button class="fida-btn fida-btn-small" data-edit-workflow>Update workflow</button>
        </div>
      </div>
      <div class="fida-detail-tabs">
        <button data-detail-tab="identity">Identity Summary</button>
        <button data-detail-tab="workflow">Workflow Gates <b>${dashboard.workflowGates?.filter((item) => item.status === 'blocked').length || 0}</b></button>
        <button data-detail-tab="recon">Recon Jobs <b>${dashboard.reconJobs?.length || 0}</b></button>
        <button data-detail-tab="evidence">Evidence <b>${dashboard.exposures.length}</b></button>
        <button data-detail-tab="cases">Removal Cases <b>${dashboard.cases.length}</b></button>
        <button data-detail-tab="activity">Activity</button>
      </div>
      <div class="fida-detail-content">
        <section class="fida-detail-pane" data-pane="identity">${renderIdentityPane()}</section>
        <section class="fida-detail-pane" data-pane="workflow">${renderWorkflowGatesPane()}</section>
        <section class="fida-detail-pane" data-pane="recon">${renderCustomerReconPane()}</section>
        <section class="fida-detail-pane" data-pane="evidence">${renderEvidencePane()}</section>
        <section class="fida-detail-pane" data-pane="cases">${renderCasesPane()}</section>
        <section class="fida-detail-pane" data-pane="activity">${renderActivityPane()}</section>
      </div>`;
    setDetailTab(state.detailTab);
    wireDetailActions();
  }

  function groupIdentifiers(profile) {
    return (profile?.identifiers || []).reduce((out, item) => {
      (out[item.type] ||= []).push(item.value);
      return out;
    }, {});
  }

  function renderIdentityPane() {
    const dashboard = state.selected;
    if (!dashboard.profile) return '<div class="fida-empty">Customer onboarding is incomplete.</div>';
    const identifiers = groupIdentifiers(dashboard.profile);
    const authorization = dashboard.authorization;
    const authorizationActive = authorization?.status === 'active' && (!authorization.expiresAt || new Date(authorization.expiresAt) > new Date());
    const renderValues = (label, values) => values?.length ? `<div class="fida-definition"><b>${esc(label)}</b>${values.map((value) => `<span>${esc(value)}</span>`).join('<br>')}</div>` : '';
    return `
      <div id="workflowEditor"></div>
      <div class="fida-authorization-banner ${authorizationActive ? 'active' : 'blocked'}"><div><strong>${authorizationActive ? 'Limited Authorization active' : 'Removal authority blocked'}</strong><p>${authorization ? `${esc(title(authorization.status))} · signed ${esc(date(authorization.signedAt))}${authorization.expiresAt ? ` · expires ${esc(date(authorization.expiresAt))}` : ''}` : 'Customer has not executed the post-signup Limited Authorization.'}</p></div>${authorization ? `<span>${esc(authorization.authorizationVersion)}</span>` : ''}</div>
      <div class="fida-summary-grid">
        <div class="fida-mini-card"><h3>Authorized identity</h3>
          ${renderValues('Names', identifiers.name)}${renderValues('Aliases', identifiers.alias)}${renderValues('Emails', identifiers.email)}${renderValues('Phones', identifiers.phone)}${renderValues('Addresses', identifiers.address)}${renderValues('Usernames', identifiers.username)}
          <div class="fida-definition"><b>Jurisdiction</b><span>${esc([dashboard.profile.jurisdictionRegion, dashboard.profile.jurisdictionCountry].filter(Boolean).join(', ') || 'Not provided')}</span></div>
        </div>
        <div class="fida-mini-card"><h3>Declared social profiles</h3>
          ${dashboard.connections.length ? dashboard.connections.map((connection) => `<div class="fida-definition"><b>${esc(title(connection.provider))} ${chip(connection.status)}</b>${connection.profileUrl ? `<a href="${esc(connection.profileUrl)}" target="_blank" rel="noopener noreferrer">${esc(connection.profileUrl)}</a>` : `<span>${esc(connection.username || connection.displayName || connection.externalUserId)}</span>`}</div>`).join('') : '<p class="fida-empty">No profiles declared.</p>'}
          <h3>Visibility policies</h3><div class="fida-policy-list">${dashboard.profile.policies.map((policy) => chip(policy.action)).join('') || chip('review')}</div>
        </div>
      </div>
      <div class="fida-section-title"><h3>Reference photos</h3><small>${dashboard.photos.length} protected files</small></div>
      <div class="fida-photo-list">${dashboard.photos.length ? dashboard.photos.map((photo) => `<button class="fida-photo-tile" data-load-photo="${esc(photo.id)}" title="Root-audited photo reveal">Reveal<br>${esc(photo.label)}</button>`).join('') : '<div class="fida-empty">No reference photos.</div>'}</div>`;
  }

  function findingCard(exposure, evidenceIndex = new Map()) {
    const sensitive = /adult|sensitive/i.test(exposure.contentCategory || '');
    const evidence = evidenceIndex.get(exposure.id) || [];
    const publication = exposure.publicationStatus || 'published';
    const checked = state.evidenceReview.selected.has(exposure.id) ? 'checked' : '';
    const publicationActions = publication === 'staged'
      ? `<button class="fida-btn fida-btn-small" data-publication="approved" data-exposure="${esc(exposure.id)}">Approve</button><button class="fida-btn fida-btn-success fida-btn-small" data-publication="published" data-exposure="${esc(exposure.id)}">Publish</button><button class="fida-btn fida-btn-danger fida-btn-small" data-publication="rejected" data-exposure="${esc(exposure.id)}">Reject</button>`
      : publication === 'approved'
        ? `<button class="fida-btn fida-btn-success fida-btn-small" data-publication="published" data-exposure="${esc(exposure.id)}">Publish</button><button class="fida-btn fida-btn-small" data-publication="staged" data-exposure="${esc(exposure.id)}">Return to staged</button>`
        : '';
    return `<article class="fida-finding-card ${sensitive ? 'sensitive' : ''}">
      <header><label class="fida-review-select"><input type="checkbox" data-select-finding="${esc(exposure.id)}" ${checked} /><span></span></label><h4>${esc(exposure.sourceName)}</h4><span>${chip(exposure.status)} ${chip(publication)}</span></header>
      <a href="${esc(exposure.listingUrl)}" target="_blank" rel="noopener noreferrer">${esc(exposure.listingUrl)}</a>
      <div class="fida-finding-meta"><span>${esc(title(exposure.contentCategory))}</span><strong>${Math.round((Number(exposure.matchConfidence) || 0) * 100)}% confidence</strong></div>
      ${evidence.length ? `<div class="fida-evidence-strip">${evidence.slice(0, 6).map((item) => `<button class="fida-evidence-thumb" data-load-evidence="${esc(item.id)}" title="${esc(item.evidenceType)} · ${esc(item.publicationStatus)}">Reveal evidence</button>`).join('')}</div>` : ''}
      <div class="fida-card-actions"><button class="fida-btn fida-btn-success fida-btn-small" data-finding-status="confirmed" data-exposure="${esc(exposure.id)}">Confirm match</button><button class="fida-btn fida-btn-small" data-finding-status="false_positive" data-exposure="${esc(exposure.id)}">Not a match</button></div>
      ${publicationActions ? `<div class="fida-publication-row"><strong>Customer visibility:</strong>${publicationActions}</div>` : ''}
    </article>`;
  }

  function reviewFindings() {
    const all = state.selected?.exposures || [];
    const filter = state.evidenceReview.filter;
    if (filter === 'pending') return all.filter((item) => ['staged', 'approved'].includes(item.publicationStatus || 'published'));
    if (filter === 'all') return all;
    return all.filter((item) => (item.publicationStatus || 'published') === filter);
  }

  function renderEvidencePane() {
    const all = state.selected.exposures || [];
    const filtered = reviewFindings();
    const pages = Math.max(1, Math.ceil(filtered.length / state.evidenceReview.pageSize));
    state.evidenceReview.page = Math.min(Math.max(1, state.evidenceReview.page), pages);
    const start = (state.evidenceReview.page - 1) * state.evidenceReview.pageSize;
    const visible = filtered.slice(start, start + state.evidenceReview.pageSize);
    const evidenceIndex = new Map();
    for (const item of state.selected.evidenceFiles || []) {
      if (!item.exposureId) continue;
      const list = evidenceIndex.get(item.exposureId) || [];
      list.push(item); evidenceIndex.set(item.exposureId, list);
    }
    const selectedCount = state.evidenceReview.selected.size;
    return `
      <details class="fida-mini-card" id="findingComposer"><summary><strong>Add manual DiveDeep finding</strong></summary>
        <form id="findingForm" class="fida-admin-form">
          <label class="fida-field"><span>Source name</span><input class="fida-input" name="sourceName" required placeholder="Example Directory" /></label>
          <label class="fida-field"><span>Category</span><select class="fida-select" name="contentCategory"><option value="social">Social</option><option value="people-search">People search</option><option value="directory">Directory</option><option value="adult">Adult / sensitive</option><option value="other">Other</option></select></label>
          <label class="fida-field full"><span>Public listing URL</span><input class="fida-input" name="listingUrl" type="url" required /></label>
          <label class="fida-field"><span>Matched detail</span><input class="fida-input" name="subjectIdentifier" /></label>
          <label class="fida-field"><span>Listing identifier</span><input class="fida-input" name="listingIdentifier" /></label>
          <label class="fida-field"><span>Confidence</span><input class="fida-input" name="matchConfidence" type="number" min="0" max="1" step="0.01" value="0.90" /></label>
          <label class="fida-field"><span>Privacy contact</span><input class="fida-input" name="recipientEmail" type="email" /></label>
          <label class="fida-check full"><input type="checkbox" name="confirmed" checked /> Confirm the finding belongs to this customer.</label>
          <label class="fida-check full"><input type="checkbox" name="createCase" /> Prepare a removal-request draft.</label>
          <label class="fida-field full"><span>Internal notes</span><textarea class="fida-textarea" name="notes"></textarea></label>
          <button class="fida-btn fida-btn-primary full" type="submit">Publish finding</button>
        </form>
      </details>
      <div class="fida-section-title"><h3>Segmented imports</h3><small>${(state.selected.importBatches || []).length} batches</small></div>
      <div class="fida-batch-list">${(state.selected.importBatches || []).length ? state.selected.importBatches.map((batch) => {
        const job = batch.job;
        const progress = job ? `<div class="fida-job-progress"><div><span>${esc(job.message || title(job.phase))}</span><strong>${job.percent}%</strong></div><div class="fida-import-progress"><i style="--progress:${job.percent}%"></i></div>${job.safeToRefresh ? '<small>Server-side job: safe to close or refresh this page.</small>' : ''}</div>` : '';
        const active = job && ['queued','parts','evidence','finalizing'].includes(job.phase);
        return `<article class="fida-batch-card" data-import-batch-card="${esc(batch.id)}"><header><strong>${esc(batch.sourceBatchId)}</strong><span data-import-batch-status>${chip(batch.status)}</span></header><p>${batch.importedCount}/${batch.findingCount} findings · ${batch.partCount} parts · ${batch.evidenceCount} evidence files</p><div data-import-batch-progress>${progress}</div>${batch.lastError ? `<p class="fida-inline-error">${esc(batch.lastError)}</p>` : ''}<div class="fida-card-actions"><button class="fida-btn fida-btn-small" data-open-import-job="${esc(batch.id)}">${active ? 'View progress' : 'View import'}</button>${job?.phase === 'failed' && job.bundleUploaded ? `<button class="fida-btn fida-btn-primary fida-btn-small" data-resume-import="${esc(batch.id)}">Resume</button>` : ''}${['ready_review','review'].includes(batch.status) ? `<button class="fida-btn fida-btn-success fida-btn-small" data-publish-batch="${esc(batch.id)}">Publish approved</button>` : ''}${!['published','cancelled','expired'].includes(batch.status) ? `<button class="fida-btn fida-btn-danger fida-btn-small" data-cancel-batch="${esc(batch.id)}">Cancel</button>` : ''}</div></article>`;
      }).join('') : '<div class="fida-empty">No segmented imports.</div>'}</div>
      <div class="fida-section-title"><h3>Evidence Review</h3><small>${all.length} findings</small></div>
      <div class="fida-review-toolbar">
        <select class="fida-select" id="findingPublicationFilter"><option value="pending" ${state.evidenceReview.filter === 'pending' ? 'selected' : ''}>Needs review</option><option value="staged" ${state.evidenceReview.filter === 'staged' ? 'selected' : ''}>Staged</option><option value="approved" ${state.evidenceReview.filter === 'approved' ? 'selected' : ''}>Approved</option><option value="published" ${state.evidenceReview.filter === 'published' ? 'selected' : ''}>Published</option><option value="rejected" ${state.evidenceReview.filter === 'rejected' ? 'selected' : ''}>Rejected</option><option value="all" ${state.evidenceReview.filter === 'all' ? 'selected' : ''}>All</option></select>
        <button class="fida-btn fida-btn-small" data-select-review-page>Select page</button><span>${selectedCount} selected</span>
        <button class="fida-btn fida-btn-small" data-bulk-publication="approved" ${selectedCount ? '' : 'disabled'}>Approve selected</button><button class="fida-btn fida-btn-success fida-btn-small" data-bulk-publication="published" ${selectedCount ? '' : 'disabled'}>Publish selected</button><button class="fida-btn fida-btn-danger fida-btn-small" data-bulk-publication="rejected" ${selectedCount ? '' : 'disabled'}>Reject selected</button>
        <button class="fida-btn fida-btn-primary fida-btn-small" data-approve-filtered ${filtered.length ? '' : 'disabled'}>Approve all filtered (${filtered.length})</button>
      </div>
      <div class="fida-review-pager"><button class="fida-btn fida-btn-small" data-review-page="${state.evidenceReview.page - 1}" ${state.evidenceReview.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${state.evidenceReview.page} of ${pages} · showing ${visible.length} of ${filtered.length}</span><button class="fida-btn fida-btn-small" data-review-page="${state.evidenceReview.page + 1}" ${state.evidenceReview.page >= pages ? 'disabled' : ''}>Next</button></div>
      <div class="fida-finding-grid">${visible.length ? visible.map((item) => findingCard(item, evidenceIndex)).join('') : '<div class="fida-empty">No findings match this review filter.</div>'}</div>`;
  }

  function nextCaseButtons(privacyCase) {
    const map = {
      draft: ['approved'], approved: ['queued'], queued: ['sent'], sent: ['acknowledged', 'needs_action', 'completed'],
      acknowledged: ['needs_action', 'completed'], needs_action: ['approved', 'queued', 'sent', 'completed'], failed: ['queued'], denied: ['needs_action'],
    };
    return map[privacyCase.state] || [];
  }

  function renderCasesPane() {
    return state.selected.cases.length ? state.selected.cases.map((privacyCase) => `
      <article class="fida-case"><header><div><h4>${esc(privacyCase.emailSubject || title(privacyCase.requestType))}</h4><p>${esc(privacyCase.recipientEmail || 'No recipient configured')} · revision ${privacyCase.revision}</p></div>${chip(privacyCase.state)}</header>
        <div class="fida-card-actions">${nextCaseButtons(privacyCase).map((next) => `<button class="fida-btn fida-btn-small" data-case-id="${esc(privacyCase.id)}" data-case-state="${next}" data-revision="${privacyCase.revision}">${esc(title(next))}</button>`).join('')}
          <button class="fida-btn fida-btn-success fida-btn-small" data-verify-id="${esc(privacyCase.id)}" data-verify-result="removed">Verify removed</button>
          <button class="fida-btn fida-btn-danger fida-btn-small" data-verify-id="${esc(privacyCase.id)}" data-verify-result="still_present">Still present</button>
        </div>
      </article>`).join('') : '<div class="fida-empty">No removal cases have been prepared.</div>';
  }

  function renderActivityPane() {
    return state.selected.events.length ? state.selected.events.map((event) => `<div class="fida-activity"><div><strong>${esc(title(event.eventType))}</strong><small>${esc(event.actorType || 'system')} · ${esc(date(event.createdAt))}</small></div>${event.details?.note ? `<small>${esc(event.details.note)}</small>` : ''}</div>`).join('') : '<div class="fida-empty">No activity recorded.</div>';
  }

  function setDetailTab(tab) {
    state.detailTab = ['identity', 'workflow', 'recon', 'evidence', 'cases', 'activity'].includes(tab) ? tab : 'identity';
    document.querySelectorAll('[data-detail-tab]').forEach((button) => button.classList.toggle('active', button.dataset.detailTab === state.detailTab));
    document.querySelectorAll('[data-pane]').forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === state.detailTab));
  }

  function workflowForm() {
    const customer = state.selected.customer;
    return `<form id="customerStateForm" class="fida-admin-form">
      <label class="fida-field"><span>Account status</span><select class="fida-select" name="status">${['pending','active','paused','closed'].map((value) => `<option value="${value}" ${customer.status === value ? 'selected' : ''}>${title(value)}</option>`).join('')}</select></label>
      <label class="fida-field"><span>Workflow</span><select class="fida-select" name="workflowStatus">${['onboarding','intake_ready','awaiting_dispatch','dispatched','researching','awaiting_review','awaiting_customer_validation','disposition_required','evidence_ready','removal_preparation','requests_in_progress','monitoring','closure_ready','complete','blocked'].map((value) => `<option value="${value}" ${customer.workflowStatus === value ? 'selected' : ''}>${title(value)}</option>`).join('')}</select></label>
      <label class="fida-field"><span>Service level</span><select class="fida-select" name="planTier">${['standard','deep','sensitive','image'].map((value) => `<option value="${value}" ${customer.planTier === value ? 'selected' : ''}>${planLabel(value)}</option>`).join('')}</select></label>
      <label class="fida-field"><span>Audit note</span><input class="fida-input" name="note" placeholder="Reason for the change" /></label>
      <button class="fida-btn fida-btn-primary full" type="submit">Save workflow</button>
    </form>`;
  }

  function wireDetailActions() {
    document.querySelectorAll('[data-detail-tab]').forEach((button) => button.addEventListener('click', () => setDetailTab(button.dataset.detailTab)));
    document.querySelectorAll('[data-export]').forEach((button) => button.addEventListener('click', () => downloadExport(button.dataset.export)));
    document.querySelectorAll('[data-export-image-bundle]').forEach((button) => button.addEventListener('click', () => downloadImageReconBundle(button)));
    document.querySelectorAll('[data-evaluate-gates]').forEach((button) => button.addEventListener('click', () => evaluateCustomerGates()));
    document.querySelectorAll('[data-create-recon-job]').forEach((button) => button.addEventListener('click', () => createReconJob()));
    wireOperationalActions($('customerDetail'));
    document.querySelectorAll('[data-edit-workflow]').forEach((button) => button.addEventListener('click', () => {
      setDetailTab('identity');
      $('workflowEditor').innerHTML = workflowForm();
      wireWorkflowForm();
    }));
    wireWorkflowForm();
    const findingForm = $('findingForm');
    if (findingForm) findingForm.addEventListener('submit', submitFinding);
    document.querySelectorAll('[data-finding-status]').forEach((button) => button.addEventListener('click', () => updateFinding(button.dataset.exposure, button.dataset.findingStatus)));
    document.querySelectorAll('[data-publication]').forEach((button) => button.addEventListener('click', () => updatePublication(button.dataset.exposure, button.dataset.publication)));
    document.querySelectorAll('[data-select-finding]').forEach((input) => input.addEventListener('change', () => {
      if (input.checked) state.evidenceReview.selected.add(input.dataset.selectFinding); else state.evidenceReview.selected.delete(input.dataset.selectFinding);
      renderDetail();
    }));
    const reviewFilter = $('findingPublicationFilter');
    if (reviewFilter) reviewFilter.addEventListener('change', () => { state.evidenceReview.filter = reviewFilter.value; state.evidenceReview.page = 1; state.evidenceReview.selected.clear(); renderDetail(); });
    document.querySelectorAll('[data-review-page]').forEach((button) => button.addEventListener('click', () => { state.evidenceReview.page = Number(button.dataset.reviewPage) || 1; renderDetail(); }));
    document.querySelectorAll('[data-select-review-page]').forEach((button) => button.addEventListener('click', () => {
      const filtered = reviewFindings(); const start = (state.evidenceReview.page - 1) * state.evidenceReview.pageSize;
      for (const item of filtered.slice(start, start + state.evidenceReview.pageSize)) state.evidenceReview.selected.add(item.id);
      renderDetail();
    }));
    document.querySelectorAll('[data-bulk-publication]').forEach((button) => button.addEventListener('click', () => bulkUpdatePublication([...state.evidenceReview.selected], button.dataset.bulkPublication)));
    document.querySelectorAll('[data-approve-filtered]').forEach((button) => button.addEventListener('click', () => bulkUpdatePublication(reviewFindings().map((item) => item.id), 'approved')));
    document.querySelectorAll('[data-load-evidence]').forEach((button) => button.addEventListener('click', () => loadEvidence(button)));
    document.querySelectorAll('[data-publish-batch]').forEach((button) => button.addEventListener('click', () => publishBatchById(button.dataset.publishBatch)));
    document.querySelectorAll('[data-cancel-batch]').forEach((button) => button.addEventListener('click', () => cancelBatchById(button.dataset.cancelBatch)));
    document.querySelectorAll('[data-open-import-job]').forEach((button) => button.addEventListener('click', () => openImportJob(button.dataset.openImportJob)));
    document.querySelectorAll('[data-resume-import]').forEach((button) => button.addEventListener('click', () => resumeImportJob(button.dataset.resumeImport)));
    document.querySelectorAll('[data-case-state]').forEach((button) => button.addEventListener('click', () => updateCase(button)));
    document.querySelectorAll('[data-verify-result]').forEach((button) => button.addEventListener('click', () => verifyCase(button)));
    document.querySelectorAll('[data-load-photo]').forEach((button) => button.addEventListener('click', () => loadPhoto(button)));
  }

  function wireWorkflowForm() {
    const form = $('customerStateForm');
    if (!form || form.dataset.wired) return;
    form.dataset.wired = 'true';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        await loadDashboard();
        toast('Customer workflow updated.');
      } catch (error) { toast(error.message, true); }
    });
  }

  async function submitFinding(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.confirmed = Boolean(form.elements.confirmed?.checked);
    payload.createCase = Boolean(form.elements.createCase?.checked);
    payload.matchConfidence = Number(payload.matchConfidence || 0);
    try {
      await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/findings`, { method: 'POST', body: JSON.stringify(payload) });
      await loadDashboard();
      state.detailTab = 'evidence';
      toast('Finding published to the customer case.');
    } catch (error) { toast(error.message, true); }
  }

  async function updateFinding(exposureId, status) {
    if (state.evidenceReview.busy) return;
    state.evidenceReview.busy = true;
    try {
      await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/findings/${encodeURIComponent(exposureId)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      const item = state.selected.exposures.find((entry) => entry.id === exposureId);
      if (item) item.status = status;
      state.detailTab = 'evidence';
      renderDetail();
      toast(`Finding marked ${title(status)}.`);
    } catch (error) { toast(error.message, true); }
    finally { state.evidenceReview.busy = false; }
  }

  async function updateCase(button) {
    try {
      await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/cases/${encodeURIComponent(button.dataset.caseId)}`, {
        method: 'PATCH', body: JSON.stringify({ state: button.dataset.caseState, expectedRevision: Number(button.dataset.revision) }),
      });
      state.detailTab = 'cases';
      await loadDashboard();
      toast(`Case moved to ${title(button.dataset.caseState)}.`);
    } catch (error) { toast(error.message, true); }
  }

  async function verifyCase(button) {
    try {
      await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/cases/${encodeURIComponent(button.dataset.verifyId)}/verifications`, {
        method: 'POST', body: JSON.stringify({ result: button.dataset.verifyResult, notes: 'Recorded by DiveDeep root operations.' }),
      });
      state.detailTab = 'cases';
      await loadDashboard();
      toast(`Verification recorded: ${title(button.dataset.verifyResult)}.`);
    } catch (error) { toast(error.message, true); }
  }

  async function downloadExport(format = 'json') {
    if (!state.root || !state.selectedId) return;
    try {
      const response = await fetch(`${base}/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/export?format=${encodeURIComponent(format)}`, {
        headers: { Accept: '*/*', 'X-Admin-CSRF': state.csrfToken },
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Export failed');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `divedeep-export.${format}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await loadDashboard();
      toast('Authorized DiveDeep packet exported.');
    } catch (error) { toast(error.message, true); }
  }

  async function downloadImageReconBundle(trigger = null) {
    if (!state.root || !state.selectedId || !state.selected?.profile) return;
    const photos = [...(state.selected.photos || [])];
    if (!photos.length) return toast('This customer has no authorized reference photos.', true);
    if (photos.length > IMAGE_RECON_MAX_IMAGES) return toast(`Image bundle exceeds the ${IMAGE_RECON_MAX_IMAGES}-image alpha limit.`, true);
    const declaredBytes = photos.reduce((sum, photo) => sum + (Number(photo.byteSize) || 0), 0);
    if (declaredBytes > IMAGE_RECON_MAX_EXPANDED_BYTES) return toast('Image bundle exceeds the 75 MB alpha limit.', true);

    const button = trigger || $('exportImageBundle');
    const originalLabel = button?.innerHTML;
    if (button) button.disabled = true;
    try {
      const imageEntries = [];
      const manifestImages = [];
      let receivedBytes = 0;
      for (let index = 0; index < photos.length; index += 1) {
        const photo = photos[index];
        if (button) button.textContent = `Bundling ${index + 1}/${photos.length}`;
        const response = await fetch(`${base}/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/photos/${encodeURIComponent(photo.id)}`, {
          headers: { 'X-Admin-CSRF': state.csrfToken },
        });
        if (!response.ok) throw new Error(`Unable to download reference photo ${index + 1}.`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        receivedBytes += bytes.length;
        if (receivedBytes > IMAGE_RECON_MAX_EXPANDED_BYTES) throw new Error('Downloaded image bundle exceeds the 75 MB alpha limit.');
        const extension = imageExtension(photo.mimeType);
        const fileName = `reference-images/${photo.id}.${extension}`;
        imageEntries.push({ name: fileName, data: bytes });
        manifestImages.push({
          photoId: photo.id,
          fileName,
          mimeType: photo.mimeType,
          byteSize: bytes.length,
          sha256: photo.sha256,
          purpose: photo.purpose || 'identity_search',
          label: photo.label || 'Reference photo',
          originalName: photo.originalName || '',
          createdAt: photo.createdAt || null,
        });
      }

      const customer = state.selected.customer || {};
      const profile = state.selected.profile || {};
      const authorization = state.selected.authorization || profile.authorization || {};
      const manifest = {
        packetType: 'divedeep.image-recon-intake',
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        product: 'OSINT Dive Deep v1',
        customerId: customer.id,
        profileId: profile.id,
        customer: {
          displayName: customer.displayName || '',
          planTier: customer.planTier || '',
          workflowStatus: customer.workflowStatus || '',
        },
        authorization: {
          status: authorization.status || 'unknown',
          id: authorization.id || null,
          version: authorization.authorizationVersion || authorization.statementVersion || null,
          signedAt: authorization.signedAt || null,
          expiresAt: authorization.expiresAt || null,
          revokedAt: authorization.revokedAt || null,
          sensitiveContentAuthorized: Boolean(customer.sensitiveContentConsentAt),
        },
        limits: {
          imageCount: manifestImages.length,
          expandedBytes: receivedBytes,
        },
        images: manifestImages,
      };
      const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
      const zip = DiveDeepZip.createStoredZipBlob([{ name: 'manifest.json', data: manifestBytes }, ...imageEntries]);
      const slug = String(customer.displayName || customer.id || 'customer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || customer.id;
      downloadBlob(zip, `divedeep-image-recon-${slug}.zip`);
      toast(`Image Recon bundle created with ${manifestImages.length} authorized image${manifestImages.length === 1 ? '' : 's'}.`);
    } catch (error) {
      toast(error.message, true);
    } finally {
      if (button) { button.disabled = false; button.innerHTML = originalLabel; }
    }
  }

  function normalizeResultBundlePath(value) {
    const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (raw === 'manifest.json' || raw.endsWith('/manifest.json')) return 'manifest.json';
    const findingIndex = raw.lastIndexOf('/findings/');
    if (findingIndex >= 0) return raw.slice(findingIndex + 1);
    if (raw.startsWith('findings/')) return raw;
    const evidenceIndex = raw.lastIndexOf('/evidence/');
    if (evidenceIndex >= 0) return raw.slice(evidenceIndex + 1);
    if (raw.startsWith('evidence/')) return raw;
    const baseName = raw.split('/').pop();
    if (/^findings-\d+\.json$/i.test(baseName)) return `findings/${baseName}`;
    if (/^ev_[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(baseName)) return `evidence/${baseName}`;
    return baseName;
  }

  function resultBundleFile(fileName) {
    const current = state.resultImport;
    return current.files.get(fileName) || current.aliases.get(String(fileName || '').split('/').pop()) || null;
  }


  function normalizedEvidenceMime(item) {
    const aliases = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png' };
    let mimeType = String(item?.mimeType || item?.mediaType || '').toLowerCase().split(';', 1)[0].trim();
    mimeType = aliases[mimeType] || mimeType;
    if (!mimeType || mimeType === 'application/octet-stream') {
      if (/\.jpe?g$/i.test(item?.fileName || '')) mimeType = 'image/jpeg';
      else if (/\.png$/i.test(item?.fileName || '')) mimeType = 'image/png';
      else if (/\.webp$/i.test(item?.fileName || '')) mimeType = 'image/webp';
    }
    return mimeType || 'application/octet-stream';
  }

  function evidenceUploadRequired(item) {
    return item?.uploadRequired === true || /^image\/(jpeg|png|webp)$/i.test(normalizedEvidenceMime(item));
  }

  async function sha256File(file) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function cachedSha256File(file) {
    if (state.resultImport.digests.has(file)) return state.resultImport.digests.get(file);
    const digest = await sha256File(file);
    state.resultImport.digests.set(file, digest);
    return digest;
  }

  function importFileStatus(kind, record) {
    const batch = state.resultImport.batch;
    if (!batch) return 'ready';
    if (kind === 'part') {
      const serverRecord = batch.parts?.find((item) => item.fileName === record.fileName);
      if (serverRecord?.status === 'imported' && Number(serverRecord.errorCount) > 0) return 'failed';
      return serverRecord?.status || 'pending';
    }
    return batch.evidence?.find((item) => item.fileName === record.fileName)?.status || 'pending';
  }

  function findingImportMessage(result, fallback = 'Finding import failed') {
    const count = Number(result?.errorCount ?? result?.errors?.length) || 0;
    const groups = Array.isArray(result?.errorSummary) ? result.errorSummary : [];
    const detail = groups.slice(0, 3).map((item) => `${Number(item.count) || 1}x [${item.code || 'FINDING_FAILED'}] ${item.message || fallback}`).join('; ')
      || (result?.errors || []).slice(0, 3).map((item) => item.error || item.findingKey).filter(Boolean).join('; ');
    return `${count || 'One or more'} finding${count === 1 ? '' : 's'} failed${detail ? `: ${detail}` : `: ${fallback}`}`;
  }

  function renderResultImport() {
    const current = state.resultImport;
    const manifest = current.manifest;
    const batch = current.batch;
    const summary = $('resultBundleSummary');
    const queue = $('resultBundleQueue');
    const progress = $('resultImportProgress');
    $('validateResultBundle').disabled = !current.manifestFile || current.running;
    const resumable = batch?.job?.phase === 'failed' && batch?.job?.bundleUploaded && !manifest;
    $('startResultImport').disabled = (!manifest && !resumable) || current.running || ['queued','parts','evidence','finalizing'].includes(batch?.job?.phase);
    $('startResultImport').textContent = resumable ? 'Resume Background Import' : 'Upload & Run in Background';
    $('publishResultBatch').hidden = !batch || !['ready_review', 'review'].includes(batch.status);
    const job = batch?.job;
    if (progress) {
      const percent = current.running && current.uploadProgress < 100 ? current.uploadProgress : Number(job?.percent) || 0;
      const label = current.running && current.uploadProgress < 100 ? `Uploading protected package… ${percent}%` : job?.message || (batch ? title(batch.status) : 'Select and validate a package.');
      progress.innerHTML = `<div class="fida-job-progress"><div><span>${esc(label)}</span><strong>${percent}%</strong></div><div class="fida-import-progress"><i style="--progress:${percent}%"></i></div>${current.uploadProgress >= 100 || job?.safeToRefresh ? '<small>Upload is durable. The server will continue if this page is closed or refreshed.</small>' : '<small>Keep this page open until the upload reaches 100%.</small>'}</div>`;
    }
    if (!manifest && !batch) {
      summary.innerHTML = '<div class="fida-empty">No valid manifest selected.</div>';
      queue.innerHTML = '';
      return;
    }
    summary.innerHTML = [
      ['Batch', manifest?.batchId || batch?.sourceBatchId || '—'], ['Findings', manifest?.findingCount ?? batch?.findingCount ?? 0],
      ['JSON parts', manifest?.parts?.length ?? batch?.partCount ?? 0], ['Evidence files', manifest?.evidence?.length ?? batch?.evidenceCount ?? 0],
      ...(current.sourceLabel ? [['Source', current.sourceLabel]] : []),
    ].map(([label, value]) => `<div class="fida-import-stat"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join('');
    const records = manifest ? [
      ...(manifest.parts || []).map((item) => ({ ...item, kind: 'part' })),
      ...(manifest.evidence || []).map((item) => ({ ...item, kind: 'evidence' })),
    ] : [
      ...(batch?.parts || []).map((item) => ({ ...item, kind: 'part' })),
      ...(batch?.evidence || []).map((item) => ({ ...item, kind: 'evidence' })),
    ];
    queue.innerHTML = records.map((item) => {
      const serverRecord = item.kind === 'part' ? batch?.parts?.find((value) => value.fileName === item.fileName) : batch?.evidence?.find((value) => value.fileName === item.fileName);
      const status = serverRecord?.status || (manifest ? 'ready' : 'pending');
      const complete = item.kind === 'part' ? status === 'imported' && Number(serverRecord?.errorCount || 0) === 0 : ['uploaded', 'metadata_only'].includes(status);
      const issue = serverRecord?.lastError || (serverRecord?.errorCount ? `${serverRecord.errorCount} finding errors` : '');
      return `<div class="fida-import-row"><strong>${esc(item.fileName)}</strong><small>${esc(item.kind)} · ${Math.ceil((Number(item.byteSize) || 0) / 1024)} KB${issue ? ` · ${esc(issue)}` : ''}</small><span>${chip(complete ? 'completed' : status)}</span></div>`;
    }).join('') || '<div class="fida-empty">No package files to display.</div>';
  }

  async function validateResultBundle() {
    const current = state.resultImport;
    if (!current.manifestFile) throw new Error('Select a DiveDeep ZIP, folder, or package files first.');
    const manifest = JSON.parse(await current.manifestFile.text());
    if (manifest.packetType !== 'divedeep.recon-result-manifest' || Number(manifest.schemaVersion) !== 1) throw new Error('Unsupported DiveDeep result manifest.');
    if (manifest.customerId !== state.selectedId || manifest.profileId !== state.selected?.profile?.id) throw new Error('This bundle belongs to a different customer or protected profile.');
    if (!manifest.batchId || !Array.isArray(manifest.parts) || !manifest.parts.length || !Array.isArray(manifest.evidence)) throw new Error('The DiveDeep manifest is incomplete.');
    const required = [
      ...manifest.parts.map((item) => ({ ...item, kind: 'result part' })),
      ...manifest.evidence.filter(evidenceUploadRequired).map((item) => ({ ...item, kind: 'evidence' })),
    ];
    const missing = required.filter((item) => !resultBundleFile(item.fileName)).map((item) => item.fileName);
    if (missing.length) throw new Error(`Bundle is missing ${missing.length} declared file${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 3).join(', ')}`);
    for (const item of required) {
      const file = resultBundleFile(item.fileName);
      if (Number(item.byteSize) !== file.size) throw new Error(`File size mismatch: ${item.fileName}`);
      const digest = await cachedSha256File(file);
      if (!/^[a-f0-9]{64}$/i.test(item.sha256 || '') || digest !== String(item.sha256).toLowerCase()) throw new Error(`SHA-256 mismatch: ${item.fileName}`);
    }
    current.manifest = manifest;
    current.manifestSha256 = await cachedSha256File(current.manifestFile);
    renderResultImport();
    toast(`Validated ${manifest.parts.length} JSON part${manifest.parts.length === 1 ? '' : 's'} and ${manifest.evidence.length} evidence record${manifest.evidence.length === 1 ? '' : 's'}.`);
    return manifest;
  }

  async function adoptResultFiles(entries, sourceLabel = '') {
    let selected = [...entries];
    let archiveFile = null;
    const zipEntries = selected.filter((entry) => /\.zip$/i.test((entry.file || entry)?.name || ''));
    if (zipEntries.length) {
      if (zipEntries.length !== 1 || selected.length !== 1) throw new Error('Select one DiveDeep ZIP at a time, or select the extracted folder contents without the ZIP.');
      if (!window.DiveDeepZip?.extractZipFile) throw new Error('ZIP import support did not load. Refresh the admin page and try again.');
      const archive = zipEntries[0].file || zipEntries[0];
      archiveFile = archive;
      toast(`Opening ${archive.name}…`);
      selected = await DiveDeepZip.extractZipFile(archive, {
        maxArchiveBytes: 550 * 1024 * 1024,
        maxExpandedBytes: 525 * 1024 * 1024,
        maxEntryBytes: 25 * 1024 * 1024,
        maxEntries: 2100,
      });
      sourceLabel = archive.name;
    }
    const files = new Map();
    const aliases = new Map();
    for (const entry of selected) {
      const file = entry.file || entry;
      if (!file || !file.name) continue;
      const path = normalizeResultBundlePath(entry.path || file.webkitRelativePath || file.name);
      if (!path || path.startsWith('__MACOSX/') || path.endsWith('/.DS_Store') || path === '.DS_Store') continue;
      if (files.has(path)) throw new Error(`Duplicate bundle path: ${path}`);
      files.set(path, file);
      const baseName = path.split('/').pop();
      if (!aliases.has(baseName)) aliases.set(baseName, file);
      else if (aliases.get(baseName) !== file) aliases.set(baseName, null);
    }
    state.resultImport = { files, aliases, digests: new Map(), manifest: null, manifestFile: files.get('manifest.json') || aliases.get('manifest.json') || null, archiveFile, batch: null, running: false, uploadProgress: 0, sourceLabel };
    renderResultImport();
    if (state.resultImport.manifestFile) await validateResultBundle();
    else throw new Error('manifest.json was not found in the selected ZIP, folder, or files.');
  }

  async function readDirectoryEntry(entry, prefix = '') {
    if (entry.isFile) return new Promise((resolve, reject) => entry.file((file) => resolve([{ file, path: `${prefix}${file.name}` }]), reject));
    if (!entry.isDirectory) return [];
    const reader = entry.createReader();
    const children = [];
    while (true) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      children.push(...batch);
    }
    const nested = await Promise.all(children.map((child) => readDirectoryEntry(child, `${prefix}${entry.name}/`)));
    return nested.flat();
  }


  async function readDirectoryHandle(handle, prefix = '') {
    const entries = [];
    for await (const [name, child] of handle.entries()) {
      if (child.kind === 'file') entries.push({ file: await child.getFile(), path: `${prefix}${name}` });
      else if (child.kind === 'directory') entries.push(...await readDirectoryHandle(child, `${prefix}${name}/`));
    }
    return entries;
  }

  async function chooseResultFolder() {
    if (typeof window.showDirectoryPicker !== 'function') return $('resultBundleFolder').click();
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      await adoptResultFiles(await readDirectoryHandle(handle), handle.name || 'Selected folder');
    } catch (error) {
      if (error?.name !== 'AbortError') toast(error.message, true);
    }
  }

  async function droppedResultFiles(dataTransfer) {
    const entries = [...(dataTransfer.items || [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) return (await Promise.all(entries.map((entry) => readDirectoryEntry(entry)))).flat();
    return [...(dataTransfer.files || [])].map((file) => ({ file, path: file.name }));
  }

  function updateImportBatchProgressDom(batch) {
    const card = document.querySelector(`[data-import-batch-card="${CSS.escape(batch.id)}"]`);
    if (!card) return;
    const status = card.querySelector('[data-import-batch-status]');
    if (status) status.innerHTML = chip(batch.status);
    const progress = card.querySelector('[data-import-batch-progress]');
    if (progress) {
      const job = batch.job;
      progress.innerHTML = job ? `<div class="fida-job-progress"><div><span>${esc(job.message || title(job.phase))}</span><strong>${job.percent}%</strong></div><div class="fida-import-progress"><i style="--progress:${job.percent}%"></i></div>${job.safeToRefresh ? '<small>Server-side job: safe to close or refresh this page.</small>' : ''}</div>` : '';
    }
  }

  async function refreshImportBatch(batchId) {
    const data = await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/import-batches/${encodeURIComponent(batchId)}/status`);
    const previous = state.resultImport.batch?.id === batchId ? state.resultImport.batch : null;
    const batch = { ...(previous || {}), ...data.batch };
    if (previous?.parts) batch.parts = previous.parts;
    if (previous?.evidence) batch.evidence = previous.evidence;
    state.resultImport.batch = batch;
    const index = (state.selected?.importBatches || []).findIndex((item) => item.id === batchId);
    if (index >= 0) state.selected.importBatches[index] = { ...state.selected.importBatches[index], ...data.batch };
    updateImportBatchProgressDom(batch);
    renderResultImport();
    return batch;
  }

  async function buildResultBundleBlob() {
    if (state.resultImport.archiveFile) return state.resultImport.archiveFile;
    if (!window.DiveDeepZip?.createStoredZipBlob) throw new Error('ZIP packaging support did not load. Refresh and try again.');
    const entries = [];
    for (const [name, file] of state.resultImport.files.entries()) entries.push({ name, data: new Uint8Array(await file.arrayBuffer()) });
    return DiveDeepZip.createStoredZipBlob(entries);
  }

  function uploadImportBundle(blob) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${base}/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/import-batches/upload`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Content-Type', 'application/zip');
      xhr.setRequestHeader('X-Admin-CSRF', state.csrfToken);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        state.resultImport.uploadProgress = Math.min(99, Math.round((event.loaded / event.total) * 100));
        renderResultImport();
      };
      xhr.onerror = () => reject(new Error('Package upload failed before the server accepted it.'));
      xhr.onload = () => {
        const data = (() => { try { return JSON.parse(xhr.responseText || '{}'); } catch { return {}; } })();
        if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.error || `Package upload failed (${xhr.status})`));
        state.resultImport.uploadProgress = 100;
        resolve(data);
      };
      xhr.send(blob);
    });
  }

  function stopImportPolling() {
    if (state.importPollTimer) clearTimeout(state.importPollTimer);
    state.importPollTimer = null;
  }

  function watchImportBatch(batchId) {
    stopImportPolling();
    const tick = async () => {
      if (!state.selectedId || !batchId) return;
      try {
        const batch = await refreshImportBatch(batchId);
        const index = (state.selected?.importBatches || []).findIndex((item) => item.id === batchId);
        if (index >= 0) state.selected.importBatches[index] = batch;
        const active = ['queued','parts','evidence','finalizing'].includes(batch.job?.phase);
        if (active) state.importPollTimer = setTimeout(tick, 1800);
        else {
          stopImportPolling();
          state.detailTab = 'evidence';
          await loadDashboard();
          if (batch.job?.phase === 'complete') toast('Background import complete. Findings are ready for review.');
          else if (batch.job?.phase === 'failed') toast(batch.job.message || 'Background import failed.', true);
        }
      } catch (error) { state.importPollTimer = setTimeout(tick, 3500); }
    };
    state.importPollTimer = setTimeout(tick, 500);
  }

  async function startResultImport() {
    if (state.resultImport.running) return;
    const failedBatch = state.resultImport.batch?.job?.phase === 'failed' && state.resultImport.batch?.job?.bundleUploaded;
    if (failedBatch && !state.resultImport.manifest) return resumeImportJob(state.resultImport.batch.id);
    try {
      state.resultImport.running = true;
      state.resultImport.uploadProgress = 0;
      renderResultImport();
      await validateResultBundle();
      const blob = await buildResultBundleBlob();
      const data = await uploadImportBundle(blob);
      state.resultImport.batch = data.batch;
      state.resultImport.running = false;
      renderResultImport();
      watchImportBatch(data.batch.id);
      toast('Package uploaded. The background importer will continue safely after refresh.');
    } catch (error) { state.resultImport.running = false; renderResultImport(); toast(error.message, true); }
  }

  async function openImportJob(batchId) {
    try {
      const data = await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/import-batches/${encodeURIComponent(batchId)}`);
      state.resultImport = { files: new Map(), aliases: new Map(), digests: new Map(), manifest: null, manifestFile: null, archiveFile: null, batch: data.batch, running: false, uploadProgress: 100, sourceLabel: 'Server-side import job' };
      $('resultImportModal').hidden = false;
      renderResultImport();
      if (['queued','parts','evidence','finalizing'].includes(data.batch.job?.phase)) watchImportBatch(batchId);
    } catch (error) { toast(error.message, true); }
  }

  async function resumeImportJob(batchId) {
    try {
      const data = await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/import-batches/${encodeURIComponent(batchId)}/resume`, { method: 'POST', body: '{}' });
      state.resultImport.batch = data.batch;
      state.resultImport.uploadProgress = 100;
      renderResultImport();
      watchImportBatch(batchId);
      toast('Background import resumed.');
    } catch (error) { toast(error.message, true); }
  }

  async function publishBatchById(batchId) {
    if (!confirm('Publish all approved findings from this batch to the customer dashboard? Staged findings will remain private.')) return;
    try {
      const data = await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/import-batches/${encodeURIComponent(batchId)}/publish`, { method: 'POST', body: '{}' });
      if (state.resultImport.batch?.id === batchId) state.resultImport.batch = data.batch;
      state.detailTab = 'evidence';
      await loadDashboard();
      renderResultImport();
      toast('Approved findings published. Staged and rejected findings remain private.');
    } catch (error) { toast(error.message, true); }
  }

  async function cancelBatchById(batchId) {
    if (!confirm('Cancel this import batch? Unpublished findings and evidence will remain private and become eligible for retention cleanup.')) return;
    try {
      const data = await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/import-batches/${encodeURIComponent(batchId)}/cancel`, { method: 'POST', body: '{}' });
      if (state.resultImport.batch?.id === batchId) state.resultImport.batch = data.batch;
      state.detailTab = 'evidence';
      await loadDashboard();
      renderResultImport();
      toast('Import batch cancelled. Published records were not changed.');
    } catch (error) { toast(error.message, true); }
  }

  async function bulkUpdatePublication(exposureIds, publicationStatus) {
    const ids = [...new Set(exposureIds || [])].filter(Boolean);
    if (!ids.length || state.evidenceReview.busy) return;
    state.evidenceReview.busy = true;
    document.querySelectorAll('[data-publication],[data-bulk-publication],[data-approve-filtered]').forEach((button) => { button.disabled = true; });
    toast(`Updating ${ids.length} finding${ids.length === 1 ? '' : 's'}…`);
    try {
      await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/findings/publication`, {
        method: 'PATCH', body: JSON.stringify({ exposureIds: ids, publicationStatus }),
      });
      const selected = new Set(ids);
      for (const item of state.selected.exposures) {
        if (!selected.has(item.id)) continue;
        item.publicationStatus = publicationStatus;
        if (publicationStatus === 'rejected') item.status = 'false_positive';
      }
      state.evidenceReview.selected.clear();
      state.detailTab = 'evidence';
      renderDetail();
      toast(`${ids.length} finding${ids.length === 1 ? '' : 's'} set to ${title(publicationStatus)}.`);
    } catch (error) { toast(error.message, true); }
    finally { state.evidenceReview.busy = false; }
  }

  async function updatePublication(exposureId, publicationStatus) {
    return bulkUpdatePublication([exposureId], publicationStatus);
  }

  async function loadEvidence(button) {
    try {
      button.disabled = true;
      const response = await fetch(`${base}/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/evidence/${encodeURIComponent(button.dataset.loadEvidence)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Evidence access failed');
      const url = URL.createObjectURL(await response.blob());
      button.innerHTML = `<img src="${url}" alt="Reviewed evidence" />`;
      button.title = 'Reviewed evidence';
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }

  async function importDiveDeepResults(file) {
    if (!state.root || !state.selectedId || !file) return;
    if (file.size > DIVEDEEP_RESULT_PACKET_MAX_BYTES) return toast('Result packet exceeds the 5 MB metadata limit. Evidence files must remain outside the JSON packet.', true);
    try {
      const packet = JSON.parse(await file.text());
      if (packet?.source?.customerId && packet.source.customerId !== state.selectedId) {
        throw new Error('This result packet belongs to a different customer.');
      }
      const data = await api(`/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/divedeep-results`, {
        method: 'POST', body: JSON.stringify(packet),
      });
      state.detailTab = 'evidence';
      await loadDashboard();
      const failed = Number(data.errors?.length) || 0;
      toast(`Imported ${Number(data.imported?.length) || 0} findings${failed ? `; ${failed} need review` : ''}.`, failed > 0);
    } catch (error) { toast(error.message, true); }
    finally { $('divedeepResultsFile').value = ''; }
  }

  async function loadPhoto(button) {
    if (!state.root) return toast('Root authorization is required to reveal reference photos.', true);
    try {
      button.disabled = true;
      const response = await fetch(`${base}/api/divedeep/customers/${encodeURIComponent(state.selectedId)}/photos/${encodeURIComponent(button.dataset.loadPhoto)}`, {
        headers: { 'X-Admin-CSRF': state.csrfToken },
      });
      if (!response.ok) throw new Error('Photo access failed');
      const url = URL.createObjectURL(await response.blob());
      button.innerHTML = `<img src="${url}" alt="Authorized customer reference" />`;
      button.title = 'Authorized reference photo';
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }

  async function loadPackages() {
    try {
      const data = await api('/api/divedeep/packages');
      state.packages = data.packages || [];
      renderPackages();
    } catch (error) { $('packageGrid').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }

  function renderPackages() {
    $('packageGrid').innerHTML = state.packages.map((item) => `<article class="fida-integration-card">
      <header><span class="fida-integration-icon">${item.restricted ? '18+' : '$'}</span>${chip(item.active ? 'active' : 'closed', item.active ? 'Available' : 'Hidden')}</header>
      <form data-package-form="${esc(item.id)}" class="fida-admin-form">
        <label class="fida-field full"><span>Package name</span><input class="fida-input" name="name" maxlength="120" required value="${esc(item.name)}" /></label>
        <label class="fida-field full"><span>Description</span><textarea class="fida-textarea" name="description" maxlength="1000" required>${esc(item.description)}</textarea></label>
        <label class="fida-field"><span>Monthly price (USD)</span><input class="fida-input" name="monthlyPrice" type="number" min="0" step="0.01" required value="${esc(item.monthlyPrice)}" /></label>
        <label class="fida-field"><span>Stripe Price ID</span><input class="fida-input" name="stripePriceId" maxlength="255" placeholder="price_…" value="${esc(item.stripePriceId)}" /></label>
        <label class="fida-check full"><input type="checkbox" name="active" ${item.active ? 'checked' : ''} /> Show this package on new signups</label>
        <button class="fida-btn fida-btn-primary full" type="submit">Save ${esc(item.name)}</button>
      </form>
    </article>`).join('') || '<div class="fida-empty">No packages configured.</div>';
    document.querySelectorAll('[data-package-form]').forEach((form) => form.addEventListener('submit', savePackage));
    const select = $('pilotPackage');
    if (select) select.innerHTML = `<option value="">Any active package</option>${state.packages.filter((item) => item.active).map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}`;
  }

  async function savePackage(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api(`/api/divedeep/packages/${encodeURIComponent(form.dataset.packageForm)}`, {
        method: 'PUT', body: JSON.stringify({
          name: form.elements.name.value, description: form.elements.description.value,
          monthlyPrice: Number(form.elements.monthlyPrice.value), stripePriceId: form.elements.stripePriceId.value,
          active: form.elements.active.checked,
        }),
      });
      await loadPackages();
      toast('Package saved. Future signup pricing has been updated.');
    } catch (error) { toast(error.message, true); }
  }

  async function loadPilotCodes() {
    try {
      if (!state.packages.length) await loadPackages();
      const data = await api('/api/divedeep/pilot-codes');
      state.pilotCodes = data.codes || [];
      renderPilotCodes();
    } catch (error) { $('pilotCodeList').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }

  function renderPilotCodes() {
    $('pilotCodeList').innerHTML = state.pilotCodes.length ? state.pilotCodes.map((item) => `<div class="fida-audit-row"><div><strong>${esc(item.label)}</strong><br><small>${esc(item.codeHint)} · ${item.packageId ? esc(item.packageId) : 'Any package'}</small></div><div>${chip(item.active ? 'active' : 'closed', item.active ? `${item.discountPercent}% off` : 'Disabled')}<br><small>${item.redemptionCount}${item.maxRedemptions == null ? '' : ` / ${item.maxRedemptions}`} redemptions${item.developerTest ? ' · developer test' : ''}</small></div><div><small>Expires ${esc(shortDate(item.expiresAt))}</small><br><button class="fida-btn fida-btn-small ${item.active ? 'fida-btn-danger' : ''}" data-pilot-toggle="${esc(item.id)}" data-active="${item.active ? 'false' : 'true'}">${item.active ? 'Disable' : 'Re-enable'}</button></div></div>`).join('') : '<div class="fida-empty">No pilot codes have been created.</div>';
    document.querySelectorAll('[data-pilot-toggle]').forEach((button) => button.addEventListener('click', () => togglePilotCode(button)));
  }

  async function createPilotCode(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const data = await api('/api/divedeep/pilot-codes', { method: 'POST', body: JSON.stringify({
        label: form.elements.label.value, code: form.elements.code.value, packageId: form.elements.packageId.value,
        discountPercent: Number(form.elements.discountPercent.value), maxRedemptions: form.elements.maxRedemptions.value,
        expiresAt: form.elements.expiresAt.value || null, developerTest: form.elements.developerTest.checked,
      }) });
      form.reset(); form.elements.discountPercent.value = '100'; form.elements.maxRedemptions.value = '1'; form.elements.developerTest.checked = true;
      window.prompt('Copy this pilot code now. It cannot be retrieved later:', data.code);
      await loadPilotCodes();
    } catch (error) { toast(error.message, true); }
  }

  async function togglePilotCode(button) {
    try {
      await api(`/api/divedeep/pilot-codes/${encodeURIComponent(button.dataset.pilotToggle)}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active === 'true' }) });
      await loadPilotCodes();
      toast('Pilot-code status updated.');
    } catch (error) { toast(error.message, true); }
  }


  function operationCard(item, options = {}) {
    const name = item.customer?.displayName || item.displayName || item.customer?.email || item.email || item.id;
    return `<article class="fida-operation-card">
      <header><div><strong>${esc(name || 'Unknown customer')}</strong><small>${esc(item.customer?.email || item.email || item.id || '')}</small></div>${chip(item.status || item.workflowStatus || 'pending')}</header>
      <dl><div><dt>Package</dt><dd>${esc(planLabel(item.packageId || item.planTier || 'standard'))}</dd></div><div><dt>Updated</dt><dd>${esc(shortDate(item.updatedAt || item.requestedAt))}</dd></div></dl>
      ${options.body || ''}
      <footer>${options.actions || ''}</footer>
    </article>`;
  }

  function customerActions(customerId) {
    return `<button class="fida-btn fida-btn-small" data-open-operations-customer="${esc(customerId)}">Open</button><button class="fida-btn fida-btn-small" data-open-privacy-workflow="${esc(customerId)}">Workflow</button><button class="fida-btn fida-btn-small" data-evaluate-customer="${esc(customerId)}">Evaluate gates</button><button class="fida-btn fida-btn-primary fida-btn-small" data-create-customer-job="${esc(customerId)}">Create job</button>`;
  }

  function wireOperationalActions(scope = document) {
    scope.querySelectorAll('[data-open-operations-customer]').forEach((button) => button.addEventListener('click', async () => { showView('overview'); await selectCustomer(button.dataset.openOperationsCustomer); }));
    scope.querySelectorAll('[data-evaluate-customer]').forEach((button) => button.addEventListener('click', () => evaluateCustomerGates(button.dataset.evaluateCustomer)));
    scope.querySelectorAll('[data-open-privacy-workflow]').forEach((button) => button.addEventListener('click', async () => { showView('privacy-workflow'); await openPrivacyWorkflow(button.dataset.openPrivacyWorkflow); }));
    scope.querySelectorAll('[data-create-customer-job]').forEach((button) => button.addEventListener('click', () => createReconJob(button.dataset.createCustomerJob)));
    scope.querySelectorAll('[data-dispatch-job]').forEach((button) => button.addEventListener('click', () => dispatchReconJob(button.dataset.dispatchJob)));
    scope.querySelectorAll('[data-sync-job]').forEach((button) => button.addEventListener('click', () => syncReconJob(button.dataset.syncJob)));
    scope.querySelectorAll('[data-cancel-job]').forEach((button) => button.addEventListener('click', () => cancelReconJob(button.dataset.cancelJob)));
  }

  async function loadCustomersOperations() {
    $('customersOperationsGrid').innerHTML = state.customers.length ? state.customers.map((customer) => operationCard(customer, {
      body: `<p>${esc(customer.profileCount || 0)} profile · ${esc(customer.exposureCount || 0)} findings · ${esc(customer.caseCount || 0)} removal cases</p>`,
      actions: customerActions(customer.id),
    })).join('') : '<div class="fida-empty">No customers found.</div>';
    wireOperationalActions($('customersOperationsGrid'));
  }

  const LANE_LABELS = { needsIntake: 'Needs intake', readyToRun: 'Ready to run', awaitingCapacity: 'Awaiting capacity', running: 'Running', needsReview: 'Needs review', customerValidation: 'Customer validation', evidenceDisposition: 'Evidence disposition', removalApproval: 'Removal approval', delivery: 'Request delivery', monitoring: 'Monitoring', closureReady: 'Ready to close', blocked: 'Blocked or failed' };
  async function loadWorkQueue() {
    try {
      const data = await api('/api/divedeep/work-queue');
      state.workQueue = data.queue || { lanes: {} };
      $('workQueueLanes').innerHTML = Object.entries(LANE_LABELS).map(([key, label]) => {
        const items = state.workQueue.lanes?.[key] || [];
        return `<section class="fida-work-lane"><header><strong>${esc(label)}</strong><span>${items.length}</span></header><div>${items.length ? items.map((item) => operationCard(item, { body: item.currentGate ? `<p>Current gate: ${esc(title(item.currentGate))}</p>` : '', actions: customerActions(item.customerId || item.id) })).join('') : '<p class="fida-empty compact">Nothing waiting.</p>'}</div></section>`;
      }).join('');
      wireOperationalActions($('workQueueLanes'));
    } catch (error) { $('workQueueLanes').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }

  function jobActions(job) {
    const actions = [`<button class="fida-btn fida-btn-small" data-open-operations-customer="${esc(job.customerId)}">Customer</button>`];
    if (state.root && ['ready','awaiting_capacity','failed'].includes(job.status)) actions.push(`<button class="fida-btn fida-btn-primary fida-btn-small" data-dispatch-job="${esc(job.id)}">Dispatch</button>`);
    if (['dispatching','running'].includes(job.status)) actions.push(`<button class="fida-btn fida-btn-small" data-sync-job="${esc(job.id)}">Sync</button>`);
    if (state.root && !['completed','cancelled','expired'].includes(job.status)) actions.push(`<button class="fida-btn fida-btn-danger fida-btn-small" data-cancel-job="${esc(job.id)}">Cancel</button>`);
    return actions.join('');
  }

  function workflowMetric(label, value, helper) {
    return `<article class="fida-metric"><div><small>${esc(label)}</small><strong>${esc(value)}</strong><em>${esc(helper)}</em></div></article>`;
  }

  async function loadPrivacyWorkflows() {
    try {
      const data = await api('/api/divedeep/privacy-workflows?limit=1000');
      state.privacyWorkflows = data.workflows || [];
      const counts = state.privacyWorkflows.reduce((out, item) => { out[item.workflowStatus] = (out[item.workflowStatus] || 0) + 1; return out; }, {});
      $('privacyWorkflowMetrics').innerHTML = [
        workflowMetric('Active cycles', state.privacyWorkflows.filter((item) => ['active','blocked','monitoring'].includes(item.workflowRunStatus)).length, `${state.privacyWorkflows.length} customers tracked`),
        workflowMetric('Human review', state.privacyWorkflows.reduce((sum, item) => sum + Number(item.openReviews || 0), 0), 'Open reviewer tasks'),
        workflowMetric('Customer actions', state.privacyWorkflows.reduce((sum, item) => sum + Number(item.customerActions || 0), 0), 'Validation or guided forms'),
        workflowMetric('Delivery work', state.privacyWorkflows.reduce((sum, item) => sum + Number(item.pendingDeliveries || 0), 0), 'Pending or failed requests'),
        workflowMetric('Monitoring', Number(counts.monitoring || 0), 'Customers under active checks'),
        workflowMetric('Ready to close', Number(counts.closure_ready || 0), 'Requires explicit closure'),
      ].join('');
      $('privacyWorkflowGrid').innerHTML = state.privacyWorkflows.length ? state.privacyWorkflows.map((item) => `<article class="fida-operation-card ${(state.selectedWorkflow?.customerId || state.selectedWorkflow?.run?.customerId) === item.customerId ? 'is-selected fida-workflow-card' : 'fida-workflow-card'}">
        <header><div><strong>${esc(item.displayName || item.email || item.customerId)}</strong><small>${esc(item.email || item.customerId)}</small></div>${chip(item.workflowStatus)}</header>
        <dl><div><dt>Stage</dt><dd>${esc(title(item.stage || item.workflowStatus))}</dd></div><div><dt>Package</dt><dd>${esc(planLabel(item.planTier))}</dd></div><div><dt>Open review</dt><dd>${esc(item.openReviews || 0)}</dd></div><div><dt>Customer actions</dt><dd>${esc(item.customerActions || 0)}</dd></div><div><dt>Delivery</dt><dd>${esc(item.pendingDeliveries || 0)} pending</dd></div><div><dt>Monitoring</dt><dd>${esc(item.activeMonitoring || 0)} active</dd></div></dl>
        <footer><button class="fida-btn fida-btn-primary fida-btn-small" data-inspect-workflow="${esc(item.customerId)}">Inspect gates</button><button class="fida-btn fida-btn-small" data-reconcile-workflow="${esc(item.customerId)}">Reconcile</button></footer>
      </article>`).join('') : '<div class="fida-empty">No customer workflow cycles exist yet.</div>';
      document.querySelectorAll('[data-inspect-workflow]').forEach((button) => button.addEventListener('click', () => openPrivacyWorkflow(button.dataset.inspectWorkflow)));
      document.querySelectorAll('[data-reconcile-workflow]').forEach((button) => button.addEventListener('click', () => reconcilePrivacyWorkflow(button.dataset.reconcileWorkflow)));
      if (state.selectedWorkflow?.customerId || state.selectedWorkflow?.run?.customerId) await openPrivacyWorkflow(state.selectedWorkflow.customerId || state.selectedWorkflow.run.customerId, false);
    } catch (error) { $('privacyWorkflowGrid').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }

  function renderPrivacyWorkflowDetail(workflow) {
    if (!workflow) { $('privacyWorkflowDetail').innerHTML = '<div class="fida-empty">Select a customer workflow.</div>'; return; }
    const run = workflow.run || {};
    const gateRows = (workflow.gates || []).map((gate, index) => `<div class="fida-gate-row" data-status="${esc(gate.status)}"><span class="fida-gate-index">${index + 1}</span><div><h4>${esc(gate.label || title(gate.key))}</h4><p>${esc(gate.summary || '')}</p></div>${chip(gate.status)}</div>`).join('');
    const openTasks = (workflow.reviewTasks || []).filter((task) => ['open','assigned','awaiting_customer'].includes(task.status));
    const actions = (workflow.customerActions || []).filter((item) => ['pending','viewed'].includes(item.status));
    const deliveries = (workflow.deliveries || []).filter((item) => !['completed','cancelled'].includes(item.status));
    const schedules = (workflow.schedules || []).filter((item) => item.status === 'active');
    const customerId = workflow.customerId || run.customerId || '';
    $('privacyWorkflowDetail').innerHTML = `<div class="fida-workflow-summary"><header><div><h3>${esc(title(run.stage || 'not evaluated'))}</h3><p>Current governed stage for this customer service cycle.</p></div>${chip(run.status || 'pending')}</header><div><small>Outcome</small><strong>${esc(title(run.outcome || 'pending'))}</strong></div></div>
      <div class="fida-workflow-counts"><div><small>Review tasks</small><strong>${openTasks.length}</strong></div><div><small>Customer actions</small><strong>${actions.length}</strong></div><div><small>Delivery items</small><strong>${deliveries.length}</strong></div><div><small>Active schedules</small><strong>${schedules.length}</strong></div></div>
      <div class="fida-gate-chain">${gateRows || '<div class="fida-empty compact">Evaluate the workflow to create the gate chain.</div>'}</div>
      ${actions.length ? `<section class="fida-workflow-subqueue"><h4>Customer action required</h4>${actions.map((item) => `<div><span>${esc(item.title || title(item.actionType))}</span>${chip(item.status)}</div>`).join('')}</section>` : ''}
      ${deliveries.length ? `<section class="fida-workflow-subqueue"><h4>Request delivery</h4>${deliveries.map((item) => `<div><span>${esc(title(item.deliveryMethod))} · ${esc(title(item.status))}</span><button class="fida-btn fida-btn-small" data-record-delivery="${esc(item.id)}">Record result</button></div>`).join('')}</section>` : ''}
      ${schedules.length ? `<section class="fida-workflow-subqueue"><h4>Monitoring</h4>${schedules.map((item) => `<div><span>${esc(title(item.monitorType))} · ${esc(title(item.cadence))}</span><button class="fida-btn fida-btn-small" data-record-monitoring="${esc(item.id)}">Record check</button></div>`).join('')}</section>` : ''}
      <div class="fida-workflow-actions"><button class="fida-btn" data-workflow-evaluate="${esc(customerId)}">Evaluate</button><button class="fida-btn" data-workflow-reconcile="${esc(customerId)}">Reconcile tasks</button><button class="fida-btn" data-create-monitoring="${esc(customerId)}">Add monitoring</button>${state.root ? `<button class="fida-btn fida-btn-primary" data-workflow-close="${esc(customerId)}" data-outcome="completed">Close complete</button><button class="fida-btn" data-workflow-close="${esc(customerId)}" data-outcome="continuing_monitoring">Continue monitoring</button>` : ''}</div>
      ${(workflow.events || []).length ? `<details class="fida-workflow-history"><summary>Gate history (${workflow.events.length})</summary>${workflow.events.slice(0, 40).map((event) => `<div><strong>${esc(title(event.gateKey))}</strong><span>${esc(title(event.previousStatus || 'new'))} → ${esc(title(event.newStatus))}</span><small>${esc(date(event.createdAt))}</small></div>`).join('')}</details>` : ''}`;
    document.querySelectorAll('[data-workflow-evaluate]').forEach((button) => button.addEventListener('click', () => evaluateCustomerGates(button.dataset.workflowEvaluate)));
    document.querySelectorAll('[data-workflow-reconcile]').forEach((button) => button.addEventListener('click', () => reconcilePrivacyWorkflow(button.dataset.workflowReconcile)));
    document.querySelectorAll('[data-workflow-close]').forEach((button) => button.addEventListener('click', () => closePrivacyWorkflow(button.dataset.workflowClose, button.dataset.outcome)));
    document.querySelectorAll('[data-record-delivery]').forEach((button) => button.addEventListener('click', () => recordDeliveryAttempt(button.dataset.recordDelivery, customerId)));
    document.querySelectorAll('[data-record-monitoring]').forEach((button) => button.addEventListener('click', () => recordMonitoringCheck(button.dataset.recordMonitoring, customerId)));
    document.querySelectorAll('[data-create-monitoring]').forEach((button) => button.addEventListener('click', () => createMonitoringSchedule(button.dataset.createMonitoring)));
  }

  async function openPrivacyWorkflow(customerId, refreshList = true) {
    try {
      const data = await api(`/api/divedeep/customers/${encodeURIComponent(customerId)}/privacy-workflow`);
      state.selectedWorkflow = data.workflow || null;
      if (state.selectedWorkflow) state.selectedWorkflow.customerId = state.selectedWorkflow.customerId || customerId;
      if (state.selectedWorkflow?.run && !state.selectedWorkflow.run.customerId) state.selectedWorkflow.run.customerId = customerId;
      renderPrivacyWorkflowDetail(state.selectedWorkflow);
      if (refreshList) await loadPrivacyWorkflows();
    } catch (error) { $('privacyWorkflowDetail').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }

  async function reconcilePrivacyWorkflow(customerId) {
    try {
      await api(`/api/divedeep/customers/${encodeURIComponent(customerId)}/privacy-workflow/reconcile`, { method: 'POST', body: '{}' });
      toast('Workflow tasks and gates reconciled.');
      await openPrivacyWorkflow(customerId);
      await loadWorkQueue();
    } catch (error) { toast(error.message, true); }
  }

  async function closePrivacyWorkflow(customerId, outcome) {
    const reason = prompt(outcome === 'continuing_monitoring' ? 'Reason for closing this service cycle while monitoring continues:' : 'Closure reason:');
    if (!reason) return;
    try {
      await api(`/api/divedeep/customers/${encodeURIComponent(customerId)}/privacy-workflow/close`, { method: 'POST', body: JSON.stringify({ outcome, reason }) });
      toast(outcome === 'continuing_monitoring' ? 'Service cycle closed with monitoring active.' : 'Privacy workflow closed.');
      await openPrivacyWorkflow(customerId);
      await loadDashboard();
    } catch (error) { toast(error.message, true); }
  }

  async function loadReconJobs() {
    try {
      const data = await api('/api/divedeep/recon-jobs?limit=500');
      state.reconJobs = data.jobs || [];
      $('reconJobRows').innerHTML = state.reconJobs.length ? state.reconJobs.map((job) => `<tr><td><strong>${esc(job.customer?.displayName || job.customer?.email || job.customerId)}</strong><br><small>${esc(job.customer?.email || '')}</small></td><td>${esc(planLabel(job.packageId))}<br><small>v${esc(job.packageVersion)}</small></td><td>${chip(job.status)}</td><td>${esc(job.workerPoolName || 'Unassigned')}</td><td><div class="fida-inline-progress"><i style="width:${Math.min(100, Math.max(0, Number(job.progressPercent) || 0))}%"></i></div><small>${esc(job.sourceCompletedCount)}/${esc(job.sourceCount)} sources · ${esc(job.candidateCount)} candidates</small></td><td>${esc(date(job.updatedAt))}</td><td><div class="fida-card-actions">${jobActions(job)}</div></td></tr>`).join('') : '<tr><td colspan="7"><div class="fida-empty">No recon jobs have been created.</div></td></tr>';
      wireOperationalActions($('reconJobRows'));
    } catch (error) { $('reconJobRows').innerHTML = `<tr><td colspan="7"><div class="fida-empty">${esc(error.message)}</div></td></tr>`; }
  }

  async function loadWorkerPools() {
    try {
      const [poolData, workerData] = await Promise.all([
        api('/api/divedeep/worker-pools'),
        api('/api/divedeep/workers?limit=200'),
      ]);
      state.workerPools = poolData.pools || [];
      state.workerInstances = workerData.workers || [];
      const runtime = workerData.operations || {};
      const workerCounts = runtime.workers || {};
      const leaseCounts = runtime.leases || {};
      const sourceCounts = runtime.sourceAttempts || {};
      const candidateCounts = runtime.candidates || {};
      if ($('workerRuntimeMetrics')) {
        $('workerRuntimeMetrics').innerHTML = [
          ['Active workers', workerCounts.active || 0, `${workerCounts.total || 0} registered`],
          ['Active leases', leaseCounts.active || 0, `${leaseCounts.expired || 0} expired`],
          ['Source attempts', sourceCounts.total || 0, `${sourceCounts.exceptions || 0} exceptions`],
          ['Review candidates', candidateCounts.reviewRequired || 0, `${candidateCounts.total || 0} received`],
        ].map(([label, value, helper]) => `<article class="fida-metric"><div><small>${esc(label)}</small><strong>${esc(value)}</strong><em>${esc(helper)}</em></div></article>`).join('');
      }
      $('workerPoolGrid').innerHTML = state.workerPools.length ? state.workerPools.map((pool) => {
        const current = pool.versions?.find((item) => item.version === pool.currentVersion) || pool.versions?.[0] || null;
        const config = current?.providerConfig || {};
        return `<article class="fida-catalog-card"><header><div><h3>${esc(pool.name)}</h3><p>${esc(pool.description || 'Disposable DiveDeep execution capacity.')}</p></div>${chip(pool.status)}</header><dl class="fida-catalog-facts"><div><dt>Provider</dt><dd>Cloud Run Jobs</dd></div><div><dt>Version</dt><dd>${current ? `v${esc(current.version)} · ${esc(title(current.status))}` : 'Not configured'}</dd></div><div><dt>Location</dt><dd>${esc(config.projectId || '—')} / ${esc(config.region || '—')}</dd></div><div><dt>Job</dt><dd>${esc(config.jobName || '—')}</dd></div><div><dt>Worker</dt><dd>${esc(config.workerVersion || '—')} · protocol ${esc(config.workerProtocolVersion || 1)}</dd></div><div><dt>Dispatch</dt><dd>${config.dispatchEnabled ? 'Enabled' : 'Disabled'}</dd></div><div><dt>Capacity</dt><dd>${esc(pool.capacity?.active || 0)} active / ${esc(pool.capacity?.maximum || current?.limits?.maximumConcurrentExecutions || 1)} max</dd></div><div><dt>Max runtime</dt><dd>${esc(current?.limits?.maximumJobSeconds || config.taskTimeoutSeconds || 0)} sec</dd></div></dl><footer><button class="fida-btn fida-btn-small" data-add-pool-version="${esc(pool.id)}">New version</button>${current?.status === 'draft' ? `<button class="fida-btn fida-btn-primary fida-btn-small" data-publish-pool-version="${esc(current.id)}">Publish</button>` : ''}</footer></article>`;
      }).join('') : '<div class="fida-empty">No worker pools configured.</div>';
      $('workerInstanceGrid').innerHTML = state.workerInstances.length ? state.workerInstances.map((worker) => `<article class="fida-operation-card"><header><div><strong>${esc(worker.poolName || 'DiveDeep worker')}</strong><small>${esc(worker.id)}</small></div>${chip(worker.status)}</header><p>Job ${esc(worker.reconJobId)} · ${esc(title(worker.jobStatus || 'unknown'))}</p><dl><div><dt>Lease</dt><dd>${esc(title(worker.leaseStatus || 'none'))}</dd></div><div><dt>Lease expires</dt><dd>${esc(date(worker.leaseExpiresAt))}</dd></div><div><dt>Heartbeat</dt><dd>${esc(date(worker.heartbeatAt))}</dd></div><div><dt>Cleanup</dt><dd>${worker.cleanupAckAt ? `Confirmed ${esc(date(worker.cleanupAckAt))}` : 'Pending'}</dd></div></dl><footer><button class="fida-btn fida-btn-small" data-open-recon-job="${esc(worker.reconJobId)}">Open job</button></footer></article>`).join('') : '<div class="fida-empty">No ephemeral workers have registered.</div>';
      document.querySelectorAll('[data-add-pool-version]').forEach((button) => button.addEventListener('click', () => openWorkerPoolModal(button.dataset.addPoolVersion)));
      document.querySelectorAll('[data-publish-pool-version]').forEach((button) => button.addEventListener('click', () => publishWorkerPoolVersion(button.dataset.publishPoolVersion)));
      document.querySelectorAll('[data-open-recon-job]').forEach((button) => button.addEventListener('click', () => { showView('recon-jobs'); loadReconJobs(); }));
    } catch (error) {
      $('workerPoolGrid').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`;
      if ($('workerInstanceGrid')) $('workerInstanceGrid').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`;
    }
  }

  async function runWorkerLeaseSweep() {
    if (!confirm('Recover worker leases that have expired without a heartbeat?')) return;
    try {
      const data = await api('/api/divedeep/workers/lease-sweep', { method: 'POST', body: JSON.stringify({ limit: 100 }) });
      await loadWorkerPools();
      toast(`Recovered ${data.result?.recovered || 0} expired worker lease(s).`);
    } catch (error) { toast(error.message, true); }
  }

  function openWorkerPoolModal(poolId = '') {
    const form = $('workerPoolForm');
    form.reset();
    form.elements.mode.value = poolId ? 'version' : 'pool';
    form.elements.poolId.value = poolId;
    form.elements.versionId.value = '';
    const pool = state.workerPools.find((item) => item.id === poolId);
    if (pool) {
      form.elements.name.value = pool.name;
      form.elements.slug.value = pool.slug;
      form.elements.description.value = pool.description || '';
      form.elements.name.disabled = true;
      form.elements.slug.disabled = true;
      const current = pool.versions?.find((item) => item.version === pool.currentVersion) || pool.versions?.[0] || null;
      const config = current?.providerConfig || {};
      form.elements.projectId.value = config.projectId || '';
      form.elements.region.value = config.region || 'us-east1';
      form.elements.jobName.value = config.jobName || 'divedeep-divedeep';
      form.elements.workerVersion.value = config.workerVersion || '5.29.0';
      form.elements.workerProtocolVersion.value = config.workerProtocolVersion || 1;
      form.elements.taskTimeoutSeconds.value = current?.limits?.maximumJobSeconds || config.taskTimeoutSeconds || 1800;
      form.elements.maxRetries.value = config.maxRetries ?? 0;
      form.elements.maximumConcurrentExecutions.value = current?.limits?.maximumConcurrentExecutions || 2;
      form.elements.imageAnalysis.checked = current?.capabilities?.imageAnalysis !== false;
      form.elements.sensitiveSources.checked = current?.capabilities?.sensitiveSources !== false;
      form.elements.dispatchEnabled.checked = Boolean(config.dispatchEnabled);
    } else {
      form.elements.name.disabled = false;
      form.elements.slug.disabled = false;
    }
    $('workerPoolModalTitle').textContent = pool ? `New ${pool.name} version` : 'Configure worker pool';
    $('workerPoolModal').hidden = false;
  }

  async function saveWorkerPool(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      providerConfig: { projectId: form.elements.projectId.value, region: form.elements.region.value, jobName: form.elements.jobName.value, workerVersion: form.elements.workerVersion.value, workerProtocolVersion: 1, taskTimeoutSeconds: Number(form.elements.taskTimeoutSeconds.value), maxRetries: Number(form.elements.maxRetries.value), dispatchEnabled: form.elements.dispatchEnabled.checked },
      capabilities: { imageAnalysis: form.elements.imageAnalysis.checked, sensitiveSources: form.elements.sensitiveSources.checked, browserAutomation: true },
      limits: { maximumConcurrentExecutions: Number(form.elements.maximumConcurrentExecutions.value), maximumJobSeconds: Number(form.elements.taskTimeoutSeconds.value), maximumTemporaryStorageMb: 4096 },
    };
    try {
      let poolId = form.elements.poolId.value;
      if (form.elements.mode.value === 'pool') {
        const created = await api('/api/divedeep/worker-pools', { method: 'POST', body: JSON.stringify({ name: form.elements.name.value, slug: form.elements.slug.value, description: form.elements.description.value, provider: 'google_cloud_run_jobs', isDefault: !state.workerPools.length }) });
        poolId = created.pool.id;
      }
      const result = await api(`/api/divedeep/worker-pools/${encodeURIComponent(poolId)}/versions`, { method: 'POST', body: JSON.stringify(payload) });
      if (form.elements.publish.checked) await api(`/api/divedeep/worker-pool-versions/${encodeURIComponent(result.version.id)}/publish`, { method: 'POST', body: '{}' });
      $('workerPoolModal').hidden = true;
      await loadWorkerPools();
      toast('Worker-pool version saved.');
    } catch (error) { toast(error.message, true); }
  }

  async function publishWorkerPoolVersion(versionId) {
    if (!confirm('Publish this immutable Cloud Run worker-pool version?')) return;
    try { await api(`/api/divedeep/worker-pool-versions/${encodeURIComponent(versionId)}/publish`, { method: 'POST', body: '{}' }); await loadWorkerPools(); toast('Worker-pool version published.'); }
    catch (error) { toast(error.message, true); }
  }

  async function loadReviewQueues() {
    try {
      const data = await api('/api/divedeep/review-queue');
      state.reviewQueue = data.queue || { findings: [], imageItems: [], workerCandidates: [] };
      const classicFindings = state.reviewQueue.findings || [];
      const workerCandidates = state.reviewQueue.workerCandidates || [];
      const findingCards = [
        ...workerCandidates.map((item) => operationCard({ ...item, displayName: `${title(item.candidateType || 'Recon')} candidate` }, { body: `<p>${esc(title(item.reviewBand || 'manual review'))} · ${item.confidence == null ? 'confidence pending' : `${Math.round(item.confidence)}% confidence`} · ${esc(title(item.sensitivity || 'standard'))}</p><small>Job ${esc(item.reconJobId)}${item.sourceKey ? ` · ${esc(item.sourceKey)}` : ''}</small>`, actions: `<button class="fida-btn fida-btn-small" data-open-operations-customer="${esc(item.customerId)}">Open customer</button>` })),
        ...classicFindings.map((item) => operationCard({ ...item, displayName: `Finding ${item.id}` }, { body: `<p>${esc(title(item.category || 'unknown'))} · ${item.confidence == null ? 'confidence pending' : `${Math.round(item.confidence * 100)}% confidence`}</p>`, actions: `<button class="fida-btn fida-btn-small" data-open-operations-customer="${esc(item.customerId)}">Open customer</button>` })),
      ];
      $('findingReviewGrid').innerHTML = findingCards.length ? findingCards.join('') : '<div class="fida-empty">No findings require review.</div>';
      $('evidenceReviewGrid').innerHTML = state.reviewQueue.imageItems.length ? state.reviewQueue.imageItems.map((item) => `<article class="fida-operation-card fida-evidence-operation"><header><div><strong>Protected candidate</strong><small>${esc(title(item.reviewBand || item.state))}</small></div>${chip(item.state)}</header><div class="fida-blurred-preview" aria-label="Blurred candidate preview"><span></span><b>Protected until reviewed</b></div><p>${item.reviewConfidence == null ? 'Reviewer confidence not recorded.' : `Reviewer confidence ${Math.round(item.reviewConfidence * 100)}%.`} ${item.customerDisposition === 'pending' ? 'Customer validation may be requested.' : ''}</p><footer><button class="fida-btn fida-btn-small" data-open-operations-customer="${esc(item.customerId)}">Open customer</button><button class="fida-btn fida-btn-small" data-image-disposition="request_customer_validation" data-image-item="${esc(item.id)}">Ask customer</button><button class="fida-btn fida-btn-success fida-btn-small" data-image-disposition="confirm" data-image-item="${esc(item.id)}">Confirm</button><button class="fida-btn fida-btn-danger fida-btn-small" data-image-disposition="reject" data-image-item="${esc(item.id)}">Not a match</button></footer></article>`).join('') : '<div class="fida-empty">No image candidates require review.</div>';
      wireOperationalActions($('findingReviewGrid'));
      wireOperationalActions($('evidenceReviewGrid'));
      document.querySelectorAll('[data-image-disposition]').forEach((button) => button.addEventListener('click', () => dispositionImageItem(button.dataset.imageItem, button.dataset.imageDisposition)));
    } catch (error) { $('findingReviewGrid').innerHTML = $('evidenceReviewGrid').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }

  async function dispositionImageItem(itemId, action) {
    let note = '';
    let reviewConfidence;
    if (action === 'request_customer_validation') {
      const confidence = prompt('Reviewer confidence from 0 to 100:', '80');
      if (confidence == null) return;
      reviewConfidence = Number(confidence);
      if (!Number.isFinite(reviewConfidence) || reviewConfidence < 0 || reviewConfidence > 100) return toast('Reviewer confidence must be between 0 and 100.', true);
      note = prompt('Reviewer note for the customer validation request:', 'Please confirm whether this image is you.');
      if (note == null) return;
    }
    try { await api(`/api/divedeep/image-analysis/items/${encodeURIComponent(itemId)}/disposition`, { method: 'POST', body: JSON.stringify({ action, reviewConfidence, note: note || undefined }) }); await loadReviewQueues(); toast('Image disposition recorded.'); }
    catch (error) { toast(error.message, true); }
  }

  async function loadRetentionQueue() {
    try {
      const data = await api('/api/divedeep/retention-queue');
      state.retentionQueue = data.queue || { artifacts: [], counts: {} };
      const counts = state.retentionQueue.counts || {};
      if ($('retentionMetrics')) {
        $('retentionMetrics').innerHTML = [
          ['Deletion due', counts.due || 0],
          ['Due within 24 hours', counts.next24Hours || 0],
          ['Pending review', counts.pendingReview || 0],
          ['Retention holds', counts.held || 0],
          ['Failed or quarantined', counts.failed || 0],
        ].map(([label, value]) => `<article class="fida-metric"><div><small>${esc(label)}</small><strong>${esc(value)}</strong></div></article>`).join('');
      }
      const items = state.retentionQueue.artifacts || [];
      $('retentionGrid').innerHTML = items.length ? items.map((item) => `<article class="fida-operation-card"><header><div><strong>${esc(title(item.artifactType || 'artifact'))}</strong><small>${esc(item.id)}</small></div>${chip(item.legalHold ? 'hold' : item.bucket)}</header><p>${esc(title(item.retentionClass || 'retention scheduled'))} · ${esc(title(item.status))}</p><dl><div><dt>Expires</dt><dd>${esc(date(item.expiresAt))}</dd></div><div><dt>Customer</dt><dd>${esc(item.customerId || '—')}</dd></div><div><dt>Review</dt><dd>${esc(title(item.reviewStatus || 'not required'))}</dd></div><div><dt>Size</dt><dd>${esc(item.actualByteSize || item.expectedByteSize || 0)} bytes</dd></div></dl><footer>${item.customerId ? `<button class="fida-btn fida-btn-small" data-open-operations-customer="${esc(item.customerId)}">Open customer</button>` : ''}<button class="fida-btn fida-btn-small" data-artifact-access="${esc(item.id)}">Open protected file</button>${item.legalHold ? `<button class="fida-btn fida-btn-small root-only" data-release-artifact-hold="${esc(item.id)}">Release hold</button>` : `<button class="fida-btn fida-btn-small root-only" data-hold-artifact="${esc(item.id)}">Hold</button>`}<button class="fida-btn fida-btn-small root-only" data-extend-artifact="${esc(item.id)}">Extend</button><button class="fida-btn fida-btn-danger fida-btn-small root-only" data-delete-artifact="${esc(item.id)}">Delete</button></footer></article>`).join('') : '<div class="fida-empty">No artifact retention deadlines are currently scheduled.</div>';
      wireOperationalActions($('retentionGrid'));
      document.querySelectorAll('[data-artifact-access]').forEach((button) => button.addEventListener('click', () => openArtifact(button.dataset.artifactAccess)));
      document.querySelectorAll('[data-hold-artifact]').forEach((button) => button.addEventListener('click', () => changeArtifactHold(button.dataset.holdArtifact, true)));
      document.querySelectorAll('[data-release-artifact-hold]').forEach((button) => button.addEventListener('click', () => changeArtifactHold(button.dataset.releaseArtifactHold, false)));
      document.querySelectorAll('[data-extend-artifact]').forEach((button) => button.addEventListener('click', () => extendArtifact(button.dataset.extendArtifact)));
      document.querySelectorAll('[data-delete-artifact]').forEach((button) => button.addEventListener('click', () => deleteArtifact(button.dataset.deleteArtifact)));
    } catch (error) { $('retentionGrid').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }

  async function openArtifact(artifactId) {
    try {
      const data = await api(`/api/divedeep/artifacts/${encodeURIComponent(artifactId)}/access`, { method: 'POST', body: JSON.stringify({ purpose: 'admin_review' }) });
      window.open(data.grant.url, '_blank', 'noopener,noreferrer');
    } catch (error) { toast(error.message, true); }
  }

  async function changeArtifactHold(artifactId, hold) {
    const reason = prompt(hold ? 'Reason for placing this artifact on retention hold:' : 'Reason for releasing this retention hold:');
    if (!reason) return;
    try {
      await api(`/api/divedeep/artifacts/${encodeURIComponent(artifactId)}/hold`, { method: hold ? 'POST' : 'DELETE', body: JSON.stringify({ reason }) });
      await loadRetentionQueue();
      toast(hold ? 'Retention hold applied.' : 'Retention hold released.');
    } catch (error) { toast(error.message, true); }
  }

  async function extendArtifact(artifactId) {
    const days = prompt('Extend retention by how many days?', '30');
    if (days == null) return;
    const reason = prompt('Reason for retention extension:');
    if (!reason) return;
    try {
      await api(`/api/divedeep/artifacts/${encodeURIComponent(artifactId)}/retention/extend`, { method: 'POST', body: JSON.stringify({ days: Number(days), reason }) });
      await loadRetentionQueue();
      toast('Retention deadline extended.');
    } catch (error) { toast(error.message, true); }
  }

  async function deleteArtifact(artifactId) {
    if (!confirm('Mark this protected artifact for deletion now?')) return;
    const reason = prompt('Reason for immediate deletion:', 'No longer required');
    if (!reason) return;
    try {
      await api(`/api/divedeep/artifacts/${encodeURIComponent(artifactId)}/disposition`, { method: 'POST', body: JSON.stringify({ action: 'delete_now', reason }) });
      await api('/api/divedeep/retention/run', { method: 'POST', body: JSON.stringify({ limit: 100 }) });
      await loadRetentionQueue();
      toast('Artifact deletion processed.');
    } catch (error) { toast(error.message, true); }
  }

  async function runRetentionSweep() {
    if (!confirm('Run the due artifact deletion queue now?')) return;
    try {
      const data = await api('/api/divedeep/retention/run', { method: 'POST', body: JSON.stringify({ limit: 250 }) });
      await loadRetentionQueue();
      toast(`Retention sweep complete: ${data.result?.deleted || 0} deleted, ${data.result?.failed || 0} failed.`);
    } catch (error) { toast(error.message, true); }
  }

  async function loadMonitoringQueue() {
    try {
      const [queueData, scheduleData] = await Promise.all([
        api('/api/divedeep/monitoring-queue'),
        api('/api/divedeep/monitoring-schedules?limit=500'),
      ]);
      state.monitoringQueue = queueData.queue || [];
      const schedules = scheduleData.schedules || [];
      const dueCards = state.monitoringQueue.map((item) => operationCard({ ...item, displayName: `Case ${item.caseId}`, status: item.exposureStatus || item.state }, { body: `<p>${esc(title(item.deliveryMethod || 'monitoring'))}${item.deadlineAt ? ` · next deadline ${esc(date(item.deadlineAt))}` : ''}</p>`, actions: `<button class="fida-btn fida-btn-small" data-open-operations-customer="${esc(item.customerId)}">Open customer</button><button class="fida-btn fida-btn-small" data-create-monitoring="${esc(item.customerId)}">Schedule check</button>` }));
      const scheduleCards = schedules.map((item) => operationCard({ ...item, displayName: title(item.monitorType), status: item.status }, { body: `<p>${esc(title(item.cadence))}${item.nextRunAt ? ` · next ${esc(date(item.nextRunAt))}` : ''}</p>`, actions: `<button class="fida-btn fida-btn-small" data-open-operations-customer="${esc(item.customerId)}">Open customer</button>${['active','draft','failed'].includes(item.status) ? `<button class="fida-btn fida-btn-primary fida-btn-small" data-record-monitoring="${esc(item.id)}">Record check</button>` : ''}` }));
      $('monitoringGrid').innerHTML = [...dueCards, ...scheduleCards].join('') || '<div class="fida-empty">No monitoring checks are due or scheduled.</div>';
      wireOperationalActions($('monitoringGrid'));
      document.querySelectorAll('[data-create-monitoring]').forEach((button) => button.addEventListener('click', () => createMonitoringSchedule(button.dataset.createMonitoring)));
      document.querySelectorAll('[data-record-monitoring]').forEach((button) => button.addEventListener('click', () => recordMonitoringCheck(button.dataset.recordMonitoring)));
    } catch (error) { $('monitoringGrid').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }


  async function loadCaseQueue() {
    try {
      const data = await api('/api/divedeep/case-queue');
      state.caseQueue = data.cases || [];
      $('caseOperationsGrid').innerHTML = state.caseQueue.length ? state.caseQueue.map((item) => operationCard({ ...item, displayName: item.customer?.displayName || `Case ${item.id}`, email: item.customer?.email, status: item.state }, { body: `<p>${esc(title(item.requestType))} · ${esc(title(item.deliveryMethod))}${item.responseDueAt ? ` · due ${esc(date(item.responseDueAt))}` : ''}</p>`, actions: `<button class="fida-btn fida-btn-small" data-open-operations-customer="${esc(item.customerId)}">Open customer</button>${['approved','queued','needs_action','failed'].includes(item.state) ? `<button class="fida-btn fida-btn-primary fida-btn-small" data-create-delivery="${esc(item.id)}" data-customer-id="${esc(item.customerId)}" data-method="${esc(item.deliveryMethod || 'email')}">Prepare delivery</button>` : ''}` })).join('') : '<div class="fida-empty">No removal cases have been prepared.</div>';
      wireOperationalActions($('caseOperationsGrid'));
      document.querySelectorAll('[data-create-delivery]').forEach((button) => button.addEventListener('click', () => createCaseDelivery(button.dataset.createDelivery, button.dataset.customerId, button.dataset.method)));
    } catch (error) { $('caseOperationsGrid').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }

  function renderWorkflowGatesPane() {
    const gates = state.selected.workflowGates || [];
    return `<div class="fida-gate-list">${gates.length ? gates.map((gate) => `<article class="fida-gate ${esc(gate.status)}"><span>${gate.status === 'pass' || gate.status === 'waived' ? '✓' : '!'}</span><div><strong>${esc(gate.label)}</strong><p>${esc(gate.summary)}</p></div>${chip(gate.status)}</article>`).join('') : '<div class="fida-empty">Workflow gates have not been evaluated yet.</div>'}</div><button class="fida-btn fida-btn-primary" data-evaluate-gates>Evaluate workflow gates</button>`;
  }

  function renderCustomerReconPane() {
    const jobs = state.selected.reconJobs || [];
    return `${jobs.length ? jobs.map((job) => `<article class="fida-case"><header><div><h4>${esc(planLabel(job.packageId))} · v${esc(job.packageVersion)}</h4><p>${esc(job.workerPoolName || 'Unassigned pool')} · ${esc(date(job.updatedAt))}</p></div>${chip(job.status)}</header><div class="fida-inline-progress"><i style="width:${Math.min(100, Math.max(0, Number(job.progressPercent) || 0))}%"></i></div><p>${esc(job.sourceCompletedCount)}/${esc(job.sourceCount)} sources · ${esc(job.candidateCount)} candidates</p><div class="fida-card-actions">${jobActions(job)}</div></article>`).join('') : '<div class="fida-empty">No recon jobs have been created for this customer.</div>'}<button class="fida-btn fida-btn-primary" data-create-recon-job>Create authorized recon job</button>`;
  }

  async function createCaseDelivery(caseId, customerId, defaultMethod = 'email') {
    const method = prompt('Delivery method: email, customer_form, api, browser, or guidance', defaultMethod || 'email');
    if (!method) return;
    const provider = prompt('Provider or channel name (optional):', '') || '';
    const body = { deliveryMethod: method.trim(), provider: provider.trim() || undefined };
    if (method.trim() === 'customer_form') body.customerInstructions = prompt('Customer instructions:', 'Complete the required removal form so we can continue.') || undefined;
    try {
      await api(`/api/divedeep/cases/${encodeURIComponent(caseId)}/deliveries`, { method: 'POST', body: JSON.stringify(body) });
      toast('Request delivery prepared.');
      await loadCaseQueue();
      if (customerId) await openPrivacyWorkflow(customerId, false);
    } catch (error) { toast(error.message, true); }
  }

  async function recordDeliveryAttempt(deliveryId, customerId = null) {
    const status = prompt('Delivery result: sending, sent, acknowledged, customer_action, completed, or failed', 'sent');
    if (!status) return;
    const payload = { status: status.trim() };
    if (payload.status === 'failed') payload.errorMessage = prompt('Failure reason:', '') || 'Delivery failed';
    if (payload.status === 'customer_action') payload.customerInstructions = prompt('Customer action instructions:', 'Complete the required removal form.') || undefined;
    const reference = prompt('Confirmation or provider reference (optional):', '') || '';
    if (reference) payload.confirmationReference = reference;
    try {
      await api(`/api/divedeep/request-deliveries/${encodeURIComponent(deliveryId)}/attempts`, { method: 'POST', body: JSON.stringify(payload) });
      toast('Delivery result recorded.');
      if (customerId) await openPrivacyWorkflow(customerId, false);
      await loadCaseQueue();
    } catch (error) { toast(error.message, true); }
  }

  async function createMonitoringSchedule(customerId) {
    if (!customerId) return;
    const monitorType = prompt('Monitoring type: removal_verification, reappearance_check, known_url, package_rescan, sensitive_image_recheck, or response_deadline', 'removal_verification');
    if (!monitorType) return;
    const cadence = prompt('Cadence: once, daily, weekly, monthly, or quarterly', 'once');
    if (!cadence) return;
    try {
      await api(`/api/divedeep/customers/${encodeURIComponent(customerId)}/monitoring-schedules`, { method: 'POST', body: JSON.stringify({ monitorType: monitorType.trim(), cadence: cadence.trim(), activate: true }) });
      toast('Monitoring schedule created.');
      await loadMonitoringQueue();
      if (state.selectedWorkflow?.customerId === customerId) await openPrivacyWorkflow(customerId, false);
    } catch (error) { toast(error.message, true); }
  }

  async function recordMonitoringCheck(scheduleId, customerId = null) {
    const result = prompt('Check result: removed, still_present, changed, reappeared, unreachable, blocked, or needs_review', 'still_present');
    if (!result) return;
    const notes = prompt('Review note (optional):', '') || '';
    try {
      await api(`/api/divedeep/monitoring-schedules/${encodeURIComponent(scheduleId)}/checks`, { method: 'POST', body: JSON.stringify({ result: result.trim(), notes: notes || undefined }) });
      toast('Monitoring result recorded.');
      await loadMonitoringQueue();
      if (customerId) await openPrivacyWorkflow(customerId, false);
    } catch (error) { toast(error.message, true); }
  }

  async function evaluateCustomerGates(customerId = state.selectedId) {
    if (!customerId) return;
    try { await api(`/api/divedeep/customers/${encodeURIComponent(customerId)}/workflow-gates/evaluate`, { method: 'POST', body: '{}' }); await loadDashboard(); if (state.selectedId === customerId) await selectCustomer(customerId); toast('Workflow gates evaluated.'); }
    catch (error) { toast(error.message, true); }
  }

  async function createReconJob(customerId = state.selectedId) {
    if (!customerId) return;
    try { const data = await api(`/api/divedeep/customers/${encodeURIComponent(customerId)}/recon-jobs`, { method: 'POST', body: '{}' }); toast(data.job.status === 'blocked' ? 'Recon job created but remains blocked by workflow gates.' : 'Authorized recon job created.', data.job.status === 'blocked'); await loadDashboard(); await loadReconJobs(); if (state.selectedId === customerId) await selectCustomer(customerId); }
    catch (error) { toast(error.message, true); }
  }

  async function dispatchReconJob(jobId) {
    if (!confirm('Start one Cloud Run Job execution for this authorized recon job?')) return;
    try { await api(`/api/divedeep/recon-jobs/${encodeURIComponent(jobId)}/dispatch`, { method: 'POST', body: '{}' }); await loadReconJobs(); await loadDashboard(); toast('Cloud Run Job dispatch accepted.'); }
    catch (error) { toast(error.message, true); }
  }

  async function syncReconJob(jobId) {
    try { await api(`/api/divedeep/recon-jobs/${encodeURIComponent(jobId)}/sync`, { method: 'POST', body: '{}' }); await loadReconJobs(); await loadDashboard(); toast('Recon job synchronized.'); }
    catch (error) { toast(error.message, true); }
  }

  async function cancelReconJob(jobId) {
    if (!confirm('Cancel this recon job in DiveDeep? Provider cancellation is deferred until the worker protocol is enabled.')) return;
    try { await api(`/api/divedeep/recon-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: '{}' }); await loadReconJobs(); await loadDashboard(); toast('Recon job cancelled.'); }
    catch (error) { toast(error.message, true); }
  }
  function showView(view) {
    if ((view === 'catalog' || view === 'integrations' || view === 'audit' || view === 'packages' || view === 'pilot-codes' || view === 'worker-pools') && !state.root) return;
    document.querySelectorAll('.fida-view').forEach((element) => element.classList.remove('active'));
    document.querySelectorAll('.fida-nav-item[data-view]').forEach((element) => element.classList.toggle('active', element.dataset.view === view));
    const handlers = {
      overview: () => { $('overviewView').classList.add('active'); renderQueueTabs(); renderQueue(); },
      customers: () => { $('customersView').classList.add('active'); loadCustomersOperations(); },
      'work-queue': () => { $('workQueueView').classList.add('active'); loadWorkQueue(); },
      'privacy-workflow': () => { $('privacyWorkflowView').classList.add('active'); loadPrivacyWorkflows(); },
      'recon-jobs': () => { $('reconJobsView').classList.add('active'); loadReconJobs(); },
      'worker-pools': () => { $('workerPoolsView').classList.add('active'); loadWorkerPools(); },
      findings: () => { $('findingsView').classList.add('active'); loadReviewQueues(); },
      evidence: () => { $('evidenceView').classList.add('active'); loadReviewQueues(); },
      cases: () => { $('casesView').classList.add('active'); loadCaseQueue(); },
      monitoring: () => { $('monitoringView').classList.add('active'); loadMonitoringQueue(); },
      retention: () => { $('retentionView').classList.add('active'); loadRetentionQueue(); },
      catalog: () => { $('catalogView').classList.add('active'); loadCatalog(); },
      integrations: () => { $('integrationsView').classList.add('active'); loadIntegrations(); },
      packages: () => { $('packagesView').classList.add('active'); loadPackages(); },
      'pilot-codes': () => { $('pilotCodesView').classList.add('active'); loadPilotCodes(); },
      audit: () => { $('auditView').classList.add('active'); loadIntegrationAudit(); },
    };
    (handlers[view] || handlers.overview)();
    document.body.classList.remove('fida-menu-open');
  }

  function catalogJson(value) { return JSON.stringify(value == null ? {} : value, null, 2); }
  function catalogParse(value, label) {
    const text = String(value || '').trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch { throw new Error(`${label} must be a JSON object.`); }
  }
  function catalogField(name, label, value = '', options = {}) {
    const wide = options.wide ? ' full' : '';
    if (options.type === 'textarea') return `<label class="fida-field${wide}"><span>${esc(label)}</span><textarea class="fida-textarea" name="${esc(name)}" rows="${options.rows || 5}" ${options.required ? 'required' : ''}>${esc(value)}</textarea>${options.help ? `<small>${esc(options.help)}</small>` : ''}</label>`;
    if (options.type === 'select') return `<label class="fida-field${wide}"><span>${esc(label)}</span><select class="fida-select" name="${esc(name)}">${(options.options || []).map((item) => { const option = typeof item === 'string' ? { value: item, label: title(item) } : item; return `<option value="${esc(option.value)}" ${String(option.value) === String(value) ? 'selected' : ''}>${esc(option.label)}</option>`; }).join('')}</select></label>`;
    if (options.type === 'checkbox') return `<label class="fida-check${wide}"><input type="checkbox" name="${esc(name)}" ${value ? 'checked' : ''}/> ${esc(label)}</label>`;
    return `<label class="fida-field${wide}"><span>${esc(label)}</span><input class="fida-input" name="${esc(name)}" type="${options.type || 'text'}" value="${esc(value)}" ${options.required ? 'required' : ''} ${options.placeholder ? `placeholder="${esc(options.placeholder)}"` : ''}/>${options.help ? `<small>${esc(options.help)}</small>` : ''}</label>`;
  }
  function catalogChecklist(name, label, items, selected = new Set(), formatter = null) {
    return `<fieldset class="fida-catalog-checkset full"><legend>${esc(label)}</legend><div class="fida-catalog-checklist">${items.length ? items.map((item) => `<label class="fida-catalog-check"><input type="checkbox" name="${esc(name)}" value="${esc(item.id)}" ${selected.has(item.id) ? 'checked' : ''}/><span><strong>${esc(formatter ? formatter(item).title : item.name)}</strong><small>${esc(formatter ? formatter(item).note : (item.primaryDomain || item.slug || item.id))}</small></span></label>`).join('') : '<div class="fida-empty">No eligible items exist yet.</div>'}</div></fieldset>`;
  }
  function publishedPoolVersions() {
    return state.catalog.pools.flatMap((pool) => (pool.versions || []).filter((version) => version.status === 'published').map((version) => ({ ...version, id: version.id, poolName: pool.name, poolSlug: pool.slug, namespace: pool.namespace })));
  }
  function publishedSourceSetVersions() {
    return state.catalog.sourceSets.flatMap((sourceSet) => (sourceSet.versions || []).filter((version) => version.status === 'published').map((version) => ({ ...version, id: version.id, sourceSetName: sourceSet.name, sourceSetSlug: sourceSet.slug })));
  }
  function publishedImageProfileVersions() {
    return (state.catalog.imageProfiles || []).flatMap((profile) => (profile.versions || []).filter((version) => version.status === 'published').map((version) => ({ ...version, profileName: profile.name, profileSlug: profile.slug })));
  }

  async function loadCatalog() {
    try {
      const [data, imageData] = await Promise.all([
        api('/api/divedeep/catalog?namespace=divedeep.source'),
        api('/api/divedeep/image-analysis/profiles'),
      ]);
      state.catalog = { ...state.catalog, ...(data.catalog || {}), imageProfiles: imageData.profiles || [], presentationContract: imageData.presentationContract || null };
      renderCatalog();
    } catch (error) {
      ['catalogResourceRows', 'catalogPoolGrid', 'catalogSourceSetGrid', 'catalogSchemaGrid', 'catalogPackageGrid', 'imageAnalysisGrid'].forEach((id) => { const el = $(id); if (el) el.innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; });
    }
  }

  function renderCatalog() {
    const summary = state.catalog.summary || {};
    $('catalogMetricResources').textContent = Number(summary.resources?.active) || 0;
    $('catalogMetricDomains').textContent = Number(summary.resources?.domains) || 0;
    $('catalogMetricPools').textContent = Number(summary.pools?.active) || 0;
    $('catalogMetricSourceSets').textContent = Number(summary.sourceSets?.active) || 0;
    $('catalogMetricPackages').textContent = Number(summary.packageVersions?.published) || 0;
    renderCatalogResources();
    renderCatalogPools();
    renderCatalogSourceSets();
    renderCatalogSchemas();
    renderCatalogPackages();
    renderImageAnalysis();
    setCatalogTab(state.catalog.tab || 'resources');
  }

  function setCatalogTab(tab) {
    state.catalog.tab = ['resources', 'pools', 'sourceSets', 'schemas', 'packages', 'imageAnalysis'].includes(tab) ? tab : 'resources';
    document.querySelectorAll('[data-catalog-tab]').forEach((button) => button.classList.toggle('active', button.dataset.catalogTab === state.catalog.tab));
    document.querySelectorAll('[data-catalog-pane]').forEach((pane) => pane.classList.toggle('active', pane.dataset.catalogPane === state.catalog.tab));
  }

  function filteredCatalogResources() {
    const query = String($('catalogResourceSearch')?.value || '').trim().toLowerCase();
    const status = $('catalogResourceStatus')?.value || '';
    const sensitivity = $('catalogResourceSensitivity')?.value || '';
    return (state.catalog.resources || []).filter((item) => {
      if (status && item.status !== status) return false;
      if (sensitivity && item.sensitivityClass !== sensitivity) return false;
      if (!query) return true;
      return `${item.name} ${item.slug} ${item.primaryDomain} ${item.resourceType} ${item.serviceType} ${item.category} ${item.topic}`.toLowerCase().includes(query);
    });
  }

  function renderCatalogResources() {
    const resources = filteredCatalogResources();
    $('catalogResourceRows').innerHTML = resources.length ? resources.map((item) => `<tr>
      <td><div class="fida-customer-cell"><span class="fida-source-mark">${esc((item.name || '?')[0].toUpperCase())}</span><div><strong>${esc(item.name)}</strong><small>${esc(item.primaryDomain || item.slug)} · revision ${item.revision}</small></div></div></td>
      <td>${chip(item.resourceType)}<br><small>${esc(item.serviceType || 'Unclassified service')}</small></td>
      <td><strong>${esc(item.category || 'Uncategorized')}</strong><br><small>${esc(item.topic || 'No topic')} · ${esc(title(item.sensitivityClass))}</small></td>
      <td><small>${esc(item.metadataSchemaName ? `${item.metadataSchemaName} v${item.metadataSchemaVersion}` : 'No metadata schema')}</small></td>
      <td>${chip(item.status)}</td>
      <td><button class="fida-btn fida-btn-small" data-edit-resource="${esc(item.id)}">Edit</button></td>
    </tr>`).join('') : '<tr><td colspan="6"><div class="fida-empty">No sources match the current filters.</div></td></tr>';
    document.querySelectorAll('[data-edit-resource]').forEach((button) => button.addEventListener('click', () => openCatalogModal('resource', button.dataset.editResource)));
  }

  function renderCatalogPools() {
    $('catalogPoolGrid').innerHTML = (state.catalog.pools || []).map((pool) => {
      const current = (pool.versions || []).find((version) => version.version === pool.currentVersion) || pool.versions?.[0];
      const drafts = (pool.versions || []).filter((version) => version.status === 'draft');
      return `<article class="fida-catalog-card"><header><div><strong>${esc(pool.name)}</strong><small>${esc(pool.namespace)} · ${esc(pool.poolType)}</small></div>${chip(pool.status)}</header><p>${esc(pool.description || 'No description')}</p><div class="fida-catalog-facts"><span><b>v${pool.currentVersion || 0}</b>Current</span><span><b>${current?.memberCount || 0}</b>Members</span><span><b>${pool.versions?.length || 0}</b>Versions</span></div>${current?.members?.length ? `<div class="fida-catalog-tags">${current.members.slice(0, 8).map((member) => `<span>${esc(member.resourceName)}</span>`).join('')}${current.members.length > 8 ? `<span>+${current.members.length - 8}</span>` : ''}</div>` : '<div class="fida-empty compact">No source members yet.</div>'}<div class="fida-card-actions root-only"><button class="fida-btn fida-btn-small" data-new-pool-version="${esc(pool.id)}">New version</button>${drafts.map((version) => `<button class="fida-btn fida-btn-small" data-edit-pool-version="${esc(version.id)}">Edit v${version.version}</button><button class="fida-btn fida-btn-primary fida-btn-small" data-publish-pool-version="${esc(version.id)}">Publish v${version.version}</button>`).join('')}</div></article>`;
    }).join('') || '<div class="fida-empty">No pools are configured.</div>';
    document.querySelectorAll('[data-new-pool-version]').forEach((button) => button.addEventListener('click', () => openCatalogModal('pool-version', null, button.dataset.newPoolVersion)));
    document.querySelectorAll('[data-edit-pool-version]').forEach((button) => button.addEventListener('click', () => openCatalogModal('pool-version-edit', button.dataset.editPoolVersion)));
    document.querySelectorAll('[data-publish-pool-version]').forEach((button) => button.addEventListener('click', () => publishCatalogVersion('pool', button.dataset.publishPoolVersion)));
  }

  function renderCatalogSourceSets() {
    $('catalogSourceSetGrid').innerHTML = (state.catalog.sourceSets || []).map((sourceSet) => {
      const current = (sourceSet.versions || []).find((version) => version.version === sourceSet.currentVersion) || sourceSet.versions?.[0];
      const drafts = (sourceSet.versions || []).filter((version) => version.status === 'draft');
      return `<article class="fida-catalog-card"><header><div><strong>${esc(sourceSet.name)}</strong><small>${esc(sourceSet.slug)}</small></div>${chip(sourceSet.status)}</header><p>${esc(sourceSet.description || 'No description')}</p><div class="fida-catalog-facts"><span><b>v${sourceSet.currentVersion || 0}</b>Current</span><span><b>${current?.poolCount || 0}</b>Pools</span><span><b>${current?.resourceCount || 0}</b>Sources</span></div>${current?.pools?.length ? `<div class="fida-catalog-tags">${current.pools.map((item) => `<span>${esc(item.poolName)} v${item.version}</span>`).join('')}</div>` : '<div class="fida-empty compact">No pool versions linked.</div>'}<div class="fida-card-actions root-only"><button class="fida-btn fida-btn-small" data-new-source-set-version="${esc(sourceSet.id)}">New version</button>${drafts.map((version) => `<button class="fida-btn fida-btn-small" data-edit-source-set-version="${esc(version.id)}">Edit v${version.version}</button><button class="fida-btn fida-btn-primary fida-btn-small" data-publish-source-set-version="${esc(version.id)}">Publish v${version.version}</button>`).join('')}</div></article>`;
    }).join('') || '<div class="fida-empty">No source sets are configured.</div>';
    document.querySelectorAll('[data-new-source-set-version]').forEach((button) => button.addEventListener('click', () => openCatalogModal('source-set-version', null, button.dataset.newSourceSetVersion)));
    document.querySelectorAll('[data-edit-source-set-version]').forEach((button) => button.addEventListener('click', () => openCatalogModal('source-set-version-edit', button.dataset.editSourceSetVersion)));
    document.querySelectorAll('[data-publish-source-set-version]').forEach((button) => button.addEventListener('click', () => publishCatalogVersion('source-set', button.dataset.publishSourceSetVersion)));
  }

  function renderCatalogSchemas() {
    $('catalogSchemaGrid').innerHTML = (state.catalog.schemas || []).map((schema) => `<article class="fida-catalog-card"><header><div><strong>${esc(schema.name)}</strong><small>${esc(schema.namespace)}.${esc(schema.schemaKey)} · v${schema.version}</small></div>${chip(schema.status)}</header><p>${esc(schema.description || 'No description')}</p><div class="fida-catalog-facts"><span><b>${esc(schema.resourceType)}</b>Resource type</span><span><b>${Object.keys(schema.jsonSchema?.properties || {}).length}</b>Properties</span><span><b>${schema.isDefault ? 'Yes' : 'No'}</b>Default</span></div><div class="fida-card-actions root-only"><button class="fida-btn fida-btn-small" data-new-schema-version="${esc(schema.id)}">New version</button>${schema.status === 'draft' ? `<button class="fida-btn fida-btn-primary fida-btn-small" data-publish-schema="${esc(schema.id)}">Publish</button>` : ''}</div></article>`).join('') || '<div class="fida-empty">No metadata schemas are configured.</div>';
    document.querySelectorAll('[data-new-schema-version]').forEach((button) => button.addEventListener('click', () => openCatalogModal('schema', button.dataset.newSchemaVersion)));
    document.querySelectorAll('[data-publish-schema]').forEach((button) => button.addEventListener('click', () => publishCatalogVersion('schema', button.dataset.publishSchema)));
  }

  function renderCatalogPackages() {
    const grouped = (state.catalog.packageVersions || []).reduce((out, item) => { (out[item.packageId] ||= []).push(item); return out; }, {});
    $('catalogPackageGrid').innerHTML = Object.entries(grouped).map(([packageId, versions]) => {
      const current = versions.find((item) => item.current) || versions[0];
      const drafts = versions.filter((item) => item.status === 'draft');
      return `<article class="fida-catalog-card"><header><div><strong>${esc(current?.packageName || title(packageId))}</strong><small>${esc(packageId)} · current v${current?.version || 0}</small></div>${chip(current?.status || 'draft')}</header><p>Source set: <strong>${esc(current?.sourceSetName || 'Unassigned')} v${current?.sourceSetVersion || '—'}</strong><br>Image policy: <strong>${esc(current?.imageAnalysisProfileName || 'None')}${current?.imageAnalysisProfileVersion ? ` v${current.imageAnalysisProfileVersion}` : ''}</strong></p><div class="fida-catalog-facts"><span><b>${esc(current?.retentionPolicy?.nonmatchHours ?? '—')}h</b>Nonmatch</span><span><b>${esc(current?.retentionPolicy?.pendingReviewDays ?? '—')}d</b>Review</span><span><b>${versions.length}</b>Versions</span></div><div class="fida-card-actions"><button class="fida-btn fida-btn-small" data-view-package-manifest="${esc(packageId)}">Resolve manifest</button><button class="fida-btn fida-btn-small root-only" data-new-package-version="${esc(packageId)}">New version</button>${drafts.map((version) => `<button class="fida-btn fida-btn-primary fida-btn-small root-only" data-publish-package-version="${esc(version.id)}">Publish v${version.version}</button>`).join('')}</div></article>`;
    }).join('') || '<div class="fida-empty">No package versions are configured.</div>';
    document.querySelectorAll('[data-new-package-version]').forEach((button) => button.addEventListener('click', () => openCatalogModal('package-version', null, button.dataset.newPackageVersion)));
    document.querySelectorAll('[data-publish-package-version]').forEach((button) => button.addEventListener('click', () => publishCatalogVersion('package', button.dataset.publishPackageVersion)));
    document.querySelectorAll('[data-view-package-manifest]').forEach((button) => button.addEventListener('click', () => viewPackageManifest(button.dataset.viewPackageManifest)));
  }

  function renderImageAnalysis() {
    const profiles = state.catalog.imageProfiles || [];
    const contract = state.catalog.presentationContract || {};
    $('imageAnalysisGrid').innerHTML = profiles.map((profile) => {
      const current = (profile.versions || []).find((version) => version.version === profile.currentVersion) || profile.versions?.[0];
      const drafts = (profile.versions || []).filter((version) => version.status === 'draft');
      const ops = current?.operations || {};
      return `<article class="fida-catalog-card"><header><div><strong>${esc(profile.name)}</strong><small>${esc(profile.slug)} · v${current?.version || 0}</small></div>${chip(profile.status)}</header><p>${esc(profile.description || '')}</p><div class="fida-catalog-tags">${Object.entries(ops).filter(([, enabled]) => enabled).map(([name]) => `<span>${esc(title(name))}</span>`).join('')}</div><div class="fida-catalog-facts"><span><b>${esc(current?.thresholds?.reviewFloor ?? '—')}%</b>Review floor</span><span><b>${esc(current?.thresholds?.highPriorityThreshold ?? '—')}%</b>Priority</span><span><b>${current?.reviewPolicy?.customerValidationAllowed ? 'Yes' : 'No'}</b>User validation</span></div><div class="fida-card-actions root-only"><button class="fida-btn fida-btn-small" data-new-image-version="${esc(profile.id)}">New version</button>${drafts.map((version) => `<button class="fida-btn fida-btn-small" data-edit-image-version="${esc(version.id)}">Edit v${version.version}</button><button class="fida-btn fida-btn-primary fida-btn-small" data-publish-image-version="${esc(version.id)}">Publish v${version.version}</button>`).join('')}</div></article>`;
    }).join('') || '<div class="fida-empty">No image-analysis profiles are configured.</div>';
    document.querySelectorAll('[data-new-image-version]').forEach((button) => button.addEventListener('click', () => openCatalogModal('image-profile-version', null, button.dataset.newImageVersion)));
    document.querySelectorAll('[data-edit-image-version]').forEach((button) => button.addEventListener('click', () => openCatalogModal('image-profile-version-edit', button.dataset.editImageVersion)));
    document.querySelectorAll('[data-publish-image-version]').forEach((button) => button.addEventListener('click', () => publishCatalogVersion('image-profile', button.dataset.publishImageVersion)));
    const contractEl = $('imagePresentationContract');
    if (contractEl) contractEl.textContent = `Blurred preview stream · ${Number(contract.itemStates?.length) || 0} analysis states · human validation required`;
  }

  function findImageProfileVersion(versionId) {
    for (const profile of state.catalog.imageProfiles || []) { const version = (profile.versions || []).find((item) => item.id === versionId); if (version) return { profile, version }; }
    return null;
  }

  function findPoolVersion(versionId) {
    for (const pool of state.catalog.pools || []) { const version = (pool.versions || []).find((item) => item.id === versionId); if (version) return { pool, version }; }
    return null;
  }
  function findSourceSetVersion(versionId) {
    for (const sourceSet of state.catalog.sourceSets || []) { const version = (sourceSet.versions || []).find((item) => item.id === versionId); if (version) return { sourceSet, version }; }
    return null;
  }

  function openCatalogModal(mode, entityId = null, parentId = null) {
    const form = $('catalogForm');
    form.reset();
    form.elements.mode.value = mode;
    form.elements.entityId.value = entityId || '';
    form.elements.parentId.value = parentId || '';
    let titleText = 'Catalog record';
    let kicker = 'Source catalog';
    let fields = '';
    if (mode === 'resource') {
      const item = (state.catalog.resources || []).find((resource) => resource.id === entityId) || {};
      titleText = item.id ? 'Edit source' : 'Add source';
      fields = catalogField('name', 'Name', item.name, { required: true }) + catalogField('slug', 'Slug', item.slug, { required: true }) +
        catalogField('namespace', 'Namespace', item.namespace || 'divedeep.source', { required: true }) + catalogField('resourceType', 'Resource type', item.resourceType || 'website', { required: true }) +
        catalogField('primaryDomain', 'Primary domain', item.primaryDomain, { placeholder: 'example.com' }) + catalogField('serviceType', 'Service type', item.serviceType) +
        catalogField('category', 'Category', item.category) + catalogField('topic', 'Topic', item.topic) +
        catalogField('sensitivityClass', 'Sensitivity', item.sensitivityClass || 'standard', { type: 'select', options: ['standard', 'sensitive', 'restricted'] }) +
        catalogField('status', 'Status', item.status || 'draft', { type: 'select', options: ['draft', 'active', 'paused', 'retired'] }) +
        catalogField('metadataSchemaId', 'Metadata schema', item.metadataSchemaId || '', { type: 'select', options: [{ value: '', label: 'No schema' }, ...(state.catalog.schemas || []).filter((schema) => schema.status === 'published').map((schema) => ({ value: schema.id, label: `${schema.name} v${schema.version}` }))] }) +
        catalogField('adapterKey', 'Adapter key', item.adapterKey) + catalogField('description', 'Description', item.description, { type: 'textarea', wide: true, rows: 3 }) +
        catalogField('metadata', 'Metadata JSON', catalogJson(item.metadata || { siteType: 'website', tags: [], languages: [], extensions: {} }), { type: 'textarea', wide: true }) +
        catalogField('capabilities', 'Capabilities JSON', catalogJson(item.capabilities || { usernameSearch: false, nameSearch: false, emailSearch: false, phoneSearch: false, reverseImage: false, knownUrlCheck: true }), { type: 'textarea', wide: true }) +
        catalogField('declarations', 'Declarations JSON', catalogJson(item.declarations || { requiresAuthentication: false, automatedRemoval: false, removalForm: false, monitoring: true, reviewRequired: true }), { type: 'textarea', wide: true }) +
        catalogField('limits', 'Limits JSON', catalogJson(item.limits || {}), { type: 'textarea', wide: true }) +
        catalogField('removalMethods', 'Removal methods JSON', catalogJson(item.removalMethods || {}), { type: 'textarea', wide: true }) +
        catalogField('monitoringSupport', 'Monitoring support JSON', catalogJson(item.monitoringSupport || {}), { type: 'textarea', wide: true }) +
        catalogField('changeNote', 'Change note', item.id ? 'Catalog source updated' : 'Catalog source created', { wide: true });
    } else if (mode === 'pool') {
      titleText = 'Add namespaced pool';
      const poolSchemas = (state.catalog.schemas || []).filter((schema) => schema.status === 'published' && schema.resourceType === 'pool');
      fields = catalogField('name', 'Pool name', '', { required: true }) + catalogField('slug', 'Slug', '', { required: true }) +
        catalogField('namespace', 'Namespace', 'divedeep.source', { required: true }) + catalogField('poolType', 'Pool type', 'category', { required: true }) +
        catalogField('metadataSchemaId', 'Pool metadata schema', poolSchemas.find((schema) => schema.isDefault)?.id || '', { type: 'select', options: [{ value: '', label: 'No schema' }, ...poolSchemas.map((schema) => ({ value: schema.id, label: `${schema.name} v${schema.version}` }))] }) +
        catalogField('description', 'Description', '', { type: 'textarea', wide: true, rows: 3 }) +
        catalogField('selectorRules', 'Selector rules JSON', catalogJson({}), { type: 'textarea', wide: true, rows: 5, help: 'Describes dynamic membership intent. Versioned members remain the resolved source list.' }) +
        catalogField('metadata', 'Pool metadata JSON', catalogJson({}), { type: 'textarea', wide: true, rows: 5 }) +
        catalogChecklist('resourceIds', 'Initial source members', state.catalog.resources || [], new Set()) + catalogField('publish', 'Publish version 1 immediately', true, { type: 'checkbox', wide: true });
    } else if (mode === 'pool-version' || mode === 'pool-version-edit') {
      const found = mode === 'pool-version-edit' ? findPoolVersion(entityId) : { pool: (state.catalog.pools || []).find((item) => item.id === parentId), version: null };
      const pool = found?.pool; const version = found?.version;
      const current = (pool?.versions || []).find((item) => item.version === pool.currentVersion) || null;
      const template = version || current || {};
      titleText = mode === 'pool-version-edit' ? `Edit ${pool?.name} draft v${version?.version}` : `New ${pool?.name || 'pool'} version`;
      const selected = new Set((template.members || []).map((item) => item.resourceId));
      fields = catalogField('label', 'Version label', version?.label || `${pool?.name || 'Pool'} next version`, { required: true }) +
        catalogField('description', 'Description', version?.description || current?.description || pool?.description || '', { type: 'textarea', wide: true, rows: 3 }) +
        catalogField('selectorRules', 'Selector rules JSON', catalogJson(template.selectorRules || {}), { type: 'textarea', wide: true, rows: 5 }) +
        catalogField('metadata', 'Version metadata JSON', catalogJson(template.metadata || {}), { type: 'textarea', wide: true, rows: 5 }) +
        catalogChecklist('resourceIds', 'Source members', state.catalog.resources || [], selected) +
        (mode === 'pool-version' ? catalogField('publish', 'Publish after saving', true, { type: 'checkbox', wide: true }) : '');
    } else if (mode === 'source-set') {
      titleText = 'Add source set';
      fields = catalogField('name', 'Source-set name', '', { required: true }) + catalogField('slug', 'Slug', '', { required: true }) +
        catalogField('selectionMode', 'Selection mode', 'pools', { type: 'select', options: ['pools', 'explicit', 'hybrid', 'rules'] }) +
        catalogField('description', 'Description', '', { type: 'textarea', wide: true, rows: 3 }) +
        catalogField('metadata', 'Source-set metadata JSON', catalogJson({}), { type: 'textarea', wide: true, rows: 5 }) +
        catalogChecklist('poolVersionIds', 'Published pool versions', publishedPoolVersions(), new Set(), (item) => ({ title: `${item.poolName} v${item.version}`, note: `${item.namespace} · ${item.memberCount} members` })) +
        catalogChecklist('resourceIds', 'Explicit source inclusions', state.catalog.resources || [], new Set()) + catalogField('publish', 'Publish version 1 immediately', true, { type: 'checkbox', wide: true });
    } else if (mode === 'source-set-version' || mode === 'source-set-version-edit') {
      const found = mode === 'source-set-version-edit' ? findSourceSetVersion(entityId) : { sourceSet: (state.catalog.sourceSets || []).find((item) => item.id === parentId), version: null };
      const sourceSet = found?.sourceSet; const version = found?.version;
      const current = (sourceSet?.versions || []).find((item) => item.version === sourceSet.currentVersion) || null;
      const template = version || current || {};
      titleText = mode === 'source-set-version-edit' ? `Edit ${sourceSet?.name} draft v${version?.version}` : `New ${sourceSet?.name || 'source-set'} version`;
      const selectedPools = new Set((template.pools || []).filter((item) => item.inclusionMode === 'include').map((item) => item.poolVersionId));
      const selectedResources = new Set((template.resources || []).filter((item) => item.inclusionMode === 'include').map((item) => item.resourceId));
      fields = catalogField('selectionMode', 'Selection mode', template.selectionMode || 'pools', { type: 'select', options: ['pools', 'explicit', 'hybrid', 'rules'] }) +
        catalogField('metadata', 'Version metadata JSON', catalogJson(template.metadata || {}), { type: 'textarea', wide: true, rows: 5 }) +
        catalogChecklist('poolVersionIds', 'Published pool versions', publishedPoolVersions(), selectedPools, (item) => ({ title: `${item.poolName} v${item.version}`, note: `${item.namespace} · ${item.memberCount} members` })) +
        catalogChecklist('resourceIds', 'Explicit source inclusions', state.catalog.resources || [], selectedResources) +
        (mode === 'source-set-version' ? catalogField('publish', 'Publish after saving', true, { type: 'checkbox', wide: true }) : '');
    } else if (mode === 'schema') {
      const prior = (state.catalog.schemas || []).find((schema) => schema.id === entityId) || {};
      titleText = prior.id ? `New ${prior.name} version` : 'Add metadata schema version';
      fields = catalogField('namespace', 'Namespace', prior.namespace || 'divedeep', { required: true }) + catalogField('schemaKey', 'Schema key', prior.schemaKey || '', { required: true }) + catalogField('resourceType', 'Resource type', prior.resourceType || 'website', { required: true }) + catalogField('name', 'Schema name', prior.name || '', { required: true }) + catalogField('description', 'Description', prior.description || '', { type: 'textarea', wide: true, rows: 3 }) + catalogField('status', 'Initial status', 'published', { type: 'select', options: ['draft', 'published'] }) + catalogField('isDefault', 'Default for this resource type', Boolean(prior.isDefault), { type: 'checkbox', wide: true }) + catalogField('jsonSchema', 'JSON Schema', catalogJson(prior.jsonSchema || { type: 'object', properties: { extensions: { type: 'object', additionalProperties: true } }, additionalProperties: false }), { type: 'textarea', wide: true, rows: 12 });
    } else if (mode === 'package-version') {
      const versions = (state.catalog.packageVersions || []).filter((item) => item.packageId === parentId);
      const current = versions.find((item) => item.current) || versions[0] || {};
      titleText = `New ${current.packageName || title(parentId)} version`;
      fields = catalogField('sourceSetVersionId', 'Published source-set version', current.sourceSetVersionId || '', { type: 'select', options: publishedSourceSetVersions().map((item) => ({ value: item.id, label: `${item.sourceSetName} v${item.version}` })) }) + catalogField('imageProfileVersionId', 'Published image-analysis profile', current.imageAnalysisProfileVersionId || '', { type: 'select', options: [{ value: '', label: 'No image analysis' }, ...publishedImageProfileVersions().map((item) => ({ value: item.id, label: `${item.profileName} v${item.version}` }))] }) + catalogField('imageAnalysisRequired', 'Require image analysis for this package version', Boolean(current.imageAnalysisRequired), { type: 'checkbox', wide: true }) + catalogField('requirements', 'Requirements JSON', catalogJson(current.requirements || {}), { type: 'textarea', wide: true }) + catalogField('executionPolicy', 'Execution policy JSON', catalogJson(current.executionPolicy || {}), { type: 'textarea', wide: true }) + catalogField('reviewPolicy', 'Review policy JSON', catalogJson(current.reviewPolicy || {}), { type: 'textarea', wide: true }) + catalogField('retentionPolicy', 'Retention policy JSON', catalogJson(current.retentionPolicy || { nonmatchHours: 24, pendingReviewDays: 30 }), { type: 'textarea', wide: true }) + catalogField('publish', 'Publish after saving', true, { type: 'checkbox', wide: true });
    } else if (mode === 'image-profile-version' || mode === 'image-profile-version-edit') {
      const found = mode === 'image-profile-version-edit' ? findImageProfileVersion(entityId) : { profile: (state.catalog.imageProfiles || []).find((item) => item.id === parentId), version: null };
      const profile = found?.profile; const version = found?.version;
      const current = (profile?.versions || []).find((item) => item.version === profile.currentVersion) || profile?.versions?.[0] || {};
      const template = version || current;
      titleText = mode === 'image-profile-version-edit' ? `Edit ${profile?.name} draft v${version?.version}` : `New ${profile?.name || 'image-analysis'} version`;
      kicker = 'Assisted image analysis';
      fields = catalogField('operations', 'Operations JSON', catalogJson(template.operations || {}), { type: 'textarea', wide: true, rows: 7 }) +
        catalogField('thresholds', 'Thresholds JSON', catalogJson(template.thresholds || {}), { type: 'textarea', wide: true, rows: 6 }) +
        catalogField('limits', 'Limits JSON', catalogJson(template.limits || {}), { type: 'textarea', wide: true, rows: 5 }) +
        catalogField('qualityRules', 'Quality rules JSON', catalogJson(template.qualityRules || {}), { type: 'textarea', wide: true, rows: 6 }) +
        catalogField('reviewPolicy', 'Review and customer-validation policy JSON', catalogJson(template.reviewPolicy || {}), { type: 'textarea', wide: true, rows: 8 }) +
        catalogField('retentionPolicy', 'Retention policy JSON', catalogJson(template.retentionPolicy || { nonmatchHours: 24, pendingReviewDays: 30 }), { type: 'textarea', wide: true, rows: 5 }) +
        (mode === 'image-profile-version' ? catalogField('publish', 'Publish after saving', true, { type: 'checkbox', wide: true }) : '');
    } else if (mode === 'manifest') {
      titleText = `Resolved ${parentId} manifest`;
      fields = catalogField('manifest', 'Resolved immutable manifest', entityId || '{}', { type: 'textarea', wide: true, rows: 20 });
      $('saveCatalogForm').hidden = true;
    }
    if (mode !== 'manifest') $('saveCatalogForm').hidden = false;
    $('catalogModalTitle').textContent = titleText;
    $('catalogModalKicker').textContent = kicker;
    $('catalogFormFields').innerHTML = fields;
    $('catalogModal').hidden = false;
  }

  function checkedValues(form, name) { return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value); }

  async function submitCatalogForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const mode = form.elements.mode.value;
    const entityId = form.elements.entityId.value;
    const parentId = form.elements.parentId.value;
    const value = (name) => form.elements[name]?.value ?? '';
    const checked = (name) => Boolean(form.elements[name]?.checked);
    try {
      if (mode === 'resource') {
        const payload = { name: value('name'), slug: value('slug'), namespace: value('namespace'), resourceType: value('resourceType'), primaryDomain: value('primaryDomain'), serviceType: value('serviceType'), category: value('category'), topic: value('topic'), sensitivityClass: value('sensitivityClass'), status: value('status'), metadataSchemaId: value('metadataSchemaId') || null, adapterKey: value('adapterKey'), description: value('description'), metadata: catalogParse(value('metadata'), 'Metadata'), capabilities: catalogParse(value('capabilities'), 'Capabilities'), declarations: catalogParse(value('declarations'), 'Declarations'), limits: catalogParse(value('limits'), 'Limits'), removalMethods: catalogParse(value('removalMethods'), 'Removal methods'), monitoringSupport: catalogParse(value('monitoringSupport'), 'Monitoring support'), changeNote: value('changeNote') };
        await api(entityId ? `/api/divedeep/catalog/resources/${encodeURIComponent(entityId)}` : '/api/divedeep/catalog/resources', { method: entityId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      } else if (mode === 'pool') {
        await api('/api/divedeep/catalog/pools', { method: 'POST', body: JSON.stringify({
          name: value('name'), slug: value('slug'), namespace: value('namespace'), poolType: value('poolType'),
          metadataSchemaId: value('metadataSchemaId') || null, description: value('description'),
          selectorRules: catalogParse(value('selectorRules'), 'Selector rules'), metadata: catalogParse(value('metadata'), 'Pool metadata'),
          resourceIds: checkedValues(form, 'resourceIds'), publish: checked('publish'),
        }) });
      } else if (mode === 'pool-version') {
        await api(`/api/divedeep/catalog/pools/${encodeURIComponent(parentId)}/versions`, { method: 'POST', body: JSON.stringify({
          label: value('label'), description: value('description'), selectorRules: catalogParse(value('selectorRules'), 'Selector rules'),
          metadata: catalogParse(value('metadata'), 'Pool version metadata'), resourceIds: checkedValues(form, 'resourceIds'), publish: checked('publish'),
        }) });
      } else if (mode === 'pool-version-edit') {
        await api(`/api/divedeep/catalog/pool-versions/${encodeURIComponent(entityId)}`, { method: 'PATCH', body: JSON.stringify({
          label: value('label'), description: value('description'), selectorRules: catalogParse(value('selectorRules'), 'Selector rules'),
          metadata: catalogParse(value('metadata'), 'Pool version metadata'), resourceIds: checkedValues(form, 'resourceIds'),
        }) });
      } else if (mode === 'source-set') {
        await api('/api/divedeep/catalog/source-sets', { method: 'POST', body: JSON.stringify({
          name: value('name'), slug: value('slug'), description: value('description'), selectionMode: value('selectionMode'),
          metadata: catalogParse(value('metadata'), 'Source-set metadata'), poolVersionIds: checkedValues(form, 'poolVersionIds'),
          resourceIds: checkedValues(form, 'resourceIds'), publish: checked('publish'),
        }) });
      } else if (mode === 'source-set-version') {
        await api(`/api/divedeep/catalog/source-sets/${encodeURIComponent(parentId)}/versions`, { method: 'POST', body: JSON.stringify({
          selectionMode: value('selectionMode'), metadata: catalogParse(value('metadata'), 'Source-set version metadata'),
          poolVersionIds: checkedValues(form, 'poolVersionIds'), resourceIds: checkedValues(form, 'resourceIds'), publish: checked('publish'),
        }) });
      } else if (mode === 'source-set-version-edit') {
        await api(`/api/divedeep/catalog/source-set-versions/${encodeURIComponent(entityId)}`, { method: 'PATCH', body: JSON.stringify({
          selectionMode: value('selectionMode'), metadata: catalogParse(value('metadata'), 'Source-set version metadata'),
          poolVersionIds: checkedValues(form, 'poolVersionIds'), resourceIds: checkedValues(form, 'resourceIds'),
        }) });
      } else if (mode === 'schema') {
        await api('/api/divedeep/catalog/schemas', { method: 'POST', body: JSON.stringify({ namespace: value('namespace'), schemaKey: value('schemaKey'), resourceType: value('resourceType'), name: value('name'), description: value('description'), status: value('status'), isDefault: checked('isDefault'), jsonSchema: JSON.parse(value('jsonSchema')) }) });
      } else if (mode === 'package-version') {
        await api(`/api/divedeep/catalog/packages/${encodeURIComponent(parentId)}/versions`, { method: 'POST', body: JSON.stringify({ sourceSetVersionId: value('sourceSetVersionId'), imageProfileVersionId: value('imageProfileVersionId') || null, imageAnalysisRequired: checked('imageAnalysisRequired'), requirements: catalogParse(value('requirements'), 'Requirements'), executionPolicy: catalogParse(value('executionPolicy'), 'Execution policy'), reviewPolicy: catalogParse(value('reviewPolicy'), 'Review policy'), retentionPolicy: catalogParse(value('retentionPolicy'), 'Retention policy'), publish: checked('publish') }) });
          } else if (mode === 'image-profile-version') {
        await api(`/api/divedeep/image-analysis/profiles/${encodeURIComponent(parentId)}/versions`, { method: 'POST', body: JSON.stringify({ operations: catalogParse(value('operations'), 'Operations'), thresholds: catalogParse(value('thresholds'), 'Thresholds'), limits: catalogParse(value('limits'), 'Limits'), qualityRules: catalogParse(value('qualityRules'), 'Quality rules'), reviewPolicy: catalogParse(value('reviewPolicy'), 'Review policy'), retentionPolicy: catalogParse(value('retentionPolicy'), 'Retention policy'), publish: checked('publish') }) });
      } else if (mode === 'image-profile-version-edit') {
        await api(`/api/divedeep/image-analysis/profile-versions/${encodeURIComponent(entityId)}`, { method: 'PATCH', body: JSON.stringify({ operations: catalogParse(value('operations'), 'Operations'), thresholds: catalogParse(value('thresholds'), 'Thresholds'), limits: catalogParse(value('limits'), 'Limits'), qualityRules: catalogParse(value('qualityRules'), 'Quality rules'), reviewPolicy: catalogParse(value('reviewPolicy'), 'Review policy'), retentionPolicy: catalogParse(value('retentionPolicy'), 'Retention policy') }) });
      }
      $('catalogModal').hidden = true;
      await loadCatalog();
      toast('Catalog configuration saved.');
    } catch (error) { toast(error.message, true); }
  }

  async function publishCatalogVersion(type, versionId) {
    if (!confirm('Publish this immutable version? Future changes will require a new version.')) return;
    const routes = { pool: `/api/divedeep/catalog/pool-versions/${encodeURIComponent(versionId)}/publish`, 'source-set': `/api/divedeep/catalog/source-set-versions/${encodeURIComponent(versionId)}/publish`, package: `/api/divedeep/catalog/package-versions/${encodeURIComponent(versionId)}/publish`, 'image-profile': `/api/divedeep/image-analysis/profile-versions/${encodeURIComponent(versionId)}/publish` };
    try {
      if (type === 'schema') await api(`/api/divedeep/catalog/schemas/${encodeURIComponent(versionId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'published' }) });
      else await api(routes[type], { method: 'POST', body: '{}' });
      await loadCatalog();
      toast('Version published.');
    } catch (error) { toast(error.message, true); }
  }

  async function viewPackageManifest(packageId) {
    try {
      const data = await api(`/api/divedeep/packages/${encodeURIComponent(packageId)}/source-manifest`);
      openCatalogModal('manifest', catalogJson(data.manifest), packageId);
    } catch (error) { toast(error.message, true); }
  }

  async function loadIntegrations() {
    try {
      const data = await api('/api/divedeep/integrations');
      state.integrations = data.integrations || [];
      const rekognition = state.integrations.find((item) => item.provider === 'aws_rekognition');
      if (rekognition) {
        try {
          const status = await api('/api/divedeep/integrations/aws_rekognition/status');
          rekognition.usage = status.usage || null;
          rekognition.presentationContract = status.presentationContract || null;
        } catch (_error) {
          rekognition.usage = null;
        }
      }
      const cloudRun = state.integrations.find((item) => item.provider === 'google_cloud_run');
      if (cloudRun) {
        try { const status = await api('/api/divedeep/integrations/google_cloud_run/status'); cloudRun.pools = status.pools || []; }
        catch (_error) { cloudRun.pools = []; }
      }
      renderIntegrations();
    } catch (error) { $('integrationGrid').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }

  function renderIntegrations() {
    $('integrationGrid').innerHTML = state.integrations.map((integration) => {
      const definition = INTEGRATION_FIELDS[integration.provider] || { icon: '•' };
      const protectedCount = (integration.secrets || []).filter((item) => item.configured).length;
      const rekognitionUsage = integration.provider === 'aws_rekognition' && integration.usage
        ? `<div class="fida-integration-status fida-integration-usage"><div><span>Calls today</span><strong>${esc(integration.usage.today?.calls ?? 0)}</strong></div><div><span>Calls this month</span><strong>${esc(integration.usage.month?.calls ?? 0)}</strong></div><div><span>Failed calls</span><strong>${esc(integration.usage.month?.failures ?? 0)}</strong></div></div>`
        : '';
      const cloudRunStatus = integration.provider === 'google_cloud_run'
        ? `<div class="fida-integration-status"><div><span>Worker pools</span><strong>${esc(integration.pools?.length || 0)}</strong></div><div><span>Project</span><strong>${esc(integration.config?.projectId || '—')}</strong></div><div><span>Dispatch</span><strong>${integration.config?.dispatchEnabled ? 'Enabled' : 'Disabled'}</strong></div></div>`
        : '';
      const storageStatus = integration.provider === 'object_storage'
        ? `<div class="fida-integration-status"><div><span>Bucket</span><strong>${esc(integration.config?.bucket || '—')}</strong></div><div><span>Driver</span><strong>${esc(title(integration.config?.driver || 'not configured'))}</strong></div><div><span>Integrity</span><strong>${esc(title(integration.config?.checksumMode || '—'))}</strong></div></div>`
        : '';
      return `<article class="fida-integration-card">
        <header><span class="fida-integration-icon">${esc(definition.icon)}</span>${chip(integration.enabled ? integration.verificationStatus : 'disconnected', integration.enabled ? title(integration.verificationStatus) : 'Disabled')}</header>
        <h2>${esc(integration.label)}</h2><p>${esc(integration.description)}</p>
        <div class="fida-integration-status"><div><span>Protected values</span><strong>${protectedCount}/${(integration.secrets || []).length}</strong></div><div><span>Last verified</span><strong>${esc(shortDate(integration.lastVerifiedAt))}</strong></div><div><span>Updated by</span><strong>${esc(integration.updatedBy || '—')}</strong></div></div>
        ${rekognitionUsage}${cloudRunStatus}${storageStatus}
        <div class="fida-integration-actions"><button class="fida-btn fida-btn-primary" data-configure-integration="${esc(integration.provider)}">Configure</button>${integration.configured ? `<button class="fida-btn" data-verify-integration="${esc(integration.provider)}">Check config</button>${integration.provider === 'aws_rekognition' ? `<button class="fida-btn" data-verify-aws-identity>Verify AWS identity</button><button class="fida-btn" data-verify-rekognition-access>Verify Rekognition access</button>` : ''}${integration.provider === 'google_cloud_run' ? `<button class="fida-btn" data-verify-cloud-run-access>Verify Job access</button>` : ''}${integration.provider === 'object_storage' ? `<button class="fida-btn" data-verify-storage-access>Verify storage access</button><button class="fida-btn" data-download-lifecycle-template>Lifecycle template</button>` : ''}<button class="fida-btn fida-btn-danger" data-disconnect-integration="${esc(integration.provider)}">Disconnect</button>` : ''}</div>
      </article>`;
    }).join('');
    document.querySelectorAll('[data-configure-integration]').forEach((button) => button.addEventListener('click', () => openIntegrationModal(button.dataset.configureIntegration)));
    document.querySelectorAll('[data-verify-integration]').forEach((button) => button.addEventListener('click', () => verifyIntegration(button.dataset.verifyIntegration)));
    document.querySelectorAll('[data-disconnect-integration]').forEach((button) => button.addEventListener('click', () => disconnectIntegration(button.dataset.disconnectIntegration)));
    document.querySelectorAll('[data-verify-aws-identity]').forEach((button) => button.addEventListener('click', () => verifyRekognition('verify-identity')));
    document.querySelectorAll('[data-verify-rekognition-access]').forEach((button) => button.addEventListener('click', () => verifyRekognition('verify-access')));
    document.querySelectorAll('[data-verify-cloud-run-access]').forEach((button) => button.addEventListener('click', verifyCloudRunAccess));
    document.querySelectorAll('[data-verify-storage-access]').forEach((button) => button.addEventListener('click', verifyStorageAccess));
    document.querySelectorAll('[data-download-lifecycle-template]').forEach((button) => button.addEventListener('click', downloadLifecycleTemplate));
  }

  function inputField(field, value, { secret = false, configured = false, hint = '' } = {}) {
    const wide = field.wide ? ' full' : '';
    if (field.type === 'checkbox') return `<label class="fida-check${wide}"><input type="checkbox" data-config-field="${esc(field.key)}" ${value ? 'checked' : ''} /> ${esc(field.label)}</label>`;
    if (field.type === 'select') return `<label class="fida-field${wide}"><span>${esc(field.label)}</span><select class="fida-select" data-config-field="${esc(field.key)}">${field.options.map((option) => `<option value="${esc(option)}" ${value === option ? 'selected' : ''}>${esc(title(option))}</option>`).join('')}</select></label>`;
    if (field.type === 'textarea') return `<label class="fida-field${wide}"><span>${esc(field.label)}${secret ? ' · encrypted' : ''}</span><textarea class="fida-textarea" rows="7" ${secret ? `data-secret-field="${esc(field.key)}" autocomplete="new-password"` : `data-config-field="${esc(field.key)}"`} placeholder="${esc(secret && configured ? `Stored ${hint}; leave blank to preserve` : field.placeholder || '')}"></textarea>${secret && configured ? `<label class="fida-check fida-secret-note"><input type="checkbox" data-clear-secret="${esc(field.key)}" /> Remove the saved value ending ${esc(hint)}</label>` : ''}</label>`;
    return `<label class="fida-field${wide}"><span>${esc(field.label)}${secret ? ' · encrypted' : ''}</span><input class="fida-input" type="${secret ? 'password' : esc(field.type || 'text')}" ${secret ? `data-secret-field="${esc(field.key)}" autocomplete="new-password"` : `data-config-field="${esc(field.key)}"`} value="${secret ? '' : esc(value || '')}" placeholder="${esc(secret && configured ? `Stored ${hint}; leave blank to preserve` : field.placeholder || '')}" />${secret && configured ? `<label class="fida-check fida-secret-note"><input type="checkbox" data-clear-secret="${esc(field.key)}" /> Remove the saved value ending ${esc(hint)}</label>` : ''}</label>`;
  }

  function openIntegrationModal(provider) {
    const integration = state.integrations.find((item) => item.provider === provider);
    const fields = INTEGRATION_FIELDS[provider];
    if (!integration || !fields) return;
    $('integrationModalTitle').textContent = integration.label;
    const form = $('integrationForm');
    form.elements.provider.value = provider;
    form.elements.enabled.checked = integration.enabled;
    const secretStatus = Object.fromEntries((integration.secrets || []).map((item) => [item.field, item]));
    $('integrationFields').innerHTML = [
      ...fields.config.map((field) => inputField(
        field,
        provider === 'meta' && field.key === 'redirectUri'
          ? `${location.origin}/divedeep/connect/facebook/callback`
          : integration.config?.[field.key]
      )),
      ...fields.secrets.map((field) => inputField(field, '', { secret: true, configured: secretStatus[field.key]?.configured, hint: secretStatus[field.key]?.hint || '' })),
    ].join('') || '<div class="fida-empty full">This integration has no protected credentials.</div>';
    const metaRedirectInput = provider === 'meta'
      ? document.querySelector('#integrationFields [data-config-field="redirectUri"]')
      : null;
    if (metaRedirectInput) {
      metaRedirectInput.readOnly = true;
      metaRedirectInput.setAttribute('aria-readonly', 'true');
    }
    $('integrationModal').hidden = false;
  }

  async function saveIntegration(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const provider = form.elements.provider.value;
    const config = {};
    document.querySelectorAll('#integrationFields [data-config-field]').forEach((input) => { config[input.dataset.configField] = input.type === 'checkbox' ? input.checked : input.value; });
    const secrets = {};
    document.querySelectorAll('#integrationFields [data-secret-field]').forEach((input) => { if (input.value.trim()) secrets[input.dataset.secretField] = input.value.trim(); });
    const clearSecrets = [...document.querySelectorAll('#integrationFields [data-clear-secret]:checked')].map((input) => input.dataset.clearSecret);
    try {
      await api(`/api/divedeep/integrations/${encodeURIComponent(provider)}`, { method: 'PUT', body: JSON.stringify({ config, secrets, clearSecrets, enabled: form.elements.enabled.checked }) });
      $('integrationModal').hidden = true;
      await loadIntegrations();
      toast('Integration settings encrypted and saved.');
    } catch (error) { toast(error.message, true); }
  }

  async function verifyIntegration(provider) {
    try {
      const data = await api(`/api/divedeep/integrations/${encodeURIComponent(provider)}/verify`, { method: 'POST', body: '{}' });
      await loadIntegrations();
      toast(data.integration.verificationMessage || 'Configuration checked.', data.integration.verificationStatus === 'invalid');
    } catch (error) { toast(error.message, true); }
  }

  async function verifyRekognition(action) {
    try {
      const data = await api(`/api/divedeep/integrations/aws_rekognition/${action}`, { method: 'POST', body: '{}' });
      await loadIntegrations();
      toast(action === 'verify-identity' ? `AWS identity verified: ${data.result?.arn || data.result?.account || 'connected'}` : 'Rekognition access verified with the built-in fixture.');
    } catch (error) { toast(error.message, true); }
  }

  async function verifyCloudRunAccess() {
    try {
      const data = await api('/api/divedeep/integrations/google_cloud_run/verify-access', { method: 'POST', body: '{}' });
      await loadIntegrations();
      toast(`Cloud Run Job verified: ${data.result?.resourceName || 'connected'}`);
    } catch (error) { toast(error.message, true); }
  }

  async function verifyStorageAccess() {
    try {
      const data = await api('/api/divedeep/integrations/object_storage/verify-access', { method: 'POST', body: '{}' });
      await loadIntegrations();
      toast(`Private storage verified: ${data.result?.bucket || 'connected'}`);
    } catch (error) { toast(error.message, true); }
  }

  async function downloadLifecycleTemplate() {
    try {
      const data = await api('/api/divedeep/storage/lifecycle-template');
      const blob = new Blob([JSON.stringify(data.template, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'divedeep-storage-lifecycle-template.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) { toast(error.message, true); }
  }

  async function disconnectIntegration(provider) {
    if (!confirm('Disable this integration and permanently remove its stored credentials?')) return;
    try {
      await api(`/api/divedeep/integrations/${encodeURIComponent(provider)}`, { method: 'DELETE' });
      await loadIntegrations();
      toast('Integration disabled and protected credentials removed.');
    } catch (error) { toast(error.message, true); }
  }

  async function loadIntegrationAudit() {
    try {
      const data = await api('/api/divedeep/integration-events?limit=200');
      $('integrationAudit').innerHTML = data.events.length ? data.events.map((event) => `<div class="fida-audit-row"><div><strong>${esc(title(event.provider))}</strong><br><small>${esc(event.actorId || 'system')}</small></div><div>${esc(title(event.eventType))}<br><small>${esc(Object.keys(event.details || {}).join(', ') || 'No secret-bearing details')}</small></div><small>${esc(date(event.createdAt))}</small></div>`).join('') : '<div class="fida-empty">No integration changes recorded.</div>';
    } catch (error) { $('integrationAudit').innerHTML = `<div class="fida-empty">${esc(error.message)}</div>`; }
  }

  function wireShell() {
    document.querySelectorAll('.fida-nav-item[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
    document.querySelectorAll('[data-workflow]').forEach((button) => button.addEventListener('click', () => { state.queueWorkflow = button.dataset.workflow; renderQueueTabs(); renderQueue(); }));
    $('globalSearch').addEventListener('input', (event) => { state.search = event.target.value.trim(); renderQueue(); });
    $('globalSearch').addEventListener('keydown', (event) => { if (event.key === 'Enter' && visibleCustomers()[0]) selectCustomer(visibleCustomers()[0].id); });
    document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('globalSearch').focus(); } if (event.key === 'Escape') { $('integrationModal').hidden = true; $('resultImportModal').hidden = true; $('catalogModal').hidden = true; $('workerPoolModal').hidden = true; } });
    $('refreshDashboard').addEventListener('click', () => loadDashboard().catch((error) => toast(error.message, true)));
    $('exportSelected').addEventListener('click', () => downloadExport('json'));
    $('exportImageBundle').addEventListener('click', () => downloadImageReconBundle($('exportImageBundle')));
    $('importBundle').addEventListener('click', () => {
      state.resultImport = { files: new Map(), aliases: new Map(), digests: new Map(), manifest: null, manifestFile: null, archiveFile: null, batch: null, running: false, uploadProgress: 0, sourceLabel: '' };
      $('resultBundleFolder').value = '';
      $('resultBundleFiles').value = '';
      $('resultImportModal').hidden = false;
      renderResultImport();
    });
    $('importResults').addEventListener('click', () => $('divedeepResultsFile').click());
    $('divedeepResultsFile').addEventListener('change', (event) => importDiveDeepResults(event.target.files?.[0]));
    $('chooseResultFolder').addEventListener('click', chooseResultFolder);
    $('chooseResultFiles').addEventListener('click', () => $('resultBundleFiles').click());
    $('resultBundleFolder').addEventListener('change', async (event) => {
      const files = [...event.target.files];
      const label = event.target.files?.[0]?.webkitRelativePath?.split('/')[0] || 'Selected folder';
      event.target.value = '';
      try { await adoptResultFiles(files, label); } catch (error) { toast(error.message, true); }
    });
    $('resultBundleFiles').addEventListener('change', async (event) => {
      const files = [...event.target.files];
      const label = event.target.files?.[0]?.name || 'Selected files';
      event.target.value = '';
      try { await adoptResultFiles(files, label); } catch (error) { toast(error.message, true); }
    });
    $('validateResultBundle').addEventListener('click', () => validateResultBundle().catch((error) => toast(error.message, true)));
    $('startResultImport').addEventListener('click', startResultImport);
    $('publishResultBatch').addEventListener('click', () => state.resultImport.batch && publishBatchById(state.resultImport.batch.id));
    const resultDrop = $('resultBundleDrop');
    ['dragenter', 'dragover'].forEach((name) => resultDrop.addEventListener(name, (event) => { event.preventDefault(); resultDrop.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((name) => resultDrop.addEventListener(name, (event) => { event.preventDefault(); resultDrop.classList.remove('dragover'); }));
    resultDrop.addEventListener('drop', async (event) => { try { await adoptResultFiles(await droppedResultFiles(event.dataTransfer), 'Dropped bundle'); } catch (error) { toast(error.message, true); } });
    $('refreshCustomersView').addEventListener('click', async () => { await loadDashboard(); await loadCustomersOperations(); });
    $('refreshWorkQueue').addEventListener('click', loadWorkQueue);
    $('refreshPrivacyWorkflow').addEventListener('click', loadPrivacyWorkflows);
    $('refreshReconJobs').addEventListener('click', loadReconJobs);
    $('refreshWorkerPools').addEventListener('click', loadWorkerPools);
    if ($('runWorkerLeaseSweep')) $('runWorkerLeaseSweep').addEventListener('click', runWorkerLeaseSweep);
    $('addWorkerPool').addEventListener('click', () => openWorkerPoolModal());
    $('workerPoolForm').addEventListener('submit', saveWorkerPool);
    document.querySelectorAll('[data-close-worker-pool-modal]').forEach((button) => button.addEventListener('click', () => { $('workerPoolModal').hidden = true; }));
    $('workerPoolModal').addEventListener('click', (event) => { if (event.target === $('workerPoolModal')) $('workerPoolModal').hidden = true; });
    $('refreshFindings').addEventListener('click', loadReviewQueues);
    $('refreshEvidenceReview').addEventListener('click', loadReviewQueues);
    $('refreshCasesView').addEventListener('click', loadCaseQueue);
    $('refreshMonitoring').addEventListener('click', loadMonitoringQueue);
    $('refreshRetention').addEventListener('click', loadRetentionQueue);
    if ($('runRetentionSweep')) $('runRetentionSweep').addEventListener('click', runRetentionSweep);
    $('refreshCatalog').addEventListener('click', loadCatalog);
    document.querySelectorAll('[data-open-integrations-view]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); showView('integrations'); }));
    document.querySelectorAll('[data-catalog-tab]').forEach((button) => button.addEventListener('click', () => setCatalogTab(button.dataset.catalogTab)));
    $('catalogResourceSearch').addEventListener('input', renderCatalogResources);
    $('catalogResourceStatus').addEventListener('change', renderCatalogResources);
    $('catalogResourceSensitivity').addEventListener('change', renderCatalogResources);
    $('addCatalogResource').addEventListener('click', () => openCatalogModal('resource'));
    $('addCatalogPool').addEventListener('click', () => openCatalogModal('pool'));
    $('addSourceSet').addEventListener('click', () => openCatalogModal('source-set'));
    $('addMetadataSchema').addEventListener('click', () => openCatalogModal('schema'));
    $('catalogForm').addEventListener('submit', submitCatalogForm);
    document.querySelectorAll('[data-close-catalog-modal]').forEach((button) => button.addEventListener('click', () => { $('catalogModal').hidden = true; }));
    $('catalogModal').addEventListener('click', (event) => { if (event.target === $('catalogModal')) $('catalogModal').hidden = true; });
    $('refreshIntegrations').addEventListener('click', loadIntegrations);
    $('refreshPackages').addEventListener('click', loadPackages);
    $('refreshPilotCodes').addEventListener('click', loadPilotCodes);
    $('pilotCodeForm').addEventListener('submit', createPilotCode);
    $('integrationForm').addEventListener('submit', saveIntegration);
    document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { $('integrationModal').hidden = true; }));
    $('integrationModal').addEventListener('click', (event) => { if (event.target === $('integrationModal')) $('integrationModal').hidden = true; });
    document.querySelectorAll('[data-close-import-modal]').forEach((button) => button.addEventListener('click', () => { $('resultImportModal').hidden = true; }));
    $('resultImportModal').addEventListener('click', (event) => { if (event.target === $('resultImportModal')) $('resultImportModal').hidden = true; });
    $('collapseSidebar').addEventListener('click', () => document.body.classList.toggle('fida-collapsed'));
    $('mobileMenu').addEventListener('click', () => document.body.classList.toggle('fida-menu-open'));
    $('logout').addEventListener('click', async () => { await fetch(base + '/logout', { method: 'POST' }); location.href = base + '/login'; });
  }

  (async () => {
    wireShell();
    try {
      await loadIdentity();
      await loadDashboard({ preserveSelection: false });
    } catch (error) { toast(error.message, true); }
  })();
})();
