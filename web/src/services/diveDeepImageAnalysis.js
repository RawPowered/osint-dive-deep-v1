const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { encryptSecret, decryptSecret } = require('./secretBox');

const PROVIDER = 'aws_rekognition';
const PROFILE_STATUSES = new Set(['draft', 'published', 'retired']);
const REVIEW_BANDS = Object.freeze(['low_priority', 'manual_review', 'high_priority']);
const ITEM_STATES = Object.freeze([
  'discovered', 'analyzing', 'likely_match', 'reviewer_confirmed',
  'customer_validation_requested', 'customer_confirmed', 'rejected', 'expired',
]);
const VISIBILITY_STATES = Object.freeze(['internal', 'review', 'customer_validation', 'published']);

function clean(value, max = 2048) { return String(value == null ? '' : value).trim().slice(0, max); }
function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : fallback; } catch { return fallback; }
}
function objectInput(value, label) {
  const parsed = parseJson(value, null);
  if (!parsed || Array.isArray(parsed)) throw statusError(`${label} must be a JSON object`);
  return parsed;
}
function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
function statusError(message, status = 400, code = 'DIVEDEEP_IMAGE_ANALYSIS_INVALID') {
  return Object.assign(new Error(message), { status, code });
}
function uuid() { return crypto.randomUUID(); }
function slugify(value, label = 'Slug') {
  const slug = clean(value, 128).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw statusError(`${label} is required`);
  return slug;
}
function iso(value) { return value ? new Date(value).toISOString() : null; }

function normalizeOperations(input = {}) {
  const operations = {
    detectFaces: bool(input.detectFaces, true),
    compareFaces: bool(input.compareFaces, true),
    detectModerationLabels: bool(input.detectModerationLabels, false),
    detectText: bool(input.detectText, false),
    detectLabels: bool(input.detectLabels, false),
    useCollections: false,
  };
  if (bool(input.useCollections, false)) throw statusError('Rekognition face collections are not permitted in Phase 1.1');
  if (operations.compareFaces && !operations.detectFaces) throw statusError('Face detection must remain enabled when face comparison is enabled');
  if (!Object.entries(operations).some(([name, enabled]) => name !== 'useCollections' && enabled)) throw statusError('Enable at least one image-analysis operation');
  return operations;
}

function normalizeThresholds(input = {}) {
  const thresholds = {
    reviewFloor: number(input.reviewFloor, 75, 0, 100),
    highPriorityThreshold: number(input.highPriorityThreshold, 92, 0, 100),
    minimumFaceConfidence: number(input.minimumFaceConfidence, 95, 0, 100),
    minimumModerationConfidence: number(input.minimumModerationConfidence, 70, 0, 100),
  };
  if (thresholds.highPriorityThreshold < thresholds.reviewFloor) throw statusError('High-priority threshold cannot be below the review floor');
  return thresholds;
}

function normalizeReviewPolicy(input = {}, operations = {}) {
  const policy = {
    humanReviewRequired: operations.compareFaces ? true : bool(input.humanReviewRequired, true),
    autoConfirm: false,
    autoRejectFromSimilarityOnly: false,
    customerValidationAllowed: bool(input.customerValidationAllowed, true),
    customerValidationMinimumConfidence: number(input.customerValidationMinimumConfidence, 60, 0, 100),
    restrictedReviewerRequired: bool(input.restrictedReviewerRequired, false),
    blurUntilDisposition: input.blurUntilDisposition == null ? true : bool(input.blurUntilDisposition, true),
    defaultBlurStrength: Math.round(number(input.defaultBlurStrength, 18, 4, 40)),
  };
  if (bool(input.autoConfirm, false)) throw statusError('Automatic face-match confirmation is not permitted');
  return policy;
}

function normalizeProfileVersion(input = {}) {
  const operations = normalizeOperations(input.operations || {});
  const thresholds = normalizeThresholds(input.thresholds || {});
  const reviewPolicy = normalizeReviewPolicy(input.reviewPolicy || {}, operations);
  const limits = {
    maximumReferenceImages: Math.round(number(input.limits?.maximumReferenceImages, 5, 1, 20)),
    maximumCandidates: Math.round(number(input.limits?.maximumCandidates, 100, 1, 10000)),
    maximumOperationsPerCandidate: Math.round(number(input.limits?.maximumOperationsPerCandidate, 8, 1, 50)),
  };
  const qualityRules = {
    requireSinglePrimaryFace: input.qualityRules?.requireSinglePrimaryFace == null ? false : bool(input.qualityRules.requireSinglePrimaryFace),
    minimumBrightness: number(input.qualityRules?.minimumBrightness, 20, 0, 100),
    minimumSharpness: number(input.qualityRules?.minimumSharpness, 20, 0, 100),
    maximumAbsoluteYaw: number(input.qualityRules?.maximumAbsoluteYaw, 45, 0, 90),
    maximumAbsolutePitch: number(input.qualityRules?.maximumAbsolutePitch, 45, 0, 90),
  };
  const retentionPolicy = {
    nonmatchHours: Math.round(number(input.retentionPolicy?.nonmatchHours, 24, 1, 168)),
    pendingReviewDays: Math.round(number(input.retentionPolicy?.pendingReviewDays, 30, 1, 90)),
    retainDetailedLandmarks: false,
  };
  return { provider: PROVIDER, operations, thresholds, limits, qualityRules, reviewPolicy, retentionPolicy };
}

