const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { getPool } = require('../db/pool');
const {
  getAuthorizedIntegration,
  integrationCredential,
  LEADCONNECTOR_PROVIDER,
} = require('./crmIntegrations');
const { syncCustomFieldDefinitions, syncObjectDefinitions } = require('./crmImporter');
const { evaluateDialerEligibility } = require('./dialerEligibility');
const { assignDialer, DEFAULT_ASSIGNED_DIALER_FIELD_ID } = require('./dialerAssignments');
const { applyCallCenterOutcome } = require('./callCenterOutcomes');
const { resolveAccess } = require('./sqlGrants');
const { getDataPool } = require('./sqlConnections');
const parrot = require('./parrot');
const parrotStudio = require('./parrotStudio');
const { getParrotConfig } = require('../config');
const { instanceAction, schemaUrn } = require('../instanceIdentity');

const NODE_TYPES = Object.freeze(['trigger', 'condition', 'action', 'end']);
const BASE_ACTION_DEFINITIONS = Object.freeze([
  actionDefinition('ghl.update_contact', 'Update Contact', 'Map standard and custom CRM fields onto an existing contact.', 'Contacts', 'contacts.write', [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
  ], { editor: 'contact_fields' }),
  actionDefinition('ghl.upsert_contact', 'Create or Update Contact', 'Upsert a contact using the location duplicate-contact policy.', 'Contacts', 'contacts.write', [], { editor: 'contact_fields' }),
  actionDefinition('ghl.add_tags', 'Add Tags', 'Add one or more tags to a contact.', 'Contacts', 'contacts.write', [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
    inputField('tags', 'Tags', 'string_list', true, ['lead-processed']),
  ], { editor: 'tags' }),
  actionDefinition('ghl.remove_tags', 'Remove Tags', 'Remove one or more tags from a contact.', 'Contacts', 'contacts.write', [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
    inputField('tags', 'Tags', 'string_list', true, []),
  ], { editor: 'tags' }),
  actionDefinition('ghl.create_note', 'Create Contact Note', 'Add a note to a contact record.', 'Contacts', 'contacts.write', [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
    inputField('body', 'Note', 'textarea', true, ''),
    inputField('userId', 'Author user ID', 'runtime', false, ''),
  ]),
  actionDefinition('ghl.create_task', 'Create Contact Task', 'Create and optionally assign a due-dated task.', 'Contacts', 'contacts.write', [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
    inputField('title', 'Task title', 'text', true, ''),
    inputField('body', 'Task details', 'textarea', false, ''),
    inputField('assignedTo', 'Assigned user ID', 'runtime', false, '{{trigger.assignedTo}}'),
    inputField('dueDate', 'Due date', 'runtime', true, ''),
    inputField('completed', 'Completed', 'boolean', false, false),
  ]),
  actionDefinition('ghl.create_opportunity', 'Create Opportunity', 'Create an opportunity for a contact in a pipeline.', 'Opportunities', 'opportunities.write', [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
    inputField('pipelineId', 'Pipeline ID', 'runtime', true, ''),
    inputField('pipelineStageId', 'Pipeline stage ID', 'runtime', false, ''),
    inputField('name', 'Opportunity name', 'text', true, ''),
    inputField('status', 'Status', 'select', true, 'open', ['open', 'won', 'lost', 'abandoned']),
    inputField('monetaryValue', 'Monetary value', 'number', false, 0),
    inputField('assignedTo', 'Assigned user ID', 'runtime', false, '{{trigger.assignedTo}}'),
  ]),
  actionDefinition('ghl.update_opportunity', 'Update Opportunity', 'Update stage, status, ownership, value, or other opportunity fields.', 'Opportunities', 'opportunities.write', [
    inputField('opportunityId', 'Opportunity ID', 'runtime', true, '{{trigger.opportunity.id}}'),
    inputField('pipelineId', 'Pipeline ID', 'runtime', false, ''),
    inputField('pipelineStageId', 'Pipeline stage ID', 'runtime', false, ''),
    inputField('name', 'Opportunity name', 'text', false, ''),
    inputField('status', 'Status', 'select', false, '', ['', 'open', 'won', 'lost', 'abandoned']),
    inputField('monetaryValue', 'Monetary value', 'number', false, null),
    inputField('assignedTo', 'Assigned user ID', 'runtime', false, ''),
  ]),
  actionDefinition('ghl.send_message', 'Send Message', 'Send an SMS, email, WhatsApp, social, live-chat, or internal message.', 'Conversations', 'conversations/message.write', [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
    inputField('type', 'Channel', 'select', true, 'SMS', ['SMS', 'Email', 'WhatsApp', 'IG', 'FB', 'Custom', 'Live_Chat', 'InternalComment']),
    inputField('message', 'Message', 'textarea', false, ''),
    inputField('subject', 'Email subject', 'text', false, ''),
    inputField('html', 'Email HTML', 'textarea', false, ''),
    inputField('scheduledTimestamp', 'Schedule timestamp', 'number', false, null),
  ]),
  actionDefinition('ghl.create_appointment', 'Create Appointment', 'Book an appointment for a contact on a HighLevel calendar.', 'Calendars', 'calendars/events.write', [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
    inputField('calendarId', 'Calendar ID', 'runtime', true, ''),
    inputField('startTime', 'Start time', 'runtime', true, ''),
    inputField('endTime', 'End time', 'runtime', false, ''),
    inputField('title', 'Title', 'text', false, ''),
    inputField('appointmentStatus', 'Status', 'select', false, 'confirmed', ['new', 'confirmed', 'cancelled', 'showed', 'noshow', 'invalid', 'completed']),
    inputField('assignedUserId', 'Assigned user ID', 'runtime', false, '{{trigger.assignedTo}}'),
    inputField('toNotify', 'Run calendar notifications', 'boolean', false, true),
  ]),
  actionDefinition('ghl.create_object_record', 'Create Object Record', 'Create a record for a discovered custom object schema.', 'Objects', 'objects/record.write', [
    inputField('schemaKey', 'Object schema key', 'object_schema', true, ''),
    inputField('properties', 'Record properties', 'object', true, {}),
  ]),
  actionDefinition('ghl.update_object_record', 'Update Object Record', 'Update an existing custom object record.', 'Objects', 'objects/record.write', [
    inputField('schemaKey', 'Object schema key', 'object_schema', true, ''),
    inputField('recordId', 'Record ID', 'runtime', true, ''),
    inputField('properties', 'Record properties', 'object', true, {}),
  ]),
  actionDefinition('$instance.evaluate_dialer_eligibility', 'Evaluate Dialer Eligibility', 'Fail-closed OWL pre-queue check for lifecycle, every configured phone, DNC, phone channel, configured calendars, marketing hours, and attempt limits. Assignment can be required for strict flows.', 'Instance', null, [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
    inputField('requireAssignment', 'Require an assigned dialer before approval', 'boolean', false, false),
    inputField('enforceMarketingHours', 'Enforce marketing hours before queue enrollment', 'boolean', false, true),
    inputField('scrubAllPhones', 'Scrub and promote an approved phone before evaluation', 'boolean', false, false),
    inputField('requireAlternatePhone', 'Require an approved alternate after a no-answer result', 'boolean', false, false),
  ]),
  actionDefinition('$instance.assign_dialer', 'Assign Dialer', 'Use Assigned Dialer, then record owner, then OWL pool-permitted round robin. Writes the chosen GoHighLevel user ID before queue enrollment.', 'Instance', 'contacts.write', [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
    inputField('servicePool', 'Service pool', 'runtime', true, '{{data.servicePool}}'),
    inputField('assignedDialerFieldId', 'Assigned Dialer field ID', 'text', false, DEFAULT_ASSIGNED_DIALER_FIELD_ID),
  ]),
  actionDefinition('$instance.apply_call_outcome', 'Apply Call Outcome to OWL', 'Write OWL lifecycle after Manual Call: not_interested, scheduled/requested_appointment, invalid, disconnected/non-working phone, closed outcomes, or dnc.', 'Instance', null, [
    inputField('contactId', 'Contact ID', 'runtime', true, '{{trigger.contactId}}'),
    inputField('outcome', 'Call outcome', 'select', true, 'not_interested', [
      'not_interested', 'scheduled', 'requested_appointment', 'invalid',
      'incorrect_number', 'wrong_number', 'no_longer_at_address',
      'disconnected', 'non_working_number', 'phone_disconnected', 'dnc',
      'closed_won', 'converted_sale', 'closed_lost', 'closed_dnq',
    ]),
  ]),
  actionDefinition('data.set', 'Set Flow Data', 'Store a value for later steps in this execution.', 'HAWK', null, [
    inputField('key', 'Data key', 'text', true, 'result'), inputField('value', 'Value', 'runtime', false, '{{trigger.contactId}}'),
  ], { editor: 'data' }),
  actionDefinition('webhook.send', 'Send Webhook', 'Send mapped JSON to a public HTTPS endpoint, including a GoHighLevel inbound-workflow URL.', 'Webhooks', null, [
    inputField('url', 'Destination URL', 'runtime', true, ''),
    inputField('method', 'Method', 'select', true, 'POST', ['POST', 'PUT', 'PATCH']),
    inputField('headers', 'Headers', 'object', false, {}),
    inputField('body', 'JSON body', 'object', false, {}),
    inputField('timeoutMs', 'Timeout (milliseconds)', 'number', false, 10000),
  ]),
  actionDefinition('parrot.run', 'Run PARROT Script', 'Run a reviewed, registered Python handler through the PARROT bridge.', 'PARROT', null, [
    inputField('scriptId', 'Registered script', 'select', true, '', []),
    inputField('scriptVersion', 'Script version', 'text', false, ''),
    inputField('inputs', 'Script inputs', 'object', false, {}),
    inputField('timeoutMs', 'Timeout (milliseconds)', 'number', false, 5000),
  ]),
  actionDefinition('parrot.inline', 'Bundle Python with HAWK', 'Author Python inside this workflow. HAWK dry-runs the source through PARROT and pins its validated hash when the flow is published.', 'PARROT', null, [], { editor:'code' }),
  actionDefinition('code.run', 'Custom Code', 'Run isolated JavaScript or Python transformations.', 'HAWK', null, [], { editor: 'code' }),
]);
function getActionDefinitions() {
  return Object.freeze(BASE_ACTION_DEFINITIONS.map((definition) => {
    if (!definition.id.startsWith('$instance.')) return definition;
    return Object.freeze({ ...definition, id: instanceAction(definition.id.slice('$instance.'.length)) });
  }));
}

