#!/usr/bin/env node
'use strict';
const { loadEnv } = require('../src/config');
loadEnv();
const { initDatabase } = require('../src/db/migrate');
const { closePool } = require('../src/db/pool');
const externalApi = require('../src/services/diveDeepExternalApi');

(async () => {
  const state = await initDatabase();
  if (!state.installed || !state.configured) throw new Error('DiveDeep database is not installed and configured');
  const limit = Math.min(Math.max(Number(process.argv[2]) || 50, 1), 500);
  const result = await externalApi.runWebhookSweep({ limit });
  console.log(JSON.stringify(result, null, 2));
  await closePool();
})().catch(async (error) => {
  console.error(`DiveDeep webhook sweep failed: ${error.code || error.message}`);
  try { await closePool(); } catch {}
  process.exit(1);
});
