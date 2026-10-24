const crypto = require('crypto');

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const DEFAULT_SERVICE_POOLS = [
  service('Roofing', ['roof', 'shingle', 'siding'], '#3b82f6', 10),
  service('Solar', ['solar', 'panel upgrade'], '#eab308', 20),
  service('Kitchen', ['kitchen'], '#a855f7', 30),
  service('Bathroom', ['bathroom', 'bath'], '#8b5cf6', 31),
  service('Home Addition', ['addition', 'home remodel', 'home renovation', 'remodel', 'renovat'], '#6366f1', 32),
  service('Mold / Water Damage', ['mold', 'water damage', 'flood', 'leak repair'], '#06b6d4', 40),
  service('Other', [], '#64748b', 1000, true),
];

function service(serviceType, tagKeywords, color, sortOrder, isFallback = false) {
  return {
    serviceType, tagKeywords, calendarIds: [], defaultCalendarId: null,
    fallbackUserId: null,
    color, sortOrder, isFallback, isEnabled: true,
  };
}

async function ensureDefaultServicePools(pool, source, locationId) {
  // Track whether any split-Remodeling pool is newly seeded.
  const splitTypes = new Set(['Kitchen', 'Bathroom', 'Home Addition']);
  let insertedSplitPool = false;
  for (const item of DEFAULT_SERVICE_POOLS) {
    const [result] = await pool.query(
      `INSERT IGNORE INTO owl_service_pools
         (id, source_slug, location_id, service_type, tag_keywords_json,
          calendar_ids_json, default_calendar_id, fallback_user_id, is_fallback, color, sort_order, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [crypto.randomUUID(), source, locationId, item.serviceType,
        JSON.stringify(item.tagKeywords), JSON.stringify([]), null,
        null, item.isFallback ? 1 : 0, item.color, item.sortOrder]
    );
    if (splitTypes.has(item.serviceType) && result.affectedRows > 0) {
      insertedSplitPool = true;
    }
  }
  // Remove the legacy monolithic Remodeling pool once split pools are seeded.
  if (insertedSplitPool) {
    await pool.query(
      `DELETE FROM owl_service_pools
       WHERE source_slug = ? AND location_id = ? AND service_type = 'Remodeling' AND is_fallback = 0`,
      [source, locationId]
    );
  }
}

async function listServicePools(pool, source, locationId, options = {}) {
  if (options.ensureDefaults !== false) await ensureDefaultServicePools(pool, source, locationId);
  const [rows] = await pool.query(
    `SELECT id, source_slug, location_id, service_type, tag_keywords_json,
            calendar_ids_json, default_calendar_id, fallback_user_id, is_fallback, color, sort_order,
            is_enabled, created_at, updated_at
     FROM owl_service_pools WHERE source_slug = ? AND location_id = ?
     ORDER BY sort_order, service_type`,
    [source, locationId]
  );
  return rows.map(publicServicePool);
}

async function getServicePool(pool, source, locationId, serviceType) {
  const rules = await listServicePools(pool, source, locationId);
  return rules.find((item) => item.serviceType === serviceType) || null;
}

async function upsertServicePool(pool, source, locationId, serviceType, input) {
  const normalized = normalizeServicePool(serviceType, input);
  const rules = await listServicePools(pool, source, locationId);
  const before = rules.find((item) => item.serviceType === normalized.serviceType) || null;
  if (before && input.calendarIds === undefined && input.calendarId === undefined && input.defaultCalendarId === undefined) {
    normalized.calendarIds = before.calendarIds;
    normalized.defaultCalendarId = before.defaultCalendarId;
  }
  if (before && input.fallbackUserId === undefined) normalized.fallbackUserId = before.fallbackUserId;
  if (normalized.fallbackUserId) {
    const [users] = await pool.query(
      `SELECT id,crmUserId FROM users
       WHERE id=? AND locationId=? AND crmUserId IS NOT NULL AND crmUserId<>'' LIMIT 1`,
      [normalized.fallbackUserId, locationId]
    );
    if (!users[0]) {
      throw Object.assign(new Error('Fallback dialer must be an OWL user mapped to a CRM user in this location'), {
        status:400, code:'OWL_FALLBACK_DIALER_INVALID',
      });
    }
  }
  const keywordOwners = new Map();
  for (const item of rules) {
    if (item.serviceType === normalized.serviceType) continue;
    for (const keyword of item.tagKeywords) keywordOwners.set(keyword.toLowerCase(), item.serviceType);
  }
  const duplicates = normalized.tagKeywords.filter((keyword) => keywordOwners.has(keyword));
  if (duplicates.length) {
    throw Object.assign(new Error(`Tag keywords already mapped: ${duplicates.map((keyword) => `${keyword} (${keywordOwners.get(keyword)})`).join(', ')}`), { status: 409 });
  }
  if (before?.isFallback && (!normalized.isFallback || !normalized.isEnabled)) {
    const replacement = rules.some((item) => item.serviceType !== before.serviceType && item.isFallback && item.isEnabled);
    if (!replacement && !normalized.isFallback) {
      throw Object.assign(new Error('A service-pool fallback must remain enabled'), { status: 409 });
    }
  }
  const conn = typeof pool.getConnection === 'function' ? await pool.getConnection() : null;
  const executor = conn || pool;
  try {
    if (conn) await conn.beginTransaction();
    if (normalized.isFallback) {
      await executor.query(
        `UPDATE owl_service_pools SET is_fallback = 0
         WHERE source_slug = ? AND location_id = ? AND service_type <> ?`,
        [source, locationId, normalized.serviceType]
      );
    }
    await executor.query(
      `INSERT INTO owl_service_pools
         (id, source_slug, location_id, service_type, tag_keywords_json,
          calendar_ids_json, default_calendar_id, fallback_user_id, is_fallback, color, sort_order, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE tag_keywords_json = VALUES(tag_keywords_json),
         calendar_ids_json = VALUES(calendar_ids_json),
         default_calendar_id = VALUES(default_calendar_id),
         fallback_user_id = VALUES(fallback_user_id),
         is_fallback = VALUES(is_fallback), color = VALUES(color),
         sort_order = VALUES(sort_order), is_enabled = VALUES(is_enabled)`,
      [crypto.randomUUID(), source, locationId, normalized.serviceType,
        JSON.stringify(normalized.tagKeywords), JSON.stringify(normalized.calendarIds),
        normalized.defaultCalendarId, normalized.fallbackUserId, normalized.isFallback ? 1 : 0,
        normalized.color, normalized.sortOrder, normalized.isEnabled ? 1 : 0]
    );
    if (conn) await conn.commit();
  } catch (error) {
    if (conn) await conn.rollback();
    throw error;
  } finally {
    if (conn) conn.release();
  }
  return { before, after: await getServicePool(pool, source, locationId, normalized.serviceType) };
}

async function setServicePoolCalendars(pool, source, locationId, serviceType, input) {
  const before = await getServicePool(pool, source, locationId, serviceType);
  if (!before) throw Object.assign(new Error('Service pool not found'), { status: 404 });
  return upsertServicePool(pool, source, locationId, serviceType, {
    ...before,
    calendarIds: input.calendarIds,
    defaultCalendarId: input.defaultCalendarId,
  });
}

function matchServiceType(tags, rules, fallbackValue = 'Other') {
  const active = rules.filter((item) => item.isEnabled);
  const fallback = active.find((item) => item.isFallback)?.serviceType || fallbackValue;
  const values = normalizeTags(tags);
  if (!values.length) return fallback;
  for (const tag of values) {
    for (const item of active) {
      if (item.isFallback) continue;
      if (item.tagKeywords.some((keyword) => tag.includes(keyword))) return item.serviceType;
    }
  }
  return fallback;
}

function classifyLeadRecord(record, rules, existingServiceType = null) {
  if (!record || typeof record !== 'object') return existingServiceType || fallbackName(rules);
  const tags = record.tags ?? record.tag ?? record.contactTags;
  if (tags == null) return existingServiceType || fallbackName(rules);
  return matchServiceType(tags, rules, existingServiceType || fallbackName(rules));
}

function mappingsObject(rules) {
  return Object.fromEntries(rules.filter((item) => item.isEnabled && !item.isFallback)
    .map((item) => [item.serviceType, item.tagKeywords]));
}

function normalizeServicePool(serviceType, input) {
  const name = String(serviceType || '').trim().slice(0, 128);
  if (!name || /[\x00-\x1f]/.test(name)) {
    throw Object.assign(new Error('Valid serviceType is required'), { status: 400 });
  }
  const tagKeywords = [...new Set((Array.isArray(input.tagKeywords) ? input.tagKeywords : [])
    .map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  if (tagKeywords.some((keyword) => keyword.length > 128)) {
    throw Object.assign(new Error('Service tag keywords must be 128 characters or fewer'), { status: 400 });
  }
  const isFallback = Boolean(input.isFallback);
  if (isFallback && input.isEnabled === false) {
    throw Object.assign(new Error('The fallback service pool must remain enabled'), { status: 400 });
  }
  if (!isFallback && !tagKeywords.length) {
    throw Object.assign(new Error('Non-fallback service pools require at least one tag keyword'), { status: 400 });
  }
  const calendarIds = normalizeCalendarIds(input.calendarIds ?? input.calendarId);
  const requestedDefault = String(input.defaultCalendarId || '').trim();
  if (requestedDefault && !calendarIds.includes(requestedDefault)) {
    throw Object.assign(new Error('defaultCalendarId must be included in calendarIds'), { status: 400 });
  }
  return {
    serviceType: name,
    tagKeywords,
    calendarIds,
    defaultCalendarId: requestedDefault || calendarIds[0] || null,
    fallbackUserId: normalizeOpaqueId(input.fallbackUserId),
    isFallback,
    color: COLOR_RE.test(String(input.color || '')) ? String(input.color).toLowerCase() : '#64748b',
    sortOrder: Math.min(Math.max(Number(input.sortOrder) || 100, 0), 10000),
    isEnabled: input.isEnabled !== false,
  };
}

function publicServicePool(row) {
  return {
    id: row.id,
    source: row.source_slug,
    locationId: row.location_id,
    serviceType: row.service_type,
    tagKeywords: parseArray(row.tag_keywords_json).map((value) => value.toLowerCase()),
    calendarIds: parseArray(row.calendar_ids_json),
    defaultCalendarId: row.default_calendar_id || null,
    fallbackUserId: row.fallback_user_id || null,
    isFallback: Boolean(row.is_fallback),
    color: row.color,
    sortOrder: Number(row.sort_order),
    isEnabled: Boolean(row.is_enabled),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeOpaqueId(value) {
  const id = String(value || '').trim();
  if (!id) return null;
  if (id.length > 128 || /[\x00-\x1f]/.test(id)) {
    throw Object.assign(new Error('fallbackUserId must be a valid OWL user ID'), { status:400 });
  }
  return id;
}

function normalizeCalendarIds(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const ids = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  if (ids.length > 20) {
    throw Object.assign(new Error('A service pool may have at most 20 calendar IDs'), { status: 400 });
  }
  if (ids.some((id) => id.length > 191 || /[\x00-\x1f]/.test(id))) {
    throw Object.assign(new Error('Calendar IDs must be valid opaque strings of 191 characters or fewer'), { status: 400 });
  }
  return ids;
}

function selectServiceCalendar(service, requestedCalendarId = null) {
  const requested = String(requestedCalendarId || '').trim() || null;
  if (!service || !service.calendarIds.length) {
    if (requested) {
      throw Object.assign(new Error('Calendar cannot be validated against the selected service pool'), { status: 409 });
    }
    return null;
  }
  const selected = requested || service.defaultCalendarId;
  if (!selected) {
    throw Object.assign(new Error(`No default calendar is configured for ${service.serviceType}`), { status: 409 });
  }
  if (!service.calendarIds.includes(selected)) {
    throw Object.assign(new Error(`Calendar is not assigned to service pool ${service.serviceType}`), { status: 409 });
  }
  return selected;
}

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
  return values.map((value) => String(value).trim().toLowerCase()).filter(Boolean);
}

function fallbackName(rules) {
  return rules.find((item) => item.isEnabled && item.isFallback)?.serviceType || 'Other';
}

function parseArray(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

module.exports = {
  DEFAULT_SERVICE_POOLS,
  ensureDefaultServicePools,
  listServicePools,
  getServicePool,
  upsertServicePool,
  setServicePoolCalendars,
  matchServiceType,
  classifyLeadRecord,
  mappingsObject,
  normalizeServicePool,
  normalizeCalendarIds,
  selectServiceCalendar,
};
