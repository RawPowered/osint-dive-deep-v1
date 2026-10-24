const cors = require('cors');
const { getCorsOrigins } = require('../config');

/**
 * CORS for browser clients (Dialer web, etc.).
 * - No Origin header (curl, native, server): always allowed at CORS layer
 * - CORS_ALLOW_ALL=true: reflect any Origin (Vibe-style preflight; less strict)
 * - CORS_ORIGINS=https://a.com,https://b.com: allowlist only
 * - Default (empty): block browser cross-origin (preflight fails intentionally)
 *
 * Always allows Authorization + common Dialer headers; OPTIONS succeeds with 200
 * before API auth when origin is permitted.
 */
function buildCorsOptions() {
  const list = getCorsOrigins();
  const requestedAllowAll = String(process.env.CORS_ALLOW_ALL || '').toLowerCase() === 'true';
  const allowAll = requestedAllowAll && process.env.NODE_ENV !== 'production';

  let origin;
  if (allowAll) {
    // Reflect request origin (works with Authorization; safer than bare "*" for credentialed-ish flows)
    origin = true;
  } else if (list.length > 0) {
    origin = (requestOrigin, callback) => {
      if (!requestOrigin) return callback(null, true);
      if (list.includes(requestOrigin)) return callback(null, true);
      return callback(null, false);
    };
  } else {
    // Non-browser clients only
    origin = (requestOrigin, callback) => {
      if (!requestOrigin) return callback(null, true);
      return callback(null, false);
    };
  }

  return {
    origin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
      'X-Operator-Token',
      'X-Request-Id',
      'X-DiveDeep-CSRF',
      'X-DiveDeep-Photo-Label',
      'X-DiveDeep-Photo-Purpose',
      'X-DiveDeep-File-Name',
      'Version',
    ],
    exposedHeaders: ['X-Request-Id'],
    optionsSuccessStatus: 200,
    credentials: !allowAll,
    maxAge: 86400,
    preflightContinue: false,
  };
}

function applyCors(app) {
  // Resolve origin settings for each request. The installer writes CORS_ORIGINS
  // during this process, after the Express app itself has already started.
  const corsMiddleware = (req, res, next) => cors(buildCorsOptions())(req, res, next);
  const list = getCorsOrigins();
  const requestedAllowAll = String(process.env.CORS_ALLOW_ALL || '').toLowerCase() === 'true';
  const allowAll = requestedAllowAll && process.env.NODE_ENV !== 'production';

  if (requestedAllowAll && !allowAll) {
    console.error('CORS_ALLOW_ALL is ignored in production; configure CORS_ORIGINS');
  } else if (allowAll) {
    console.log('CORS: ALLOW_ALL=true (any browser origin)');
  } else if (list.length) {
    console.log('CORS allowlist:', list.join(', '));
  } else {
    console.log('CORS: no browser origins configured (set CORS_ORIGINS or CORS_ALLOW_ALL=true)');
  }

  // Global CORS + explicit preflight on all routes (before auth)
  app.use(corsMiddleware);
  app.options('*', corsMiddleware);

  // Failsafe: if OPTIONS still open after cors, end without hitting auth
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      if (res.headersSent) return;
      return res.sendStatus(204);
    }
    next();
  });
}

module.exports = {
  buildCorsOptions,
  applyCors,
};
