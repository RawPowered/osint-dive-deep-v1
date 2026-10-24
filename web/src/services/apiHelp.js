const { SCHEMA_VERSION } = require('../config');
const packageJson = require('../../package.json');
const { getInstanceIdentity } = require('../instanceIdentity');

function command(id, category, method, path, summary, options = {}) {
  return {
    id,
    category,
    method,
    path,
    summary,
    access: options.access || 'Valid DiveDeep Bearer API key',
    required: options.required || {},
    anyOf: options.anyOf || [],
    optional: options.optional || {},
    example: options.example || {},
    notes: options.notes || [],
  };
}

const COMMANDS = [
  command('help.index', 'help', 'GET', '/api/help', 'List and search machine API commands', {
    optional: { query: ['q', 'category', 'format'] },
    example: { query: { format: 'text' } },
  }),
  command('help.command', 'help', 'GET', '/api/help/{command}', 'Get requirements for one command', {
    required: { path: ['command'] },
    optional: { query: ['format'] },
    example: { path: { command: 'leads.assigned' } },
  }),
  command('help.validate', 'help', 'POST', '/api/help/validate', 'Validate a proposed API request without executing it', {
    required: { body: ['command'] },
    optional: { body: ['path', 'query', 'body'] },
    example: {
      body: {
        command: 'leads.assigned',
        query: { locationId: 'LOCATION_ID', userId: 'USER_ID' },
      },
    },
  }),
  command('help.openapi', 'help', 'GET', '/api/help/openapi.json', 'Get an OpenAPI 3.1 document for machine ingestion'),

  command('system.location.get', 'system', 'GET', '/api/db/sync', 'Read durable location state', {
    required: { query: ['locationId'] },
    example: { query: { locationId: 'LOCATION_ID' } },
  }),
  command('system.location.put', 'system', 'POST', '/api/db/sync', 'Create or replace durable location state', {
    required: { body: ['locationId', 'payload'] },
    example: { body: { locationId: 'LOCATION_ID', payload: { setting: 'value' } } },
  }),
  command('system.config', 'system', 'GET', '/api/system/config', 'Read the bootstrap location snapshot'),
  command('system.operatorStatus', 'system', 'GET', '/api/system/status', 'Check the current Dialer operator session', {
    access: 'Public when no session is supplied; authenticated with Authorization: Operator SESSION_TOKEN',
    notes: ['An omitted token returns HTTP 200 with authenticated=false. An invalid or expired supplied token returns HTTP 401.'],
  }),
  command('system.operatorAdmin', 'system', 'GET', '/api/system/has-admin', 'Check whether the authenticated operator has administrator access', {
    access: 'Authorization: Operator SESSION_TOKEN or X-Operator-Token',
    notes: ['Returns only authenticated and hasAdmin booleans; role names and password material are never returned.'],
  }),
  command('system.operatorLogout', 'system', 'POST', '/api/system/logout', 'Revoke the current Dialer operator session', {
    access: 'Authorization: Operator SESSION_TOKEN or X-Operator-Token',
  }),
  command('song.scripts', 'song', 'GET', '/api/song/scripts', 'Search published scripts available to the authenticated Dialer', {
    access: 'DiveDeep Bearer key with CRM read grant plus X-Operator-Token',
    required: { headers:['X-Operator-Token'] },
    optional: { query:['locationId', 'serviceType', 'languageCode', 'q', 'limit'] },
    example: { query:{ serviceType:'Roofing', languageCode:'es-US', q:'initial outreach', limit:25 } },
    notes: [
      'Returns published summaries only; draft graphs, runtime nodes, author identities, and version history are excluded.',
      'Use the returned scriptId with serviceType on song.runtime or song.runtimeResolve. The default service assignment is listed first.',
      'limit is clamped to 1-50. Location and operator identity come from the operator session.',
    ],
  }),
  command('song.runtime', 'song', 'GET', '/api/song/runtime', 'Load the published script assigned to a service pool', {
    access: 'DiveDeep Bearer key with CRM read grant plus X-Operator-Token',
    required: { headers:['X-Operator-Token'], query:['serviceType'] },
    optional: { query:['locationId', 'leadId', 'scriptId', 'languageCode'] },
    example: { query:{ serviceType:'Roofing', languageCode:'es-US', scriptId:'SCRIPT_ID', leadId:'LEAD_ID' } },
    notes: [
      'Location and operator identity come from the operator session. An optional locationId is only a cross-check.',
      'Returns an immutable compiled published graph; drafts, author identities, editor positions, and version history are excluded.',
      'When leadId is supplied, it must be assigned to the operator and runtime.variableValues contains only fields declared by the published script.',
      'When scriptId is omitted, SONG resolves the default published assignment for serviceType.',
      'When languageCode is supplied without scriptId, SONG resolves the default published assignment for that service and language.',
    ],
  }),
  command('song.runtimeResolve', 'song', 'POST', '/api/song/runtime/resolve', 'Load a published script and resolve its declared lead and dynamic variables', {
    access: 'DiveDeep Bearer key with CRM read grant plus X-Operator-Token',
    required: { headers:['X-Operator-Token'], body:['serviceType'] },
    optional: { body:['locationId', 'leadId', 'scriptId', 'languageCode', 'runtimeContext'] },
    example: { body:{ serviceType:'Roofing', languageCode:'es-US', scriptId:'SCRIPT_ID', leadId:'LEAD_ID', runtimeContext:{ greeting:'Buenas tardes', localTime:'2:15 PM', weatherSummary:'Despejado, 78 F', appointmentType:'inspection' } } },
    notes: [
      'runtimeContext accepts only greeting, localTime, weatherSummary, and appointmentType.',
      'When leadId is supplied, it must be assigned to the operator. variableValues contains only variables declared by the published script.',
    ],
  }),
  command('song.event', 'song', 'POST', '/api/song/events', 'Record one script runtime event', {
    access: 'DiveDeep Bearer key with CRM read grant plus X-Operator-Token',
    required: { headers:['X-Operator-Token'], body:['scriptId', 'versionId', 'eventType'] },
    optional: { body:['leadId', 'nodeId', 'branchId', 'outcome', 'metadata'] },
    example: { body:{ scriptId:'SCRIPT_ID', versionId:'VERSION_ID', nodeId:'greeting', eventType:'node_viewed' } },
    notes: ['Event metadata is capped at 4 KB and password, secret, token, authorization, cookie, and API-key fields are removed.'],
  }),
  command('services.list', 'leads', 'GET', '/api/service-pools', 'List authoritative Dialer service pools, CRM tag mappings, and calendar assignments', {
    required: { query: ['locationId'] },
    example: { query: { locationId: 'LOCATION_ID' } },
    notes: ['Use mappings instead of browser-local tag mapping state.'],
  }),
  command('services.classify', 'leads', 'POST', '/api/service-pools/classify', 'Resolve CRM tags to a Dialer service pool', {
    required: { body: ['locationId', 'tags'] },
    example: { body: { locationId: 'LOCATION_ID', tags: ['roof-repair', 'priority'] } },
  }),
  command('calendars.list', 'calendar', 'GET', '/api/calendars', 'List enabled service-to-calendar assignments for a location', {
    required: { query: ['locationId'] },
    example: { query: { locationId: 'LOCATION_ID' } },
    notes: ['Use defaultCalendarId unless the user selects another ID from calendarIds.'],
  }),
  command('calendars.resolve', 'calendar', 'GET', '/api/calendars/resolve', 'Resolve allowed and default calendar IDs by service or lead', {
    required: { query: ['locationId'] },
    anyOf: [{ source: 'query', fields: ['serviceType', 'leadId'], label: 'serviceType or leadId' }],
    example: { query: { locationId: 'LOCATION_ID', leadId: 'LEAD_ID' } },
  }),
  command('users.list', 'users', 'GET', '/api/users', 'List users for a location', {
    required: { query: ['locationId'] },
    example: { query: { locationId: 'LOCATION_ID' } },
    notes: ['Returns only id, locationId, username, and displayName.'],
  }),
  command('users.get', 'users', 'GET', '/api/users/{userId}', 'Get one user', {
    required: { path: ['userId'], query: ['locationId'] },
    example: { path: { userId: 'USER_ID' }, query: { locationId: 'LOCATION_ID' } },
  }),
  command('users.create', 'users', 'POST', '/api/users', 'Create or upsert one user', {
    required: { body: ['id', 'locationId'] },
    optional: { body: ['username', 'email', 'phone', 'role', 'crmUserId', 'crmUserName', 'password'] },
    example: { body: { id: 'USER_ID', locationId: 'LOCATION_ID', username: 'agent' } },
  }),
  command('users.update', 'users', 'PUT', '/api/users/{userId}', 'Update one user', {
    required: { path: ['userId'], body: ['locationId'] },
    optional: { body: ['username', 'email', 'phone', 'role', 'crmUserId', 'crmUserName'] },
    example: { path: { userId: 'USER_ID' }, body: { locationId: 'LOCATION_ID', role: 'agent' } },
  }),
  command('users.bulk', 'users', 'POST', '/api/users/bulk', 'Create or upsert users in a location', {
    required: { body: ['locationId', 'users'] },
    example: { body: { locationId: 'LOCATION_ID', users: [{ id: 'USER_ID', username: 'agent' }] } },
  }),
  command('users.login', 'users', 'POST', '/api/users/login', 'Authenticate a Dialer user', {
    required: { body: ['locationId'] },
    anyOf: [
      { source: 'body', fields: ['userId', 'username', 'email'], label: 'one user identity' },
      { source: 'body', fields: ['password'], label: 'plaintext password' },
    ],
    example: { body: { locationId: 'LOCATION_ID', userId: 'USER_ID', password: 'PASSWORD' } },
    notes: [
      'The response contains a minimal user identity and a short-lived opaque session token; it never contains password hashes, role names, CRM IDs, email, or phone.',
      'Use Authorization: Operator SESSION_TOKEN for /api/system/status and /api/system/has-admin. Continue using the DiveDeep Bearer key for machine API routes.',
    ],
  }),
  command('users.resetPassword', 'users', 'POST', '/api/users/reset-password', 'Set or reset a user password', {
    required: { body: ['locationId'] },
    anyOf: [
      { source: 'body', fields: ['userId', 'username', 'email'], label: 'one user identity' },
      { source: 'body', fields: ['password'], label: 'plaintext password' },
    ],
    example: { body: { locationId: 'LOCATION_ID', userId: 'USER_ID', password: 'NEW_PASSWORD' } },
  }),
  command('users.password', 'users', 'PUT', '/api/users/{userId}/password', 'Update a user password', {
    required: { path: ['userId'], body: ['locationId', 'password'] },
    example: { path: { userId: 'USER_ID' }, body: { locationId: 'LOCATION_ID', password: 'NEW_PASSWORD' } },
  }),

  command('leads.list', 'leads', 'GET', '/api/leads', 'List and search leads for a location', {
    access: 'DiveDeep Bearer key with CRM read grant plus X-Operator-Token; returns only leads assigned to that operator',
    required: { headers: ['X-Operator-Token'], query: ['locationId'] },
    optional: { query: ['status', 'dncStatus', 'serviceType', 'assignedTo', 'search', 'limit', 'offset'] },
    example: { query: { locationId: 'LOCATION_ID', limit: 100 } },
    notes: ['Lead records contain only leadId, contactId, firstName, lastName, phone, city, state, latitude, and longitude.'],
  }),
  command('leads.assigned', 'leads', 'GET', '/api/leads/assigned', 'Restore active leads assigned to one user', {
    access: 'DiveDeep Bearer key with CRM read grant plus X-Operator-Token bound to locationId and userId',
    required: { headers: ['X-Operator-Token'], query: ['locationId', 'userId'] },
    optional: { query: ['limit', 'offset'] },
    example: { query: { locationId: 'LOCATION_ID', userId: 'USER_ID' } },
    notes: [
      'An empty queue is HTTP 200 with leads: [].',
      'Lead records contain only leadId, contactId, firstName, lastName, phone, city, state, latitude, and longitude.',
    ],
  }),
  command('leads.get', 'leads', 'GET', '/api/leads/{leadId}', 'Get one lead', {
    access: 'DiveDeep Bearer key with CRM read grant plus X-Operator-Token; the lead must be assigned to that operator',
    required: { headers: ['X-Operator-Token'], path: ['leadId'], query: ['locationId'] },
    example: { path: { leadId: 'LEAD_ID' }, query: { locationId: 'LOCATION_ID' } },
  }),
  command('leads.bulk', 'leads', 'POST', '/api/leads/bulk', 'Add leads without overwriting duplicate IDs', {
    required: { body: ['locationId', 'leads'] },
    example: { body: { locationId: 'LOCATION_ID', leads: [{ id: 'LEAD_ID', serviceType: 'Roofing', contactData: {} }] } },
  }),
  command('leads.pull', 'leads', 'POST', '/api/leads/pull', 'Atomically assign available leads to a user', {
    access: 'DiveDeep Bearer key with manage-leads grant plus X-Operator-Token bound to locationId and userId',
    required: { headers: ['X-Operator-Token'], body: ['locationId', 'userId', 'serviceType'] },
    optional: { body: ['count'] },
    example: { body: { locationId: 'LOCATION_ID', userId: 'USER_ID', serviceType: 'Roofing', count: 10 } },
    notes: [
      'Only leads with dncStatus=clean are assignable.',
      'Returned leads are restricted to leadId, contactId, firstName, lastName, phone, city, state, latitude, and longitude.',
      'The user must have submitted a schedule for the current Monday-Sunday America/New_York week. Missing or draft schedules return 409 WEEKLY_SCHEDULE_REQUIRED before assignment.',
      'Candidates must fall within the company 8:00 AM-7:00 PM lead-local marketing window. State-inconsistent CRM timezones are rejected; Florida uses coordinate resolution or the safe Eastern/Central overlap. Florida candidates also require fresh CRM call history and fewer than three outbound attempts in the rolling prior 24 hours.',
    ],
  }),
  command('leads.callAuthorizeContact', 'leads', 'POST', '/api/leads/call-attempts/authorize', 'Authorize one outbound call from a contact ID', {
    access: 'DiveDeep Bearer key plus X-Operator-Token bound to locationId and userId',
    required: { headers:['X-Operator-Token'], body:['contactId'] },
    example: { body:{ contactId:'CONTACT_ID' } },
    notes: [
      'Preferred Dialer method. API key, location, user, jurisdiction, and timezone are resolved server-side; send only contactId.',
      'DiveDeep resolves the internal lead and complete CRM record server-side, reconciles configured service calendars, then checks assignment, weekly schedule, DNC, local marketing hours, and Florida attempt limits.',
      'A current appointment routes the lead to Scheduled and returns 409 APPOINTMENT_ALREADY_SCHEDULED. Calendar verification failures return 503 and never silently authorize a call.',
      'Success returns success, allowed, and authorizationId. A denial returns a compact code, reason, optional appointment summary, and optional nextEligibleAt.',
    ],
  }),
  command('leads.bookingContext', 'leads', 'POST', '/api/leads/booking-context', 'Resolve operator-scoped calendar prefill fields', {
    access: 'DiveDeep Bearer key plus X-Operator-Token; the lead must be assigned to that operator',
    required: { headers:['X-Operator-Token'], body:['contactId'] },
    example: { body:{ contactId:'CONTACT_ID' } },
    notes: [
      'Returns the service calendar IDs plus first name, last name, name, email, and phone for iframe injection.',
      'The response is no-store and Sentinel pseudonymizes PII in encrypted forensic evidence. CRM credentials are never returned.',
    ],
  }),
  command('leads.callAuthorize', 'leads', 'POST', '/api/leads/{leadId}/call-attempts/authorize', 'Compatibility alias for outbound call authorization', {
    access: 'DiveDeep Bearer key plus X-Operator-Token',
    required: { headers:['X-Operator-Token'], path:['leadId'] },
    example: { path:{ leadId:'CONTACT_ID' } },
    notes: [
      'Compatibility alias. New Dialer clients should use POST /api/leads/call-attempts/authorize with body.contactId.',
      'For Florida leads this atomically reserves the attempt and returns 409 MARKETING_COMPLIANCE_BLOCK when three attempts already exist in the rolling prior 24 hours.',
    ],
  }),
  command('leads.dncPulse', 'leads', 'POST', '/api/leads/{leadId}/dnc-pulse', 'Create an allowlisted DNCScrub browser pulse for a lead', {
    access: 'DiveDeep Bearer key with manage-leads grant for the location integration',
    required: { path: ['leadId'], body: ['locationId'] },
    optional: { body: ['url'] },
    example: {
      path: { leadId: 'CONTACT_ID' },
      body: {
        locationId: 'LOCATION_ID',
        url: 'https://webapi.dncscrub.com/gohighlvl/contact-scrub.html?contactId=CONTACT_ID&locationId=LOCATION_ID&t=VENDOR_TOKEN',
      },
    },
    notes: [
      'Returns a browser_navigation URL; it does not fetch or execute the vendor page server-side.',
      'When url is omitted, DiveDeep searches the granted LeadConnector contact notes for the scrub link.',
      'The DNCScrub t token is validated but never stored in the pulse audit event.',
    ],
  }),
  command('leads.dncRefresh', 'leads', 'POST', '/api/leads/{leadId}/dnc-refresh', 'Refresh one lead DNC state from current LeadConnector tags', {
    access: 'DiveDeep Bearer key with manage-leads grant for the location integration',
    required: { path: ['leadId'], body: ['locationId'] },
    example: { path: { leadId: 'LEAD_ID' }, body: { locationId: 'LOCATION_ID' } },
    notes: ['Call after the DNCScrub browser pulse; pending remains non-assignable.'],
  }),
  command('leads.status', 'leads', 'PATCH', '/api/leads/{leadId}/status', 'Set a controlled lead status', {
    access: 'DiveDeep Bearer key plus X-Operator-Token; the lead must be assigned to that operator',
    required: { headers: ['X-Operator-Token'], path: ['leadId'], body: ['locationId', 'status'] },
    optional: { body: ['lastContacted'] },
    example: { path: { leadId: 'LEAD_ID' }, body: { locationId: 'LOCATION_ID', status: 'contacted' } },
  }),
  command('leads.release', 'leads', 'POST', '/api/leads/{leadId}/release', 'Return an assigned lead to the pool', {
    access: 'DiveDeep Bearer key plus X-Operator-Token; the lead must be assigned to that operator',
    required: { headers: ['X-Operator-Token'], path: ['leadId'], body: ['locationId'] },
    example: { path: { leadId: 'LEAD_ID' }, body: { locationId: 'LOCATION_ID' } },
  }),

  command('sessions.get', 'sessions', 'GET', '/api/sessions/workspace', 'Restore an operator workspace', {
    required: { query: ['locationId', 'userId'] },
    example: { query: { locationId: 'LOCATION_ID', userId: 'USER_ID' } },
  }),
  command('sessions.put', 'sessions', 'PUT', '/api/sessions/workspace', 'Save an operator workspace', {
    required: { body: ['locationId', 'userId', 'state'] },
    optional: { body: ['clientTabId', 'expectedRevision', 'leaseSeconds'] },
    example: { body: { locationId: 'LOCATION_ID', userId: 'USER_ID', state: {} } },
  }),
  command('sessions.delete', 'sessions', 'DELETE', '/api/sessions/workspace', 'Delete an operator workspace', {
    anyOf: [{ source: 'queryOrBody', fields: ['locationId', 'userId'], label: 'locationId and userId', mode: 'all' }],
    example: { query: { locationId: 'LOCATION_ID', userId: 'USER_ID' } },
  }),
  command('sessions.heartbeat', 'sessions', 'POST', '/api/sessions/workspace/heartbeat', 'Renew a workspace lease', {
    required: { headers: ['X-Operator-Token'], body: ['locationId', 'userId'] },
    optional: { body: ['clientTabId', 'leaseSeconds'] },
    example: { body: { locationId: 'LOCATION_ID', userId: 'USER_ID' } },
    notes: ['The operator session must match body.locationId and body.userId. Each successful heartbeat records one metadata-only verified activity minute for schedule adherence reporting.'],
  }),
  command('sessions.resolveUrl', 'sessions', 'GET', '/api/sessions/workspace/resolve-url', 'Resolve an allowlisted CRM workspace URL', {
    required: { query: ['locationId'] },
    anyOf: [{ source: 'query', fields: ['contactId', 'path'], label: 'contactId or path' }],
    example: { query: { locationId: 'LOCATION_ID', contactId: 'CONTACT_ID' } },
  }),

  command('crm.integrations', 'crm', 'GET', '/api/crm/integrations', 'List CRM integrations granted to this key', {
    notes: ['The DiveDeep key selects a grant; encrypted LeadConnector PIT credentials remain server-side.'],
  }),
  command('crm.test', 'crm', 'POST', '/api/crm/integrations/{integrationId}/test', 'Test an upstream CRM integration', {
    access: 'DiveDeep Bearer key with import grant for the integration',
    required: { path: ['integrationId'] },
    example: { path: { integrationId: 'INTEGRATION_ID' } },
  }),
  command('crm.fields', 'crm', 'GET', '/api/crm/integrations/{integrationId}/fields', 'List payload fields and provider custom-field definitions discovered during CRM import', {
    access: 'DiveDeep Bearer key with read grant for the integration',
    required: { path: ['integrationId'] },
    example: { path: { integrationId: 'INTEGRATION_ID' } },
  }),
  command('crm.contactRecords', 'crm', 'GET', '/api/crm/integrations/{integrationId}/contact-records', 'Page through complete current CRM contact payloads', {
    access: 'DiveDeep Bearer key with read grant for the integration',
    required: { path: ['integrationId'] },
    optional: { query: ['limit', 'afterId', 'includeInactive'] },
    example: { path: { integrationId: 'INTEGRATION_ID' }, query: { limit: 100, afterId: 'CONTACT_ID' } },
    notes: ['Follow nextAfterId until it is null. includeInactive=true also returns contacts absent from the latest successful full sync.'],
  }),
  command('crm.import.start', 'crm', 'POST', '/api/crm/integrations/{integrationId}/imports', 'Queue an exhaustive full or resumable incremental CRM import', {
    access: 'DiveDeep Bearer key with import grant for the integration',
    required: { path: ['integrationId'] },
    optional: { body: ['dryRun', 'full', 'pageSize', 'maxPages', 'defaultServiceType'] },
    example: { path: { integrationId: 'INTEGRATION_ID' }, body: { full: true, pageSize: 100 } },
    notes: ['Direct LeadConnector sync uses POST /contacts/search with 100-record pages. CRM uses compound cursors. full=true continues until the upstream total is exhausted and ignores maxPages.'],
  }),
  command('crm.import.status', 'crm', 'GET', '/api/crm/imports/{runId}', 'Read CRM import status and counters', {
    access: 'DiveDeep Bearer key with read grant for the run integration',
    required: { path: ['runId'] },
    example: { path: { runId: 'RUN_ID' } },
  }),
  command('crm.import.history', 'crm', 'GET', '/api/crm/integrations/{integrationId}/imports', 'List CRM import history', {
    access: 'DiveDeep Bearer key with read grant for the integration',
    required: { path: ['integrationId'] },
    optional: { query: ['limit'] },
    example: { path: { integrationId: 'INTEGRATION_ID' }, query: { limit: 25 } },
  }),
  command('crm.import.conflicts', 'crm', 'GET', '/api/crm/imports/{runId}/conflicts', 'Read CRM import conflicts', {
    access: 'DiveDeep Bearer key with read grant for the run integration',
    required: { path: ['runId'] },
    example: { path: { runId: 'RUN_ID' } },
  }),
  command('crm.backfill', 'crm', 'POST', '/api/crm/integrations/{integrationId}/backfill', 'Link existing leads without modifying them', {
    access: 'DiveDeep Bearer key with import grant for the integration',
    required: { path: ['integrationId'] },
    example: { path: { integrationId: 'INTEGRATION_ID' } },
  }),

  command('appointments.create', 'performance', 'POST', '/api/appointments', 'Record an appointment', {
    required: { body: ['locationId', 'leadId', 'userId', 'appointmentDate'] },
    optional: { body: ['calendarId', 'serviceType'] },
    example: { body: { locationId: 'LOCATION_ID', leadId: 'LEAD_ID', userId: 'USER_ID', calendarId: 'CALENDAR_ID', appointmentDate: '2026-07-12T15:00:00Z' } },
    notes: ['Omitted calendarId resolves to the service default. Supplied IDs must belong to that service pool.'],
  }),
  command('rewards.create', 'performance', 'POST', '/api/rewards', 'Record a reward', {
    required: { body: ['locationId', 'userId', 'leadId', 'amount', 'type'] },
    example: { body: { locationId: 'LOCATION_ID', userId: 'USER_ID', leadId: 'LEAD_ID', amount: 25, type: 'appointment' } },
  }),
  command('users.stats', 'performance', 'GET', '/api/users/{userId}/stats', 'Read user performance totals', {
    required: { path: ['userId'], query: ['locationId'] },
    example: { path: { userId: 'USER_ID' }, query: { locationId: 'LOCATION_ID' } },
  }),
  command('schedules.get', 'schedules', 'GET', '/api/users/{userId}/schedule', 'Read one user current-week schedule and submission state', {
    required: { path: ['userId'], query: ['locationId'] },
    example: { path: { userId: 'USER_ID' }, query: { locationId: 'LOCATION_ID' } },
  }),
  command('schedules.put', 'schedules', 'PUT', '/api/users/{userId}/schedule', 'Save a current-week schedule draft or save and submit', {
    required: { path: ['userId'], body: ['locationId', 'scheduleData'] },
    optional: { body: ['submit'] },
    example: { path: { userId: 'USER_ID' }, body: { locationId: 'LOCATION_ID', scheduleData: { days: { monday: { start: '09:00', end: '17:00', breakMinutes: 30 } } }, submit: true } },
    notes: ['Saving with submit=false creates a draft and locks lead pulls until submission.'],
  }),
  command('schedules.submit', 'schedules', 'POST', '/api/users/{userId}/schedule/submit', 'Submit the saved current-week schedule', {
    required: { path: ['userId'], body: ['locationId'] },
    example: { path: { userId: 'USER_ID' }, body: { locationId: 'LOCATION_ID' } },
  }),
  command('schedules.list', 'schedules', 'GET', '/api/schedules', 'List schedules for a location', {
    required: { query: ['locationId'] },
    example: { query: { locationId: 'LOCATION_ID' } },
  }),
  command('workSessions.list', 'schedules', 'GET', '/api/users/{userId}/work-sessions', 'List current-week actual work sessions', {
    required: { path: ['userId'], query: ['locationId'] },
    example: { path: { userId: 'USER_ID' }, query: { locationId: 'LOCATION_ID' } },
  }),
  command('workSessions.start', 'schedules', 'POST', '/api/users/{userId}/work-sessions/start', 'Clock a dialer user into work', {
    required: { path: ['userId'], body: ['locationId'] },
    optional: { body: ['source'] },
    example: { path: { userId: 'USER_ID' }, body: { locationId: 'LOCATION_ID', source: 'dialer' } },
    notes: ['A user may have only one active work session per location.'],
  }),
  command('workSessions.stop', 'schedules', 'POST', '/api/users/{userId}/work-sessions/{sessionId}/stop', 'Clock a dialer user out of work', {
    required: { path: ['userId', 'sessionId'], body: ['locationId'] },
    example: { path: { userId: 'USER_ID', sessionId: 'SESSION_ID' }, body: { locationId: 'LOCATION_ID' } },
  }),

  command('divedeep.templates', 'divedeep', 'GET', '/api/divedeep/templates', 'List reusable privacy request templates'),
  command('divedeep.sources', 'divedeep', 'GET', '/api/divedeep/sources', 'List available privacy source adapters'),
  command('divedeep.profiles.create', 'divedeep', 'POST', '/api/divedeep/profiles', 'Create an authorized protected profile and queue its initial scan', {
    required: { body: ['displayName', 'requesterName', 'requesterEmail', 'authorizationAffirmed', 'identifiers'] },
    optional: { body: ['authorizationType', 'requesterRole', 'authorizationDate', 'authorizationExpiresAt', 'authorizationScope', 'jurisdictionCountry', 'jurisdictionRegion', 'scanCadenceDays', 'defaultVisibilityAction', 'enqueueInitialScan'] },
    example: { body: { displayName: 'Protected Person', requesterName: 'Protected Person', requesterEmail: 'person@example.com', authorizationAffirmed: true, authorizationType: 'self', identifiers: [{ type: 'email', value: 'person@example.com', isPrimary: true }] } },
    notes: ['Identity values and generated request content are encrypted at rest. Sentinel records metadata but omits DiveDeep request and response bodies.'],
  }),
  command('divedeep.profiles.list', 'divedeep', 'GET', '/api/divedeep/profiles', 'List protected profiles for this API-key tenant', {
    optional: { query: ['status', 'limit'] },
  }),
  command('divedeep.profiles.get', 'divedeep', 'GET', '/api/divedeep/profiles/{profileId}', 'Read one protected profile', {
    required: { path: ['profileId'] },
  }),
  command('divedeep.identifiers.create', 'divedeep', 'POST', '/api/divedeep/profiles/{profileId}/identifiers', 'Add an encrypted identity identifier', {
    required: { path: ['profileId'], body: ['type', 'value'] },
    optional: { body: ['label', 'isPrimary'] },
  }),
  command('divedeep.policies.upsert', 'divedeep', 'PUT', '/api/divedeep/profiles/{profileId}/policies', 'Set remove, monitor, preserve, ignore, or review behavior', {
    required: { path: ['profileId'], body: ['action'] },
    optional: { body: ['scopeType', 'scopeValue', 'priority'] },
  }),
  command('divedeep.scans.enqueue', 'divedeep', 'POST', '/api/divedeep/profiles/{profileId}/scans', 'Queue an idempotent privacy scan job', {
    required: { path: ['profileId'] },
    optional: { body: ['jobType', 'idempotencyKey', 'payload', 'maxAttempts', 'availableAt'] },
  }),
  command('divedeep.jobs.claim', 'divedeep', 'POST', '/api/divedeep/jobs/claim', 'Lease the next scan job for a tenant worker', {
    required: { body: ['workerId'] },
    optional: { body: ['leaseSeconds'] },
    notes: ['The lease token is returned once and must be supplied to the completion endpoint.'],
  }),
  command('divedeep.jobs.complete', 'divedeep', 'POST', '/api/divedeep/jobs/{jobId}/complete', 'Complete, fail, or retry a leased scan job', {
    required: { path: ['jobId'], body: ['leaseToken', 'status'] },
    optional: { body: ['workerId', 'resultSummary', 'error', 'errorCode', 'retryAfterSeconds'] },
  }),
  command('divedeep.exposures.upsert', 'divedeep', 'POST', '/api/divedeep/profiles/{profileId}/exposures', 'Create or refresh a discovered privacy exposure', {
    required: { path: ['profileId'], body: ['listingUrl'] },
    optional: { body: ['sourceId', 'sourceName', 'domain', 'listingIdentifier', 'subjectIdentifier', 'identifierType', 'matchConfidence', 'contentCategory', 'evidenceRef', 'evidenceSha256', 'metadata', 'discoveredAt'] },
  }),
  command('divedeep.exposures.list', 'divedeep', 'GET', '/api/divedeep/exposures', 'List tenant exposures', {
    optional: { query: ['profileId', 'status', 'limit'] },
  }),
  command('divedeep.exposures.status', 'divedeep', 'PATCH', '/api/divedeep/exposures/{exposureId}/status', 'Review or classify an exposure', {
    required: { path: ['exposureId'], body: ['status'] },
  }),
  command('divedeep.cases.create', 'divedeep', 'POST', '/api/divedeep/exposures/{exposureId}/cases', 'Draft a privacy request from a confirmed exposure', {
    required: { path: ['exposureId'] },
    optional: { body: ['templateKey', 'requestType', 'requestActions', 'recipientEmail', 'deliveryMethod', 'legalBasis', 'legalBasisPreset', 'responseDueAt', 'reviewApproved', 'idempotencyKey', 'notes'] },
  }),
  command('divedeep.cases.transition', 'divedeep', 'PATCH', '/api/divedeep/cases/{caseId}/status', 'Apply a controlled privacy case state transition', {
    required: { path: ['caseId'], body: ['state'] },
    optional: { body: ['expectedRevision', 'confirmationReference', 'notes', 'responseDueAt'] },
  }),
  command('divedeep.cases.verify', 'divedeep', 'POST', '/api/divedeep/cases/{caseId}/verifications', 'Record removal verification and update exposure state', {
    required: { path: ['caseId'], body: ['result'] },
    optional: { body: ['sourceUrl', 'notes', 'checkedAt', 'evidenceRef', 'evidenceSha256'] },
  }),
  command('divedeep.profile.export', 'divedeep', 'GET', '/api/divedeep/profiles/{profileId}/export', 'Export a complete tenant-scoped privacy case packet', {
    required: { path: ['profileId'] },
  }),

  command('telemetry.error', 'telemetry', 'POST', '/api/errors', 'Record a client error with resolved user identity', {
    required: { body: ['id', 'locationId'] },
    optional: { body: ['userId', 'username', 'email', 'type', 'message', 'details', 'url'] },
    example: { body: { id: 'ERROR_ID', locationId: 'LOCATION_ID', userId: 'USER_ID', type: 'api', message: 'Request failed' } },
  }),
  command('telemetry.log', 'telemetry', 'POST', '/api/logs', 'Record a client authentication event', {
    required: { body: ['id', 'locationId'] },
    optional: { body: ['userId', 'username', 'email', 'status', 'userAgent'] },
    example: { body: { id: 'LOG_ID', locationId: 'LOCATION_ID', userId: 'USER_ID', status: 'success' } },
  }),
  command('telemetry.errors.list', 'telemetry', 'GET', '/api/errors', 'List recent client errors for a location', {
    required: { query: ['locationId'] },
    example: { query: { locationId: 'LOCATION_ID' } },
  }),
  command('telemetry.errors.clear', 'telemetry', 'DELETE', '/api/errors', 'Clear client errors for a location', {
    required: { query: ['locationId'] },
    example: { query: { locationId: 'LOCATION_ID' } },
  }),
  command('telemetry.logs.list', 'telemetry', 'GET', '/api/logs', 'List recent client auth logs for a location', {
    required: { query: ['locationId'] },
    example: { query: { locationId: 'LOCATION_ID' } },
  }),

  command('sql.connections', 'sql', 'GET', '/api/sql/connections', 'List SQL connections and grants for this key', {
    access: 'Valid DiveDeep Bearer key; returns only grants for that key',
  }),
  command('sql.tables', 'sql', 'GET', '/api/sql/{slug}/tables', 'List granted tables for a SQL connection', {
    access: 'DiveDeep Bearer key with connection grant and introspection permission',
    required: { path: ['slug'] },
    example: { path: { slug: 'reporting-db' } },
  }),
  command('sql.columns', 'sql', 'GET', '/api/sql/{slug}/tables/{table}/columns', 'Describe columns on a granted SQL table', {
    access: 'DiveDeep Bearer key with table grant and introspection permission',
    required: { path: ['slug', 'table'] },
    example: { path: { slug: 'reporting-db', table: 'customers' } },
  }),
  command('sql.rows.list', 'sql', 'GET', '/api/sql/{slug}/{table}', 'List rows from a granted SQL table', {
    access: 'DiveDeep Bearer key with SELECT grant for the table',
    required: { path: ['slug', 'table'] },
    optional: { query: ['limit', 'offset', 'orderBy', 'orderDir', 'filter[column]'] },
    example: { path: { slug: 'reporting-db', table: 'customers' }, query: { limit: 50 } },
  }),
  command('sql.row.get', 'sql', 'GET', '/api/sql/{slug}/{table}/{primaryKey}', 'Read one row from a granted SQL table', {
    access: 'DiveDeep Bearer key with SELECT grant for the table',
    required: { path: ['slug', 'table', 'primaryKey'] },
  }),
  command('sql.row.insert', 'sql', 'POST', '/api/sql/{slug}/{table}', 'Insert into a granted SQL table', {
    access: 'DiveDeep Bearer key with INSERT grant for the table',
    required: { path: ['slug', 'table'], body: ['*'] },
    notes: ['Send a non-empty JSON object whose keys are granted table columns.'],
  }),
  command('sql.row.update', 'sql', 'PATCH', '/api/sql/{slug}/{table}/{primaryKey}', 'Update a granted SQL row', {
    access: 'DiveDeep Bearer key with UPDATE grant for the table',
    required: { path: ['slug', 'table', 'primaryKey'], body: ['*'] },
    notes: ['Send a non-empty JSON object whose keys are granted table columns.'],
  }),
  command('sql.row.delete', 'sql', 'DELETE', '/api/sql/{slug}/{table}/{primaryKey}', 'Delete a granted SQL row', {
    access: 'DiveDeep Bearer key with DELETE grant for the table',
    required: { path: ['slug', 'table', 'primaryKey'] },
  }),
];

