const crypto = require('crypto');
const { getPool } = require('../db/pool');

const PROVIDERS = new Set(['google_cloud_run_jobs']);
const POOL_STATUSES = new Set(['draft', 'active', 'draining', 'maintenance', 'disabled']);
const VERSION_STATUSES = new Set(['draft', 'published', 'retired']);

function clean(value, max = 512) { return String(value == null ? '' : value).trim().slice(0, max); }
function slug(value) {
  const output = clean(value, 128).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!output || output.length < 3) throw statusError('Worker-pool slug must contain at least three letters or numbers');
  return output;
}
function parseJson(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : fallback; }
  catch { return fallback; }
}
function asArray(value, max = 100) { return Array.isArray(value) ? value.slice(0, max).map((item) => clean(item, 128)).filter(Boolean) : []; }
function statusError(message, status = 400, code = 'DIVEDEEP_WORKER_POOL_INVALID') { return Object.assign(new Error(message), { status, code }); }
function iso(value) { return value ? new Date(value).toISOString() : null; }

function normalizeProviderConfig(provider, input = {}) {
  if (provider !== 'google_cloud_run_jobs') throw statusError('Unsupported DiveDeep worker-pool provider');
  const cloudRun = require('./diveDeepCloudRun');
  const normalized = cloudRun.normalizeConfig({
    credentialMode: input.credentialMode || 'application_default',
    projectId: input.projectId || '',
    region: input.region || 'us-east1',
    jobName: input.jobName || 'divedeep-divedeep',
    serviceAccountEmail: input.serviceAccountEmail || '',
    dispatchEnabled: input.dispatchEnabled === true,
    defaultTaskCount: input.taskCount || 1,
    defaultParallelism: input.parallelism || 1,
    defaultTaskTimeoutSeconds: input.taskTimeoutSeconds || 1800,
    defaultMaxRetries: input.maxRetries ?? 0,
  });
  return {
    integrationProvider: 'google_cloud_run',
    projectId: normalized.projectId,
    region: normalized.region,
    jobName: normalized.jobName,
    serviceAccountEmail: normalized.serviceAccountEmail,
    workerVersion: clean(input.workerVersion || '5.29.0', 64),
    workerProtocolVersion: 1,
    dispatchEnabled: normalized.dispatchEnabled,
    taskCount: normalized.defaultTaskCount,
    parallelism: normalized.defaultParallelism,
    taskTimeoutSeconds: normalized.defaultTaskTimeoutSeconds,
    maxRetries: normalized.defaultMaxRetries,
    lifecycle: 'single_execution',
    transport: 'api_callback',
    dataResidency: clean(input.dataResidency || 'us', 64),
  };
}