function reviewBand(similarity, thresholds = {}) {
  const score = Number(similarity);
  if (!Number.isFinite(score) || score < Number(thresholds.reviewFloor ?? 75)) return 'low_priority';
  if (score >= Number(thresholds.highPriorityThreshold ?? 92)) return 'high_priority';
  return 'manual_review';
}

function normalizeRekognitionResult(raw = {}, context = {}, profile = normalizeProfileVersion({})) {
  const matches = Array.isArray(raw.FaceMatches) ? raw.FaceMatches : [];
  const maximumSimilarity = matches.reduce((max, item) => Math.max(max, Number(item.Similarity) || 0), 0) || null;
  const faceDetails = Array.isArray(raw.FaceDetails) ? raw.FaceDetails : [];
  const moderation = Array.isArray(raw.ModerationLabels) ? raw.ModerationLabels.map((item) => ({
    name: clean(item.Name, 160), parentName: clean(item.ParentName, 160), confidence: Number(item.Confidence) || 0,
  })) : [];
  const detectedText = Array.isArray(raw.TextDetections) ? raw.TextDetections.slice(0, 100).map((item) => ({
    text: clean(item.DetectedText, 500), type: clean(item.Type, 32), confidence: Number(item.Confidence) || 0,
  })) : [];
  const contextLabels = Array.isArray(raw.Labels) ? raw.Labels.slice(0, 100).map((item) => ({
    name: clean(item.Name, 160), confidence: Number(item.Confidence) || 0,
  })) : [];
  return {
    provider: PROVIDER,
    providerRegion: clean(context.region, 64) || null,
    operations: Array.isArray(context.operations) ? context.operations.slice(0, 10) : [],
    referenceArtifactIds: Array.isArray(context.referenceArtifactIds) ? context.referenceArtifactIds.slice(0, 20) : [],
    candidateArtifactId: clean(context.candidateArtifactId, 36) || null,
    faceCount: faceDetails.length,
    maximumSimilarity,
    referenceComparisons: matches.slice(0, 100).map((item) => ({
      similarity: Number(item.Similarity) || 0,
      confidence: Number(item.Face?.Confidence) || 0,
      boundingBox: item.Face?.BoundingBox ? {
        width: Number(item.Face.BoundingBox.Width) || 0,
        height: Number(item.Face.BoundingBox.Height) || 0,
        left: Number(item.Face.BoundingBox.Left) || 0,
        top: Number(item.Face.BoundingBox.Top) || 0,
      } : null,
    })),
    quality: faceDetails[0]?.Quality ? {
      brightness: Number(faceDetails[0].Quality.Brightness) || null,
      sharpness: Number(faceDetails[0].Quality.Sharpness) || null,
      poseWarnings: [],
    } : { brightness: null, sharpness: null, poseWarnings: [] },
    moderation,
    detectedText,
    contextLabels,
    reviewBand: reviewBand(maximumSimilarity, profile.thresholds),
    humanReviewRequired: true,
    providerRequestIds: raw.$metadata?.requestId ? [raw.$metadata.requestId] : [],
    completedAt: new Date().toISOString(),
  };
}

function buildPresentationItem(item = {}, profile = normalizeProfileVersion({})) {
  const state = ITEM_STATES.includes(item.state) ? item.state : 'discovered';
  const reviewConfidence = number(item.reviewConfidence, 0, 0, 100);
  const customerValidationRequested = state === 'customer_validation_requested';
  const visibility = customerValidationRequested ? 'customer_validation' : (VISIBILITY_STATES.includes(item.visibility) ? item.visibility : 'review');
  return {
    id: clean(item.id, 36) || null,
    state,
    visibility,
    phaseLabel: customerValidationRequested ? 'Your confirmation requested' : clean(item.phaseLabel, 160) || 'Analysis and validation',
    blurred: profile.reviewPolicy.blurUntilDisposition && !['customer_confirmed', 'reviewer_confirmed', 'published'].includes(state),
    blurStrength: profile.reviewPolicy.defaultBlurStrength,
    thumbnailArtifactId: clean(item.thumbnailArtifactId, 36) || null,
    progressPercent: Math.round(number(item.progressPercent, state === 'analyzing' ? 55 : 100, 0, 100)),
    reviewBand: REVIEW_BANDS.includes(item.reviewBand) ? item.reviewBand : reviewBand(item.providerSimilarity, profile.thresholds),
    providerSimilarity: item.providerSimilarity == null ? null : number(item.providerSimilarity, 0, 0, 100),
    reviewConfidence,
    humanValidated: ['reviewer_confirmed', 'customer_confirmed'].includes(state),
    customerValidationAvailable: profile.reviewPolicy.customerValidationAllowed && reviewConfidence >= profile.reviewPolicy.customerValidationMinimumConfidence,
    customerValidationRequested,
    safeStatusText: clean(item.safeStatusText, 240) || (state === 'analyzing' ? 'Comparing candidate imagery and validating context' : 'Human review is protecting against false matches'),
    expiresAt: item.expiresAt || null,
  };
}