function getCommand(id) {
  const item = COMMANDS.find((candidate) => candidate.id.toLowerCase() === String(id || '').toLowerCase());
  return item ? materializeCommand(item) : null;
}

function publicApiPath(suffix = '') {
  const base = getInstanceIdentity().publicApiBasePath;
  const rest = String(suffix || '').replace(/^\/+/, '');
  return rest ? `${base}/${rest}` : base;
}

function materializeCommand(item) {
  const path = item.path.replace(/^\/api(?=\/|$)/, getInstanceIdentity().publicApiBasePath);
  const materializeText = (value) => String(value)
    .replace(/\/api(?=\/|\b)/g, getInstanceIdentity().publicApiBasePath)
    .replace(/DiveDeep\s+/gi, 'instance ');
  return {
    ...item,
    path,
    access: materializeText(item.access || '').replace(/^instance\s+/i, ''),
    notes: (item.notes || []).map(materializeText),
  };
}

function listCommands() {
  return COMMANDS.map(materializeCommand);
}

function catalogMeta(baseUrl) {
  const identity = getInstanceIdentity();
  return {
    name: identity.apiDisplayName,
    version: packageJson.version,
    schemaVersion: SCHEMA_VERSION,
    baseUrl,
    apiBasePath: identity.publicApiBasePath,
    authentication: {
      type: 'http',
      scheme: 'bearer',
      format: `${identity.apiKeyPrefix}...`,
      header: 'Authorization: Bearer $INSTANCE_API_KEY',
      operatorSession: 'X-Operator-Token: $OPERATOR_SESSION_TOKEN on Dialer lead routes',
      operatorLogin: `POST ${publicApiPath('users/login')}; read session.token from the JSON response`,
      browserCookieFallback: 'Use credentials: include on login and subsequent requests',
    },
    help: {
      list: publicApiPath('help'),
      text: `${publicApiPath('help')}?format=text`,
      command: publicApiPath('help/{command}'),
      validate: publicApiPath('help/validate'),
      openapi: publicApiPath('help/openapi.json'),
    },
  };
}

module.exports = { COMMANDS, listCommands, getCommand, publicApiPath, catalogMeta };
