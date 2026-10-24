const https = require('https');
const { getPool } = require('../db/pool');
const { normalizeIp } = require('./sentinelBlocks');
const { outboundUserAgent } = require('../instanceIdentity');

const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4500;

function isPrivateOrReserved(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  return false;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'application/rdap+json, application/json',
          'User-Agent': outboundUserAgent('rdap'),
        },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1_500_000) {
            req.destroy();
            reject(new Error('RDAP response too large'));
          }
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`RDAP HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Invalid RDAP JSON'));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('RDAP timeout'));
    });
    req.on('error', reject);
  });
}

function pickVcardFn(entity) {
  if (!entity || !Array.isArray(entity.vcardArray)) return null;
  const card = entity.vcardArray[1];
  if (!Array.isArray(card)) return null;
  for (const row of card) {
    if (Array.isArray(row) && row[0] === 'fn' && row[3]) return String(row[3]);
  }
  return null;
}

function normalizeRdap(raw, ip) {
  if (!raw || typeof raw !== 'object') {
    return { ip, network: null, org: null, country: null, cidr: null, abuse: null };
  }
  const cidrs = [];
  if (Array.isArray(raw.cidr0_cidrs)) {
    for (const c of raw.cidr0_cidrs) {
      if (c.v4prefix) cidrs.push(`${c.v4prefix}/${c.length}`);
      if (c.v6prefix) cidrs.push(`${c.v6prefix}/${c.length}`);
    }
  }
  let org = null;
  let abuse = null;
  if (Array.isArray(raw.entities)) {
    for (const ent of raw.entities) {
      const roles = ent.roles || [];
      const name = pickVcardFn(ent) || ent.handle || null;
      if (roles.includes('registrant') || roles.includes('registrant') || !org) {
        if (name) org = org || name;
      }
      if (roles.includes('abuse') && name) abuse = name;
      // email from vcard
      if (Array.isArray(ent.vcardArray?.[1])) {
        for (const row of ent.vcardArray[1]) {
          if (Array.isArray(row) && row[0] === 'email' && row[3] && roles.includes('abuse')) {
            abuse = String(row[3]);
          }
        }
      }
    }
  }
  const network =
    raw.name ||
    raw.handle ||
    (raw.network && (raw.network.name || raw.network.handle)) ||
    null;
  const country = raw.country || raw.network?.country || null;
  // Truncated raw keys only
  const rawLite = {
    objectClassName: raw.objectClassName,
    handle: raw.handle,
    name: raw.name,
    type: raw.type,
    country: raw.country,
    startAddress: raw.startAddress,
    endAddress: raw.endAddress,
    links: Array.isArray(raw.links)
      ? raw.links.slice(0, 3).map((l) => ({ rel: l.rel, href: l.href }))
      : undefined,
  };
  return {
    ip,
    network: network ? String(network).slice(0, 255) : null,
    org: org ? String(org).slice(0, 255) : null,
    country: country ? String(country).slice(0, 8) : null,
    cidr: cidrs.length ? cidrs.slice(0, 5).join(', ') : null,
    abuse: abuse ? String(abuse).slice(0, 255) : null,
    raw: rawLite,
  };
}

async function readCache(ip) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM sentinel_ip_intel_cache WHERE ip = ? LIMIT 1`,
    [ip]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  const exp = new Date(row.expires_at).getTime();
  if (Date.now() > exp) return { stale: true, row };
  let payload = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = null;
    }
  }
  return {
    stale: false,
    cached: true,
    error: row.error,
    provider: row.provider,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    intel: payload,
  };
}

async function writeCache(ip, { payload, error, success }) {
  const pool = getPool();
  const ttl = success ? SUCCESS_TTL_MS : FAIL_TTL_MS;
  const expires = new Date(Date.now() + ttl);
  await pool.query(
    `INSERT INTO sentinel_ip_intel_cache (ip, payload_json, provider, fetched_at, expires_at, error)
     VALUES (?, ?, 'rdap', CURRENT_TIMESTAMP(3), ?, ?)
     ON DUPLICATE KEY UPDATE
       payload_json = VALUES(payload_json),
       provider = VALUES(provider),
       fetched_at = CURRENT_TIMESTAMP(3),
       expires_at = VALUES(expires_at),
       error = VALUES(error)`,
    [
      ip,
      payload ? JSON.stringify(payload).slice(0, 500000) : null,
      expires,
      error ? String(error).slice(0, 255) : null,
    ]
  );
}

/**
 * Lookup IP intelligence via RDAP (cached).
 */
async function lookupIpIntel(rawIp, { force = false } = {}) {
  const ip = normalizeIp(rawIp);
  if (!ip) {
    const err = new Error('Invalid IP');
    err.status = 400;
    throw err;
  }

  if (isPrivateOrReserved(ip)) {
    return {
      ip,
      cached: false,
      private: true,
      intel: {
        ip,
        network: 'Private/reserved',
        org: null,
        country: null,
        cidr: null,
        abuse: null,
        note: 'Private or reserved address — RDAP not applicable',
      },
    };
  }

  if (!force) {
    const cached = await readCache(ip);
    if (cached && !cached.stale) {
      return {
        ip,
        cached: true,
        private: false,
        error: cached.error || null,
        provider: cached.provider,
        fetchedAt: cached.fetchedAt,
        expiresAt: cached.expiresAt,
        intel: cached.intel,
      };
    }
  }

  try {
    const raw = await httpsGetJson(`https://rdap.org/ip/${encodeURIComponent(ip)}`);
    const intel = normalizeRdap(raw, ip);
    await writeCache(ip, { payload: intel, error: null, success: true });
    return {
      ip,
      cached: false,
      private: false,
      provider: 'rdap',
      intel,
      error: null,
    };
  } catch (e) {
    const msg = e.message || 'RDAP failed';
    await writeCache(ip, { payload: null, error: msg, success: false });
    return {
      ip,
      cached: false,
      private: false,
      provider: 'rdap',
      intel: null,
      error: msg,
    };
  }
}

module.exports = {
  lookupIpIntel,
  isPrivateOrReserved,
  normalizeRdap,
};
