const { loadEnv, getSessionSecret, assertRuntimeSecurity } = require('./src/config');
const { initDatabase, applySchema } = require('./src/db/migrate');
const { getPool, closePool } = require('./src/db/pool');
const { createApp } = require('./src/app');
const { purgeOldEvents } = require('./src/services/sentinel');
const { purgeOldLoginEvents } = require('./src/services/loginSecurity');
const { runSentinelPreflight } = require('./src/services/sentinelPreflight');
const { cleanupExpiredImports, resumePendingImportJobs } = require('./src/services/diveDeepImports');
const { runRetentionSweep } = require('./src/services/diveDeepArtifacts');
const { sweepExpiredLeases, sweepExpiredWorkerMetadata } = require('./src/services/diveDeepWorkerRuntime');
const { runCrmSweep } = require('./src/services/diveDeepCrmIntegration');
const { runWebhookSweep, purgeExternalApiState } = require('./src/services/diveDeepExternalApi');

async function main() {
  loadEnv();

  const appState = {
    installed: false,
    configured: false,
    sentinelReady: false,
    sentinelPreflight: null,
    sessionSecret: getSessionSecret(),
  };

  const dbState = await initDatabase();
  appState.installed = Boolean(dbState.installed);
  appState.configured = Boolean(dbState.configured);
  if (dbState.error) {
    console.warn('DB not ready:', dbState.error);
  }
  assertRuntimeSecurity(appState);

  // Ensure new tables (e.g. api_sentinel_events) exist after upgrades
  if (appState.installed && appState.configured) {
    try {
      await applySchema(getPool());
      appState.sentinelPreflight = await runSentinelPreflight(getPool());
      appState.sentinelReady = appState.sentinelPreflight.ready;
      if (!appState.sentinelReady) {
        console.error(
          `Sentinel preflight NOT READY: ${appState.sentinelPreflight.failed} failed, ${appState.sentinelPreflight.warnings} warning(s)`
        );
      }
    } catch (err) {
      appState.sentinelReady = false;
      console.error(`Sentinel/schema initialization failed code=${err.code || err.name || 'INITIALIZATION_FAILED'}`);
    }
  }

  const app = createApp(appState);
  const PORT = Number(process.env.PORT || 3000);

  const server = app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`API server listening on port ${PORT}`);
    if (!appState.installed) {
      console.log(`Installation required → /install`);
    } else {
      // Do not print full admin path to shared logs if avoidable; hint only
      console.log('Installed. Admin path is in ADMIN_BASE_PATH (.env). Public site does not link it.');
    }
    const corsAll = String(process.env.CORS_ALLOW_ALL || '').toLowerCase() === 'true';
    const corsOrigins = process.env.CORS_ORIGINS || '';
    console.log(
      corsAll
        ? 'CORS_ALLOW_ALL=true'
        : corsOrigins
          ? `CORS_ORIGINS=${corsOrigins}`
          : 'CORS not open to browsers — set CORS_ORIGINS or CORS_ALLOW_ALL in .env'
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received. Closing HTTP and database connections.`);
    const forceTimer = setTimeout(() => process.exit(1), 15000);
    forceTimer.unref();
    await new Promise((resolve) => server.close(resolve));
    await closePool();
    clearTimeout(forceTimer);
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  if (appState.installed && appState.configured) {
    setTimeout(() => {
      resumePendingImportJobs().then((result) => {
        if (result.queued) console.log(`DiveDeep resumed ${result.queued} background import job(s).`);
      }).catch((error) => console.warn(`DiveDeep import recovery failed code=${error.code || error.name || 'IMPORT_RECOVERY_FAILED'}`));
    }, 1500);
  }

  // Disposable DiveDeep workers heartbeat through short-lived job leases.
  // Lease recovery is local database work only; it does not call Cloud Run or external sources.
  if (appState.installed && appState.configured) {
    const sweepLeases = () => sweepExpiredLeases({ limit: 100 }).catch((error) => {
      console.warn(`DiveDeep worker lease recovery failed code=${error.code || error.name || 'WORKER_LEASE_SWEEP_FAILED'}`);
    });
    setInterval(sweepLeases, 60 * 1000);
    setTimeout(sweepLeases, 20 * 1000);
  }

  // Durable CRM outbox/inbox processing. Idempotency keys and row locks make this safe
  // across restarts and horizontally scaled API instances.
  if (appState.installed && appState.configured && String(process.env.DIVEDEEP_CRM_SWEEP_ENABLED || 'true').toLowerCase() !== 'false') {
    const requestedInterval = Number(process.env.DIVEDEEP_CRM_SWEEP_INTERVAL_MS || 60000);
    const intervalMs = Number.isFinite(requestedInterval) ? Math.min(Math.max(requestedInterval, 30000), 15 * 60 * 1000) : 60000;
    const sweepCrm = () => runCrmSweep({ limit: 100, reconcileLimit: 200 }).catch((error) => {
      console.warn(`DiveDeep CRM queue sweep failed code=${error.code || error.name || 'CRM_SWEEP_FAILED'}`);
    });
    setInterval(sweepCrm, intervalMs);
    setTimeout(sweepCrm, 15000);
  }

  // Signed Phase 9 webhook delivery queue. The body is a customer-safe projection,
  // signed with a per-subscription HMAC secret and retried with stale-lock recovery.
  if (appState.installed && appState.configured && String(process.env.DIVEDEEP_WEBHOOK_SWEEP_ENABLED || 'true').toLowerCase() !== 'false') {
    const requestedInterval = Number(process.env.DIVEDEEP_WEBHOOK_SWEEP_INTERVAL_MS || 60000);
    const intervalMs = Number.isFinite(requestedInterval) ? Math.min(Math.max(requestedInterval, 30000), 15 * 60 * 1000) : 60000;
    const sweepWebhooks = () => runWebhookSweep({ limit: 100 }).catch((error) => {
      console.warn(`DiveDeep signed webhook sweep failed code=${error.code || error.name || 'WEBHOOK_SWEEP_FAILED'}`);
    });
    setInterval(sweepWebhooks, intervalMs);
    setTimeout(sweepWebhooks, 25000);
  }

  // Daily-ish retention cleanup (every 6 hours)
  if (appState.installed) {
    const purgeAll = async () => {
      const results = await Promise.allSettled([
        purgeOldEvents(),
        purgeOldLoginEvents(),
        cleanupExpiredImports(),
        runRetentionSweep({ limit: 250 }),
        sweepExpiredWorkerMetadata({ limit: 500 }),
        purgeExternalApiState(),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') console.warn(`Retention cleanup failed code=${result.reason?.code || result.reason?.name || 'CLEANUP_FAILED'}`);
      }
    };
    setInterval(purgeAll, 6 * 60 * 60 * 1000);
    setTimeout(purgeAll, 60 * 1000);
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
