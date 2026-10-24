#!/usr/bin/env node
'use strict';
const { loadEnv } = require('../src/config');
loadEnv();
const { initDatabase } = require('../src/db/migrate');
const { closePool } = require('../src/db/pool');
const crm = require('../src/services/diveDeepCrmIntegration');

(async () => {
  const state = await initDatabase();
  if (!state.installed || !state.configured) throw new Error('DiveDeep database is not installed and configured');
  const limit = Math.min(Math.max(Number(process.argv[2]) || 100, 1), 500);
  const result = await crm.runCrmSweep({ limit, reconcileLimit: Math.max(limit, 200) });
  console.log(JSON.stringify(result, null, 2));
  await closePool();
})().catch(async (error) => {
  console.error(`DiveDeep CRM sweep failed: ${error.code || error.message}`);
  try { await closePool(); } catch {}
  process.exit(1);
});
