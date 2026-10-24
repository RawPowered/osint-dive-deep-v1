#!/usr/bin/env node
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const manifestPath = process.argv[2] || path.join(__dirname, '..', 'deploy', 'rollback', 'ROLLBACK_MANIFEST.example.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const errors = [];
if (manifest.strategy !== 'restore_verified_backup_then_deploy_previous_application') errors.push('Rollback strategy must be restore_verified_backup_then_deploy_previous_application');
if (!Number.isInteger(Number(manifest.sourceSchemaVersion))) errors.push('sourceSchemaVersion is required');
if (!Number.isInteger(Number(manifest.targetSchemaVersion))) errors.push('targetSchemaVersion is required');
if (Number(manifest.targetSchemaVersion) >= Number(manifest.sourceSchemaVersion)) errors.push('targetSchemaVersion must be lower than sourceSchemaVersion');
if (!manifest.backupFile) errors.push('backupFile is required');
if (!/^[a-f0-9]{64}$/i.test(String(manifest.backupSha256 || ''))) errors.push('backupSha256 must contain 64 hexadecimal characters');
let actualSha256 = null;
if (manifest.backupFile && fs.existsSync(manifest.backupFile)) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(manifest.backupFile));
  actualSha256 = hash.digest('hex');
  if (actualSha256 !== String(manifest.backupSha256).toLowerCase()) errors.push('Backup SHA-256 does not match rollback manifest');
}
const result = { ok: errors.length === 0, manifestPath, backupPresent: Boolean(manifest.backupFile && fs.existsSync(manifest.backupFile)), actualSha256, errors };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
