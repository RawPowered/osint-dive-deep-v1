const { verifyKey } = require('../services/apiKeys');

async function apiKeyAuth(req, res, next) {
  // Preflight must never hit 401 (CORS layer should answer OPTIONS first)
  if (req.method === 'OPTIONS') return next();

  try {
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      // Also accept raw token without "Bearer " (some clients misconfigure)
      const raw = authHeader.trim().replace(/^["']|["']$/g, '');
      if (raw && !raw.includes(' ')) {
        const key = await verifyKey(raw);
        if (key) {
          req.apiKey = key;
          return next();
        }
      }
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Strip accidental quotes around the secret
    const secret = match[1].trim().replace(/^["']|["']$/g, '');
    const key = await verifyKey(secret);
    if (!key) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.apiKey = key;
    next();
  } catch (err) {
    console.error('apiKeyAuth error:', err.message);
    return res.status(500).json({ error: 'Auth error' });
  }
}

module.exports = { apiKeyAuth };
