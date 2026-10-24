const crypto = require('crypto');
const { getPool } = require('../db/pool');

const GRAPH_SCHEMA_VERSION = 1;
const MAX_GRAPH_BYTES = 512 * 1024;
const MAX_NODES = 100;
const MAX_BRANCHES_PER_NODE = 12;
const MAX_TRANSITIONS = 100;
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VARIABLE_RE = /^[a-z][a-zA-Z0-9_.]{0,63}$/;
const NODE_TYPES = new Set([
  'prompt', 'question', 'qualification', 'value', 'objection', 'action',
  'appointment', 'voicemail', 'disposition', 'confirmation', 'end',
]);
const TERMINAL_TYPES = new Set(['end', 'disposition', 'voicemail']);
const ACTION_TYPES = new Set([
  'none', 'authorize_call', 'set_disposition', 'book_appointment', 'release_lead',
  'set_variable', 'capture_input', 'emit_event', 'complete_script',
]);
const CONDITION_OPERATORS = new Set([
  'equals', 'not_equals', 'contains', 'not_contains', 'exists', 'not_exists',
  'greater_than', 'less_than', 'in',
]);
const EVENT_TYPES = new Set([
  'script_started', 'node_viewed', 'branch_selected', 'action_started',
  'action_completed', 'action_failed', 'script_completed', 'script_abandoned',
]);
const FORBIDDEN_METADATA_KEY = /password|secret|token|authorization|cookie|api.?key/i;

const DEFAULT_VARIABLES = [
  variable('firstName', 'First name', 'lead.firstName'),
  variable('lastName', 'Last name', 'lead.lastName'),
  variable('phone', 'Phone', 'lead.phone'),
  variable('city', 'City', 'lead.city'),
  variable('state', 'State', 'lead.state'),
  variable('agentName', 'Agent name', 'operator.displayName'),
];

const STANDARD_VARIABLE_CATALOG = [
  catalog('firstName', 'First name', 'lead.firstName', 'Contact', 'string'),
  catalog('lastName', 'Last name', 'lead.lastName', 'Contact', 'string'),
  catalog('fullName', 'Full name', 'lead.fullName', 'Contact', 'string'),
  catalog('phone', 'Phone', 'lead.phone', 'Contact', 'phone'),
  catalog('email', 'Email', 'lead.email', 'Contact', 'email'),
  catalog('companyName', 'Business name', 'lead.companyName', 'Contact', 'string'),
  catalog('website', 'Website', 'lead.website', 'Contact', 'url'),
  catalog('dateOfBirth', 'Date of birth', 'lead.dateOfBirth', 'Contact', 'date'),
  catalog('contactType', 'Contact type', 'lead.type', 'Contact', 'string'),
  catalog('address', 'Street address', 'lead.address', 'Geography', 'string'),
  catalog('city', 'City', 'lead.city', 'Geography', 'string'),
  catalog('state', 'State', 'lead.state', 'Geography', 'string'),
  catalog('postalCode', 'Postal code', 'lead.postalCode', 'Geography', 'string'),
  catalog('country', 'Country', 'lead.country', 'Geography', 'string'),
  catalog('timezone', 'Timezone', 'lead.timezone', 'Geography', 'string'),
  catalog('latitude', 'Latitude', 'lead.latitude', 'Geography', 'number'),
  catalog('longitude', 'Longitude', 'lead.longitude', 'Geography', 'number'),
  catalog('contactSource', 'Contact source', 'lead.source', 'Marketing', 'string'),
  catalog('serviceType', 'Service pool', 'lead.serviceType', 'Marketing', 'string'),
  catalog('tags', 'Tags', 'lead.tags', 'Marketing', 'list'),
  catalog('agentName', 'Agent display name', 'operator.displayName', 'Operator', 'string'),
  catalog('agentUsername', 'Agent username', 'operator.username', 'Operator', 'string'),
  catalog('agentUserId', 'Agent user ID', 'operator.userId', 'Operator', 'string'),
  catalog('agentCrmName', 'Agent CRM name', 'operator.crmUserName', 'Operator', 'string'),
  catalog('runtimeValue', 'Runtime value', 'runtime.value', 'Runtime', 'string'),
];

function variable(key, label, source) {
  return { key, label, source, defaultValue:'' };
}

function catalog(key, label, source, group, dataType, fieldId = null) {
  return { key, label, source, group, dataType, fieldId };
}

function vibeServiceToGraph(input = {}) {
  const serviceType = requiredText(input.serviceType || input.name, 128, 'Service type');
  const scripts = input.mainScript && typeof input.mainScript === 'object' ? input.mainScript : {};
  const reason = cleanText(input.reason || `information about ${serviceType}`, 500);
  const concernRows = Array.isArray(input.concerns) ? input.concerns.slice(0, 12) : [];
  const outcomes = (Array.isArray(input.outcomes) && input.outcomes.length
    ? input.outcomes : ['Appointment Booked', 'Follow Up', 'Not Interested', 'Wrong Number', 'No Answer'])
    .slice(0, 12).map((value) => cleanText(typeof value === 'string' ? value : value?.label, 128)).filter(Boolean);
  const nodes = [
    vibeNode('identity', 'prompt', 'Identity', 'Confirm you are speaking with the homeowner',
      vibePrompt(scripts.identity, `{{dynamicGreeting}}, is this {{firstName}}?`, { path:'mainScript.identity' }),
      promptHelper(scripts.identity, 'Wait for confirmation.'), 360, 60, [], [
        vibeBranch('confirmed', 'Yes, confirmed', 'confirmed', 'reason'),
        vibeBranch('wrong_person', 'No / wrong person', 'wrong_person', 'wrong_number'),
      ]),
    vibeNode('reason', 'prompt', 'Reason for call', 'Explain who is calling and why',
      vibePrompt(scripts.reason, `Great, this is {{agentName}} with DiveDeep. I'm calling because you requested ${reason} here in {{city}}.`, { path:'mainScript.reason', reason }),
      promptHelper(scripts.reason, ''), 360, 260, [], [
        vibeBranch('continue', 'Yes, continue', 'continue', 'address'),
        vibeBranch('not_interested', 'Not interested / did not request', 'not_interested', 'not_interested'),
      ]),
    vibeNode('address', 'question', 'Service address', 'Ask for the current service address',
      vibePrompt(scripts.address, `What is the current service address for the home we're discussing?`, { path:'mainScript.address' }),
      promptHelper(scripts.address, 'Type the address exactly as stated.'), 360, 460,
      [{ type:'capture_input', config:{ key:'serviceAddress', inputType:'address', label:'Current Service Address', required:true } }],
      [vibeBranch('address_confirmed', 'Address confirmed', 'confirmed', 'diagnosis')]),
    vibeNode('diagnosis', 'qualification', 'Diagnosis', 'Identify the primary concern',
      vibePrompt(scripts.diagnosis, 'What made you reach out?', { path:'mainScript.diagnosis' }),
      promptHelper(scripts.diagnosis, 'Select the response that best matches the customer concern.'), 360, 660, [],
      concernRows.length ? concernRows.map((concern, index) => concernBranch(concern, index))
        : [vibeBranch('continue', 'Continue', 'continue', 'trust')]),
    vibeNode('trust', 'value', 'Trust', 'Build trust and pivot to inspection',
      vibePrompt(scripts.trust, `DiveDeep is licensed, bonded, and insured. The {{appointmentType}} gives you a clear understanding of the project and practical options before you make a decision.`, { path:'mainScript.trust' }),
      promptHelper(scripts.trust, ''), 360, 860, [], [vibeBranch('continue', 'Continue to appointment', 'continue', 'appointment')]),
    vibeNode('appointment', 'appointment', 'Appointment', 'Book the inspection or consultation',
      vibePrompt(scripts.appointment, 'I have a couple of {{appointmentType}} times available. Which works better for you?', { path:'mainScript.appointment' }),
      promptHelper(scripts.appointment, 'Use the calendar assigned to this service pool.'), 360, 1060,
      [{ type:'book_appointment', config:{ useServicePoolCalendar:true } }], [
        vibeBranch('booked', 'Appointment booked', 'appointment_booked', 'confirmation', null,
          [{ type:'set_variable', config:{ key:'appointmentBooked', value:true } }]),
        vibeBranch('not_booked', 'No appointment', 'no_appointment', 'confirmation', null,
          [{ type:'set_variable', config:{ key:'appointmentBooked', value:false } }]),
      ]),
    vibeNode('confirmation', 'confirmation', 'Confirmation', 'Confirm appointment details',
      vibePrompt(scripts.confirmation, `Perfect. I have you scheduled. You'll receive a confirmation with the details.`, { path:'mainScript.confirmation' }),
      promptHelper(scripts.confirmation, 'Confirm date, time, address, phone, and decision-maker availability.'), 360, 1260, [],
      [vibeBranch('continue', 'Continue to wrap-up', 'continue', 'wrap_up')]),
    vibeNode('wrap_up', 'disposition', 'Wrap-up', 'Log call outcome and notes',
      vibePrompt(scripts.wrapUp || scripts.wrapup || scripts['wrap-up'], 'Select the call outcome, add any final notes, and save the result to the CRM.', { path:'mainScript.wrapUp' }),
      promptHelper(scripts.wrapUp || scripts.wrapup || scripts['wrap-up'], 'Complete the CRM note before ending the call.'), 360, 1460,
      [{ type:'capture_input', config:{ key:'additionalNotes', inputType:'textarea', label:'Additional notes', required:false } }],
      outcomes.map((outcome, index) => vibeBranch(`outcome_${index + 1}`, outcome, slug(outcome), 'complete', null, [
        { type:'set_disposition', config:{ status:slug(outcome), label:outcome, releaseLead:true } },
      ]))),
    vibeNode('wrong_number', 'disposition', 'Wrong person', 'Close the wrong-number call politely',
      `My apologies, I must have the wrong number. Have a great day.`, '', 80, 260, [],
      [vibeBranch('finish', 'End call', 'wrong_number', 'complete', null, [
        { type:'set_disposition', config:{ status:'wrong_number', label:'Wrong Number', releaseLead:true } },
      ])]),
    vibeNode('not_interested', 'disposition', 'Not interested', "Honor the customer's request",
      `I completely understand. I'll update our records and we won't bother you again. Have a great day.`, '', 650, 460, [],
      [vibeBranch('finish', 'End call', 'not_interested', 'complete', null, [
        { type:'set_disposition', config:{ status:'not_interested', label:'Not Interested', releaseLead:true } },
      ])]),
    vibeNode('complete', 'end', 'Complete', 'Complete the call and load the next lead',
      'Complete the call and continue to the next lead.', '', 360, 1660,
      [{ type:'complete_script', config:{} }], []),
  ];
  applyPromptAnswers(nodes, scripts);
  applyDynamicAnswers(nodes, input.dynamicAnswers);
  return normalizeGraph({
    schemaVersion:GRAPH_SCHEMA_VERSION,
    startNodeId:'identity',
    variables:[
      variable('dynamicGreeting', 'Dynamic greeting', 'runtime.greeting'),
      variable('weatherSummary', 'Local weather summary', 'runtime.weatherSummary'),
      variable('localTime', 'Lead local time', 'runtime.localTime'),
      variable('firstName', 'First name', 'lead.firstName'),
      variable('city', 'City', 'lead.city'),
      variable('state', 'State', 'lead.state'),
      variable('latitude', 'Latitude', 'lead.latitude'),
      variable('longitude', 'Longitude', 'lead.longitude'),
      variable('serviceType', 'Service pool', 'lead.serviceType'),
      variable('agentName', 'Agent display name', 'operator.displayName'),
      variable('appointmentType', 'Appointment type', 'runtime.appointmentType'),
      variable('serviceAddress', 'Service address', 'runtime.serviceAddress'),
      variable('selectedConcern', 'Selected concern', 'runtime.selectedConcern'),
      variable('additionalNotes', 'Additional notes', 'runtime.additionalNotes'),
    ],
    nodes,
  });
}

