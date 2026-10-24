const crypto = require('crypto');
const {
  extractPhoneCandidates,
  scrubPhoneNumbers,
  ALTERNATIVE_PHONE_FIELD_ID,
  PHONE_3_FIELD_ID,
} = require('./dncScrub');
const {
  applyDncScreeningStatus,
  applyMarketingChannelStatus,
} = require('./crmImporter');
const { listPoolRules } = require('./leadPools');
const { syncDncResultsToCrm } = require('./dncCrmSync');
const { integrationCredential, LEADCONNECTOR_ORIGIN } = require('./crmIntegrations');

async function scrubAndPromoteDialerPhone(pool, input = {}) {
  const locationId = required(input.locationId, 'locationId');
  const contactId = required(input.contactId, 'contactId');
  const lead = input.lead;
  if (!lead?.id) throw phoneError('OWL lead is required', 'OWL_PHONE_LEAD_REQUIRED', 409);
  if (!input.integration) throw phoneError('GoHighLevel connection is required', 'OWL_PHONE_CONNECTION_REQUIRED', 409);

  const fetchImpl = input.fetchImpl || global.fetch;
  const record = await fetchContact(input.integration, contactId, fetchImpl);
  const candidates = extractPhoneCandidates(record);
  if (!candidates.length) {
    await persistNoPhone(input.operationalPool || pool, pool, {
      apiKeyId:input.apiKeyId,
      lead, locationId, contactId, record, sourceSlug:input.sourceSlug,
      integrationId:input.integration.id,
    });
    return selectionResult(false, 'phone_unavailable', candidates, [], null);
  }

  const providerResults = await scrubPhoneNumbers(candidates.map((item) => item.phone), { fetchImpl });
  const byPhone = new Map(providerResults.map((item) => [item.phone, item]));
  const checked = candidates.map((candidate) => ({ candidate, provider:byPhone.get(candidate.phone) || null }));
  const selectable = input.requireAlternatePhone === true
    ? checked.filter((item) => item.candidate.slot !== 'primary')
    : checked;
  const selected = selectable.find((item) => item.provider?.state === 'clean') || null;

  if (input.requireAlternatePhone === true && !selected) {
    return selectionResult(false, 'no_dnc_approved_alternate_phone', candidates, checked, null);
  }
  if (!selected) {
    const failure = aggregateFailure(checked);
    await persistDncDecision(input.operationalPool || pool, pool, {
      apiKeyId:input.apiKeyId,
      lead,
      locationId,
      contactId,
      record,
      sourceSlug:input.sourceSlug,
      provider:failure,
      fetchImpl,
      action:`multi_phone_scrub_${failure.state}`,
      integrationId:input.integration.id,
    });
    return selectionResult(false, failureReason(failure), candidates, checked, failure);
  }

  if (String(lead.dncResultCode || '').toUpperCase() === 'P') {
    return selectionResult(false, 'internal_dnc_requires_review', candidates, checked, selected.provider);
  }

  const promoted = selected.candidate.slot !== 'primary';
  const updatedRecord = promoted
    ? swapPrimaryPhone(record, selected.candidate)
    : record;
  if (promoted) {
    await updateContactPhone(input.integration, contactId, record, selected.candidate, fetchImpl);
  }
  const persisted = await persistDncDecision(input.operationalPool || pool, pool, {
    apiKeyId:input.apiKeyId,
    lead,
    locationId,
    contactId,
    record:updatedRecord,
    sourceSlug:input.sourceSlug,
    provider:selected.provider,
    fetchImpl,
    action:promoted ? 'multi_phone_scrub_promoted' : 'multi_phone_scrub_clean',
    allowBlockedRelease:true,
    integrationId:input.integration.id,
  });
  return {
    ...selectionResult(true, 'dnc_approved_phone_selected', candidates, checked, selected.provider),
    promoted,
    selectedSlot:selected.candidate.slot,
    crmSync:persisted.crmSync,
  };
}

function aggregateFailure(checked) {
  const missing = checked.find((item) => !item.provider);
  if (missing) return unresolvedResult();
  const pending = checked.find((item) => item.provider.state === 'pending');
  if (pending) return pending.provider;
  const review = checked.find((item) => item.provider.state === 'review');
  if (review) return review.provider;
  const blocked = checked.find((item) => item.provider.state === 'blocked');
  return blocked?.provider || unresolvedResult();
}

