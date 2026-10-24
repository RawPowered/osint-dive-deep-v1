const { getCrmProxyConfig } = require('../config');

/**
 * Normalize and validate upstream path (no open proxy).
 * Accepts "/backend/..." or "backend/..."
 */
function sanitizeUpstreamPath(rawPath) {
  const cfg = getCrmProxyConfig();
  let p = String(rawPath || '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  if (!p.startsWith('/')) p = `/${p}`;
  // block traversal / protocol tricks
  if (p.includes('..') || p.includes('//') || p.includes('\\') || p.includes('@')) {
    return { ok: false, error: 'Invalid path' };
  }
  const allowed = cfg.allowedPathPrefixes.some(
    (prefix) => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
  );
  if (!allowed) {
    return { ok: false, error: 'Path not allowed for CRM proxy' };
  }
  return { ok: true, path: p };
}

/**
 * Exact compatibility surface used by the reviewed Vibe client. The broad
 * CRM_EGRESS_ALLOWED_PATHS prefix remains a second, operator-controlled gate;
 * it can no longer make arbitrary /backend routes reachable by itself.
 * OAuth token exchange is deliberately excluded because client secrets and
 * refresh tokens must not transit a general Dialer proxy.
 */
function authorizeUpstreamRequest(method, rawPath) {
  const verb = String(method || 'GET').toUpperCase();
  const checked = sanitizeUpstreamPath(String(rawPath || '').split('?')[0]);
  if (!checked.ok) return checked;
  const rules = [
    ['GET', /^\/backend\/locations\/[^/]+\/customValues\/?$/],
    ['POST', /^\/backend\/locations\/[^/]+\/customValues\/?$/],
    ['PUT', /^\/backend\/locations\/[^/]+\/customValues\/[^/]+\/?$/],
    ['PUT', /^\/backend\/contacts\/[^/]+\/?$/],
    ['GET', /^\/backend\/conversations\/search\/?$/],
    ['GET', /^\/backend\/conversations\/[^/]+\/messages\/?$/],
    ['POST', /^\/backend\/conversations\/messages\/?$/],
    ['POST', /^\/backend\/contacts\/[^/]+\/notes\/?$/],
  ];
  const allowed = rules.some(([allowedMethod, pattern]) =>
    allowedMethod === verb && pattern.test(checked.path)
  );
  return allowed
    ? checked
    : { ok: false, error: 'Method and path are not allowed for CRM proxy' };
}

function resolveUpstreamAuth(req) {
  const cfg = getCrmProxyConfig();
  if (cfg.allowClientUpstreamAuth) {
    const wrapped = req.proxyUpstreamHeaders && req.proxyUpstreamHeaders.Authorization;
    if (wrapped && wrapped.trim()) return wrapped.trim();
    const client =
      req.get('x-nova-authorization') ||
      req.get('x-upstream-authorization') ||
      req.get('x-nova-edge-authorization');
    if (client && client.trim()) return client.trim();
  }
  return cfg.authorization || '';
}

/**
 * Proxy HTTP request to CRM. Returns { status, headers, body, contentType }.
 */
async function proxyToCRM(req, upstreamPathWithQuery) {
  const cfg = getCrmProxyConfig();
  if (!cfg.enabled) {
    const err = new Error('CRM proxy is disabled');
    err.status = 503;
    throw err;
  }
  if (!cfg.baseUrl) {
    const err = new Error('CRM_EGRESS_BASE_URL is not configured');
    err.status = 503;
    throw err;
  }

  const pathOnly = upstreamPathWithQuery.split('?')[0];
  const query = upstreamPathWithQuery.includes('?')
    ? upstreamPathWithQuery.slice(upstreamPathWithQuery.indexOf('?'))
    : '';
  const checked = authorizeUpstreamRequest(req.method, pathOnly);
  if (!checked.ok) {
    const err = new Error(checked.error);
    err.status = 403;
    throw err;
  }

  const url = `${cfg.baseUrl}${checked.path}${query}`;
  const wrappedHeaders = req.proxyUpstreamHeaders || {};
  const headers = {
    Accept: wrappedHeaders.Accept || req.get('accept') || 'application/json',
  };
  const contentType = wrappedHeaders['Content-Type'] || req.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;
  const version = wrappedHeaders.Version || req.get('version');
  if (version) headers.Version = version;

  const upstreamAuth = resolveUpstreamAuth(req);
  if (upstreamAuth) {
    headers.Authorization = upstreamAuth;
  }

  const method = req.method.toUpperCase();
  const init = {
    method,
    headers,
    redirect: 'manual',
  };

  if (method !== 'GET' && method !== 'HEAD' && req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) {
      init.body = req.body;
    } else if (typeof req.body === 'string') {
      init.body = req.body;
    } else if (req.body && Object.keys(req.body).length) {
      init.body = JSON.stringify(req.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  init.signal = controller.signal;

  try {
    const upstream = await fetch(url, init);
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    return {
      status: upstream.status,
      contentType: ct,
      body: buf,
      upstreamUrl: url,
    };
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('CRM request timed out');
      err.status = 504;
      throw err;
    }
    const err = new Error(`CRM proxy failed: ${e.message}`);
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  sanitizeUpstreamPath,
  authorizeUpstreamRequest,
  proxyToCRM,
  getCrmProxyConfig,
};