function vibeNode(id, type, title, goal, prompt, helperText, x, y, actions, branches) {
  return { id, type, title, goal, prompt, helperText, required:true, trackAnalytics:true, position:{ x, y }, actions, branches };
}

function vibeBranch(id, label, outcome, targetNodeId, agentResponse = null, actions = []) {
  return { id, label, outcome, targetNodeId, agentResponse, color:'#5f6b7a', condition:null, actions };
}

function concernBranch(concern, index) {
  const label = cleanText(concern?.label || concern?.name || `Concern ${index + 1}`, 128);
  const action = String(concern?.action || '').toLowerCase();
  const allowedStages = new Set(['identity','reason','address','diagnosis','trust','appointment','confirmation','wrap_up']);
  let target = action === 'end_call' ? 'wrap_up' : cleanText(concern?.targetStage, 64).replace('-', '_');
  if (!allowedStages.has(target)) target = 'trust';
  return vibeBranch(`concern_${index + 1}`, label, cleanText(concern?.outcome || slug(label), 64), target,
    vibePrompt(concern?.response, ''), [{ type:'set_variable', config:{ key:'selectedConcern', value:label } }]);
}

function applyDynamicAnswers(nodes, dynamicAnswers) {
  if (!dynamicAnswers || typeof dynamicAnswers !== 'object') return;
  for (const [stage, answers] of Object.entries(dynamicAnswers)) {
    const node = nodes.find((item) => item.id === String(stage).replace('-', '_'));
    if (!node || !Array.isArray(answers)) continue;
    for (const answer of answers) {
      if (node.branches.length >= MAX_BRANCHES_PER_NODE) break;
      const target = String(answer?.targetStage || answer?.target || '').replace('-', '_');
      if (!nodes.some((item) => item.id === target)) continue;
      node.branches.push(vibeBranch(
        `dynamic_${node.branches.length + 1}`, cleanText(answer?.label || 'Response', 128),
        cleanText(answer?.outcome || slug(answer?.label), 64), target,
        vibePrompt(answer?.response || answer?.script, ''), normalizeActions(answer?.actions)
      ));
    }
  }
}

function vibePrompt(value, fallback, context = {}) {
  const path = context.path || 'prompt';
  let raw = value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = raw.text;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw vibeShapeError(`${path}.text`, 'a string', raw);
  }
  let text = cleanText(raw || fallback, 8000);
  const replacements = [
    [/\{\s*getGreeting\(\)\s*\}/g, '{{dynamicGreeting}}'],
    [/\{\s*contact\.firstName\s*\}/g, '{{firstName}}'],
    [/\{\s*contact\.city\s*\}/g, '{{city}}'],
    [/\{\s*contact\.state\s*\}/g, '{{state}}'],
    [/\{\s*contact\.address\s*\}/g, '{{serviceAddress}}'],
    [/\{\s*agent\.firstName\s*\}/g, '{{agentName}}'],
    [/\{\s*selectedService\s*\}/g, '{{serviceType}}'],
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  if (context.reason) text = text.replace(/\{\s*currentServiceData\.reason\s*\}/g, cleanText(context.reason, 500));
  return text.replace(/^(["'])|(["'])$/g, '');
}

function promptHelper(value, fallback) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.helperText == null) return fallback;
  if (typeof value.helperText !== 'string') throw vibeShapeError('mainScript.*.helperText', 'a string', value.helperText);
  return cleanText(value.helperText, 2000);
}

function applyPromptAnswers(nodes, scripts) {
  const nextByStage = {
    identity:'reason', reason:'address', address:'diagnosis', trust:'appointment',
    appointment:'confirmation', confirmation:'wrap_up',
  };
  for (const [stage, definition] of Object.entries(scripts || {})) {
    const nodeId = String(stage).replace('-', '_').replace(/^wrapup$/i, 'wrap_up');
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || !definition || typeof definition !== 'object' || Array.isArray(definition)) continue;
    if (definition.type != null && !['question','statement'].includes(String(definition.type))) {
      throw vibeShapeError(`mainScript.${stage}.type`, 'question or statement', definition.type);
    }
    if (definition.answers == null) continue;
    if (!Array.isArray(definition.answers)) throw vibeShapeError(`mainScript.${stage}.answers`, 'an array', definition.answers);
    if (!definition.answers.length || stage === 'diagnosis') continue;
    node.branches = definition.answers.slice(0, MAX_BRANCHES_PER_NODE).map((answer, index) =>
      promptAnswerBranch(stage, answer, index, nextByStage, nodes)
    );
  }
}

function promptAnswerBranch(stage, answer, index, nextByStage, nodes) {
  const path = `mainScript.${stage}.answers[${index}]`;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw vibeShapeError(path, 'an object', answer);
  if (typeof answer.label !== 'string' || !answer.label.trim()) throw vibeShapeError(`${path}.label`, 'a non-empty string', answer.label);
  const action = String(answer.action || 'proceed');
  if (!['proceed','show_negative_path','book_appointment','jump_to_stage'].includes(action)) {
    throw vibeShapeError(`${path}.action`, 'proceed, show_negative_path, book_appointment, or jump_to_stage', answer.action);
  }
  let target = nextByStage[stage] || 'complete';
  let actions = [];
  let agentResponse = optionalPromptString(answer.agentResponse ?? answer.response, `${path}.response`);
  let outcome = cleanText(answer.outcome || slug(answer.label), 64);
  if (action === 'show_negative_path') {
    const negativeOutcome = cleanText(answer.negativePathOutcome || answer.outcome || 'Not Interested', 128);
    target = /wrong/i.test(negativeOutcome) ? 'wrong_number' : 'not_interested';
    const terminal = nodes.find((item) => item.id === target);
    const negativeText = optionalPromptString(answer.negativePathText, `${path}.negativePathText`);
    if (terminal && negativeText) terminal.prompt = vibePrompt(negativeText, terminal.prompt, { path:`${path}.negativePathText` });
    if (terminal?.branches?.[0]?.actions?.[0]) {
      terminal.branches[0].actions[0].config = {
        status:slug(negativeOutcome), label:negativeOutcome, releaseLead:true,
      };
    }
    outcome = slug(negativeOutcome);
    agentResponse = '';
  } else if (action === 'book_appointment') {
    target = 'confirmation';
    actions = [{ type:'set_variable', config:{ key:'appointmentBooked', value:true } }];
  } else if (action === 'jump_to_stage') {
    target = String(answer.targetStage || '').replace('-', '_').replace(/^wrapup$/i, 'wrap_up');
    if (!nodes.some((item) => item.id === target)) throw vibeShapeError(`${path}.targetStage`, 'a valid stage ID', answer.targetStage);
  } else if (stage === 'appointment') {
    actions = [{ type:'set_variable', config:{ key:'appointmentBooked', value:false } }];
  }
  return vibeBranch(safeSongId(answer.id || `${stage}_${index + 1}`, `${stage}_${index + 1}`),
    answer.label, outcome, target, agentResponse, actions);
}

