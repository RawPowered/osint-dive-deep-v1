const { getPool } = require('../db/pool');
const { getCrmAppOrigin, getWorkspaceMaxBytes } = require('../config');

/** Keys that must never appear in workspace state (case-insensitive). */
const FORBIDDEN_KEY_RE =
  /^(cookie|cookies|set-cookie|password|passwordhash|authorization|sessiontoken|accesstoken|refreshtoken|secret|apitoken|api_key|apikey)$/i;

const MAX_ID_LEN = 128;
const MAX_PATH_LEN = 512;
const MAX_TAB_LEN = 64;

function clip(str, max) {
  if (str == null) return null;
  const s = String(str);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Deep-scan object keys for forbidden secret-like names.
 * Returns { ok: true, value } or { ok: false, error }.
 */
function stripAndValidateSecrets(value, path = 'state') {
  if (value === null || value === undefined) {
    return { ok: true, value };
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { ok: true, value };
  }
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      const r = stripAndValidateSecrets(value[i], `${path}[${i}]`);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY_RE.test(k)) {
        return {
          ok: false,
          error: `Forbidden key "${k}" in workspace state (Harbor does not store CRM secrets/cookies)`,
        };
      }
      const r = stripAndValidateSecrets(v, `${path}.${k}`);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false, error: `Unsupported type at ${path}` };
}

/**
 * Sanitize CRM path: relative app path only, no schemes / traversal.
 */
function sanitizeCrmPath(raw) {
  if (raw == null || raw === '') return null;
  let p = String(raw).trim();
  // Allow full URL: extract pathname
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = u.pathname + (u.search || '');
    } catch {
      return { ok: false, error: 'Invalid CRM path/URL' };
    }
  }
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.includes('..') || p.includes('\\') || p.includes('@') || /[\x00-\x1f]/.test(p)) {
    return { ok: false, error: 'Invalid CRM path' };
  }
  if (/^javascript:/i.test(p) || /^data:/i.test(p)) {
    return { ok: false, error: 'Invalid CRM path scheme' };
  }
  // Prefer /v2/location/... shape used by white-label app
  if (!p.startsWith('/v2/location/') && !p.startsWith('/v2/') && !p.startsWith('/location/')) {
    // Allow other CRM app paths but still relative-only
    if (!p.startsWith('/')) {
      return { ok: false, error: 'CRM path must be absolute path on CRM origin' };
    }
  }
  return { ok: true, path: clip(p, MAX_PATH_LEN) };
}

function buildContactPath(locationId, contactId) {
  const loc = encodeURIComponent(String(locationId));
  const cid = encodeURIComponent(String(contactId));
  return `/v2/location/${loc}/contacts/detail/${cid}`;
}

function buildLocationHomePath(locationId) {
  const loc = encodeURIComponent(String(locationId));
  return `/v2/location/${loc}`;
}

/**
 * Resolve canonical CRM URL for a location and optional contact.
 */
function resolveCrmUrl({ locationId, contactId, path: rawPath } = {}) {
  const origin = getCrmAppOrigin();
  if (rawPath) {
    const s = sanitizeCrmPath(rawPath);
    if (!s.ok) return s;
    return { ok: true, origin, path: s.path, url: `${origin}${s.path}` };
  }
  if (!locationId) {
    return { ok: false, error: 'Missing locationId' };
  }
  const path = contactId
    ? buildContactPath(locationId, contactId)
    : buildLocationHomePath(locationId);
  return { ok: true, origin, path, url: `${origin}${path}` };
}

function parseStateJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function rowToWorkspace(row) {
  if (!row) return null;
  const state = parseStateJson(row.state_json);
  return {
    locationId: row.location_id,
    userId: row.user_id,
    revision: Number(row.revision) || 1,
    state,
    crmContactId: row.crm_contact_id || null,
    crmPath: row.crm_path || null,
    clientTabId: row.client_tab_id || null,
    leaseUntil: row.lease_until || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function getWorkspace(locationId, userId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT location_id, user_id, revision, state_json, crm_contact_id, crm_path,
            client_tab_id, lease_until, created_at, updated_at
     FROM dialer_workspaces
     WHERE location_id = ? AND user_id = ?
     LIMIT 1`,
    [String(locationId), String(userId)]
  );
  return rowToWorkspace(rows[0] || null);
}

/**
 * Extract denormalized CRM fields from state for indexing.
 */
function extractCrmMeta(state, locationId) {
  const crm = state && typeof state === 'object' ? state.crm || {} : {};
  let contactId = crm.contactId || crm.activeContactId || null;
  let path = crm.path || crm.activePath || null;

  if (path) {
    const s = sanitizeCrmPath(path);
    path = s.ok ? s.path : null;
  }
  if (!path && contactId && locationId) {
    path = buildContactPath(locationId, contactId);
  }
  if (!contactId && path) {
    const m = String(path).match(/\/contacts\/detail\/([^/?#]+)/i);
    if (m) contactId = decodeURIComponent(m[1]);
  }
  return {
    crmContactId: contactId ? clip(contactId, MAX_ID_LEN) : null,
    crmPath: path ? clip(path, MAX_PATH_LEN) : null,
  };
}

/**
 * Upsert workspace. Returns { ok, workspace } or { ok: false, status, error, workspace? }.
 */
async function upsertWorkspace(
  {
    locationId,
    userId,
    state,
    clientTabId = null,
    expectedRevision = null,
    leaseSeconds = null,
  },
  pool = null
) {
  if (!locationId || !userId) {
    return { ok: false, status: 400, error: 'Missing locationId or userId' };
  }
  if (state === undefined || state === null) {
    return { ok: false, status: 400, error: 'Missing state' };
  }

  const validated = stripAndValidateSecrets(state);
  if (!validated.ok) {
    return { ok: false, status: 400, error: validated.error };
  }
  const cleanState = validated.value;
  if (typeof cleanState !== 'object' || Array.isArray(cleanState)) {
    return { ok: false, status: 400, error: 'state must be a JSON object' };
  }
  if (cleanState.schemaVersion == null) {
    cleanState.schemaVersion = 1;
  }

  const stateStr = JSON.stringify(cleanState);
  const maxBytes = getWorkspaceMaxBytes();
  if (Buffer.byteLength(stateStr, 'utf8') > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `Workspace state exceeds max size (${maxBytes} bytes)`,
    };
  }

  const loc = clip(locationId, MAX_ID_LEN);
  const uid = clip(userId, MAX_ID_LEN);
  const tab = clientTabId != null ? clip(clientTabId, MAX_TAB_LEN) : null;
  const meta = extractCrmMeta(cleanState, loc);

  let leaseUntil = null;
  if (leaseSeconds != null && Number(leaseSeconds) > 0) {
    const sec = Math.min(Number(leaseSeconds), 86400);
    leaseUntil = new Date(Date.now() + sec * 1000);
  }

  const p = pool || getPool();
  const existing = await getWorkspace(loc, uid, p);

  if (expectedRevision != null && expectedRevision !== '') {
    const exp = Number(expectedRevision);
    if (!Number.isFinite(exp)) {
      return { ok: false, status: 400, error: 'expectedRevision must be a number' };
    }
    if (!existing) {
      if (exp !== 0) {
        return {
          ok: false,
          status: 409,
          error: 'Revision conflict (no workspace yet; use expectedRevision 0 or omit)',
          workspace: null,
        };
      }
    } else if (Number(existing.revision) !== exp) {
      return {
        ok: false,
        status: 409,
        error: 'Revision conflict',
        workspace: existing,
      };
    }
  }

  const nextRevision = existing ? Number(existing.revision) + 1 : 1;

  await p.query(
    `INSERT INTO dialer_workspaces
       (location_id, user_id, revision, state_json, crm_contact_id, crm_path,
        client_tab_id, lease_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       revision = VALUES(revision),
       state_json = VALUES(state_json),
       crm_contact_id = VALUES(crm_contact_id),
       crm_path = VALUES(crm_path),
       client_tab_id = VALUES(client_tab_id),
       lease_until = VALUES(lease_until),
       updated_at = CURRENT_TIMESTAMP`,
    [
      loc,
      uid,
      nextRevision,
      stateStr,
      meta.crmContactId,
      meta.crmPath,
      tab,
      leaseUntil,
    ]
  );

  const workspace = await getWorkspace(loc, uid, p);
  return { ok: true, workspace };
}

async function deleteWorkspace(locationId, userId, pool = null) {
  if (!locationId || !userId) {
    return { ok: false, status: 400, error: 'Missing locationId or userId' };
  }
  const p = pool || getPool();
  const [result] = await p.query(
    `DELETE FROM dialer_workspaces WHERE location_id = ? AND user_id = ?`,
    [String(locationId), String(userId)]
  );
  return { ok: true, deleted: result.affectedRows > 0 };
}

/**
 * Heartbeat: touch updated_at, optional tab + lease extension.
 * If no row exists, returns 404 — client should PUT full state first.
 */
async function heartbeatWorkspace(
  { locationId, userId, clientTabId = null, leaseSeconds = 120 },
  pool = null
) {
  if (!locationId || !userId) {
    return { ok: false, status: 400, error: 'Missing locationId or userId' };
  }
  const p = pool || getPool();
  const loc = String(locationId);
  const uid = String(userId);
  const existing = await getWorkspace(loc, uid, p);
  if (!existing) {
    return { ok: false, status: 404, error: 'Workspace not found' };
  }

  const tab =
    clientTabId != null ? clip(clientTabId, MAX_TAB_LEN) : existing.clientTabId;
  let leaseUntil = existing.leaseUntil;
  if (leaseSeconds != null && Number(leaseSeconds) > 0) {
    const sec = Math.min(Number(leaseSeconds), 86400);
    leaseUntil = new Date(Date.now() + sec * 1000);
  }

  await p.query(
    `UPDATE dialer_workspaces
     SET client_tab_id = ?, lease_until = ?, updated_at = CURRENT_TIMESTAMP
     WHERE location_id = ? AND user_id = ?`,
    [tab, leaseUntil, loc, uid]
  );

  const workspace = await getWorkspace(loc, uid, p);
  return { ok: true, workspace };
}

module.exports = {
  getWorkspace,
  upsertWorkspace,
  deleteWorkspace,
  heartbeatWorkspace,
  resolveCrmUrl,
  sanitizeCrmPath,
  stripAndValidateSecrets,
  buildContactPath,
  buildLocationHomePath,
  FORBIDDEN_KEY_RE,
};
