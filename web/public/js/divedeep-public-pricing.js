(() => {
  const apiUrl = (path) => {
    const client = window.DiveDeepClient;
    if (!client?.apiOrigin || typeof client.apiUrl !== 'function') throw new Error('DiveDeep API is not configured');
    return client.apiUrl(path);
  };
  Promise.resolve()
    .then(() => fetch(apiUrl('/divedeep/api/config'), { headers: { Accept: 'application/json' }, credentials: 'include' }))
    .then((response) => response.ok ? response.json() : null)
    .then((data) => {
      const plans = Array.isArray(data?.config?.plans) ? data.config.plans : [];
      for (const plan of plans) {
        const card = document.querySelector(`[data-package-card="${CSS.escape(plan.id)}"]`);
        if (!card) continue;
        const name = card.querySelector('[data-package-name]');
        const description = card.querySelector('[data-package-description]');
        const price = card.querySelector('[data-package-price]');
        if (name) name.textContent = plan.name;
        if (description) description.textContent = plan.description;
        if (price) price.textContent = `$${Number(plan.monthlyPrice).toFixed(2)}`;
      }
    })
    .catch(() => { /* Static fallback pricing remains visible if the API is unavailable. */ });
})();