function optionalPromptString(value, path) {
  if (value == null) return '';
  if (typeof value !== 'string') throw vibeShapeError(path, 'a string', value);
  return cleanText(value, 2000);
}

function safeSongId(value, fallback) {
  let id = String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  if (!/^[A-Za-z]/.test(id)) id = `id_${id}`.slice(0, 64);
  return id || fallback;
}

function vibeShapeError(path, expected, actual) {
  const type = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
  return statusError(`${path} must be ${expected}; received ${type}`, 400, 'SONG_VIBE_TEMPLATE_INVALID', {
    path, expected, receivedType:type,
  });
}

function slug(value) {
  const result = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return result.slice(0, 64) || 'outcome';
}

async function listVariableCatalog({ apiKeyId, locationId }, pool = null) {
  requireScope(apiKeyId, locationId);
  const p = pool || getPool();
  const result = STANDARD_VARIABLE_CATALOG.map((item) => ({ ...item }));
  const [integrations] = await p.query(
    `SELECT i.id
     FROM crm_integrations i
     INNER JOIN crm_integration_grants g ON g.integration_id=i.id
     WHERE g.api_key_id=? AND i.location_id=? AND i.is_enabled=1 AND g.allow_read=1
     ORDER BY i.created_at ASC`,
    [apiKeyId, locationId]
  );
  const integrationIds = integrations.map((row) => row.id).filter(Boolean);
  if (!integrationIds.length) return result;
  const placeholders = integrationIds.map(() => '?').join(',');
  const [objectFields] = await p.query(
    `SELECT field_id,object_model,field_key,field_name,data_type
     FROM crm_object_field_definitions
     WHERE integration_id IN (${placeholders}) AND location_id=? AND is_current=1
     ORDER BY object_model,field_name,field_key,field_id`,
    [...integrationIds, locationId]
  );
  const [discoveredFields] = await p.query(
    `SELECT field_key,field_label,data_type
     FROM crm_field_definitions
     WHERE integration_id IN (${placeholders})
     ORDER BY field_label,field_key`,
    integrationIds
  );
  const seen = new Set(result.map((item) => item.source));
  const seenFieldKeys = new Set();
  for (const row of objectFields) {
    const identifier = safeFieldIdentifier(row.field_id || row.field_key);
    if (!identifier) continue;
    const normalizedFieldKey = safeFieldIdentifier(row.field_key);
    if (normalizedFieldKey) seenFieldKeys.add(normalizedFieldKey);
    const source = `field.${identifier}`;
    if (seen.has(source)) continue;
    seen.add(source);
    const label = cleanText(row.field_name || row.field_key || row.field_id || 'CRM field', 128);
    result.push(catalog(
      suggestedVariableKey(row.field_key || label || row.field_id),
      label,
      source,
      `CRM ${titleCase(row.object_model || 'contact')}`,
      cleanText(row.data_type || 'string', 32),
      cleanText(row.field_id, 191)
    ));
  }
  for (const row of discoveredFields) {
    const identifier = safeFieldIdentifier(row.field_key);
    if (!identifier) continue;
    if (seenFieldKeys.has(identifier)) continue;
    const source = `field.${identifier}`;
    if (seen.has(source)) continue;
    seen.add(source);
    const label = cleanText(row.field_label || row.field_key || 'Imported field', 128);
    result.push(catalog(
      suggestedVariableKey(row.field_key || label), label, source, 'Imported fields',
      cleanText(row.data_type || 'string', 32), null
    ));
  }
  return result.slice(0, 2500);
}

function safeFieldIdentifier(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
}

function suggestedVariableKey(value) {
  const words = String(value || '').split('.').pop().replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let key = words.map((word, index) => index ? word[0]?.toUpperCase() + word.slice(1) : word.toLowerCase()).join('');
  if (!/^[a-z]/.test(key)) key = `field${key ? key[0].toUpperCase() + key.slice(1) : ''}`;
  return key.slice(0, 48) || 'crmField';
}

function titleCase(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function defaultGraph() {
  return normalizeGraph({
    schemaVersion:GRAPH_SCHEMA_VERSION,
    startNodeId:'greeting',
    variables:DEFAULT_VARIABLES,
    nodes:[
      {
        id:'greeting', type:'prompt', title:'Greeting', goal:'Confirm the homeowner',
        prompt:'Hi {{firstName}}, this is {{agentName}}. How are you doing today?',
        helperText:'Confirm you are speaking with the right person.', required:true,
        trackAnalytics:true, position:{ x:360, y:70 }, actions:[],
        branches:[
          { id:'confirmed', label:'Confirmed', outcome:'confirmed', targetNodeId:'qualification', color:'#27865b' },
          { id:'wrong_person', label:'Wrong person', outcome:'wrong_person', targetNodeId:'end', color:'#8b95a7' },
        ],
      },
      {
        id:'qualification', type:'qualification', title:'Qualification', goal:'Understand the need',
        prompt:'What prompted you to look into this service today?', helperText:'Listen for urgency and desired outcome.',
        required:true, trackAnalytics:true, position:{ x:360, y:280 }, actions:[],
        branches:[
          { id:'qualified', label:'Qualified', outcome:'qualified', targetNodeId:'end', color:'#27865b' },
          { id:'not_interested', label:'Not interested', outcome:'not_interested', targetNodeId:'end', color:'#d18a35', actions:[{ type:'set_disposition', config:{ status:'not_interested' } }] },
        ],
      },
      {
        id:'end', type:'end', title:'Complete', goal:'Close cleanly',
        prompt:'Thank the customer and complete the call.', helperText:'', required:true,
        trackAnalytics:true, position:{ x:360, y:510 }, actions:[{ type:'complete_script', config:{} }], branches:[],
      },
    ],
  });
}

function normalizeGraph(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const raw = JSON.stringify(source);
  if (Buffer.byteLength(raw, 'utf8') > MAX_GRAPH_BYTES) {
    throw statusError('Script graph exceeds 512 KB', 413, 'SONG_GRAPH_TOO_LARGE');
  }
  const nodes = Array.isArray(source.nodes) ? source.nodes.slice(0, MAX_NODES + 1).map(normalizeNode) : [];
  const variables = Array.isArray(source.variables) ? source.variables.slice(0, 51).map(normalizeVariable) : [];
  return {
    schemaVersion:GRAPH_SCHEMA_VERSION,
    startNodeId:cleanId(source.startNodeId),
    variables,
    nodes,
  };
}

function normalizeNode(node, index) {
  const value = node && typeof node === 'object' ? node : {};
  return {
    id:cleanId(value.id || `node_${index + 1}`),
    type:String(value.type || 'prompt').trim().toLowerCase().slice(0, 32),
    title:cleanText(value.title || `Step ${index + 1}`, 191),
    goal:cleanText(value.goal, 500),
    prompt:cleanText(value.prompt, 8000),
    helperText:cleanText(value.helperText, 2000),
    required:value.required !== false,
    trackAnalytics:value.trackAnalytics !== false,
    position:{
      x:clampNumber(value.position?.x, 0, 5000, 120 + (index % 4) * 260),
      y:clampNumber(value.position?.y, 0, 5000, 80 + Math.floor(index / 4) * 190),
    },
    actions:normalizeActions(value.actions),
    branches:(Array.isArray(value.branches) ? value.branches : [])
      .slice(0, MAX_BRANCHES_PER_NODE + 1).map((branch, branchIndex) => normalizeBranch(branch, branchIndex)),
  };
}

function normalizeBranch(branch, index) {
  const value = branch && typeof branch === 'object' ? branch : {};
  return {
    id:cleanId(value.id || `branch_${index + 1}`),
    label:cleanText(value.label || `Option ${index + 1}`, 128),
    outcome:cleanText(value.outcome || value.id || `option_${index + 1}`, 64),
    agentResponse:cleanText(value.agentResponse, 2000),
    targetNodeId:cleanId(value.targetNodeId),
    color:/^#[0-9a-f]{6}$/i.test(String(value.color || '')) ? String(value.color).toLowerCase() : '#5f6b7a',
    condition:normalizeCondition(value.condition),
    actions:normalizeActions(value.actions),
  };
}

function normalizeVariable(value) {
  const item = value && typeof value === 'object' ? value : {};
  return {
    key:cleanText(item.key, 64),
    label:cleanText(item.label || item.key, 128),
    source:cleanText(item.source, 128),
    defaultValue:cleanText(item.defaultValue, 500),
  };
}

function normalizeActions(value) {
  return (Array.isArray(value) ? value : []).slice(0, 12).map((action) => ({
    type:String(action?.type || 'none').trim().toLowerCase().slice(0, 32),
    config:safeObject(action?.config, 4096),
  }));
}

function normalizeCondition(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    mode:String(value.mode || 'all').toLowerCase() === 'any' ? 'any' : 'all',
    rules:(Array.isArray(value.rules) ? value.rules : []).slice(0, 10).map((rule) => ({
      field:cleanText(rule?.field, 64),
      operator:String(rule?.operator || 'equals').toLowerCase().slice(0, 32),
      value:scalarValue(rule?.value),
    })),
  };
}

