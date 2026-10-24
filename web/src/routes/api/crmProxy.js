const express = require('express');
const { proxyToCRM, getCrmProxyConfig } = require('../../services/crmProxy');
const { getPool } = require('../../db/pool');
const { requireOperatorSession } = require('../../services/operatorSessions');
const { getInstanceIdentity } = require('../../instanceIdentity');

/**
 * CRM integration proxy.
 *
 * Browser client → the installation-defined public API path (CORS + API key)
 * This server → the configured CRM service (no browser CORS)
 *
 * Examples:
 *   GET /api/nova-edge/backend/locations/:locationId/customValues
 *   GET /api/nova-edge/proxy?path=/backend/locations/xxx/customValues
 *
 * Point the client CRM base URL at the value returned by the status endpoint
 * when the product supports overriding that host (paths stay /backend/...).
 */
function createCRMRouter() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const cfg = getCrmProxyConfig();
    const proxyBase = `${getInstanceIdentity().publicApiBasePath}/nova-edge`;
    res.json({
      success: true,
      enabled: cfg.enabled,
      baseUrl: cfg.baseUrl,
      allowedPathPrefixes: cfg.allowedPathPrefixes,
      hasUpstreamAuth: Boolean(cfg.authorization),
      acceptsClientUpstreamAuth: cfg.allowClientUpstreamAuth,
      proxyBase,
      example: `${proxyBase}/backend/locations/{locationId}/customValues`,
    });
  });

  // The wrapper is the only egress surface. Raw /backend passthrough was
  // removed so every request carries an explicit location and grant check.
  router.all('/proxy', explicitProxyHandler);

  return router;
}

/**
 * Supports both the documented query form and the Vibe wrapper form:
 * { path|url, method?, headers?, body?, query? }. Absolute URLs must match
 * CRM_EGRESS_BASE_URL. Only Accept, Content-Type, Version, and Authorization
 * are considered from wrapper headers.
 */
async function explicitProxyHandler(req, res) {
  const wrapper = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
    ? req.body
    : {};
  let rawPath = req.query.path || req.query.p || wrapper.path || wrapper.p || wrapper.url;
  if (!rawPath) return res.status(400).json({ error: 'Missing proxy path' });

  try {
    if (/^https?:\/\//i.test(String(rawPath))) {
      const cfg = getCrmProxyConfig();
      const supplied = new URL(String(rawPath));
      const configured = new URL(cfg.baseUrl);
      if (supplied.origin === configured.origin) {
        rawPath = `${supplied.pathname}${supplied.search}`;
      } else if (supplied.origin === 'https://services.leadconnectorhq.com') {
        const mapped = mapLeadConnectorPathToCRM(supplied.pathname);
        if (!mapped) {
          return res.status(403).json({
            error: 'Only known CRM compatibility paths are allowed',
          });
        }
        rawPath = `${mapped}${supplied.search}`;
      } else {
        return res.status(403).json({ error: 'Proxy URL origin is not allowed' });
      }
    }
  } catch {
    return res.status(400).json({ error: 'Invalid proxy path' });
  }

  const query = new URLSearchParams({ ...req.query });
  query.delete('path');
  query.delete('p');
  if (wrapper.query && typeof wrapper.query === 'object') {
    for (const [key, value] of Object.entries(wrapper.query)) {
      if (value != null) query.set(key, String(value));
    }
  }
  const hasQuery = String(rawPath).includes('?');
  const extra = query.toString() ? `${hasQuery ? '&' : '?'}${query.toString()}` : '';

  let grantedLocationId;
  try {
    grantedLocationId = await enforceGrantedLocation(req, rawPath, wrapper);
    await requireOperatorSession(req, { locationId: grantedLocationId });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }

  const proxyReq = Object.create(req);
  proxyReq.get = req.get.bind(req);
  const requestedMethod = String(wrapper.method || req.method).toUpperCase();
  const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
  if (!allowedMethods.has(requestedMethod)) {
    return res.status(400).json({ error: 'Unsupported proxy method' });
  }
  proxyReq.method = requestedMethod;
  proxyReq.proxyUpstreamHeaders = sanitizeWrapperHeaders(wrapper.headers);
  if (Object.prototype.hasOwnProperty.call(wrapper, 'body')) {
    proxyReq.body = wrapper.body;
  } else if (wrapper.path || wrapper.p || wrapper.url || wrapper.method || wrapper.query) {
    const {
      path,
      p,
      url,
      method,
      headers: ignoredHeaders,
      query: ignoredQuery,
      ...upstreamBody
    } = wrapper;
    proxyReq.body = Object.keys(upstreamBody).length ? upstreamBody : undefined;
  }
  return forward(proxyReq, res, String(rawPath) + extra);
}

