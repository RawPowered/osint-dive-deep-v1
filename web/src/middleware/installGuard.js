/**
 * While uninstalled: only install + css + health + public landing.
 * Unknown paths get generic 404 (no redirect to /install — avoids advertising setup).
 */
function createInstallGuard(getState) {
  return function installGuard(req, res, next) {
    const state = getState();
    if (state.installed) return next();

    const path = req.path || '';
    const identity = getInstanceIdentity();
    if (
      path.startsWith('/install') ||
      path.startsWith('/css') ||
      path.startsWith('/js') ||
      path === identity.healthPath ||
      path === '/favicon.ico' ||
      path === '/'
    ) {
      return next();
    }

    if (isPathWithin(path, identity.publicApiBasePath)) {
      return res.status(503).json({ error: 'Service unavailable' });
    }

    if ((req.headers.accept || '').includes('application/json')) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.status(404).send('Not found');
  };
}

module.exports = { createInstallGuard };
const { getInstanceIdentity, isPathWithin } = require('../instanceIdentity');
