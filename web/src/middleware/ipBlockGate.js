const { isIpBlocked, normalizeIp } = require('../services/sentinelBlocks');
const { recordEvent, newRequestId } = require('../services/sentinel');
const { touchSighting } = require('../services/sentinelSightings');

/**
 * Deny machine API traffic from actively blocked IPs.
 * Generic 403 — do not advertise that the client is on a blocklist.
 * Still records a sentinel event + sighting for OpSec visibility.
 */
async function ipBlockGate(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  try {
    const ip = normalizeIp(req.ip);
    if (!ip) return next();

    const blocked = await isIpBlocked(ip);
    if (!blocked) return next();

    const requestId = req.sentinelRequestId || newRequestId();
    req.sentinelRequestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const path = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;
    recordEvent({
      request_id: requestId,
      method: req.method,
      path,
      status_code: 403,
      duration_ms: 0,
      ip: req.ip,
      user_agent: req.get('user-agent'),
      error_class: 'blocked',
    });
    touchSighting({
      ip: req.ip,
      status_code: 403,
      path,
      method: req.method,
      error_class: 'blocked',
    });

    return res.status(403).json({ error: 'Forbidden' });
  } catch (err) {
    // Known blocked IPs remain denied from the last-good cache. Unknown IPs
    // continue during a DB outage, but the enforcement failure is always alerted.
    console.error(`ipBlockGate enforcement error: ${err.code || err.name || 'BLOCK_CHECK_FAILED'}`);
    return next();
  }
}

module.exports = { ipBlockGate };
