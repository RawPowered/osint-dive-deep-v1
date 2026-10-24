const { getRuntimeIntegration } = require('./diveDeepIntegrations');
const { getPool } = require('../db/pool');

const ALLOWED_OPERATIONS = Object.freeze([
  'DetectFaces',
  'CompareFaces',
  'DetectModerationLabels',
  'DetectText',
  'DetectLabels',
]);

function statusError(message, status = 400, code = 'DIVEDEEP_REKOGNITION_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function clean(value, max = 2048) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function validateRegion(region) {
  const value = clean(region, 64);
  if (!/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/.test(value)) {
    throw statusError('AWS Region must use a valid regional identifier such as us-east-1');
  }
  return value;
}

function validateRoleArn(roleArn) {
  const value = clean(roleArn, 512);
  if (!/^arn:(aws|aws-us-gov|aws-cn):iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/.test(value)) {
    throw statusError('Role ARN must be a valid AWS IAM role ARN');
  }
  return value;
}

function normalizeConfig(input = {}) {
  const credentialMode = clean(input.credentialMode || 'default_provider_chain', 64);
  if (!['default_provider_chain', 'assume_role', 'static_keys'].includes(credentialMode)) {
    throw statusError('Credential mode must be default_provider_chain, assume_role, or static_keys');
  }
  const inputMode = clean(input.inputMode || 'bytes', 64);
  if (!['bytes', 's3_staging'].includes(inputMode)) throw statusError('Input mode must be bytes or s3_staging');
  const region = validateRegion(input.region || 'us-east-1');
  const roleArn = credentialMode === 'assume_role' ? validateRoleArn(input.roleArn) : clean(input.roleArn, 512);
  const config = {
    credentialMode,
    region,
    roleArn,
    inputMode,
    stagingBucket: clean(input.stagingBucket, 255),
    stagingPrefix: clean(input.stagingPrefix || 'divedeep-rekognition/', 512),
    defaultSimilarityThreshold: number(input.defaultSimilarityThreshold, 75, 0, 100),
    highPriorityThreshold: number(input.highPriorityThreshold, 92, 0, 100),
    minimumFaceConfidence: number(input.minimumFaceConfidence, 95, 0, 100),
    minimumModerationConfidence: number(input.minimumModerationConfidence, 70, 0, 100),
    enableFaceDetection: bool(input.enableFaceDetection, true),
    enableFaceComparison: bool(input.enableFaceComparison, true),
    enableModeration: bool(input.enableModeration, false),
    enableTextDetection: bool(input.enableTextDetection, true),
    enableLabelDetection: bool(input.enableLabelDetection, false),
    maximumReferencesPerCandidate: Math.round(number(input.maximumReferencesPerCandidate, 5, 1, 20)),
    maximumCandidatesPerRun: Math.round(number(input.maximumCandidatesPerRun, 100, 1, 10000)),
    dailyCallBudget: Math.round(number(input.dailyCallBudget, 2500, 1, 10000000)),
    monthlyCallBudget: Math.round(number(input.monthlyCallBudget, 50000, 1, 100000000)),
  };
  if (config.highPriorityThreshold < config.defaultSimilarityThreshold) {
    throw statusError('High-priority threshold cannot be below the review threshold');
  }
  if (config.enableFaceComparison && !config.enableFaceDetection) {
    throw statusError('Face detection must remain enabled when face comparison is enabled');
  }
  if (!enabledOperations(config).length) {
    throw statusError('Enable at least one Rekognition operation');
  }
  if (inputMode === 's3_staging' && !config.stagingBucket) {
    throw statusError('A same-region AWS S3 staging bucket is required for s3_staging input mode');
  }
  return config;
}

function enabledOperations(config = {}) {
  const mapping = {
    DetectFaces: config.enableFaceDetection,
    CompareFaces: config.enableFaceComparison,
    DetectModerationLabels: config.enableModeration,
    DetectText: config.enableTextDetection,
    DetectLabels: config.enableLabelDetection,
  };
  return ALLOWED_OPERATIONS.filter((name) => Boolean(mapping[name]));
}

function baseCredentials(mode, secrets = {}) {
  if (mode === 'static_keys') {
    if (!secrets.accessKeyId || !secrets.secretAccessKey) {
      throw statusError('Static AWS access key ID and secret access key are required', 409, 'DIVEDEEP_REKOGNITION_CREDENTIALS_MISSING');
    }
    return {
      accessKeyId: secrets.accessKeyId,
      secretAccessKey: secrets.secretAccessKey,
      ...(secrets.sessionToken ? { sessionToken: secrets.sessionToken } : {}),
    };
  }
  return undefined;
}

async function loadSdk() {
  try {
    const rekognition = require('@aws-sdk/client-rekognition');
    const sts = require('@aws-sdk/client-sts');
    return { ...rekognition, ...sts };
  } catch (error) {
    throw statusError(`AWS SDK dependencies are unavailable: ${error.message}`, 503, 'DIVEDEEP_REKOGNITION_SDK_UNAVAILABLE');
  }
}