function getActionTypes() {
  return Object.freeze(getActionDefinitions().map((item) => item.id));
}
const TRIGGER_DEFINITIONS = Object.freeze([
  triggerDefinition('manual', 'Manual', 'Run from HAWK, API, or a safe replay.', 'HAWK', 'ready'),
  triggerDefinition('webhook.received', 'Webhook Received', 'Run when this flow\'s authenticated HAWK endpoint receives an event.', 'HAWK', 'ready', 'eventName'),
  triggerDefinition('divedeep.customer.linked', 'DiveDeep Customer Linked', 'Run after a verified CRM contact is linked to a DiveDeep customer.', 'DiveDeep', 'ready'),
  triggerDefinition('divedeep.customer.created', 'DiveDeep Customer Created', 'Run when a linked lead becomes a DiveDeep customer.', 'DiveDeep', 'ready'),
  triggerDefinition('divedeep.lifecycle.updated', 'DiveDeep Lifecycle Updated', 'Run when the safe customer lifecycle projection changes.', 'DiveDeep', 'ready'),
  triggerDefinition('divedeep.onboarding.completed', 'DiveDeep Onboarding Completed', 'Run when protected-profile onboarding is complete.', 'DiveDeep', 'ready'),
  triggerDefinition('contact.created', 'Contact Created', 'A new contact record is created.', 'Contact'),
  triggerDefinition('contact.updated', 'Contact Updated', 'A contact record changes.', 'Contact'),
  triggerDefinition('contact.tag_added', 'Tag Added', 'A tag is added to a contact.', 'Contact', 'adapter_required', 'tag'),
  triggerDefinition('contact.tag_removed', 'Tag Removed', 'A tag is removed from a contact.', 'Contact', 'adapter_required', 'tag'),
  triggerDefinition('contact.field_changed', 'Contact Field Changed', 'A selected contact field changes.', 'Contact', 'adapter_required', 'fieldPath'),
  triggerDefinition('contact.dnd_changed', 'Contact DND Changed', 'Contact-level or channel-level DND changes.', 'Contact'),
  triggerDefinition('opportunity.created', 'Opportunity Created', 'A new opportunity is created.', 'Opportunity'),
  triggerDefinition('opportunity.updated', 'Opportunity Updated', 'Any opportunity field changes.', 'Opportunity'),
  triggerDefinition('opportunity.stage_changed', 'Opportunity Stage Changed', 'An opportunity moves between pipeline stages.', 'Opportunity'),
  triggerDefinition('opportunity.status_changed', 'Opportunity Status Changed', 'An opportunity becomes open, won, lost, or abandoned.', 'Opportunity'),
  triggerDefinition('appointment.created', 'Appointment Created', 'A calendar appointment is booked.', 'Appointment'),
  triggerDefinition('appointment.updated', 'Appointment Updated', 'Time, assignee, or appointment status changes.', 'Appointment'),
  triggerDefinition('appointment.deleted', 'Appointment Deleted', 'An appointment is deleted.', 'Appointment'),
  triggerDefinition('task.created', 'Task Created', 'A contact task is created.', 'Task'),
  triggerDefinition('task.completed', 'Task Completed', 'A contact task is completed.', 'Task'),
  triggerDefinition('message.inbound', 'Inbound Message', 'A contact sends an inbound message.', 'Conversation', 'adapter_required', 'channel'),
  triggerDefinition('message.outbound', 'Outbound Message', 'A user or integration sends an outbound message.', 'Conversation', 'adapter_required', 'channel'),
  triggerDefinition('form.submitted', 'Form Submitted', 'A HighLevel form is submitted.', 'Form'),
  triggerDefinition('object.record_created', 'Object Record Created', 'A discovered custom-object record is created.', 'Object', 'adapter_required', 'objectKey'),
  triggerDefinition('object.record_updated', 'Object Record Updated', 'A discovered custom-object record changes.', 'Object', 'adapter_required', 'objectKey'),
]);
const TRIGGER_TYPES = Object.freeze(TRIGGER_DEFINITIONS.map((item) => item.id));
const CONDITION_OPERATORS = Object.freeze([
  'equals', 'not_equals', 'contains', 'not_contains', 'exists', 'not_exists',
  'greater_than', 'less_than', 'in',
]);
const SECRET_KEY_RE = /(?:authorization|cookie|password|secret|token|credential|api[_-]?key)/i;
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_GRAPH_BYTES = 512 * 1024;
const MAX_STORED_BYTES = 64 * 1024;
const MAX_CODE_BYTES = 32 * 1024;
const IMPORT_FORMAT = 'hawk-automation-1';
const STANDARD_FIELD_CATALOG = Object.freeze([
  standardField('contactId', 'Contact ID', 'string', false),
  standardField('name', 'Contact full name', 'string', false),
  standardField('firstName', 'First name'),
  standardField('lastName', 'Last name'),
  standardField('email', 'Email', 'email'),
  standardField('phone', 'Phone', 'phone'),
  standardField('source', 'Source'),
  standardField('tags', 'Tags', 'array'),
  standardField('assignedTo', 'Assigned user ID'),
  standardField('address1', 'Street address'),
  standardField('city', 'City'),
  standardField('state', 'State'),
  standardField('postalCode', 'Postal code'),
  standardField('country', 'Country'),
  standardField('dateAdded', 'Date added', 'datetime', false),
  standardField('serviceType', 'Webhook service type', 'string', false),
  standardField('callOutcome', 'Webhook call outcome', 'string', false),
  standardField('nextCallAt', 'Webhook next call time', 'datetime', false),
  standardField('servicePool', 'Webhook service pool', 'string', false),
  standardField('eventName', 'Webhook event name', 'string', false),
  standardField('customerId', 'DiveDeep customer ID', 'string', false),
  standardField('customerStatus', 'DiveDeep customer status', 'string', false),
  standardField('workflowStatus', 'DiveDeep workflow status', 'string', false),
  standardField('planTier', 'DiveDeep plan tier', 'string', false),
  standardField('onboardingComplete', 'DiveDeep onboarding complete', 'boolean', false),
  standardField('openCustomerActions', 'Open customer actions', 'number', false),
  standardField('pendingDeliveries', 'Pending privacy request deliveries', 'number', false),
  standardField('activeMonitoring', 'Active monitoring schedules', 'number', false),
  standardField('communicationKey', 'SONG communication intent key', 'string', false),
  standardObjectField('opportunity.id', 'Opportunity ID', 'opportunity', 'string', false),
  standardObjectField('opportunity.name', 'Opportunity name', 'opportunity'),
  standardObjectField('opportunity.status', 'Opportunity status', 'opportunity'),
  standardObjectField('opportunity.monetaryValue', 'Opportunity value', 'opportunity', 'number'),
  standardObjectField('appointment.id', 'Appointment ID', 'appointment', 'string', false),
  standardObjectField('appointment.startTime', 'Appointment start', 'appointment', 'datetime', false),
  standardObjectField('form.id', 'Form ID', 'form', 'string', false),
  standardObjectField('form.name', 'Form name', 'form', 'string', false),
]);

function defaultGraph() {
  return normalizeGraph({
    schemaVersion: 1,
    startNodeId: 'trigger',
    nodes: [
      {
        id: 'trigger', type: 'trigger', name: 'Tag added',
        config: { event: 'contact.tag_added', tag: 'new-lead' },
        nextNodeId: 'source_check', position: { x: 390, y: 45 },
      },
      {
        id: 'source_check', type: 'condition', name: 'Lead source is paid',
        config: { field: 'trigger.source', operator: 'in', value: ['Facebook', 'Google'] },
        routes: [
          { label: 'Yes', when: true, targetNodeId: 'add_tag' },
          { label: 'No', when: false, targetNodeId: 'end' },
        ],
        position: { x: 390, y: 190 },
      },
      {
        id: 'add_tag', type: 'action', action: 'ghl.add_tags', name: 'Add processed tag',
        config: { contactId: '{{trigger.contactId}}', tags: ['lead-processed'] },
        nextNodeId: 'end', position: { x: 390, y: 350 },
      },
      {
        id: 'end', type: 'end', name: 'Complete', config: {},
        position: { x: 390, y: 500 },
      },
    ],
  });
}

function normalizeGraph(input = {}) {
  const nodes = Array.isArray(input.nodes) ? input.nodes.slice(0, 101).map(normalizeNode) : [];
  return {
    schemaVersion: Number(input.schemaVersion || 1),
    startNodeId: cleanText(input.startNodeId, 64),
    nodes,
  };
}

function normalizeNode(input = {}, index = 0) {
  const type = cleanText(input.type, 24).toLowerCase();
  const node = {
    id: cleanText(input.id || `step_${index + 1}`, 64),
    type,
    name: cleanText(input.name || `Step ${index + 1}`, 191),
    config: safeData(input.config || {}),
    position: {
      x: clampNumber(input.position?.x, 0, 4800, 320),
      y: clampNumber(input.position?.y, 0, 4800, 80 + index * 140),
    },
  };
  if (type === 'action') node.action = cleanText(input.action, 64);
  if (type === 'condition') {
    node.routes = Array.isArray(input.routes) ? input.routes.slice(0, 4).map((route) => ({
      label: cleanText(route?.label, 64),
      when: Boolean(route?.when),
      targetNodeId: cleanText(route?.targetNodeId, 64),
    })) : [];
  } else if (input.nextNodeId) {
    node.nextNodeId = cleanText(input.nextNodeId, 64);
  }
  return node;
}

function validateGraph(input) {
  const errors = [];
  let graph;
  try {
    graph = normalizeGraph(input);
  } catch (error) {
    return { valid: false, errors: [issue('GRAPH_INVALID', error.message)], stats: { nodes: 0, actions: 0 } };
  }
  const bytes = Buffer.byteLength(JSON.stringify(graph));
  if (bytes > MAX_GRAPH_BYTES) errors.push(issue('GRAPH_TOO_LARGE', 'Graph exceeds 512 KB'));
  if (graph.schemaVersion !== 1) errors.push(issue('SCHEMA_VERSION_UNSUPPORTED', 'schemaVersion must be 1'));
  if (!graph.nodes.length) errors.push(issue('NODES_REQUIRED', 'At least one node is required'));
  if (graph.nodes.length > 100) errors.push(issue('NODE_LIMIT', 'A flow may contain at most 100 nodes'));

  const byId = new Map();
  for (const node of graph.nodes) {
    if (!ID_RE.test(node.id)) errors.push(issue('NODE_ID_INVALID', `Invalid node id: ${node.id || '(empty)'}`, node.id));
    if (byId.has(node.id)) errors.push(issue('NODE_ID_DUPLICATE', `Duplicate node id: ${node.id}`, node.id));
    byId.set(node.id, node);
    if (!NODE_TYPES.includes(node.type)) errors.push(issue('NODE_TYPE_INVALID', `Unsupported node type: ${node.type}`, node.id));
    if (!node.name) errors.push(issue('NODE_NAME_REQUIRED', 'Node name is required', node.id));
    if (node.type === 'trigger' && !TRIGGER_TYPES.includes(node.config?.event || 'manual')) {
      errors.push(issue('TRIGGER_TYPE_INVALID', `Unsupported trigger: ${node.config?.event}`, node.id));
    }
    if (node.type === 'action' && !getActionTypes().includes(node.action)) {
      errors.push(issue('ACTION_TYPE_INVALID', `Unsupported action: ${node.action}`, node.id));
    }
    if (node.type === 'action' && getActionTypes().includes(node.action)) validateActionConfig(node, errors);
    if (node.type === 'action' && node.action === 'code.run') {
      const language = String(node.config?.language || '').toLowerCase();
      if (!['javascript', 'python'].includes(language)) {
        errors.push(issue('CODE_LANGUAGE_INVALID', 'Custom code language must be javascript or python', node.id));
      }
      if (!String(node.config?.code || '').trim()) {
        errors.push(issue('CODE_REQUIRED', 'Custom code is required', node.id));
      } else if (Buffer.byteLength(String(node.config.code)) > MAX_CODE_BYTES) {
        errors.push(issue('CODE_TOO_LARGE', 'Custom code may not exceed 32 KB', node.id));
      }
    }
    if (node.type === 'condition') {
      if (!CONDITION_OPERATORS.includes(node.config?.operator)) {
        errors.push(issue('CONDITION_OPERATOR_INVALID', 'Select a supported condition operator', node.id));
      }
      if (!validRuntimePath(node.config?.field)) {
        errors.push(issue('CONDITION_FIELD_INVALID', 'Condition field must be a safe trigger, data, or steps path', node.id));
      }
      const yes = node.routes?.filter((route) => route.when === true) || [];
      const no = node.routes?.filter((route) => route.when === false) || [];
      if (yes.length !== 1 || no.length !== 1) {
        errors.push(issue('CONDITION_ROUTES_INVALID', 'A condition requires exactly one Yes and one No route', node.id));
      }
    }
    for (const path of templatePaths(node.config)) {
      if (!validRuntimePath(path)) errors.push(issue('TEMPLATE_PATH_INVALID', `Unsafe template path: ${path}`, node.id));
    }
  }

  const start = byId.get(graph.startNodeId);
  if (!start) errors.push(issue('START_NODE_UNKNOWN', 'startNodeId must reference an existing node'));
  else if (start.type !== 'trigger') errors.push(issue('START_NODE_NOT_TRIGGER', 'The start node must be a trigger', start.id));
  if (graph.nodes.filter((node) => node.type === 'trigger').length !== 1) {
    errors.push(issue('TRIGGER_COUNT_INVALID', 'A flow must contain exactly one trigger'));
  }
  if (!graph.nodes.some((node) => node.type === 'end')) errors.push(issue('END_REQUIRED', 'A flow requires an End node'));

  for (const node of graph.nodes) {
    for (const target of targets(node)) {
      if (!byId.has(target)) errors.push(issue('TARGET_UNKNOWN', `Target does not exist: ${target}`, node.id));
    }
    if (!['condition', 'end'].includes(node.type) && !node.nextNodeId) {
      errors.push(issue('NEXT_REQUIRED', 'This node must connect to another step', node.id));
    }
  }

  if (start) {
    const reachable = reachableNodes(graph, byId);
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) errors.push(issue('NODE_UNREACHABLE', 'Node is not reachable from the trigger', node.id));
    }
    if (hasCycle(graph, byId)) errors.push(issue('FLOW_CYCLE', 'Cycles are not supported in Phase 1'));
    const terminalMemo = new Map();
    for (const id of reachable) {
      if (!canReachEnd(id, byId, terminalMemo, new Set())) {
        errors.push(issue('TERMINAL_PATH_MISSING', 'Every path must reach an End node', id));
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    stats: {
      nodes: graph.nodes.length,
      actions: graph.nodes.filter((node) => node.type === 'action').length,
      conditions: graph.nodes.filter((node) => node.type === 'condition').length,
      bytes,
    },
    graph,
  };
}

function targets(node) {
  if (node.type === 'condition') return (node.routes || []).map((route) => route.targetNodeId).filter(Boolean);
  return node.nextNodeId ? [node.nextNodeId] : [];
}

function reachableNodes(graph, byId = new Map(graph.nodes.map((node) => [node.id, node]))) {
  const found = new Set();
  const stack = [graph.startNodeId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || found.has(id) || !byId.has(id)) continue;
    found.add(id);
    stack.push(...targets(byId.get(id)));
  }
  return found;
}

function hasCycle(graph, byId) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id) || !byId.has(id)) return false;
    visiting.add(id);
    if (targets(byId.get(id)).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return visit(graph.startNodeId);
}

function canReachEnd(id, byId, memo, visiting) {
  if (memo.has(id)) return memo.get(id);
  if (visiting.has(id) || !byId.has(id)) return false;
  const node = byId.get(id);
  if (node.type === 'end') return true;
  visiting.add(id);
  const next = targets(node);
  const result = next.length > 0 && next.every((target) => canReachEnd(target, byId, memo, new Set(visiting)));
  memo.set(id, result);
  return result;
}

