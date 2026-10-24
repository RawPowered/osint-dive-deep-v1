(() => {
  const qs = new URLSearchParams(location.search);
  const signupForm = document.getElementById('signupForm');
  const loginForm = document.getElementById('loginForm');
  const errorEl = document.getElementById('formError');
  const facebookSignup = document.getElementById('facebookSignup');
  const apiUrl = (path) => {
    const client = window.DiveDeepClient;
    if (!client?.apiOrigin || typeof client.apiUrl !== 'function') {
      throw new Error('DiveDeep signup is not connected to its API. Upload the installer-generated divedeep-runtime.js file.');
    }
    return client.apiUrl(path);
  };

  function setError(message) { if (errorEl) errorEl.textContent = message || ''; }
  function boolField(form, name) { return Boolean(form.elements[name]?.checked); }

  async function request(url, payload) {
    const response = await fetch(apiUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `DiveDeep API request failed (${response.status})`);
    return data;
  }

  async function configureSignup() {
    if (!signupForm) return;
    const plan = qs.get('plan');
    if (['standard', 'deep', 'sensitive', 'image'].includes(plan)) signupForm.elements.planTier.value = plan;
    const planSelect = document.getElementById('planTier');
    const sensitive = document.getElementById('sensitiveConsent');
    const updateSensitive = () => sensitive?.classList.toggle('visible', ['sensitive', 'image'].includes(planSelect.value));
    planSelect.addEventListener('change', updateSensitive);
    updateSensitive();
    try {
      if (facebookSignup) facebookSignup.href = apiUrl('/divedeep/connect/facebook/signup');
      const response = await fetch(apiUrl('/divedeep/api/config'), { headers: { Accept: 'application/json' }, credentials: 'include' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `DiveDeep API configuration failed (${response.status})`);
      if (facebookSignup) facebookSignup.hidden = !data.config?.facebookConnectionEnabled;
      const plans = Array.isArray(data.config?.plans) ? data.config.plans : [];
      if (plans.length) {
        const selectedPlan = planSelect.value;
        planSelect.replaceChildren(...plans.map((item) => {
          const option = document.createElement('option');
          option.value = item.id;
          option.textContent = `${item.name} · $${Number(item.monthlyPrice).toFixed(2)} / month`;
          return option;
        }));
        if (plans.some((item) => item.id === selectedPlan)) planSelect.value = selectedPlan;
        updateSensitive();
      }
      const invite = document.getElementById('inviteField');
      if (invite && data.config?.inviteRequired) invite.querySelector('.fid-label').textContent = 'Pilot access code';
      if (!data.config?.signupsEnabled) {
        setError('Pilot registrations are currently closed.');
        signupForm.querySelector('button[type="submit"]').disabled = true;
      }
      if (qs.get('social') === 'facebook') {
        const prefillResponse = await fetch(apiUrl('/divedeep/api/signup-prefill'), { headers: { Accept: 'application/json' }, credentials: 'include' });
        const prefill = await prefillResponse.json();
        if (prefill.facebook) {
          signupForm.elements.firstName.value = prefill.facebook.firstName || '';
          signupForm.elements.lastName.value = prefill.facebook.lastName || '';
          signupForm.elements.email.value = prefill.facebook.email || '';
          setError('Facebook is connected for profile setup. Review your details, create a password, and accept the authorization below.');
        }
      }
    } catch (error) {
      if (facebookSignup) {
        facebookSignup.hidden = true;
        facebookSignup.removeAttribute('href');
      }
      setError(error.message || 'DiveDeep signup configuration could not be loaded.');
      signupForm.querySelector('button[type="submit"]').disabled = true;
    }
  }

  if (signupForm) {
    configureSignup();
    signupForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setError('');
      const button = signupForm.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const payload = {
          firstName: signupForm.elements.firstName.value,
          lastName: signupForm.elements.lastName.value,
          email: signupForm.elements.email.value,
          password: signupForm.elements.password.value,
          planTier: signupForm.elements.planTier.value,
          pilotCode: signupForm.elements.pilotCode?.value || '',
          age18Affirmed: boolField(signupForm, 'age18Affirmed'),
          sensitiveContentConsent: boolField(signupForm, 'sensitiveContentConsent'),
          noticeAcknowledged: boolField(signupForm, 'noticeAcknowledged'),
          termsAccepted: boolField(signupForm, 'termsAccepted'),
          crmIntegrationId: /^[A-Za-z0-9-]{1,36}$/.test(qs.get('crmIntegrationId') || '') ? qs.get('crmIntegrationId') : '',
          crmContactId: /^[A-Za-z0-9_-]{1,191}$/.test(qs.get('crmContactId') || '') ? qs.get('crmContactId') : '',
        };
        const data = await request('/divedeep/api/signup', payload);
        location.href = data.redirect || '/divedeep/app';
      } catch (error) {
        setError(error.message);
        button.disabled = false;
      }
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setError('');
      const button = loginForm.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const data = await request('/divedeep/api/login', {
          email: loginForm.elements.email.value,
          password: loginForm.elements.password.value,
        });
        location.href = '/divedeep/app';
      } catch (error) {
        setError(error.message);
        button.disabled = false;
      }
    });
  }
})();
