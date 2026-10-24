/**
 * Call Center terminal outcomes: CRM tag guards + OWL lifecycle writes.
 *
 * OWL pool sync: not_interested, scheduled (requested appointment), invalid
 * (incorrect number / no longer at address / wrong number), disconnected
 * (non-working phone), and legacy dnc.
 * Won / Lost / DNQ stay tag-only (recheck skip).
 */
const { getPoolRule } = require('./leadPools');

/** Outcomes / aliases that write OWL lifecycle pools. */
const OUTCOME_TO_POOL = Object.freeze({
  not_interested: 'not_interested',
  dnc: 'dnc',
  scheduled: 'scheduled',
  requested_appointment: 'scheduled',
  invalid: 'invalid',
  incorrect_number: 'invalid',
  wrong_number: 'invalid',
  no_longer_at_address: 'invalid',
  disconnected: 'disconnected',
  non_working_number: 'disconnected',
  phone_disconnected: 'disconnected',
  disconnected_number: 'disconnected',
  // Sales terminals — owner preserved for won, cleared for lost/dnq.
  closed_won: 'closed_won',
  converted_sale: 'closed_won',
  won: 'closed_won',
  closed_lost: 'closed_lost',
  lost: 'closed_lost',
  closed_dnq: 'closed_dnq',
  dnq: 'closed_dnq',
});

/**
 * Canonical CRM tags that must never receive a fresh cc-recheck signal.
 * Includes smart/varying aliases for sales terminals (no OWL write yet).
 */
const TERMINAL_SKIP_TAGS = Object.freeze(new Set([
  'cc-not-interested',
  'cc-dnc',
  'cc-scheduled',
  'cc-invalid',
  'cc-disconnected',
  'cc-converted-sale',
  'cc-closed-won',
  'cc-won',
  'cc-closed-lost',
  'cc-lost',
  'cc-closed-dnq',
  'cc-dnq',
  'cc-dial-blocked',
]));

/** Normalized forms that map onto TERMINAL_SKIP_TAGS after canonicalizeTag. */
const TERMINAL_SKIP_ALIASES = Object.freeze({
  'not-interested': 'cc-not-interested',
  not_interested: 'cc-not-interested',
  'closed-not-interested': 'cc-not-interested',
  dnc: 'cc-dnc',
  'do-not-call': 'cc-dnc',
  do_not_call: 'cc-dnc',
  scheduled: 'cc-scheduled',
  'requested-appointment': 'cc-scheduled',
  requested_appointment: 'cc-scheduled',
  invalid: 'cc-invalid',
  'incorrect-number': 'cc-invalid',
  incorrect_number: 'cc-invalid',
  'wrong-number': 'cc-invalid',
  wrong_number: 'cc-invalid',
  'no-longer-at-address': 'cc-invalid',
  no_longer_at_address: 'cc-invalid',
  disconnected: 'cc-disconnected',
  'non-working-number': 'cc-disconnected',
  non_working_number: 'cc-disconnected',
  'phone-disconnected': 'cc-disconnected',
  phone_disconnected: 'cc-disconnected',
  'disconnected-number': 'cc-disconnected',
  disconnected_number: 'cc-disconnected',
  'converted-sale': 'cc-converted-sale',
  convertedsale: 'cc-converted-sale',
  'closed-won': 'cc-closed-won',
  closed_won: 'cc-closed-won',
  won: 'cc-won',
  'closed-lost': 'cc-closed-lost',
  closed_lost: 'cc-closed-lost',
  lost: 'cc-lost',
  'closed-dnq': 'cc-closed-dnq',
  closed_dnq: 'cc-closed-dnq',
  dnq: 'cc-dnq',
  'dial-blocked': 'cc-dial-blocked',
  dial_blocked: 'cc-dial-blocked',
});

function canonicalizeTag(tag) {
  let value = String(tag || '').trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^#+/, '');
  // collapse separators to hyphen for alias lookup
  const hyphenated = value.replace(/[_\s]+/g, '-');
  if (TERMINAL_SKIP_TAGS.has(hyphenated)) return hyphenated;
  if (TERMINAL_SKIP_TAGS.has(value)) return value;
  if (TERMINAL_SKIP_ALIASES[hyphenated]) return TERMINAL_SKIP_ALIASES[hyphenated];
  if (TERMINAL_SKIP_ALIASES[value]) return TERMINAL_SKIP_ALIASES[value];
  // accept cc- prefix variants already in set
  if (!hyphenated.startsWith('cc-') && TERMINAL_SKIP_TAGS.has(`cc-${hyphenated}`)) {
    return `cc-${hyphenated}`;
  }
  return hyphenated.startsWith('cc-') ? hyphenated : value;
}

