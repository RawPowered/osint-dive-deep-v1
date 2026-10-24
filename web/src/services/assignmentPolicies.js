const DEFAULT_LANGUAGE_RULES = [
  {
    code:'en', label:'English',
    values:['english', 'en', 'en-us', 'en_us'],
  },
  {
    code:'es', label:'Spanish',
    values:['spanish', 'es', 'es-us', 'es_us', 'espanol', 'español', 'castellano', 'pr', 'puerto rico', 'puertorico', 'habla espanol', 'habla español'],
  },
];

async function getAssignmentPolicy(pool, locationId) {
  const id = String(locationId || '').trim();
  const [rows] = await pool.query(
    `SELECT location_id AS locationId,require_submitted_schedule AS requireSubmittedSchedule,
            language_field_id AS languageFieldId,language_field_key AS languageFieldKey,
            default_language_code AS defaultLanguageCode,language_rules_json AS languageRulesJson
     FROM owl_assignment_policies WHERE location_id=? LIMIT 1`, [id]
  );
  return policyFromRow(rows[0], id);
}

async function saveAssignmentPolicy(pool, input = {}) {
  const locationId = String(input.locationId || '').trim();
  if (!locationId) throw Object.assign(new Error('locationId is required'), { status:400 });
  const before = await getAssignmentPolicy(pool, locationId);
  const rules = normalizeLanguageRules(input.languageRules || before.languageRules);
  const defaultLanguageCode = normalizeCode(input.defaultLanguageCode || before.defaultLanguageCode || 'en');
  if (!rules.some((rule) => rule.code === defaultLanguageCode)) {
    throw Object.assign(new Error('Default language must exist in the language rules'), { status:400 });
  }
  await pool.query(
    `INSERT INTO owl_assignment_policies
       (location_id,require_submitted_schedule,language_field_id,language_field_key,default_language_code,language_rules_json)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE require_submitted_schedule=VALUES(require_submitted_schedule),
       language_field_id=VALUES(language_field_id),language_field_key=VALUES(language_field_key),
       default_language_code=VALUES(default_language_code),language_rules_json=VALUES(language_rules_json),
       updated_at=CURRENT_TIMESTAMP(3)`,
    [locationId, input.requireSubmittedSchedule === true ? 1 : 0,
      clean(input.languageFieldId, 191), clean(input.languageFieldKey, 191),
      defaultLanguageCode, JSON.stringify(rules)]
  );
  return { before, after:await getAssignmentPolicy(pool, locationId) };
}

async function listUserLanguagePermissions(pool, locationId) {
  const [rows] = await pool.query(
    `SELECT user_id AS userId,language_code AS languageCode,is_enabled AS isEnabled
     FROM owl_user_language_permissions WHERE location_id=? ORDER BY user_id,language_code`,
    [String(locationId || '').trim()]
  );
  return rows.map((row) => ({ ...row, languageCode:normalizeCode(row.languageCode), isEnabled:Boolean(row.isEnabled) }));
}

async function saveUserLanguagePermissions(pool, input = {}) {
  const locationId = String(input.locationId || '').trim();
  const userId = String(input.userId || '').trim();
  if (!locationId || !userId) throw Object.assign(new Error('locationId and userId are required'), { status:400 });
  const codes = [...new Set((Array.isArray(input.languageCodes) ? input.languageCodes : []).map(normalizeCode).filter(Boolean))];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE owl_user_language_permissions SET is_enabled=0,updated_at=CURRENT_TIMESTAMP(3) WHERE location_id=? AND user_id=?', [locationId, userId]);
    for (const code of codes) {
      await conn.query(
        `INSERT INTO owl_user_language_permissions (location_id,user_id,language_code,is_enabled)
         VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE is_enabled=1,updated_at=CURRENT_TIMESTAMP(3)`,
        [locationId, userId, code]
      );
    }
    await conn.commit();
    return codes;
  } catch (error) {
    await conn.rollback(); throw error;
  } finally { conn.release(); }
}

function detectContactLanguage(contact, policy) {
  const rules = normalizeLanguageRules(policy?.languageRules);
  const candidates = new Set(contactTags(contact).map(normalizeLanguageValue).filter(Boolean));
  const fieldValue = configuredFieldValue(contact, policy);
  for (const value of flattenValues(fieldValue)) candidates.add(normalizeLanguageValue(value));
  for (const rule of rules) {
    if (rule.values.some((value) => candidates.has(normalizeLanguageValue(value)))) return rule.code;
  }
  return normalizeCode(policy?.defaultLanguageCode || 'en');
}

function policyFromRow(row, locationId) {
  return {
    locationId,
    requireSubmittedSchedule:Boolean(row?.requireSubmittedSchedule),
    languageFieldId:row?.languageFieldId || null,
    languageFieldKey:row?.languageFieldKey || null,
    defaultLanguageCode:normalizeCode(row?.defaultLanguageCode || 'en'),
    languageRules:normalizeLanguageRules(parseJson(row?.languageRulesJson) || DEFAULT_LANGUAGE_RULES),
  };
}

function configuredFieldValue(contact, policy) {
  const id = String(policy?.languageFieldId || '').trim();
  if (id) {
    const item = (Array.isArray(contact?.customFields) ? contact.customFields : [])
      .find((field) => String(field?.id || field?.fieldId || '') === id);
    if (item) return item.value ?? item.fieldValue ?? item.field_value;
  }
  const key = String(policy?.languageFieldKey || '').trim();
  if (!key) return null;
  return key.split('.').reduce((value, part) => value == null ? null : value[part], contact);
}

function contactTags(contact) {
  const tags = contact?.tags;
  if (Array.isArray(tags)) return tags.map((tag) => typeof tag === 'object' ? tag.name || tag.label || tag.value : tag);
  return typeof tags === 'string' ? tags.split(',') : [];
}

function normalizeLanguageRules(value) {
  const rules = Array.isArray(value) && value.length ? value : DEFAULT_LANGUAGE_RULES;
  return rules.map((rule) => ({
    code:normalizeCode(rule.code),
    label:String(rule.label || rule.code || '').trim().slice(0, 64),
    values:[...new Set((Array.isArray(rule.values) ? rule.values : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 100),
  })).filter((rule) => rule.code && rule.label && rule.values.length).slice(0, 25);
}

function normalizeLanguageValue(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
}
function normalizeCode(value) { return String(value || '').trim().toLowerCase().replace(/_/g, '-').slice(0, 35); }
function flattenValues(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function clean(value, max) { const text = String(value || '').trim(); return text ? text.slice(0, max) : null; }
function parseJson(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }

module.exports = {
  DEFAULT_LANGUAGE_RULES,
  getAssignmentPolicy,
  saveAssignmentPolicy,
  listUserLanguagePermissions,
  saveUserLanguagePermissions,
  detectContactLanguage,
  normalizeLanguageRules,
  normalizeLanguageValue,
};
