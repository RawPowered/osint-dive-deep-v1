'use strict';
const assert = require('assert/strict');
const { parseEnvText, compareProfiles } = require('../scripts/phase10/environmentProfiles');
function profile(env, suffix) {
  return { name:`${env}.env`, values:parseEnvText(`DEPLOYMENT_ENV=${env}\nDIVEDEEP_DEPLOYMENT_ID=fid-${suffix}\nINSTANCE_ID=i-${suffix}\nDB_NAME=db_${suffix}\nDIVEDEEP_STORAGE_NAMESPACE=storage-${suffix}\nDIVEDEEP_PUBLIC_ORIGIN=https://${suffix}.example\nDIVEDEEP_API_ORIGIN=https://api-${suffix}.example\nCORS_ALLOW_ALL=false\nDIVEDEEP_PRODUCTION_ACK=${env === 'production' ? 'DIVEDEEP_PRODUCTION' : ''}`) };
}
const valid = compareProfiles([profile('development','dev'),profile('staging','stage'),profile('production','prod')]);
assert.equal(valid.ok,true);
const duplicate = profile('production','stage');
duplicate.values.DIVEDEEP_PRODUCTION_ACK='DIVEDEEP_PRODUCTION';
const invalid = compareProfiles([profile('development','dev'),profile('staging','stage'),duplicate]);
assert.equal(invalid.ok,false);
assert.ok(invalid.checks.some((item)=>item.id==='unique_db_name' && !item.ok));
console.log('DiveDeep Phase 10 environment profile comparison checks passed');