function isTerminalSkipTag(tag) {
  const canonical = canonicalizeTag(tag);
  return TERMINAL_SKIP_TAGS.has(canonical);
}

function terminalSkipReason(tag) {
  const canonical = canonicalizeTag(tag);
  if (!TERMINAL_SKIP_TAGS.has(canonical)) return null;
  if (canonical === 'cc-not-interested') return 'not_interested';
  if (canonical === 'cc-dnc') return 'dnc';
  if (canonical === 'cc-scheduled') return 'scheduled';
  if (canonical === 'cc-invalid') return 'invalid';
  if (canonical === 'cc-disconnected') return 'disconnected';
  if (canonical === 'cc-converted-sale' || canonical === 'cc-closed-won' || canonical === 'cc-won') {
    return 'converted_sale';
  }
  if (canonical === 'cc-closed-lost' || canonical === 'cc-lost') return 'closed_lost';
  if (canonical === 'cc-closed-dnq' || canonical === 'cc-dnq') return 'dnq';
  if (canonical === 'cc-dial-blocked') return 'dial_blocked';
  return 'terminal_tag';
}

/**
 * Map a call outcome (or pool key) to an OWL pool key.
 * Won / Lost / DNQ intentionally return null (workflow tags only).
 * Incorrect Number / Wrong Number / No Longer At Address → invalid.
 * Disconnected / Non-Working Number / Phone Disconnected → disconnected.
 */
function mapOutcomeToPoolKey(outcome) {
  const raw = String(outcome || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!raw) return null;
  if (OUTCOME_TO_POOL[raw]) return OUTCOME_TO_POOL[raw];
  // accept pool keys directly when they are in the write set
  if ([...new Set(Object.values(OUTCOME_TO_POOL))].includes(raw)) return raw;
  // tag-shaped inputs
  const fromTag = canonicalizeTag(outcome);
  if (fromTag === 'cc-not-interested') return 'not_interested';
  if (fromTag === 'cc-dnc') return 'dnc';
  if (fromTag === 'cc-scheduled') return 'scheduled';
  if (fromTag === 'cc-invalid') return 'invalid';
  if (fromTag === 'cc-disconnected') return 'disconnected';
  if (fromTag === 'cc-closed-won' || fromTag === 'cc-won' || fromTag === 'cc-converted-sale') return 'closed_won';
  if (fromTag === 'cc-closed-lost' || fromTag === 'cc-lost') return 'closed_lost';
  if (fromTag === 'cc-closed-dnq' || fromTag === 'cc-dnq') return 'closed_dnq';
  return null;
}

/**
 * Apply a call-center terminal outcome to OWL lifecycle (status + ownership policy).
 * Does not set dncStatus=blocked for rep-reported DNC (registry semantics stay separate).
 */
