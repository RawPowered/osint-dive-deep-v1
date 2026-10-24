'use strict';
const assert = require('assert/strict');
const readiness = require('../src/services/diveDeepProductionReadiness');
assert.deepEqual(readiness.ROLLOUT_ORDER, [
  'internal_test_records','controlled_pilot','small_customer_cohort','normal_production',
  'enterprise_clients','hourly_burst_capacity','multi_provider_capacity',
]);
assert.equal(readiness.validateRolloutTransition('internal_test_records','controlled_pilot').direction, 'forward');
assert.throws(() => readiness.validateRolloutTransition('internal_test_records','normal_production'), (error) => error.code === 'DIVEDEEP_ROLLOUT_TRANSITION_BLOCKED');
assert.throws(() => readiness.validateRolloutTransition('normal_production','controlled_pilot'), (error) => error.code === 'DIVEDEEP_ROLLOUT_TRANSITION_BLOCKED');
assert.equal(readiness.validateRolloutTransition('normal_production','controlled_pilot',{ rollback:true, reason:'pilot regression' }).direction, 'rollback');
const rows = readiness.REQUIRED_RELEASE_CHECKS.map((checkType) => ({ checkType, status: 'passed', completedAt: new Date().toISOString() }));
assert.equal(readiness.evaluateReleaseGate(rows).ready, true);
assert.equal(readiness.evaluateReleaseGate(rows.slice(1)).ready, false);
console.log('DiveDeep Phase 10 rollout gate checks passed');
