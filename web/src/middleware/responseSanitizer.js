const BLOCKED_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'credentialenc',
  'credential_enc',
  'tokenhash',
  'token_hash',
  'keyhash',
  'key_hash',
  'secrethash',
  'secret_hash',
]);

function sanitizeApiResponse(value, depth = 0, seen = new WeakSet()) {
  if (depth > 12 || value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeApiResponse(item, depth + 1, seen));
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(String(key).toLowerCase())) continue;
    output[key] = sanitizeApiResponse(child, depth + 1, seen);
  }
  return output;
}

function apiResponseSanitizer(req, res, next) {
  const json = res.json.bind(res);
  res.json = (payload) => {
    if (process.env.NODE_ENV === 'production' && res.statusCode >= 500) {
      return json({
        error: 'Internal server error',
        requestId: req.sentinelRequestId || undefined,
      });
    }
    return json(sanitizeApiResponse(payload));
  };
  next();
}

module.exports = { apiResponseSanitizer, sanitizeApiResponse, BLOCKED_KEYS };