function validateActionConfig(node, errors) {
  const definition = getActionDefinitions().find((item) => item.id === node.action);
  if (!definition) return;
  for (const field of definition.fields || []) {
    const value = node.config?.[field.key];
    if (field.required && isBlankActionValue(value)) {
      errors.push(issue('ACTION_INPUT_REQUIRED', `${field.label} is required for ${definition.label}`, node.id));
    }
    if (field.kind === 'select' && value != null && value !== '' && field.options?.length && !field.options.includes(value)) {
      errors.push(issue('ACTION_INPUT_INVALID', `${field.label} has an unsupported value`, node.id));
    }
    if (field.kind === 'object' && value != null && (typeof value !== 'object' || Array.isArray(value))) {
      errors.push(issue('ACTION_INPUT_INVALID', `${field.label} must be a JSON object`, node.id));
    }
    if (field.kind === 'string_list' && value != null && !Array.isArray(value)) {
      errors.push(issue('ACTION_INPUT_INVALID', `${field.label} must be an array`, node.id));
    }
  }
  if (node.action === 'ghl.upsert_contact') {
    const fields = node.config?.fields || {};
    if (!fields.email && !fields.phone && !fields.firstName && !fields.name) {
      errors.push(issue('ACTION_INPUT_REQUIRED', 'Create or Update Contact needs at least an email, phone, first name, or name', node.id));
    }
  }
  if (node.action === 'ghl.send_message' && !node.config?.message && !node.config?.html && !node.config?.templateId) {
    errors.push(issue('ACTION_INPUT_REQUIRED', 'Send Message needs message, html, or templateId', node.id));
  }
  if (node.action === 'parrot.run' && !/^[a-z][a-z0-9_.-]{1,95}$/.test(String(node.config?.scriptId || ''))) {
    errors.push(issue('PARROT_SCRIPT_ID_INVALID', 'Select a registered PARROT script', node.id));
  }
  if (node.action === 'parrot.inline') {
    if (node.config?.language && node.config.language !== 'python') errors.push(issue('PARROT_LANGUAGE_INVALID', 'Bundled PARROT source must use Python', node.id));
    if (!String(node.config?.code || '').trim()) errors.push(issue('PARROT_SOURCE_REQUIRED', 'Bundled PARROT source is required', node.id));
    if (Buffer.byteLength(String(node.config?.code || '')) > 128 * 1024) errors.push(issue('PARROT_SOURCE_TOO_LARGE', 'Bundled PARROT source exceeds 128 KiB', node.id));
  }
}

