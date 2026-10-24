#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readiness = require('../src/services/diveDeepProductionReadiness');
const root = path.join(__dirname, '..');
const release = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE.json'), 'utf8'));
const matrix = readiness.loadCompatibilityMatrix(root);
const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, '').split('='); return [key, rest.join('=')];
}));
const result = readiness.validatePackageCompatibility({
  apiVersion: args.api || release.version,
  schemaVersion: Number(args.schema || release.schemaVersion),
  workerVersion: args.worker || matrix.divedeepWorker.tested,
  workerProtocol: args.protocol || matrix.divedeepWorker.protocol,
  frontendVersion: args.frontend || matrix.frontend.tested,
  nodeVersion: args.node || process.versions.node,
});
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
