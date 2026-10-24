(() => {
  if (window.__divedeepStructuredReceiverInstalled) {
    return;
  }
  window.__divedeepStructuredReceiverInstalled = true;

  const unique = (values, limit = 30) => {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      const clean = String(value || "").replace(/\s+/g, " ").trim();
      const key = clean.toLocaleLowerCase();
      if (clean && clean.length <= 1000 && !seen.has(key)) {
        seen.add(key);
        result.push(clean);
      }
      if (result.length >= limit) break;
    }
    return result;
  };

  const readJsonLd = () => {
    const names = [];
    const addresses = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent || "null");
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) {
          const value = queue.shift();
          if (!value || typeof value !== "object") continue;
          if (Array.isArray(value)) {
            queue.push(...value);
            continue;
          }
          const type = Array.isArray(value["@type"]) ? value["@type"].join(" ") : String(value["@type"] || "");
          if (/person/i.test(type) && value.name) names.push(value.name);
          const address = value.address;
          if (typeof address === "string") addresses.push(address);
          if (address && typeof address === "object") {
            addresses.push([
              address.streetAddress,
              address.addressLocality,
              address.addressRegion,
              address.postalCode
            ].filter(Boolean).join(", "));
          }
          for (const child of Object.values(value)) {
            if (child && typeof child === "object") queue.push(child);
          }
        }
      } catch (_) {
        // Ignore malformed page-owned JSON-LD and continue with visible fields.
      }
    }
    return { names, addresses };
  };

  const scan = () => {
    const jsonLd = readJsonLd();
    const nameSelectors = [
      '[itemprop="name"]', "h1", "h2", ".person-name", ".profile-name",
      '[class*="personName"]', '[class*="person-name"]'
    ];
    const addressSelectors = [
      "address", '[itemprop="address"]', '[itemprop="streetAddress"]',
      ".address", ".residential-address", '[class*="street-address"]'
    ];
    const names = [...jsonLd.names];
    for (const node of document.querySelectorAll(nameSelectors.join(","))) {
      names.push(node.textContent || "");
    }
    const titleName = document.title.split(/[|–—-]/)[0];
    if (titleName) names.push(titleName);

    const addresses = [...jsonLd.addresses];
    for (const node of document.querySelectorAll(addressSelectors.join(","))) {
      const container = node.closest("address, [itemprop='address'], .address") || node;
      addresses.push(container.textContent || "");
    }
    const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const addressPattern = /\b\d{1,6}\s+[A-Z0-9][A-Z0-9.'-]*(?:\s+[A-Z0-9][A-Z0-9.'-]*){0,7}\s+(?:STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|BOULEVARD|BLVD|COURT|CT|PLACE|PL|CIRCLE|CIR|HIGHWAY|HWY|WAY|TRAIL|TRL)\b(?:[^\n,]{0,25})?(?:,\s*[A-Z .'-]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/gi;
    for (const match of bodyText.matchAll(addressPattern)) {
      addresses.push(match[0]);
    }
    const declaredLanguage = document.documentElement.lang || document.querySelector('meta[http-equiv="content-language" i]')?.content || "";
    return {
      pageUrl: location.href,
      pageTitle: document.title,
      candidateNames: unique(names.map(value => String(value).replace(/\b(?:age|born|lives in|profile)\b.*$/i, "").trim()), 30),
      candidateAddresses: unique(addresses, 30),
      declaredLanguage: String(declaredLanguage).trim(),
      textSample: bodyText.slice(0, 50000),
      scannedAt: new Date().toISOString()
    };
  };

  browser.runtime.onMessage.addListener(message => {
    if (message?.type === "divedeep.scan") {
      return Promise.resolve(scan());
    }
    return undefined;
  });
})();