function rowPool(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    provider: row.provider,
    status: row.status,
    isDefault: Boolean(row.is_default),
    currentVersion: Number(row.current_version) || 0,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowVersion(row) {
  return {
    id: row.id,
    poolId: row.pool_id,
    version: Number(row.version) || 0,
    status: row.status,
    providerConfig: parseJson(row.provider_config_json, {}),
    capabilities: parseJson(row.capabilities_json, {}),
    packageIds: parseJson(row.package_ids_json, []),
    sourceSetIds: parseJson(row.source_set_ids_json, []),
    limits: parseJson(row.limits_json, {}),
    healthPolicy: parseJson(row.health_policy_json, {}),
    createdBy: row.created_by || null,
    publishedBy: row.published_by || null,
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function listPools(filters = {}, pool = null) {
  const p = pool || getPool();
  const params = [];
  const where = [];
  if (filters.status && POOL_STATUSES.has(filters.status)) { where.push('p.status=?'); params.push(filters.status); }
  const [rows] = await p.query(
    `SELECT p.* FROM divedeep_worker_pools p ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.is_default DESC,p.name`, params
  );
  const [usageRows] = await p.query(
    `SELECT worker_pool_id,COUNT(*) active_count FROM divedeep_recon_jobs
     WHERE status IN ('dispatching','running') AND worker_pool_id IS NOT NULL GROUP BY worker_pool_id`
  );
  const usage = new Map(usageRows.map((row) => [row.worker_pool_id, Number(row.active_count) || 0]));
  const output = [];
  for (const row of rows) {
    const [versionRows] = await p.query(
      `SELECT * FROM divedeep_worker_pool_versions WHERE pool_id=? ORDER BY version DESC`, [row.id]
    );
    const versions = versionRows.map(rowVersion);
    const current = versions.find((item) => item.version === Number(row.current_version)) || versions[0] || null;
    const maximum = Math.max(1, Number(current?.limits?.maximumConcurrentExecutions) || 1);
    const active = usage.get(row.id) || 0;
    output.push({
      ...rowPool(row),
      capacity: { maximum, active, available: Math.max(0, maximum - active) },
      versions,
    });
  }
  return output;
}

async function getPoolById(poolId, db = null) {
  const p = db || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_worker_pools WHERE id=? LIMIT 1', [clean(poolId, 64)]);
  if (!rows[0]) throw statusError('Worker pool not found', 404, 'DIVEDEEP_WORKER_POOL_NOT_FOUND');
  const [versions] = await p.query('SELECT * FROM divedeep_worker_pool_versions WHERE pool_id=? ORDER BY version DESC', [rows[0].id]);
  return { ...rowPool(rows[0]), versions: versions.map(rowVersion) };
}

async function createPool(input, actorId, pool = null) {
  const p = pool || getPool();
  const provider = clean(input.provider || 'google_cloud_run_jobs', 64).toLowerCase();
  if (!PROVIDERS.has(provider)) throw statusError('Unsupported worker-pool provider');
  const id = crypto.randomUUID();
  const poolSlug = slug(input.slug || input.name);
  const name = clean(input.name, 160);
  if (!name) throw statusError('Worker-pool name is required');
  const status = POOL_STATUSES.has(input.status) ? input.status : 'draft';
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    if (input.isDefault) await connection.query('UPDATE divedeep_worker_pools SET is_default=0');
    await connection.query(
      `INSERT INTO divedeep_worker_pools
       (id,slug,name,description,provider,status,is_default,current_version,created_by,updated_by)
       VALUES (?,?,?,?,?,?,?,0,?,?)`,
      [id, poolSlug, name, clean(input.description, 2000), provider, status, input.isDefault ? 1 : 0, clean(actorId, 128) || null, clean(actorId, 128) || null]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    if (String(error.code || '').includes('DUP')) throw statusError('Worker-pool slug already exists', 409, 'DIVEDEEP_WORKER_POOL_EXISTS');
    throw error;
  } finally { connection.release(); }
  return getPoolById(id, p);
}

async function createVersion(poolId, input, actorId, pool = null) {
  const p = pool || getPool();
  const parent = await getPoolById(poolId, p);
  const nextVersion = Math.max(0, ...parent.versions.map((item) => item.version)) + 1;
  const id = crypto.randomUUID();
  const providerConfig = normalizeProviderConfig(parent.provider, input.providerConfig || {});
  const capabilities = {
    recon: true,
    imageAnalysis: Boolean(input.capabilities?.imageAnalysis),
    sensitiveSources: Boolean(input.capabilities?.sensitiveSources),
    browserAutomation: input.capabilities?.browserAutomation !== false,
    sourceAttemptEvents: true,
    incrementalResults: true,
    ...(parseJson(input.capabilities, {})),
  };
  const limits = {
    maximumConcurrentExecutions: Math.min(Math.max(Number(input.limits?.maximumConcurrentExecutions) || 1, 1), 100),
    maximumJobSeconds: Math.min(Math.max(Number(input.limits?.maximumJobSeconds) || 1800, 60), 604800),
    maximumTemporaryStorageMb: Math.min(Math.max(Number(input.limits?.maximumTemporaryStorageMb) || 4096, 128), 65536),
  };
  const healthPolicy = {
    staleAfterSeconds: Math.min(Math.max(Number(input.healthPolicy?.staleAfterSeconds) || 180, 30), 3600),
    failureThreshold: Math.min(Math.max(Number(input.healthPolicy?.failureThreshold) || 3, 1), 20),
    ...(parseJson(input.healthPolicy, {})),
  };
  await p.query(
    `INSERT INTO divedeep_worker_pool_versions
     (id,pool_id,version,status,provider_config_json,capabilities_json,package_ids_json,source_set_ids_json,limits_json,health_policy_json,created_by)
     VALUES (?,?,?,'draft',?,?,?,?,?,?,?)`,
    [id, parent.id, nextVersion, JSON.stringify(providerConfig), JSON.stringify(capabilities), JSON.stringify(asArray(input.packageIds, 20)), JSON.stringify(asArray(input.sourceSetIds, 100)), JSON.stringify(limits), JSON.stringify(healthPolicy), clean(actorId, 128) || null]
  );
  return rowVersion((await p.query('SELECT * FROM divedeep_worker_pool_versions WHERE id=? LIMIT 1', [id]))[0][0]);
}

async function updateVersion(versionId, input, actorId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT v.*,p.provider FROM divedeep_worker_pool_versions v INNER JOIN divedeep_worker_pools p ON p.id=v.pool_id WHERE v.id=? LIMIT 1`, [clean(versionId, 64)]
  );
  const current = rows[0];
  if (!current) throw statusError('Worker-pool version not found', 404, 'DIVEDEEP_WORKER_POOL_VERSION_NOT_FOUND');
  if (current.status !== 'draft') throw statusError('Published worker-pool versions are immutable', 409, 'DIVEDEEP_WORKER_POOL_VERSION_IMMUTABLE');
  const providerConfig = normalizeProviderConfig(current.provider, input.providerConfig || parseJson(current.provider_config_json, {}));
  const capabilities = parseJson(input.capabilities, parseJson(current.capabilities_json, {}));
  const packageIds = input.packageIds == null ? parseJson(current.package_ids_json, []) : asArray(input.packageIds, 20);
  const sourceSetIds = input.sourceSetIds == null ? parseJson(current.source_set_ids_json, []) : asArray(input.sourceSetIds, 100);
  const limits = parseJson(input.limits, parseJson(current.limits_json, {}));
  const healthPolicy = parseJson(input.healthPolicy, parseJson(current.health_policy_json, {}));
  await p.query(
    `UPDATE divedeep_worker_pool_versions SET provider_config_json=?,capabilities_json=?,package_ids_json=?,source_set_ids_json=?,limits_json=?,health_policy_json=?,updated_at=NOW(3) WHERE id=?`,
    [JSON.stringify(providerConfig), JSON.stringify(capabilities), JSON.stringify(packageIds), JSON.stringify(sourceSetIds), JSON.stringify(limits), JSON.stringify(healthPolicy), current.id]
  );
  await p.query('UPDATE divedeep_worker_pools SET updated_by=?,updated_at=NOW(3) WHERE id=?', [clean(actorId, 128) || null, current.pool_id]);
  return rowVersion((await p.query('SELECT * FROM divedeep_worker_pool_versions WHERE id=? LIMIT 1', [current.id]))[0][0]);
}

async function publishVersion(versionId, actorId, pool = null) {
  const p = pool || getPool();
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT v.*,p.status pool_status FROM divedeep_worker_pool_versions v INNER JOIN divedeep_worker_pools p ON p.id=v.pool_id WHERE v.id=? FOR UPDATE`, [clean(versionId, 64)]
    );
    const version = rows[0];
    if (!version) throw statusError('Worker-pool version not found', 404, 'DIVEDEEP_WORKER_POOL_VERSION_NOT_FOUND');
    if (version.status !== 'draft') throw statusError('Only draft worker-pool versions can be published', 409, 'DIVEDEEP_WORKER_POOL_VERSION_STATE');
    const providerConfig = parseJson(version.provider_config_json, {});
    if (!providerConfig.projectId || !providerConfig.region || !providerConfig.jobName) {
      throw statusError('Cloud Run project, region, and job name are required before publishing a worker-pool version');
    }
    await connection.query(`UPDATE divedeep_worker_pool_versions SET status='retired' WHERE pool_id=? AND status='published'`, [version.pool_id]);
    await connection.query(
      `UPDATE divedeep_worker_pool_versions SET status='published',published_by=?,published_at=NOW(3),updated_at=NOW(3) WHERE id=?`,
      [clean(actorId, 128) || null, version.id]
    );
    await connection.query(
      `UPDATE divedeep_worker_pools SET status='active',current_version=?,updated_by=?,updated_at=NOW(3) WHERE id=?`,
      [version.version, clean(actorId, 128) || null, version.pool_id]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  const [rows] = await p.query('SELECT * FROM divedeep_worker_pool_versions WHERE id=? LIMIT 1', [versionId]);
  return rowVersion(rows[0]);
}

async function selectPoolForManifest(manifest, pool = null) {
  const p = pool || getPool();
  const packageId = clean(manifest?.package?.packageId || manifest?.package?.id, 64);
  const sourceSetId = clean(manifest?.sourceSet?.id, 64);
  const [rows] = await p.query(
    `SELECT p.*,v.id version_id,v.version,v.provider_config_json,v.capabilities_json,v.package_ids_json,v.source_set_ids_json,v.limits_json,v.health_policy_json,
            COALESCE(u.active_count,0) active_count
     FROM divedeep_worker_pools p
     INNER JOIN divedeep_worker_pool_versions v ON v.pool_id=p.id AND v.status='published' AND v.version=p.current_version
     LEFT JOIN (
       SELECT worker_pool_id,COUNT(*) active_count FROM divedeep_recon_jobs
       WHERE status IN ('dispatching','running') AND worker_pool_id IS NOT NULL GROUP BY worker_pool_id
     ) u ON u.worker_pool_id=p.id
     WHERE p.status='active'
     ORDER BY p.is_default DESC,p.name`
  );
  const candidates = rows.map((row) => {
    const version = rowVersion({ ...row, id: row.version_id, pool_id: row.id });
    const maximum = Math.max(1, Number(version.limits?.maximumConcurrentExecutions) || 1);
    const active = Number(row.active_count) || 0;
    return {
      pool: rowPool(row),
      version: { ...version, capacity: { maximum, active, available: Math.max(0, maximum - active) } },
    };
  }).filter((item) => {
    const packages = item.version.packageIds || [];
    const sourceSets = item.version.sourceSetIds || [];
    return (!packages.length || packages.includes(packageId)) && (!sourceSets.length || sourceSets.includes(sourceSetId));
  });
  return candidates.find((item) => item.version.providerConfig?.dispatchEnabled && item.version.capacity.available > 0)
    || candidates.find((item) => item.version.providerConfig?.dispatchEnabled)
    || candidates[0]
    || null;
}

async function getPoolSummary(pool = null) {
  const p = pool || getPool();
  const [[poolRows], [jobRows]] = await Promise.all([
    p.query(`SELECT COUNT(*) total,SUM(status='active') active,SUM(status='draining') draining,SUM(status='maintenance') maintenance FROM divedeep_worker_pools`),
    p.query(`SELECT worker_pool_id,status,COUNT(*) count FROM divedeep_recon_jobs WHERE status IN ('ready','awaiting_capacity','dispatching','running') GROUP BY worker_pool_id,status`),
  ]);
  const queueByPool = {};
  for (const row of jobRows) {
    const key = row.worker_pool_id || 'unassigned';
    queueByPool[key] ||= {};
    queueByPool[key][row.status] = Number(row.count) || 0;
  }
  return {
    total: Number(poolRows[0]?.total) || 0,
    active: Number(poolRows[0]?.active) || 0,
    draining: Number(poolRows[0]?.draining) || 0,
    maintenance: Number(poolRows[0]?.maintenance) || 0,
    queueByPool,
  };
}

module.exports = {
  PROVIDERS,
  POOL_STATUSES,
  VERSION_STATUSES,
  normalizeProviderConfig,
  listPools,
  getPoolById,
  createPool,
  createVersion,
  updateVersion,
  publishVersion,
  selectPoolForManifest,
  getPoolSummary,
};
