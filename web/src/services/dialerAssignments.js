const crypto = require('crypto');
const { integrationCredential } = require('./crmIntegrations');
const { resolveComplianceLead } = require('./marketingCompliance');
const { getScheduleWeek } = require('./dialerSchedules');
const { getAssignmentPolicy, detectContactLanguage } = require('./assignmentPolicies');

const DEFAULT_ASSIGNED_DIALER_FIELD_ID = String(process.env.CRM_ASSIGNED_DIALER_FIELD_ID || '').trim();

function normalizeServicePool(value) {
  const text = String(value || '').trim().toLowerCase();
  if (/roof/.test(text)) return 'roofing';
  if (/mold/.test(text)) return 'mold';
  if (/solar/.test(text)) return 'solar';
  if (/kitchen/.test(text)) return 'kitchen';
  if (/bath/.test(text)) return 'bathroom';
  if (/addition/.test(text)) return 'home_addition';
  return text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

async function listDialerPoolPermissions(pool, locationId) {
  const [rows] = await pool.query(
    `SELECT user_id AS userId,service_pool AS servicePool,is_enabled AS isEnabled,
            assignment_count AS assignmentCount,last_assigned_at AS lastAssignedAt
     FROM owl_user_pool_permissions WHERE location_id=? ORDER BY user_id,service_pool`,
    [String(locationId || '').trim()]
  );
  return rows.map((row) => ({
    ...row,
    isEnabled:Boolean(row.isEnabled),
    assignmentCount:Number(row.assignmentCount || 0),
  }));
}

async function saveDialerPoolPermissions(pool, input = {}) {
  const locationId = String(input.locationId || '').trim();
  const userId = String(input.userId || '').trim();
  if (!locationId || !userId) throw inputError('locationId and userId are required', 'OWL_DIALER_PERMISSION_SCOPE_REQUIRED');
  const servicePools = [...new Set((Array.isArray(input.servicePools) ? input.servicePools : [])
    .map(normalizeServicePool).filter(Boolean))];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [before] = await conn.query(
      `SELECT service_pool AS servicePool FROM owl_user_pool_permissions
       WHERE location_id=? AND user_id=? AND is_enabled=1 ORDER BY service_pool FOR UPDATE`,
      [locationId, userId]
    );
    await conn.query(
      `UPDATE owl_user_pool_permissions SET is_enabled=0,updated_at=CURRENT_TIMESTAMP(3)
       WHERE location_id=? AND user_id=?`,
      [locationId, userId]
    );
    for (const servicePool of servicePools) {
      await conn.query(
        `INSERT INTO owl_user_pool_permissions
           (location_id,user_id,service_pool,is_enabled)
         VALUES (?,?,?,1)
         ON DUPLICATE KEY UPDATE is_enabled=1,updated_at=CURRENT_TIMESTAMP(3)`,
        [locationId, userId, servicePool]
      );
    }
    await conn.commit();
    return { before:before.map((row) => row.servicePool), after:servicePools };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function assignDialer(pool, input = {}) {
  const locationId = String(input.locationId || '').trim();
  const apiKeyId = String(input.apiKeyId || '').trim();
  const contactId = String(input.contactId || '').trim();
  const servicePool = normalizeServicePool(input.servicePool);
  const fieldId = String(input.assignedDialerFieldId || DEFAULT_ASSIGNED_DIALER_FIELD_ID).trim();
  if (!fieldId) throw inputError('Configure CRM_ASSIGNED_DIALER_FIELD_ID or supply assignedDialerFieldId', 'HAWK_DIALER_FIELD_REQUIRED');
  if (!locationId || !contactId || !servicePool) {
    throw inputError('locationId, contactId, and servicePool are required', 'HAWK_DIALER_ASSIGNMENT_INPUT_REQUIRED');
  }
  if (!input.integration) throw inputError('GoHighLevel integration is required', 'HAWK_CONNECTION_REQUIRED');

  const current = await fetchContact(input.integration, contactId, input.fetchImpl || global.fetch);
  const policy = await getAssignmentPolicy(pool, locationId);
  const languageCode = detectContactLanguage(current, policy);
  const existingDialer = customFieldValue(current, fieldId);
  const ownerId = contactOwnerId(current);
  let selected;
  if (existingDialer) {
    selected = await userForCrmId(pool, locationId, existingDialer);
    selected = { userId:selected?.id || null, crmUserId:existingDialer, source:'existing_assigned_dialer' };
  } else if (ownerId) {
    const owner = await userForCrmId(pool, locationId, ownerId);
    selected = { userId:owner?.id || null, crmUserId:ownerId, source:'record_owner' };
  } else {
    selected = await nextRoundRobinUser(pool, locationId, servicePool, {
      allowEmpty:true,
      languageCode,
      defaultLanguageCode:policy.defaultLanguageCode,
      requireSubmittedSchedule:policy.requireSubmittedSchedule,
    });
    if (!selected) {
      selected = await fallbackUserForPool(pool, {
        sourceSlug:input.sourceSlug,
        locationId,
        servicePool, languageCode, defaultLanguageCode:policy.defaultLanguageCode,
        requireSubmittedSchedule:policy.requireSubmittedSchedule,
      });
    }
    if (!selected) {
      throw Object.assign(new Error(`No round-robin or fallback dialer is available for service pool ${servicePool}`), {
        status:409,
        code:'OWL_NO_DIALER_ASSIGNMENT_OPTION',
        details:{ locationId, servicePool },
      });
    }
  }

  if (!existingDialer) {
    await updateContactAssignment(input.integration, contactId, {
      assignedDialerFieldId:fieldId,
      crmUserId:selected.crmUserId,
      setOwner:!ownerId,
    }, input.fetchImpl || global.fetch);
  }

  if (selected.userId && input.operationalPool) {
    try {
      const lead = await resolveComplianceLead(pool, { locationId, contactId, operationalPool:input.operationalPool });
      await input.operationalPool.query(
        'UPDATE leads SET assignedTo=? WHERE id=? AND locationId=?',
        [selected.userId, lead.id, locationId]
      );
    } catch (error) {
      if (error?.code !== 'CONTACT_NOT_FOUND') throw error;
    }
  }

  await pool.query(
    `INSERT INTO hawk_dialer_assignment_events
       (id,api_key_id,location_id,contact_id,service_pool,user_id,crm_user_id,assignment_source)
     VALUES (?,?,?,?,?,?,?,?)`,
    [crypto.randomUUID(), apiKeyId || null, locationId, contactId, servicePool,
      selected.userId || null, selected.crmUserId, selected.source]
  );
  return {
    assigned:true,
    contactId,
    servicePool,
    assignedDialer:selected.crmUserId,
    owlUserId:selected.userId,
    source:selected.source,
    contactUpdated:!existingDialer,
    ownerUpdated:!existingDialer && !ownerId,
    languageCode,
  };
}

async function nextRoundRobinUser(pool, locationId, servicePool, options = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const languageCode = String(options.languageCode || options.defaultLanguageCode || 'en').toLowerCase();
    const defaultLanguageCode = String(options.defaultLanguageCode || 'en').toLowerCase();
    const languageClause = languageCode === defaultLanguageCode ? '' : `
         AND EXISTS (SELECT 1 FROM owl_user_language_permissions lp
                     WHERE lp.location_id=p.location_id AND lp.user_id=p.user_id
                       AND lp.language_code=? AND lp.is_enabled=1)`;
    const scheduleClause = options.requireSubmittedSchedule === true ? `
         AND EXISTS (SELECT 1 FROM user_schedule_weeks sw
                     WHERE sw.locationId=p.location_id AND sw.userId=p.user_id
                       AND sw.weekStart=? AND sw.submittedAt IS NOT NULL)` : '';
    const params = [locationId, servicePool];
    if (languageClause) params.push(languageCode);
    if (scheduleClause) params.push(getScheduleWeek().weekStart);
    const [rows] = await conn.query(
      `SELECT p.user_id AS userId,u.crmUserId AS crmUserId
       FROM owl_user_pool_permissions p
       INNER JOIN users u ON u.id=p.user_id AND u.locationId=p.location_id
       WHERE p.location_id=? AND p.service_pool=? AND p.is_enabled=1
         AND u.crmUserId IS NOT NULL AND u.crmUserId<>''${languageClause}${scheduleClause}
       ORDER BY COALESCE(p.last_assigned_at,'1970-01-01 00:00:00.000'),p.assignment_count,p.user_id
       LIMIT 1 FOR UPDATE`,
      params
    );
    if (!rows[0]) {
      if (options.allowEmpty) {
        await conn.commit();
        return null;
      }
      throw Object.assign(new Error(`No OWL dialer user is permitted for service pool ${servicePool}`), {
        status:409,
        code:'OWL_NO_DIALER_POOL_PERMISSION',
        details:{ locationId, servicePool },
      });
    }
    await conn.query(
      `UPDATE owl_user_pool_permissions
       SET assignment_count=assignment_count+1,last_assigned_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3)
       WHERE location_id=? AND user_id=? AND service_pool=?`,
      [locationId, rows[0].userId, servicePool]
    );
    await conn.commit();
    return { ...rows[0], source:'round_robin' };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function fallbackUserForPool(pool, input = {}) {
  const sourceSlug = String(input.sourceSlug || 'core').trim().toLowerCase() || 'core';
  const locationId = String(input.locationId || '').trim();
  const servicePool = normalizeServicePool(input.servicePool);
  const [rows] = await pool.query(
    `SELECT sp.source_slug AS sourceSlug,sp.service_type AS serviceType,
            sp.tag_keywords_json AS tagKeywordsJson,sp.fallback_user_id AS userId,u.crmUserId AS crmUserId
     FROM owl_service_pools sp
     LEFT JOIN users u ON u.id=sp.fallback_user_id AND u.locationId=sp.location_id
     WHERE sp.source_slug IN (?, 'core') AND sp.location_id=? AND sp.is_enabled=1
       AND sp.fallback_user_id IS NOT NULL AND sp.fallback_user_id<>''`,
    [sourceSlug, locationId]
  );
  const selected = rows
    .map((row) => ({ row, match:fallbackPoolMatch(row, servicePool) }))
    .filter((item) => item.match < 2)
    .sort((a, b) => a.match - b.match
      || sourcePriority(a.row.sourceSlug, sourceSlug) - sourcePriority(b.row.sourceSlug, sourceSlug))[0]?.row;
  if (!selected) return null;
  if (!cleanId(selected.crmUserId)) {
    throw Object.assign(new Error(`The fallback dialer for ${servicePool} is not mapped to a GoHighLevel CRM user`), {
      status:409,
      code:'OWL_FALLBACK_DIALER_INVALID',
      details:{ locationId, servicePool, userId:selected.userId || null },
    });
  }
  const languageCode = String(input.languageCode || input.defaultLanguageCode || 'en').toLowerCase();
  const defaultLanguageCode = String(input.defaultLanguageCode || 'en').toLowerCase();
  if (languageCode !== defaultLanguageCode) {
    const [allowed] = await pool.query(
      `SELECT 1 FROM owl_user_language_permissions
       WHERE location_id=? AND user_id=? AND language_code=? AND is_enabled=1 LIMIT 1`,
      [locationId, selected.userId, languageCode]
    );
    if (!allowed[0]) return null;
  }
  if (input.requireSubmittedSchedule === true) {
    const [scheduled] = await pool.query(
      `SELECT 1 FROM user_schedule_weeks
       WHERE locationId=? AND userId=? AND weekStart=? AND submittedAt IS NOT NULL LIMIT 1`,
      [locationId, selected.userId, getScheduleWeek().weekStart]
    );
    if (!scheduled[0]) return null;
  }
  return { userId:selected.userId, crmUserId:selected.crmUserId, source:'pool_fallback' };
}

function fallbackPoolMatch(row, servicePool) {
  if (normalizeServicePool(row.serviceType) === servicePool) return 0;
  const keywords = parseJsonArray(row.tagKeywordsJson);
  return keywords.some((keyword) => normalizeServicePool(keyword) === servicePool) ? 1 : 2;
}

function sourcePriority(value, preferred) {
  const source = String(value || '').trim().toLowerCase();
  if (source === preferred) return 0;
  if (source === 'core') return 1;
  return 2;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function userForCrmId(pool, locationId, crmUserId) {
  const [rows] = await pool.query(
    'SELECT id,crmUserId FROM users WHERE locationId=? AND crmUserId=? LIMIT 1',
    [locationId, crmUserId]
  );
  return rows[0] || null;
}

async function fetchContact(integration, contactId, fetchImpl) {
  const response = await fetchImpl(`${String(integration.base_url).replace(/\/$/, '')}/contacts/${encodeURIComponent(contactId)}`, {
    headers:{ Accept:'application/json', Authorization:`Bearer ${integrationCredential(integration)}`, Version:'2021-07-28' },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw upstreamError(`GoHighLevel contact lookup returned HTTP ${response.status}`, response.status, body);
  return body.contact || body;
}

async function updateContactAssignment(integration, contactId, input, fetchImpl) {
  const fields = {
    ...(input.setOwner ? { assignedTo:input.crmUserId } : {}),
    customFields:[{ id:input.assignedDialerFieldId, field_value:input.crmUserId }],
  };
  const response = await fetchImpl(`${String(integration.base_url).replace(/\/$/, '')}/contacts/${encodeURIComponent(contactId)}`, {
    method:'PUT',
    headers:{ Accept:'application/json', 'Content-Type':'application/json', Authorization:`Bearer ${integrationCredential(integration)}`, Version:'2021-07-28' },
    body:JSON.stringify(fields),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw upstreamError(`GoHighLevel assignment update returned HTTP ${response.status}`, response.status, body);
  return body;
}

function customFieldValue(contact, fieldId) {
  const fields = Array.isArray(contact?.customFields) ? contact.customFields : [];
  const item = fields.find((field) => String(field?.id || field?.fieldId || '') === fieldId);
  return cleanId(item?.value ?? item?.fieldValue ?? item?.field_value);
}

function contactOwnerId(contact) {
  const value = contact?.assignedTo ?? contact?.assignedUserId ?? contact?.ownerId;
  return cleanId(typeof value === 'object' ? value.id : value);
}

function cleanId(value) { return String(value || '').trim().slice(0, 128) || null; }
function inputError(message, code) { return Object.assign(new Error(message), { status:400, code }); }
function upstreamError(message, status, body) {
  return Object.assign(new Error(message), { status:502, code:'HAWK_GHL_HTTP_ERROR', details:{ upstreamStatus:status, body } });
}

module.exports = {
  DEFAULT_ASSIGNED_DIALER_FIELD_ID,
  normalizeServicePool,
  listDialerPoolPermissions,
  saveDialerPoolPermissions,
  nextRoundRobinUser,
  fallbackUserForPool,
  assignDialer,
  customFieldValue,
  contactOwnerId,
};