function isBlankActionValue(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

async function listConnections({ apiKeyId, locationId }, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT i.id,i.name,i.provider,i.location_id,i.base_url,i.config_json,i.is_enabled,
            i.credential_updated_at,i.updated_at,g.allow_read,g.allow_import,g.allow_manage_leads
     FROM crm_integrations i
     INNER JOIN crm_integration_grants g ON g.integration_id=i.id
     WHERE g.api_key_id=? AND g.allow_read=1 AND i.location_id=? AND i.is_enabled=1
     ORDER BY i.name`,
    [apiKeyId, locationId]
  );
  return rows.map((row) => ({
    id: row.id, name: row.name, provider: row.provider, locationId: row.location_id,
    baseUrl: row.base_url, isEnabled: Boolean(row.is_enabled),
    capabilities:{ read:Boolean(row.allow_read), import:Boolean(row.allow_import), manageLeads:Boolean(row.allow_manage_leads) },
    credentialUpdatedAt: row.credential_updated_at || null, updatedAt: row.updated_at || null,
  }));
}

async function listFieldCatalog({ apiKeyId, locationId, integrationId = null }, pool = null) {
  requireScope({ apiKeyId, locationId });
  const p = pool || getPool();
  let integrationIds = [];
  if (integrationId) {
    const integration = await getAuthorizedIntegration(integrationId, apiKeyId, 'allow_read', p);
    if (integration.location_id !== locationId) throw statusError('Connection is outside the selected location', 403, 'HAWK_SCOPE_MISMATCH');
    integrationIds = [integrationId];
  } else {
    const [rows] = await p.query(
      `SELECT i.id FROM crm_integrations i
       INNER JOIN crm_integration_grants g ON g.integration_id=i.id
       WHERE g.api_key_id=? AND g.allow_read=1 AND i.location_id=? AND i.is_enabled=1`,
      [apiKeyId, locationId]
    );
    integrationIds = rows.map((row) => row.id).filter(Boolean);
  }
  const fields = STANDARD_FIELD_CATALOG.map((item) => ({ ...item }));
  if (!integrationIds.length) return buildCatalogResult(fields, [], []);
  const placeholders = integrationIds.map(() => '?').join(',');
  const [objectFields] = await p.query(
    `SELECT integration_id,field_id,object_model,field_key,field_name,data_type,metadata_json,last_seen_at
     FROM crm_object_field_definitions
     WHERE integration_id IN (${placeholders}) AND location_id=? AND is_current=1
     ORDER BY object_model,field_name,field_key,field_id`,
    [...integrationIds, locationId]
  );
  const [discoveredFields] = await p.query(
    `SELECT integration_id,field_key,field_label,data_type,last_seen_at
     FROM crm_field_definitions WHERE integration_id IN (${placeholders})
     ORDER BY field_label,field_key`,
    integrationIds
  );
  const [objectDefinitions] = await p.query(
    `SELECT integration_id,object_id,object_key,singular_label,plural_label,is_standard,
            primary_display_property,last_seen_at
     FROM crm_object_definitions
     WHERE integration_id IN (${placeholders}) AND location_id=? AND is_current=1
     ORDER BY is_standard DESC,singular_label,object_key`,
    [...integrationIds, locationId]
  );
  const seen = new Set(fields.map((item) => item.runtimePath));
  for (const row of objectFields) {
    const fieldId = safeFieldIdentifier(row.field_id);
    if (!fieldId) continue;
    const model = cleanText(row.object_model || 'contact', 64).toLowerCase();
    const metadata = parseJson(row.metadata_json, {});
    const runtimePath = `trigger.customFields.${fieldId}`;
    if (seen.has(runtimePath)) continue;
    seen.add(runtimePath);
    fields.push({
      id: `custom:${fieldId}`,
      integrationId: row.integration_id,
      objectModel: model,
      fieldId,
      fieldKey: cleanText(row.field_key, 191) || null,
      label: cleanText(row.field_name || row.field_key || fieldId, 255),
      dataType: normalizeDataType(row.data_type),
      runtimePath,
      template: `{{${runtimePath}}}`,
      writable: ['contact', 'opportunity'].includes(model),
      targetPath: model === 'contact' ? `customFields:${fieldId}` : null,
      allowedValues: allowedValues(metadata),
      source: 'ghl_custom_field',
      lastSeenAt: row.last_seen_at || null,
    });
  }
  for (const row of discoveredFields) {
    const key = safeRuntimeSuffix(row.field_key);
    if (!key) continue;
    const runtimePath = `trigger.${key}`;
    if (seen.has(runtimePath)) continue;
    seen.add(runtimePath);
    fields.push({
      id: `discovered:${key}`,
      integrationId: row.integration_id,
      objectModel: key.split('.')[0] || 'contact',
      fieldId: null,
      fieldKey: cleanText(row.field_key, 191),
      label: cleanText(row.field_label || row.field_key, 255),
      dataType: normalizeDataType(row.data_type),
      runtimePath,
      template: `{{${runtimePath}}}`,
      writable: false,
      targetPath: null,
      allowedValues: [],
      source: 'observed_payload',
      lastSeenAt: row.last_seen_at || null,
    });
  }
  return buildCatalogResult(fields.slice(0, 5000), integrationIds, objectDefinitions);
}

async function refreshFieldCatalog({ apiKeyId, locationId, integrationId }, pool = null) {
  requireScope({ apiKeyId, locationId });
  if (!integrationId) throw statusError('integrationId is required', 400, 'HAWK_CONNECTION_REQUIRED');
  const p = pool || getPool();
  const integration = await getAuthorizedIntegration(integrationId, apiKeyId, 'allow_read', p);
  if (integration.location_id !== locationId) throw statusError('Connection is outside the selected location', 403, 'HAWK_SCOPE_MISMATCH');
  if (!isLeadConnectorConnection(integration)) {
    throw statusError('Live HAWK catalog refresh requires a GoHighLevel Private Integration connection', 409, 'HAWK_GHL_CONNECTION_REQUIRED');
  }
  const sync = await syncCustomFieldDefinitions(integration, p);
  const objects = await syncObjectDefinitions(integration, p);
  return { sync: { ...sync, objects }, catalog: await listFieldCatalog({ apiKeyId, locationId, integrationId }, p) };
}

async function searchTestRecords(input, pool = null, fetchImpl = global.fetch) {
  requireScope(input);
  const p = pool || getPool();
  const source = String(input.source || 'contact_cache').trim();
  const query = cleanText(input.query, 128);
  const limit = Math.floor(clampNumber(input.limit, 1, 20, 10));
  if (source === 'lead') return searchLeadTestRecords(input, query, limit, p);
  if (source === 'appointment') return searchAppointmentTestRecords(input, query, limit, p);
  if (!input.integrationId) throw statusError('Select a GoHighLevel connection to search CRM records', 400, 'HAWK_CONNECTION_REQUIRED');
  const integration = await getAuthorizedIntegration(input.integrationId, input.apiKeyId, 'allow_read', p);
  if (integration.location_id !== input.locationId) throw statusError('Connection is outside the selected location', 403, 'HAWK_SCOPE_MISMATCH');
  if (source === 'contact_cache') return searchCachedContactTestRecords(input, query, limit, p);
  if (!isLeadConnectorConnection(integration)) {
    throw statusError('Live record search requires a GoHighLevel Private Integration connection', 409, 'HAWK_GHL_CONNECTION_REQUIRED');
  }
  const request = await buildTestRecordSearchRequest(source, input, query, limit, p);
  const response = await runGhlReadRequest(integration, request, fetchImpl);
  const records = extractTestRecordArray(response.data, request.resultKeys).slice(0, limit);
  return {
    source, live: true, query, total: records.length,
    records: records.map((record) => publicTestRecord(source, record, request.schemaKey)),
    rateLimit: response.rateLimit,
  };
}

async function searchLeadTestRecords(input, query, limit, corePool) {
  const pool = await operationalPoolFor({ dataSourceSlug:dataSourceSlug(input) }, input.apiKeyId, corePool);
  const params = [input.locationId]; let filter = '';
  if (query) { filter = ' AND (id LIKE ? OR COALESCE(contactData,\'\') LIKE ?)'; params.push(`%${query}%`, `%${query}%`); }
  params.push(limit);
  const [rows] = await pool.query(
    `SELECT id,serviceType,status,contactData,assignedTo,lastContacted,dateAdded
     FROM leads WHERE locationId=?${filter} ORDER BY dateAdded DESC,id LIMIT ?`, params
  );
  return {
    source:'lead', live:false, query, total:rows.length,
    records:rows.map((row) => {
      const contact = parseJson(row.contactData, {});
      return publicTestRecord('contact', {
        ...contact, id:contact.id || row.id, contactId:contact.id || row.id,
        leadId:row.id, serviceType:row.serviceType, leadStatus:row.status,
        assignedTo:row.assignedTo, lastContacted:row.lastContacted, dateAdded:row.dateAdded,
      }, null, { recordId:contact.id || row.id });
    }),
  };
}

async function searchCachedContactTestRecords(input, query, limit, pool) {
  const params = [input.integrationId, input.locationId];
  let filter = '';
  if (query) { filter = ' AND payload_json LIKE ?'; params.push(`%${query}%`); }
  params.push(limit);
  const [rows] = await pool.query(
    `SELECT external_record_id,payload_json,last_seen_at FROM crm_contact_records
     WHERE integration_id=? AND location_id=? AND is_current=1${filter}
     ORDER BY last_seen_at DESC LIMIT ?`, params
  );
  return {
    source:'contact_cache', live:false, query, total:rows.length,
    records:rows.map((row) => publicTestRecord('contact', parseJson(row.payload_json, { id:row.external_record_id }), null, {
      recordId:row.external_record_id, lastSeenAt:row.last_seen_at,
    })),
  };
}

async function searchAppointmentTestRecords(input, query, limit, pool) {
  const params = [input.locationId];
  let filter = '';
  if (query) {
    filter = ` AND (CAST(a.id AS CHAR) LIKE ? OR COALESCE(a.externalEventId,'') LIKE ? OR
      COALESCE(a.externalContactId,'') LIKE ? OR COALESCE(a.calendarId,'') LIKE ? OR COALESCE(l.contactData,'') LIKE ?)`;
    params.push(...Array(5).fill(`%${query}%`));
  }
  params.push(limit);
  const [rows] = await pool.query(
    `SELECT a.id,a.leadId,a.userId,a.calendarId,a.externalEventId,a.externalContactId,a.source,
            a.appointmentDate,a.status,a.createdAt,l.contactData
     FROM appointments a LEFT JOIN leads l ON l.id=a.leadId AND l.locationId=a.locationId
     WHERE a.locationId=?${filter} ORDER BY a.appointmentDate DESC,a.id DESC LIMIT ?`, params
  );
  return {
    source:'appointment', live:false, query, total:rows.length,
    records:rows.map((row) => {
      const contact = parseJson(row.contactData, {});
      const record = {
        ...contact,
        id:String(row.externalEventId || row.id), appointmentId:String(row.externalEventId || row.id),
        leadId:row.leadId || null, contactId:row.externalContactId || contact.id || row.leadId || null,
        userId:row.userId || null, calendarId:row.calendarId || null, startTime:row.appointmentDate,
        appointmentStatus:row.status, status:row.status, source:row.source, createdAt:row.createdAt,
        contact,
      };
      return publicTestRecord('appointment', record);
    }),
  };
}

async function buildTestRecordSearchRequest(source, input, query, limit, pool) {
  const shared = { locationId:input.locationId, query, page:1, pageLimit:limit, limit };
  if (source === 'contact') return { method:'POST', path:'/contacts/search', body:shared, resultKeys:['contacts','records','data','results'] };
  if (source === 'opportunity') return { method:'POST', path:'/opportunities/search', body:shared, resultKeys:['opportunities','records','data','results'] };
  if (!source.startsWith('object:')) throw statusError('Unsupported test record source', 400, 'HAWK_TEST_SOURCE_INVALID');
  const schemaKey = source.slice(7);
  if (!/^[A-Za-z0-9_.-]{1,191}$/.test(schemaKey)) throw statusError('Invalid CRM object key', 400, 'HAWK_TEST_OBJECT_INVALID');
  const [rows] = await pool.query(
    `SELECT object_key FROM crm_object_definitions
     WHERE integration_id=? AND location_id=? AND object_key=? AND is_current=1 LIMIT 1`,
    [input.integrationId, input.locationId, schemaKey]
  );
  if (!rows[0]) throw statusError('CRM object is not available in the selected connection catalog', 404, 'HAWK_TEST_OBJECT_NOT_FOUND');
  return { method:'POST', path:`/objects/${encodeURIComponent(schemaKey)}/records/search`, body:shared,
    resultKeys:['records','data','results'], schemaKey };
}

async function runGhlReadRequest(integration, request, fetchImpl) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(`${String(integration.base_url).replace(/\/$/, '')}${request.path}`, {
      method:request.method,
      headers:{ Accept:'application/json', 'Content-Type':'application/json', Authorization:`Bearer ${integrationCredential(integration)}`, Version:'v3' },
      body:request.body ? JSON.stringify(request.body) : undefined, signal:controller.signal,
    });
    const text = (await response.text()).slice(0, MAX_STORED_BYTES);
    const data = parseJson(text, {});
    const rateLimit = { dailyRemaining:response.headers.get('x-ratelimit-daily-remaining'), intervalRemaining:response.headers.get('x-ratelimit-remaining') };
    if (!response.ok) throw statusError(`GoHighLevel record search returned HTTP ${response.status}`, 502, 'HAWK_GHL_SEARCH_ERROR', { upstreamStatus:response.status, rateLimit });
    return { data:safeData(data), rateLimit };
  } catch (error) {
    if (error.name === 'AbortError') throw statusError('GoHighLevel record search timed out', 504, 'HAWK_GHL_TIMEOUT');
    throw error;
  } finally { clearTimeout(timer); }
}

function extractTestRecordArray(data, keys) {
  for (const key of keys || []) if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data)) return data;
  for (const container of [data?.data, data?.result]) {
    if (Array.isArray(container)) return container;
    for (const key of keys || []) if (Array.isArray(container?.[key])) return container[key];
  }
  return [];
}

function publicTestRecord(source, input, schemaKey = null, metadata = {}) {
  const record = safeData(input && typeof input === 'object' ? input : {});
  const id = String(metadata.recordId || record.id || record._id || record.contactId || record.opportunityId || 'record');
  const contact = record.contact && typeof record.contact === 'object' ? record.contact : null;
  const properties = record.properties && typeof record.properties === 'object' ? record.properties : null;
  const customFields = normalizeCustomFieldValues(record.customFields || properties);
  let payload;
  if (source === 'contact') payload = { ...record, contactId:id, customFields };
  else if (source === 'opportunity') payload = { ...(contact || {}), ...record, opportunityId:id, contactId:record.contactId || contact?.id || null, customFields };
  else if (source === 'appointment') payload = { ...record, appointmentId:record.appointmentId || id };
  else payload = { ...record, recordId:id, schemaKey, customFields:properties || customFields };
  const name = record.name || record.fullName || contact?.name || properties?.name || properties?.title ||
    [record.firstName, record.lastName].filter(Boolean).join(' ') || `${schemaKey || source} ${id}`;
  const subtitle = record.email || contact?.email || record.phone || contact?.phone || record.status ||
    record.appointmentStatus || metadata.lastSeenAt || id;
  return { id, source, schemaKey, title:String(name), subtitle:String(subtitle || ''), payload:safeData(payload) };
}

function normalizeCustomFieldValues(value) {
  if (!value) return {};
  if (!Array.isArray(value)) return value && typeof value === 'object' ? value : {};
  const result = {};
  for (const item of value) {
    const id = safeFieldIdentifier(item?.id || item?.fieldId || item?.key);
    if (id) result[id] = item?.value ?? item?.fieldValue ?? item?.field_value ?? null;
  }
  return result;
}

async function listFlows(scope, pool = null, options = {}) {
  const p = pool || getPool();
  const archivedFilter = options.includeArchived ? '' : " AND f.status<>'archived'";
  const [rows] = await p.query(
    `SELECT f.id,f.api_key_id,f.location_id,f.data_source_slug,f.integration_id,f.name,f.description,f.status,
            f.folder_id,f.color,f.sort_order,f.draft_revision,f.published_version_id,f.created_at,f.updated_at,
            d.name AS folder_name,d.color AS folder_color,
            v.version_number AS published_version_number,v.published_at
     FROM hawk_flows f
     LEFT JOIN hawk_flow_folders d ON d.id=f.folder_id
     LEFT JOIN hawk_flow_versions v ON v.id=f.published_version_id
     WHERE f.api_key_id=? AND f.location_id=? AND f.data_source_slug=?${archivedFilter}
     ORDER BY COALESCE(d.sort_order,2147483647),d.name,f.sort_order,f.updated_at DESC`,
    [scope.apiKeyId, scope.locationId, dataSourceSlug(scope)]
  );
  return rows.map(publicFlowSummary);
}

async function listFlowFolders(scope, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT d.id,d.name,d.description,d.color,d.sort_order,d.created_at,d.updated_at,
            SUM(CASE WHEN f.status<>'archived' THEN 1 ELSE 0 END) AS flow_count
     FROM hawk_flow_folders d LEFT JOIN hawk_flows f ON f.folder_id=d.id AND f.data_source_slug=?
     WHERE d.api_key_id=? AND d.location_id=? AND d.data_source_slug=?
     GROUP BY d.id,d.name,d.description,d.color,d.sort_order,d.created_at,d.updated_at
     ORDER BY d.sort_order,d.name`, [dataSourceSlug(scope), scope.apiKeyId, scope.locationId, dataSourceSlug(scope)]
  );
  return rows.map((row) => ({
    id: row.id, name: row.name, description: row.description || '', color: row.color,
    sortOrder: Number(row.sort_order || 0), flowCount: Number(row.flow_count || 0),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

async function createFlowFolder(input, actor, pool = null) {
  const p = pool || getPool(); requireScope(input);
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO hawk_flow_folders
      (id,api_key_id,location_id,data_source_slug,name,description,color,sort_order,created_by,updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, input.apiKeyId, input.locationId, dataSourceSlug(input), requiredText(input.name, 191, 'name'),
      cleanText(input.description, 500), normalizeColor(input.color, '#2f85de'),
      clampNumber(input.sortOrder, 0, 100000, 0), actor?.id || null, actor?.id || null]
  );
  return (await listFlowFolders(input, p)).find((item) => item.id === id);
}

async function updateFlowFolder(folderId, input, actor, pool = null) {
  const p = pool || getPool(); requireScope(input);
  const [rows] = await p.query(
    'SELECT * FROM hawk_flow_folders WHERE id=? AND api_key_id=? AND location_id=? AND data_source_slug=? LIMIT 1',
    [folderId, input.apiKeyId, input.locationId, dataSourceSlug(input)]
  );
  if (!rows[0]) throw statusError('HAWK flow folder not found', 404, 'HAWK_FOLDER_NOT_FOUND');
  await p.query(
    `UPDATE hawk_flow_folders SET name=?,description=?,color=?,sort_order=?,updated_by=?,updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=? AND api_key_id=? AND location_id=? AND data_source_slug=?`,
    [requiredText(input.name ?? rows[0].name, 191, 'name'), cleanText(input.description ?? rows[0].description, 500),
      normalizeColor(input.color, rows[0].color), clampNumber(input.sortOrder, 0, 100000, rows[0].sort_order || 0),
      actor?.id || null, folderId, input.apiKeyId, input.locationId, dataSourceSlug(input)]
  );
  return (await listFlowFolders(input, p)).find((item) => item.id === folderId);
}

async function deleteFlowFolder(folderId, scope, actor, pool = null) {
  const p = pool || getPool(); requireScope(scope);
  const folders = await listFlowFolders(scope, p);
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) throw statusError('HAWK flow folder not found', 404, 'HAWK_FOLDER_NOT_FOUND');
  await p.query(
    `UPDATE hawk_flows SET folder_id=NULL,updated_by=?,updated_at=CURRENT_TIMESTAMP(3)
     WHERE folder_id=? AND api_key_id=? AND location_id=? AND data_source_slug=?`,
    [actor?.id || null, folderId, scope.apiKeyId, scope.locationId, dataSourceSlug(scope)]
  );
  await p.query('DELETE FROM hawk_flow_folders WHERE id=? AND api_key_id=? AND location_id=? AND data_source_slug=?',
    [folderId, scope.apiKeyId, scope.locationId, dataSourceSlug(scope)]);
  return folder;
}

async function getFlow(flowId, scope, pool = null, options = {}) {
  const p = pool || getPool();
  const suffix = options.forUpdate ? ' FOR UPDATE' : '';
  const [rows] = await p.query(
    `SELECT f.*,d.name AS folder_name,d.color AS folder_color,
            v.version_number AS published_version_number,v.published_at,v.checksum AS published_checksum
     FROM hawk_flows f
     LEFT JOIN hawk_flow_folders d ON d.id=f.folder_id
     LEFT JOIN hawk_flow_versions v ON v.id=f.published_version_id
     WHERE f.id=? AND f.api_key_id=? AND f.location_id=? AND f.data_source_slug=? LIMIT 1${suffix}`,
    [flowId, scope.apiKeyId, scope.locationId, dataSourceSlug(scope)]
  );
  if (!rows[0]) throw statusError('HAWK flow not found', 404, 'HAWK_FLOW_NOT_FOUND');
  return publicFlow(rows[0]);
}

async function createFlow(input, actor, pool = null) {
  const p = pool || getPool();
  requireScope(input);
  const id = crypto.randomUUID();
  const name = requiredText(input.name, 191, 'name');
  const graph = normalizeGraph(input.graph || defaultGraph());
  const validation = validateGraph(graph);
  if (!validation.valid) throw statusError('Flow graph is invalid', 400, 'HAWK_GRAPH_INVALID', validation);
  await assertFolderScope(input.folderId, input, p);
  await p.query(
    `INSERT INTO hawk_flows
       (id,api_key_id,location_id,data_source_slug,integration_id,name,description,folder_id,color,sort_order,status,draft_graph_json,created_by,updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`,
    [id, input.apiKeyId, input.locationId, dataSourceSlug(input), nullableId(input.integrationId), name,
      cleanText(input.description, 1000), nullableId(input.folderId), normalizeColor(input.color, null),
      clampNumber(input.sortOrder, 0, 100000, 0), JSON.stringify(validation.graph), actor?.id || null, actor?.id || null]
  );
  return getFlow(id, input, p);
}

async function updateFlowOrganization(flowId, input, actor, pool = null) {
  const p = pool || getPool(); requireScope(input);
  const current = await getFlow(flowId, input, p);
  const folderId = Object.prototype.hasOwnProperty.call(input, 'folderId') ? input.folderId : current.folderId;
  const color = Object.prototype.hasOwnProperty.call(input, 'color') ? input.color : current.color;
  await assertFolderScope(folderId, input, p);
  await p.query(
    `UPDATE hawk_flows SET name=?,description=?,folder_id=?,color=?,sort_order=?,updated_by=?,updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=? AND api_key_id=? AND location_id=?`,
    [requiredText(input.name ?? current.name, 191, 'name'), cleanText(input.description ?? current.description, 1000),
      nullableId(folderId), normalizeColor(color, current.color),
      clampNumber(input.sortOrder, 0, 100000, current.sortOrder || 0), actor?.id || null,
      flowId, input.apiKeyId, input.locationId]
  );
  return { before: current, after: await getFlow(flowId, input, p) };
}

async function setFlowArchived(flowId, scope, archived, actor, pool = null) {
  const p = pool || getPool(); requireScope(scope);
  const current = await getFlow(flowId, scope, p);
  const status = archived ? 'archived' : (current.publishedVersionId ? 'paused' : 'draft');
  await p.query(
    `UPDATE hawk_flows SET status=?,updated_by=?,updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=? AND api_key_id=? AND location_id=?`,
    [status, actor?.id || null, flowId, scope.apiKeyId, scope.locationId]
  );
  return { before: current, after: await getFlow(flowId, scope, p) };
}

async function saveDraft(flowId, input, actor, pool = null) {
  const p = pool || getPool();
  requireScope(input);
  const current = await getFlow(flowId, input, p);
  const graph = normalizeGraph(input.graph || current.graph);
  const validation = validateGraph(graph);
  if (!validation.valid) throw statusError('Flow graph is invalid', 400, 'HAWK_GRAPH_INVALID', validation);
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw statusError('expectedRevision is required', 400, 'HAWK_REVISION_REQUIRED');
  }
  const [result] = await p.query(
    `UPDATE hawk_flows SET name=?,description=?,integration_id=?,draft_graph_json=?,
       draft_revision=draft_revision+1,updated_by=?,updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=? AND api_key_id=? AND location_id=? AND draft_revision=? AND status<>'archived'`,
    [requiredText(input.name ?? current.name, 191, 'name'), cleanText(input.description ?? current.description, 1000),
      nullableId(input.integrationId ?? current.integrationId), JSON.stringify(validation.graph), actor?.id || null,
      flowId, input.apiKeyId, input.locationId, expectedRevision]
  );
  if (!result.affectedRows) throw statusError('Flow changed in another session', 409, 'HAWK_REVISION_CONFLICT');
  return { before: current, after: await getFlow(flowId, input, p), validation };
}

async function publishFlow(flowId, scope, actor, pool = null) {
  const p = pool || getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const flow = await getFlow(flowId, scope, conn, { forUpdate: true });
    const validation = validateGraph(flow.graph);
    if (!validation.valid) throw statusError('Flow graph is invalid', 409, 'HAWK_GRAPH_INVALID', validation);
    if (validation.graph.nodes.some((node) => node.action?.startsWith('ghl.') || node.action === instanceAction('assign_dialer')) && !flow.integrationId) {
      throw statusError('Select a granted GoHighLevel connection before publishing', 409, 'HAWK_CONNECTION_REQUIRED');
    }
    if (validation.graph.nodes.some((node) => node.action === 'code.run') && !getCodeRunnerConfig().enabled) {
      throw statusError(
        'Custom code steps require an isolated HAWK code runner before publishing',
        409,
        'HAWK_CODE_RUNNER_REQUIRED'
      );
    }
    const parrotNodes = validation.graph.nodes.filter((node) => ['parrot.run', 'parrot.inline'].includes(node.action));
    if (parrotNodes.length) {
      if (!getParrotConfig().enabled) {
        throw statusError(
          'PARROT script steps require the registered Python bridge before publishing',
          409,
          'PARROT_REQUIRED'
        );
      }
      const registered = await parrot.getCatalog();
      registered.scripts = [...registered.scripts, ...await parrotStudio.listCatalog(scope, conn)];
      for (const node of parrotNodes) {
        if (node.action === 'parrot.inline') {
          const sourceValidation = await parrot.validateSource({ source:node.config?.code, capabilities:node.config?.capabilities || [] });
          if (sourceValidation.valid !== true) {
            throw statusError('Bundled PARROT source is invalid', 409, 'PARROT_SOURCE_INVALID', sourceValidation);
          }
          node.config.language = 'python';
          node.config.sourceSha256 = sourceValidation.sha256;
          node.config.capabilities = sourceValidation.capabilities || [];
          continue;
        }
        const script = registered.scripts.find((item) => item.id === node.config?.scriptId);
        if (!script) throw statusError(`PARROT script is not registered: ${node.config?.scriptId}`, 409, 'PARROT_SCRIPT_NOT_REGISTERED');
        if (node.config?.scriptVersion && node.config.scriptVersion !== script.version) {
          throw statusError(`PARROT script version is unavailable: ${node.config.scriptVersion}`, 409, 'PARROT_SCRIPT_VERSION_NOT_FOUND');
        }
      }
    }
    if (flow.integrationId) await getAuthorizedIntegration(flow.integrationId, scope.apiKeyId, 'allow_manage_leads', conn);
    const [versionRows] = await conn.query(
      'SELECT COALESCE(MAX(version_number),0)+1 AS next_version FROM hawk_flow_versions WHERE flow_id=?', [flowId]
    );
    const number = Number(versionRows[0].next_version);
    const id = crypto.randomUUID();
    const graphJson = JSON.stringify(validation.graph);
    const checksum = crypto.createHash('sha256').update(graphJson).digest('hex');
    await conn.query(
      `INSERT INTO hawk_flow_versions (id,flow_id,version_number,graph_json,checksum,published_by)
       VALUES (?,?,?,?,?,?)`,
      [id, flowId, number, graphJson, checksum, actor?.id || null]
    );
    const status = flow.status === 'active' ? 'active' : 'published';
    await conn.query(
      `UPDATE hawk_flows SET published_version_id=?,status=?,updated_by=?,updated_at=CURRENT_TIMESTAMP(3)
       WHERE id=?`,
      [id, status, actor?.id || null, flowId]
    );
    await conn.commit();
    return { flow: await getFlow(flowId, scope, p), version: { id, number, checksum } };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function setFlowState(flowId, scope, state, actor, pool = null) {
  const p = pool || getPool();
  if (!['active', 'paused'].includes(state)) throw statusError('state must be active or paused', 400, 'HAWK_STATE_INVALID');
  const current = await getFlow(flowId, scope, p);
  if (!current.publishedVersionId) throw statusError('Publish the flow before changing its state', 409, 'HAWK_NOT_PUBLISHED');
  await p.query(
    `UPDATE hawk_flows SET status=?,updated_by=?,updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=? AND api_key_id=? AND location_id=?`,
    [state, actor?.id || null, flowId, scope.apiKeyId, scope.locationId]
  );
  return { before: current, after: await getFlow(flowId, scope, p) };
}

async function listVersions(flowId, scope, pool = null) {
  const p = pool || getPool();
  await getFlow(flowId, scope, p);
  const [rows] = await p.query(
    `SELECT id,version_number,checksum,published_by,published_at
     FROM hawk_flow_versions WHERE flow_id=? ORDER BY version_number DESC`, [flowId]
  );
  return rows.map((row) => ({
    id: row.id, versionNumber: row.version_number, checksum: row.checksum,
    publishedBy: row.published_by, publishedAt: row.published_at,
  }));
}

async function executeFlow(flowId, scope, input, options = {}, actor = null, pool = null, fetchImpl = global.fetch) {
  const p = pool || getPool();
  const flow = await getFlow(flowId, scope, p);
  const mode = options.dryRun === false ? 'live' : 'dry_run';
  if (mode === 'live') {
    if (options.confirmLive !== true) throw statusError('Live execution requires confirmLive=true', 400, 'HAWK_LIVE_CONFIRMATION_REQUIRED');
    if (flow.status !== 'active' || !flow.publishedVersionId) {
      throw statusError('Only an active published flow can run live', 409, 'HAWK_FLOW_NOT_ACTIVE');
    }
  }
  let graph = flow.graph;
  let versionId = null;
  if (!options.useDraft && flow.publishedVersionId) {
    const [rows] = await p.query(
      'SELECT graph_json FROM hawk_flow_versions WHERE id=? AND flow_id=? LIMIT 1',
      [flow.publishedVersionId, flow.id]
    );
    if (!rows[0]) throw statusError('Published flow version not found', 409, 'HAWK_VERSION_NOT_FOUND');
    graph = parseJson(rows[0].graph_json, null);
    versionId = flow.publishedVersionId;
  }
  const validation = validateGraph(graph);
  if (!validation.valid) throw statusError('Flow graph is invalid', 409, 'HAWK_GRAPH_INVALID', validation);
  const executionId = crypto.randomUUID();
  const triggerType = validation.graph.nodes.find((node) => node.type === 'trigger')?.config?.event || 'manual';
  const safeInput = safeData(normalizeTriggerData(input || {}));
  const initiatedByType = ['admin', 'system', 'webhook'].includes(options.initiatedByType)
    ? options.initiatedByType
    : (actor ? 'admin' : 'system');
  const initiatedById = cleanText(options.initiatedById || actor?.id, 128) || null;
  await p.query(
    `INSERT INTO hawk_executions
       (id,flow_id,version_id,api_key_id,location_id,data_source_slug,trigger_type,status,mode,idempotency_key,
        replay_of_execution_id,request_id,input_json,steps_total,initiated_by_type,initiated_by_id)
     VALUES (?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?)`,
    [executionId, flow.id, versionId, scope.apiKeyId, scope.locationId, flow.dataSourceSlug, triggerType, mode,
      cleanText(options.idempotencyKey, 191) || null, options.replayOfExecutionId || null,
      cleanText(options.requestId, 64) || null, JSON.stringify(safeInput), validation.stats.nodes,
      initiatedByType, initiatedById]
  );
  await p.query("UPDATE hawk_executions SET status='running',started_at=CURRENT_TIMESTAMP(3) WHERE id=?", [executionId]);

  let cachedIntegration = null;
  let cachedOperationalPool = null;
  const actionRunner = async ({ node, config }) => {
    if (node.action === 'data.set') return { stored: true, key: config.key, value: config.value };
    if (node.action === 'parrot.run') {
      const managed = String(config.scriptId || '').startsWith('custom.')
        ? await parrotStudio.resolveDeployedPackage(scope, config.scriptId, config.scriptVersion || null, p)
        : null;
      if (String(config.scriptId || '').startsWith('custom.') && !managed) {
        throw statusError('Managed PARROT script is not deployed', 409, 'PARROT_SCRIPT_NOT_DEPLOYED');
      }
      return parrot.runScript({
        apiKeyId:scope.apiKeyId,
        locationId:scope.locationId,
        dataSourceSlug:flow.dataSourceSlug,
        source:'hawk',
        mode,
        scriptId:config.scriptId,
        scriptVersion:config.scriptVersion || null,
        inputs:config.inputs || {},
        timeoutMs:config.timeoutMs,
        idempotencyKey:`hawk:${executionId}:${node.id}`,
        ...(managed || {}),
      }, {
        requestId:options.requestId || null,
        actorType:initiatedByType,
        actorId:initiatedById,
        hawkExecutionId:executionId,
        hawkNodeId:node.id,
      }, p, fetchImpl);
    }
    if (node.action === 'parrot.inline') {
      const code = String(config.code || '');
      const sha256 = String(config.sourceSha256 || crypto.createHash('sha256').update(code).digest('hex'));
      const scriptId = `custom.hawk-${String(node.id || 'step').toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 72)}`;
      const version = `hawk.${sha256.slice(0, 12)}`;
      return parrot.runScript({
        apiKeyId:scope.apiKeyId, locationId:scope.locationId, dataSourceSlug:flow.dataSourceSlug,
        source:'hawk', mode, scriptId, scriptVersion:version, inputs:config.inputs || {},
        timeoutMs:config.timeoutMs, idempotencyKey:`hawk:${executionId}:${node.id}`,
        sourcePackage:{ source:code, sha256, version, capabilities:config.capabilities || [], approved:mode === 'live' },
      }, {
        requestId:options.requestId || null, actorType:initiatedByType, actorId:initiatedById,
        hawkExecutionId:executionId, hawkNodeId:node.id,
      }, p, fetchImpl);
    }
    if (mode === 'dry_run') return dryRunAction(node.action, config);
    if (node.action === 'code.run') return runCodeAction(config, fetchImpl);
    if (node.action === 'webhook.send') return runOutboundWebhook(config, fetchImpl);
    if (node.action === instanceAction('evaluate_dialer_eligibility')) {
      if (!cachedOperationalPool) cachedOperationalPool = await operationalPoolFor(flow, scope.apiKeyId, p);
      if (config.scrubAllPhones === true) {
        if (!flow.integrationId) throw statusError('All-phone DNC evaluation requires a GoHighLevel connection', 409, 'HAWK_CONNECTION_REQUIRED');
        if (!cachedIntegration) {
          cachedIntegration = await getAuthorizedIntegration(flow.integrationId, scope.apiKeyId, 'allow_manage_leads', p);
          if (!isLeadConnectorConnection(cachedIntegration)) {
            throw statusError('All-phone DNC evaluation requires a GoHighLevel Private Integration connection', 409, 'HAWK_GHL_CONNECTION_REQUIRED');
          }
        }
      }
      return evaluateDialerEligibility(p, {
        apiKeyId:scope.apiKeyId, locationId:scope.locationId, contactId:config.contactId, fetchImpl,
        operationalPool:cachedOperationalPool, sourceSlug:flow.dataSourceSlug,
        integration:cachedIntegration,
        requireAssignment:config.requireAssignment === true,
        enforceMarketingHours:config.enforceMarketingHours !== false,
        scrubAllPhones:config.scrubAllPhones === true,
        requireAlternatePhone:config.requireAlternatePhone === true,
      });
    }
    if (node.action === instanceAction('assign_dialer')) {
      if (!flow.integrationId) throw statusError('Flow has no GoHighLevel connection', 409, 'HAWK_CONNECTION_REQUIRED');
      if (!cachedIntegration) {
        cachedIntegration = await getAuthorizedIntegration(flow.integrationId, scope.apiKeyId, 'allow_manage_leads', p);
        if (!isLeadConnectorConnection(cachedIntegration)) {
          throw statusError('This action requires a GoHighLevel Private Integration connection', 409, 'HAWK_GHL_CONNECTION_REQUIRED');
        }
      }
      if (!cachedOperationalPool) cachedOperationalPool = await operationalPoolFor(flow, scope.apiKeyId, p);
      return assignDialer(p, {
        apiKeyId:scope.apiKeyId,
        locationId:scope.locationId,
        contactId:config.contactId,
        servicePool:config.servicePool,
        assignedDialerFieldId:config.assignedDialerFieldId,
        sourceSlug:flow.dataSourceSlug,
        integration:cachedIntegration,
        operationalPool:cachedOperationalPool,
        fetchImpl,
      });
    }
    if (node.action === instanceAction('apply_call_outcome')) {
      if (!cachedOperationalPool) cachedOperationalPool = await operationalPoolFor(flow, scope.apiKeyId, p);
      if (flow.integrationId && !cachedIntegration) {
        cachedIntegration = await getAuthorizedIntegration(flow.integrationId, scope.apiKeyId, 'allow_manage_leads', p);
        if (!isLeadConnectorConnection(cachedIntegration)) {
          throw statusError('This action requires a GoHighLevel Private Integration connection', 409, 'HAWK_GHL_CONNECTION_REQUIRED');
        }
      }
      return applyCallCenterOutcome(p, {
        apiKeyId:scope.apiKeyId,
        locationId:scope.locationId,
        contactId:config.contactId,
        outcome:config.outcome || config.poolKey,
        sourceSlug:'core',
        dataSourceSlug:flow.dataSourceSlug || 'dial',
        operationalPool:cachedOperationalPool,
        integration:cachedIntegration,
        fetchImpl,
      });
    }
    if (!flow.integrationId) throw statusError('Flow has no GoHighLevel connection', 409, 'HAWK_CONNECTION_REQUIRED');
    if (!cachedIntegration) {
      cachedIntegration = await getAuthorizedIntegration(flow.integrationId, scope.apiKeyId, 'allow_manage_leads', p);
      if (!isLeadConnectorConnection(cachedIntegration)) {
        throw statusError('This action requires a GoHighLevel Private Integration connection', 409, 'HAWK_GHL_CONNECTION_REQUIRED');
      }
    }
    return runGhlAction(node.action, config, cachedIntegration, fetchImpl);
  };
  const onStep = async (phase, step) => recordExecutionStep(p, executionId, phase, step);

  try {
    const result = await runGraph(validation.graph, safeInput, { mode, actionRunner, onStep });
    await p.query(
      `UPDATE hawk_executions SET status='successful',output_json=?,steps_completed=?,
       completed_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
      [JSON.stringify(safeData(result)), result.steps.length, executionId]
    );
  } catch (error) {
    await p.query(
      `UPDATE hawk_executions SET status='failed',output_json=?,error_code=?,error_message=?,
       steps_completed=?,completed_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
      [JSON.stringify(safeData(error.result || {})), cleanText(error.code || 'HAWK_EXECUTION_FAILED', 64),
        cleanText(error.message, 1000), Number(error.result?.steps?.length || 0), executionId]
    );
  }
  return getExecution(executionId, scope, p);
}

async function runGraph(inputGraph, input, options = {}) {
  const validation = validateGraph(inputGraph);
  if (!validation.valid) throw statusError('Flow graph is invalid', 400, 'HAWK_GRAPH_INVALID', validation);
  const graph = validation.graph;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const context = { trigger: safeData(input || {}), data: {}, steps: {} };
  const steps = [];
  let nodeId = graph.startNodeId;
  for (let transition = 0; nodeId && transition < 100; transition += 1) {
    const node = byId.get(nodeId);
    if (!node) throw statusError(`Node not found: ${nodeId}`, 500, 'HAWK_NODE_NOT_FOUND');
    const started = Date.now();
    const step = { id: crypto.randomUUID(), nodeId: node.id, nodeType: node.type, actionType: node.action || null, status: 'running', input: null };
    await options.onStep?.('start', step);
    try {
      let output;
      if (node.type === 'trigger') {
        output = { accepted: true, event: node.config.event || 'manual' };
        nodeId = node.nextNodeId;
      } else if (node.type === 'condition') {
        const config = renderTemplates(node.config, context);
        const actual = getPath(context, config.field);
        const matched = evaluateCondition(actual, config.operator, config.value);
        output = { field: config.field, matched };
        nodeId = node.routes.find((route) => route.when === matched)?.targetNodeId;
      } else if (node.type === 'action') {
        const config = renderTemplates(node.config, context);
        step.input = node.action === 'webhook.send' ? safeWebhookConfig(config) : safeData(config);
        output = await options.actionRunner({ node, config, context, mode: options.mode || 'dry_run' });
        if (node.action === 'data.set') {
          const key = cleanText(config.key, 64);
          if (!ID_RE.test(key)) throw statusError('data.set key must be a safe identifier', 400, 'HAWK_DATA_KEY_INVALID');
          context.data[key] = safeData(config.value);
        }
        context.steps[node.id] = { response: safeData(output) };
        nodeId = node.nextNodeId;
      } else {
        output = { completed: true };
        nodeId = null;
      }
      step.status = 'successful';
      step.output = safeData(output);
      step.durationMs = Date.now() - started;
      steps.push(step);
      await options.onStep?.('finish', step);
    } catch (error) {
      step.status = 'failed';
      step.errorCode = error.code || 'HAWK_STEP_FAILED';
      step.errorMessage = cleanText(error.message, 1000);
      step.durationMs = Date.now() - started;
      steps.push(step);
      await options.onStep?.('finish', step);
      error.result = { steps, data: context.data, failedNodeId: node.id };
      throw error;
    }
  }
  if (nodeId) throw statusError('Execution exceeded 100 transitions', 409, 'HAWK_TRANSITION_LIMIT');
  return { steps, data: safeData(context.data), completed: true };
}

function dryRunAction(action, config) {
  if (action === instanceAction('evaluate_dialer_eligibility')) {
    return { dryRun:true, action, eligible:false, reason:'dry_run_requires_live_authority', contactId:config.contactId };
  }
  if (action === 'webhook.send') {
    return { dryRun:true, action, method:String(config.method || 'POST').toUpperCase(), destination:maskWebhookUrl(config.url), body:safeData(config.body || {}) };
  }
  if (action === instanceAction('assign_dialer')) {
    return { dryRun:true, action, contactId:config.contactId, servicePool:config.servicePool, assignment:'not_mutated' };
  }
  if (action === instanceAction('apply_call_outcome')) {
    return {
      dryRun:true,
      action,
      contactId:config.contactId,
      outcome:config.outcome || config.poolKey || null,
      lifecycle:'not_mutated',
    };
  }
  if (!action.startsWith('ghl.')) return { dryRun: true, action, config: safeData(config) };
  const request = buildGhlRequest(action, config, { location_id: 'locationId' });
  return { dryRun: true, action, method: request.method, path: request.path, body: safeData(request.body) };
}

async function runOutboundWebhook(config, fetchImpl = global.fetch, lookupImpl = dns.lookup) {
  const url = await validateOutboundWebhookUrl(config.url, lookupImpl);
  const method = String(config.method || 'POST').toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(method)) throw statusError('Webhook method must be POST, PUT, or PATCH', 400, 'HAWK_WEBHOOK_METHOD_INVALID');
  const headers = objectValue(config.headers);
  const blocked = /^(?:host|content-length|connection|transfer-encoding|cookie|set-cookie)$/i;
  const cleanHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = cleanText(key, 64);
    if (!name || blocked.test(name)) continue;
    cleanHeaders[name] = cleanText(value, 2048);
  }
  const timeoutMs = clampNumber(config.timeoutMs, 500, 30000, 10000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method,
      headers:{ Accept:'application/json', 'Content-Type':'application/json', ...cleanHeaders },
      body:JSON.stringify(objectValue(config.body)),
      signal:controller.signal,
      redirect:'error',
    });
    const text = (await response.text()).slice(0, MAX_STORED_BYTES);
    const payload = parseJson(text, text || null);
    if (!response.ok) {
      const error = statusError(`Webhook receiver returned HTTP ${response.status}`, 502, 'HAWK_WEBHOOK_HTTP_ERROR', { upstreamStatus:response.status });
      error.upstream = safeData(payload);
      throw error;
    }
    return { status:response.status, data:safeData(payload) };
  } catch (error) {
    if (error.name === 'AbortError') throw statusError('Webhook request timed out', 504, 'HAWK_WEBHOOK_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function validateOutboundWebhookUrl(value, lookupImpl = dns.lookup) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw statusError('Webhook destination must be a valid URL', 400, 'HAWK_WEBHOOK_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw statusError('Webhook destinations must use HTTPS without embedded credentials', 400, 'HAWK_WEBHOOK_URL_INVALID');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw statusError('Webhook destination must use a public host', 400, 'HAWK_WEBHOOK_HOST_BLOCKED');
  }
  const addresses = net.isIP(hostname)
    ? [{ address:hostname }]
    : await lookupImpl(hostname, { all:true, verbatim:true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
    throw statusError('Webhook destination resolves to a blocked network', 400, 'HAWK_WEBHOOK_HOST_BLOCKED');
  }
  return url;
}

function isPrivateAddress(value) {
  const ip = String(value || '').toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip)) return true;
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? isPrivateAddress(mapped) : false;
  }
  return true;
}

