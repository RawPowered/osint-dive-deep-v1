'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'mysql2/promise') {
    return { createPool() { throw new Error('Database access is not part of the Phase 1.1 contract test'); } };
  }
  return originalLoad(request, parent, isMain);
};
const { sanitizeConfig, PROVIDERS, publicIntegration } = require('../src/services/diveDeepIntegrations');
const rekognition = require('../src/services/diveDeepRekognition');
const imageAnalysis = require('../src/services/diveDeepImageAnalysis');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const schema = read('sql/schema.sql');
const routes = read('src/routes/adminDiveDeep.js');
const catalog = read('src/services/platformCatalog.js');
const packageJson = JSON.parse(read('package.json'));
const config = read('src/config.js');

assert.equal(packageJson.version, '1.16.0');
assert.match(config, /SCHEMA_VERSION:\s*['"']64['"']/);
assert.ok(PROVIDERS.aws_rekognition);
assert.ok(packageJson.dependencies['@aws-sdk/client-rekognition']);
assert.ok(packageJson.dependencies['@aws-sdk/client-sts']);

for (const table of [
  'divedeep_image_analysis_profiles',
  'divedeep_image_analysis_profile_versions',
  'divedeep_package_image_analysis_links',
  'divedeep_image_analysis_sessions',
  'divedeep_image_analysis_items',
  'divedeep_image_analysis_events',
]) assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));

assert.match(schema, /customer_validation_requested/);
assert.ok(schema.includes('\"pendingReviewDays\":30'));
assert.ok(schema.includes('\"nonmatchHours\":24'));
assert.doesNotMatch(schema, /CreateCollection|IndexFaces|SearchFacesByImage/);
assert.match(schema, /provider_result_enc\s+LONGTEXT/);
assert.doesNotMatch(schema, /provider_result_json\s+LONGTEXT/);

const cfg = sanitizeConfig('aws_rekognition', {
  credentialMode: 'assume_role',
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/DiveDeepRekognition',
  inputMode: 'bytes',
  defaultSimilarityThreshold: '75',
  highPriorityThreshold: '92',
  enableFaceComparison: true,
  enableModeration: false,
});
assert.equal(cfg.region, 'us-east-1');
assert.equal(cfg.defaultSimilarityThreshold, 75);
assert.equal(cfg.enableFaceComparison, true);
assert.throws(() => sanitizeConfig('aws_rekognition', { credentialMode: 'assume_role', region: 'bad', roleArn: 'bad' }), /AWS Region|Role ARN/);
assert.throws(() => sanitizeConfig('aws_rekognition', { credentialMode: 'static_keys', region: 'us-east-1', accessKeyId: 'leak' }), /protected secret/);
assert.deepEqual(rekognition.enabledOperations(cfg), ['DetectFaces', 'CompareFaces', 'DetectText']);

const profile = imageAnalysis.normalizeProfileVersion({
  operations: { detectFaces: true, compareFaces: true, detectText: true },
  thresholds: { reviewFloor: 75, highPriorityThreshold: 92 },
  reviewPolicy: { humanReviewRequired: false, autoConfirm: false, customerValidationAllowed: true },
});
assert.equal(profile.reviewPolicy.humanReviewRequired, true);
assert.equal(profile.reviewPolicy.autoConfirm, false);
assert.equal(profile.operations.useCollections, false);
assert.throws(() => imageAnalysis.normalizeProfileVersion({ operations: { useCollections: true } }), /collections are not permitted/);
assert.throws(() => imageAnalysis.normalizeProfileVersion({ operations: { compareFaces: true, detectFaces: false } }), /Face detection must remain enabled/);
assert.throws(() => imageAnalysis.normalizeProfileVersion({ reviewPolicy: { autoConfirm: true } }), /Automatic face-match confirmation/);

const normalized = imageAnalysis.normalizeRekognitionResult({
  FaceMatches: [{ Similarity: 93.4, Face: { Confidence: 99.1, BoundingBox: { Width: .2, Height: .3, Left: .1, Top: .1 } } }],
  $metadata: { requestId: 'request-fixture' },
}, { region: 'us-east-1', operations: ['CompareFaces'], referenceArtifactIds: ['ref-1'], candidateArtifactId: 'candidate-1' }, profile);
assert.equal(normalized.reviewBand, 'high_priority');
assert.equal(normalized.humanReviewRequired, true);
assert.equal(normalized.maximumSimilarity, 93.4);
assert.deepEqual(normalized.providerRequestIds, ['request-fixture']);
assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'Landmarks'), false);

const presentation = imageAnalysis.buildPresentationItem({
  id: 'item-1', state: 'customer_validation_requested', providerSimilarity: 82, reviewConfidence: 72,
  thumbnailArtifactId: 'thumb-1',
}, profile);
assert.equal(presentation.blurred, true);
assert.equal(presentation.visibility, 'customer_validation');
assert.equal(presentation.customerValidationAvailable, true);
assert.equal(presentation.customerValidationRequested, true);

const contract = imageAnalysis.presentationContract();
assert.ok(contract.itemStates.includes('customer_validation_requested'));
assert.equal(contract.privacyDefaults.blurredThumbnailStream, true);
assert.equal(contract.privacyDefaults.humanValidationRequired, true);

for (const route of [
  '/api/divedeep/integrations/aws_rekognition/status',
  '/api/divedeep/integrations/aws_rekognition/verify-identity',
  '/api/divedeep/integrations/aws_rekognition/verify-access',
  '/api/divedeep/image-analysis/profiles',
  '/api/divedeep/image-analysis/profile-versions/:versionId',
  '/api/divedeep/image-analysis/preview-manifest',
  '/api/divedeep/image-analysis/presentation-contract',
  '/api/divedeep/catalog/package-versions/:versionId/image-analysis',
]) assert.ok(routes.includes(route), `Missing Phase 1.1 route ${route}`);

const customerRoutes = read('src/routes/diveDeep.js');
for (const route of [
  '/api/image-analysis/sessions',
  '/api/image-analysis/sessions/:sessionId',
  '/api/image-analysis/items/:itemId/validation',
]) assert.ok(customerRoutes.includes(route), `Missing customer-safe image-analysis route ${route}`);
assert.match(customerRoutes, /requireCustomerSession/);
assert.match(customerRoutes, /requireCustomerCsrf/);

for (const action of [
  'divedeep.integration.rekognition.verify_identity',
  'divedeep.integration.rekognition.verify_access',
  'divedeep.image_analysis.profile.create',
  'divedeep.image_analysis.version.publish',
  'divedeep.image_analysis.package_link.update',
]) assert.ok(routes.includes(action), `Missing Sentinel control ${action}`);

assert.match(catalog, /imageAnalysis:\s*await imageAnalysis\.resolvePackageImageAnalysis/);
const diveDeepService = read('src/services/diveDeep.js');
assert.match(diveDeepService, /imageAnalysis:\s*sourceManifest\.imageAnalysis/);
assert.match(diveDeepService, /blurred by default/);
assert.match(diveDeepService, /do not retain completed case data in the worker/);
const safePublic = publicIntegration({ provider: 'aws_rekognition', config_json: JSON.stringify(cfg), secrets_enc: 'secret-material', secret_hints_json: JSON.stringify({ secretAccessKey: '••••abcd' }), is_enabled: 1 });
assert.equal(JSON.stringify(safePublic).includes('secret-material'), false);
assert.equal(safePublic.secrets.find((item) => item.field === 'secretAccessKey').hint, '••••abcd');

Module._load = originalLoad;
console.log('DiveDeep Phase 1.1 Rekognition and image-analysis contract checks passed');
