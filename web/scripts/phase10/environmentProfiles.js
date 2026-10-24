'use strict';
const fs = require('fs');

function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}
function loadEnvFile(file) { return parseEnvText(fs.readFileSync(file, 'utf8')); }
function compareProfiles(profiles) {
  const requiredEnvironments = ['development', 'staging', 'production'];
  const fields = ['DIVEDEEP_DEPLOYMENT_ID','INSTANCE_ID','DB_NAME','DIVEDEEP_STORAGE_NAMESPACE','DIVEDEEP_PUBLIC_ORIGIN','DIVEDEEP_API_ORIGIN'];
  const checks = [];
  const byEnvironment = new Map();
  for (const profile of profiles) {
    const env = String(profile.values.DEPLOYMENT_ENV || '').toLowerCase();
    checks.push({ id:`environment_${profile.name}`, ok:requiredEnvironments.includes(env), message:`${profile.name} must declare a supported DEPLOYMENT_ENV` });
    if (env) byEnvironment.set(env, profile);
  }
  for (const env of requiredEnvironments) checks.push({ id:`present_${env}`, ok:byEnvironment.has(env), message:`${env} profile is required` });
  for (const field of fields) {
    const values = profiles.map((profile) => String(profile.values[field] || '').trim());
    checks.push({ id:`complete_${field.toLowerCase()}`, ok:values.every(Boolean), message:`${field} must be set in every full environment file` });
    checks.push({ id:`unique_${field.toLowerCase()}`, ok:new Set(values.filter(Boolean)).size === profiles.length, message:`${field} must be unique across environments` });
  }
  const production = byEnvironment.get('production')?.values || {};
  checks.push({ id:'production_ack', ok:production.DIVEDEEP_PRODUCTION_ACK === 'DIVEDEEP_PRODUCTION', message:'Production acknowledgement is required' });
  checks.push({ id:'production_closed_cors', ok:String(production.CORS_ALLOW_ALL || '').toLowerCase() !== 'true', message:'Production CORS cannot allow all origins' });
  return { ok:checks.every((item)=>item.ok), checks };
}
module.exports = { parseEnvText, loadEnvFile, compareProfiles };