function validateGraph(input) {
  let graph;
  try { graph = normalizeGraph(input); }
  catch (error) {
    return { valid:false, errors:[issue(error.code || 'GRAPH_INVALID', error.message)], warnings:[], stats:{ nodes:0, branches:0, reachable:0, terminalNodes:0 } };
  }
  const errors = [];
  const warnings = [];
  if (!graph.nodes.length) errors.push(issue('NODES_REQUIRED', 'At least one script node is required'));
  if (graph.nodes.length > MAX_NODES) errors.push(issue('NODE_LIMIT', `A script may contain at most ${MAX_NODES} nodes`));
  if (graph.variables.length > 50) errors.push(issue('VARIABLE_LIMIT', 'A script may contain at most 50 variables'));

  const nodeIds = new Set();
  const duplicateNodes = new Set();
  for (const node of graph.nodes) {
    if (!ID_RE.test(node.id)) errors.push(issue('NODE_ID_INVALID', `Invalid node ID "${node.id || '(empty)'}"`, node.id));
    if (nodeIds.has(node.id)) duplicateNodes.add(node.id);
    nodeIds.add(node.id);
    if (!NODE_TYPES.has(node.type)) errors.push(issue('NODE_TYPE_INVALID', `Unsupported node type "${node.type}"`, node.id));
    if (!node.title) errors.push(issue('NODE_TITLE_REQUIRED', 'Node title is required', node.id));
    if (!node.prompt && !TERMINAL_TYPES.has(node.type)) warnings.push(issue('PROMPT_EMPTY', 'This step has no agent prompt', node.id));
    if (node.branches.length > MAX_BRANCHES_PER_NODE) errors.push(issue('BRANCH_LIMIT', `A node may contain at most ${MAX_BRANCHES_PER_NODE} branches`, node.id));
    validateActions(node.actions, errors, node.id, null);
    const branchIds = new Set();
    for (const branch of node.branches) {
      if (!ID_RE.test(branch.id)) errors.push(issue('BRANCH_ID_INVALID', `Invalid branch ID "${branch.id || '(empty)'}"`, node.id, branch.id));
      if (branchIds.has(branch.id)) errors.push(issue('BRANCH_ID_DUPLICATE', `Duplicate branch ID "${branch.id}"`, node.id, branch.id));
      branchIds.add(branch.id);
      if (!branch.label) errors.push(issue('BRANCH_LABEL_REQUIRED', 'Branch label is required', node.id, branch.id));
      if (!branch.targetNodeId) errors.push(issue('BRANCH_TARGET_REQUIRED', 'Branch target is required', node.id, branch.id));
      else if (!nodeIds.has(branch.targetNodeId) && graph.nodes.every((candidate) => candidate.id !== branch.targetNodeId)) {
        errors.push(issue('BRANCH_TARGET_UNKNOWN', `Target node "${branch.targetNodeId}" does not exist`, node.id, branch.id));
      }
      validateActions(branch.actions, errors, node.id, branch.id);
      validateCondition(branch.condition, errors, node.id, branch.id);
    }
  }
  for (const id of duplicateNodes) errors.push(issue('NODE_ID_DUPLICATE', `Duplicate node ID "${id}"`, id));
  if (!graph.startNodeId) errors.push(issue('START_REQUIRED', 'A start node is required'));
  else if (!nodeIds.has(graph.startNodeId)) errors.push(issue('START_UNKNOWN', 'The start node does not exist'));

  const variableKeys = new Set();
  for (const item of graph.variables) {
    if (!VARIABLE_RE.test(item.key)) errors.push(issue('VARIABLE_KEY_INVALID', `Invalid variable key "${item.key || '(empty)'}"`));
    if (variableKeys.has(item.key)) errors.push(issue('VARIABLE_KEY_DUPLICATE', `Duplicate variable key "${item.key}"`));
    variableKeys.add(item.key);
    if (!validVariableSource(item.source)) errors.push(issue('VARIABLE_SOURCE_INVALID', `Variable "${item.key}" uses an unsupported source`));
  }
  for (const node of graph.nodes) {
    for (const text of [node.prompt, node.helperText, node.goal]) {
      for (const key of templateVariables(text)) {
        if (!variableKeys.has(key)) errors.push(issue('VARIABLE_UNDECLARED', `Template variable "${key}" is not declared`, node.id));
      }
    }
  }

  const reachable = reachableNodes(graph);
  for (const node of graph.nodes) if (!reachable.has(node.id)) warnings.push(issue('NODE_UNREACHABLE', 'Node is not reachable from the start', node.id));
  const terminalIds = new Set(graph.nodes.filter((node) => TERMINAL_TYPES.has(node.type)).map((node) => node.id));
  if (!terminalIds.size) errors.push(issue('TERMINAL_REQUIRED', 'At least one End, Disposition, or Voicemail node is required'));
  const canFinish = nodesThatCanReachTerminal(graph, terminalIds);
  for (const id of reachable) if (!canFinish.has(id)) errors.push(issue('NO_TERMINAL_PATH', 'This reachable node has no path to a terminal step', id));

  return {
    valid:errors.length === 0,
    errors,
    warnings,
    stats:{
      nodes:graph.nodes.length,
      branches:graph.nodes.reduce((sum, node) => sum + node.branches.length, 0),
      reachable:reachable.size,
      terminalNodes:terminalIds.size,
    },
    graph,
  };
}

function compileGraph(script, versionId, versionNumber, validation = null) {
  const checked = validation || validateGraph(script.graph);
  if (!checked.valid) throw statusError('Script cannot be published until validation errors are resolved', 409, 'SONG_VALIDATION_FAILED', checked);
  const graph = checked.graph;
  return {
    schemaVersion:GRAPH_SCHEMA_VERSION,
    scriptId:script.id,
    versionId,
    versionNumber,
    name:script.name,
    serviceType:script.serviceType,
    languageCode:script.languageCode,
    startNodeId:graph.startNodeId,
    maxTransitions:MAX_TRANSITIONS,
    variables:graph.variables,
    nodes:graph.nodes.map((node) => ({
      id:node.id, type:node.type, title:node.title, goal:node.goal,
      prompt:node.prompt, helperText:node.helperText, required:node.required,
      trackAnalytics:node.trackAnalytics, actions:node.actions,
      branches:node.branches.map((branch) => ({
        id:branch.id, label:branch.label, outcome:branch.outcome,
        agentResponse:branch.agentResponse,
        targetNodeId:branch.targetNodeId, condition:branch.condition,
        actions:branch.actions,
      })),
    })),
  };
}

