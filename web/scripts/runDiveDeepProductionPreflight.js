#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEnv, ROOT, SCHEMA_VERSION } = require('../src/config');
const readiness = require('../src/services/diveDeepProductionReadiness');

loadEnv();
const release = JSON.parse(fs.readFileSync(path.join(ROOT, 'RELEASE.json'), 'utf8'));
const matrix = readiness.loadCompatibilityMatrix(ROOT);
const environment = readiness.validateEnvironmentSeparation(process.env);
const compatibility = readiness.validatePackageCompatibility({
  apiVersion: release.version,
  schemaVersion: Number(SCHEMA_VERSION),
  workerVersion: process.env.DIVEDEEP_EXPECTED_WORKER_VERSION || matrix.divedeepWorker.tested,
  workerProtocol: process.env.DIVEDEEP_EXPECTED_WORKER_PROTOCOL || matrix.divedeepWorker.protocol,
  frontendVersion: process.env.DIVEDEEP_EXPECTED_FRONTEND_VERSION || matrix.frontend.tested,
  nodeVersion: process.versions.node,
});
const result = { ok: environment.ok && compatibility.ok, environment, compatibility };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
