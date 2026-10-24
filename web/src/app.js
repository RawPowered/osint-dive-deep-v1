const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const MySQLStoreFactory = require('express-mysql-session')(session);

const {
  ROOT,
  getSessionSecret,
  getDbConfig,
  getAdminBasePath,
  healthEnabled,
  trustProxyHops,
} = require('./config');
const { applyCors } = require('./middleware/corsSetup');
const { apiResponseSanitizer } = require('./middleware/responseSanitizer');
const { createInstallGuard } = require('./middleware/installGuard');
const { requireAdminSession, principalType } = require('./middleware/sessionAuth');
const { adminIpGate } = require('./middleware/adminGate');
const { controlPlaneSentinel } = require('./middleware/controlPlaneSentinel');
const { createInstallRouter } = require('./routes/install');
const { createAuthRouter } = require('./routes/auth');
const { createAdminKeysRouter } = require('./routes/adminKeys');
const { createAdminSqlRouter } = require('./routes/adminSql');
const { createAdminCrmRouter } = require('./routes/adminCrm');
const { createAdminOwlRouter } = require('./routes/adminOwl');
const { createAdminEagleRouter } = require('./routes/adminEagle');
const { createAdminSongRouter } = require('./routes/adminSong');
const { createAdminHawkRouter } = require('./routes/adminHawk');
const { createAdminParrotRouter } = require('./routes/adminParrot');
const { createAdminDiveDeepRouter } = require('./routes/adminDiveDeep');
const { createHawkWebhookRouter } = require('./routes/hawkWebhooks');
const { createOwlWebhookRouter } = require('./routes/owlWebhooks');
const { createCrmWebhookRouter } = require('./routes/crmWebhooks');
const { createDocsRouter } = require('./routes/docs');
const { createSentinelRouter } = require('./routes/sentinel');
const { createApiRouter } = require('./routes/api');
const { createInstanceDataRouter } = require('./routes/instanceData');
const { createDiveDeepRouter } = require('./routes/diveDeep');
const { getTelemetryWriterStatus } = require('./services/telemetryWriter');
const { telemetryWriterCheck } = require('./services/sentinelHealth');
const {
  getInstanceIdentity,
  isPathWithin,
  relativeMountedUrl,
} = require('./instanceIdentity');

function generic404(req, res) {
  if (isPathWithin(req.path, getInstanceIdentity().publicApiBasePath) ||
      (req.headers.accept || '').includes('application/json')) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.status(404).send('Not found');
}

function buildAdminRouter() {
  const adminRouter = express.Router();
  adminRouter.use(controlPlaneSentinel);
  adminRouter.use(adminIpGate);
  adminRouter.use(createAuthRouter());
  adminRouter.get('/', requireAdminSession, (req, res) => {
    if (principalType(req.session.admin) === 'tenant') return res.redirect(`${getAdminBasePath()}/owl`);
    res.sendFile(path.join(ROOT, 'public', 'admin', 'index.html'));
  });
  adminRouter.use(createAdminKeysRouter());
  adminRouter.use(createAdminSqlRouter());
  adminRouter.use(createAdminCrmRouter());
  adminRouter.use(createAdminOwlRouter());
  adminRouter.use(createAdminEagleRouter());
  adminRouter.use(createAdminSongRouter());
  adminRouter.use(createAdminHawkRouter());
  adminRouter.use(createAdminParrotRouter());
  adminRouter.use(createAdminDiveDeepRouter());
  adminRouter.use(createSentinelRouter());
  adminRouter.use('/docs', createDocsRouter());
  return adminRouter;
}

/**
 * Build Express app.
 * appState: { installed, configured, sessionSecret?, onInstalled? }
 */