async function listScripts({ apiKeyId, locationId, includeArchived = false }, pool = null) {
  requireScope(apiKeyId, locationId);
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT s.id,s.api_key_id,s.location_id,s.service_type,s.language_code,s.name,s.description,s.status,
            s.draft_revision,s.published_version_id,s.created_at,s.updated_at,
            v.version_number AS published_version_number,v.published_at,
            CASE WHEN a.script_id=s.id AND a.version_id=s.published_version_id THEN 1 ELSE 0 END AS is_assigned,
            CASE WHEN la.script_id=s.id AND la.version_id=s.published_version_id THEN 1 ELSE 0 END AS is_language_default
     FROM song_scripts s
     LEFT JOIN song_script_versions v ON v.id=s.published_version_id
     LEFT JOIN song_service_assignments a ON a.api_key_id=s.api_key_id AND a.location_id=s.location_id
       AND a.service_type=s.service_type
     LEFT JOIN song_service_language_assignments la ON la.api_key_id=s.api_key_id AND la.location_id=s.location_id
       AND la.service_type=s.service_type AND la.language_code=s.language_code
     WHERE s.api_key_id=? AND s.location_id=? ${includeArchived ? '' : "AND s.status<>'archived'"}
     ORDER BY s.updated_at DESC,s.name`,
    [apiKeyId, locationId]
  );
  return rows.map(publicScriptSummary);
}

async function getScript(scriptId, scope, pool = null, options = {}) {
  const p = pool || getPool();
  const params = [scriptId];
  let scopeSql = '';
  if (scope?.apiKeyId || scope?.locationId) {
    requireScope(scope.apiKeyId, scope.locationId);
    scopeSql = ' AND s.api_key_id=? AND s.location_id=?';
    params.push(scope.apiKeyId, scope.locationId);
  }
  const [rows] = await p.query(
    `SELECT s.id,s.api_key_id,s.location_id,s.service_type,s.language_code,s.name,s.description,s.status,
            s.draft_revision,s.draft_graph_json,s.published_version_id,s.created_at,s.updated_at,
            v.version_number AS published_version_number,v.published_at,
            CASE WHEN a.script_id=s.id AND a.version_id=s.published_version_id THEN 1 ELSE 0 END AS is_assigned,
            CASE WHEN la.script_id=s.id AND la.version_id=s.published_version_id THEN 1 ELSE 0 END AS is_language_default
     FROM song_scripts s
     LEFT JOIN song_script_versions v ON v.id=s.published_version_id
     LEFT JOIN song_service_assignments a ON a.api_key_id=s.api_key_id AND a.location_id=s.location_id
       AND a.service_type=s.service_type
     LEFT JOIN song_service_language_assignments la ON la.api_key_id=s.api_key_id AND la.location_id=s.location_id
       AND la.service_type=s.service_type AND la.language_code=s.language_code
     WHERE s.id=?${scopeSql} LIMIT 1`,
    params
  );
  if (!rows[0] && options.required !== false) throw statusError('Script not found', 404, 'SONG_SCRIPT_NOT_FOUND');
  return rows[0] ? publicScript(rows[0]) : null;
}

async function createScript(input, actor, pool = null) {
  const p = pool || getPool();
  const apiKeyId = cleanText(input.apiKeyId, 36);
  const locationId = cleanText(input.locationId, 128);
  requireScope(apiKeyId, locationId);
  const id = crypto.randomUUID();
  const graph = input.graph ? normalizeGraph(input.graph) : defaultGraph();
  const name = requiredText(input.name, 191, 'Script name');
  const serviceType = requiredText(input.serviceType, 128, 'Service type');
  const languageCode = normalizeLanguageCode(input.languageCode);
  await p.query(
    `INSERT INTO song_scripts
       (id,api_key_id,location_id,service_type,language_code,name,description,status,draft_revision,
        draft_graph_json,created_by,updated_by)
     VALUES (?,?,?,?,?,?,?,'draft',1,?,?,?)`,
    [id, apiKeyId, locationId, serviceType, languageCode, name, cleanText(input.description, 1000),
      JSON.stringify(graph), actor?.id || null, actor?.id || null]
  );
  return getScript(id, { apiKeyId, locationId }, p);
}

async function saveDraft(scriptId, input, actor, pool = null) {
  const p = pool || getPool();
  const before = await getScript(scriptId, input, p);
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw statusError('expectedRevision is required', 400, 'SONG_REVISION_REQUIRED');
  }
  const graph = normalizeGraph(input.graph);
  const name = input.name === undefined ? before.name : requiredText(input.name, 191, 'Script name');
  const serviceType = input.serviceType === undefined ? before.serviceType : requiredText(input.serviceType, 128, 'Service type');
  const languageCode = input.languageCode === undefined ? before.languageCode : normalizeLanguageCode(input.languageCode);
  if (before.publishedVersionId && serviceType !== before.serviceType) {
    throw statusError('Clone the script to change its service after publication', 409, 'SONG_PUBLISHED_CLASSIFICATION_LOCKED');
  }
  if (before.publishedVersionId && languageCode !== before.languageCode) {
    throw statusError('Use the published language endpoint to change this script language', 409, 'SONG_PUBLISHED_LANGUAGE_CHANGE_REQUIRED');
  }
  const [result] = await p.query(
    `UPDATE song_scripts SET name=?,description=?,service_type=?,language_code=?,draft_graph_json=?,
       draft_revision=draft_revision+1,updated_by=?,status=CASE WHEN status='archived' THEN 'draft' ELSE status END
     WHERE id=? AND api_key_id=? AND location_id=? AND draft_revision=?`,
    [name, input.description === undefined ? before.description : cleanText(input.description, 1000),
      serviceType, languageCode, JSON.stringify(graph), actor?.id || null, scriptId,
      input.apiKeyId, input.locationId, expectedRevision]
  );
  if (!result.affectedRows) throw statusError('Draft changed in another session; reload before saving', 409, 'SONG_REVISION_CONFLICT');
  return { before, after:await getScript(scriptId, input, p) };
}

async function publishScript(scriptId, input, actor, pool = null) {
  const p = pool || getPool();
  requireScope(input.apiKeyId, input.locationId);
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id,api_key_id,location_id,service_type,language_code,name,description,status,draft_revision,
              draft_graph_json,published_version_id,created_at,updated_at
       FROM song_scripts WHERE id=? AND api_key_id=? AND location_id=? FOR UPDATE`,
      [scriptId, input.apiKeyId, input.locationId]
    );
    if (!rows[0]) throw statusError('Script not found', 404, 'SONG_SCRIPT_NOT_FOUND');
    if (Number(input.expectedRevision) !== Number(rows[0].draft_revision)) {
      throw statusError('Draft changed in another session; reload before publishing', 409, 'SONG_REVISION_CONFLICT');
    }
    const script = publicScript(rows[0]);
    const validation = validateGraph(script.graph);
    if (!validation.valid) throw statusError('Script has validation errors', 409, 'SONG_VALIDATION_FAILED', validation);
    const [versionRows] = await conn.query(
      'SELECT COALESCE(MAX(version_number),0)+1 AS nextVersion FROM song_script_versions WHERE script_id=?',
      [scriptId]
    );
    const versionNumber = Number(versionRows[0].nextVersion) || 1;
    const versionId = crypto.randomUUID();
    const compiled = compileGraph(script, versionId, versionNumber, validation);
    const graphJson = JSON.stringify(validation.graph);
    const compiledJson = JSON.stringify(compiled);
    const checksum = crypto.createHash('sha256').update(compiledJson).digest('hex');
    await conn.query(
      `INSERT INTO song_script_versions
         (id,script_id,version_number,graph_json,compiled_json,checksum,validation_json,published_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [versionId, scriptId, versionNumber, graphJson, compiledJson, checksum,
        JSON.stringify({ warnings:validation.warnings, stats:validation.stats }), actor?.id || null]
    );
    await conn.query(
      `UPDATE song_scripts SET status='published',published_version_id=?,updated_by=? WHERE id=?`,
      [versionId, actor?.id || null, scriptId]
    );
    if (script.languageCode === 'en-US') {
      await conn.query(
        `INSERT INTO song_service_assignments
           (api_key_id,location_id,service_type,script_id,version_id,updated_by)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE script_id=VALUES(script_id),version_id=VALUES(version_id),
           updated_by=VALUES(updated_by),updated_at=CURRENT_TIMESTAMP(3)`,
        [input.apiKeyId, input.locationId, script.serviceType, scriptId, versionId, actor?.id || null]
      );
    }
    await conn.query(
      `INSERT INTO song_service_language_assignments
         (api_key_id,location_id,service_type,language_code,script_id,version_id,updated_by)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE script_id=VALUES(script_id),version_id=VALUES(version_id),
         updated_by=VALUES(updated_by),updated_at=CURRENT_TIMESTAMP(3)`,
      [input.apiKeyId, input.locationId, script.serviceType, script.languageCode,
        scriptId, versionId, actor?.id || null]
    );
    await conn.commit();
    return {
      script:await getScript(scriptId, input, p),
      version:{ id:versionId, number:versionNumber, checksum, publishedAt:new Date().toISOString() },
      validation,
    };
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally { conn.release(); }
}

async function changeScriptLanguage(scriptId, input, actor, pool = null) {
  const p = pool || getPool();
  requireScope(input.apiKeyId, input.locationId);
  const languageCode = normalizeLanguageCode(input.languageCode);
  const conn = await p.getConnection();
  let version = null;
  let released = false;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id,api_key_id,location_id,service_type,language_code,name,description,status,draft_revision,
              draft_graph_json,published_version_id,created_at,updated_at
       FROM song_scripts WHERE id=? AND api_key_id=? AND location_id=? FOR UPDATE`,
      [scriptId, input.apiKeyId, input.locationId]
    );
    if (!rows[0]) throw statusError('Script not found', 404, 'SONG_SCRIPT_NOT_FOUND');
    const currentLanguage = normalizeLanguageCode(rows[0].language_code || 'en-US');
    if (languageCode === currentLanguage) {
      await conn.commit();
      conn.release();
      released = true;
      return { changed:false, script:await getScript(scriptId, input, p), version:null };
    }

    if (!rows[0].published_version_id) {
      await conn.query(
        `UPDATE song_scripts SET language_code=?,updated_by=?
         WHERE id=? AND api_key_id=? AND location_id=?`,
        [languageCode, actor?.id || null, scriptId, input.apiKeyId, input.locationId]
      );
      await conn.commit();
      conn.release();
      released = true;
      return { changed:true, script:await getScript(scriptId, input, p), version:null };
    }

    const [publishedRows] = await conn.query(
      `SELECT graph_json,compiled_json,validation_json
       FROM song_script_versions WHERE id=? AND script_id=? LIMIT 1`,
      [rows[0].published_version_id, scriptId]
    );
    if (!publishedRows[0]) {
      throw statusError('Published script version not found', 409, 'SONG_PUBLISHED_VERSION_MISSING');
    }
    const graph = normalizeGraph(parseJson(publishedRows[0].graph_json, {}));
    const validation = validateGraph(graph);
    if (!validation.valid) throw statusError('Published script has validation errors', 409, 'SONG_VALIDATION_FAILED', validation);
    const previousCompiled = parseJson(publishedRows[0].compiled_json, null);
    if (!previousCompiled || typeof previousCompiled !== 'object') {
      throw statusError('Published runtime is invalid', 409, 'SONG_PUBLISHED_RUNTIME_INVALID');
    }
    const [versionRows] = await conn.query(
      'SELECT COALESCE(MAX(version_number),0)+1 AS nextVersion FROM song_script_versions WHERE script_id=?',
      [scriptId]
    );
    const versionNumber = Number(versionRows[0].nextVersion) || 1;
    const versionId = crypto.randomUUID();
    const compiled = { ...previousCompiled, versionId, versionNumber, languageCode };
    const compiledJson = JSON.stringify(compiled);
    const checksum = crypto.createHash('sha256').update(compiledJson).digest('hex');
    await conn.query(
      `INSERT INTO song_script_versions
         (id,script_id,version_number,graph_json,compiled_json,checksum,validation_json,published_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [versionId, scriptId, versionNumber, JSON.stringify(validation.graph), compiledJson, checksum,
        publishedRows[0].validation_json || JSON.stringify({ warnings:validation.warnings, stats:validation.stats }),
        actor?.id || null]
    );
    await conn.query(
      `UPDATE song_scripts SET language_code=?,published_version_id=?,updated_by=?
       WHERE id=? AND api_key_id=? AND location_id=?`,
      [languageCode, versionId, actor?.id || null, scriptId, input.apiKeyId, input.locationId]
    );

    const [removedLanguage] = await conn.query(
      `DELETE FROM song_service_language_assignments
       WHERE api_key_id=? AND location_id=? AND service_type=? AND language_code=? AND script_id=?`,
      [input.apiKeyId, input.locationId, rows[0].service_type, currentLanguage, scriptId]
    );
    if (removedLanguage.affectedRows) {
      await restoreLanguageAssignment(conn, {
        apiKeyId:input.apiKeyId, locationId:input.locationId, serviceType:rows[0].service_type,
        languageCode:currentLanguage, excludeScriptId:scriptId, actorId:actor?.id || null,
      });
    }
    await upsertLanguageAssignment(conn, {
      apiKeyId:input.apiKeyId, locationId:input.locationId, serviceType:rows[0].service_type,
      languageCode, scriptId, versionId, actorId:actor?.id || null,
    });

    if (currentLanguage === 'en-US' && languageCode !== 'en-US') {
      const [removedService] = await conn.query(
        `DELETE FROM song_service_assignments
         WHERE api_key_id=? AND location_id=? AND service_type=? AND script_id=?`,
        [input.apiKeyId, input.locationId, rows[0].service_type, scriptId]
      );
      if (removedService.affectedRows) {
        await restoreServiceAssignment(conn, {
          apiKeyId:input.apiKeyId, locationId:input.locationId, serviceType:rows[0].service_type,
          excludeScriptId:scriptId, actorId:actor?.id || null,
        });
      }
    } else if (languageCode === 'en-US') {
      await upsertServiceAssignment(conn, {
        apiKeyId:input.apiKeyId, locationId:input.locationId, serviceType:rows[0].service_type,
        scriptId, versionId, actorId:actor?.id || null,
      });
    }

    version = { id:versionId, number:versionNumber, checksum, publishedAt:new Date().toISOString() };
    await conn.commit();
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally { if (!released) conn.release(); }
  return { changed:true, script:await getScript(scriptId, input, p), version };
}

async function restoreLanguageAssignment(conn, input) {
  const [rows] = await conn.query(
    `SELECT id,published_version_id FROM song_scripts
     WHERE api_key_id=? AND location_id=? AND service_type=? AND language_code=?
       AND status='published' AND published_version_id IS NOT NULL AND id<>?
     ORDER BY updated_at DESC,id LIMIT 1`,
    [input.apiKeyId, input.locationId, input.serviceType, input.languageCode, input.excludeScriptId]
  );
  if (!rows[0]) return;
  await upsertLanguageAssignment(conn, {
    ...input, scriptId:rows[0].id, versionId:rows[0].published_version_id,
  });
}

async function restoreServiceAssignment(conn, input) {
  const [rows] = await conn.query(
    `SELECT id,published_version_id FROM song_scripts
     WHERE api_key_id=? AND location_id=? AND service_type=? AND language_code='en-US'
       AND status='published' AND published_version_id IS NOT NULL AND id<>?
     ORDER BY updated_at DESC,id LIMIT 1`,
    [input.apiKeyId, input.locationId, input.serviceType, input.excludeScriptId]
  );
  if (!rows[0]) return;
  await upsertServiceAssignment(conn, {
    ...input, scriptId:rows[0].id, versionId:rows[0].published_version_id,
  });
}

async function upsertLanguageAssignment(conn, input) {
  await conn.query(
    `INSERT INTO song_service_language_assignments
       (api_key_id,location_id,service_type,language_code,script_id,version_id,updated_by)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE script_id=VALUES(script_id),version_id=VALUES(version_id),
       updated_by=VALUES(updated_by),updated_at=CURRENT_TIMESTAMP(3)`,
    [input.apiKeyId, input.locationId, input.serviceType, input.languageCode,
      input.scriptId, input.versionId, input.actorId]
  );
}

async function upsertServiceAssignment(conn, input) {
  await conn.query(
    `INSERT INTO song_service_assignments
       (api_key_id,location_id,service_type,script_id,version_id,updated_by)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE script_id=VALUES(script_id),version_id=VALUES(version_id),
       updated_by=VALUES(updated_by),updated_at=CURRENT_TIMESTAMP(3)`,
    [input.apiKeyId, input.locationId, input.serviceType, input.scriptId, input.versionId, input.actorId]
  );
}

async function archiveScript(scriptId, input, actor, pool = null) {
  const p = pool || getPool();
  const before = await getScript(scriptId, input, p);
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM song_service_assignments
       WHERE api_key_id=? AND location_id=? AND script_id=?`,
      [input.apiKeyId, input.locationId, scriptId]
    );
    await conn.query(
      `DELETE FROM song_service_language_assignments
       WHERE api_key_id=? AND location_id=? AND script_id=?`,
      [input.apiKeyId, input.locationId, scriptId]
    );
    await conn.query(
      `UPDATE song_scripts SET status='archived',updated_by=? WHERE id=? AND api_key_id=? AND location_id=?`,
      [actor?.id || null, scriptId, input.apiKeyId, input.locationId]
    );
    await conn.commit();
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally { conn.release(); }
  return { before, after:await getScript(scriptId, input, p) };
}

