#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const { loadEnv } = require('../src/config');
const { getPool, closePool } = require('../src/db/pool');
const readiness = require('../src/services/diveDeepProductionReadiness');
const workers = require('../src/services/diveDeepWorkerRuntime');
const artifacts = require('../src/services/diveDeepArtifacts');
const storage = require('../src/services/diveDeepObjectStorage');
const crm = require('../src/services/diveDeepCrmIntegration');

function args() {
  const out = {};
  for (const item of process.argv.slice(2)) {
    const [key, ...value] = item.replace(/^--/, '').split('='); out[key] = value.join('=') || true;
  }
  return out;
}
function requireControlledAck(mode) {
  if (process.env.DIVEDEEP_REHEARSAL_ACK !== 'DIVEDEEP_CONTROLLED_REHEARSAL') throw new Error(`${mode} requires DIVEDEEP_REHEARSAL_ACK=DIVEDEEP_CONTROLLED_REHEARSAL`);
  if (process.env.DEPLOYMENT_ENV === 'production' && process.env.DIVEDEEP_PRODUCTION_REHEARSAL_ACK !== 'DIVEDEEP_PRODUCTION_REHEARSAL') {
    throw new Error(`${mode} in production requires DIVEDEEP_PRODUCTION_REHEARSAL_ACK=DIVEDEEP_PRODUCTION_REHEARSAL`);
  }
}

(async () => {
  loadEnv();
  const input = args();
  const mode = String(input.mode || 'corrupt-upload');
  const startedAt = new Date();
  let checkType;
  let details;
  if (mode === 'corrupt-upload') {
    checkType = 'corrupt_upload';
    const original = Buffer.from('divedeep-phase10-integrity-probe', 'utf8');
    const expected = { sha256: crypto.createHash('sha256').update(original).digest('hex'), byteSize: original.length };
    const valid = readiness.verifyUploadIntegrity(original, expected);
    const corrupt = Buffer.from(original); corrupt[0] ^= 0xff;
    const rejected = readiness.verifyUploadIntegrity(corrupt, expected);
    details = { validAccepted: valid.ok, corruptRejected: !rejected.ok, valid, rejected };
    if (!valid.ok || rejected.ok) throw new Error('Corrupt upload rehearsal failed');
  } else if (mode === 'storage-lifecycle') {
    requireControlledAck(mode); checkType = 'storage_lifecycle';
    details = { access: await storage.verifyAccess(), lifecycle: storage.lifecyclePolicyTemplate({ bucket: input.bucket || 'configured-private-bucket' }) };
  } else if (mode === 'worker-loss' || mode === 'expired-lease') {
    requireControlledAck(mode); checkType = mode === 'worker-loss' ? 'worker_loss' : 'expired_lease_recovery';
    if (!input['lease-id']) throw new Error('--lease-id is required');
    const pool = getPool();
    const [result] = await pool.query(`UPDATE divedeep_job_leases SET expires_at=DATE_SUB(NOW(3),INTERVAL 5 SECOND) WHERE id=? AND status='active'`, [input['lease-id']]);
    if (!result.affectedRows) throw new Error('Active controlled-test lease not found');
    const recovery = await workers.sweepExpiredLeases({ limit: 10 }, pool);
    const [rows] = await pool.query(`SELECT status,release_reason FROM divedeep_job_leases WHERE id=?`, [input['lease-id']]);
    details = { recovery, lease: rows[0] || null };
    if (rows[0]?.status !== 'expired') throw new Error('Expired lease was not recovered');
  } else if (mode === 'retention-deletion') {
    requireControlledAck(mode); checkType = 'retention_deletion';
    if (!input['artifact-id']) throw new Error('--artifact-id is required');
    const pool = getPool();
    const [rows] = await pool.query(`SELECT id,artifact_type,status,metadata_enc FROM divedeep_artifacts WHERE id=? LIMIT 1`, [input['artifact-id']]);
    if (!rows[0] || rows[0].artifact_type !== 'other') throw new Error('Retention rehearsal requires a synthetic artifact with artifact_type=other');
    await pool.query(`UPDATE divedeep_artifacts SET expires_at=DATE_SUB(NOW(3),INTERVAL 5 SECOND),legal_hold=0 WHERE id=?`, [input['artifact-id']]);
    const sweep = await artifacts.runRetentionSweep({ limit: 10 }, pool);
    const [after] = await pool.query(`SELECT status,deleted_at,object_key FROM divedeep_artifacts WHERE id=?`, [input['artifact-id']]);
    details = { sweep, artifact: after[0] || null };
    if (after[0]?.status !== 'deleted') throw new Error('Synthetic artifact was not deleted');
  } else if (mode === 'sentinel-alert') {
    requireControlledAck(mode); checkType = 'sentinel_alert';
    const requestId = crypto.randomUUID();
    const pool = getPool();
    await pool.query(`INSERT INTO api_sentinel_events (method,path,status_code,duration_ms,ip,user_agent,error_class,request_id,surface,actor_type,action,entity_type,entity_id,outcome) VALUES ('TEST','/phase10/synthetic-alert',599,1,'127.0.0.1','phase10-rehearsal','PHASE10_SYNTHETIC_ALERT',?,'divedeep_admin','system','divedeep.phase10.synthetic_alert','release','1.16.0','failure')`, [requestId]);
    const [rows] = await pool.query(`SELECT id,status_code,error_class,action FROM api_sentinel_events WHERE request_id=?`, [requestId]);
    details = { requestId, event: rows[0] || null };
    if (!rows[0]) throw new Error('Synthetic Sentinel event was not recorded');
  } else if (mode === 'ghl-webhook-replay') {
    requireControlledAck(mode); checkType = 'ghl_webhook_replay';
    if (!input.direction || !input['event-id']) throw new Error('--direction and --event-id are required');
    const pool = getPool();
    await crm.retryDeadLetter(input.direction, input['event-id'], 'phase10-rehearsal', pool);
    const sweep = await crm.runCrmSweep({ limit: 10, reconcile: false }, pool);
    const events = await crm.listQueueEvents(input.direction, { limit: 25 }, pool);
    const event = events.find((item) => item.id === input['event-id']);
    details = { sweep, event: event || null };
    if (!event || event.status === 'dead_letter') throw new Error('GHL webhook replay remained dead-lettered');
  } else {
    throw new Error('Unsupported rehearsal mode');
  }
  const recorded = await readiness.recordReadinessCheck({
    checkType,
    status: 'passed',
    summary: `Phase 10 ${mode} rehearsal passed`,
    details,
    startedAt,
  }, 'phase10-rehearsal');
  console.log(JSON.stringify({ ok: true, mode, recorded, details }, null, 2));
  await closePool();
})().catch(async (error) => {
  console.error(error.code || error.message);
  try { await closePool(); } catch {}
  process.exitCode = 1;
});