function safeWebhookConfig(config) {
  return safeData({ ...config, url:maskWebhookUrl(config.url), headers:Object.fromEntries(Object.keys(objectValue(config.headers)).map((key) => [key, '[redacted]'])) });
}

function maskWebhookUrl(value) {
  try { const url = new URL(String(value || '')); url.search = url.search ? '?[redacted]' : ''; url.hash = ''; return url.toString(); }
  catch { return '[invalid webhook URL]'; }
}

async function runGhlAction(action, config, integration, fetchImpl) {
  const { method, path, body } = buildGhlRequest(action, config, integration);
  const url = `${String(integration.base_url).replace(/\/$/, '')}${path}`;
  const integrationConfig = parseJson(integration.config_json, {});
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${integrationCredential(integration)}`,
    Version: cleanText(integrationConfig.hawkVersions?.[action] || integrationConfig.hawkVersion || 'v3', 32),
  };
  const requestBody = JSON.stringify(body);
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetchImpl(url, { method, headers, body:requestBody, signal:controller.signal });
      const text = (await response.text()).slice(0, MAX_STORED_BYTES);
      const payload = parseJson(text, text || null);
      const rateLimit = {
        dailyRemaining: response.headers.get('x-ratelimit-daily-remaining'),
        intervalRemaining: response.headers.get('x-ratelimit-remaining'),
        retryAfter: response.headers.get('retry-after'),
      };
      if (response.ok) return { status: response.status, data: safeData(payload), rateLimit, attempts:attempt };

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await waitForGhlRetry(response.headers.get('retry-after'), attempt);
        continue;
      }

      const error = statusError(`GoHighLevel returned HTTP ${response.status}`, 502, 'HAWK_GHL_HTTP_ERROR', {
        upstreamStatus: response.status, rateLimit, attempts:attempt,
      });
      error.upstream = safeData(payload);
      throw error;
    } catch (error) {
      if (error.name === 'AbortError') throw statusError('GoHighLevel request timed out', 504, 'HAWK_GHL_TIMEOUT');
      if (isRetryableGhlTransportError(error) && attempt < maxAttempts) {
        await waitForGhlRetry(null, attempt);
        continue;
      }
      if (isRetryableGhlTransportError(error)) {
        throw statusError('GoHighLevel could not be reached after retrying', 502, 'HAWK_GHL_NETWORK_ERROR', {
          attempts:attempt,
          causeCode:cleanText(error?.cause?.code || error?.code, 64) || null,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRetryableGhlTransportError(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  if (['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return true;
  return error?.name === 'TypeError' && /fetch failed|network/i.test(String(error?.message || ''));
}

async function waitForGhlRetry(retryAfter, attempt) {
  const raw = String(retryAfter || '').trim();
  const seconds = raw ? Number(raw) : NaN;
  const dateDelay = raw && !Number.isFinite(seconds) ? Date.parse(raw) - Date.now() : NaN;
  const headerDelay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : dateDelay;
  const fallbackDelay = (2 ** attempt) * 1000;
  const delay = Math.min(Math.max(Number.isFinite(headerDelay) ? headerDelay : fallbackDelay, 100), 10000);
  const jitter = Math.floor(Math.random() * 251);
  await new Promise((resolve) => setTimeout(resolve, delay + jitter));
}

function buildGhlRequest(action, config = {}, integration = {}) {
  const locationId = requiredPathSegment(integration.location_id || 'locationId', 'locationId');
  if (action === 'ghl.update_contact') {
    const contactId = requiredPathSegment(config.contactId, 'contactId');
    return request('PUT', `/contacts/${encodeURIComponent(contactId)}`, objectValue(config.fields));
  }
  if (action === 'ghl.upsert_contact') {
    return request('POST', '/contacts/upsert', { ...objectValue(config.fields), locationId });
  }
  if (action === 'ghl.add_tags' || action === 'ghl.remove_tags') {
    const contactId = requiredPathSegment(config.contactId, 'contactId');
    const tags = stringList(config.tags, 'At least one tag is required');
    return request(action === 'ghl.add_tags' ? 'POST' : 'DELETE', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags });
  }
  if (action === 'ghl.create_note') {
    const contactId = requiredPathSegment(config.contactId, 'contactId');
    return request('POST', `/contacts/${encodeURIComponent(contactId)}/notes`, compactBody({ body: requiredActionString(config.body, 'body'), userId: config.userId }));
  }
  if (action === 'ghl.create_task') {
    const contactId = requiredPathSegment(config.contactId, 'contactId');
    return request('POST', `/contacts/${encodeURIComponent(contactId)}/tasks`, compactBody({
      title: requiredActionString(config.title, 'title'), body: config.body, assignedTo: config.assignedTo,
      dueDate: requiredActionString(config.dueDate, 'dueDate'), completed: Boolean(config.completed),
    }));
  }
  if (action === 'ghl.create_opportunity') {
    return request('POST', '/opportunities/', compactBody({
      pipelineId: requiredActionString(config.pipelineId, 'pipelineId'), locationId,
      name: requiredActionString(config.name, 'name'), pipelineStageId: config.pipelineStageId,
      status: config.status || 'open', contactId: requiredActionString(config.contactId, 'contactId'),
      monetaryValue: config.monetaryValue, assignedTo: config.assignedTo, source: config.source,
      customFields: config.customFields,
    }));
  }
  if (action === 'ghl.update_opportunity') {
    const opportunityId = requiredPathSegment(config.opportunityId, 'opportunityId');
    return request('PUT', `/opportunities/${encodeURIComponent(opportunityId)}`, compactBody({
      pipelineId: config.pipelineId, pipelineStageId: config.pipelineStageId, name: config.name,
      status: config.status, monetaryValue: config.monetaryValue, assignedTo: config.assignedTo,
      forecastExpectedCloseDate: config.forecastExpectedCloseDate, forecastProbability: config.forecastProbability,
      customFields: config.customFields,
    }));
  }
  if (action === 'ghl.send_message') {
    if (!String(config.message || '').trim() && !String(config.html || '').trim() && !String(config.templateId || '').trim()) {
      throw statusError('message, html, or templateId is required', 400, 'HAWK_ACTION_INPUT_INVALID');
    }
    return request('POST', '/conversations/messages', compactBody({
      type: config.type || 'SMS', contactId: requiredActionString(config.contactId, 'contactId'),
      message: config.message, subject: config.subject, html: config.html, templateId: config.templateId,
      scheduledTimestamp: config.scheduledTimestamp, status: config.status || 'pending',
    }));
  }
  if (action === 'ghl.create_appointment') {
    return request('POST', '/calendars/events/appointments', compactBody({
      calendarId: requiredActionString(config.calendarId, 'calendarId'), locationId,
      contactId: requiredActionString(config.contactId, 'contactId'), startTime: requiredActionString(config.startTime, 'startTime'),
      endTime: config.endTime, title: config.title, appointmentStatus: config.appointmentStatus || 'confirmed',
      assignedUserId: config.assignedUserId, description: config.description, address: config.address,
      toNotify: config.toNotify !== false, ignoreDateRange: Boolean(config.ignoreDateRange),
      ignoreFreeSlotValidation: Boolean(config.ignoreFreeSlotValidation),
    }));
  }
  if (action === 'ghl.create_object_record' || action === 'ghl.update_object_record') {
    const schemaKey = requiredSchemaKey(config.schemaKey);
    const suffix = action === 'ghl.update_object_record' ? `/${encodeURIComponent(requiredPathSegment(config.recordId, 'recordId'))}` : '';
    return request(action === 'ghl.create_object_record' ? 'POST' : 'PUT',
      `/objects/${encodeURIComponent(schemaKey)}/records${suffix}?locationId=${encodeURIComponent(locationId)}`, objectValue(config.properties));
  }
  throw statusError(`Unsupported GoHighLevel action: ${action}`, 400, 'HAWK_ACTION_UNSUPPORTED');
}

function request(method, path, body) { return { method, path, body }; }
function objectValue(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function compactBody(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}
function stringList(value, message) {
  const result = Array.isArray(value) ? value.map((item) => cleanText(item, 191)).filter(Boolean) : [];
  if (!result.length) throw statusError(message, 400, 'HAWK_TAGS_REQUIRED');
  return result;
}
function requiredActionString(value, label) {
  const text = String(value == null ? '' : value).trim().slice(0, 16000);
  if (!text) throw statusError(`${label} is required`, 400, 'HAWK_ACTION_INPUT_INVALID');
  return text;
}
function requiredSchemaKey(value) {
  const text = String(value || '').trim();
  if (!/^(?:custom_objects|business)\.[A-Za-z0-9_-]{1,160}$/.test(text)) {
    throw statusError('schemaKey must be a discovered custom_objects.* or business.* key', 400, 'HAWK_ACTION_INPUT_INVALID');
  }
  return text;
}

async function runCodeAction(config, fetchImpl = global.fetch) {
  const runner = getCodeRunnerConfig();
  if (!runner.enabled) throw statusError('Isolated HAWK code runner is not configured', 409, 'HAWK_CODE_RUNNER_REQUIRED');
  const language = String(config.language || '').toLowerCase();
  if (!['javascript', 'python'].includes(language)) throw statusError('Unsupported custom code language', 400, 'HAWK_CODE_LANGUAGE_INVALID');
  const code = String(config.code || '');
  if (!code.trim() || Buffer.byteLength(code) > MAX_CODE_BYTES) throw statusError('Custom code must contain 1-32768 bytes', 400, 'HAWK_CODE_INVALID');
  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(Number(config.timeoutMs) || runner.timeoutMs, 100), runner.timeoutMs);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(runner.url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(runner.token ? { Authorization: `Bearer ${runner.token}` } : {}),
      },
      body: JSON.stringify({
        runtime: language,
        code,
        inputs: safeData(config.inputs || {}),
        limits: { timeoutMs, outputBytes: MAX_STORED_BYTES, network: false },
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    const text = (await response.text()).slice(0, MAX_STORED_BYTES);
    const payload = parseJson(text, { output: text });
    if (!response.ok) throw statusError(`HAWK code runner returned HTTP ${response.status}`, 502, 'HAWK_CODE_RUNNER_HTTP_ERROR', safeData(payload));
    return safeData(payload);
  } catch (error) {
    if (error.name === 'AbortError') throw statusError('HAWK code step timed out', 504, 'HAWK_CODE_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getCodeRunnerConfig() {
  const raw = String(process.env.HAWK_CODE_RUNNER_URL || '').trim();
  if (!raw) return { enabled: false, url: '', token: '', timeoutMs: 5000 };
  let url;
  try { url = new URL(raw); } catch { return { enabled: false, url: '', token: '', timeoutMs: 5000, error: 'invalid_url' }; }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { enabled: false, url: '', token: '', timeoutMs: 5000, error: 'https_required' };
  }
  const requested = Number(process.env.HAWK_CODE_RUNNER_TIMEOUT_MS || 5000);
  return {
    enabled: true,
    url: url.toString(),
    token: String(process.env.HAWK_CODE_RUNNER_TOKEN || '').trim(),
    timeoutMs: Number.isFinite(requested) ? Math.min(Math.max(requested, 100), 30000) : 5000,
  };
}

async function recordExecutionStep(pool, executionId, phase, step) {
  if (phase === 'start') {
    await pool.query(
      `INSERT INTO hawk_execution_steps
         (id,execution_id,node_id,node_type,action_type,status,input_json)
       VALUES (?,?,?,?,?,'running',?)`,
      [step.id, executionId, step.nodeId, step.nodeType, step.actionType, JSON.stringify(safeData(step.input))]
    );
    return;
  }
  await pool.query(
    `UPDATE hawk_execution_steps SET status=?,input_json=?,output_json=?,error_code=?,error_message=?,
       duration_ms=?,completed_at=CURRENT_TIMESTAMP(3) WHERE id=? AND execution_id=?`,
    [step.status, JSON.stringify(safeData(step.input)), JSON.stringify(safeData(step.output)),
      step.errorCode || null, step.errorMessage || null, step.durationMs || 0, step.id, executionId]
  );
}

async function listExecutions(scope, filters = {}, pool = null) {
  const p = pool || getPool();
  const where = ['e.api_key_id=?', 'e.location_id=?', 'e.data_source_slug=?'];
  const params = [scope.apiKeyId, scope.locationId, dataSourceSlug(scope)];
  if (filters.flowId) { where.push('e.flow_id=?'); params.push(filters.flowId); }
  if (filters.status) { where.push('e.status=?'); params.push(filters.status); }
  const limit = clampNumber(filters.limit, 1, 200, 50);
  params.push(limit);
  const [rows] = await p.query(
    `SELECT e.id,e.flow_id,e.version_id,e.data_source_slug,e.trigger_type,e.status,e.mode,e.replay_of_execution_id,
            e.steps_total,e.steps_completed,e.error_code,e.started_at,e.completed_at,e.created_at,f.name AS flow_name
     FROM hawk_executions e INNER JOIN hawk_flows f ON f.id=e.flow_id
     WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT ?`, params
  );
  return rows.map(publicExecutionSummary);
}

async function getExecution(id, scope, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT e.*,f.name AS flow_name FROM hawk_executions e
     INNER JOIN hawk_flows f ON f.id=e.flow_id
     WHERE e.id=? AND e.api_key_id=? AND e.location_id=? AND e.data_source_slug=? LIMIT 1`,
    [id, scope.apiKeyId, scope.locationId, dataSourceSlug(scope)]
  );
  if (!rows[0]) throw statusError('HAWK execution not found', 404, 'HAWK_EXECUTION_NOT_FOUND');
  const [steps] = await p.query(
    `SELECT id,node_id,node_type,action_type,attempt_number,status,input_json,output_json,
            error_code,error_message,duration_ms,started_at,completed_at
     FROM hawk_execution_steps WHERE execution_id=? ORDER BY started_at,id`, [id]
  );
  return {
    ...publicExecutionSummary(rows[0]),
    requestId: rows[0].request_id,
    idempotencyKey: rows[0].idempotency_key,
    input: parseJson(rows[0].input_json, {}),
    output: parseJson(rows[0].output_json, {}),
    errorMessage: rows[0].error_message,
    initiatedBy: { type: rows[0].initiated_by_type, id: rows[0].initiated_by_id },
    steps: steps.map((step) => ({
      id: step.id, nodeId: step.node_id, nodeType: step.node_type, actionType: step.action_type,
      attemptNumber: step.attempt_number, status: step.status,
      input: parseJson(step.input_json, null), output: parseJson(step.output_json, null),
      errorCode: step.error_code, errorMessage: step.error_message, durationMs: step.duration_ms,
      startedAt: step.started_at, completedAt: step.completed_at,
    })),
  };
}

