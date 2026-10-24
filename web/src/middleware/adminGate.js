const { getAdminIpAllowlist } = require('../config');

/**
 * Optional IP allowlist for admin base. Fail closed with generic 404
 * so scanners cannot confirm the path exists.
 */
function adminIpGate(req, res, next) {
  const list = getAdminIpAllowlist();
  if (!list || !list.length) return next();

  const ip = req.ip || '';
  const normalized = ip.replace(/^::ffff:/, '');
  const ok = list.some((allowed) => allowed === ip || allowed === normalized);
  if (!ok) {
    req.sentinelControlDenied = 'admin_ip_gate';
    return res.status(404).send('Not found');
  }
  return next();
}

module.exports = { adminIpGate };
