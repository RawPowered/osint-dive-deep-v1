'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { validateAgainstSchema } = require('../src/services/jsonSchemaSubset');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const schema = read('sql/schema.sql');
const config = read('src/config.js');
const routes = read('src/routes/adminDiveDeep.js');
const service = read('src/services/platformCatalog.js');
const diveDeepService = read('src/services/diveDeep.js');
const admin = read('public/admin/divedeep.html');
const adminScript = read('public/js/divedeep-admin-v1.13.0.js');
const owlPools = read('src/services/servicePools.js');

assert.equal(packageJson.version, '1.16.0');
assert.match(config, /SCHEMA_VERSION:\s*['"']64['"']/);

const phase1Tables = [
  'platform_metadata_schemas',
  'platform_resources',
  'platform_resource_revisions',
  'platform_pools',
  'platform_pool_versions',
  'platform_pool_memberships',
  'divedeep_source_sets',
  'divedeep_source_set_versions',
  'divedeep_source_set_pool_links',
  'divedeep_source_set_resource_links',
  'divedeep_package_versions',
];
for (const table of phase1Tables) {
  assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`), `Missing Phase 1 table ${table}`);
}
for (const removed of ['divedeep_divedeep_nodes', 'divedeep_recon_runs', 'divedeep_recon_run_events']) {
  assert.doesNotMatch(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${removed}\\s*\\(`), `Superseded persistent-node table remains: ${removed}`);
}

// Existing OWL routing remains isolated and intact.
for (const table of ['owl_lead_pool_rules', 'owl_service_pools']) {
  assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
}
for (const contract of ['ensureDefaultServicePools', 'listServicePools', 'upsertServicePool', 'matchServiceType', 'classifyLeadRecord', 'selectServiceCalendar']) {
  assert.match(owlPools, new RegExp(`\\b${contract}\\b`));
}

// EAGLE remains available as the analytics surface.
for (const table of ['eagle_snapshots', 'eagle_lead_facts', 'eagle_lead_events', 'eagle_validation_runs', 'eagle_rollout_states', 'eagle_metric_targets']) {
  assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
}

// Fresh-install defaults establish the controlled vocabulary without inventing source records.
for (const poolSlug of ['mainstream-social', 'declared-profiles', 'identity-discovery', 'people-search', 'sensitive-exposure', 'image-discovery', 'monitoring']) {
  assert.ok(schema.includes(`'${poolSlug}'`), `Missing default source pool ${poolSlug}`);
}
for (const sourceSet of ['standard-coverage', 'deep-coverage', 'sensitive-coverage', 'image-coverage']) {
  assert.ok(schema.includes(`'${sourceSet}'`), `Missing default source set ${sourceSet}`);
}
assert.match(schema, /"nonmatchHours":24/);
assert.match(schema, /"pendingReviewDays":30/);

// API and Sentinel-controlled writes are part of the existing DiveDeep admin surface.
for (const route of [
  '/api/divedeep/catalog',
  '/api/divedeep/catalog/schemas',
  '/api/divedeep/catalog/resources',
  '/api/divedeep/catalog/pools',
  '/api/divedeep/catalog/pool-versions/:versionId',
  '/api/divedeep/catalog/source-sets',
  '/api/divedeep/catalog/source-set-versions/:versionId',
  '/api/divedeep/catalog/packages/:packageId/versions',
  '/api/divedeep/packages/:packageId/source-manifest',
]) {
  assert.ok(routes.includes(route), `Missing catalog route ${route}`);
}
for (const action of [
  'divedeep.catalog.schema.create',
  'divedeep.catalog.resource.create',
  'divedeep.catalog.pool_version.update',
  'divedeep.catalog.pool_version.publish',
  'divedeep.catalog.source_set_version.update',
  'divedeep.catalog.source_set_version.publish',
  'divedeep.catalog.package_version.publish',
]) {
  assert.ok(routes.includes(action), `Missing Sentinel action ${action}`);
}
assert.doesNotMatch(routes, /\/api\/divedeep\/divedeep\/nodes/);
assert.doesNotMatch(routes, /\/api\/divedeep\/recon-runs/);

// Package exports are now resolved from immutable package/source-set/pool versions.
assert.match(diveDeepService, /resolvePackageSourceManifest/);
assert.match(diveDeepService, /packageVersion:\s*sourceManifest\.package\.version/);
assert.match(diveDeepService, /sourcePools:\s*sourceManifest\.pools/);
assert.match(diveDeepService, /resources:\s*sourceManifest\.resources/);
assert.match(service, /Published pool versions are immutable/);
assert.match(service, /Published schemas are immutable/);
assert.match(service, /v\.status='published'/);
assert.match(service, /sv\.status='published'/);
assert.match(service, /r\.status='active'/);

// Admin UIX is integrated into the existing API admin area.
assert.match(admin, /data-view="catalog"/);
assert.ok(admin.includes('Source Catalog'));
assert.ok(admin.includes('Published versions are immutable'));
assert.match(admin, /divedeep-admin-v1\.13\.0\.js/);
assert.ok(adminScript.includes('/api/divedeep/catalog'));
assert.ok(adminScript.includes('/catalog/pool-versions/'));
assert.ok(adminScript.includes('/catalog/source-set-versions/'));
assert.ok(adminScript.includes('/source-manifest'));
assert.equal(adminScript.includes('/divedeep/nodes'), false);
assert.equal(adminScript.includes('/recon-runs'), false);

// Validate the supported JSON Schema subset without a database or external network.
const websiteSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['discoveryMethods', 'publicAccess'],
  properties: {
    discoveryMethods: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 2 } },
    publicAccess: { type: 'boolean' },
    confidenceFloor: { type: 'number', minimum: 0, maximum: 1 },
  },
};
assert.equal(validateAgainstSchema(websiteSchema, { discoveryMethods: ['username'], publicAccess: true, confidenceFloor: 0.8 }), true);
assert.throws(() => validateAgainstSchema(websiteSchema, { publicAccess: true }), /discoveryMethods is required/);
assert.throws(() => validateAgainstSchema(websiteSchema, { discoveryMethods: ['username'], publicAccess: 'yes' }), /publicAccess must be boolean/);
assert.throws(() => validateAgainstSchema(websiteSchema, { discoveryMethods: ['username'], publicAccess: true, extra: 1 }), /extra is not allowed/);
assert.throws(() => validateAgainstSchema(websiteSchema, { discoveryMethods: ['username', 'username'], publicAccess: true }), /unique items/);

console.log('DiveDeep Phase 1 resource catalog checks passed');