async function replayExecution(id, scope, options, actor, pool = null, fetchImpl = global.fetch) {
  const previous = await getExecution(id, scope, pool);
  return executeFlow(previous.flowId, scope, previous.input, {
    dryRun: options?.dryRun !== false,
    confirmLive: options?.confirmLive === true,
    useDraft: false,
    replayOfExecutionId: previous.id,
    requestId: options?.requestId,
  }, actor, pool, fetchImpl);
}

function renderTemplates(value, context) {
  if (Array.isArray(value)) return value.map((item) => renderTemplates(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplates(item, context)]));
  }
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/);
  if (exact) return getPath(context, exact[1]);
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, path) => {
    const resolved = getPath(context, path);
    return resolved == null ? '' : typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
  });
}

function templatePaths(value, output = []) {
  if (Array.isArray(value)) value.forEach((item) => templatePaths(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => templatePaths(item, output));
  else if (typeof value === 'string') {
    for (const match of value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) output.push(match[1]);
  }
  return output;
}

function validRuntimePath(value) {
  const path = String(value || '').trim();
  if (!/^(trigger|data|steps)(?:\.[A-Za-z0-9_-]+)+$/.test(path)) return false;
  return !path.split('.').some((part) => SECRET_KEY_RE.test(part));
}

function getPath(object, path) {
  if (!validRuntimePath(path)) return undefined;
  return String(path).split('.').reduce((value, key) => value == null ? undefined : value[key], object);
}

function evaluateCondition(actual, operator, expected) {
  if (operator === 'exists') return actual !== undefined && actual !== null && actual !== '';
  if (operator === 'not_exists') return actual === undefined || actual === null || actual === '';
  if (operator === 'equals') return String(actual ?? '') === String(expected ?? '');
  if (operator === 'not_equals') return String(actual ?? '') !== String(expected ?? '');
  if (operator === 'contains') return Array.isArray(actual) ? actual.map(String).includes(String(expected)) : String(actual ?? '').includes(String(expected ?? ''));
  if (operator === 'not_contains') return !evaluateCondition(actual, 'contains', expected);
  if (operator === 'greater_than') return Number(actual) > Number(expected);
  if (operator === 'less_than') return Number(actual) < Number(expected);
  if (operator === 'in') return (Array.isArray(expected) ? expected : [expected]).map(String).includes(String(actual));
  return false;
}

function normalizeTriggerData(input) {
  const output = input && typeof input === 'object' && !Array.isArray(input) ? structuredClone(input) : {};
  const collections = [];
  if (Array.isArray(output.customFields)) collections.push(output.customFields);
  if (Array.isArray(output.contact?.customFields)) collections.push(output.contact.customFields);
  if (collections.length) {
    const normalized = {};
    for (const collection of collections) {
      for (const item of collection) {
        const id = safeFieldIdentifier(item?.id || item?.fieldId || item?.key);
        if (!id) continue;
        normalized[id] = item?.value ?? item?.fieldValue ?? item?.field_value ?? null;
      }
    }
    output.customFields = normalized;
  }
  return output;
}

function buildImportPreview(payload, catalog = { fields: [] }) {
  const flows = normalizeImportPackage(payload);
  const paths = new Set((catalog.fields || []).map((item) => item.runtimePath));
  const targetIds = new Set((catalog.fields || []).filter((item) => item.writable).map((item) => item.fieldId).filter(Boolean));
  const objectKeys = new Set((catalog.objects || []).map((item) => item.id).filter(Boolean));
  return flows.map((flow, index) => {
    const validation = validateGraph(flow.graph);
    const catalogIssues = [];
    for (const node of validation.graph?.nodes || []) {
      for (const path of templatePaths(node.config)) {
        if (path.startsWith('trigger.') && paths.size && !paths.has(path)) {
          catalogIssues.push(issue('CATALOG_PATH_UNKNOWN', `Runtime field is not in the live CRM catalog: ${path}`, node.id));
        }
      }
      if (node.type === 'condition' && node.config?.field?.startsWith('trigger.') && paths.size && !paths.has(node.config.field)) {
        catalogIssues.push(issue('CATALOG_PATH_UNKNOWN', `Condition field is not in the live CRM catalog: ${node.config.field}`, node.id));
      }
      if (['ghl.update_contact', 'ghl.upsert_contact'].includes(node.action)) {
        for (const custom of Array.isArray(node.config?.fields?.customFields) ? node.config.fields.customFields : []) {
          const fieldId = safeFieldIdentifier(custom?.id || custom?.fieldId);
          if (fieldId && targetIds.size && !targetIds.has(fieldId)) {
            catalogIssues.push(issue('CATALOG_TARGET_UNKNOWN', `Writable custom field is not in the live CRM catalog: ${fieldId}`, node.id));
          }
        }
      }
      if (['ghl.create_object_record', 'ghl.update_object_record'].includes(node.action)) {
        const schemaKey = String(node.config?.schemaKey || '');
        if (schemaKey && objectKeys.size && !objectKeys.has(schemaKey)) {
          catalogIssues.push(issue('CATALOG_OBJECT_UNKNOWN', `Object schema is not in the live CRM catalog: ${schemaKey}`, node.id));
        }
      }
    }
    return {
      index,
      name: flow.name,
      description: flow.description,
      integrationId: flow.integrationId,
      graph: validation.graph || flow.graph,
      validation: {
        ...validation,
        valid: validation.valid && catalogIssues.length === 0,
        errors: [...validation.errors, ...catalogIssues],
      },
    };
  });
}

function normalizeImportPackage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw statusError('HAWK import must be a JSON object', 400, 'HAWK_IMPORT_INVALID');
  }
  if (payload.format !== IMPORT_FORMAT) {
    throw statusError(`format must be ${IMPORT_FORMAT}`, 400, 'HAWK_IMPORT_FORMAT_INVALID');
  }
  if (!Array.isArray(payload.flows) || !payload.flows.length || payload.flows.length > 50) {
    throw statusError('flows must contain 1-50 automations', 400, 'HAWK_IMPORT_FLOWS_INVALID');
  }
  return payload.flows.map((flow, index) => ({
    name: requiredText(flow?.name, 191, `flows[${index}].name`),
    description: cleanText(flow?.description, 1000),
    integrationId: nullableId(flow?.integrationId),
    graph: normalizeGraph(flow?.graph || {}),
  }));
}