async function resolveCredentials(runtime, sdk) {
  const { config, secrets } = runtime;
  const base = baseCredentials(config.credentialMode, secrets);
  if (config.credentialMode !== 'assume_role') return base;
  const sts = new sdk.STSClient({ region: config.region, ...(base ? { credentials: base } : {}) });
  const response = await sts.send(new sdk.AssumeRoleCommand({
    RoleArn: config.roleArn,
    RoleSessionName: `divedeep-rekognition-${Date.now()}`,
    DurationSeconds: 900,
    ...(secrets.externalId ? { ExternalId: secrets.externalId } : {}),
  }));
  if (!response.Credentials) throw statusError('AWS did not return temporary role credentials', 502, 'DIVEDEEP_REKOGNITION_ASSUME_ROLE_FAILED');
  return {
    accessKeyId: response.Credentials.AccessKeyId,
    secretAccessKey: response.Credentials.SecretAccessKey,
    sessionToken: response.Credentials.SessionToken,
    expiration: response.Credentials.Expiration,
  };
}

async function runtimeConfig(pool = null) {
  const runtime = await getRuntimeIntegration('aws_rekognition', pool);
  if (!runtime) throw statusError('Amazon Rekognition is not enabled', 409, 'DIVEDEEP_REKOGNITION_DISABLED');
  runtime.config = normalizeConfig(runtime.config);
  return runtime;
}

async function createClients(pool = null) {
  const runtime = await runtimeConfig(pool);
  const sdk = await loadSdk();
  const credentials = await resolveCredentials(runtime, sdk);
  const options = { region: runtime.config.region, ...(credentials ? { credentials } : {}) };
  return {
    runtime,
    sdk,
    sts: new sdk.STSClient(options),
    rekognition: new sdk.RekognitionClient(options),
  };
}

async function verifyIdentity(pool = null) {
  const started = Date.now();
  const { runtime, sdk, sts } = await createClients(pool);
  const response = await sts.send(new sdk.GetCallerIdentityCommand({}));
  return {
    ok: true,
    region: runtime.config.region,
    credentialMode: runtime.config.credentialMode,
    account: response.Account || null,
    arn: response.Arn || null,
    userId: response.UserId || null,
    latencyMs: Date.now() - started,
    checkedAt: new Date().toISOString(),
  };
}

const ACCESS_FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAN0lEQVR4nO3NMQEAAAgDINc/9K3hHFQgE9nZ2VlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVkH2yUBP/VmL8YAAAAASUVORK5CYII=',
  'base64'
);

async function verifyAccess(pool = null) {
  const started = Date.now();
  const { runtime, sdk, rekognition } = await createClients(pool);
  const enabled = enabledOperations(runtime.config);
  let operation;
  let command;
  if (enabled.includes('DetectFaces')) {
    operation = 'DetectFaces';
    command = new sdk.DetectFacesCommand({ Image: { Bytes: ACCESS_FIXTURE_PNG }, Attributes: ['DEFAULT'] });
  } else if (enabled.includes('DetectLabels')) {
    operation = 'DetectLabels';
    command = new sdk.DetectLabelsCommand({ Image: { Bytes: ACCESS_FIXTURE_PNG }, MaxLabels: 1, MinConfidence: 99 });
  } else if (enabled.includes('DetectText')) {
    operation = 'DetectText';
    command = new sdk.DetectTextCommand({ Image: { Bytes: ACCESS_FIXTURE_PNG } });
  } else if (enabled.includes('DetectModerationLabels')) {
    operation = 'DetectModerationLabels';
    command = new sdk.DetectModerationLabelsCommand({ Image: { Bytes: ACCESS_FIXTURE_PNG }, MinConfidence: 99 });
  } else {
    throw statusError('Rekognition access verification requires an enabled detection operation', 409, 'DIVEDEEP_REKOGNITION_VERIFY_OPERATION_REQUIRED');
  }
  const response = await rekognition.send(command);
  return {
    ok: true,
    operation,
    region: runtime.config.region,
    modelVersion: response.FaceModelVersion || response.LabelModelVersion || response.TextModelVersion || response.ModerationModelVersion || null,
    requestId: response.$metadata?.requestId || null,
    latencyMs: Date.now() - started,
    checkedAt: new Date().toISOString(),
  };
}

function ensureOperationAllowed(config, operation) {
  if (!ALLOWED_OPERATIONS.includes(operation)) throw statusError('Unsupported Rekognition operation');
  if (!enabledOperations(config).includes(operation)) {
    throw statusError(`${operation} is disabled by the Rekognition integration policy`, 403, 'DIVEDEEP_REKOGNITION_OPERATION_DISABLED');
  }
}

