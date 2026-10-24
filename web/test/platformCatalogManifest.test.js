'use strict';

const assert = require('assert/strict');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'mysql2/promise') {
    return { createPool() { throw new Error('Unexpected real database pool creation'); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const catalog = require('../src/services/platformCatalog');
Module._load = originalLoad;

const observed = [];
const fakePool = {
  async query(sql, params) {
    observed.push({ sql: String(sql), params });
    if (String(sql).includes('FROM divedeep_packages p')) {
      return [[{
        id: 'package-version-1', package_id: 'standard', package_name: 'Basic Privacy', package_current_version: 1,
        version: 1, status: 'published', source_set_version_id: 'source-set-version-1', source_set_id: 'source-set-1',
        source_set_name: 'Standard Coverage', source_set_version: 1,
        requirements_json: '{}', execution_policy_json: '{}', review_policy_json: '{}', retention_policy_json: '{"nonmatchHours":24}',
        created_by: 'system', published_by: 'system', published_at: '2026-07-25 00:00:00', created_at: '2026-07-25 00:00:00', updated_at: '2026-07-25 00:00:00',
      }]];
    }
    if (String(sql).includes('FROM divedeep_source_set_pool_links l') && String(sql).includes('ORDER BY l.priority')) {
      return [[{
        inclusion_mode: 'include', priority: 10, filter_json: '{}', pool_version_id: 'pool-version-1', version: 1,
        pool_id: 'pool-1', slug: 'mainstream-social', name: 'Mainstream Social', namespace: 'divedeep.source', pool_type: 'category',
      }]];
    }
    if (String(sql).includes('FROM divedeep_package_image_analysis_links l')) {
      return [[{
        package_version_id: 'package-version-1', is_required: 0,
        id: 'image-profile-version-1', profile_id: 'image-profile-1', version: 1, status: 'published', provider: 'aws_rekognition',
        operations_json: '{"detectFaces":true,"compareFaces":true,"useCollections":false}',
        thresholds_json: '{"reviewFloor":78,"highPriorityThreshold":94}',
        limits_json: '{"maximumReferenceImages":3,"maximumCandidates":30}',
        quality_rules_json: '{}',
        review_policy_json: '{"humanReviewRequired":true,"autoConfirm":false,"customerValidationAllowed":true,"blurUntilDisposition":true,"defaultBlurStrength":18}',
        retention_policy_json: '{"nonmatchHours":24,"pendingReviewDays":30}',
        profile_slug: 'standard-image-safety', profile_name: 'Standard Image Safety',
        created_by: 'system', published_by: 'system', published_at: '2026-07-25 00:00:00', created_at: '2026-07-25 00:00:00', updated_at: '2026-07-25 00:00:00',
      }]];
    }
    if (String(sql).includes('FROM platform_resources r')) {
      return [[{
        id: 'resource-1', tenant_id: null, owner_scope: 'global', namespace: 'divedeep.source', resource_type: 'website',
        slug: 'example-source', name: 'Example Source', description: '', primary_domain: 'example.com', service_type: 'social',
        category: 'social', topic: 'profile', sensitivity_class: 'standard', jurisdiction_country: '', jurisdiction_region: '', adapter_key: 'example',
        metadata_schema_id: 'schema-1', metadata_schema_name: 'Website Source', metadata_schema_version: 1,
        metadata_json: '{}', capabilities_json: '{"usernameSearch":true}', declarations_json: '{}', limits_json: '{}',
        removal_methods_json: '{}', monitoring_support_json: '{}', status: 'active', revision: 1,
        created_by: 'system', updated_by: 'system', created_at: '2026-07-25 00:00:00', updated_at: '2026-07-25 00:00:00',
      }]];
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
};

(async () => {
  const manifest = await catalog.resolvePackageSourceManifest('standard', null, fakePool);
  assert.equal(manifest.package.packageId, 'standard');
  assert.equal(manifest.package.version, 1);
  assert.equal(manifest.sourceSet.id, 'source-set-1');
  assert.equal(manifest.sourceSet.versionId, 'source-set-version-1');
  assert.equal(manifest.pools[0].slug, 'mainstream-social');
  assert.equal(manifest.resources[0].primaryDomain, 'example.com');
  assert.equal(manifest.resources[0].capabilities.usernameSearch, true);
  assert.equal(manifest.imageAnalysis.provider, 'aws_rekognition');
  assert.equal(manifest.imageAnalysis.review.humanReviewRequired, true);
  assert.equal(manifest.imageAnalysis.presentation.blurredThumbnailStream, true);

  const packageQuery = observed.find((item) => item.sql.includes('FROM divedeep_packages p')).sql;
  const resourceQuery = observed.find((item) => item.sql.includes('FROM platform_resources r')).sql;
  assert.match(packageQuery, /v\.status='published'/);
  assert.match(packageQuery, /sv\.status='published'/);
  assert.match(resourceQuery, /m\.effective_at IS NULL/);
  assert.match(resourceQuery, /m\.expires_at IS NULL/);
  assert.match(resourceQuery, /l\.inclusion_mode='exclude'/);
  assert.match(resourceQuery, /r\.status='active'/);

  console.log('Platform catalog manifest resolution checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