async function cloneScript(scriptId, input, actor, pool = null) {
  const source = await getScript(scriptId, input, pool);
  return createScript({
    apiKeyId:input.apiKeyId,
    locationId:input.locationId,
    name:input.name || `${source.name} Copy`,
    description:source.description,
    serviceType:input.serviceType || source.serviceType,
    languageCode:input.languageCode || source.languageCode,
    graph:source.graph,
  }, actor, pool);
}

async function listVersions(scriptId, scope, pool = null) {
  const p = pool || getPool();
  await getScript(scriptId, scope, p);
  const [rows] = await p.query(
    `SELECT id,version_number,checksum,validation_json,published_by,published_at
     FROM song_script_versions WHERE script_id=? ORDER BY version_number DESC`,
    [scriptId]
  );
  return rows.map((row) => ({
    id:row.id, versionNumber:Number(row.version_number), checksum:row.checksum,
    validation:parseJson(row.validation_json, {}), publishedBy:row.published_by || null,
    publishedAt:row.published_at,
  }));
}

async function getRuntimeScript({ apiKeyId, locationId, serviceType, scriptId, languageCode }, pool = null) {
  requireScope(apiKeyId, locationId);
  const service = requiredText(serviceType, 128, 'Service type');
  const p = pool || getPool();
  const selectedScriptId = cleanText(scriptId, 64);
  const language = languageCode == null || String(languageCode).trim() === ''
    ? null : normalizeLanguageCode(languageCode);
  if (selectedScriptId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selectedScriptId)) {
    throw statusError('scriptId must be a valid SONG script ID', 400, 'SONG_SCRIPT_ID_INVALID');
  }
  const [rows] = selectedScriptId
    ? await p.query(
      `SELECT s.id AS script_id,v.id AS version_id,v.compiled_json,v.checksum,v.published_at
       FROM song_scripts s
       INNER JOIN song_script_versions v ON v.id=s.published_version_id AND v.script_id=s.id
       WHERE s.id=? AND s.api_key_id=? AND s.location_id=? AND s.service_type=?
         AND s.status='published' ${language ? 'AND s.language_code=?' : ''} LIMIT 1`,
      language ? [selectedScriptId, apiKeyId, locationId, service, language]
        : [selectedScriptId, apiKeyId, locationId, service]
    )
    : language ? await p.query(
      `SELECT a.script_id,a.version_id,v.compiled_json,v.checksum,v.published_at
       FROM song_service_language_assignments a
       INNER JOIN song_scripts s ON s.id=a.script_id AND s.status='published'
       INNER JOIN song_script_versions v ON v.id=a.version_id AND v.script_id=a.script_id
       WHERE a.api_key_id=? AND a.location_id=? AND a.service_type=? AND a.language_code=? LIMIT 1`,
      [apiKeyId, locationId, service, language]
    ) : await p.query(
      `SELECT a.script_id,a.version_id,v.compiled_json,v.checksum,v.published_at
       FROM song_service_assignments a
       INNER JOIN song_scripts s ON s.id=a.script_id AND s.status='published'
       INNER JOIN song_script_versions v ON v.id=a.version_id AND v.script_id=a.script_id
       WHERE a.api_key_id=? AND a.location_id=? AND a.service_type=? LIMIT 1`,
      [apiKeyId, locationId, service]
    );
  if (!rows[0]) throw statusError('No published script is assigned to this service', 404, 'SONG_RUNTIME_NOT_FOUND');
  return {
    ...parseJson(rows[0].compiled_json, {}),
    checksum:rows[0].checksum,
    publishedAt:rows[0].published_at,
  };
}

