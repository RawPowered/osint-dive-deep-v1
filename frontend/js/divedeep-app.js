(() => {
  let session = null;
  let dashboard = null;
  let activeConnectionTab = 'overview';
  let metaSyncStarted = false;
  let loaderTimer = null;
  let loaderSlowTimer = null;
  let bootstrapPromise = null;
  let dashboardLoadPromise = null;
  let dashboardController = null;
  let formsWired = false;
  let bootFailed = false;
  const activeRequestControllers = new Set();
  let findingPage = 1;
  const FINDING_PAGE_SIZE = 20;
  const apiUrl = (path) => {
    const client = window.DiveDeepClient;
    if (!client?.apiOrigin || typeof client.apiUrl !== 'function') {
      throw new Error('DiveDeep is not connected to its API. Upload the installer-generated divedeep-runtime.js file.');
    }
    return client.apiUrl(path);
  };

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  function toast(message, error = false) {
    const el = $('toast');
    el.textContent = message;
    el.className = `fid-toast show${error ? ' error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.className = 'fid-toast'; }, 4200);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function requestJson(url, options = {}) {
    const {
      timeoutMs = 15000,
      retries = 0,
      redirectOnUnauthorized = true,
      signal: externalSignal,
      ...fetchOptions
    } = options;
    const retryableStatuses = new Set([429, 502, 503, 504]);
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      activeRequestControllers.add(controller);
      const abortFromOutside = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', abortFromOutside, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(apiUrl(url), {
          ...fetchOptions,
          cache: fetchOptions.cache || 'no-store',
          credentials: 'include',
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 401 && redirectOnUnauthorized) {
          location.replace('/divedeep/login');
          throw Object.assign(new Error('Session expired'), { code: 'DIVEDEEP_SESSION_EXPIRED' });
        }
        if (!response.ok) {
          const error = Object.assign(new Error(data.error || 'Request failed'), {
            code: data.code || `HTTP_${response.status}`,
            status: response.status,
          });
          if (retryableStatuses.has(response.status) && attempt < retries) {
            const retryAfter = Math.min(Number(response.headers.get('retry-after')) || 1, 5);
            lastError = error;
            await wait((retryAfter * 1000) + (attempt * 400));
            continue;
          }
          throw error;
        }
        return data;
      } catch (error) {
        const abortedByCaller = Boolean(externalSignal?.aborted);
        const timedOut = error?.name === 'AbortError' && !abortedByCaller;
        const normalized = timedOut
          ? Object.assign(new Error('The DiveDeep server did not respond in time.'), { code: 'DIVEDEEP_REQUEST_TIMEOUT' })
          : error;
        lastError = normalized;
        const retryableNetworkError = timedOut || error?.name === 'TypeError';
        if (!abortedByCaller && retryableNetworkError && attempt < retries) {
          await wait(600 + (attempt * 700));
          continue;
        }
        throw normalized;
      } finally {
        clearTimeout(timer);
        activeRequestControllers.delete(controller);
        if (externalSignal) externalSignal.removeEventListener('abort', abortFromOutside);
      }
    }
    throw lastError || new Error('Request failed');
  }

  async function api(url, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET' && session?.csrfToken) headers['X-DiveDeep-CSRF'] = session.csrfToken;
    return requestJson(url, {
      ...options,
      method,
      headers,
      timeoutMs: options.timeoutMs || (method === 'GET' ? 18000 : 45000),
      retries: options.retries == null ? (method === 'GET' ? 1 : 0) : options.retries,
    });
  }

  function formatDate(value) {
    if (!value) return 'Not available';
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
    catch { return value; }
  }

  function titleCase(value) {
    return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function chip(status) {
    const s = String(status || 'unknown');
    let tone = 'info';
    if (['removed', 'completed', 'connected', 'active'].includes(s)) tone = 'success';
    else if (['confirmed', 'reappeared', 'denied', 'failed', 'error'].includes(s)) tone = 'danger';
    else if (['review', 'open', 'pending', 'needs_action', 'queued', 'sent', 'acknowledged'].includes(s)) tone = 'warning';
    return `<span class="fid-chip ${tone}">${escapeHtml(titleCase(s))}</span>`;
  }

  function providerIconMarkup(provider) {
    const label = titleCase(provider || 'other');
    const key = String(provider || 'other').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'other';
    const monogram = label.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
    return `<span class="fid-provider-icon ${escapeHtml(key)}" aria-hidden="true">${escapeHtml(monogram)}</span>`;
  }

  function showBootLoader() {
    const overlay = $('bootLoader');
    const card = overlay?.querySelector('.fid-loading-card');
    const label = $('bootLoaderMessage');
    const actions = $('bootLoaderActions');
    if (!overlay || !label) return;
    const messages = [
      'Loading your protected profile…',
      'Synchronizing authorized customer details…',
      'Preparing your privacy overview…'
    ];
    let index = 0;
    bootFailed = false;
    overlay.classList.remove('hidden');
    card?.classList.remove('failed');
    if (actions) actions.hidden = true;
    label.textContent = messages[0];
    clearInterval(loaderTimer);
    clearTimeout(loaderSlowTimer);
    loaderTimer = setInterval(() => {
      index = (index + 1) % messages.length;
      label.textContent = messages[index];
    }, 1200);
    loaderSlowTimer = setTimeout(() => {
      if (!bootFailed) label.textContent = 'Still connecting securely. DiveDeep will retry automatically…';
    }, 6500);
  }

  function showBootFailure(message) {
    bootFailed = true;
    clearInterval(loaderTimer);
    clearTimeout(loaderSlowTimer);
    const overlay = $('bootLoader');
    const card = overlay?.querySelector('.fid-loading-card');
    const label = $('bootLoaderMessage');
    const actions = $('bootLoaderActions');
    if (overlay) overlay.classList.remove('hidden');
    card?.classList.add('failed');
    if (label) label.textContent = message || 'DiveDeep could not finish loading this workspace.';
    if (actions) actions.hidden = false;
  }

  function hideBootLoader() {
    clearInterval(loaderTimer);
    clearTimeout(loaderSlowTimer);
    const overlay = $('bootLoader');
    if (overlay) overlay.classList.add('hidden');
  }

  function emptyState(title, body) {
    return `<div class="fid-empty fid-empty-rich"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p></div>`;
  }

  function eventLabel(event) {
    const map = {
      'account.created': 'DiveDeep account created',
      'account.login': 'Customer sign-in',
      'authorization.signed': 'Limited Authorization signed',
      'authorization.revoked': 'Limited Authorization revoked',
      'profile.intake_completed': 'Protected profile completed',
      'profile.identifier_added': 'Identity detail added',
      'profile.visibility_policy_updated': 'Visibility rule updated',
      'profile.photo_uploaded': 'Reference photo uploaded',
      'profile.photo_deleted': 'Reference photo removed',
      'profile.first_scrub_requested': 'First scrub request started',
      'social.connection_added': 'Social profile added',
      'social.connection_disconnected': 'Social profile disconnected',
      'social.facebook_reconnected': 'Facebook profile connected',
      'social.media_synchronized': 'Authorized Meta media synchronized',
      'social.account_protected': 'Owned social profile protected',
      'social.account_protection_removed': 'Owned social profile protection removed',
      'admin.packet_exported': 'Profile packet exported for review',
      'admin.finding_added': 'Online exposure documented',
      'admin.case_transitioned': 'Removal case updated',
      'admin.case_verified': 'Removal verification recorded',
      'admin.customer_updated': 'Service workflow updated',
      'account.plan_changed': 'Service level changed',
    };
    return map[event.eventType] || titleCase(event.eventType);
  }

  function switchPane(name) {
    document.querySelectorAll('.fid-tab').forEach((button) => button.classList.toggle('active', button.dataset.pane === name));
    document.querySelectorAll('.fid-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `pane-${name}`));
    history.replaceState(null, '', `#${name}`);
  }

  function authorizationIsActive() {
    const authorization = dashboard?.authorization;
    return Boolean(authorization && authorization.status === 'active' && (!authorization.expiresAt || new Date(authorization.expiresAt) > new Date()));
  }

  function renderOnboarding() {
    const container = $('onboardingContainer');
    if (!authorizationIsActive()) {
      $('overviewContent').hidden = true;
      container.innerHTML = `
        <section class="fid-onboarding fid-authorization-gate">
          <div class="fid-authorization-gate-icon" aria-hidden="true">✓</div>
          <div><div class="fid-eyebrow">Account created</div><h2>Authorization is required before we can act.</h2>
          <p class="fid-help">Review and sign the Limited Authorization so DiveDeep can submit supported privacy and removal requests for you. Your signature, signing time, authenticated session, and server-observed network information will be recorded.</p>
          <div class="fid-launch-steps"><span class="done"><b>1</b> Create account</span><span><b>2</b> Sign authorization</span><span><b>3</b> Build protected profile</span></div>
          <button id="openAuthorization" class="fid-btn fid-btn-primary" type="button">Review and sign authorization</button></div>
        </section>`;
      $('openAuthorization').addEventListener('click', () => switchPane('authorization'));
      return;
    }
    if (dashboard.profile) {
      container.innerHTML = '';
      $('overviewContent').hidden = false;
      return;
    }
    $('overviewContent').hidden = true;
    const c = dashboard.customer;
    container.innerHTML = `
      <section class="fid-onboarding fid-discovery-launch">
        <div class="fid-eyebrow">Authorization complete</div>
        <h2>Create the protected profile we will use.</h2>
        <p class="fid-help">Your account name and email become your private discovery profile. Next, you can connect a social account or add reference photos, then start your first authorized discovery request.</p>
        <div class="fid-launch-steps"><span class="done"><b>1</b> Sign authorization</span><span><b>2</b> Create profile</span><span><b>3</b> Start discovery</span></div>
        <form id="onboardingForm" class="fid-form-grid">
          <input type="hidden" name="legalName" value="${escapeHtml(c.displayName)}" />
          <label class="fid-field"><span class="fid-label">Country</span><input class="fid-input" name="jurisdictionCountry" value="${escapeHtml(dashboard.authorization?.jurisdictionCountry || 'US')}" /></label>
          <label class="fid-field"><span class="fid-label">State or region</span><input class="fid-input" name="jurisdictionRegion" value="${escapeHtml(dashboard.authorization?.jurisdictionRegion || '')}" placeholder="Florida" required /></label>
          <button class="fid-btn fid-btn-primary full" type="submit">Create my protected profile</button>
          <div id="onboardingError" class="fid-form-error full"></div>
        </form>
      </section>`;
    $('onboardingForm').addEventListener('submit', submitOnboarding);
  }

  function renderAuthorization() {
    const authorization = dashboard.authorization;
    const active = authorizationIsActive();
    $('authorizationStatus').textContent = active ? 'Active' : authorization ? titleCase(authorization.status) : 'Required';
    $('authorizationStatus').className = `fid-status-pill${active ? ' success' : ''}`;
    if (active) {
      const permitted = authorization.scope?.permittedActions || [];
      const limitations = authorization.scope?.limitations || [];
      $('authorizationContent').innerHTML = `
        <section class="fid-authorization-active">
          <div class="fid-authorization-active-head"><div class="fid-authorization-seal">✓</div><div><div class="fid-eyebrow">Authorization active</div><h2>DiveDeep may perform the limited actions you approved.</h2><p>Signed ${escapeHtml(formatDate(authorization.signedAt))} · Expires ${escapeHtml(formatDate(authorization.expiresAt))}</p></div></div>
          <div class="fid-authorization-meta"><div><span>Authorization ID</span><strong>${escapeHtml(authorization.id)}</strong></div><div><span>Signer</span><strong>${escapeHtml(authorization.signerName)}</strong></div><div><span>Document version</span><strong>${escapeHtml(authorization.authorizationVersion)}</strong></div><div><span>Integrity</span><strong>${escapeHtml((authorization.documentSha256 || '').slice(0, 16))}…</strong></div></div>
          <div class="fid-authorization-columns"><article><h3>Authorized activity</h3><ul>${permitted.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></article><article><h3>Authority not granted</h3><ul>${limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></article></div>
          <div class="fid-authorization-actions"><button id="downloadAuthorization" class="fid-btn fid-btn-primary" type="button">Download executed record</button><button id="revokeAuthorization" class="fid-btn fid-btn-danger" type="button">Revoke authorization</button><a class="fid-btn" href="/divedeep/authorized-agent" target="_blank" rel="noopener">Read authorized-agent policy</a></div>
          <p class="fid-help">Revocation stops new submissions. It does not erase the record showing that prior activity was authorized.</p>
        </section>`;
      $('downloadAuthorization').addEventListener('click', downloadAuthorization);
      $('revokeAuthorization').addEventListener('click', revokeAuthorization);
      return;
    }
    const c = dashboard.customer;
    $('authorizationContent').innerHTML = `
      <section class="fid-authorization-intro"><div><div class="fid-eyebrow">Post-signup activation</div><h2>Limited Authorization and Consent</h2><p>This is separate from the Terms. It gives DiveDeep narrowly defined authority to contact supported websites, brokers, platforms, publishers, hosts, and search providers concerning your own information.</p></div><div class="fid-authorization-callout"><strong>Recorded with your signature</strong><span>Server date and time</span><span>Authenticated session</span><span>Network and device metadata</span><span>Versioned document hash</span></div></section>
      ${authorization ? `<div class="fid-authorization-history">Your previous authorization is <strong>${escapeHtml(titleCase(authorization.status))}</strong>. Signing below creates a new active record.</div>` : ''}
      <form id="authorizationForm" class="fid-authorization-form">
        <div class="fid-authorization-section"><span class="fid-step-number">1</span><div><h3>Your legal identity</h3><p>Use the information a request recipient can reasonably associate with you.</p></div></div>
        <div class="fid-form-grid">
          <label class="fid-field full"><span class="fid-label">Full legal name</span><input class="fid-input" name="legalName" maxlength="255" value="${escapeHtml(c.displayName || '')}" autocomplete="name" required /></label>
          <label class="fid-field full"><span class="fid-label">Street address</span><input class="fid-input" name="streetAddress" maxlength="255" autocomplete="street-address" required /></label>
          <label class="fid-field full"><span class="fid-label">Address line 2 <small>(optional)</small></span><input class="fid-input" name="addressLine2" maxlength="255" /></label>
          <label class="fid-field"><span class="fid-label">City</span><input class="fid-input" name="city" maxlength="128" autocomplete="address-level2" required /></label>
          <label class="fid-field"><span class="fid-label">State or region</span><input class="fid-input" name="jurisdictionRegion" maxlength="128" autocomplete="address-level1" required /></label>
          <label class="fid-field"><span class="fid-label">Postal code</span><input class="fid-input" name="postalCode" maxlength="32" autocomplete="postal-code" required /></label>
          <label class="fid-field"><span class="fid-label">Country</span><input class="fid-input" name="jurisdictionCountry" maxlength="64" value="US" autocomplete="country-name" required /></label>
          <label class="fid-field full"><span class="fid-label">Phone <small>(optional)</small></span><input class="fid-input" name="phone" maxlength="64" autocomplete="tel" /></label>
        </div>
        <div class="fid-authorization-section"><span class="fid-step-number">2</span><div><h3>Review the authority</h3><p>DiveDeep may make supported privacy, suppression, opt-out, deletion, image-removal, and verification requests. It may disclose only the identifiers reasonably needed for a recipient to match your record.</p></div></div>
        <div class="fid-consent-stack">
          <label class="fid-check"><input type="checkbox" name="signingForSelf" required /><span>I am an adult signing for myself. I am not using this form to act for another adult.</span></label>
          <label class="fid-check"><input type="checkbox" name="agencyConsent" required /><span>I appoint DiveDeep as my limited authorized agent for the privacy and removal activity described in the <a href="/divedeep/authorized-agent" target="_blank" rel="noopener">Authorized-Agent Policy</a>.</span></label>
          <label class="fid-check"><input type="checkbox" name="dataDisclosureConsent" required /><span>I authorize DiveDeep to disclose the minimum identifiers and evidence reasonably required to locate my records and process an authorized request.</span></label>
          <label class="fid-check"><input type="checkbox" name="accuracyAttested" required /><span>I attest that my information is accurate and that I will not use the service to conceal fraud, evade lawful obligations, or interfere with lawful records.</span></label>
          <label class="fid-check"><input type="checkbox" name="electronicRecordsConsent" required /><span>I consent to electronic records and signatures and reviewed the <a href="/divedeep/electronic-records" target="_blank" rel="noopener">Electronic Records Disclosure</a>.</span></label>
        </div>
        <div class="fid-authorization-section"><span class="fid-step-number">3</span><div><h3>Sign and date</h3><p>Type your full legal name exactly as entered above. The authoritative signing date is generated by the server.</p></div></div>
        <label class="fid-field"><span class="fid-label">Typed electronic signature</span><input class="fid-input fid-signature-input" name="typedSignature" maxlength="255" autocomplete="off" required /></label>
        <label class="fid-check"><input type="checkbox" name="signatureIntent" required /><span>By selecting “Sign and activate,” I intend to sign this authorization electronically and understand that DiveDeep will record technical evidence of execution.</span></label>
        <div class="fid-legal-links"><a href="/divedeep/privacy" target="_blank" rel="noopener">Privacy Policy</a><a href="/divedeep/responsible-data" target="_blank" rel="noopener">Responsible Data Use</a><a href="/divedeep/notice-at-collection" target="_blank" rel="noopener">Notice at Collection</a></div>
        <div id="authorizationError" class="fid-form-error" role="alert"></div>
        <button class="fid-btn fid-btn-primary fid-btn-block" type="submit">Sign and activate DiveDeep</button>
      </form>`;
    $('authorizationForm').addEventListener('submit', submitAuthorization);
  }

  async function submitAuthorization(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const error = $('authorizationError');
    error.textContent = '';
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      for (const name of ['signingForSelf', 'electronicRecordsConsent', 'agencyConsent', 'dataDisclosureConsent', 'accuracyAttested', 'signatureIntent']) payload[name] = Boolean(form.elements[name]?.checked);
      payload.localDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' }).format(new Date());
      payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const result = await api('/divedeep/api/authorization', { method: 'POST', body: JSON.stringify(payload) });
      dashboard = result.dashboard;
      renderAll();
      switchPane('overview');
      toast('Authorization signed. You can now create your protected profile.');
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  }

  async function downloadAuthorization() {
    try {
      const authorization = dashboard.authorization;
      const response = await fetch(apiUrl(`/divedeep/api/authorization/${encodeURIComponent(authorization.id)}/document`), { credentials: 'include' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Unable to download authorization');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `divedeep-authorization-${authorization.id}.html`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { toast(error.message, true); }
  }

  async function revokeAuthorization() {
    if (!confirm('Revoke DiveDeep’s authority to initiate new requests for you? Existing request and audit records will remain documented.')) return;
    try {
      const result = await api('/divedeep/api/authorization/revoke', { method: 'POST', body: JSON.stringify({ reason: 'Revoked by customer from dashboard' }) });
      dashboard = result.dashboard;
      renderAll();
      toast('Authorization revoked. New discovery and removal activity is blocked.');
    } catch (error) { toast(error.message, true); }
  }

  async function submitOnboarding(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const error = $('onboardingError');
    error.textContent = '';
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      payload.planTier = dashboard.customer.planTier;
      const result = await api('/divedeep/api/onboarding', { method: 'POST', body: JSON.stringify(payload) });
      dashboard = result.dashboard;
      renderAll();
      switchPane('connections');
      toast('Your discovery profile is ready. Connect Facebook or add reference photos next.');
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  }

  function renderOverview() {
    const stats = dashboard.stats || {};
    $('customerName').textContent = dashboard.customer.displayName || dashboard.customer.email;
    $('workflowStatus').textContent = titleCase(dashboard.customer.workflowStatus);
    $('statFound').textContent = stats.found || 0;
    $('statPresent').textContent = stats.stillPresent || 0;
    $('statSent').textContent = stats.requestsSent || 0;
    $('statRemoved').textContent = stats.removed || 0;

    const findings = dashboard.exposures.slice(0, 4);
    $('recentFindings').innerHTML = findings.length ? findings.map(findingCard).join('') : emptyState('No findings have been added yet.', 'This is normal before evidence has been imported. Your intake is waiting for review and this area will populate as authorized discovery results are added.');
    const events = dashboard.events.slice(0, 8);
    $('activityTimeline').innerHTML = events.length ? events.map((event) => `
      <div class="fid-timeline-item"><span class="fid-timeline-dot"></span><div><p>${escapeHtml(eventLabel(event))}</p><time>${escapeHtml(formatDate(event.createdAt))}</time></div></div>
    `).join('') : emptyState('No activity yet.', 'A clear timeline of profile, discovery, and removal progress will appear here.');
  }

  function findingCard(item) {
    const sensitive = String(item.contentCategory || '').toLowerCase().includes('adult') || String(item.contentCategory || '').toLowerCase().includes('sensitive');
    const evidence = (dashboard.evidenceFiles || []).filter((record) => record.exposureId === item.id);
    const body = `
      <div class="fid-row-top"><div class="fid-row-title">${escapeHtml(item.sourceName || item.domain)}</div>${chip(item.status)}</div>
      <div class="fid-row-meta">${escapeHtml(item.domain || '')} · Match confidence ${Math.round((Number(item.matchConfidence) || 0) * 100)}%</div>
      <div class="fid-row-meta">${escapeHtml(item.subjectIdentifier || item.listingIdentifier || 'Matched profile information')}</div>
      ${evidence.length ? `<div class="fid-evidence-grid">${evidence.slice(0, 6).map((record) => `<button class="fid-evidence-tile" data-customer-evidence="${escapeHtml(record.id)}">View ${escapeHtml(titleCase(record.evidenceType))}</button>`).join('')}</div>` : ''}
      <div class="fid-toolbar"><a class="fid-btn fid-btn-sm" href="${escapeHtml(item.listingUrl)}" target="_blank" rel="noopener noreferrer">Open source</a><span class="fid-chip info">${escapeHtml(titleCase(item.visibilityAction))}</span></div>`;
    if (!sensitive) return `<article class="fid-row">${body}</article>`;
    return `<article class="fid-row fid-sensitive-card"><div class="fid-sensitive-overlay"><button class="fid-btn fid-btn-danger fid-btn-sm" data-reveal-sensitive>Reveal sensitive finding</button></div><div class="fid-sensitive-body">${body}</div></article>`;
  }

  async function loadFindingPage(page) {
    const pager = $('findingPager');
    const list = $('findingList');
    pager?.classList.add('loading');
    if (list) list.setAttribute('aria-busy', 'true');
    try {
      const result = await api(`/divedeep/api/findings?page=${encodeURIComponent(page)}&pageSize=${FINDING_PAGE_SIZE}`, {
        timeoutMs: 18000,
        retries: 1,
      });
      dashboard.exposures = result.exposures || [];
      dashboard.evidenceFiles = result.evidenceFiles || [];
      dashboard.findingPagination = result.pagination || {};
      findingPage = Number(dashboard.findingPagination.page) || 1;
      renderFindings();
      document.getElementById('pane-findings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      toast(error.message, true);
      renderFindings();
    } finally {
      pager?.classList.remove('loading');
      if (list) list.removeAttribute('aria-busy');
    }
  }

  function renderFindings() {
    const findings = dashboard.exposures || [];
    const pagination = dashboard.findingPagination || {
      page: 1,
      pageSize: FINDING_PAGE_SIZE,
      pageCount: 1,
      total: findings.length,
      hasPrevious: false,
      hasNext: false,
    };
    findingPage = Number(pagination.page) || 1;
    $('findingList').innerHTML = findings.length
      ? findings.map(findingCard).join('')
      : emptyState('No online exposures have been documented yet.', 'This is not an error. Findings will appear here after the privacy team imports verified evidence from authorized review work.');
    const pager = $('findingPager');
    if (pager) {
      const total = Number(pagination.total) || findings.length;
      const pageCount = Math.max(Number(pagination.pageCount) || 1, 1);
      pager.hidden = total <= Number(pagination.pageSize || FINDING_PAGE_SIZE);
      pager.innerHTML = `<button class="fid-btn fid-btn-sm" data-finding-page="${findingPage - 1}" ${pagination.hasPrevious ? '' : 'disabled'}>Previous</button><span>Page ${findingPage} of ${pageCount} · showing ${findings.length} of ${total}</span><button class="fid-btn fid-btn-sm" data-finding-page="${findingPage + 1}" ${pagination.hasNext ? '' : 'disabled'}>Next</button>`;
      pager.querySelectorAll('[data-finding-page]').forEach((button) => button.addEventListener('click', () => {
        if (button.disabled) return;
        pager.querySelectorAll('button').forEach((item) => { item.disabled = true; });
        loadFindingPage(Number(button.dataset.findingPage) || 1);
      }));
    }
    document.querySelectorAll('[data-reveal-sensitive]').forEach((button) => button.addEventListener('click', () => button.closest('.fid-sensitive-card').classList.add('revealed')));
    document.querySelectorAll('[data-customer-evidence]').forEach((button) => button.addEventListener('click', () => loadCustomerEvidence(button)));
  }

  async function loadCustomerEvidence(button) {
    try {
      button.disabled = true;
      const response = await fetch(apiUrl(`/divedeep/api/evidence/${encodeURIComponent(button.dataset.customerEvidence)}`), { credentials: 'include' });
      if (!response.ok) throw new Error('Evidence image could not be opened');
      const url = URL.createObjectURL(await response.blob());
      button.innerHTML = `<img src="${url}" alt="Published evidence" />`;
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }

  function renderRequests() {
    $('requestList').innerHTML = dashboard.cases.length ? dashboard.cases.map((item) => `
      <article class="fid-row">
        <div class="fid-row-top"><div class="fid-row-title">${escapeHtml(item.emailSubject || titleCase(item.requestType))}</div>${chip(item.state)}</div>
        <div class="fid-row-meta">Delivery: ${escapeHtml(titleCase(item.deliveryMethod))}${item.recipientEmail ? ` · ${escapeHtml(item.recipientEmail)}` : ''}</div>
        <div class="fid-row-meta">Created ${escapeHtml(formatDate(item.createdAt))}${item.sentAt ? ` · Sent ${escapeHtml(formatDate(item.sentAt))}` : ''}</div>
        ${item.confirmationReference ? `<div class="fid-row-meta">Confirmation: ${escapeHtml(item.confirmationReference)}</div>` : ''}
      </article>`).join('') : emptyState('No removal activity yet.', 'Removal requests will appear here after a finding has been verified and prepared for action.');
  }

  function renderProfile() {
    $('profileEmpty').hidden = Boolean(dashboard.profile);
    $('profileContent').hidden = !dashboard.profile;
    if (!dashboard.profile) return;
    $('identifierList').innerHTML = dashboard.profile.identifiers.map((item) => `
      <div class="fid-identifier"><b>${escapeHtml(item.type)}</b><span>${escapeHtml(item.value)}</span></div>`).join('');
    $('policyList').innerHTML = dashboard.profile.policies.length ? dashboard.profile.policies.map((item) => `
      <div class="fid-row"><div class="fid-row-top"><div class="fid-row-title">${escapeHtml(item.scopeType)}: ${escapeHtml(item.scopeValue || '*')}</div>${chip(item.action)}</div><div class="fid-row-meta">Priority ${item.priority}</div></div>`).join('') : '<div class="fid-empty">No custom visibility rules.</div>';
    renderPhotos();
  }

  function renderConnections() {
    const list = dashboard.connections;
    $('connectionList').innerHTML = list.length ? list.map((item) => `
      <article class="fid-connection">
        <div class="fid-row-top"><div class="fid-connection-provider">${providerIconMarkup(item.provider)}<strong>${escapeHtml(item.provider)}</strong></div>${chip(item.status)}</div>
        <div class="fid-row-meta">${escapeHtml(item.displayName || item.username || 'Connected profile')}</div>
        ${item.connectionMode === 'oauth' ? `<div class="fid-row-meta">${item.scopes.length} provider permissions granted</div>` : ''}
        ${item.profileUrl ? `<a href="${escapeHtml(item.profileUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.profileUrl)}</a>` : ''}
        <div class="fid-toolbar" style="margin-top:10px"><button class="fid-btn fid-btn-danger fid-btn-sm" data-disconnect="${escapeHtml(item.id)}">Disconnect</button></div>
      </article>`).join('') : '<div class="fid-empty">No profiles connected yet. Add profile URLs or connect Facebook when enabled.</div>';
    $('facebookConnect').style.display = session.config?.facebookConnectionEnabled ? 'inline-flex' : 'none';
    $('facebookConnect').href = apiUrl('/divedeep/connect/facebook');
    const facebook = list.find((item) => item.provider === 'facebook' && item.connectionMode === 'oauth' && item.status === 'connected');
    const connectedFacebook = Boolean(facebook);
    const albumAvailable = connectedFacebook && session.config?.facebookAlbumImportEnabled && facebook.scopes.includes('user_photos');
    const instagramAvailable = connectedFacebook && session.config?.instagramMediaImportEnabled &&
      facebook.scopes.includes('instagram_basic') && facebook.scopes.includes('pages_show_list');
    $('metaSync').hidden = !connectedFacebook;
    $('facebookAlbumPicker').dataset.available = albumAvailable ? 'true' : 'false';
    $('instagramMediaPicker').dataset.available = instagramAvailable ? 'true' : 'false';
    if (albumAvailable) {
      $('loadFacebookAlbums').onclick = loadFacebookAlbums;
      $('facebookAlbumList').innerHTML = '<div class="fid-empty">Load an album to choose private reference photos.</div>';
      $('facebookPhotoList').innerHTML = '';
    }
    if (instagramAvailable) {
      $('loadInstagramAccounts').onclick = loadInstagramAccounts;
      $('instagramAccountList').innerHTML = '<div class="fid-empty">Load a linked professional account to choose reference images.</div>';
      $('instagramMediaList').innerHTML = '';
    }
    renderProtectionList();
    updateConnectionSections();
    document.querySelectorAll('[data-disconnect]').forEach((button) => button.addEventListener('click', () => disconnectConnection(button.dataset.disconnect)));
    if (connectedFacebook && !metaSyncStarted) {
      metaSyncStarted = true;
      syncMetaData(true);
    }
  }

  function updateConnectionSections() {
    document.querySelectorAll('[data-connection-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.connectionTab === activeConnectionTab);
    });
    document.querySelectorAll('[data-connection-section]').forEach((section) => {
      const matches = section.dataset.connectionSection === activeConnectionTab;
      const providerAvailable = !section.dataset.available || section.dataset.available === 'true';
      section.hidden = !(matches && providerAvailable);
    });
  }

  async function switchConnectionTab(name) {
    activeConnectionTab = name;
    updateConnectionSections();
    if (name === 'facebook-images') await loadMediaCatalog('facebook', 'image');
    if (name === 'facebook-posts') await loadMediaCatalog('facebook', 'post');
    if (name === 'instagram-images') await loadMediaCatalog('instagram', 'image');
  }

  function renderProtectionList() {
    const connections = dashboard.connections.filter((item) => item.profileUrl && item.status === 'connected');
    $('accountProtectionList').innerHTML = connections.length ? connections.map((item) => `
      <div class="fid-row fid-protection-row ${item.protectedFromRemoval ? 'protected' : ''}">
        <div><strong>${escapeHtml(item.provider)} · ${escapeHtml(item.displayName || item.username || 'Owned profile')}</strong>
        <small>${escapeHtml(item.profileUrl)}${item.protectedFromRemoval ? ' · Protected from removal requests' : ' · Eligible for normal review'}</small></div>
        <button class="fid-btn fid-btn-sm ${item.protectedFromRemoval ? 'fid-btn-secondary' : 'fid-btn-primary'}"
          data-account-protection="${escapeHtml(item.id)}" data-protected="${item.protectedFromRemoval ? 'true' : 'false'}">
          ${item.protectedFromRemoval ? 'Remove protection' : 'Protect this account'}
        </button>
      </div>`).join('') : '<div class="fid-empty">Connect or add an owned profile URL before creating account protection.</div>';
    document.querySelectorAll('[data-account-protection]').forEach((button) => button.addEventListener('click', () => setAccountProtection(button)));
  }

  async function setAccountProtection(button) {
    button.disabled = true;
    const protect = button.dataset.protected !== 'true';
    try {
      await api(`/divedeep/api/connections/${encodeURIComponent(button.dataset.accountProtection)}/protection`, {
        method: 'PUT',
        body: JSON.stringify({ protected: protect }),
      });
      await reloadDashboard();
      toast(protect ? 'Owned account protected from scrub and removal requests.' : 'Account protection removed.');
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }

  async function syncMetaData(silent = false) {
    const status = $('metaSyncStatus');
    status.className = 'fid-sync-status';
    status.textContent = 'Synchronizing authorized Facebook and Instagram data…';
    $('metaSync').disabled = true;
    try {
      const data = await api('/divedeep/api/connections/meta/sync', { method: 'POST', body: '{}' });
      const summary = data.summary || {};
      const counts = `${Number(summary.facebookImages) || 0} Facebook images, ${Number(summary.facebookPosts) || 0} posts, and ${Number(summary.instagramImages) || 0} Instagram items`;
      const missing = summary.permissions?.missing || [];
      status.textContent = summary.errors?.length
        ? `Sync completed with limited access: ${counts}. ${summary.errors.map((item) => item.message).join(' ')}`
        : missing.length
          ? `Sync complete with limited permissions: ${counts}. Reconnect Meta to grant: ${missing.join(', ')}.`
          : `Sync complete: ${counts}.`;
      status.classList.toggle('error', Boolean(summary.errors?.length || missing.length));
      await reloadDashboard();
      if (activeConnectionTab === 'facebook-images') await loadMediaCatalog('facebook', 'image');
      if (activeConnectionTab === 'facebook-posts') await loadMediaCatalog('facebook', 'post');
      if (activeConnectionTab === 'instagram-images') await loadMediaCatalog('instagram', 'image');
      if (!silent) toast('Authorized Meta data synchronized.');
    } catch (error) {
      status.textContent = error.message;
      status.className = 'fid-sync-status error';
      if (!silent) toast(error.message, true);
    } finally { $('metaSync').disabled = false; }
  }

  async function loadMediaCatalog(provider, itemType) {
    const target = provider === 'instagram' ? $('instagramLibraryList') : itemType === 'post' ? $('facebookPostList') : $('facebookLibraryList');
    target.innerHTML = '<div class="fid-empty">Loading synchronized media…</div>';
    try {
      const data = await api(`/divedeep/api/connections/media?provider=${encodeURIComponent(provider)}&itemType=${encodeURIComponent(itemType)}&limit=300`);
      if (itemType === 'post') {
        target.innerHTML = data.items.length ? data.items.map((item) => `
          <article class="fid-row fid-media-post"><div class="fid-row-top"><strong>${escapeHtml(formatDate(item.publishedAt))}</strong>${chip(item.status)}</div>
          <p>${escapeHtml(item.caption || 'Facebook post')}</p>${item.permalink ? `<a href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener noreferrer">Open on Facebook</a>` : ''}</article>`).join('')
          : '<div class="fid-empty">No Facebook posts were synchronized. Reconnect Facebook if the user_posts permission was added after the original connection.</div>';
        return;
      }
      target.innerHTML = data.items.length ? data.items.map((item) => {
        const accountId = item.metadata?.accountId || '';
        const preview = provider === 'instagram'
          ? `/divedeep/api/connections/instagram/accounts/${encodeURIComponent(accountId)}/media/${encodeURIComponent(item.externalItemId)}/preview`
          : `/divedeep/api/connections/facebook/photos/${encodeURIComponent(item.externalItemId)}/preview`;
        const whitelisted = item.selectionStatus === 'whitelisted';
        return `<article class="fid-album-photo"><img src="${escapeHtml(apiUrl(preview))}" alt="${escapeHtml(provider)} image preview" loading="lazy" />
          <div><strong>${escapeHtml(item.caption || `${titleCase(provider)} image`)}</strong>
          <span class="fid-media-state">${whitelisted ? 'Already in visual whitelist' : escapeHtml(formatDate(item.publishedAt))}</span>
          <button class="fid-btn ${whitelisted ? 'fid-btn-secondary' : 'fid-btn-primary'} fid-btn-sm"
            data-catalog-provider="${escapeHtml(provider)}" data-catalog-item="${escapeHtml(item.externalItemId)}"
            data-catalog-account="${escapeHtml(accountId)}" ${whitelisted ? 'disabled' : ''}>${whitelisted ? 'Whitelisted' : 'Add to whitelist'}</button></div></article>`;
      }).join('') : `<div class="fid-empty">No authorized ${escapeHtml(provider)} images were synchronized. Reconnect the account if its media permission was added later.</div>`;
      target.querySelectorAll('[data-catalog-item]').forEach((button) => button.addEventListener('click', () => whitelistCatalogItem(button)));
    } catch (error) { target.innerHTML = `<div class="fid-empty">${escapeHtml(error.message)}</div>`; }
  }

  async function whitelistCatalogItem(button) {
    if (button.dataset.catalogProvider === 'instagram') {
      button.dataset.instagramAccountId = button.dataset.catalogAccount;
      button.dataset.instagramMedia = button.dataset.catalogItem;
      await whitelistInstagramMedia(button);
      await loadMediaCatalog('instagram', 'image');
    } else {
      button.dataset.facebookPhoto = button.dataset.catalogItem;
      await whitelistFacebookPhoto(button);
      await loadMediaCatalog('facebook', 'image');
    }
  }

  async function loadFacebookAlbums() {
    $('facebookAlbumError').textContent = '';
    try {
      const data = await api('/divedeep/api/connections/facebook/albums');
      $('facebookAlbumList').innerHTML = data.albums.length ? data.albums.map((album) => `<button class="fid-row fid-album-row" data-facebook-album="${escapeHtml(album.id)}"><span><strong>${escapeHtml(album.name)}</strong><small>${Number(album.count) || 0} photos</small></span><span>Choose</span></button>`).join('') : '<div class="fid-empty">No accessible Facebook albums were returned.</div>';
      document.querySelectorAll('[data-facebook-album]').forEach((button) => button.addEventListener('click', () => loadFacebookAlbumPhotos(button.dataset.facebookAlbum)));
    } catch (error) { $('facebookAlbumError').textContent = error.message; }
  }

  async function loadFacebookAlbumPhotos(albumId) {
    $('facebookAlbumError').textContent = '';
    $('facebookPhotoList').innerHTML = '<div class="fid-empty">Loading album photos…</div>';
    try {
      const data = await api(`/divedeep/api/connections/facebook/albums/${encodeURIComponent(albumId)}/photos`);
      $('facebookPhotoList').innerHTML = data.photos.length ? data.photos.map((photo) => `<article class="fid-album-photo"><img src="${escapeHtml(apiUrl(`/divedeep/api/connections/facebook/photos/${photo.id}/preview`))}" alt="Facebook photo preview" loading="lazy" /><div><strong>${escapeHtml(photo.name || 'Facebook photo')}</strong><button class="fid-btn fid-btn-primary fid-btn-sm" data-facebook-photo="${escapeHtml(photo.id)}">Whitelist this photo</button></div></article>`).join('') : '<div class="fid-empty">No importable photos were returned from this album.</div>';
      document.querySelectorAll('[data-facebook-photo]').forEach((button) => button.addEventListener('click', () => whitelistFacebookPhoto(button)));
    } catch (error) { $('facebookPhotoList').innerHTML = ''; $('facebookAlbumError').textContent = error.message; }
  }

  async function whitelistFacebookPhoto(button) {
    button.disabled = true;
    try {
      await api(`/divedeep/api/connections/facebook/photos/${encodeURIComponent(button.dataset.facebookPhoto)}/whitelist`, { method: 'POST', body: JSON.stringify({ purpose: 'identity_search' }) });
      await reloadDashboard();
      toast('Facebook reference photo encrypted and added to your whitelist.');
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }

  async function loadInstagramAccounts() {
    $('instagramMediaError').textContent = '';
    try {
      const data = await api('/divedeep/api/connections/instagram/accounts');
      $('instagramAccountList').innerHTML = data.accounts.length ? data.accounts.map((account) => `<button class="fid-row fid-album-row" data-instagram-account="${escapeHtml(account.id)}"><span><strong>@${escapeHtml(account.username)}</strong><small>Linked Instagram professional account</small></span><span>Choose</span></button>`).join('') : '<div class="fid-empty">No linked Instagram professional account was returned.</div>';
      document.querySelectorAll('[data-instagram-account]').forEach((button) => button.addEventListener('click', () => loadInstagramMedia(button.dataset.instagramAccount)));
    } catch (error) { $('instagramMediaError').textContent = error.message; }
  }

  async function loadInstagramMedia(accountId) {
    $('instagramMediaError').textContent = '';
    $('instagramMediaList').innerHTML = '<div class="fid-empty">Loading Instagram images…</div>';
    try {
      const data = await api(`/divedeep/api/connections/instagram/accounts/${encodeURIComponent(accountId)}/media`);
      $('instagramMediaList').innerHTML = data.media.length ? data.media.map((media) => `<article class="fid-album-photo"><img src="${escapeHtml(apiUrl(`/divedeep/api/connections/instagram/accounts/${accountId}/media/${media.id}/preview`))}" alt="Instagram image preview" loading="lazy" /><div><strong>${escapeHtml(media.caption || 'Instagram image')}</strong><button class="fid-btn fid-btn-primary fid-btn-sm" data-instagram-media="${escapeHtml(media.id)}" data-instagram-account-id="${escapeHtml(accountId)}">Whitelist this image</button></div></article>`).join('') : '<div class="fid-empty">No importable Instagram images were returned.</div>';
      document.querySelectorAll('[data-instagram-media]').forEach((button) => button.addEventListener('click', () => whitelistInstagramMedia(button)));
    } catch (error) { $('instagramMediaList').innerHTML = ''; $('instagramMediaError').textContent = error.message; }
  }

  async function whitelistInstagramMedia(button) {
    button.disabled = true;
    try {
      await api(`/divedeep/api/connections/instagram/accounts/${encodeURIComponent(button.dataset.instagramAccountId)}/media/${encodeURIComponent(button.dataset.instagramMedia)}/whitelist`, { method: 'POST', body: JSON.stringify({ purpose: 'identity_search' }) });
      await reloadDashboard();
      toast('Instagram reference image encrypted and added to your whitelist.');
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }

  function renderPhotos() {
    $('photoList').innerHTML = dashboard.photos.length ? dashboard.photos.map((photo) => `
      <article class="fid-photo">
        <div class="fid-photo-preview"><img src="${escapeHtml(apiUrl(`/divedeep/api/photos/${photo.id}`))}" alt="Hidden authorized reference" loading="lazy"/><button class="fid-btn fid-btn-sm fid-photo-reveal" type="button">Reveal photo</button></div>
        <div class="fid-photo-body"><strong>${escapeHtml(photo.label)}</strong><div class="fid-row-meta">${escapeHtml(titleCase(photo.purpose))} · ${Math.round(photo.byteSize / 1024)} KB</div><button class="fid-btn fid-btn-danger fid-btn-sm" data-delete-photo="${escapeHtml(photo.id)}" type="button" style="margin-top:8px">Delete</button></div>
      </article>`).join('') : '<div class="fid-empty">No reference photos uploaded.</div>';
    document.querySelectorAll('.fid-photo-reveal').forEach((button) => button.addEventListener('click', () => button.closest('.fid-photo-preview').classList.add('revealed')));
    document.querySelectorAll('[data-delete-photo]').forEach((button) => button.addEventListener('click', () => deletePhoto(button.dataset.deletePhoto)));
  }

  function renderPlans() {
    const selected = dashboard.customer.planTier;
    const plans = session.config.plans || [];
    $('planCards').innerHTML = plans.map((plan) => `
      <article class="fid-card fid-plan ${selected === plan.id ? 'featured' : ''}">
        ${selected === plan.id ? '<span class="fid-plan-badge">Current level</span>' : ''}
        <div class="fid-plan-level">Level ${plan.level}</div><h3>${escapeHtml(plan.name)}</h3>${Number.isFinite(Number(plan.monthlyPrice)) ? `<div class="fid-plan-price">$${Number(plan.monthlyPrice).toFixed(2)} <span>/ month</span></div>` : ''}<p>${escapeHtml(plan.description)}</p>
        ${plan.sensitive ? '<p class="fid-help">Requires adult-status confirmation and restricted-content consent.</p>' : ''}
        <button class="fid-btn ${selected === plan.id ? '' : 'fid-btn-primary'}" data-plan="${plan.id}" ${selected === plan.id ? 'disabled' : ''}>${selected === plan.id ? 'Selected' : 'Choose this level'}</button>
      </article>`).join('');
    document.querySelectorAll('[data-plan]').forEach((button) => button.addEventListener('click', () => changePlan(button.dataset.plan)));
  }

  async function changePlan(planTier) {
    let age18Affirmed = false;
    let sensitiveContentConsent = false;
    if (['sensitive', 'image'].includes(planTier)) {
      age18Affirmed = confirm('This restricted service is for adults protecting their own identity. Confirm that you are at least 18 years old.');
      if (!age18Affirmed) return;
      sensitiveContentConsent = confirm('Authorize restricted review of adult and explicit-content websites? Sensitive evidence will remain hidden by default.');
      if (!sensitiveContentConsent) return;
    }
    try {
      const result = await api('/divedeep/api/account/plan', { method: 'PATCH', body: JSON.stringify({ planTier, age18Affirmed, sensitiveContentConsent }) });
      dashboard.customer = result.customer;
      renderPlans();
      $('workflowStatus').textContent = titleCase(dashboard.customer.workflowStatus);
      toast('Service level updated.');
    } catch (error) { toast(error.message, true); }
  }

  async function disconnectConnection(id) {
    if (!confirm('Disconnect this profile from DiveDeep?')) return;
    try {
      await api(`/divedeep/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await reloadDashboard();
      toast('Profile disconnected.');
    } catch (error) { toast(error.message, true); }
  }

  async function deletePhoto(id) {
    if (!confirm('Delete this encrypted reference photo?')) return;
    try {
      await api(`/divedeep/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await reloadDashboard();
      toast('Reference photo deleted.');
    } catch (error) { toast(error.message, true); }
  }

  function renderAll() {
    renderOnboarding();
    renderAuthorization();
    renderOverview();
    renderProfile();
    renderConnections();
    renderFindings();
    renderRequests();
    renderPlans();
  }

  async function reloadDashboard(options = {}) {
    if (dashboardLoadPromise && !options.force) return dashboardLoadPromise;
    if (options.force && dashboardController) dashboardController.abort();
    const controller = new AbortController();
    dashboardController = controller;
    const promise = api('/divedeep/api/dashboard', {
      signal: controller.signal,
      timeoutMs: 20000,
      retries: 1,
    }).then((result) => {
      dashboard = result.dashboard;
      findingPage = Number(dashboard?.findingPagination?.page) || 1;
      renderAll();
      return dashboard;
    }).finally(() => {
      if (dashboardLoadPromise === promise) dashboardLoadPromise = null;
      if (dashboardController === controller) dashboardController = null;
    });
    dashboardLoadPromise = promise;
    return promise;
  }

  function wireForms() {
    if (formsWired) return;
    formsWired = true;
    document.querySelectorAll('.fid-tab').forEach((button) => button.addEventListener('click', () => switchPane(button.dataset.pane)));
    document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => switchPane(button.dataset.go)));
    document.querySelectorAll('[data-connection-tab]').forEach((button) => button.addEventListener('click', () => switchConnectionTab(button.dataset.connectionTab)));
    $('metaSync').addEventListener('click', () => syncMetaData(false));

    $('logoutButton').addEventListener('click', async () => {
      try { await api('/divedeep/api/logout', { method: 'POST', body: JSON.stringify({}) }); } catch {}
      location.href = '/divedeep/login';
    });

    $('firstScrubRequest').addEventListener('click', async () => {
      try {
        const result = await api('/divedeep/api/first-scrub-request', { method: 'POST', body: '{}' });
        dashboard = result.dashboard;
        renderAll();
        toast('Your first scrub request is in the authorized discovery queue.');
      } catch (error) { toast(error.message, true); }
    });

    $('identifierForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      $('identifierError').textContent = '';
      try {
        const data = Object.fromEntries(new FormData(form).entries());
        await api('/divedeep/api/identifiers', { method: 'POST', body: JSON.stringify(data) });
        form.reset();
        await reloadDashboard();
        toast('Identifier added.');
      } catch (error) { $('identifierError').textContent = error.message; }
    });

    $('policyForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      $('policyError').textContent = '';
      try {
        const data = Object.fromEntries(new FormData(form).entries());
        data.priority = Number(data.priority || 0);
        await api('/divedeep/api/policies', { method: 'PUT', body: JSON.stringify(data) });
        await reloadDashboard();
        toast('Visibility rule saved.');
      } catch (error) { $('policyError').textContent = error.message; }
    });

    $('connectionForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      $('connectionError').textContent = '';
      try {
        const data = Object.fromEntries(new FormData(form).entries());
        await api('/divedeep/api/connections', { method: 'POST', body: JSON.stringify(data) });
        form.reset();
        await reloadDashboard();
        toast('Profile added.');
      } catch (error) { $('connectionError').textContent = error.message; }
    });

    $('photoForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const file = form.elements.photo.files[0];
      $('photoError').textContent = '';
      if (!file) return;
      try {
        const response = await fetch(apiUrl('/divedeep/api/photos'), {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': file.type,
            'X-DiveDeep-CSRF': session.csrfToken,
            'X-DiveDeep-Photo-Label': form.elements.label.value,
            'X-DiveDeep-Photo-Purpose': form.elements.purpose.value,
            'X-DiveDeep-File-Name': file.name,
          },
          credentials: 'include',
          body: file,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Upload failed');
        form.reset();
        await reloadDashboard();
        toast('Encrypted reference photo uploaded.');
      } catch (error) { $('photoError').textContent = error.message; }
    });
  }

  async function bootstrap() {
    if (bootstrapPromise) return bootstrapPromise;
    showBootLoader();
    bootstrapPromise = (async () => {
      const sessionData = await requestJson('/divedeep/api/session', {
        headers: { Accept: 'application/json' },
        timeoutMs: 12000,
        retries: 1,
        redirectOnUnauthorized: false,
      });
      if (!sessionData.authenticated) {
        location.replace('/divedeep/login');
        return;
      }
      session = sessionData;
      wireForms();
      await reloadDashboard({ force: true });
      hideBootLoader();
      const requested = location.hash.slice(1);
      if (requested && document.querySelector(`[data-pane="${CSS.escape(requested)}"]`)) switchPane(requested);
      const connection = new URLSearchParams(location.search).get('connection');
      if (connection) {
        const messages = {
          'facebook-connected': 'Facebook profile connected.',
          'facebook-unavailable': 'Facebook connection is not configured yet. Add the profile manually for now.',
          'facebook-failed': 'Facebook connection could not be completed.',
          'facebook-session-error': 'Facebook connection session could not be saved.',
        };
        toast(messages[connection] || titleCase(connection), connection.includes('failed') || connection.includes('error'));
        history.replaceState(null, '', location.pathname + location.hash);
      }
    })().catch((error) => {
      if (error?.code === 'DIVEDEEP_SESSION_EXPIRED') return;
      showBootFailure(error.message || 'DiveDeep could not load this workspace.');
    }).finally(() => {
      bootstrapPromise = null;
    });
    return bootstrapPromise;
  }

  $('bootRetry')?.addEventListener('click', () => bootstrap());
  window.addEventListener('online', () => { if (bootFailed) bootstrap(); });
  window.addEventListener('pagehide', () => {
    dashboardController?.abort();
    activeRequestControllers.forEach((controller) => controller.abort());
  });

  if (!window.__diveDeepCustomerAppStarted) {
    window.__diveDeepCustomerAppStarted = true;
    bootstrap();
  }

})();