function unresolvedResult() {
  return {
    state:'pending', resultCode:'MISSING', resultLabel:'No provider result',
    decisionCategory:'unresolved', reviewRequired:true,
    reason:'DNCScrub omitted one or more available phone numbers',
  };
}

function failureReason(provider) {
  if (provider.state === 'blocked') return 'all_phones_dnc_blocked';
  if (provider.state === 'review') return provider.resultCode === 'B'
    ? 'all_phones_blocked_or_b_review' : 'all_phones_blocked_or_review';
  return 'phone_dnc_unresolved';
}

async function persistNoPhone(operationalPool, corePool, input) {
  const rules = await listPoolRules(corePool, String(input.sourceSlug || 'core'), input.locationId);
  const conn = await connectionFor(operationalPool);
  try {
    await conn.beginTransaction?.();
    await conn.query(
      'UPDATE leads SET contactData=? WHERE id=? AND locationId=?',
      [JSON.stringify(input.record), input.lead.id, input.locationId]
    );
    await applyMarketingChannelStatus(conn, input.lead.id, input.locationId, input.record, rules);
    await conn.commit?.();
  } catch (error) {
    await conn.rollback?.();
    throw error;
  } finally {
    conn.release?.();
  }
  if (input.integrationId) {
    await updateCachedContact(corePool, input.integrationId, input.contactId, input.lead.id, input.record);
  }
  await recordPulse(corePool, input, 'multi_phone_scrub_no_phone');
}

async function persistDncDecision(operationalPool, corePool, input) {
  const provider = input.provider;
  const rules = await listPoolRules(corePool, String(input.sourceSlug || 'core'), input.locationId);
  const conn = await connectionFor(operationalPool);
  try {
    await conn.beginTransaction?.();
    await conn.query(
      'UPDATE leads SET contactData=? WHERE id=? AND locationId=?',
      [JSON.stringify(input.record), input.lead.id, input.locationId]
    );
    const applied = await applyDncScreeningStatus(
      conn,
      input.lead.id,
      input.locationId,
      { state:provider.state, tags:[] },
      rules,
      {
        source:'dncscrub_api',
        resultCode:provider.resultCode,
        reason:provider.reason,
        decisionCategory:provider.decisionCategory,
        reviewRequired:provider.reviewRequired,
        allowBlockedRelease:input.allowBlockedRelease === true,
        expectedDncStatus:String(input.lead.dncStatus || 'pending'),
      }
    );
    if (applied === false) {
      throw phoneError('Lead DNC state changed during phone selection', 'OWL_PHONE_DNC_STATE_CHANGED', 409);
    }
    await applyMarketingChannelStatus(conn, input.lead.id, input.locationId, input.record, rules);
    await conn.commit?.();
  } catch (error) {
    await conn.rollback?.();
    throw error;
  } finally {
    conn.release?.();
  }

  if (input.integrationId) {
    await updateCachedContact(corePool, input.integrationId, input.contactId, input.lead.id, input.record);
  }
  const result = {
    leadId:String(input.lead.id),
    dncStatus:provider.state,
    resultCode:provider.resultCode,
    resultLabel:provider.resultLabel,
    reason:provider.reason,
    decisionCategory:provider.decisionCategory,
    reviewRequired:Boolean(provider.reviewRequired),
    lineType:provider.lineType,
    region:provider.region,
    ebrType:provider.ebrType,
    callingWindow:provider.callingWindow,
    doNotCallToday:provider.doNotCallToday,
    isWirelessOrVoip:provider.isWirelessOrVoip,
    source:'dncscrub_api',
  };
  const crmSync = await syncDncResultsToCrm(corePool, {
    apiKeyId:input.apiKeyId,
    locationId:input.locationId,
    results:[result],
    fetchImpl:input.fetchImpl,
  });
  await recordPulse(corePool, input, input.action);
  return { result, crmSync };
}

async function fetchContact(integration, contactId, fetchImpl) {
  const response = await ghlRequest(integration, 'GET', `/contacts/${encodeURIComponent(contactId)}`, null, fetchImpl);
  return response.contact || response;
}