async function listRuntimeScripts({ apiKeyId, locationId, serviceType, languageCode, query, limit = 25 }, pool = null) {
  requireScope(apiKeyId, locationId);
  const p = pool || getPool();
  const service = cleanText(serviceType, 128);
  const language = languageCode == null || String(languageCode).trim() === ''
    ? null : normalizeLanguageCode(languageCode);
  const search = cleanText(query, 100);
  const safeLimit = Math.trunc(clampNumber(limit, 1, 50, 25));
  const where = ["s.api_key_id=?", "s.location_id=?", "s.status='published'", 's.published_version_id IS NOT NULL'];
  const params = [apiKeyId, locationId];
  if (service) { where.push('s.service_type=?'); params.push(service); }
  if (language) { where.push('s.language_code=?'); params.push(language); }
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    where.push("(s.name LIKE ? ESCAPE '\\\\' OR s.description LIKE ? ESCAPE '\\\\')");
    params.push(pattern, pattern);
  }
  params.push(safeLimit);
  const [rows] = await p.query(
    `SELECT s.id AS script_id,s.service_type,s.language_code,s.name,s.description,
            v.id AS version_id,v.version_number,v.checksum,v.published_at,
            CASE WHEN a.script_id=s.id AND a.version_id=v.id THEN 1 ELSE 0 END AS is_default,
            CASE WHEN la.script_id=s.id AND la.version_id=v.id THEN 1 ELSE 0 END AS is_language_default
     FROM song_scripts s
     INNER JOIN song_script_versions v ON v.id=s.published_version_id AND v.script_id=s.id
     LEFT JOIN song_service_assignments a ON a.api_key_id=s.api_key_id
       AND a.location_id=s.location_id AND a.service_type=s.service_type
     LEFT JOIN song_service_language_assignments la ON la.api_key_id=s.api_key_id
       AND la.location_id=s.location_id AND la.service_type=s.service_type AND la.language_code=s.language_code
     WHERE ${where.join(' AND ')}
     ORDER BY is_language_default DESC,is_default DESC,s.name ASC,s.id ASC LIMIT ?`,
    params
  );
  return rows.map((row) => ({
    scriptId:row.script_id,
    serviceType:row.service_type,
    languageCode:row.language_code,
    name:row.name,
    description:row.description || '',
    versionId:row.version_id,
    versionNumber:Number(row.version_number),
    checksum:row.checksum,
    publishedAt:row.published_at,
    isDefault:Number(row.is_default) === 1,
    isLanguageDefault:Number(row.is_language_default) === 1,
  }));
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function resolveRuntimeVariables({ variables, leadId, locationId, operator, runtimeContext }, pool = null) {
  const declared = Array.isArray(variables) ? variables.slice(0, 50) : [];
  const values = {};
  const operatorValues = {
    'operator.displayName':operator?.crmUserName || operator?.username || '',
    'operator.username':operator?.username || '',
    'operator.userId':operator?.userId || '',
    'operator.crmUserName':operator?.crmUserName || '',
  };
  const safeRuntimeContext = sanitizeRuntimeContext(runtimeContext);
  for (const item of declared) {
    if (Object.hasOwn(operatorValues, item.source)) values[item.key] = operatorValues[item.source] || item.defaultValue || '';
    else if (String(item.source || '').startsWith('runtime.')) {
      const runtimeKey = String(item.source).slice(8);
      values[item.key] = Object.hasOwn(safeRuntimeContext, runtimeKey)
        ? safeRuntimeContext[runtimeKey] : item.defaultValue || '';
    }
  }
  const safeLeadId = cleanText(leadId, 128);
  if (!safeLeadId) return values;
  const p = pool || getPool();
  const [leadRows] = await p.query(
    `SELECT id,locationId,serviceType,assignedTo,contactData
     FROM leads WHERE id=? AND locationId=? LIMIT 1`,
    [safeLeadId, locationId]
  );
  const lead = leadRows[0];
  if (!lead) throw statusError('Lead is not available for this script runtime', 404, 'SONG_RUNTIME_LEAD_NOT_FOUND');
  if (!operator?.isAdmin && String(lead.assignedTo || '') !== String(operator?.userId || '')) {
    throw statusError('Lead is not assigned to this operator', 403, 'SONG_RUNTIME_LEAD_FORBIDDEN');
  }
  const contact = parseJson(lead.contactData, {});
  const imported = new Map();
  const [importRows] = await p.query(
    `SELECT field_key,data_type,value_text,value_number,value_datetime,value_boolean,value_json
     FROM lead_import_values WHERE lead_id=? AND is_current=1`,
    [safeLeadId]
  );
  for (const row of importRows) imported.set(String(row.field_key || ''), importedValue(row));
  const custom = customFieldValues(contact);
  const requestedFieldIds = declared.filter((item) => String(item.source || '').startsWith('field.'))
    .map((item) => String(item.source).slice(6));
  if (requestedFieldIds.length) {
    const [definitionRows] = await p.query(
      `SELECT d.field_id,d.field_key
       FROM crm_object_field_definitions d
       INNER JOIN lead_source_links l ON l.integration_id=d.integration_id
       WHERE l.lead_id=? AND d.location_id=? AND d.is_current=1`,
      [safeLeadId, locationId]
    );
    for (const definition of definitionRows) {
      const id = safeFieldIdentifier(definition.field_id);
      const key = String(definition.field_key || '');
      if (id && !custom.has(id) && imported.has(key)) custom.set(id, imported.get(key));
    }
  }
  const leadValues = {
    ...contact,
    id:lead.id,
    locationId:lead.locationId,
    serviceType:lead.serviceType,
  };
  for (const item of declared) {
    const source = String(item.source || '');
    let value;
    if (source.startsWith('lead.')) value = getObjectPath(leadValues, source.slice(5));
    else if (source.startsWith('field.')) {
      const field = source.slice(6);
      value = custom.has(field) ? custom.get(field) : imported.get(field);
    }
    if (value !== undefined && value !== null && value !== '') values[item.key] = scalarRuntimeValue(value);
    else if (!Object.hasOwn(values, item.key)) values[item.key] = item.defaultValue || '';
  }
  return values;
}

function sanitizeRuntimeContext(value) {
  const allowed = new Set(['greeting','weatherSummary','localTime','appointmentType']);
  const output = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    output[key] = scalarRuntimeValue(child);
  }
  return output;
}

function customFieldValues(contact) {
  const values = new Map();
  for (const item of Array.isArray(contact?.customFields) ? contact.customFields : []) {
    const value = item?.value ?? item?.fieldValue ?? item?.values ?? null;
    for (const candidate of [item?.id, item?.fieldId, item?.key]) {
      const key = safeFieldIdentifier(candidate);
      if (key && value != null) values.set(key, value);
    }
  }
  return values;
}

function importedValue(row) {
  if (row.value_boolean != null) return Boolean(row.value_boolean);
  if (row.value_number != null) return Number(row.value_number);
  if (row.value_datetime != null) return row.value_datetime;
  if (row.value_json != null) return parseJson(row.value_json, row.value_json);
  return row.value_text;
}

function getObjectPath(object, path) {
  const direct = String(path || '').split('.').reduce((value, key) => value == null ? undefined : value[key], object);
  if (direct !== undefined) return direct;
  const aliases = {
    fullName:['contactName','name'], companyName:['businessName','company'], postalCode:['postal_code','zip','zipCode'],
    dateOfBirth:['date_of_birth','dob'], firstName:['first_name'], lastName:['last_name'],
  };
  for (const alias of aliases[path] || []) if (object?.[alias] !== undefined) return object[alias];
  return undefined;
}

function scalarRuntimeValue(value) {
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scalarRuntimeValue(item));
  if (value && typeof value === 'object') return JSON.stringify(value).slice(0, 2000);
  if (typeof value === 'string') return value.slice(0, 2000);
  return value;
}

