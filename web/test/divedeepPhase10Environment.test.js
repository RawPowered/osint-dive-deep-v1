'use strict';
const assert = require('assert/strict');
const readiness = require('../src/services/diveDeepProductionReadiness');
const base = {
  NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', DIVEDEEP_DEPLOYMENT_ID: 'divedeep-prod-primary',
  INSTANCE_ID: 'instance-prod-1', DB_HOST: 'db.internal', DB_PORT: '3306', DB_NAME: 'divedeep_prod',
  DIVEDEEP_STORAGE_NAMESPACE: 'divedeep-prod-primary', DIVEDEEP_PUBLIC_ORIGIN: 'https://divedeep.example',
  DIVEDEEP_API_ORIGIN: 'https://api.divedeep.example', DIVEDEEP_PRIMARY_COMPUTE_PROVIDER: 'google_cloud_run_jobs',
  DIVEDEEP_PRODUCTION_ACK: 'DIVEDEEP_PRODUCTION', COOKIE_SECURE: 'true', CORS_ALLOW_ALL: 'false',
  ALLOW_REINSTALL: 'false', DIVEDEEP_AUTO_APPROVE: 'false', DIVEDEEP_SIGNUPS_ENABLED: 'false',
};
const valid = readiness.validateEnvironmentSeparation(base);
assert.equal(valid.ok, true);
assert.equal(valid.blockerCount, 0);
assert.match(valid.fingerprint, /^[a-f0-9]{64}$/);
const unsafe = readiness.validateEnvironmentSeparation({ ...base, CORS_ALLOW_ALL: 'true' });
assert.equal(unsafe.ok, false);
assert.ok(unsafe.checks.some((item) => item.id === 'cors_closed' && !item.ok));
assert.throws(() => readiness.normalizeDeploymentEnvironment('qa'), /DEPLOYMENT_ENV/);
console.log('DiveDeep Phase 10 environment separation checks passed');
