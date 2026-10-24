const DNC_PULSE_ORIGIN = 'https://webapi.dncscrub.com';
const DNC_PULSE_PATH = '/gohighlvl/contact-scrub.html';
const { integrationCredential, parseJson } = require('./crmIntegrations');

function buildDncPulseUrl({ templateUrl, contactId, locationId }) {
  const selectedContact = cleanId(contactId, 'contactId');
  const selectedLocation = cleanId(locationId, 'locationId');
  let input;
  try {
    input = new URL(String(templateUrl || '').trim());
  } catch {
    throw badRequest('Valid DNCScrub pulse URL is required');
  }
  if (input.origin !== DNC_PULSE_ORIGIN || input.pathname !== DNC_PULSE_PATH || input.username || input.password) {
    throw badRequest('DNCScrub pulse URL is not allowlisted');
  }
  const token = String(input.searchParams.get('t') || '').trim();
  if (!token || token.length > 1024 || /[\x00-\x20]/.test(token)) {
    throw badRequest('DNCScrub pulse URL requires a valid t token');
  }
  const inputContact = input.searchParams.get('contactId');
  const inputLocation = input.searchParams.get('locationId');
  if (inputContact && inputContact !== selectedContact) throw badRequest('Pulse contactId does not match the selected lead');
  if (inputLocation && inputLocation !== selectedLocation) throw badRequest('Pulse locationId does not match the selected lead');

  const output = new URL(DNC_PULSE_PATH, DNC_PULSE_ORIGIN);
  output.searchParams.set('contactId', selectedContact);
  output.searchParams.set('locationId', selectedLocation);
  output.searchParams.set('t', token);
  return output.toString();
}

function buildDncDraftUrl({ contactId, locationId }) {
  const output = new URL(DNC_PULSE_PATH, DNC_PULSE_ORIGIN);
  output.searchParams.set('contactId', cleanId(contactId, 'contactId'));
  output.searchParams.set('locationId', cleanId(locationId, 'locationId'));
  return output.toString();
}

function buildCrmContactUrl({ contactId, locationId }) {
  const selectedContact = cleanId(contactId, 'contactId');
  const selectedLocation = cleanId(locationId, 'locationId');
  const origin = require('../config').getCrmAppOrigin();
  if (!origin) return '';
  return `${origin}/v2/location/${encodeURIComponent(selectedLocation)}` +
    `/contacts/detail/${encodeURIComponent(selectedContact)}`;
}

function cleanId(value, label) {
  const result = String(value || '').trim();
  if (!result || result.length > 191 || /[\x00-\x20/?#&]/.test(result)) {
    throw badRequest(`Valid ${label} is required`);
  }
  return result;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function fetchDncPulseUrlFromNotes(integration, contactId, locationId) {
  const body = await fetchLeadConnectorJson(
    integration,
    `/contacts/${encodeURIComponent(contactId)}/notes`,
    'contact notes'
  );
  const candidates = extractPulseUrls(body);
  for (const candidate of candidates) {
    try {
      return buildDncPulseUrl({ templateUrl: candidate, contactId, locationId });
    } catch {
      // Ignore unrelated or stale links and continue searching notes.
    }
  }
  throw Object.assign(new Error('DNC scrub note link is unavailable for this contact'), { status: 409 });
}

async function fetchLeadConnectorContact(integration, contactId) {
  const body = await fetchLeadConnectorJson(
    integration,
    `/contacts/${encodeURIComponent(contactId)}`,
    'contact'
  );
  const contact = body?.contact || body;
  if (!contact || typeof contact !== 'object' || Array.isArray(contact)) {
    throw Object.assign(new Error('LeadConnector contact response is invalid'), { status: 502 });
  }
  return contact;
}

async function fetchLeadConnectorJson(integration, pathname, resourceLabel) {
  if (!integration || integration.provider !== 'leadconnector-pit') {
    throw Object.assign(new Error(`LeadConnector source is required to read ${resourceLabel}`), { status: 409 });
  }
  const credential = integrationCredential(integration);
  if (!credential) throw Object.assign(new Error('LeadConnector integration has no stored credential'), { status: 409 });
  const base = new URL(integration.base_url);
  if (base.origin !== 'https://services.leadconnectorhq.com') {
    throw Object.assign(new Error('LeadConnector source origin is invalid'), { status: 409 });
  }
  const url = new URL(pathname, base.origin);
  const config = parseJson(integration.config_json);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `${integration.auth_scheme || 'Bearer'} ${credential}`.trim(),
        Version: String(config.version || '2021-07-28'),
      },
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    const message = error.name === 'AbortError'
      ? `LeadConnector ${resourceLabel} request timed out`
      : `LeadConnector ${resourceLabel} request failed`;
    throw Object.assign(new Error(message), { status: 502 });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? `LeadConnector PIT cannot read ${resourceLabel}; verify the contact read scope`
      : `LeadConnector ${resourceLabel} request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status === 404 ? 409 : 502 });
  }
  return response.json();
}

function extractPulseUrls(value, output = []) {
  if (typeof value === 'string') {
    const decoded = value.replace(/&amp;/g, '&');
    const matches = decoded.match(/https:\/\/webapi\.dncscrub\.com\/gohighlvl\/contact-scrub\.html\?[^\s<>"']+/g) || [];
    for (const match of matches) output.push(match.replace(/[),.;]+$/, ''));
  } else if (Array.isArray(value)) {
    for (const item of value) extractPulseUrls(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) extractPulseUrls(item, output);
  }
  return output;
}

module.exports = {
  DNC_PULSE_ORIGIN,
  DNC_PULSE_PATH,
  buildDncPulseUrl,
  buildDncDraftUrl,
  buildCrmContactUrl,
  fetchDncPulseUrlFromNotes,
  fetchLeadConnectorContact,
  extractPulseUrls,
};
