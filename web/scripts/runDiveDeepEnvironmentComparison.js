#!/usr/bin/env node
'use strict';
const path = require('path');
const { loadEnvFile, compareProfiles } = require('./phase10/environmentProfiles');
const files = process.argv.slice(2).filter((item) => !item.startsWith('--'));
if (files.length !== 3) {
  console.error('Usage: node scripts/runDiveDeepEnvironmentComparison.js development.env staging.env production.env');
  process.exit(2);
}
const profiles = files.map((file) => ({ name:path.basename(file), values:loadEnvFile(file) }));
const result = compareProfiles(profiles);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