async function recordRuntimeEvent(input, pool = null) {
  requireScope(input.apiKeyId, input.locationId);
  if (!EVENT_TYPES.has(String(input.eventType || ''))) {
    throw statusError('Unsupported SONG event type', 400, 'SONG_EVENT_TYPE_INVALID');
  }
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT v.compiled_json FROM song_script_versions v
     INNER JOIN song_scripts s ON s.id=v.script_id
     WHERE s.id=? AND v.id=? AND s.api_key_id=? AND s.location_id=? LIMIT 1`,
    [input.scriptId, input.versionId, input.apiKeyId, input.locationId]
  );
  if (!rows[0]) throw statusError('Script runtime version not found', 404, 'SONG_RUNTIME_NOT_FOUND');
  const compiled = parseJson(rows[0].compiled_json, {});
  const node = input.nodeId ? compiled.nodes?.find((item) => item.id === input.nodeId) : null;
  if (input.nodeId && !node) throw statusError('Runtime node is not part of this script version', 400, 'SONG_EVENT_NODE_INVALID');
  if (input.branchId && !node?.branches?.some((branch) => branch.id === input.branchId)) {
    throw statusError('Runtime branch is not part of this node', 400, 'SONG_EVENT_BRANCH_INVALID');
  }
  const metadata = safeMetadata(input.metadata);
  const [result] = await p.query(
    `INSERT INTO song_runtime_events
       (api_key_id,location_id,script_id,version_id,operator_user_id,lead_id,node_id,
        branch_id,event_type,outcome,metadata_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [input.apiKeyId, input.locationId, input.scriptId, input.versionId,
      requiredText(input.operatorUserId, 128, 'Operator user'), cleanText(input.leadId, 128),
      cleanText(input.nodeId, 64), cleanText(input.branchId, 64), input.eventType,
      cleanText(input.outcome, 64), metadata == null ? null : JSON.stringify(metadata)]
  );
  return { id:Number(result.insertId), recorded:true };
}

async function getAnalytics(scriptId, scope, pool = null) {
  const p = pool || getPool();
  await getScript(scriptId, scope, p);
  const [summaryRows] = await p.query(
    `SELECT COUNT(*) AS events,COUNT(DISTINCT operator_user_id) AS operators,
            COUNT(DISTINCT lead_id) AS leads,
            SUM(event_type='script_completed') AS completions,
            SUM(event_type='script_abandoned') AS abandoned
     FROM song_runtime_events WHERE script_id=?`,
    [scriptId]
  );
  const [nodes] = await p.query(
    `SELECT node_id AS nodeId,event_type AS eventType,outcome,COUNT(*) AS total
     FROM song_runtime_events WHERE script_id=?
     GROUP BY node_id,event_type,outcome ORDER BY total DESC`,
    [scriptId]
  );
  const row = summaryRows[0] || {};
  return {
    summary:{
      events:Number(row.events) || 0, operators:Number(row.operators) || 0,
      leads:Number(row.leads) || 0, completions:Number(row.completions) || 0,
      abandoned:Number(row.abandoned) || 0,
    },
    nodes:nodes.map((item) => ({ ...item, total:Number(item.total) || 0 })),
  };
}

function publicScriptSummary(row) {
  return {
    id:row.id, apiKeyId:row.api_key_id, locationId:row.location_id,
    serviceType:row.service_type, languageCode:normalizeLanguageCode(row.language_code || 'en-US'),
    name:row.name, description:row.description || '',
    status:row.status, draftRevision:Number(row.draft_revision),
    publishedVersionId:row.published_version_id || null,
    publishedVersionNumber:row.published_version_number == null ? null : Number(row.published_version_number),
    publishedAt:row.published_at || null, isAssigned:Number(row.is_assigned) === 1,
    isLanguageDefault:Number(row.is_language_default) === 1,
    createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

function publicScript(row) {
  return {
    ...publicScriptSummary(row),
    graph:normalizeGraph(parseJson(row.draft_graph_json, {})),
  };
}

function validateActions(actions, errors, nodeId, branchId) {
  for (const action of actions) {
    if (!ACTION_TYPES.has(action.type)) errors.push(issue('ACTION_TYPE_INVALID', `Unsupported action "${action.type}"`, nodeId, branchId));
  }
}

function validateCondition(condition, errors, nodeId, branchId) {
  if (!condition) return;
  for (const rule of condition.rules) {
    if (!VARIABLE_RE.test(rule.field)) errors.push(issue('CONDITION_FIELD_INVALID', 'Condition field is invalid', nodeId, branchId));
    if (!CONDITION_OPERATORS.has(rule.operator)) errors.push(issue('CONDITION_OPERATOR_INVALID', `Unsupported condition operator "${rule.operator}"`, nodeId, branchId));
  }
}

function reachableNodes(graph) {
  const result = new Set();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const stack = graph.startNodeId ? [graph.startNodeId] : [];
  while (stack.length) {
    const id = stack.pop();
    if (result.has(id) || !nodes.has(id)) continue;
    result.add(id);
    for (const branch of nodes.get(id).branches) if (branch.targetNodeId) stack.push(branch.targetNodeId);
  }
  return result;
}

function nodesThatCanReachTerminal(graph, terminalIds) {
  const reverse = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const node of graph.nodes) for (const branch of node.branches) {
    if (reverse.has(branch.targetNodeId)) reverse.get(branch.targetNodeId).push(node.id);
  }
  const result = new Set();
  const stack = [...terminalIds];
  while (stack.length) {
    const id = stack.pop();
    if (result.has(id)) continue;
    result.add(id);
    for (const parent of reverse.get(id) || []) stack.push(parent);
  }
  return result;
}

function templateVariables(text) {
  const values = [];
  const regex = /{{\s*([a-z][a-zA-Z0-9_.]{0,63})\s*}}/g;
  let match;
  while ((match = regex.exec(String(text || '')))) values.push(match[1]);
  return values;
}

function validVariableSource(source) {
  return new Set(STANDARD_VARIABLE_CATALOG.map((item) => item.source)).has(source)
    || /^runtime\.[a-z][a-zA-Z0-9_.]{0,55}$/.test(source)
    || /^field\.[A-Za-z0-9_.:-]{1,120}$/.test(source);
}

function safeMetadata(value, depth = 0) {
  if (value == null) return null;
  const cleaned = sanitizeMetadataValue(value, depth);
  if (Buffer.byteLength(JSON.stringify(cleaned), 'utf8') > 4096) {
    throw statusError('SONG event metadata exceeds 4 KB', 413, 'SONG_EVENT_METADATA_TOO_LARGE');
  }
  return cleaned;
}

function sanitizeMetadataValue(value, depth) {
  if (depth > 5) return null;
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return scalarValue(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeMetadataValue(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 500);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !FORBIDDEN_METADATA_KEY.test(key))
    .slice(0, 50).map(([key, child]) => [String(key).slice(0, 64), sanitizeMetadataValue(child, depth + 1)]));
}

function safeObject(value, maxBytes) {
  const cleaned = sanitizeMetadataValue(value && typeof value === 'object' ? value : {}, 0);
  return Buffer.byteLength(JSON.stringify(cleaned), 'utf8') <= maxBytes ? cleaned : {};
}

function scalarValue(value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scalarValue(item));
  return String(value).slice(0, 500);
}

function issue(code, message, nodeId = null, branchId = null) {
  return { code, message, nodeId, branchId };
}

function requiredText(value, max, label) {
  const result = cleanText(value, max);
  if (!result) throw statusError(`${label} is required`, 400, `SONG_${label.toUpperCase().replace(/\s+/g, '_')}_REQUIRED`);
  return result;
}

function cleanText(value, max) {
  if (value == null) return '';
  return String(value).trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max);
}

function normalizeLanguageCode(value = 'en-US') {
  const input = cleanText(value || 'en-US', 35).replace(/_/g, '-');
  try {
    const locale = new Intl.Locale(input).toString();
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) throw new Error();
    return locale;
  } catch {
    throw statusError('languageCode must be a valid BCP 47 language tag', 400, 'SONG_LANGUAGE_INVALID');
  }
}

function cleanId(value) {
  return cleanText(value, 64);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

function requireScope(apiKeyId, locationId) {
  if (!apiKeyId || !locationId) throw statusError('apiKeyId and locationId are required', 400, 'SONG_SCOPE_REQUIRED');
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { const parsed = JSON.parse(value); return parsed == null ? fallback : parsed; }
  catch { return fallback; }
}

function statusError(message, status, code, details = null) {
  return Object.assign(new Error(message), { status, code, details });
}

module.exports = {
  GRAPH_SCHEMA_VERSION,
  NODE_TYPES,
  ACTION_TYPES,
  EVENT_TYPES,
  DEFAULT_VARIABLES,
  STANDARD_VARIABLE_CATALOG,
  listVariableCatalog,
  vibeServiceToGraph,
  defaultGraph,
  normalizeGraph,
  validateGraph,
  compileGraph,
  listScripts,
  getScript,
  createScript,
  saveDraft,
  publishScript,
  changeScriptLanguage,
  archiveScript,
  cloneScript,
  listVersions,
  listRuntimeScripts,
  getRuntimeScript,
  resolveRuntimeVariables,
  recordRuntimeEvent,
  getAnalytics,
  safeMetadata,
  normalizeLanguageCode,
};
