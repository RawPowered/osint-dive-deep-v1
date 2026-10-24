const crypto = require('crypto');
const { getPool } = require('../db/pool');
const imageAnalysis = require('./diveDeepImageAnalysis');
const { validateAgainstSchema } = require('./jsonSchemaSubset');

const RESOURCE_STATUSES = new Set(['draft', 'active', 'paused', 'retired']);
const VERSION_STATUSES = new Set(['draft', 'published', 'retired']);
const SET_STATUSES = new Set(['draft', 'active', 'retired']);
const SENSITIVITY = new Set(['standard', 'sensitive', 'restricted']);
const SELECTION_MODES = new Set(['explicit', 'pools', 'rules', 'hybrid']);

function uuid() { return crypto.randomUUID(); }
function clean(value, max = 255) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : '';
}
function bool(value) { return value === true || value === 1 || String(value).toLowerCase() === 'true'; }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function statusError(message, status = 400, code = 'PLATFORM_CATALOG_INVALID') {
  return Object.assign(new Error(message), { status, code });
}
function slugify(value, label = 'Slug') {
  const slug = clean(value, 128).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug.length < 2) throw statusError(`${label} must contain letters or numbers`);
  return slug;
}
function namespaceValue(value, fallback = 'divedeep.source') {
  const namespace = clean(value || fallback, 64).toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(namespace)) throw statusError('Namespace is invalid');
  return namespace;
}
function ownerScope(tenantId) {
  const tenant = clean(tenantId, 36);
  return tenant ? `tenant:${tenant}` : 'global';
}
function parseJson(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function objectInput(value, label, fallback = {}) {
  const parsed = value == null || value === '' ? fallback : (typeof value === 'string' ? (() => {
    try { return JSON.parse(value); } catch { throw statusError(`${label} must be valid JSON`); }
  })() : value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw statusError(`${label} must be a JSON object`);
  return parsed;
}
function arrayInput(value, label, max = 2000) {
  const parsed = value == null || value === '' ? [] : (typeof value === 'string' ? (() => {
    try { return JSON.parse(value); } catch { throw statusError(`${label} must be valid JSON`); }
  })() : value);
  if (!Array.isArray(parsed)) throw statusError(`${label} must be an array`);
  if (parsed.length > max) throw statusError(`${label} exceeds the maximum of ${max} items`);
  return parsed;
}
function normalizeDomain(value) {
  let domain = clean(value, 255).toLowerCase();
  if (!domain) return null;
  if (domain.includes('://')) {
    try { domain = new URL(domain).hostname.toLowerCase(); } catch { throw statusError('Primary domain is invalid'); }
  }
  domain = domain.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes('.')) throw statusError('Primary domain is invalid');
  return domain;
}
function schemaRow(row) {
  return {
    id: row.id,
    namespace: row.namespace,
    schemaKey: row.schema_key,
    version: Number(row.version),
    resourceType: row.resource_type,
    name: row.name,
    description: row.description || '',
    jsonSchema: parseJson(row.json_schema_json, {}),
    status: row.status,
    isDefault: Boolean(row.is_default),
    createdBy: row.created_by || null,
    publishedBy: row.published_by || null,
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function resourceRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id || null,
    ownerScope: row.owner_scope,
    namespace: row.namespace,
    resourceType: row.resource_type,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    primaryDomain: row.primary_domain || '',
    serviceType: row.service_type || '',
    category: row.category || '',
    topic: row.topic || '',
    sensitivityClass: row.sensitivity_class,
    jurisdictionCountry: row.jurisdiction_country || '',
    jurisdictionRegion: row.jurisdiction_region || '',
    adapterKey: row.adapter_key || '',
    metadataSchemaId: row.metadata_schema_id || null,
    metadataSchemaName: row.metadata_schema_name || null,
    metadataSchemaVersion: row.metadata_schema_version == null ? null : Number(row.metadata_schema_version),
    metadata: parseJson(row.metadata_json, {}),
    capabilities: parseJson(row.capabilities_json, {}),
    declarations: parseJson(row.declarations_json, {}),
    limits: parseJson(row.limits_json, {}),
    removalMethods: parseJson(row.removal_methods_json, {}),
    monitoringSupport: parseJson(row.monitoring_support_json, {}),
    status: row.status,
    revision: Number(row.revision),
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function poolVersionRow(row) {
  return {
    id: row.id,
    poolId: row.pool_id,
    version: Number(row.version),
    status: row.status,
    label: row.label,
    description: row.description || '',
    selectorRules: parseJson(row.selector_rules_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    memberCount: Number(row.member_count) || 0,
    createdBy: row.created_by || null,
    publishedBy: row.published_by || null,
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    members: [],
  };
}
function poolRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id || null,
    ownerScope: row.owner_scope,
    namespace: row.namespace,
    poolType: row.pool_type,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    metadataSchemaId: row.metadata_schema_id || null,
    status: row.status,
    currentVersion: Number(row.current_version) || 0,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    versions: [],
  };
}
function sourceSetVersionRow(row) {
  return {
    id: row.id,
    sourceSetId: row.source_set_id,
    version: Number(row.version),
    status: row.status,
    selectionMode: row.selection_mode,
    metadata: parseJson(row.metadata_json, {}),
    resourceCount: Number(row.resource_count) || 0,
    poolCount: Number(row.pool_count) || 0,
    createdBy: row.created_by || null,
    publishedBy: row.published_by || null,
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    pools: [],
    resources: [],
  };
}
function sourceSetRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    status: row.status,
    currentVersion: Number(row.current_version) || 0,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    versions: [],
  };
}
function packageVersionRow(row) {
  return {
    id: row.id,
    packageId: row.package_id,
    packageName: row.package_name || row.package_id,
    version: Number(row.version),
    current: Number(row.package_current_version) === Number(row.version),
    status: row.status,
    sourceSetVersionId: row.source_set_version_id,
    sourceSetName: row.source_set_name || null,
    sourceSetVersion: row.source_set_version == null ? null : Number(row.source_set_version),
    requirements: parseJson(row.requirements_json, {}),
    executionPolicy: parseJson(row.execution_policy_json, {}),
    reviewPolicy: parseJson(row.review_policy_json, {}),
    retentionPolicy: parseJson(row.retention_policy_json, {}),
    imageAnalysisProfileVersionId: row.image_analysis_profile_version_id || null,
    imageAnalysisProfileName: row.image_analysis_profile_name || null,
    imageAnalysisProfileVersion: row.image_analysis_profile_version == null ? null : Number(row.image_analysis_profile_version),
    imageAnalysisRequired: Boolean(row.image_analysis_required),
    createdBy: row.created_by || null,
    publishedBy: row.published_by || null,
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function listMetadataSchemas(filters = {}, pool = null) {
  const p = pool || getPool();
  const where = [];
  const params = [];
  if (filters.status) { where.push('status=?'); params.push(clean(filters.status, 32)); }
  if (filters.resourceType) { where.push('resource_type=?'); params.push(clean(filters.resourceType, 64)); }
  if (filters.namespace) { where.push('namespace=?'); params.push(namespaceValue(filters.namespace)); }
  const [rows] = await p.query(`SELECT * FROM platform_metadata_schemas ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY namespace,schema_key,version DESC`, params);
  return rows.map(schemaRow);
}

function validateSchemaDefinition(definition) {
  const schema = objectInput(definition, 'JSON schema');
  if (schema.type !== 'object') throw statusError('Catalog metadata schemas must declare type object');
  if (schema.properties != null && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) throw statusError('JSON schema properties must be an object');
  if (schema.required != null && !Array.isArray(schema.required)) throw statusError('JSON schema required must be an array');
  return schema;
}

async function createMetadataSchema(input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const namespace = namespaceValue(input.namespace || 'divedeep');
  const schemaKey = slugify(input.schemaKey || input.name, 'Schema key');
  const resourceType = clean(input.resourceType, 64).toLowerCase();
  const name = clean(input.name, 160);
  if (!resourceType || !name) throw statusError('Resource type and schema name are required');
  const schema = validateSchemaDefinition(input.jsonSchema || input.schema || {});
  let version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) {
    const [rows] = await p.query('SELECT COALESCE(MAX(version),0)+1 AS next_version FROM platform_metadata_schemas WHERE namespace=? AND schema_key=?', [namespace, schemaKey]);
    version = Number(rows[0]?.next_version) || 1;
  }
  const status = VERSION_STATUSES.has(input.status) ? input.status : 'draft';
  const id = uuid();
  try {
    await p.query(
      `INSERT INTO platform_metadata_schemas
       (id,namespace,schema_key,version,resource_type,name,description,json_schema_json,status,is_default,created_by,published_by,published_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, namespace, schemaKey, version, resourceType, name, clean(input.description, 1000), JSON.stringify(schema), status,
        bool(input.isDefault) ? 1 : 0, clean(actorId, 128) || null,
        status === 'published' ? clean(actorId, 128) || null : null,
        status === 'published' ? new Date() : null]
    );
  } catch (error) {
    if (String(error.code || '').includes('DUP')) throw statusError('That metadata schema version already exists', 409, 'PLATFORM_CATALOG_SCHEMA_EXISTS');
    throw error;
  }
  if (bool(input.isDefault)) {
    await p.query('UPDATE platform_metadata_schemas SET is_default=0 WHERE namespace=? AND resource_type=? AND id<>?', [namespace, resourceType, id]);
  }
  const [rows] = await p.query('SELECT * FROM platform_metadata_schemas WHERE id=?', [id]);
  return schemaRow(rows[0]);
}

async function updateMetadataSchema(schemaId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM platform_metadata_schemas WHERE id=? LIMIT 1', [clean(schemaId, 36)]);
  const current = rows[0];
  if (!current) throw statusError('Metadata schema not found', 404, 'PLATFORM_CATALOG_SCHEMA_NOT_FOUND');
  const nextStatus = VERSION_STATUSES.has(input.status) ? input.status : current.status;
  if (current.status === 'published' && nextStatus !== 'retired') {
    throw statusError('Published schemas are immutable. Create a new version instead', 409, 'PLATFORM_CATALOG_SCHEMA_IMMUTABLE');
  }
  let definition = parseJson(current.json_schema_json, {});
  let name = current.name;
  let description = current.description;
  if (current.status === 'draft') {
    if (input.jsonSchema != null) definition = validateSchemaDefinition(input.jsonSchema);
    if (input.name != null) name = clean(input.name, 160);
    if (input.description != null) description = clean(input.description, 1000);
  }
  const publish = nextStatus === 'published' && current.status !== 'published';
  await p.query(
    `UPDATE platform_metadata_schemas SET name=?,description=?,json_schema_json=?,status=?,is_default=?,published_by=COALESCE(?,published_by),published_at=COALESCE(?,published_at),updated_at=NOW(3) WHERE id=?`,
    [name, description, JSON.stringify(definition), nextStatus, input.isDefault == null ? current.is_default : (bool(input.isDefault) ? 1 : 0),
      publish ? clean(actorId, 128) || null : null, publish ? new Date() : null, current.id]
  );
  if (bool(input.isDefault)) await p.query('UPDATE platform_metadata_schemas SET is_default=0 WHERE namespace=? AND resource_type=? AND id<>?', [current.namespace, current.resource_type, current.id]);
  const [updated] = await p.query('SELECT * FROM platform_metadata_schemas WHERE id=?', [current.id]);
  return schemaRow(updated[0]);
}

async function getPublishedSchema(schemaId, pool) {
  if (!schemaId) return null;
  const [rows] = await pool.query('SELECT * FROM platform_metadata_schemas WHERE id=? LIMIT 1', [schemaId]);
  if (!rows[0]) throw statusError('Metadata schema not found', 409, 'PLATFORM_CATALOG_SCHEMA_NOT_FOUND');
  if (rows[0].status !== 'published') throw statusError('Resources may only use published metadata schemas', 409, 'PLATFORM_CATALOG_SCHEMA_NOT_PUBLISHED');
  return rows[0];
}

async function recordResourceRevision(resource, note, actorId, pool) {
  await pool.query(
    `INSERT INTO platform_resource_revisions (id,resource_id,revision,snapshot_json,change_note,created_by)
     VALUES (?,?,?,?,?,?)`,
    [uuid(), resource.id, resource.revision, JSON.stringify(resource), clean(note, 1000) || null, clean(actorId, 128) || null]
  );
}

async function listResources(filters = {}, pool = null) {
  const p = pool || getPool();
  const where = [];
  const params = [];
  if (filters.namespace) { where.push('r.namespace=?'); params.push(namespaceValue(filters.namespace)); }
  if (filters.resourceType) { where.push('r.resource_type=?'); params.push(clean(filters.resourceType, 64)); }
  if (filters.status) { where.push('r.status=?'); params.push(clean(filters.status, 32)); }
  if (filters.category) { where.push('r.category=?'); params.push(clean(filters.category, 64)); }
  if (filters.topic) { where.push('r.topic=?'); params.push(clean(filters.topic, 128)); }
  if (filters.sensitivityClass) { where.push('r.sensitivity_class=?'); params.push(clean(filters.sensitivityClass, 32)); }
  if (filters.q) {
    where.push('(r.name LIKE ? OR r.slug LIKE ? OR r.primary_domain LIKE ? OR r.category LIKE ? OR r.topic LIKE ?)');
    const query = `%${clean(filters.q, 120)}%`; params.push(query, query, query, query, query);
  }
  const limit = Math.min(Math.max(Number(filters.limit) || 500, 1), 2000);
  params.push(limit);
  const [rows] = await p.query(
    `SELECT r.*,s.name AS metadata_schema_name,s.version AS metadata_schema_version
     FROM platform_resources r LEFT JOIN platform_metadata_schemas s ON s.id=r.metadata_schema_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY r.namespace,r.category,r.topic,r.name LIMIT ?`, params
  );
  return rows.map(resourceRow);
}

async function getResource(resourceId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT r.*,s.name AS metadata_schema_name,s.version AS metadata_schema_version
     FROM platform_resources r LEFT JOIN platform_metadata_schemas s ON s.id=r.metadata_schema_id WHERE r.id=? LIMIT 1`,
    [clean(resourceId, 36)]
  );
  if (!rows[0]) throw statusError('Catalog resource not found', 404, 'PLATFORM_CATALOG_RESOURCE_NOT_FOUND');
  return resourceRow(rows[0]);
}

async function createResource(input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const tenantId = clean(input.tenantId, 36) || null;
  const namespace = namespaceValue(input.namespace || 'divedeep.source');
  const resourceType = clean(input.resourceType || 'website', 64).toLowerCase();
  const name = clean(input.name, 255);
  if (!name) throw statusError('Resource name is required');
  const slug = slugify(input.slug || name, 'Resource slug');
  const status = RESOURCE_STATUSES.has(input.status) ? input.status : 'draft';
  const sensitivity = SENSITIVITY.has(input.sensitivityClass) ? input.sensitivityClass : 'standard';
  const metadata = objectInput(input.metadata, 'Metadata');
  const schema = await getPublishedSchema(clean(input.metadataSchemaId, 36) || null, p);
  if (schema) validateAgainstSchema(parseJson(schema.json_schema_json, {}), metadata);
  const payloads = {
    metadata,
    capabilities: objectInput(input.capabilities, 'Capabilities'),
    declarations: objectInput(input.declarations, 'Declarations'),
    limits: objectInput(input.limits, 'Limits'),
    removalMethods: objectInput(input.removalMethods, 'Removal methods'),
    monitoringSupport: objectInput(input.monitoringSupport, 'Monitoring support'),
  };
  const id = uuid();
  try {
    await p.query(
      `INSERT INTO platform_resources
       (id,tenant_id,owner_scope,namespace,resource_type,slug,name,description,primary_domain,service_type,category,topic,sensitivity_class,jurisdiction_country,jurisdiction_region,adapter_key,metadata_schema_id,metadata_json,capabilities_json,declarations_json,limits_json,removal_methods_json,monitoring_support_json,status,revision,created_by,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [id, tenantId, ownerScope(tenantId), namespace, resourceType, slug, name, clean(input.description, 2000), normalizeDomain(input.primaryDomain),
        clean(input.serviceType, 64) || null, clean(input.category, 64) || null, clean(input.topic, 128) || null, sensitivity,
        clean(input.jurisdictionCountry, 64) || null, clean(input.jurisdictionRegion, 128) || null, clean(input.adapterKey, 128) || null,
        schema?.id || null, JSON.stringify(payloads.metadata), JSON.stringify(payloads.capabilities), JSON.stringify(payloads.declarations),
        JSON.stringify(payloads.limits), JSON.stringify(payloads.removalMethods), JSON.stringify(payloads.monitoringSupport), status,
        clean(actorId, 128) || null, clean(actorId, 128) || null]
    );
  } catch (error) {
    if (String(error.code || '').includes('DUP')) throw statusError('A resource with that namespace and slug already exists', 409, 'PLATFORM_CATALOG_RESOURCE_EXISTS');
    throw error;
  }
  const resource = await getResource(id, p);
  await recordResourceRevision(resource, input.changeNote || 'Resource created', actorId, p);
  return resource;
}

async function updateResource(resourceId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const current = await getResource(resourceId, p);
  const status = input.status == null ? current.status : (RESOURCE_STATUSES.has(input.status) ? input.status : (() => { throw statusError('Invalid resource status'); })());
  const sensitivity = input.sensitivityClass == null ? current.sensitivityClass : (SENSITIVITY.has(input.sensitivityClass) ? input.sensitivityClass : (() => { throw statusError('Invalid sensitivity class'); })());
  const schemaId = input.metadataSchemaId === undefined ? current.metadataSchemaId : (clean(input.metadataSchemaId, 36) || null);
  const schema = await getPublishedSchema(schemaId, p);
  const metadata = input.metadata === undefined ? current.metadata : objectInput(input.metadata, 'Metadata');
  if (schema) validateAgainstSchema(parseJson(schema.json_schema_json, {}), metadata);
  const next = {
    ...current,
    namespace: input.namespace == null ? current.namespace : namespaceValue(input.namespace),
    resourceType: input.resourceType == null ? current.resourceType : clean(input.resourceType, 64).toLowerCase(),
    slug: input.slug == null ? current.slug : slugify(input.slug, 'Resource slug'),
    name: input.name == null ? current.name : clean(input.name, 255),
    description: input.description == null ? current.description : clean(input.description, 2000),
    primaryDomain: input.primaryDomain === undefined ? current.primaryDomain : (normalizeDomain(input.primaryDomain) || ''),
    serviceType: input.serviceType === undefined ? current.serviceType : clean(input.serviceType, 64),
    category: input.category === undefined ? current.category : clean(input.category, 64),
    topic: input.topic === undefined ? current.topic : clean(input.topic, 128),
    sensitivityClass: sensitivity,
    jurisdictionCountry: input.jurisdictionCountry === undefined ? current.jurisdictionCountry : clean(input.jurisdictionCountry, 64),
    jurisdictionRegion: input.jurisdictionRegion === undefined ? current.jurisdictionRegion : clean(input.jurisdictionRegion, 128),
    adapterKey: input.adapterKey === undefined ? current.adapterKey : clean(input.adapterKey, 128),
    metadataSchemaId: schemaId,
    metadata,
    capabilities: input.capabilities === undefined ? current.capabilities : objectInput(input.capabilities, 'Capabilities'),
    declarations: input.declarations === undefined ? current.declarations : objectInput(input.declarations, 'Declarations'),
    limits: input.limits === undefined ? current.limits : objectInput(input.limits, 'Limits'),
    removalMethods: input.removalMethods === undefined ? current.removalMethods : objectInput(input.removalMethods, 'Removal methods'),
    monitoringSupport: input.monitoringSupport === undefined ? current.monitoringSupport : objectInput(input.monitoringSupport, 'Monitoring support'),
    status,
    revision: current.revision + 1,
  };
  if (!next.name) throw statusError('Resource name is required');
  try {
    await p.query(
      `UPDATE platform_resources SET namespace=?,resource_type=?,slug=?,name=?,description=?,primary_domain=?,service_type=?,category=?,topic=?,sensitivity_class=?,jurisdiction_country=?,jurisdiction_region=?,adapter_key=?,metadata_schema_id=?,metadata_json=?,capabilities_json=?,declarations_json=?,limits_json=?,removal_methods_json=?,monitoring_support_json=?,status=?,revision=?,updated_by=?,updated_at=NOW(3) WHERE id=?`,
      [next.namespace, next.resourceType, next.slug, next.name, next.description, next.primaryDomain || null, next.serviceType || null,
        next.category || null, next.topic || null, next.sensitivityClass, next.jurisdictionCountry || null, next.jurisdictionRegion || null,
        next.adapterKey || null, next.metadataSchemaId, JSON.stringify(next.metadata), JSON.stringify(next.capabilities), JSON.stringify(next.declarations),
        JSON.stringify(next.limits), JSON.stringify(next.removalMethods), JSON.stringify(next.monitoringSupport), next.status, next.revision,
        clean(actorId, 128) || null, current.id]
    );
  } catch (error) {
    if (String(error.code || '').includes('DUP')) throw statusError('A resource with that namespace and slug already exists', 409, 'PLATFORM_CATALOG_RESOURCE_EXISTS');
    throw error;
  }
  const resource = await getResource(current.id, p);
  await recordResourceRevision(resource, input.changeNote || 'Resource updated', actorId, p);
  return resource;
}

async function listResourceRevisions(resourceId, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM platform_resource_revisions WHERE resource_id=? ORDER BY revision DESC LIMIT 100', [clean(resourceId, 36)]);
  return rows.map((row) => ({ id: row.id, resourceId: row.resource_id, revision: Number(row.revision), snapshot: parseJson(row.snapshot_json, {}), changeNote: row.change_note || '', createdBy: row.created_by || null, createdAt: iso(row.created_at) }));
}

async function listPools(filters = {}, pool = null) {
  const p = pool || getPool();
  const where = [];
  const params = [];
  if (filters.namespace) { where.push('namespace=?'); params.push(namespaceValue(filters.namespace)); }
  if (filters.poolType) { where.push('pool_type=?'); params.push(clean(filters.poolType, 64)); }
  if (filters.status) { where.push('status=?'); params.push(clean(filters.status, 32)); }
  const [rows] = await p.query(`SELECT * FROM platform_pools ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY namespace,pool_type,name`, params);
  const pools = rows.map(poolRow);
  if (!pools.length) return pools;
  const ids = pools.map((item) => item.id);
  const placeholders = ids.map(() => '?').join(',');
  const [versionRows] = await p.query(`SELECT * FROM platform_pool_versions WHERE pool_id IN (${placeholders}) ORDER BY pool_id,version DESC`, ids);
  const versions = new Map(versionRows.map((row) => [row.id, poolVersionRow(row)]));
  const versionIds = [...versions.keys()];
  if (versionIds.length) {
    const memberPlaceholders = versionIds.map(() => '?').join(',');
    const [memberRows] = await p.query(
      `SELECT m.*,r.name AS resource_name,r.slug AS resource_slug,r.primary_domain,r.resource_type,r.status AS resource_status
       FROM platform_pool_memberships m INNER JOIN platform_resources r ON r.id=m.resource_id
       WHERE m.pool_version_id IN (${memberPlaceholders}) ORDER BY m.pool_version_id,m.priority DESC,r.name`, versionIds
    );
    for (const row of memberRows) {
      const version = versions.get(row.pool_version_id);
      if (version) version.members.push({ id: row.id, resourceId: row.resource_id, resourceName: row.resource_name, resourceSlug: row.resource_slug, primaryDomain: row.primary_domain || '', resourceType: row.resource_type, resourceStatus: row.resource_status, metadata: parseJson(row.membership_metadata_json, {}), priority: Number(row.priority) || 0, enabled: Boolean(row.enabled), effectiveAt: iso(row.effective_at), expiresAt: iso(row.expires_at) });
    }
  }
  const byPool = new Map(pools.map((item) => [item.id, item]));
  for (const version of versions.values()) byPool.get(version.poolId)?.versions.push(version);
  return pools;
}

async function createPool(input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const tenantId = clean(input.tenantId, 36) || null;
  const namespace = namespaceValue(input.namespace || 'divedeep.source');
  const poolType = clean(input.poolType || 'category', 64).toLowerCase();
  const name = clean(input.name, 255);
  if (!name) throw statusError('Pool name is required');
  const id = uuid();
  const versionId = uuid();
  const status = RESOURCE_STATUSES.has(input.status) ? input.status : 'draft';
  const metadataSchemaId = clean(input.metadataSchemaId, 36) || null;
  const metadata = objectInput(input.metadata, 'Pool metadata');
  const metadataSchema = await getPublishedSchema(metadataSchemaId, p);
  if (metadataSchema) validateAgainstSchema(parseJson(metadataSchema.json_schema_json, {}), metadata);
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO platform_pools (id,tenant_id,owner_scope,namespace,pool_type,slug,name,description,metadata_schema_id,status,current_version,created_by,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      [id, tenantId, ownerScope(tenantId), namespace, poolType, slugify(input.slug || name, 'Pool slug'), name, clean(input.description, 2000), metadataSchemaId, status, clean(actorId, 128) || null, clean(actorId, 128) || null]
    );
    await conn.query(
      `INSERT INTO platform_pool_versions (id,pool_id,version,status,label,description,selector_rules_json,metadata_json,created_by)
       VALUES (?,?,1,'draft',?,?,?,?,?)`,
      [versionId, id, clean(input.versionLabel || `${name} v1`, 160), clean(input.description, 2000), JSON.stringify(objectInput(input.selectorRules, 'Selector rules')), JSON.stringify(metadata), clean(actorId, 128) || null]
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    if (String(error.code || '').includes('DUP')) throw statusError('A pool with that namespace and slug already exists', 409, 'PLATFORM_CATALOG_POOL_EXISTS');
    throw error;
  } finally { conn.release(); }
  if (input.resourceIds) await replacePoolMembers(versionId, input.resourceIds, actorId, p);
  if (bool(input.publish)) await publishPoolVersion(versionId, actorId, p);
  return (await listPools({ namespace }, p)).find((item) => item.id === id);
}

async function getPoolVersion(versionId, pool) {
  const [rows] = await pool.query('SELECT v.*,p.name AS pool_name,p.namespace,p.status AS pool_status,p.metadata_schema_id FROM platform_pool_versions v INNER JOIN platform_pools p ON p.id=v.pool_id WHERE v.id=? LIMIT 1', [clean(versionId, 36)]);
  if (!rows[0]) throw statusError('Pool version not found', 404, 'PLATFORM_CATALOG_POOL_VERSION_NOT_FOUND');
  return rows[0];
}

async function createPoolVersion(poolId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const [poolRows] = await p.query('SELECT * FROM platform_pools WHERE id=? LIMIT 1', [clean(poolId, 36)]);
  if (!poolRows[0]) throw statusError('Pool not found', 404, 'PLATFORM_CATALOG_POOL_NOT_FOUND');
  let currentVersion = null;
  if (Number(poolRows[0].current_version) > 0) {
    const [currentRows] = await p.query('SELECT * FROM platform_pool_versions WHERE pool_id=? AND version=? LIMIT 1', [poolId, poolRows[0].current_version]);
    currentVersion = currentRows[0] || null;
  }
  const [nextRows] = await p.query('SELECT COALESCE(MAX(version),0)+1 AS next_version FROM platform_pool_versions WHERE pool_id=?', [poolId]);
  const version = Number(nextRows[0]?.next_version) || 1;
  const id = uuid();
  const selectorRules = input.selectorRules === undefined
    ? parseJson(currentVersion?.selector_rules_json, {})
    : objectInput(input.selectorRules, 'Selector rules');
  const metadata = input.metadata === undefined
    ? parseJson(currentVersion?.metadata_json, {})
    : objectInput(input.metadata, 'Pool metadata');
  const metadataSchema = await getPublishedSchema(poolRows[0].metadata_schema_id, p);
  if (metadataSchema) validateAgainstSchema(parseJson(metadataSchema.json_schema_json, {}), metadata);
  await p.query(
    `INSERT INTO platform_pool_versions (id,pool_id,version,status,label,description,selector_rules_json,metadata_json,created_by)
     VALUES (?,?,?,'draft',?,?,?,?,?)`,
    [id, poolId, version, clean(input.label || `${poolRows[0].name} v${version}`, 160), clean(input.description ?? currentVersion?.description ?? poolRows[0].description, 2000), JSON.stringify(selectorRules), JSON.stringify(metadata), clean(actorId, 128) || null]
  );
  if (input.resourceIds) await replacePoolMembers(id, input.resourceIds, actorId, p);
  else if (input.cloneCurrent !== false && currentVersion) {
    const [members] = await p.query('SELECT resource_id,membership_metadata_json,priority,enabled,effective_at,expires_at FROM platform_pool_memberships WHERE pool_version_id=?', [currentVersion.id]);
    for (const member of members) await p.query(
      `INSERT INTO platform_pool_memberships (id,pool_version_id,resource_id,membership_metadata_json,priority,enabled,effective_at,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [uuid(), id, member.resource_id, member.membership_metadata_json, member.priority, member.enabled, member.effective_at, member.expires_at, clean(actorId, 128) || null]
    );
    await p.query('UPDATE platform_pool_versions SET member_count=? WHERE id=?', [members.length, id]);
  }
  if (bool(input.publish)) await publishPoolVersion(id, actorId, p);
  const pools = await listPools({ namespace: poolRows[0].namespace }, p);
  return pools.find((item) => item.id === poolId)?.versions.find((item) => item.id === id);
}

async function updatePoolVersion(versionId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const version = await getPoolVersion(versionId, p);
  if (version.status !== 'draft') throw statusError('Published pool versions are immutable. Create a new version', 409, 'PLATFORM_CATALOG_POOL_VERSION_IMMUTABLE');
  const selectorRules = input.selectorRules === undefined ? parseJson(version.selector_rules_json, {}) : objectInput(input.selectorRules, 'Selector rules');
  const metadata = input.metadata === undefined ? parseJson(version.metadata_json, {}) : objectInput(input.metadata, 'Pool metadata');
  const metadataSchema = await getPublishedSchema(version.metadata_schema_id, p);
  if (metadataSchema) validateAgainstSchema(parseJson(metadataSchema.json_schema_json, {}), metadata);
  await p.query(
    `UPDATE platform_pool_versions SET label=?,description=?,selector_rules_json=?,metadata_json=?,updated_at=NOW(3) WHERE id=?`,
    [clean(input.label ?? version.label, 160), clean(input.description ?? version.description, 2000), JSON.stringify(selectorRules), JSON.stringify(metadata), version.id]
  );
  if (input.resourceIds !== undefined) await replacePoolMembers(version.id, input.resourceIds, actorId, p);
  const pools = await listPools({ namespace: version.namespace }, p);
  return pools.find((item) => item.id === version.pool_id)?.versions.find((item) => item.id === version.id);
}

async function replacePoolMembers(versionId, membersInput, actorId = null, pool = null) {
  const p = pool || getPool();
  const version = await getPoolVersion(versionId, p);
  if (version.status !== 'draft') throw statusError('Published pool versions are immutable. Create a new version', 409, 'PLATFORM_CATALOG_POOL_VERSION_IMMUTABLE');
  const input = arrayInput(membersInput, 'Pool members', 5000);
  const normalized = input.map((item, index) => {
    const object = typeof item === 'string' ? { resourceId: item } : item;
    const resourceId = clean(object?.resourceId || object?.id, 36);
    if (!resourceId) throw statusError(`Pool member ${index + 1} is missing a resource ID`);
    return { resourceId, metadata: objectInput(object.metadata, 'Membership metadata'), priority: Math.max(-32768, Math.min(32767, Number(object.priority) || 0)), enabled: object.enabled === undefined ? true : bool(object.enabled), effectiveAt: object.effectiveAt ? new Date(object.effectiveAt) : null, expiresAt: object.expiresAt ? new Date(object.expiresAt) : null };
  });
  if (new Set(normalized.map((item) => item.resourceId)).size !== normalized.length) throw statusError('Pool members must be unique');
  if (normalized.length) {
    const ids = normalized.map((item) => item.resourceId);
    const [resources] = await p.query(`SELECT id,status FROM platform_resources WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    if (resources.length !== ids.length) throw statusError('One or more pool resources do not exist', 409, 'PLATFORM_CATALOG_POOL_RESOURCE_MISSING');
    if (resources.some((item) => item.status === 'retired')) throw statusError('Retired resources cannot be added to a new pool version', 409, 'PLATFORM_CATALOG_POOL_RESOURCE_RETIRED');
  }
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM platform_pool_memberships WHERE pool_version_id=?', [version.id]);
    for (const member of normalized) await conn.query(
      `INSERT INTO platform_pool_memberships (id,pool_version_id,resource_id,membership_metadata_json,priority,enabled,effective_at,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [uuid(), version.id, member.resourceId, JSON.stringify(member.metadata), member.priority, member.enabled ? 1 : 0, member.effectiveAt, member.expiresAt, clean(actorId, 128) || null]
    );
    await conn.query('UPDATE platform_pool_versions SET member_count=?,updated_at=NOW(3) WHERE id=?', [normalized.length, version.id]);
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  return { versionId: version.id, memberCount: normalized.length };
}

async function publishPoolVersion(versionId, actorId = null, pool = null) {
  const p = pool || getPool();
  const version = await getPoolVersion(versionId, p);
  if (version.status === 'published') return poolVersionRow(version);
  if (version.status !== 'draft') throw statusError('Only draft pool versions can be published', 409, 'PLATFORM_CATALOG_POOL_VERSION_INVALID');
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE platform_pool_versions SET status='published',published_by=?,published_at=NOW(3),updated_at=NOW(3) WHERE id=?", [clean(actorId, 128) || null, version.id]);
    await conn.query("UPDATE platform_pools SET current_version=?,status='active',updated_by=?,updated_at=NOW(3) WHERE id=?", [version.version, clean(actorId, 128) || null, version.pool_id]);
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  const pools = await listPools({ namespace: version.namespace }, p);
  return pools.find((item) => item.id === version.pool_id)?.versions.find((item) => item.id === version.id);
}

async function listSourceSets(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_source_sets ORDER BY name');
  const sets = rows.map(sourceSetRow);
  if (!sets.length) return sets;
  const ids = sets.map((item) => item.id);
  const [versionRows] = await p.query(`SELECT * FROM divedeep_source_set_versions WHERE source_set_id IN (${ids.map(() => '?').join(',')}) ORDER BY source_set_id,version DESC`, ids);
  const versions = new Map(versionRows.map((row) => [row.id, sourceSetVersionRow(row)]));
  const versionIds = [...versions.keys()];
  if (versionIds.length) {
    const marks = versionIds.map(() => '?').join(',');
    const [poolLinks] = await p.query(
      `SELECT l.*,v.version AS pool_version,p.id AS pool_id,p.name AS pool_name,p.slug AS pool_slug,p.namespace,p.status AS pool_status,v.status AS pool_version_status
       FROM divedeep_source_set_pool_links l INNER JOIN platform_pool_versions v ON v.id=l.pool_version_id INNER JOIN platform_pools p ON p.id=v.pool_id
       WHERE l.source_set_version_id IN (${marks}) ORDER BY l.source_set_version_id,l.priority,p.name`, versionIds
    );
    for (const row of poolLinks) versions.get(row.source_set_version_id)?.pools.push({ id: row.id, poolVersionId: row.pool_version_id, poolId: row.pool_id, poolName: row.pool_name, poolSlug: row.pool_slug, namespace: row.namespace, poolStatus: row.pool_status, poolVersionStatus: row.pool_version_status, version: Number(row.pool_version), inclusionMode: row.inclusion_mode, priority: Number(row.priority) || 0, filter: parseJson(row.filter_json, {}) });
    const [resourceLinks] = await p.query(
      `SELECT l.*,r.name AS resource_name,r.slug AS resource_slug,r.primary_domain,r.status AS resource_status
       FROM divedeep_source_set_resource_links l INNER JOIN platform_resources r ON r.id=l.resource_id
       WHERE l.source_set_version_id IN (${marks}) ORDER BY l.source_set_version_id,l.priority,r.name`, versionIds
    );
    for (const row of resourceLinks) versions.get(row.source_set_version_id)?.resources.push({ id: row.id, resourceId: row.resource_id, resourceName: row.resource_name, resourceSlug: row.resource_slug, primaryDomain: row.primary_domain || '', resourceStatus: row.resource_status, inclusionMode: row.inclusion_mode, priority: Number(row.priority) || 0, metadata: parseJson(row.metadata_json, {}) });
  }
  const bySet = new Map(sets.map((item) => [item.id, item]));
  for (const version of versions.values()) bySet.get(version.sourceSetId)?.versions.push(version);
  return sets;
}

async function createSourceSet(input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const name = clean(input.name, 255);
  if (!name) throw statusError('Source-set name is required');
  const id = uuid();
  const versionId = uuid();
  const status = SET_STATUSES.has(input.status) ? input.status : 'draft';
  const mode = SELECTION_MODES.has(input.selectionMode) ? input.selectionMode : 'pools';
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('INSERT INTO divedeep_source_sets (id,slug,name,description,status,current_version,created_by,updated_by) VALUES (?,?,?,?,?,0,?,?)', [id, slugify(input.slug || name, 'Source-set slug'), name, clean(input.description, 2000), status, clean(actorId, 128) || null, clean(actorId, 128) || null]);
    await conn.query("INSERT INTO divedeep_source_set_versions (id,source_set_id,version,status,selection_mode,metadata_json,created_by) VALUES (?,?,1,'draft',?,?,?)", [versionId, id, mode, JSON.stringify(objectInput(input.metadata, 'Source-set metadata')), clean(actorId, 128) || null]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    if (String(error.code || '').includes('DUP')) throw statusError('A source set with that slug already exists', 409, 'DIVEDEEP_SOURCE_SET_EXISTS');
    throw error;
  } finally { conn.release(); }
  if (input.poolVersionIds || input.resourceIds) await replaceSourceSetLinks(versionId, input, actorId, p);
  if (bool(input.publish)) await publishSourceSetVersion(versionId, actorId, p);
  return (await listSourceSets(p)).find((item) => item.id === id);
}

async function getSourceSetVersion(versionId, pool) {
  const [rows] = await pool.query('SELECT v.*,s.name AS source_set_name,s.slug,s.status AS source_set_status FROM divedeep_source_set_versions v INNER JOIN divedeep_source_sets s ON s.id=v.source_set_id WHERE v.id=? LIMIT 1', [clean(versionId, 36)]);
  if (!rows[0]) throw statusError('Source-set version not found', 404, 'DIVEDEEP_SOURCE_SET_VERSION_NOT_FOUND');
  return rows[0];
}

async function createSourceSetVersion(sourceSetId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const [setRows] = await p.query('SELECT * FROM divedeep_source_sets WHERE id=? LIMIT 1', [clean(sourceSetId, 36)]);
  if (!setRows[0]) throw statusError('Source set not found', 404, 'DIVEDEEP_SOURCE_SET_NOT_FOUND');
  let currentVersion = null;
  if (Number(setRows[0].current_version) > 0) {
    const [currentRows] = await p.query('SELECT * FROM divedeep_source_set_versions WHERE source_set_id=? AND version=? LIMIT 1', [sourceSetId, setRows[0].current_version]);
    currentVersion = currentRows[0] || null;
  }
  const [nextRows] = await p.query('SELECT COALESCE(MAX(version),0)+1 AS next_version FROM divedeep_source_set_versions WHERE source_set_id=?', [sourceSetId]);
  const version = Number(nextRows[0]?.next_version) || 1;
  const id = uuid();
  const mode = input.selectionMode === undefined
    ? (SELECTION_MODES.has(currentVersion?.selection_mode) ? currentVersion.selection_mode : 'pools')
    : (SELECTION_MODES.has(input.selectionMode) ? input.selectionMode : (() => { throw statusError('Invalid selection mode'); })());
  const metadata = input.metadata === undefined ? parseJson(currentVersion?.metadata_json, {}) : objectInput(input.metadata, 'Source-set metadata');
  await p.query("INSERT INTO divedeep_source_set_versions (id,source_set_id,version,status,selection_mode,metadata_json,created_by) VALUES (?,?,?,'draft',?,?,?)", [id, sourceSetId, version, mode, JSON.stringify(metadata), clean(actorId, 128) || null]);
  if (input.poolVersionIds || input.resourceIds) await replaceSourceSetLinks(id, input, actorId, p);
  else if (input.cloneCurrent !== false && currentVersion) {
    const [poolLinks] = await p.query('SELECT pool_version_id,inclusion_mode,priority,filter_json FROM divedeep_source_set_pool_links WHERE source_set_version_id=?', [currentVersion.id]);
    const [resourceLinks] = await p.query('SELECT resource_id,inclusion_mode,priority,metadata_json FROM divedeep_source_set_resource_links WHERE source_set_version_id=?', [currentVersion.id]);
    await replaceSourceSetLinks(id, { poolVersionIds: poolLinks.map((row) => ({ id: row.pool_version_id, inclusionMode: row.inclusion_mode, priority: row.priority, filter: parseJson(row.filter_json, {}) })), resourceIds: resourceLinks.map((row) => ({ id: row.resource_id, inclusionMode: row.inclusion_mode, priority: row.priority, metadata: parseJson(row.metadata_json, {}) })) }, actorId, p);
  }
  if (bool(input.publish)) await publishSourceSetVersion(id, actorId, p);
  return (await listSourceSets(p)).find((item) => item.id === sourceSetId)?.versions.find((item) => item.id === id);
}

async function updateSourceSetVersion(versionId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const version = await getSourceSetVersion(versionId, p);
  if (version.status !== 'draft') throw statusError('Published source-set versions are immutable. Create a new version', 409, 'DIVEDEEP_SOURCE_SET_VERSION_IMMUTABLE');
  const mode = input.selectionMode === undefined
    ? version.selection_mode
    : (SELECTION_MODES.has(input.selectionMode) ? input.selectionMode : (() => { throw statusError('Invalid selection mode'); })());
  const metadata = input.metadata === undefined ? parseJson(version.metadata_json, {}) : objectInput(input.metadata, 'Source-set metadata');
  await p.query('UPDATE divedeep_source_set_versions SET selection_mode=?,metadata_json=?,updated_at=NOW(3) WHERE id=?', [mode, JSON.stringify(metadata), version.id]);
  if (input.poolVersionIds !== undefined || input.resourceIds !== undefined) await replaceSourceSetLinks(version.id, input, actorId, p);
  return (await listSourceSets(p)).find((item) => item.id === version.source_set_id)?.versions.find((item) => item.id === version.id);
}

async function replaceSourceSetLinks(versionId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const version = await getSourceSetVersion(versionId, p);
  if (version.status !== 'draft') throw statusError('Published source-set versions are immutable. Create a new version', 409, 'DIVEDEEP_SOURCE_SET_VERSION_IMMUTABLE');
  const pools = arrayInput(input.poolVersionIds, 'Source-set pools', 1000).map((item, index) => {
    const object = typeof item === 'string' ? { id: item } : item;
    const id = clean(object?.poolVersionId || object?.id, 36);
    if (!id) throw statusError(`Source-set pool ${index + 1} is missing an ID`);
    return { id, inclusionMode: object.inclusionMode === 'exclude' ? 'exclude' : 'include', priority: Math.max(-32768, Math.min(32767, Number(object.priority) || 0)), filter: objectInput(object.filter, 'Pool filter') };
  });
  const resources = arrayInput(input.resourceIds, 'Source-set resources', 5000).map((item, index) => {
    const object = typeof item === 'string' ? { id: item } : item;
    const id = clean(object?.resourceId || object?.id, 36);
    if (!id) throw statusError(`Source-set resource ${index + 1} is missing an ID`);
    return { id, inclusionMode: object.inclusionMode === 'exclude' ? 'exclude' : 'include', priority: Math.max(-32768, Math.min(32767, Number(object.priority) || 0)), metadata: objectInput(object.metadata, 'Resource link metadata') };
  });
  if (pools.length) {
    const [rows] = await p.query(`SELECT id FROM platform_pool_versions WHERE id IN (${pools.map(() => '?').join(',')})`, pools.map((item) => item.id));
    if (rows.length !== new Set(pools.map((item) => item.id)).size) throw statusError('One or more pool versions do not exist', 409, 'DIVEDEEP_SOURCE_SET_POOL_MISSING');
  }
  if (resources.length) {
    const [rows] = await p.query(`SELECT id FROM platform_resources WHERE id IN (${resources.map(() => '?').join(',')})`, resources.map((item) => item.id));
    if (rows.length !== new Set(resources.map((item) => item.id)).size) throw statusError('One or more resources do not exist', 409, 'DIVEDEEP_SOURCE_SET_RESOURCE_MISSING');
  }
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM divedeep_source_set_pool_links WHERE source_set_version_id=?', [version.id]);
    await conn.query('DELETE FROM divedeep_source_set_resource_links WHERE source_set_version_id=?', [version.id]);
    for (const item of pools) await conn.query('INSERT INTO divedeep_source_set_pool_links (id,source_set_version_id,pool_version_id,inclusion_mode,priority,filter_json,created_by) VALUES (?,?,?,?,?,?,?)', [uuid(), version.id, item.id, item.inclusionMode, item.priority, JSON.stringify(item.filter), clean(actorId, 128) || null]);
    for (const item of resources) await conn.query('INSERT INTO divedeep_source_set_resource_links (id,source_set_version_id,resource_id,inclusion_mode,priority,metadata_json,created_by) VALUES (?,?,?,?,?,?,?)', [uuid(), version.id, item.id, item.inclusionMode, item.priority, JSON.stringify(item.metadata), clean(actorId, 128) || null]);
    await conn.query('UPDATE divedeep_source_set_versions SET pool_count=?,resource_count=?,updated_at=NOW(3) WHERE id=?', [pools.filter((item) => item.inclusionMode === 'include').length, resources.filter((item) => item.inclusionMode === 'include').length, version.id]);
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  return { versionId: version.id, poolCount: pools.length, resourceCount: resources.length };
}

async function publishSourceSetVersion(versionId, actorId = null, pool = null) {
  const p = pool || getPool();
  const version = await getSourceSetVersion(versionId, p);
  if (version.status === 'published') return sourceSetVersionRow(version);
  if (version.status !== 'draft') throw statusError('Only draft source-set versions can be published', 409, 'DIVEDEEP_SOURCE_SET_VERSION_INVALID');
  const [invalidPools] = await p.query(
    `SELECT COUNT(*) AS total FROM divedeep_source_set_pool_links l INNER JOIN platform_pool_versions v ON v.id=l.pool_version_id
     WHERE l.source_set_version_id=? AND l.inclusion_mode='include' AND v.status<>'published'`, [version.id]
  );
  if (Number(invalidPools[0]?.total)) throw statusError('All included pool versions must be published first', 409, 'DIVEDEEP_SOURCE_SET_POOL_UNPUBLISHED');
  const [countRows] = await p.query(
    `SELECT COUNT(DISTINCT included.resource_id) AS total FROM (
       SELECT m.resource_id
       FROM divedeep_source_set_pool_links l
       INNER JOIN platform_pool_versions pv ON pv.id=l.pool_version_id AND pv.status='published'
       INNER JOIN platform_pool_memberships m ON m.pool_version_id=pv.id AND m.enabled=1
       WHERE l.source_set_version_id=? AND l.inclusion_mode='include'
         AND (m.effective_at IS NULL OR m.effective_at<=NOW(3))
         AND (m.expires_at IS NULL OR m.expires_at>NOW(3))
       UNION
       SELECT r.resource_id FROM divedeep_source_set_resource_links r
       WHERE r.source_set_version_id=? AND r.inclusion_mode='include'
     ) included
     INNER JOIN platform_resources active_resource ON active_resource.id=included.resource_id AND active_resource.status='active'
     WHERE included.resource_id NOT IN (
       SELECT excluded.resource_id FROM (
         SELECT m.resource_id
         FROM divedeep_source_set_pool_links l
         INNER JOIN platform_pool_versions pv ON pv.id=l.pool_version_id AND pv.status='published'
         INNER JOIN platform_pool_memberships m ON m.pool_version_id=pv.id AND m.enabled=1
         WHERE l.source_set_version_id=? AND l.inclusion_mode='exclude'
           AND (m.effective_at IS NULL OR m.effective_at<=NOW(3))
           AND (m.expires_at IS NULL OR m.expires_at>NOW(3))
         UNION
         SELECT r.resource_id FROM divedeep_source_set_resource_links r
         WHERE r.source_set_version_id=? AND r.inclusion_mode='exclude'
       ) excluded
     )`, [version.id, version.id, version.id, version.id]
  );
  const [poolRows] = await p.query("SELECT COUNT(*) AS total FROM divedeep_source_set_pool_links WHERE source_set_version_id=? AND inclusion_mode='include'", [version.id]);
  const resourceCount = Number(countRows[0]?.total) || 0;
  const poolCount = Number(poolRows[0]?.total) || 0;
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE divedeep_source_set_versions SET status='published',resource_count=?,pool_count=?,published_by=?,published_at=NOW(3),updated_at=NOW(3) WHERE id=?", [resourceCount, poolCount, clean(actorId, 128) || null, version.id]);
    await conn.query("UPDATE divedeep_source_sets SET current_version=?,status='active',updated_by=?,updated_at=NOW(3) WHERE id=?", [version.version, clean(actorId, 128) || null, version.source_set_id]);
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  return (await listSourceSets(p)).find((item) => item.id === version.source_set_id)?.versions.find((item) => item.id === version.id);
}

async function listPackageVersions(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT v.*,p.name AS package_name,p.current_version AS package_current_version,s.name AS source_set_name,sv.version AS source_set_version,
            ial.image_analysis_profile_version_id,iap.name AS image_analysis_profile_name,iav.version AS image_analysis_profile_version,ial.is_required AS image_analysis_required
     FROM divedeep_package_versions v INNER JOIN divedeep_packages p ON p.id=v.package_id
     INNER JOIN divedeep_source_set_versions sv ON sv.id=v.source_set_version_id
     INNER JOIN divedeep_source_sets s ON s.id=sv.source_set_id
     LEFT JOIN divedeep_package_image_analysis_links ial ON ial.package_version_id=v.id
     LEFT JOIN divedeep_image_analysis_profile_versions iav ON iav.id=ial.image_analysis_profile_version_id
     LEFT JOIN divedeep_image_analysis_profiles iap ON iap.id=iav.profile_id
     ORDER BY p.sort_order,v.version DESC`
  );
  return rows.map(packageVersionRow);
}

async function createPackageVersion(packageId, input = {}, actorId = null, pool = null) {
  const p = pool || getPool();
  const id = clean(packageId, 64).toLowerCase();
  const [packageRows] = await p.query('SELECT * FROM divedeep_packages WHERE id=? LIMIT 1', [id]);
  if (!packageRows[0]) throw statusError('Package not found', 404, 'DIVEDEEP_PACKAGE_NOT_FOUND');
  const sourceSetVersionId = clean(input.sourceSetVersionId, 36);
  const [setRows] = await p.query("SELECT * FROM divedeep_source_set_versions WHERE id=? AND status='published' LIMIT 1", [sourceSetVersionId]);
  if (!setRows[0]) throw statusError('A published source-set version is required', 409, 'DIVEDEEP_PACKAGE_SOURCE_SET_REQUIRED');
  const [nextRows] = await p.query('SELECT COALESCE(MAX(version),0)+1 AS next_version FROM divedeep_package_versions WHERE package_id=?', [id]);
  const version = Number(nextRows[0]?.next_version) || 1;
  const versionId = uuid();
  await p.query(
    `INSERT INTO divedeep_package_versions (id,package_id,version,status,source_set_version_id,requirements_json,execution_policy_json,review_policy_json,retention_policy_json,created_by)
     VALUES (?,?,?,'draft',?,?,?,?,?,?)`,
    [versionId, id, version, sourceSetVersionId, JSON.stringify(objectInput(input.requirements, 'Requirements')), JSON.stringify(objectInput(input.executionPolicy, 'Execution policy')), JSON.stringify(objectInput(input.reviewPolicy, 'Review policy')), JSON.stringify(objectInput(input.retentionPolicy, 'Retention policy')), clean(actorId, 128) || null]
  );
  if (input.imageProfileVersionId) {
    await imageAnalysis.setPackageProfile(versionId, input.imageProfileVersionId, input.imageAnalysisRequired, actorId, p);
  }
  if (bool(input.publish)) await publishPackageVersion(versionId, actorId, p);
  return (await listPackageVersions(p)).find((item) => item.id === versionId);
}

async function publishPackageVersion(versionId, actorId = null, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM divedeep_package_versions WHERE id=? LIMIT 1', [clean(versionId, 36)]);
  const version = rows[0];
  if (!version) throw statusError('Package version not found', 404, 'DIVEDEEP_PACKAGE_VERSION_NOT_FOUND');
  if (version.status === 'published') return (await listPackageVersions(p)).find((item) => item.id === version.id);
  if (version.status !== 'draft') throw statusError('Only draft package versions can be published', 409, 'DIVEDEEP_PACKAGE_VERSION_INVALID');
  const [setRows] = await p.query("SELECT status FROM divedeep_source_set_versions WHERE id=? LIMIT 1", [version.source_set_version_id]);
  if (setRows[0]?.status !== 'published') throw statusError('The source-set version must be published first', 409, 'DIVEDEEP_PACKAGE_SOURCE_SET_UNPUBLISHED');
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE divedeep_package_versions SET status='published',published_by=?,published_at=NOW(3),updated_at=NOW(3) WHERE id=?", [clean(actorId, 128) || null, version.id]);
    await conn.query('UPDATE divedeep_packages SET current_version=?,updated_by=?,updated_at=NOW(3) WHERE id=?', [version.version, clean(actorId, 128) || null, version.package_id]);
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  return (await listPackageVersions(p)).find((item) => item.id === version.id);
}

async function resolvePackageSourceManifest(packageId, versionNumber = null, pool = null) {
  const p = pool || getPool();
  const id = clean(packageId, 64).toLowerCase();
  const requestedVersion = versionNumber == null || versionNumber === '' ? null : Number(versionNumber);
  if (requestedVersion != null && (!Number.isInteger(requestedVersion) || requestedVersion < 1)) {
    throw statusError('Package version must be a positive integer');
  }
  const versionPredicate = requestedVersion == null ? 'v.version=p.current_version' : 'v.version=?';
  const params = requestedVersion == null ? [id] : [requestedVersion, id];
  const [versions] = await p.query(
    `SELECT v.*,p.name AS package_name,p.current_version AS package_current_version,
            s.id AS source_set_id,s.name AS source_set_name,sv.version AS source_set_version
     FROM divedeep_packages p
     INNER JOIN divedeep_package_versions v ON v.package_id=p.id AND ${versionPredicate} AND v.status='published'
     INNER JOIN divedeep_source_set_versions sv ON sv.id=v.source_set_version_id AND sv.status='published'
     INNER JOIN divedeep_source_sets s ON s.id=sv.source_set_id
     WHERE p.id=? LIMIT 1`, params
  );
  const packageVersion = versions[0];
  if (!packageVersion) throw statusError('Published package version not found', 404, 'DIVEDEEP_PACKAGE_VERSION_NOT_FOUND');
  const sourceSetVersionId = packageVersion.source_set_version_id;
  const [poolLinks] = await p.query(
    `SELECT l.inclusion_mode,l.priority,l.filter_json,v.id AS pool_version_id,v.version,
            p.id AS pool_id,p.slug,p.name,p.namespace,p.pool_type
     FROM divedeep_source_set_pool_links l
     INNER JOIN platform_pool_versions v ON v.id=l.pool_version_id AND v.status='published'
     INNER JOIN platform_pools p ON p.id=v.pool_id
     WHERE l.source_set_version_id=? ORDER BY l.priority,p.name`, [sourceSetVersionId]
  );
  const [resourceRows] = await p.query(
    `SELECT DISTINCT r.*,ms.name AS metadata_schema_name,ms.version AS metadata_schema_version
     FROM platform_resources r
     LEFT JOIN platform_metadata_schemas ms ON ms.id=r.metadata_schema_id
     WHERE r.id IN (
       SELECT m.resource_id
       FROM divedeep_source_set_pool_links l
       INNER JOIN platform_pool_versions pv ON pv.id=l.pool_version_id AND pv.status='published'
       INNER JOIN platform_pool_memberships m ON m.pool_version_id=pv.id AND m.enabled=1
       WHERE l.source_set_version_id=? AND l.inclusion_mode='include'
         AND (m.effective_at IS NULL OR m.effective_at<=NOW(3))
         AND (m.expires_at IS NULL OR m.expires_at>NOW(3))
       UNION
       SELECT x.resource_id FROM divedeep_source_set_resource_links x
       WHERE x.source_set_version_id=? AND x.inclusion_mode='include'
     )
     AND r.id NOT IN (
       SELECT excluded.resource_id FROM (
         SELECT m.resource_id
         FROM divedeep_source_set_pool_links l
         INNER JOIN platform_pool_versions pv ON pv.id=l.pool_version_id AND pv.status='published'
         INNER JOIN platform_pool_memberships m ON m.pool_version_id=pv.id AND m.enabled=1
         WHERE l.source_set_version_id=? AND l.inclusion_mode='exclude'
           AND (m.effective_at IS NULL OR m.effective_at<=NOW(3))
           AND (m.expires_at IS NULL OR m.expires_at>NOW(3))
         UNION
         SELECT x.resource_id FROM divedeep_source_set_resource_links x
         WHERE x.source_set_version_id=? AND x.inclusion_mode='exclude'
       ) excluded
     )
     AND r.status='active'
     ORDER BY r.category,r.topic,r.name`, [sourceSetVersionId, sourceSetVersionId, sourceSetVersionId, sourceSetVersionId]
  );
  return {
    package: packageVersionRow(packageVersion),
    sourceSet: {
      id: packageVersion.source_set_id,
      versionId: packageVersion.source_set_version_id,
      name: packageVersion.source_set_name,
      version: Number(packageVersion.source_set_version),
    },
    pools: poolLinks.map((row) => ({
      poolId: row.pool_id,
      poolVersionId: row.pool_version_id,
      version: Number(row.version),
      namespace: row.namespace,
      poolType: row.pool_type,
      slug: row.slug,
      name: row.name,
      inclusionMode: row.inclusion_mode,
      priority: Number(row.priority) || 0,
      filter: parseJson(row.filter_json, {}),
    })),
    resources: resourceRows.map(resourceRow),
    imageAnalysis: await imageAnalysis.resolvePackageImageAnalysis(packageVersion.id, p),
    generatedAt: new Date().toISOString(),
  };
}

async function getCatalogSummary(pool = null) {
  const p = pool || getPool();
  const [[resourceRows], [poolRows], [setRows], [schemaRows], [packageRows]] = await Promise.all([
    p.query("SELECT COUNT(*) AS total,SUM(status='active') AS active,SUM(sensitivity_class<>'standard') AS sensitive,COUNT(DISTINCT primary_domain) AS domains FROM platform_resources"),
    p.query("SELECT COUNT(*) AS total,SUM(status='active') AS active FROM platform_pools"),
    p.query("SELECT COUNT(*) AS total,SUM(status='active') AS active FROM divedeep_source_sets"),
    p.query("SELECT COUNT(*) AS total,SUM(status='published') AS published FROM platform_metadata_schemas"),
    p.query("SELECT COUNT(*) AS total,SUM(status='published') AS published FROM divedeep_package_versions"),
  ]);
  return {
    resources: { total: Number(resourceRows[0]?.total) || 0, active: Number(resourceRows[0]?.active) || 0, sensitive: Number(resourceRows[0]?.sensitive) || 0, domains: Number(resourceRows[0]?.domains) || 0 },
    pools: { total: Number(poolRows[0]?.total) || 0, active: Number(poolRows[0]?.active) || 0 },
    sourceSets: { total: Number(setRows[0]?.total) || 0, active: Number(setRows[0]?.active) || 0 },
    schemas: { total: Number(schemaRows[0]?.total) || 0, published: Number(schemaRows[0]?.published) || 0 },
    packageVersions: { total: Number(packageRows[0]?.total) || 0, published: Number(packageRows[0]?.published) || 0 },
  };
}

async function getCatalogBundle(filters = {}, pool = null) {
  const p = pool || getPool();
  const [summary, schemas, resources, pools, sourceSets, packageVersions] = await Promise.all([
    getCatalogSummary(p),
    listMetadataSchemas({}, p),
    listResources({ namespace: filters.namespace || 'divedeep.source', limit: filters.limit || 2000 }, p),
    listPools({ namespace: filters.namespace || 'divedeep.source' }, p),
    listSourceSets(p),
    listPackageVersions(p),
  ]);
  return { summary, schemas, resources, pools, sourceSets, packageVersions };
}

module.exports = {
  validateAgainstSchema,
  listMetadataSchemas,
  createMetadataSchema,
  updateMetadataSchema,
  listResources,
  getResource,
  createResource,
  updateResource,
  listResourceRevisions,
  listPools,
  createPool,
  createPoolVersion,
  updatePoolVersion,
  replacePoolMembers,
  publishPoolVersion,
  listSourceSets,
  createSourceSet,
  createSourceSetVersion,
  updateSourceSetVersion,
  replaceSourceSetLinks,
  publishSourceSetVersion,
  listPackageVersions,
  createPackageVersion,
  publishPackageVersion,
  resolvePackageSourceManifest,
  getCatalogSummary,
  getCatalogBundle,
};
