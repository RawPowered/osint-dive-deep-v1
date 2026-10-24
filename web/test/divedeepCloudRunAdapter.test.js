'use strict';
const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;

const fakeExecution = {
  name: 'projects/divedeep-prod1/locations/us-east1/jobs/divedeep-divedeep/executions/execution-123',
  taskCount: 1,
  runningCount: 1,
  succeededCount: 0,
  failedCount: 0,
  conditions: [],
};

class FakeJobsClient {
  async getJob({ name }) { return [{ name, generation: '1', observedGeneration: '1' }]; }
  async runJob({ name }) { return [{ name: 'projects/divedeep-prod1/locations/us-east1/operations/operation-123', jobName: name }]; }
  async checkRunJobProgress(name) {
    return {
      done: false,
      metadata: { ...fakeExecution },
      latestResponse: { name, done: false },
    };
  }
  async close() {}
}
class FakeExecutionsClient {
  async getExecution({ name }) { return [{ ...fakeExecution, name }]; }
  async close() {}
}

Module._load = function patched(request, parent, isMain) {
  if (request === './diveDeepIntegrations' && parent?.filename?.endsWith('diveDeepCloudRun.js')) {
    return {
      getRuntimeIntegration: async () => ({
        config: {
          credentialMode: 'application_default', projectId: 'divedeep-prod1', region: 'us-east1',
          jobName: 'divedeep-divedeep', dispatchEnabled: true, defaultTaskCount: 1,
          defaultTaskTimeoutSeconds: 1800, defaultMaxRetries: 0,
        },
        secrets: {},
      }),
    };
  }
  if (request === '../config' && parent?.filename?.endsWith('diveDeepCloudRun.js')) {
    return { getDiveDeepConfig: () => ({ apiOrigin: 'https://api.divedeep.example.invalid' }) };
  }
  if (request === '@google-cloud/run') {
    return { v2: { JobsClient: FakeJobsClient, ExecutionsClient: FakeExecutionsClient } };
  }
  return originalLoad(request, parent, isMain);
};

const cloudRun = require('../src/services/diveDeepCloudRun');

(async () => {
  const config = cloudRun.normalizeConfig({
    credentialMode: 'application_default', projectId: 'divedeep-prod1', region: 'us-east1', jobName: 'divedeep-divedeep',
    dispatchEnabled: true, defaultTaskCount: 1, defaultTaskTimeoutSeconds: 1800,
  });
  assert.equal(config.projectId, 'divedeep-prod1');
  assert.equal(cloudRun.jobResourceName(config), 'projects/divedeep-prod1/locations/us-east1/jobs/divedeep-divedeep');
  const overrides = cloudRun.executionOverrides(config, { jobId: 'job-123', poolVersionId: 'pool-version-1' });
  assert.equal(overrides.taskCount, 1);
  assert.equal(overrides.timeout, '1800s');
  const env = Object.fromEntries(overrides.containerOverrides[0].env.map((item) => [item.name, item.value]));
  assert.equal(env.DIVEDEEP_RECON_JOB_ID, 'job-123');
  assert.equal(env.DIVEDEEP_API_ORIGIN, 'https://api.divedeep.example.invalid');
  assert.equal(env.DIVEDEEP_WORKER_MODE, 'cloud_run_job');
  assert.equal(Object.keys(env).some((key) => /secret|token|credential|password/i.test(key)), false);

  const completed = cloudRun.mapExecution({ name: 'projects/p/locations/r/jobs/j/executions/e', taskCount: 1, succeededCount: 1, runningCount: 0, conditions: [{ type: 'Completed', state: 'CONDITION_SUCCEEDED' }] });
  assert.equal(completed.status, 'completed');
  const failed = cloudRun.mapExecution({ name: 'projects/p/locations/r/jobs/j/executions/e2', failedCount: 1, runningCount: 0, conditions: [{ type: 'Completed', state: 'CONDITION_FAILED', message: 'fixture failure' }] });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.terminalCondition.message, 'fixture failure');

  const dispatch = await cloudRun.executeJob({ jobId: 'job-123' });
  assert.equal(dispatch.status, 'dispatching');
  assert.match(dispatch.operationName, /\/operations\/operation-123$/);

  const operation = await cloudRun.checkRunOperation(dispatch.operationName);
  assert.equal(operation.done, false);
  assert.equal(operation.status, 'running');
  assert.equal(operation.externalExecutionName, fakeExecution.name);

  assert.throws(() => cloudRun.normalizeConfig({ projectId: 'divedeep-prod1', region: 'us-east1', jobName: 'job', defaultTaskCount: 2 }), /exactly one Cloud Run task/i);
  assert.throws(() => cloudRun.executionOverrides(config, { jobId: 'job-123', taskCount: 2 }), /single Cloud Run task/i);
  assert.throws(() => cloudRun.normalizeConfig({ projectId: 'INVALID PROJECT', region: 'us-east1', jobName: 'job' }), /project ID/i);
  await assert.rejects(() => cloudRun.checkRunOperation('not-an-operation'), /operation resource name/i);

  console.log('DiveDeep Cloud Run adapter contract checks passed');
})().finally(() => {
  Module._load = originalLoad;
}).catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
