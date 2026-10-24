#!/usr/bin/env node
'use strict';
const { loadEnv } = require('../src/config');
loadEnv();
const { getPool } = require('../src/db/pool');
const runtime = require('../src/services/diveDeepWorkerRuntime');

(async () => {
  const limit = Math.min(Math.max(Number(process.argv[2]) || 100, 1), 500);
  const pool = getPool();
  const leases = await runtime.sweepExpiredLeases({ limit }, pool);
  const metadata = await runtime.sweepExpiredWorkerMetadata({ limit }, pool);
  console.log(JSON.stringify({ leases, metadata }, null, 2));
  await pool.end();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