async function reserveOperationBudget(operation, config, pool = null) {
  const p = pool || getPool();
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO divedeep_image_analysis_usage_daily (usage_date,provider,operation,call_count) VALUES (UTC_DATE(),'aws_rekognition','__total__',0)
       ON DUPLICATE KEY UPDATE updated_at=updated_at`
    );
    const [dailyRows] = await connection.query(
      `SELECT call_count FROM divedeep_image_analysis_usage_daily
       WHERE usage_date=UTC_DATE() AND provider='aws_rekognition' AND operation='__total__' FOR UPDATE`
    );
    const [monthlyRows] = await connection.query(
      `SELECT COALESCE(SUM(call_count),0) AS total FROM divedeep_image_analysis_usage_daily
       WHERE provider='aws_rekognition' AND operation='__total__'
         AND usage_date>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01')`
    );
    const daily = Number(dailyRows[0]?.call_count) || 0;
    const monthly = Number(monthlyRows[0]?.total) || 0;
    if (daily >= config.dailyCallBudget) {
      throw statusError('Amazon Rekognition daily call budget has been reached', 429, 'DIVEDEEP_REKOGNITION_DAILY_BUDGET');
    }
    if (monthly >= config.monthlyCallBudget) {
      throw statusError('Amazon Rekognition monthly call budget has been reached', 429, 'DIVEDEEP_REKOGNITION_MONTHLY_BUDGET');
    }
    await connection.query(
      `UPDATE divedeep_image_analysis_usage_daily SET call_count=call_count+1
       WHERE usage_date=UTC_DATE() AND provider='aws_rekognition' AND operation='__total__'`
    );
    await connection.query(
      `INSERT INTO divedeep_image_analysis_usage_daily (usage_date,provider,operation,call_count)
       VALUES (UTC_DATE(),'aws_rekognition',?,1)
       ON DUPLICATE KEY UPDATE call_count=call_count+1`, [operation]
    );
    await connection.commit();
    return { daily: daily + 1, monthly: monthly + 1 };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

async function recordOperationResult(operation, success, estimatedUnits = 1, pool = null) {
  const p = pool || getPool();
  await p.query(
    `UPDATE divedeep_image_analysis_usage_daily
     SET success_count=success_count+?,failure_count=failure_count+?,estimated_units=estimated_units+?
     WHERE usage_date=UTC_DATE() AND provider='aws_rekognition' AND operation=?`,
    [success ? 1 : 0, success ? 0 : 1, Number(estimatedUnits) || 1, operation]
  );
}

async function getUsageStatus(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT operation,call_count,success_count,failure_count,estimated_units
     FROM divedeep_image_analysis_usage_daily
     WHERE usage_date=UTC_DATE() AND provider='aws_rekognition' ORDER BY operation`
  );
  const [monthlyRows] = await p.query(
    `SELECT COALESCE(SUM(call_count),0) AS calls,COALESCE(SUM(success_count),0) AS successes,
            COALESCE(SUM(failure_count),0) AS failures,COALESCE(SUM(estimated_units),0) AS estimated_units
     FROM divedeep_image_analysis_usage_daily
     WHERE provider='aws_rekognition' AND operation<>'__total__'
       AND usage_date>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01')`
  );
  const todayTotal = rows.find((row) => row.operation === '__total__');
  return {
    today: {
      calls: Number(todayTotal?.call_count) || 0,
      operations: rows.filter((row) => row.operation !== '__total__').map((row) => ({
        operation: row.operation,
        calls: Number(row.call_count) || 0,
        successes: Number(row.success_count) || 0,
        failures: Number(row.failure_count) || 0,
        estimatedUnits: Number(row.estimated_units) || 0,
      })),
    },
    month: {
      calls: Number(monthlyRows[0]?.calls) || 0,
      successes: Number(monthlyRows[0]?.successes) || 0,
      failures: Number(monthlyRows[0]?.failures) || 0,
      estimatedUnits: Number(monthlyRows[0]?.estimated_units) || 0,
    },
  };
}

async function execute(operation, input, pool = null) {
  const { runtime, sdk, rekognition } = await createClients(pool);
  ensureOperationAllowed(runtime.config, operation);
  await reserveOperationBudget(operation, runtime.config, pool);
  const commandMap = {
    DetectFaces: sdk.DetectFacesCommand,
    CompareFaces: sdk.CompareFacesCommand,
    DetectModerationLabels: sdk.DetectModerationLabelsCommand,
    DetectText: sdk.DetectTextCommand,
    DetectLabels: sdk.DetectLabelsCommand,
  };
  const Command = commandMap[operation];
  try {
    const response = await rekognition.send(new Command(input));
    await recordOperationResult(operation, true, 1, pool);
    return response;
  } catch (error) {
    await recordOperationResult(operation, false, 1, pool).catch(() => {});
    throw error;
  }
}

module.exports = {
  ALLOWED_OPERATIONS,
  normalizeConfig,
  enabledOperations,
  validateRegion,
  validateRoleArn,
  verifyIdentity,
  verifyAccess,
  execute,
  ensureOperationAllowed,
  reserveOperationBudget,
  getUsageStatus,
};
