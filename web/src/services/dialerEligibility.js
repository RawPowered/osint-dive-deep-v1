const { findRuleForStatus, getPoolRule } = require('./leadPools');
const { reconcileScheduledAppointment } = require('./calendarAppointments');
const { resolveComplianceLead, screenLeadCandidates } = require('./marketingCompliance');
const { classifyMarketingChannels } = require('./crmImporter');
const { scrubAndPromoteDialerPhone } = require('./dialerPhoneSelection');
const { hydrateContactOnMiss } = require('./owlContactSync');

function decision(eligible, reason, lead, extra = {}) {
  return {
    eligible,
    reason,
    leadId:String(lead.id),
    contactId:String(extra.contactId || lead.id),
    assignedTo:lead.assignedTo ? String(lead.assignedTo) : null,
    serviceType:lead.serviceType ? String(lead.serviceType) : null,
    ...extra,
  };
}

function resolveDialerServicePool(lead) {
  const record = lead?.contactData && typeof lead.contactData === 'object' ? lead.contactData : {};
  const rawTags = record.tags ?? record.tag ?? record.contactTags ?? record.contact?.tags ?? [];
  const tags = Array.isArray(rawTags) ? rawTags : String(rawTags || '').split(',');
  const values = [
    ...tags,
    record.Keywords,
    record.keywords,
    record.service_type,
    record.serviceType,
    record['Service Needed'],
    record.serviceNeeded,
    lead?.serviceType,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  const matches = (pattern) => values.some((value) => pattern.test(value));

  // Specific room pools first, then roofing (before mold — "roof leak" must not match mold),
  // then mold (explicit water/mold wins over ambiguous renovat), then solar, then the
  // generic Home Addition catch-all (remodel/renovat/home renovation without a room prefix).
  if (matches(/\bkitchen\b/)) return 'kitchen';
  if (matches(/\bbath(?:room)?\b/)) return 'bathroom';
  if (matches(/\b(?:roof|roofing|shingle|siding)\b/)) return 'roofing';
  if (matches(/\b(?:mold|water\s+damage|flood|leak\s+repair)\b/)) return 'mold';
  if (matches(/\bsolar\b|\bpanel\s+upgrade\b/)) return 'solar';
  if (matches(/\b(?:home\s+)?addition\b|\bhome\s+(?:remodel|renovat)|\bremodel\b|\brenovat/i)) return 'home_addition';
  return null;
}

function contactRecord(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function currentCallOutcome(lead) {
  const record = contactRecord(lead?.contactData);
  const nested = record.contact && typeof record.contact === 'object' ? record.contact : {};
  const values = [
    record.Call_outcome,
    record.call_outcome,
    record.callOutcome,
    record['Call Outcome'],
    nested.Call_outcome,
    nested.call_outcome,
    nested.callOutcome,
    nested['Call Outcome'],
  ];
  const selected = values.find((value) => value != null && String(value).trim());
  return String(selected || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function isScheduledCallOutcome(value) {
  return value === 'scheduled' || value === 'requested_appointment' || value === 'appointment';
}

async function releaseStaleScheduledLifecycle(controlPool, operationalPool, controlSourceSlug, lead) {
  const available = await getPoolRule(controlPool, controlSourceSlug, lead.locationId, 'available');
  if (!available || !available.isEnabled || !available.destinationStatus) return null;
  if (available.assignmentPolicy === 'clear') {
    await operationalPool.query(
      'UPDATE leads SET status=?,assignedTo=NULL WHERE id=? AND locationId=?',
      [available.destinationStatus, lead.id, lead.locationId]
    );
  } else {
    await operationalPool.query(
      'UPDATE leads SET status=? WHERE id=? AND locationId=?',
      [available.destinationStatus, lead.id, lead.locationId]
    );
  }
  return {
    fromPool:'scheduled',
    toPool:available.poolKey,
    destinationStatus:available.destinationStatus,
    reason:'calendar_clear_and_call_outcome_clear',
  };
}

function resolvePhoneMarketingStatus(lead) {
  const storedStatus = String(lead.phoneMarketingStatus || 'pending');
  if (storedStatus !== 'pending') {
    return { status:storedStatus, storedStatus, source:'stored' };
  }

  const channels = classifyMarketingChannels(lead.contactData);
  if (channels.phoneStatus === 'blocked' || channels.phoneStatus === 'unavailable') {
    return { status:channels.phoneStatus, storedStatus, source:'current_crm_contact' };
  }
  if (channels.phoneStatus === 'pending' && String(lead.dncStatus || 'pending') === 'clean') {
    return { status:'available', storedStatus, source:'canonical_dnc_and_current_phone' };
  }
  return { status:'pending', storedStatus, source:'stored' };
}

async function evaluateDialerEligibility(pool, input = {}) {
  const locationId = String(input.locationId || '').trim();
  const contactId = String(input.contactId || '').trim();
  const requireAssignment = input.requireAssignment === true;
  const enforceMarketingHours = input.enforceMarketingHours !== false;
  // OWL control-plane policy is intentionally anchored to the Legacy/core store.
  // The operational lead row may still be read from a granted external source such as `dial`.
  const controlSourceSlug = String(input.controlSourceSlug || 'core').trim().toLowerCase() || 'core';
  if (!locationId) throw Object.assign(new Error('locationId is required'), { status:400, code:'LOCATION_REQUIRED' });
  if (!contactId) throw Object.assign(new Error('contactId is required'), { status:400, code:'CONTACT_ID_REQUIRED' });

  const resolved = await resolveLeadWithHydration(pool, {
    ...input,
    locationId,
    contactId,
    operationalPool:input.operationalPool || pool,
  });
  let lead = resolved.lead;
  let base = {
    contactId,
    hydration:resolved.hydration,
    assignmentRequired:requireAssignment,
    marketingHoursEnforced:enforceMarketingHours,
    assignmentState:lead.assignedTo ? 'assigned' : 'unassigned',
    servicePool:resolveDialerServicePool(lead),
    controlSourceSlug,
  };
  if (requireAssignment && !lead.assignedTo) return decision(false, 'not_assigned', lead, base);

  let phoneSelection = null;
  if (input.scrubAllPhones === true) {
    phoneSelection = await scrubAndPromoteDialerPhone(pool, {
      apiKeyId:input.apiKeyId,
      locationId,
      contactId,
      lead,
      sourceSlug:input.sourceSlug,
      operationalPool:input.operationalPool || pool,
      integration:input.integration,
      fetchImpl:input.fetchImpl,
      requireAlternatePhone:input.requireAlternatePhone === true,
    });
    if (!phoneSelection.approved) {
      return decision(false, phoneSelection.reason, lead, { ...base, phoneSelection });
    }
    lead = await resolveComplianceLead(pool, {
      locationId, contactId, operationalPool:input.operationalPool || pool,
    });
    base = {
      ...base,
      assignmentState:lead.assignedTo ? 'assigned' : 'unassigned',
      servicePool:resolveDialerServicePool(lead),
      phoneSelection,
    };
  }

  let lifecycle = await findRuleForStatus(pool, controlSourceSlug, locationId, lead.status);
  let calendar = null;
  let lifecycleRelease = null;
  if (lifecycle?.poolKey === 'scheduled') {
    const callOutcome = currentCallOutcome(lead);
    try {
      calendar = await reconcileScheduledAppointment(pool, {
        apiKeyId:input.apiKeyId,
        lead,
        now:input.now instanceof Date ? input.now : new Date(input.now || Date.now()),
        fetchImpl:input.fetchImpl,
      });
    } catch (error) {
      if (error?.code !== 'CALENDAR_VERIFICATION_UNAVAILABLE' && error?.code !== 'CALENDAR_RATE_LIMITED') throw error;
      return decision(false, 'calendar_verification_unavailable', lead, {
        ...base,
        lifecyclePool:lifecycle.poolKey,
        callOutcome:callOutcome || null,
        calendar:{ checked:false, scheduled:false },
        nextEligibleAt:error.compliance?.nextEligibleAt || null,
      });
    }
    if (calendar.checked && !calendar.scheduled && !isScheduledCallOutcome(callOutcome)) {
      lifecycleRelease = await releaseStaleScheduledLifecycle(
        pool, input.operationalPool || pool, controlSourceSlug, lead
      );
      if (lifecycleRelease) {
        lead = await resolveComplianceLead(pool, {
          locationId, contactId, operationalPool:input.operationalPool || pool,
        });
        base = {
          ...base,
          assignmentState:lead.assignedTo ? 'assigned' : 'unassigned',
          servicePool:resolveDialerServicePool(lead),
          lifecycleRelease,
        };
        lifecycle = await findRuleForStatus(pool, controlSourceSlug, locationId, lead.status);
      }
    }
    if (lifecycle?.poolKey === 'scheduled') {
      return decision(false, calendar.scheduled ? 'appointment_scheduled' : 'not_in_dialer_entry_pool', lead, {
        ...base,
        lifecyclePool:lifecycle.poolKey,
        callOutcome:callOutcome || null,
        calendar:{
          checked:Boolean(calendar.checked),
          scheduled:Boolean(calendar.scheduled),
          source:calendar.source || null,
          appointment:calendar.appointment || null,
        },
        blockCategory:'lifecycle',
        hardBlock:false,
        assignmentChecked:false,
      });
    }
  }
  if (lifecycle?.poolKey === 'dnc_pending') {
    return decision(false, 'dnc_pending', lead, { ...base, lifecyclePool:lifecycle.poolKey });
  }
  if (lifecycle?.poolKey === 'dnc') {
    return decision(false, 'dnc_blocked', lead, { ...base, lifecyclePool:lifecycle.poolKey });
  }
  if (lifecycle?.poolKey === 'no_phone') {
    return decision(false, 'phone_unavailable', lead, { ...base, lifecyclePool:lifecycle.poolKey });
  }
  const eligibleLifecycle = lifecycle && (lifecycle.poolKey === 'assigned' || lifecycle.isAssignable);
  if (!eligibleLifecycle) {
    return decision(false, requireAssignment ? 'not_in_assigned_pool' : 'not_in_dialer_entry_pool', lead, {
      ...base,
      lifecyclePool:lifecycle?.poolKey || null,
      blockCategory:'lifecycle',
      hardBlock:false,
      assignmentChecked:false,
    });
  }
  if (String(lead.dncStatus || 'pending') !== 'clean') {
    return decision(false, `dnc_${String(lead.dncStatus || 'pending')}`, lead, base);
  }
  const phoneMarketing = resolvePhoneMarketingStatus(lead);
  if (phoneMarketing.status !== 'available') {
    return decision(false, `phone_${phoneMarketing.status}`, lead, {
      ...base,
      phoneMarketingStatus:phoneMarketing.status,
      phoneMarketingStatusStored:phoneMarketing.storedStatus,
      phoneMarketingStatusSource:phoneMarketing.source,
    });
  }

  if (!calendar) {
    try {
      calendar = await reconcileScheduledAppointment(pool, {
        apiKeyId:input.apiKeyId,
        lead,
        now:input.now instanceof Date ? input.now : new Date(input.now || Date.now()),
        fetchImpl:input.fetchImpl,
      });
    } catch (error) {
      if (error?.code !== 'CALENDAR_VERIFICATION_UNAVAILABLE' && error?.code !== 'CALENDAR_RATE_LIMITED') throw error;
      return decision(false, 'calendar_verification_unavailable', lead, {
        ...base,
        calendar:{ checked:false, scheduled:false },
        nextEligibleAt:error.compliance?.nextEligibleAt || null,
      });
    }
  }
  if (!calendar.checked) {
    return decision(false, calendar.reason || 'calendar_verification_unavailable', lead, {
      ...base,
      calendar:{
        checked:false,
        scheduled:false,
        serviceLookup:calendar.serviceLookup || null,
      },
    });
  }
  if (calendar.scheduled) {
    return decision(false, 'appointment_scheduled', lead, {
      ...base,
      calendar:{ checked:true, scheduled:true, source:calendar.source || null, appointment:calendar.appointment || null },
    });
  }

  const screened = await screenLeadCandidates(pool, {
    apiKeyId:input.apiKeyId,
    locationId,
    userId:lead.assignedTo ? String(lead.assignedTo) : null,
    leads:[lead],
    now:input.now instanceof Date ? input.now : new Date(input.now || Date.now()),
    enforceMarketingHours,
  });
  if (!screened.eligible.length) {
    const compliance = screened.blocked[0]?.compliance || { allowed:false, reason:'marketing_compliance_block' };
    return decision(false, compliance.reason || 'marketing_compliance_block', lead, {
      ...base,
      calendar:{ checked:true, scheduled:false, source:calendar.source || null },
      compliance,
    });
  }
  return decision(true, 'eligible', lead, {
    ...base,
    lifecyclePool:lifecycle.poolKey,
    phoneMarketingStatus:phoneMarketing.status,
    phoneMarketingStatusStored:phoneMarketing.storedStatus,
    phoneMarketingStatusSource:phoneMarketing.source,
    calendar:{ checked:true, scheduled:false, source:calendar.source || null },
    compliance:{ allowed:true, reason:'eligible' },
  });
}

async function resolveLeadWithHydration(pool, input) {
  try {
    return {
      lead:await resolveComplianceLead(pool, {
        locationId:input.locationId,
        contactId:input.contactId,
        operationalPool:input.operationalPool || pool,
      }),
      hydration:null,
    };
  } catch (error) {
    if (error?.code !== 'CONTACT_NOT_FOUND') throw error;
    const hydration = await hydrateContactOnMiss({
      corePool:pool,
      operationalPool:input.operationalPool || pool,
      apiKeyId:input.apiKeyId,
      locationId:input.locationId,
      contactId:input.contactId,
      dataSourceSlug:input.sourceSlug || 'dial',
      integration:input.integration,
      integrationId:input.integrationId,
      fetchImpl:input.fetchImpl || global.fetch,
    });
    const lead = await resolveComplianceLead(pool, {
      locationId:input.locationId,
      contactId:input.contactId,
      operationalPool:input.operationalPool || pool,
    });
    return { lead, hydration };
  }
}

module.exports = {
  evaluateDialerEligibility, resolvePhoneMarketingStatus, resolveDialerServicePool,
  currentCallOutcome, isScheduledCallOutcome, releaseStaleScheduledLifecycle,
  resolveLeadWithHydration,
};
