const { getDiveDeepConfig } = require('../config');
const integrations = require('./diveDeepIntegrations');

const PROVIDER = 'google_cloud_run';
const JOB_NAME_RE = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION_RE = /^[a-z]+(?:-[a-z0-9]+)+\d$/;
const SERVICE_ACCOUNT_RE = /^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/;

function clean(value, max = 512) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function bool(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function integer(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function statusError(message, status = 400, code = 'DIVEDEEP_CLOUD_RUN_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function normalizeConfig(input = {}) {
  const credentialMode = clean(input.credentialMode || 'application_default', 64).toLowerCase();
  if (!['application_default', 'service_account_json'].includes(credentialMode)) {
    throw statusError('Cloud Run credential mode must be application_default or service_account_json');
  }
  const output = {
    credentialMode,
    projectId: clean(input.projectId, 128).toLowerCase(),
    region: clean(input.region || 'us-east1', 64).toLowerCase(),
    jobName: clean(input.jobName || 'divedeep-divedeep', 63).toLowerCase(),
    serviceAccountEmail: clean(input.serviceAccountEmail, 320).toLowerCase(),
    dispatchEnabled: bool(input.dispatchEnabled),
    defaultTaskCount: integer(input.defaultTaskCount, 1, 1, 1),
    defaultParallelism: integer(input.defaultParallelism, 1, 1, 1),
    defaultTaskTimeoutSeconds: integer(input.defaultTaskTimeoutSeconds, 1800, 60, 604800),
    defaultMaxRetries: integer(input.defaultMaxRetries, 0, 0, 10),
  };
  if (output.projectId && !PROJECT_ID_RE.test(output.projectId)) throw statusError('Google Cloud project ID is invalid');
  if (output.region && !REGION_RE.test(output.region)) throw statusError('Google Cloud region is invalid');
  if (output.jobName && !JOB_NAME_RE.test(output.jobName)) throw statusError('Cloud Run Job name is invalid');
  if (output.serviceAccountEmail && !SERVICE_ACCOUNT_RE.test(output.serviceAccountEmail)) {
    throw statusError('Cloud Run service account email is invalid');
  }
  if (Number(input.defaultTaskCount || 1) !== 1 || Number(input.defaultParallelism || 1) !== 1) {
    throw statusError('DiveDeep permits exactly one Cloud Run task per recon execution');
  }
  if (Number(input.defaultMaxRetries || 0) !== 0) {
    throw statusError('The ephemeral worker protocol requires zero Cloud Run task retries; DiveDeep performs safe redispatch with a new bootstrap token');
  }
  if (output.dispatchEnabled && (!output.projectId || !output.region || !output.jobName)) {
    throw statusError('Project ID, region, and Cloud Run Job name are required before dispatch can be enabled');
  }
  return output;
}

function parseServiceAccountJson(value) {
  if (!value) return null;
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw statusError('Google service account JSON is not valid JSON'); }
  if (!parsed || parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key || !parsed.project_id) {
    throw statusError('Google service account JSON is incomplete');
  }
  return parsed;
}

async function runtime() {
  const integration = await integrations.getRuntimeIntegration(PROVIDER);
  if (!integration) throw statusError('Google Cloud Run integration is disabled', 409, 'DIVEDEEP_CLOUD_RUN_DISABLED');
  const config = normalizeConfig(integration.config || {});
  const serviceAccount = config.credentialMode === 'service_account_json'
    ? parseServiceAccountJson(integration.secrets?.serviceAccountJson)
    : null;
  if (config.credentialMode === 'service_account_json' && !serviceAccount) {
    throw statusError('Google service account JSON is required for the configured credential mode', 409, 'DIVEDEEP_CLOUD_RUN_CREDENTIALS');
  }
  return { config, serviceAccount };
}

function loadRunClient() {
  try { return require('@google-cloud/run').v2; }
  catch (error) {
    throw statusError(`Google Cloud Run client is unavailable: ${error.message}`, 503, 'DIVEDEEP_CLOUD_RUN_CLIENT_UNAVAILABLE');
  }
}

async function createClients() {
  const { config, serviceAccount } = await runtime();
  const { JobsClient, ExecutionsClient } = loadRunClient();
  const options = serviceAccount
    ? { projectId: config.projectId || serviceAccount.project_id, credentials: serviceAccount }
    : { projectId: config.projectId };
  return { config, jobsClient: new JobsClient(options), executionsClient: new ExecutionsClient(options) };
}

function jobResourceName(config, overrideJobName = '') {
  const jobName = clean(overrideJobName || config.jobName, 63).toLowerCase();
  if (!config.projectId || !PROJECT_ID_RE.test(config.projectId)) throw statusError('Google Cloud project ID is invalid');
  if (!config.region || !REGION_RE.test(config.region)) throw statusError('Google Cloud region is invalid');
  if (!JOB_NAME_RE.test(jobName)) throw statusError('Cloud Run Job name is invalid');
  return `projects/${config.projectId}/locations/${config.region}/jobs/${jobName}`;
}

async function verifyAccess() {
  const started = Date.now();
  const { config, jobsClient } = await createClients();
  const name = jobResourceName(config);
  try {
    const [job] = await jobsClient.getJob({ name });
    return {
      ok: true,
      provider: PROVIDER,
      operation: 'GetJob',
      projectId: config.projectId,
      region: config.region,
      jobName: config.jobName,
      resourceName: job?.name || name,
      generation: String(job?.generation || ''),
      observedGeneration: String(job?.observedGeneration || ''),
      terminalCondition: job?.terminalCondition?.state || null,
      latencyMs: Date.now() - started,
      message: 'Cloud Run Job configuration is reachable.',
    };
  } finally {
    await jobsClient.close().catch(() => {});
  }
}

function executionOverrides(config, input = {}) {
  const apiOrigin = clean(input.apiOrigin || getDiveDeepConfig().apiOrigin, 2048);
  const jobId = clean(input.jobId, 64);
  if (!jobId) throw statusError('DiveDeep recon job ID is required');
  if (!apiOrigin) throw statusError('DIVEDEEP_API_ORIGIN is required before Cloud Run dispatch');
  const env = [
    { name: 'DIVEDEEP_RECON_JOB_ID', value: jobId },
    { name: 'DIVEDEEP_API_ORIGIN', value: apiOrigin },
    { name: 'DIVEDEEP_WORKER_MODE', value: 'cloud_run_job' },
  ];
  if (input.poolVersionId) env.push({ name: 'DIVEDEEP_WORKER_POOL_VERSION_ID', value: clean(input.poolVersionId, 64) });
  if (input.executionId) env.push({ name: 'DIVEDEEP_RECON_EXECUTION_ID', value: clean(input.executionId, 64) });
  if (input.bootstrapToken) env.push({ name: 'DIVEDEEP_WORKER_BOOTSTRAP_TOKEN', value: clean(input.bootstrapToken, 4096) });
  if (Number(input.taskCount || 1) !== 1) {
    throw statusError('DiveDeep recon jobs must execute as a single Cloud Run task');
  }
  return {
    taskCount: 1,
    timeout: `${integer(input.taskTimeoutSeconds, config.defaultTaskTimeoutSeconds, 60, 604800)}s`,
    containerOverrides: [{ env }],
  };
}

async function executeJob(input = {}) {
  const started = Date.now();
  const { config, jobsClient } = await createClients();
  if (!config.dispatchEnabled) {
    await jobsClient.close().catch(() => {});
    throw statusError('Cloud Run dispatch is disabled in the integration', 409, 'DIVEDEEP_CLOUD_RUN_DISPATCH_DISABLED');
  }
  const effectiveConfig = normalizeConfig({
    ...config,
    projectId: input.projectId || config.projectId,
    region: input.region || config.region,
    jobName: input.jobName || config.jobName,
    dispatchEnabled: config.dispatchEnabled,
  });
  const name = jobResourceName(effectiveConfig);
  const overrides = executionOverrides(effectiveConfig, input);
  try {
    const [operation] = await jobsClient.runJob({ name, overrides });
    return {
      ok: true,
      provider: PROVIDER,
      operation: 'RunJob',
      operationName: operation?.name || null,
      jobResourceName: name,
      projectId: effectiveConfig.projectId,
      region: effectiveConfig.region,
      jobName: name.split('/').pop(),
      taskCount: overrides.taskCount,
      status: 'dispatching',
      latencyMs: Date.now() - started,
    };
  } finally {
    await jobsClient.close().catch(() => {});
  }
}

function mapExecution(execution = {}) {
  const conditions = Array.isArray(execution.conditions) ? execution.conditions : [];
  const terminal = conditions.find((item) => item.type === 'Completed') || execution.terminalCondition || null;
  const state = terminal?.state || '';
  const reason = terminal?.reason || '';
  let status = 'running';
  if (state === 'CONDITION_SUCCEEDED' || Number(execution.succeededCount) > 0 && Number(execution.runningCount) === 0) status = 'completed';
  else if (state === 'CONDITION_FAILED' || Number(execution.failedCount) > 0 && Number(execution.runningCount) === 0) status = 'failed';
  else if (reason === 'Cancelled') status = 'cancelled';
  return {
    externalExecutionName: execution.name || null,
    status,
    taskCount: Number(execution.taskCount) || 0,
    runningCount: Number(execution.runningCount) || 0,
    succeededCount: Number(execution.succeededCount) || 0,
    failedCount: Number(execution.failedCount) || 0,
    cancelledCount: Number(execution.cancelledCount) || 0,
    retriedCount: Number(execution.retriedCount) || 0,
    startTime: execution.startTime || null,
    completionTime: execution.completionTime || null,
    terminalCondition: terminal ? { state: terminal.state || null, reason: terminal.reason || null, message: clean(terminal.message, 1000) || null } : null,
  };
}

async function getExecution(executionName) {
  const name = clean(executionName, 1024);
  if (!/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+\/executions\/[^/]+$/.test(name)) {
    throw statusError('Cloud Run execution resource name is invalid');
  }
  const { executionsClient } = await createClients();
  try {
    const [execution] = await executionsClient.getExecution({ name });
    return mapExecution(execution);
  } finally {
    await executionsClient.close().catch(() => {});
  }
}

async function checkRunOperation(operationName) {
  const name = clean(operationName, 1024);
  if (!/^projects\/[^/]+\/locations\/[^/]+\/operations\/[^/]+$/.test(name)) {
    throw statusError('Cloud Run operation resource name is invalid');
  }
  const { jobsClient } = await createClients();
  try {
    const operation = await jobsClient.checkRunJobProgress(name);
    const latest = operation?.latestResponse || {};
    const error = operation?.error || latest.error || null;
    const execution = operation?.result || operation?.metadata || null;
    const mapped = execution?.name ? mapExecution(execution) : null;
    const done = Boolean(operation?.done ?? latest.done);
    return {
      provider: PROVIDER,
      operation: 'CheckRunJobProgress',
      operationName: name,
      done,
      status: error ? 'failed' : (mapped?.status || (done ? 'completed' : 'dispatching')),
      externalExecutionName: mapped?.externalExecutionName || null,
      execution: mapped,
      error: error ? {
        code: error.code == null ? null : String(error.code),
        message: clean(error.message, 1000) || 'Cloud Run operation failed',
      } : null,
    };
  } finally {
    await jobsClient.close().catch(() => {});
  }
}

module.exports = {
  PROVIDER,
  normalizeConfig,
  parseServiceAccountJson,
  jobResourceName,
  executionOverrides,
  verifyAccess,
  executeJob,
  mapExecution,
  getExecution,
  checkRunOperation,
};