function buildExportPackage(flow) {
  if (!flow || typeof flow !== 'object') {
    throw statusError('HAWK flow is required for export', 400, 'HAWK_EXPORT_FLOW_REQUIRED');
  }
  const validation = validateGraph(flow.graph || {});
  if (!validation.valid) {
    throw statusError('Flow graph is invalid and cannot be exported', 409, 'HAWK_GRAPH_INVALID', validation);
  }
  return {
    format: IMPORT_FORMAT,
    generatedFor: {
      locationId: flow.locationId || null,
      dataSourceSlug: flow.dataSourceSlug || 'core',
      flowId: flow.id || null,
      draftRevision: Number(flow.draftRevision || 1),
      status: flow.status || 'draft',
      publishedVersionNumber: flow.publishedVersionNumber || null,
      exportedAt: new Date().toISOString(),
      source: 'hawk-flow-code',
    },
    flows: [{
      name: requiredText(flow.name, 191, 'name'),
      description: cleanText(flow.description, 1000),
      integrationId: nullableId(flow.integrationId),
      graph: validation.graph,
    }],
  };
}

function buildImportSchema(catalog = { fields: [], objects: [] }) {
  const runtimePaths = [...new Set((catalog.fields || []).map((item) => item.runtimePath).filter(Boolean))];
  const writableFields = (catalog.fields || []).filter((item) => item.writable);
  const customFieldIds = [...new Set(writableFields.map((item) => item.fieldId).filter(Boolean))];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: schemaUrn('hawk-automation-import'),
    title: 'HAWK automation import',
    type: 'object',
    additionalProperties: false,
    required: ['format', 'flows'],
    properties: {
      format: { const: IMPORT_FORMAT },
      generatedFor: { type: 'object' },
      flows: { type: 'array', minItems: 1, maxItems: 50, items: { $ref: '#/$defs/flow' } },
    },
    $defs: {
      runtimePath: { type: 'string', enum: runtimePaths },
      customFieldId: { type: 'string', enum: customFieldIds },
      flow: {
        type: 'object', additionalProperties: false, required: ['name', 'graph'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 191 },
          description: { type: 'string', maxLength: 1000 },
          integrationId: { type: ['string', 'null'] },
          graph: { $ref: '#/$defs/graph' },
        },
      },
      graph: {
        type: 'object', additionalProperties: false, required: ['schemaVersion', 'startNodeId', 'nodes'],
        properties: {
          schemaVersion: { const: 1 },
          startNodeId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' },
          nodes: { type: 'array', minItems: 2, maxItems: 100, items: { $ref: '#/$defs/node' } },
        },
      },
      node: {
        type: 'object', required: ['id', 'type', 'name', 'config', 'position'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' },
          type: { enum: NODE_TYPES },
          action: { enum: getActionTypes() },
          name: { type: 'string', minLength: 1, maxLength: 191 },
          config: { type: 'object' },
          nextNodeId: { type: 'string' },
          routes: { type: 'array' },
          position: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
        },
      },
    },
    'x-hawk-catalog': {
      generatedAt: new Date().toISOString(),
      objects: catalog.objects || [],
      runtimeFields: (catalog.fields || []).map((item) => ({
        label: item.label, objectModel: item.objectModel, runtimePath: item.runtimePath,
        template: item.template, fieldId: item.fieldId, fieldKey: item.fieldKey,
        dataType: item.dataType, allowedValues: item.allowedValues || [], writable: item.writable,
      })),
      actionTypes: getActionTypes(),
      triggerTypes: TRIGGER_TYPES,
      actionDefinitions: getActionDefinitions(),
      triggerDefinitions: TRIGGER_DEFINITIONS,
      conditionOperators: CONDITION_OPERATORS,
      customFieldIds,
    },
  };
}