async function applyCallCenterOutcome(corePool, input = {}) {
  const locationId = String(input.locationId || '').trim();
  const contactId = String(input.contactId || '').trim();
  const sourceSlug = String(input.sourceSlug || 'core').trim() || 'core';
  const operationalPool = input.operationalPool || corePool;
  if (!locationId) {
    throw Object.assign(new Error('locationId is required'), { status: 400, code: 'LOCATION_REQUIRED' });
  }
  if (!contactId) {
    throw Object.assign(new Error('contactId is required'), { status: 400, code: 'CONTACT_ID_REQUIRED' });
  }

  const poolKey = mapOutcomeToPoolKey(input.outcome || input.poolKey);
  if (!poolKey) {
    throw Object.assign(
      new Error(
        'Outcome is not an OWL-synced call-center terminal ' +
        '(use not_interested, scheduled/requested_appointment, ' +
        'invalid/incorrect_number/wrong_number/no_longer_at_address, ' +
        'disconnected/non_working_number/phone_disconnected, ' +
        'closed_won/converted_sale, closed_lost, closed_dnq, or dnc)'
      ),
      { status: 400, code: 'OUTCOME_NOT_OWL_SYNCED' }
    );
  }

  const rule = await getPoolRule(corePool, sourceSlug, locationId, poolKey);
  if (!rule || !rule.isEnabled) {
    throw Object.assign(new Error(`Lifecycle pool not found or disabled: ${poolKey}`), {
      status: 404,
      code: 'POOL_NOT_FOUND',
    });
  }

  let lead;
  try {
    lead = await resolveLeadForOutcome(corePool, operationalPool, locationId, contactId);
  } catch (error) {
    const canHydrate = error?.code === 'CONTACT_NOT_FOUND' && input.apiKeyId && input.integration;
    if (!canHydrate) throw error;
    const { hydrateContactOnMiss } = require('./owlContactSync');
    await hydrateContactOnMiss({
      corePool,
      operationalPool,
      apiKeyId:input.apiKeyId,
      locationId,
      contactId,
      dataSourceSlug:input.dataSourceSlug || input.sourceSlug || 'dial',
      integration:input.integration,
      fetchImpl:input.fetchImpl || global.fetch,
    });
    lead = await resolveLeadForOutcome(corePool, operationalPool, locationId, contactId);
  }
  const beforeStatus = String(lead.status || '');
  const destinationStatus = String(rule.destinationStatus);
  const beforeAssigned = lead.assignedTo == null ? null : String(lead.assignedTo);

  if (beforeStatus === destinationStatus) {
    const ownerMatches = rule.assignmentPolicy === 'clear'
      ? beforeAssigned == null
      : true;
    if (ownerMatches || rule.assignmentPolicy === 'preserve') {
      return {
        leadId: String(lead.id),
        contactId,
        poolKey: rule.poolKey,
        destinationStatus,
        beforeStatus,
        afterStatus: beforeStatus,
        beforeAssignedTo: beforeAssigned,
        afterAssignedTo: beforeAssigned,
        changed: false,
        assignmentPolicy: rule.assignmentPolicy,
      };
    }
  }

  let afterAssignedTo = beforeAssigned;
  if (rule.assignmentPolicy === 'clear') {
    await operationalPool.query(
      'UPDATE leads SET status = ?, assignedTo = NULL WHERE id = ? AND locationId = ?',
      [destinationStatus, lead.id, locationId]
    );
    afterAssignedTo = null;
  } else {
    // preserve (require_user unused for these terminals — keep owner as-is)
    await operationalPool.query(
      'UPDATE leads SET status = ? WHERE id = ? AND locationId = ?',
      [destinationStatus, lead.id, locationId]
    );
  }

  return {
    leadId: String(lead.id),
    contactId,
    poolKey: rule.poolKey,
    destinationStatus,
    beforeStatus,
    afterStatus: destinationStatus,
    beforeAssignedTo: beforeAssigned,
    afterAssignedTo,
    changed: true,
    assignmentPolicy: rule.assignmentPolicy,
  };
}

/**
 * Resolve contactId → lead without full compliance contact merge (lazy path for outcomes).
 */
async function resolveLeadForOutcome(corePool, operationalPool, locationId, contactId) {
  const [links] = await corePool.query(
    `SELECT lead_id FROM lead_source_links
     WHERE location_id=? AND external_record_id=?
     ORDER BY last_seen_at DESC LIMIT 1`,
    [locationId, contactId]
  );
  const leadId = links[0]?.lead_id || contactId;
  const [rows] = await operationalPool.query(
    `SELECT id, locationId, status, assignedTo, dncStatus
     FROM leads WHERE id=? AND locationId=? LIMIT 1`,
    [leadId, locationId]
  );
  if (!rows[0]) {
    throw Object.assign(new Error('Contact is not available in the Dialer'), {
      status: 404,
      code: 'CONTACT_NOT_FOUND',
    });
  }
  return rows[0];
}

module.exports = {
  OUTCOME_TO_POOL,
  TERMINAL_SKIP_TAGS,
  TERMINAL_SKIP_ALIASES,
  canonicalizeTag,
  isTerminalSkipTag,
  terminalSkipReason,
  mapOutcomeToPoolKey,
  applyCallCenterOutcome,
  resolveLeadForOutcome,
};
