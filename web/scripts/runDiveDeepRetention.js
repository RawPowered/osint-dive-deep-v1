#!/usr/bin/env node
const { loadEnv } = require('../src/config');
const { initDatabase } = require('../src/db/migrate');
const { closePool } = require('../src/db/pool');
const { runRetentionSweep } = require('../src/services/diveDeepArtifacts');

(async () => {
  loadEnv();
  const state = await initDatabase();
  if (!state.installed || !state.configured) throw new Error('DiveDeep database is not installed and configured');
  const result = await runRetentionSweep({ limit: Number(process.argv[2]) || 250 });
  console.log(JSON.stringify(result, null, 2));
  await closePool();
})().catch(async (error) => {
  console.error(`DiveDeep retention sweep failed: ${error.code || error.message}`);
  try { await closePool(); } catch {}
  process.exit(1);
});