function profileVersionRow(row) {
  return {
    id: row.id, profileId: row.profile_id, version: Number(row.version), status: row.status, provider: row.provider,
    operations: parseJson(row.operations_json, {}), thresholds: parseJson(row.thresholds_json, {}), limits: parseJson(row.limits_json, {}),
    qualityRules: parseJson(row.quality_rules_json, {}), reviewPolicy: parseJson(row.review_policy_json, {}), retentionPolicy: parseJson(row.retention_policy_json, {}),
    createdBy: row.created_by || null, publishedBy: row.published_by || null, publishedAt: iso(row.published_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
function profileRow(row) {
  return { id: row.id, slug: row.slug, name: row.name, description: row.description || '', status: row.status, currentVersion: Number(row.current_version) || 0, createdBy: row.created_by || null, updatedBy: row.updated_by || null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), versions: [] };
}

async function listProfiles(pool = null) {
  const p = pool || getPool();
  const [profiles] = await p.query('SELECT * FROM divedeep_image_analysis_profiles ORDER BY name');
  const [versions] = await p.query('SELECT * FROM divedeep_image_analysis_profile_versions ORDER BY profile_id,version DESC');
  const byId = new Map(profiles.map((row) => [row.id, profileRow(row)]));
  for (const row of versions) if (byId.has(row.profile_id)) byId.get(row.profile_id).versions.push(profileVersionRow(row));
  return [...byId.values()];
}

async function createProfile(input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const id = uuid();
  const slug = slugify(input.slug || input.name, 'Profile slug');
  const name = clean(input.name, 160);
  if (!name) throw statusError('Profile name is required');
  await p.query(`INSERT INTO divedeep_image_analysis_profiles (id,slug,name,description,status,current_version,created_by,updated_by) VALUES (?,?,?,?, 'draft',0,?,?)`, [id, slug, name, clean(input.description, 2000), clean(actorId, 128) || null, clean(actorId, 128) || null]);
  if (input.createVersion !== false) await createProfileVersion(id, input.version || input, actorId, p);
  return (await listProfiles(p)).find((item) => item.id === id);
}

async function createProfileVersion(profileId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_image_analysis_profiles WHERE id=? LIMIT 1', [clean(profileId, 36)]);
  if (!rows[0]) throw statusError('Image-analysis profile not found', 404, 'DIVEDEEP_IMAGE_PROFILE_NOT_FOUND');
  const [nextRows] = await p.query('SELECT COALESCE(MAX(version),0)+1 AS next_version FROM divedeep_image_analysis_profile_versions WHERE profile_id=?', [rows[0].id]);
  const version = Number(nextRows[0]?.next_version) || 1;
  const normalized = normalizeProfileVersion(input);
  const id = uuid();
  await p.query(`INSERT INTO divedeep_image_analysis_profile_versions (id,profile_id,version,status,provider,operations_json,thresholds_json,limits_json,quality_rules_json,review_policy_json,retention_policy_json,created_by) VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?)`, [id, rows[0].id, version, normalized.provider, JSON.stringify(normalized.operations), JSON.stringify(normalized.thresholds), JSON.stringify(normalized.limits), JSON.stringify(normalized.qualityRules), JSON.stringify(normalized.reviewPolicy), JSON.stringify(normalized.retentionPolicy), clean(actorId, 128) || null]);
  if (bool(input.publish)) await publishProfileVersion(id, actorId, p);
  return (await listProfiles(p)).find((item) => item.id === rows[0].id)?.versions.find((item) => item.id === id);
}

async function updateProfileVersion(versionId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_image_analysis_profile_versions WHERE id=? LIMIT 1', [clean(versionId, 36)]);
  const row = rows[0];
  if (!row) throw statusError('Image-analysis profile version not found', 404, 'DIVEDEEP_IMAGE_PROFILE_VERSION_NOT_FOUND');
  if (row.status !== 'draft') throw statusError('Published image-analysis profile versions are immutable', 409, 'DIVEDEEP_IMAGE_PROFILE_IMMUTABLE');
  const current = profileVersionRow(row);
  const normalized = normalizeProfileVersion({
    operations: input.operations ?? current.operations,
    thresholds: input.thresholds ?? current.thresholds,
    limits: input.limits ?? current.limits,
    qualityRules: input.qualityRules ?? current.qualityRules,
    reviewPolicy: input.reviewPolicy ?? current.reviewPolicy,
    retentionPolicy: input.retentionPolicy ?? current.retentionPolicy,
  });
  await p.query(`UPDATE divedeep_image_analysis_profile_versions SET operations_json=?,thresholds_json=?,limits_json=?,quality_rules_json=?,review_policy_json=?,retention_policy_json=?,updated_at=NOW(3) WHERE id=?`, [JSON.stringify(normalized.operations), JSON.stringify(normalized.thresholds), JSON.stringify(normalized.limits), JSON.stringify(normalized.qualityRules), JSON.stringify(normalized.reviewPolicy), JSON.stringify(normalized.retentionPolicy), row.id]);
  if (bool(input.publish)) await publishProfileVersion(row.id, actorId, p);
  return (await listProfiles(p)).find((item) => item.id === row.profile_id)?.versions.find((item) => item.id === row.id);
}

async function publishProfileVersion(versionId, actorId = null, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_image_analysis_profile_versions WHERE id=? LIMIT 1', [clean(versionId, 36)]);
  const row = rows[0];
  if (!row) throw statusError('Image-analysis profile version not found', 404);
  if (row.status === 'published') return (await listProfiles(p)).find((item) => item.id === row.profile_id)?.versions.find((item) => item.id === row.id);
  if (row.status !== 'draft') throw statusError('Only draft versions can be published', 409);
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE divedeep_image_analysis_profile_versions SET status='published',published_by=?,published_at=NOW(3),updated_at=NOW(3) WHERE id=?", [clean(actorId, 128) || null, row.id]);
    await conn.query("UPDATE divedeep_image_analysis_profiles SET status='active',current_version=?,updated_by=?,updated_at=NOW(3) WHERE id=?", [row.version, clean(actorId, 128) || null, row.profile_id]);
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  return (await listProfiles(p)).find((item) => item.id === row.profile_id)?.versions.find((item) => item.id === row.id);
}

async function setPackageProfile(packageVersionId, profileVersionId, required = false, actorId = null, pool = null) {
  const p = pool || getPool();
  const [packages] = await p.query('SELECT id,status FROM divedeep_package_versions WHERE id=? LIMIT 1', [clean(packageVersionId, 36)]);
  if (!packages[0]) throw statusError('Package version not found', 404);
  if (packages[0].status !== 'draft') throw statusError('Published package versions are immutable', 409, 'DIVEDEEP_PACKAGE_VERSION_IMMUTABLE');
  const [profiles] = await p.query("SELECT id,status FROM divedeep_image_analysis_profile_versions WHERE id=? AND status='published' LIMIT 1", [clean(profileVersionId, 36)]);
  if (!profiles[0]) throw statusError('A published image-analysis profile version is required', 409);
  await p.query(`INSERT INTO divedeep_package_image_analysis_links (package_version_id,image_analysis_profile_version_id,is_required,created_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE image_analysis_profile_version_id=VALUES(image_analysis_profile_version_id),is_required=VALUES(is_required),created_by=VALUES(created_by),updated_at=NOW(3)`, [packages[0].id, profiles[0].id, bool(required) ? 1 : 0, clean(actorId, 128) || null]);
  return getPackageProfile(packages[0].id, p);
}

async function getPackageProfile(packageVersionId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(`SELECT l.package_version_id,l.is_required,v.*,p.slug AS profile_slug,p.name AS profile_name FROM divedeep_package_image_analysis_links l INNER JOIN divedeep_image_analysis_profile_versions v ON v.id=l.image_analysis_profile_version_id INNER JOIN divedeep_image_analysis_profiles p ON p.id=v.profile_id WHERE l.package_version_id=? LIMIT 1`, [clean(packageVersionId, 36)]);
  if (!rows[0]) return null;
  return { packageVersionId: rows[0].package_version_id, required: Boolean(rows[0].is_required), profile: { ...profileVersionRow(rows[0]), slug: rows[0].profile_slug, name: rows[0].profile_name } };
}

async function resolvePackageImageAnalysis(packageVersionId, pool = null) {
  const link = await getPackageProfile(packageVersionId, pool);
  if (!link) return null;
  return {
    provider: link.profile.provider,
    profileId: link.profile.profileId,
    profileSlug: link.profile.slug,
    profileName: link.profile.name,
    profileVersionId: link.profile.id,
    profileVersion: link.profile.version,
    required: link.required,
    operations: link.profile.operations,
    thresholds: link.profile.thresholds,
    limits: link.profile.limits,
    qualityRules: link.profile.qualityRules,
    review: link.profile.reviewPolicy,
    retention: link.profile.retentionPolicy,
    presentation: {
      blurredThumbnailStream: true,
      blurUntilDisposition: link.profile.reviewPolicy.blurUntilDisposition,
      defaultBlurStrength: link.profile.reviewPolicy.defaultBlurStrength,
      customerValidationEnabled: link.profile.reviewPolicy.customerValidationAllowed,
      customerValidationState: 'customer_validation_requested',
      statusLanguage: 'analysis_and_validation',
    },
  };
}

function previewManifest(input = {}) {
  const normalized = normalizeProfileVersion(input);
  return {
    provider: normalized.provider,
    ...normalized,
    presentation: {
      blurredThumbnailStream: true,
      blurUntilDisposition: normalized.reviewPolicy.blurUntilDisposition,
      defaultBlurStrength: normalized.reviewPolicy.defaultBlurStrength,
      customerValidationEnabled: normalized.reviewPolicy.customerValidationAllowed,
      states: ITEM_STATES,
      visibilityStates: VISIBILITY_STATES,
    },
  };
}

async function createSession(input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const profileVersionId = clean(input.profileVersionId, 36);
  const [profiles] = await p.query("SELECT * FROM divedeep_image_analysis_profile_versions WHERE id=? AND status='published' LIMIT 1", [profileVersionId]);
  if (!profiles[0]) throw statusError('A published image-analysis profile version is required', 409, 'DIVEDEEP_IMAGE_PROFILE_REQUIRED');
  const id = uuid();
  const presentation = {
    contractVersion: 1,
    blurredThumbnailStream: true,
    blurUntilDisposition: parseJson(profiles[0].review_policy_json, {}).blurUntilDisposition !== false,
    statusLanguage: 'analysis_and_validation',
  };
  await p.query(
    `INSERT INTO divedeep_image_analysis_sessions
      (id,customer_id,recon_job_id,package_version_id,profile_version_id,status,public_phase,progress_percent,presentation_json,started_at,expires_at)
     VALUES (?,?,?,?,?,'created','analysis_and_validation',0,?,NULL,?)`,
    [id, clean(input.customerId, 36) || null, clean(input.reconJobId, 36) || null, clean(input.packageVersionId, 36) || null,
      profileVersionId, JSON.stringify(presentation), input.expiresAt ? new Date(input.expiresAt) : null]
  );
  await p.query(
    `INSERT INTO divedeep_image_analysis_events (id,session_id,event_type,actor_type,actor_id,details_json)
     VALUES (?,?, 'session.created','system',?,?)`,
    [uuid(), id, clean(actorId, 128) || null, JSON.stringify({ profileVersionId })]
  );
  return getSession(id, p);
}

async function getSession(sessionId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_image_analysis_sessions WHERE id=? LIMIT 1', [clean(sessionId, 36)]);
  if (!rows[0]) throw statusError('Image-analysis session not found', 404, 'DIVEDEEP_IMAGE_SESSION_NOT_FOUND');
  const row = rows[0];
  return {
    id: row.id, customerId: row.customer_id || null, reconJobId: row.recon_job_id || null,
    packageVersionId: row.package_version_id || null, profileVersionId: row.profile_version_id,
    status: row.status, publicPhase: row.public_phase, progressPercent: Number(row.progress_percent) || 0,
    counts: { discovered: Number(row.discovered_count) || 0, analyzed: Number(row.analyzed_count) || 0, review: Number(row.review_count) || 0, confirmed: Number(row.confirmed_count) || 0, customerAction: Number(row.customer_action_count) || 0 },
    presentation: parseJson(row.presentation_json, {}), startedAt: iso(row.started_at), completedAt: iso(row.completed_at), expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

async function profileForSession(sessionId, pool) {
  const [rows] = await pool.query(
    `SELECT v.* FROM divedeep_image_analysis_sessions s
     INNER JOIN divedeep_image_analysis_profile_versions v ON v.id=s.profile_version_id
     WHERE s.id=? LIMIT 1`, [clean(sessionId, 36)]
  );
  if (!rows[0]) throw statusError('Image-analysis session not found', 404, 'DIVEDEEP_IMAGE_SESSION_NOT_FOUND');
  return profileVersionRow(rows[0]);
}

async function upsertAnalysisItem(sessionId, input = {}, actor = {}, pool = null) {
  const p = pool || getPool();
  const session = await getSession(sessionId, p);
  const profile = await profileForSession(session.id, p);
  const id = clean(input.id, 36) || uuid();
  const state = ITEM_STATES.includes(input.state) ? input.state : 'discovered';
  const providerSimilarity = input.providerSimilarity == null ? null : number(input.providerSimilarity, 0, 0, 100);
  const band = REVIEW_BANDS.includes(input.reviewBand) ? input.reviewBand : reviewBand(providerSimilarity, profile.thresholds);
  const presentation = buildPresentationItem({ ...input, id, state, reviewBand: band, providerSimilarity }, { ...profile, reviewPolicy: profile.reviewPolicy, thresholds: profile.thresholds });
  const retentionClass = clean(input.retentionClass, 64) || (state === 'rejected' ? 'transient_nonmatch' : 'pending_review');
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : (retentionClass === 'transient_nonmatch' ? new Date(Date.now() + profile.retentionPolicy.nonmatchHours * 3600000) : new Date(Date.now() + profile.retentionPolicy.pendingReviewDays * 86400000));
  const normalizedResult = objectInput(input.normalizedResult || {}, 'Normalized provider result');
  await p.query(
    `INSERT INTO divedeep_image_analysis_items
      (id,session_id,candidate_artifact_id,thumbnail_artifact_id,source_resource_id,state,visibility,review_band,provider_similarity,review_confidence,provider_result_enc,presentation_json,retention_class,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE candidate_artifact_id=VALUES(candidate_artifact_id),thumbnail_artifact_id=VALUES(thumbnail_artifact_id),source_resource_id=VALUES(source_resource_id),state=VALUES(state),visibility=VALUES(visibility),review_band=VALUES(review_band),provider_similarity=VALUES(provider_similarity),review_confidence=VALUES(review_confidence),provider_result_enc=VALUES(provider_result_enc),presentation_json=VALUES(presentation_json),retention_class=VALUES(retention_class),expires_at=VALUES(expires_at),updated_at=NOW(3)`,
    [id, session.id, clean(input.candidateArtifactId, 36) || null, clean(input.thumbnailArtifactId, 36) || null, clean(input.sourceResourceId, 36) || null,
      state, presentation.visibility, band, providerSimilarity, input.reviewConfidence == null ? null : number(input.reviewConfidence, 0, 0, 100),
      encryptSecret(JSON.stringify(normalizedResult)), JSON.stringify(presentation), retentionClass, expiresAt]
  );
  await p.query(
    `INSERT INTO divedeep_image_analysis_events (id,session_id,item_id,event_type,actor_type,actor_id,details_json)
     VALUES (?,?,?,?,?,?,?)`,
    [uuid(), session.id, id, input.eventType || 'item.updated', ['system','worker','reviewer','customer'].includes(actor.type) ? actor.type : 'system', clean(actor.id, 128) || null, JSON.stringify({ state, reviewBand: band })]
  );
  await refreshSessionCounts(session.id, p);
  return getAnalysisItem(id, p);
}

async function getAnalysisItem(itemId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_image_analysis_items WHERE id=? LIMIT 1', [clean(itemId, 36)]);
  if (!rows[0]) throw statusError('Image-analysis item not found', 404, 'DIVEDEEP_IMAGE_ITEM_NOT_FOUND');
  const row = rows[0];
  return {
    id: row.id, sessionId: row.session_id, candidateArtifactId: row.candidate_artifact_id || null, thumbnailArtifactId: row.thumbnail_artifact_id || null,
    sourceResourceId: row.source_resource_id || null, state: row.state, visibility: row.visibility, reviewBand: row.review_band,
    providerSimilarity: row.provider_similarity == null ? null : Number(row.provider_similarity), reviewConfidence: row.review_confidence == null ? null : Number(row.review_confidence),
    normalizedResult: parseJson(decryptSecret(row.provider_result_enc), {}), presentation: parseJson(row.presentation_json, {}), reviewerId: row.reviewer_id || null,
    reviewerNote: row.reviewer_note || '', customerDisposition: row.customer_disposition, customerDispositionAt: iso(row.customer_disposition_at),
    retentionClass: row.retention_class, expiresAt: iso(row.expires_at), dispositionedAt: iso(row.dispositioned_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

async function refreshSessionCounts(sessionId, pool) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS discovered,
       SUM(state NOT IN ('discovered','analyzing')) AS analyzed,
       SUM(state IN ('likely_match','customer_validation_requested')) AS review_count,
       SUM(state IN ('reviewer_confirmed','customer_confirmed')) AS confirmed_count,
       SUM(state='customer_validation_requested') AS customer_action_count
     FROM divedeep_image_analysis_items WHERE session_id=?`, [sessionId]
  );
  const counts = rows[0] || {};
  const total = Number(counts.discovered) || 0;
  const analyzed = Number(counts.analyzed) || 0;
  const progress = total ? Math.min(99, Math.round((analyzed / total) * 100)) : 0;
  const status = Number(counts.customer_action_count) ? 'awaiting_customer_validation' : (Number(counts.review_count) ? 'awaiting_review' : (total && analyzed === total ? 'completed' : 'analyzing'));
  await pool.query(
    `UPDATE divedeep_image_analysis_sessions SET status=?,progress_percent=?,discovered_count=?,analyzed_count=?,review_count=?,confirmed_count=?,customer_action_count=?,started_at=COALESCE(started_at,NOW(3)),completed_at=IF(?='completed',NOW(3),completed_at),updated_at=NOW(3) WHERE id=?`,
    [status, status === 'completed' ? 100 : progress, total, analyzed, Number(counts.review_count) || 0, Number(counts.confirmed_count) || 0, Number(counts.customer_action_count) || 0, status, sessionId]
  );
}

async function reviewItem(itemId, action, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const item = await getAnalysisItem(itemId, p);
  const profile = await profileForSession(item.sessionId, p);
  const reviewConfidence = number(input.reviewConfidence ?? item.reviewConfidence, 0, 0, 100);
  let state; let visibility; let retentionClass; let expiresAt = null;
  if (action === 'confirm') {
    state = 'reviewer_confirmed'; visibility = 'review'; retentionClass = 'confirmed_relevant';
  } else if (action === 'reject') {
    state = 'rejected'; visibility = 'internal'; retentionClass = 'transient_nonmatch'; expiresAt = new Date(Date.now() + profile.retentionPolicy.nonmatchHours * 3600000);
  } else if (action === 'request_customer_validation') {
    if (!profile.reviewPolicy.customerValidationAllowed) throw statusError('Customer validation is disabled for this profile', 409, 'DIVEDEEP_CUSTOMER_VALIDATION_DISABLED');
    if (reviewConfidence < profile.reviewPolicy.customerValidationMinimumConfidence) throw statusError('Reviewer confidence is below the profile minimum for customer validation', 409, 'DIVEDEEP_CUSTOMER_VALIDATION_CONFIDENCE');
    state = 'customer_validation_requested'; visibility = 'customer_validation'; retentionClass = 'pending_review'; expiresAt = new Date(Date.now() + profile.retentionPolicy.pendingReviewDays * 86400000);
  } else if (action === 'publish') {
    if (!['reviewer_confirmed','customer_confirmed'].includes(item.state)) throw statusError('Only validated matches can be published', 409, 'DIVEDEEP_IMAGE_ITEM_NOT_VALIDATED');
    state = item.state; visibility = 'published'; retentionClass = 'confirmed_relevant';
  } else throw statusError('Unsupported image-analysis disposition action');
  const presentation = buildPresentationItem({ ...item, state, visibility, reviewConfidence, phaseLabel: state === 'customer_validation_requested' ? 'Your confirmation requested' : 'Analysis and validation' }, { ...profile, reviewPolicy: profile.reviewPolicy, thresholds: profile.thresholds });
  await p.query(
    `UPDATE divedeep_image_analysis_items SET state=?,visibility=?,review_confidence=?,reviewer_id=?,reviewer_note=?,retention_class=?,expires_at=?,dispositioned_at=NOW(3),presentation_json=?,updated_at=NOW(3) WHERE id=?`,
    [state, visibility, reviewConfidence, clean(actorId, 128) || null, clean(input.note, 2000), retentionClass, expiresAt, JSON.stringify(presentation), item.id]
  );
  await p.query(
    `INSERT INTO divedeep_image_analysis_events (id,session_id,item_id,event_type,actor_type,actor_id,details_json)
     VALUES (?,?,?,?, 'reviewer',?,?)`,
    [uuid(), item.sessionId, item.id, `item.${action}`, clean(actorId, 128) || null, JSON.stringify({ state, visibility, reviewConfidence, retentionClass })]
  );
  await refreshSessionCounts(item.sessionId, p);
  return getAnalysisItem(item.id, p);
}

async function getPresentationFeed(sessionId, options = {}, pool = null) {
  const p = pool || getPool();
  const session = await getSession(sessionId, p);
  const customerSafe = bool(options.customerSafe, false);
  const where = customerSafe ? " AND visibility IN ('customer_validation','published')" : '';
  const [rows] = await p.query(`SELECT * FROM divedeep_image_analysis_items WHERE session_id=?${where} ORDER BY updated_at DESC,id`, [session.id]);
  return {
    session,
    items: rows.map((row) => {
      const presentation = parseJson(row.presentation_json, {});
      const base = { id: row.id, state: row.state, visibility: row.visibility, thumbnailArtifactId: row.thumbnail_artifact_id || null, presentation, expiresAt: iso(row.expires_at), updatedAt: iso(row.updated_at) };
      if (!customerSafe) return { ...base, reviewBand: row.review_band, providerSimilarity: row.provider_similarity == null ? null : Number(row.provider_similarity), reviewConfidence: row.review_confidence == null ? null : Number(row.review_confidence), normalizedResult: parseJson(decryptSecret(row.provider_result_enc), {}) };
      return { ...base, customerDisposition: row.customer_disposition };
    }),
    contract: presentationContract(),
  };
}

async function listCustomerSessions(customerId, options = {}, pool = null) {
  const p = pool || getPool();
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
  const [rows] = await p.query(
    `SELECT * FROM divedeep_image_analysis_sessions
     WHERE customer_id=? AND status<>'expired'
     ORDER BY updated_at DESC,id DESC LIMIT ?`,
    [clean(customerId, 36), limit]
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    publicPhase: row.public_phase,
    progressPercent: Number(row.progress_percent) || 0,
    counts: {
      discovered: Number(row.discovered_count) || 0,
      analyzed: Number(row.analyzed_count) || 0,
      review: Number(row.review_count) || 0,
      confirmed: Number(row.confirmed_count) || 0,
      customerAction: Number(row.customer_action_count) || 0,
    },
    presentation: parseJson(row.presentation_json, {}),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    expiresAt: iso(row.expires_at),
    updatedAt: iso(row.updated_at),
  }));
}

async function getCustomerPresentationFeed(customerId, sessionId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    'SELECT id FROM divedeep_image_analysis_sessions WHERE id=? AND customer_id=? LIMIT 1',
    [clean(sessionId, 36), clean(customerId, 36)]
  );
  if (!rows[0]) throw statusError('Image-analysis session not found', 404, 'DIVEDEEP_IMAGE_SESSION_NOT_FOUND');
  return getPresentationFeed(rows[0].id, { customerSafe: true }, p);
}

async function submitCustomerValidation(customerId, itemId, disposition, input = {}, pool = null) {
  const p = pool || getPool();
  const normalizedDisposition = clean(disposition, 32).toLowerCase();
  if (!['confirmed', 'not_me', 'unsure'].includes(normalizedDisposition)) {
    throw statusError('Customer validation must be confirmed, not_me, or unsure');
  }
  const [rows] = await p.query(
    `SELECT i.*,s.customer_id,s.profile_version_id
     FROM divedeep_image_analysis_items i
     INNER JOIN divedeep_image_analysis_sessions s ON s.id=i.session_id
     WHERE i.id=? AND s.customer_id=? LIMIT 1`,
    [clean(itemId, 36), clean(customerId, 36)]
  );
  const row = rows[0];
  if (!row) throw statusError('Image-analysis item not found', 404, 'DIVEDEEP_IMAGE_ITEM_NOT_FOUND');
  if (row.state !== 'customer_validation_requested' || row.visibility !== 'customer_validation') {
    throw statusError('This item is not awaiting customer validation', 409, 'DIVEDEEP_CUSTOMER_VALIDATION_NOT_AVAILABLE');
  }
  const profile = await profileForSession(row.session_id, p);
  const current = await getAnalysisItem(row.id, p);
  let state = row.state;
  let visibility = row.visibility;
  let retentionClass = row.retention_class;
  let expiresAt = row.expires_at;
  let customerDisposition = normalizedDisposition;
  if (normalizedDisposition === 'confirmed') {
    state = 'customer_confirmed';
    visibility = 'customer_validation';
    retentionClass = 'confirmed_relevant';
    expiresAt = null;
  } else if (normalizedDisposition === 'not_me') {
    state = 'rejected';
    visibility = 'internal';
    retentionClass = 'transient_nonmatch';
    expiresAt = new Date(Date.now() + profile.retentionPolicy.nonmatchHours * 3600000);
  } else {
    customerDisposition = 'unsure';
    retentionClass = 'pending_review';
    expiresAt = new Date(Date.now() + profile.retentionPolicy.pendingReviewDays * 86400000);
  }
  const presentation = buildPresentationItem({
    ...current,
    state,
    visibility,
    phaseLabel: normalizedDisposition === 'confirmed'
      ? 'Confirmation received'
      : normalizedDisposition === 'not_me'
        ? 'Not identified as you'
        : 'Additional review requested',
    safeStatusText: normalizedDisposition === 'confirmed'
      ? 'Your confirmation was received and the evidence remains under protected review.'
      : normalizedDisposition === 'not_me'
        ? 'This candidate was excluded from your case.'
        : 'Your uncertainty was recorded so a reviewer can take another look.',
  }, { ...profile, reviewPolicy: profile.reviewPolicy, thresholds: profile.thresholds });
  await p.query(
    `UPDATE divedeep_image_analysis_items
     SET state=?,visibility=?,customer_disposition=?,customer_disposition_at=NOW(3),retention_class=?,expires_at=?,dispositioned_at=NOW(3),presentation_json=?,updated_at=NOW(3)
     WHERE id=?`,
    [state, visibility, customerDisposition, retentionClass, expiresAt, JSON.stringify(presentation), row.id]
  );
  await p.query(
    `INSERT INTO divedeep_image_analysis_events
      (id,session_id,item_id,event_type,actor_type,actor_id,details_json)
     VALUES (?,?,?,?, 'customer',?,?)`,
    [uuid(), row.session_id, row.id, `item.customer_${normalizedDisposition}`, clean(customerId, 128), JSON.stringify({ disposition: normalizedDisposition, noteProvided: Boolean(clean(input.note, 1000)) })]
  );
  await refreshSessionCounts(row.session_id, p);
  const updated = await getAnalysisItem(row.id, p);
  return {
    id: updated.id,
    sessionId: updated.sessionId,
    state: updated.state,
    visibility: updated.visibility,
    thumbnailArtifactId: updated.thumbnailArtifactId,
    presentation: updated.presentation,
    customerDisposition: updated.customerDisposition,
    expiresAt: updated.expiresAt,
    updatedAt: updated.updatedAt,
  };
}

function presentationContract() {
  return {
    version: 1,
    itemStates: ITEM_STATES,
    visibilityStates: VISIBILITY_STATES,
    reviewBands: REVIEW_BANDS,
    privacyDefaults: { blurredThumbnailStream: true, noPublicRawProviderData: true, humanValidationRequired: true },
    customerValidation: { state: 'customer_validation_requested', affirmativeStates: ['customer_confirmed'], negativeStates: ['rejected'] },
  };
}

module.exports = {
  PROVIDER, ITEM_STATES, VISIBILITY_STATES, REVIEW_BANDS,
  normalizeProfileVersion, reviewBand, normalizeRekognitionResult, buildPresentationItem,
  listProfiles, createProfile, createProfileVersion, updateProfileVersion, publishProfileVersion,
  setPackageProfile, getPackageProfile, resolvePackageImageAnalysis, previewManifest, presentationContract,
  createSession, getSession, upsertAnalysisItem, getAnalysisItem, reviewItem, getPresentationFeed,
  listCustomerSessions, getCustomerPresentationFeed, submitCustomerValidation,
};