function createApp(appState) {
  const app = express();
  const adminRouter = buildAdminRouter();
  const apiRouter = express.Router();
  const webhookRouter = express.Router();
  apiRouter.use(apiResponseSanitizer, createApiRouter());
  webhookRouter.use('/hawk', apiResponseSanitizer, createHawkWebhookRouter());
  webhookRouter.use('/owl', apiResponseSanitizer, createOwlWebhookRouter());
  webhookRouter.use('/crm', apiResponseSanitizer, createCrmWebhookRouter());

  app.disable('x-powered-by');

  const trust = trustProxyHops();
  if (trust !== false) {
    app.set('trust proxy', trust);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'unsafe-inline'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginEmbedderPolicy: false,
      // Allow cross-origin API calls from browser apps (CORS still enforces Origin)
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  // CORS + OPTIONS preflight BEFORE body parser / auth (Vibe update intent, hardened)
  applyCors(app);

  app.use((req, res, next) => {
    const identity = getInstanceIdentity();
    const bulkLeadImport = req.method === 'POST' &&
      req.path === `${identity.publicApiBasePath}/leads/bulk`;
    const divedeepEvidenceUpload = req.method === 'POST' &&
      /\/api\/divedeep\/customers\/[^/]+\/import-batches\/[^/]+\/evidence\/[^/]+$/.test(req.path);
    if (divedeepEvidenceUpload) return next();
    const divedeepResultImport = req.method === 'POST' && (
      /\/api\/divedeep\/customers\/[^/]+\/divedeep-results$/.test(req.path) ||
      /\/api\/divedeep\/customers\/[^/]+\/import-batches$/.test(req.path) ||
      /\/api\/divedeep\/customers\/[^/]+\/import-batches\/[^/]+\/parts\/\d+$/.test(req.path)
    );
    const jsonLimit = bulkLeadImport ? '50mb' : divedeepResultImport ? '5mb' : '256kb';
    return express.json({
      limit: jsonLimit,
      verify: (request, response, buffer) => {
        if (isPathWithin(request.path, identity.webhookBasePath) ||
            /\/api\/divedeep\/customers\/[^/]+\/import-batches\/[^/]+\/parts\/\d+$/.test(request.path)) {
          request.rawBody = Buffer.from(buffer);
        }
      },
    })(req, res, next);
  });
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());

  // Public static only — never expose admin/install HTML via static root
  app.use('/css', express.static(path.join(ROOT, 'public', 'css'), { index: false, dotfiles: 'deny' }));
  app.use('/js', express.static(path.join(ROOT, 'public', 'js'), { index: false, dotfiles: 'deny' }));
  app.use('/assets', express.static(path.join(ROOT, 'public', 'assets'), { index: false, dotfiles: 'deny' }));
  app.get('/divedeep-runtime.js', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'divedeep-runtime.js'));
  });
  app.use('/data', createInstanceDataRouter());
  app.use('/data', express.static(path.join(ROOT, 'public', 'data'), { index: false, dotfiles: 'deny' }));

  let sessionMiddleware = buildSessionMiddleware(appState);
  app.use((req, res, next) => sessionMiddleware(req, res, next));

  appState.onInstalled = async () => {
    sessionMiddleware = buildSessionMiddleware(appState);
  };

  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path !== getInstanceIdentity().healthPath) return next();
    if (!healthEnabled()) return generic404(req, res);
    const writerHealth = telemetryWriterCheck(getTelemetryWriterStatus());
    const sentinelRequired = Boolean(appState.installed && appState.configured);
    const ok = !sentinelRequired || (appState.sentinelReady && writerHealth.status !== 'critical');
    res.status(ok ? 200 : 503).json({
      ok,
      telemetry: ok ? 'operational' : 'degraded',
    });
  });

  app.use('/install', createInstallRouter(appState));
  app.use(createInstallGuard(() => appState));

  // Flow-scoped, authenticated event ingestion. This must remain outside the
  // hidden admin base so external systems can deliver events to it.
  app.use(dynamicMount(() => getInstanceIdentity().webhookBasePath, webhookRouter));

  app.use('/divedeep', createDiveDeepRouter());

  // Canonical Phase 9 administration boundary. It is predictable for managed
  // clients but remains protected by the same admin session, IP gate, CSRF,
  // RBAC, and Sentinel controls as the hidden administrative mount.
  app.use('/api/admin/divedeep', apiResponseSanitizer, (req, res, next) => {
    res.setHeader('X-DiveDeep-API-Version', '1');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const originalUrl = req.url;
    const suffix = req.url === '/' ? '' : req.url;
    req.url = `/api/divedeep${suffix}`;
    return adminRouter(req, res, (error) => {
      req.url = originalUrl;
      return next(error);
    });
  });

  app.get('/', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'divedeep', 'index.html'));
  });

  app.use(dynamicMount(() => getInstanceIdentity().publicApiBasePath, apiRouter));

  // Dynamic secret admin base (reads ADMIN_BASE_PATH each request — works after install)
  app.use((req, res, next) => {
    const base = getAdminBasePath();
    if (!base || base === '/') return next();
    if (req.path !== base && !req.path.startsWith(`${base}/`)) return next();

    const rest = req.url.slice(base.length) || '/';
    req.url = rest.startsWith('/') ? rest : `/${rest}`;
    return adminRouter(req, res, next);
  });

  // Predictable recon paths → generic 404
  for (const p of ['/admin', '/docs', '/administrator', '/wp-admin', '/login']) {
    app.all(p, generic404);
    app.all(`${p}/*`, generic404);
  }

  app.use(generic404);

  return app;
}

function buildSessionMiddleware(appState) {
  const secret = appState.sessionSecret || getSessionSecret();
  const base = {
    secret,
    resave: false,
    saveUninitialized: false,
    name: getInstanceIdentity().sessionCookieName,
    cookie: {
      httpOnly: true,
      // OAuth returns through a cross-site top-level GET. Lax keeps that callback session-bound
      // while still withholding the cookie from cross-site subrequests and POSTs.
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' ||
        String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  };

  if (appState.installed && appState.configured) {
    try {
      const cfg = getDbConfig();
      const store = new MySQLStoreFactory({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        clearExpired: true,
        checkExpirationInterval: 900000,
        expiration: 7 * 24 * 60 * 60 * 1000,
        createDatabaseTable: true,
        schema: {
          tableName: 'admin_sessions',
        },
      });
      return session({ ...base, store });
    } catch (err) {
      console.warn('MySQL session store unavailable, using memory store:', err.message);
    }
  }

  return session(base);
}

function dynamicMount(getBasePath, router) {
  return (req, res, next) => {
    const basePath = getBasePath();
    if (!isPathWithin(req.path, basePath)) return next();
    const originalUrl = req.url;
    req.url = relativeMountedUrl(req.url, basePath);
    return router(req, res, (error) => {
      req.url = originalUrl;
      return next(error);
    });
  };
}

module.exports = { createApp, dynamicMount };