async function updateContactPhone(integration, contactId, record, selected, fetchImpl) {
  const currentPrimary = extractPhoneCandidates(record).find((item) => item.slot === 'primary');
  const body = {
    phone:selected.raw,
    customFields:[{ id:selected.fieldId, field_value:currentPrimary?.raw || '' }],
  };
  await ghlRequest(integration, 'PUT', `/contacts/${encodeURIComponent(contactId)}`, body, fetchImpl);
}

async function ghlRequest(integration, method, path, body, fetchImpl) {
  if (typeof fetchImpl !== 'function') throw phoneError('GoHighLevel transport is unavailable', 'OWL_PHONE_TRANSPORT_UNAVAILABLE', 503);
  const credential = integrationCredential(integration);
  if (!credential) throw phoneError('GoHighLevel credential is unavailable', 'OWL_PHONE_CREDENTIAL_UNAVAILABLE', 503);
  const base = String(integration.base_url || LEADCONNECTOR_ORIGIN).replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers:{
        Accept:'application/json',
        ...(body ? { 'Content-Type':'application/json' } : {}),
        Authorization:`Bearer ${credential}`,
        Version:'v3',
      },
      ...(body ? { body:JSON.stringify(body) } : {}),
      redirect:'error',
      signal:controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw phoneError(`GoHighLevel returned HTTP ${response.status}`, 'OWL_PHONE_GHL_HTTP_ERROR', 502);
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw phoneError('GoHighLevel phone update timed out', 'OWL_PHONE_GHL_TIMEOUT', 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function swapPrimaryPhone(record, selected) {
  const clone = JSON.parse(JSON.stringify(record || {}));
  const currentPrimary = extractPhoneCandidates(record).find((item) => item.slot === 'primary');
  clone.phone = selected.raw;
  setCustomField(clone, selected.fieldId, currentPrimary?.raw || '');
  if (clone.contact && typeof clone.contact === 'object') clone.contact.phone = selected.raw;
  return clone;
}

function setCustomField(record, fieldId, value) {
  const fields = record.customFields ?? record.custom_fields;
  if (Array.isArray(fields)) {
    const field = fields.find((item) => String(item?.id || item?.fieldId || item?.field_id || '') === fieldId);
    if (field) {
      if (Object.hasOwn(field, 'field_value')) field.field_value = value;
      else field.value = value;
    } else fields.push({ id:fieldId, value });
    return;
  }
  if (fields && typeof fields === 'object') {
    fields[fieldId] = value;
    return;
  }
  record.customFields = [{ id:fieldId, value }];
}

async function updateCachedContact(pool, integrationId, contactId, leadId, record) {
  const payload = JSON.stringify(record);
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  await pool.query(
    `UPDATE crm_contact_records SET payload_json=?,payload_hash=?,last_seen_at=CURRENT_TIMESTAMP
     WHERE integration_id=? AND external_record_id=? AND lead_id=? AND is_current=1`,
    [payload, hash, integrationId, contactId, leadId]
  );
}

async function recordPulse(pool, input, action) {
  try {
    await pool.query(
      `INSERT INTO dnc_pulse_events
         (id,api_key_id,lead_id,external_contact_id,location_id,action)
       VALUES (?,?,?,?,?,?)`,
      [crypto.randomUUID(), input.apiKeyId || null, input.lead.id, input.contactId, input.locationId, action]
    );
  } catch {}
}

function selectionResult(approved, reason, candidates, checked, provider) {
  return {
    approved,
    reason,
    checkedPhoneCount:candidates.length,
    outcomes:checked.map((item) => ({
      slot:item.candidate.slot,
      state:item.provider?.state || 'pending',
      resultCode:item.provider?.resultCode || 'MISSING',
    })),
    resultCode:provider?.resultCode || null,
  };
}

async function connectionFor(pool) {
  if (typeof pool.getConnection === 'function') return pool.getConnection();
  return pool;
}

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) throw phoneError(`${label} is required`, `OWL_PHONE_${label.toUpperCase()}_REQUIRED`, 400);
  return text;
}

function phoneError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

module.exports = {
  ALTERNATIVE_PHONE_FIELD_ID,
  PHONE_3_FIELD_ID,
  scrubAndPromoteDialerPhone,
  aggregateFailure,
  failureReason,
  swapPrimaryPhone,
};
