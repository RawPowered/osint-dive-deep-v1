#!/usr/bin/env node
'use strict';
const { loadEnv } = require('../src/config');
const { closePool } = require('../src/db/pool');
const readiness = require('../src/services/diveDeepProductionReadiness');
(async () => {
  loadEnv();
  const overview = await readiness.getProductionReadinessOverview();
  console.log(JSON.stringify(overview, null, 2));
  if (!overview.environment.ok || !overview.releaseGate.ready) process.exitCode = 1;
  await closePool();
})().catch(async (error) => { console.error(error.code || error.message); try { await closePool(); } catch {} process.exitCode = 1; });