function mapLeadConnectorPathToCRM(pathname) {
  const path = String(pathname || '');
  if (/^\/contacts\/?$/i.test(path)) return '/backend/contacts/';
  const customValues = path.match(/^\/locations\/([^/]+)\/customValues\/?$/i);
  if (customValues) {
    return `/backend/locations/${encodeURIComponent(decodeURIComponent(customValues[1]))}/customValues`;
  }
  return null;
}

function sanitizeWrapperHeaders(rawHeaders) {
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) return {};
  const allowed = new Map([
    ['accept', 'Accept'],
    ['content-type', 'Content-Type'],
    ['version', 'Version'],
    ['authorization', 'Authorization'],
  ]);
  const result = {};
  for (const [rawName, rawValue] of Object.entries(rawHeaders)) {
    const name = allowed.get(String(rawName).toLowerCase());
    if (!name || typeof rawValue !== 'string') continue;
    const value = rawValue.trim();
    if (!value || /[\r\n]/.test(value)) continue;
    result[name] = value.slice(0, 2048);
  }
  return result;
}

async function enforceGrantedLocation(req, rawPath, wrapper) {
  if (!req.apiKey || !req.apiKey.id) {
    throw Object.assign(new Error('API key required'), { status: 401 });
  }
  const pool = getPool();
  const [grants] = await pool.query(
    `SELECT DISTINCT i.location_id FROM crm_integrations i
     INNER JOIN crm_integration_grants g ON g.integration_id = i.id
     WHERE g.api_key_id = ? AND i.is_enabled = 1`,
    [req.apiKey.id]
  );
  if (!grants.length) {
    throw Object.assign(new Error('Proxy location access denied'), { status: 403 });
  }
  const allowed = new Set(grants.map((row) => String(row.location_id)));
  const supplied = new Set();
  const pathMatch = String(rawPath).match(/\/locations\/([^/?]+)/i);
  if (pathMatch) {
    try {
      supplied.add(decodeURIComponent(pathMatch[1]));
    } catch {
      throw Object.assign(new Error('Invalid proxy location'), { status: 400 });
    }
  }
  try {
    const parsedPath = new URL(String(rawPath), 'https://instance.invalid');
    if (parsedPath.searchParams.get('locationId')) {
      supplied.add(parsedPath.searchParams.get('locationId'));
    }
  } catch {
    throw Object.assign(new Error('Invalid proxy path'), { status: 400 });
  }
  if (req.query && req.query.locationId) supplied.add(String(req.query.locationId));
  if (wrapper.locationId) supplied.add(String(wrapper.locationId));
  if (wrapper.query && wrapper.query.locationId) supplied.add(String(wrapper.query.locationId));
  if (wrapper.body && wrapper.body.locationId) supplied.add(String(wrapper.body.locationId));
  if (supplied.size !== 1) {
    throw Object.assign(new Error('Exactly one proxy locationId is required'), { status: 400 });
  }
  for (const locationId of supplied) {
    if (!allowed.has(locationId)) {
      throw Object.assign(new Error('Proxy location access denied'), { status: 403 });
    }
  }
  return [...supplied][0];
}

function createCRMCompatibilityRouter() {
  const router = express.Router();
  router.all('/proxy', explicitProxyHandler);
  return router;
}

async function forward(req, res, upstreamPathWithQuery) {
  try {
    const result = await proxyToCRM(req, upstreamPathWithQuery);
    res.status(result.status);
    res.setHeader('Content-Type', result.contentType);
    // Do not leak upstream set-cookie into browser by default
    res.send(result.body);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || 'Proxy error',
      integration: 'nova-edge',
    });
  }
}

module.exports = {
  createCRMRouter,
  createCRMCompatibilityRouter,
  explicitProxyHandler,
  enforceGrantedLocation,
  sanitizeWrapperHeaders,
  mapLeadConnectorPathToCRM,
};
