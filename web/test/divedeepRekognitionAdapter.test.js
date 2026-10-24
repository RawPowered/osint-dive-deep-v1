'use strict';

const assert = require('assert/strict');
const Module = require('module');

const originalLoad = Module._load;
class GetCallerIdentityCommand { constructor(input) { this.input = input; } }
class AssumeRoleCommand { constructor(input) { this.input = input; } }
class STSClient {
  constructor(options) { this.options = options; }
  async send(command) {
    if (command instanceof GetCallerIdentityCommand) {
      return { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:role/DiveDeep', UserId: 'fixture' };
    }
    if (command instanceof AssumeRoleCommand) throw new Error('AssumeRole is not expected in this fixture');
    throw new Error('Unexpected STS command');
  }
}
class DetectLabelsCommand { constructor(input) { this.input = input; } }
class DetectFacesCommand { constructor(input) { this.input = input; } }
class CompareFacesCommand { constructor(input) { this.input = input; } }
class DetectModerationLabelsCommand { constructor(input) { this.input = input; } }
class DetectTextCommand { constructor(input) { this.input = input; } }
class RekognitionClient {
  constructor(options) { this.options = options; }
  async send(command) {
    assert.ok(command instanceof DetectFacesCommand);
    assert.ok(Buffer.isBuffer(command.input.Image.Bytes));
    assert.ok(command.input.Image.Bytes.length < 1024 * 1024);
    return { FaceModelVersion: 'fixture-model', $metadata: { requestId: 'fixture-request' } };
  }
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './diveDeepIntegrations' && parent?.filename?.endsWith('diveDeepRekognition.js')) {
    return {
      async getRuntimeIntegration() {
        return {
          provider: 'aws_rekognition',
          config: {
            credentialMode: 'default_provider_chain', region: 'us-east-1', inputMode: 'bytes',
            enableFaceDetection: true, enableFaceComparison: true, enableModeration: false,
            enableTextDetection: true, enableLabelDetection: true,
            dailyCallBudget: 100, monthlyCallBudget: 1000,
          },
          secrets: {},
        };
      },
    };
  }
  if (request === 'mysql2/promise') return { createPool() { throw new Error('Database pool should not be created'); } };
  if (request === '@aws-sdk/client-rekognition') {
    return { RekognitionClient, DetectLabelsCommand, DetectFacesCommand, CompareFacesCommand, DetectModerationLabelsCommand, DetectTextCommand };
  }
  if (request === '@aws-sdk/client-sts') return { STSClient, GetCallerIdentityCommand, AssumeRoleCommand };
  return originalLoad(request, parent, isMain);
};

const rekognition = require('../src/services/diveDeepRekognition');

(async () => {
  const identity = await rekognition.verifyIdentity();
  assert.equal(identity.ok, true);
  assert.equal(identity.account, '123456789012');
  assert.equal(identity.region, 'us-east-1');

  const access = await rekognition.verifyAccess();
  assert.equal(access.ok, true);
  assert.equal(access.operation, 'DetectFaces');
  assert.equal(access.requestId, 'fixture-request');
  assert.equal(access.modelVersion, 'fixture-model');

  Module._load = originalLoad;
  console.log('DiveDeep Rekognition adapter fixture checks passed');
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