function actionDefinition(id, label, description, group, scope, fields = [], options = {}) {
  return Object.freeze({ id, label, description, group, scope, fields, ready: true, ...options });
}

function inputField(key, label, kind, required = false, defaultValue = '', options = []) {
  return Object.freeze({ key, label, kind, required, defaultValue, options });
}

function triggerDefinition(id, label, description, object, readiness = 'adapter_required', filterKey = null) {
  return Object.freeze({ id, label, description, object, readiness, delivery: id === 'manual' ? 'direct' : 'webhook_or_poll', filterKey });
}

function standardField(key, label, dataType = 'string', writable = true) {
  return standardObjectField(key, label, 'contact', dataType, writable);
}

function standardObjectField(key, label, objectModel, dataType = 'string', writable = true) {
  const runtimePath = `trigger.${key}`;
  return {
    id: `standard:${key}`, integrationId: null, objectModel, fieldId: null, fieldKey: key,
    label, dataType, runtimePath, template: `{{${runtimePath}}}`, writable,
    targetPath: writable && objectModel === 'contact' ? key : null,
    allowedValues: [], source: 'hawk_standard', lastSeenAt: null,
  };
}

function buildCatalogResult(fields, integrationIds, objectDefinitions = []) {
  const models = new Set([...fields.map((item) => item.objectModel), ...objectDefinitions.map((item) => item.object_key)].filter(Boolean));
  const objects = [...models].sort().map((model) => {
    const definition = objectDefinitions.find((item) => item.object_key === model);
    return {
      id: model,
      objectId: definition?.object_id || null,
      label: definition?.singular_label || model.replace(/[._-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
      pluralLabel: definition?.plural_label || null,
      standard: definition ? Boolean(definition.is_standard) : ['contact', 'opportunity', 'appointment', 'form'].includes(model),
      primaryDisplayProperty: definition?.primary_display_property || null,
      fieldCount: fields.filter((item) => item.objectModel === model).length,
      lastSeenAt: definition?.last_seen_at || null,
    };
  });
  const lastSeen = fields.map((item) => item.lastSeenAt).filter(Boolean).sort().at(-1) || null;
  return { fields, objects, integrationIds, total: fields.length, lastSeenAt: lastSeen };
}

function normalizeDataType(value) {
  const type = String(value || 'string').toLowerCase();
  if (/(number|numeric|currency|monetary|decimal|integer)/.test(type)) return 'number';
  if (/(date|time)/.test(type)) return 'datetime';
  if (/(bool|checkbox)/.test(type)) return 'boolean';
  if (/(multi|array|list)/.test(type)) return 'array';
  if (/email/.test(type)) return 'email';
  if (/phone/.test(type)) return 'phone';
  return 'string';
}

function allowedValues(metadata) {
  const values = metadata?.picklistOptions || metadata?.options || metadata?.picklistImageOptions || [];
  return Array.isArray(values) ? values.map((item) => cleanText(typeof item === 'object' ? item.label || item.value : item, 191)).filter(Boolean).slice(0, 500) : [];
}

function safeFieldIdentifier(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

function safeRuntimeSuffix(value) {
  const suffix = String(value || '').trim().split('.').map((item) => safeFieldIdentifier(item)).filter(Boolean).join('.');
  return suffix && /^(?:[A-Za-z0-9_-]+\.?)+$/.test(suffix) ? suffix.slice(0, 240) : '';
}

function safeData(value, depth = 0) {
  if (depth > 8) return '[depth-limited]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 16000);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeData(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      output[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : safeData(item, depth + 1);
    }
    if (depth === 0) {
      const json = JSON.stringify(output);
      if (Buffer.byteLength(json) > MAX_STORED_BYTES) return { _truncated: true, preview: json.slice(0, 16000) };
    }
    return output;
  }
  return String(value).slice(0, 1000);
}

function publicFlowSummary(row) {
  return {
    id: row.id, apiKeyId: row.api_key_id, locationId: row.location_id,
    dataSourceSlug:row.data_source_slug || 'core',
    integrationId: row.integration_id, name: row.name, description: row.description || '',
    folderId: row.folder_id || null, folderName: row.folder_name || null,
    folderColor: row.folder_color || null, color: row.color || null,
    sortOrder: Number(row.sort_order || 0),
    status: row.status, draftRevision: row.draft_revision,
    publishedVersionId: row.published_version_id,
    publishedVersionNumber: row.published_version_number || null,
    publishedAt: row.published_at || null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function publicFlow(row) {
  return {
    ...publicFlowSummary(row),
    graph: parseJson(row.draft_graph_json, defaultGraph()),
    publishedChecksum: row.published_checksum || null,
  };
}

function publicExecutionSummary(row) {
  const started = row.started_at ? new Date(row.started_at).getTime() : null;
  const ended = row.completed_at ? new Date(row.completed_at).getTime() : null;
  return {
    id: row.id, flowId: row.flow_id, flowName: row.flow_name, versionId: row.version_id,
    dataSourceSlug:row.data_source_slug || 'core',
    triggerType: row.trigger_type, status: row.status, mode: row.mode,
    replayOfExecutionId: row.replay_of_execution_id,
    stepsTotal: row.steps_total, stepsCompleted: row.steps_completed,
    errorCode: row.error_code, startedAt: row.started_at, completedAt: row.completed_at,
    createdAt: row.created_at, durationMs: started != null && ended != null ? Math.max(0, ended - started) : null,
  };
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function requiredPathSegment(value, label) {
  const text = String(value || '').trim();
  if (!text || !/^[A-Za-z0-9_-]{1,191}$/.test(text)) throw statusError(`${label} is required`, 400, 'HAWK_ACTION_INPUT_INVALID');
  return text;
}

function requireScope(input) {
  if (!String(input?.apiKeyId || '').trim() || !String(input?.locationId || '').trim()) {
    throw statusError('apiKeyId and locationId are required', 400, 'HAWK_SCOPE_REQUIRED');
  }
}

function dataSourceSlug(input) {
  const value = String(input?.dataSourceSlug || input?.source || 'core').trim().toLowerCase();
  if (value !== 'core' && !/^[a-z][a-z0-9_-]{1,62}$/.test(value)) {
    throw statusError('Invalid HAWK data source', 400, 'HAWK_DATA_SOURCE_INVALID');
  }
  return value;
}

function isLeadConnectorConnection(integration) {
  if (integration?.provider === LEADCONNECTOR_PROVIDER) return true;
  try { return new URL(integration?.base_url).origin === 'https://services.leadconnectorhq.com'; }
  catch { return false; }
}

async function operationalPoolFor(flow, apiKeyId, corePool) {
  const source = flow.dataSourceSlug || 'core';
  if (source === 'core') return corePool;
  const { connection } = await resolveAccess({ apiKeyId, connectionSlug:source, tableName:'leads', op:'select' });
  return getDataPool(connection);
}

async function assertFolderScope(folderId, scope, pool) {
  if (!folderId) return;
  const [rows] = await pool.query(
    'SELECT id FROM hawk_flow_folders WHERE id=? AND api_key_id=? AND location_id=? AND data_source_slug=? LIMIT 1',
    [folderId, scope.apiKeyId, scope.locationId, dataSourceSlug(scope)]
  );
  if (!rows[0]) throw statusError('Selected folder is outside this HAWK workspace', 409, 'HAWK_FOLDER_SCOPE_MISMATCH');
}

function normalizeColor(value, fallback = null) {
  const color = String(value || '').trim().toLowerCase();
  if (!color) return fallback;
  if (!/^#[0-9a-f]{6}$/.test(color)) throw statusError('color must be a six-digit hex value', 400, 'HAWK_COLOR_INVALID');
  return color;
}

function nullableId(value) { return String(value || '').trim() || null; }
function requiredText(value, max, label) {
  const text = cleanText(value, max);
  if (!text) throw statusError(`${label} is required`, 400, 'HAWK_INPUT_REQUIRED');
  return text;
}
function cleanText(value, max) { return String(value == null ? '' : value).trim().replace(/[\r\n\t]/g, ' ').slice(0, max); }
function clampNumber(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback; }
function issue(code, message, nodeId = null) { return { code, message, nodeId }; }
function statusError(message, status, code, details = null) { return Object.assign(new Error(message), { status, code, details }); }

module.exports = {
  NODE_TYPES,
  get ACTION_TYPES() { return getActionTypes(); },
  get ACTION_DEFINITIONS() { return getActionDefinitions(); },
  getActionTypes,
  getActionDefinitions,
  TRIGGER_TYPES,
  TRIGGER_DEFINITIONS,
  CONDITION_OPERATORS,
  defaultGraph,
  normalizeGraph,
  validateGraph,
  renderTemplates,
  evaluateCondition,
  safeData,
  listConnections,
  listFieldCatalog,
  refreshFieldCatalog,
  searchTestRecords,
  listFlows,
  listFlowFolders,
  createFlowFolder,
  updateFlowFolder,
  deleteFlowFolder,
  getFlow,
  createFlow,
  updateFlowOrganization,
  setFlowArchived,
  saveDraft,
  publishFlow,
  setFlowState,
  listVersions,
  executeFlow,
  runGraph,
  listExecutions,
  getExecution,
  replayExecution,
  runGhlAction,
  buildGhlRequest,
  runCodeAction,
  runOutboundWebhook,
  validateOutboundWebhookUrl,
  isPrivateAddress,
  getCodeRunnerConfig,
  normalizeTriggerData,
  normalizeImportPackage,
  buildExportPackage,
  buildImportPreview,
  buildImportSchema,
  IMPORT_FORMAT,
  STANDARD_FIELD_CATALOG,
  isLeadConnectorConnection,
};
