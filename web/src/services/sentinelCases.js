const crypto = require('crypto');
const { getPool } = require('../db/pool');

const OPENISH = new Set(['open','triage','investigating','contained','monitoring','reopened']);
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const CASE_STATUSES = new Set(['open','triage','investigating','contained','monitoring','resolved','closed','reopened']);
const DISPOSITIONS = new Set(['confirmed_malicious','suspicious','policy_violation','expected_behavior','benign_anomaly','false_positive','duplicate','insufficient_evidence']);

function fingerprintFor(finding) {
  const rule = String(finding.ruleId || finding.rule_id || 'unknown').slice(0, 64);
  const et = String(finding.entityType || finding.entity_type || 'metric').slice(0, 32);
  const ent = String(finding.fingerprintEntity || finding.entity || '').slice(0, 120);
  return `${rule}:${et}:${ent}`.slice(0, 191);
}

function mapCase(row) {
  if (!row) return null;
  let evidence = null;
  if (row.evidence_json) {
    try {
      evidence =
        typeof row.evidence_json === 'string'
          ? JSON.parse(row.evidence_json)
          : row.evidence_json;
    } catch {
      evidence = null;
    }
  }
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    ruleId: row.rule_id,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    entityType: row.entity_type,
    entity: row.entity,
    status: row.status,
    ownerAdminId: row.owner_admin_id,
    priority: row.priority || 'normal',
    confidence: row.confidence,
    disposition: row.disposition,
    dueAt: row.due_at,
    evidence,
    count: Number(row.count) || 0,
    windowHours: row.window_hours,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    reviewNote: row.review_note,
    resolutionSummary: row.resolution_summary,
    validationSummary: row.validation_summary,
    triagedBy: row.triaged_by,
    triagedAt: row.triaged_at,
    containedBy: row.contained_by,
    containedAt: row.contained_at,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    validatedBy: row.validated_by,
    validatedAt: row.validated_at,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    reopenCount: Number(row.reopen_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function recordAction(caseId, action, { adminId = null, detail = null } = {}) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO sentinel_case_actions (id, case_id, admin_id, action, detail)
     VALUES (?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      caseId,
      adminId || null,
      String(action).slice(0, 32),
      detail ? String(detail).slice(0, 512) : null,
    ]
  );
}

async function listActions(caseId, limit = 50) {
  const pool = getPool();
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const [rows] = await pool.query(
    `SELECT id, case_id, admin_id, action, detail, created_at
     FROM sentinel_case_actions
     WHERE case_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    [caseId, lim]
  );
  return rows.map((r) => ({
    id: r.id,
    caseId: r.case_id,
    adminId: r.admin_id,
    action: r.action,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

async function listNotes(caseId, limit = 100) {
  const pool = getPool();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const [rows] = await pool.query(
    `SELECT id,case_id,admin_id,note_type,note,created_at FROM sentinel_case_notes
     WHERE case_id=? ORDER BY created_at DESC LIMIT ?`, [caseId, lim]
  );
  return rows.map((row) => ({ id:row.id, caseId:row.case_id, adminId:row.admin_id,
    noteType:row.note_type, note:row.note, createdAt:row.created_at }));
}

async function listStatusHistory(caseId, limit = 100) {
  const pool = getPool();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const [rows] = await pool.query(
    `SELECT id,case_id,admin_id,from_status,to_status,reason,created_at
     FROM sentinel_case_status_history WHERE case_id=? ORDER BY created_at DESC LIMIT ?`,
    [caseId, lim]
  );
  return rows.map((row) => ({ id:row.id, caseId:row.case_id, adminId:row.admin_id,
    fromStatus:row.from_status, toStatus:row.to_status, reason:row.reason, createdAt:row.created_at }));
}

async function appendCaseNote(id, note, adminId, noteType = 'analyst') {
  const text = String(note || '').trim();
  if (!text) throw Object.assign(new Error('Case note is required'), { status:400 });
  if (!await getCaseById(id)) throw Object.assign(new Error('Case not found'), { status:404 });
  const pool = getPool();
  await pool.query(
    `INSERT INTO sentinel_case_notes (id,case_id,admin_id,note_type,note) VALUES (?,?,?,?,?)`,
    [crypto.randomUUID(), id, adminId || null, String(noteType || 'analyst').slice(0,32), text.slice(0,8000)]
  );
  await recordAction(id, 'note', { adminId, detail:text.slice(0,512) });
  return listNotes(id);
}

async function assignCaseOwner(id, ownerAdminId, adminId) {
  const current = await getCaseById(id);
  if (!current) throw Object.assign(new Error('Case not found'), { status:404 });
  const owner = String(ownerAdminId || '').trim() || null;
  const pool = getPool();
  await pool.query(`UPDATE sentinel_threat_cases SET owner_admin_id=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?`, [owner,id]);
  await recordAction(id, owner ? 'assign' : 'unassign', { adminId, detail:owner ? `Assigned to ${owner}` : 'Owner cleared' });
  return getCaseById(id);
}

async function getCaseById(id) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM sentinel_threat_cases WHERE id = ? LIMIT 1`,
    [id]
  );
  return mapCase(rows[0]);
}

async function getCaseByFingerprint(fp) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM sentinel_threat_cases WHERE fingerprint = ? LIMIT 1`,
    [fp]
  );
  return mapCase(rows[0]);
}

async function listCases({
  status,
  severity,
  owner,
  disposition,
  sla,
  q,
  limit = 100,
  offset = 0,
  openOnly = false,
} = {}) {
  const pool = getPool();
  const where = [];
  const params = [];
  if (openOnly) {
    where.push(`status IN ('open','under_review','watching')`);
  } else if (status) {
    where.push('status = ?');
    params.push(String(status).slice(0, 32));
  }
  if (severity) {
    where.push('severity = ?');
    params.push(String(severity).slice(0, 16));
  }
  if (owner === 'unassigned') where.push('owner_admin_id IS NULL');
  else if (owner) { where.push('owner_admin_id = ?'); params.push(String(owner).slice(0,64)); }
  if (disposition) { where.push('disposition = ?'); params.push(String(disposition).slice(0,32)); }
  if (sla === 'breached') where.push("due_at < UTC_TIMESTAMP(3) AND status NOT IN ('resolved','closed')");
  else if (sla === 'due_soon') where.push("due_at BETWEEN UTC_TIMESTAMP(3) AND DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 HOUR) AND status NOT IN ('resolved','closed')");
  if (q) {
    where.push('(title LIKE ? OR summary LIKE ? OR entity LIKE ? OR rule_id LIKE ?)');
    const like = `%${String(q).slice(0, 80)}%`;
    params.push(like, like, like, like);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const off = Math.max(Number(offset) || 0, 0);

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM sentinel_threat_cases ${sqlWhere}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT * FROM sentinel_threat_cases ${sqlWhere}
     ORDER BY
       FIELD(status, 'open', 'reopened', 'triage', 'investigating', 'contained', 'monitoring', 'resolved', 'closed'),
       FIELD(severity, 'critical', 'high', 'medium', 'low', 'info'),
       last_seen DESC
     LIMIT ? OFFSET ?`,
    [...params, lim, off]
  );

  const [byStatus] = await pool.query(
    `SELECT status, COUNT(*) AS c FROM sentinel_threat_cases GROUP BY status`
  );
  const statusCounts = {};
  for (const r of byStatus) statusCounts[r.status] = Number(r.c) || 0;

  return {
    total: Number(countRows[0]?.total) || 0,
    cases: rows.map(mapCase),
    statusCounts,
  };
}

async function getCaseOperationsReport({ sinceHours = 24 } = {}) {
  const pool = getPool();
  const hours = Math.min(Math.max(Number(sinceHours) || 24, 1), 24 * 90);
  const [totals] = await pool.query(
    `SELECT COUNT(*) AS total,
      SUM(status IN ('open','reopened')) AS newCases,
      SUM(owner_admin_id IS NULL AND status NOT IN ('resolved','closed')) AS unassigned,
      SUM(due_at<UTC_TIMESTAMP(3) AND status NOT IN ('resolved','closed')) AS slaBreached,
      SUM(due_at BETWEEN UTC_TIMESTAMP(3) AND DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 HOUR) AND status NOT IN ('resolved','closed')) AS dueSoon,
      SUM(status='resolved') AS awaitingValidation,
      SUM(status='monitoring') AS monitoring,
      SUM(status='reopened') AS reopened,
      SUM(resolved_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS resolvedInWindow,
      SUM(closed_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS closedInWindow,
      SUM(status='closed' AND resolution_summary IS NOT NULL AND validation_summary IS NOT NULL AND disposition IS NOT NULL) AS qualityClosures,
      SUM(status='closed') AS allClosures,
      AVG(CASE WHEN triaged_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND,created_at,triaged_at) END) AS avgTriageSeconds,
      AVG(CASE WHEN resolved_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND,created_at,resolved_at) END) AS avgResolutionSeconds,
      MAX(CASE WHEN status NOT IN ('resolved','closed') THEN TIMESTAMPDIFF(SECOND,created_at,UTC_TIMESTAMP(3)) END) AS oldestOpenSeconds
     FROM sentinel_threat_cases`, [hours,hours]
  );
  const [byStatus] = await pool.query(`SELECT status,COUNT(*) AS total FROM sentinel_threat_cases GROUP BY status`);
  const [bySeverity] = await pool.query(`SELECT severity,COUNT(*) AS total FROM sentinel_threat_cases WHERE status NOT IN ('resolved','closed') GROUP BY severity`);
  const [analysts] = await pool.query(
    `SELECT COALESCE(resolved_by,closed_by,owner_admin_id,'unassigned') AS analyst,
      COUNT(*) AS casesHandled,SUM(resolved_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS resolved,
      SUM(closed_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS closed,
      AVG(CASE WHEN resolved_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND,created_at,resolved_at) END) AS avgResolutionSeconds
     FROM sentinel_threat_cases
     WHERE updated_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR
     GROUP BY analyst ORDER BY resolved DESC,closed DESC,casesHandled DESC LIMIT 50`,
    [hours,hours,hours]
  );
  const value = totals[0] || {};
  const allClosures = Number(value.allClosures) || 0;
  return {
    windowHours:hours,
    totals:{
      total:Number(value.total)||0,newCases:Number(value.newCases)||0,unassigned:Number(value.unassigned)||0,
      slaBreached:Number(value.slaBreached)||0,dueSoon:Number(value.dueSoon)||0,
      awaitingValidation:Number(value.awaitingValidation)||0,monitoring:Number(value.monitoring)||0,
      reopened:Number(value.reopened)||0,resolvedInWindow:Number(value.resolvedInWindow)||0,
      closedInWindow:Number(value.closedInWindow)||0,avgTriageSeconds:Number(value.avgTriageSeconds)||0,
      avgResolutionSeconds:Number(value.avgResolutionSeconds)||0,oldestOpenSeconds:Number(value.oldestOpenSeconds)||0,
      closureQualityRate:allClosures ? (Number(value.qualityClosures)||0)/allClosures : 1,
    },
    byStatus:Object.fromEntries(byStatus.map((row)=>[row.status,Number(row.total)||0])),
    bySeverity:Object.fromEntries(bySeverity.map((row)=>[row.severity,Number(row.total)||0])),
    analysts:analysts.map((row)=>({...row,casesHandled:Number(row.casesHandled)||0,resolved:Number(row.resolved)||0,
      closed:Number(row.closed)||0,avgResolutionSeconds:Number(row.avgResolutionSeconds)||0})),
  };
}

/**
 * Upsert findings into durable cases.
 * - severity high/critical always
 * - medium when rule is first_auth_fail_ip or custom
 * - do not re-open dismissed within 24h unless critical
 */
async function syncFindingsToCases(findings = []) {
  if (!Array.isArray(findings) || !findings.length) {
    return { created: 0, updated: 0 };
  }
  const pool = getPool();
  let created = 0;
  let updated = 0;

  for (const f of findings) {
    const sev = String(f.severity || 'info');
    const ruleId = String(f.ruleId || '');
    const shouldCase =
      sev === 'critical' ||
      sev === 'high' ||
      (sev === 'medium' &&
        (ruleId === 'first_auth_fail_ip' || ruleId.startsWith('custom:')));
    if (!shouldCase) continue;

    const fp = fingerprintFor(f);
    const [existingRows] = await pool.query(
      `SELECT * FROM sentinel_threat_cases WHERE fingerprint = ? LIMIT 1`,
      [fp]
    );
    const existing = existingRows[0];
    const evidence = {
      recommendedAction: f.recommendedAction || null,
      windowHours: f.windowHours || null,
      evidence: f.evidence || null,
    };
    const evidenceStr = JSON.stringify(evidence).slice(0, 60000);
    const title = String(f.title || 'Finding').slice(0, 255);
    const summary = String(f.summary || '').slice(0, 512);
    const entityType = String(f.entityType || 'metric').slice(0, 32);
    const entity = String(f.entity || '').slice(0, 255);
    const count = Number(f.count) || 0;
    const windowHours = f.windowHours != null ? Number(f.windowHours) : null;
    const firstSeen = f.firstSeen || null;
    const lastSeen = f.lastSeen || null;

    if (!existing) {
      const id = crypto.randomUUID();
      const slaHours = sev === 'critical' ? 1 : sev === 'high' ? 4 : sev === 'medium' ? 24 : 72;
      const priority = sev === 'critical' ? 'urgent' : sev === 'high' ? 'high' : 'normal';
      await pool.query(
        `INSERT INTO sentinel_threat_cases
           (id, fingerprint, rule_id, severity, title, summary, entity_type, entity,
            status, priority, due_at, evidence_json, count, window_hours, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? HOUR), ?, ?, ?, ?, ?)`,
        [
          id,
          fp,
          ruleId.slice(0, 64),
          sev.slice(0, 16),
          title,
          summary,
          entityType,
          entity,
          priority,
          slaHours,
          evidenceStr,
          count,
          windowHours,
          firstSeen,
          lastSeen,
        ]
      );
      await recordAction(id, 'auto_open', {
        detail: `Auto-opened from rule ${ruleId}`,
      });
      created += 1;
      continue;
    }

    // Dismissed cooldown
    if (['resolved','closed'].includes(existing.status)) {
      const resolvedAt = existing.resolved_at
        ? new Date(existing.resolved_at).getTime()
        : 0;
      const withinCooldown = Date.now() - resolvedAt < 24 * 60 * 60 * 1000;
      const escalate =
        sev === 'critical' &&
        SEV_RANK[existing.severity] != null &&
        SEV_RANK[sev] < SEV_RANK[existing.severity];
      if (withinCooldown && !escalate && sev !== 'critical') {
        continue;
      }
      // Re-open a previously completed case on critical recurrence or after cooldown.
      await pool.query(
        `UPDATE sentinel_threat_cases
         SET status = 'reopened', severity = ?, title = ?, summary = ?,
             evidence_json = ?, count = ?, window_hours = ?,
             first_seen = COALESCE(first_seen, ?), last_seen = ?,
             reopen_count=reopen_count+1
         WHERE id = ?`,
        [
          sev.slice(0, 16),
          title,
          summary,
          evidenceStr,
          count,
          windowHours,
          firstSeen,
          lastSeen,
          existing.id,
        ]
      );
      await recordAction(existing.id, 'auto_open', {
        detail: `Re-opened (${sev}) from rule ${ruleId}`,
      });
      updated += 1;
      continue;
    }

    if (OPENISH.has(existing.status)) {
      // Prefer higher severity while retaining the analyst's active lifecycle state.
      const nextSev =
        SEV_RANK[sev] < (SEV_RANK[existing.severity] ?? 9) ? sev : existing.severity;
      await pool.query(
        `UPDATE sentinel_threat_cases
         SET severity = ?, title = ?, summary = ?, evidence_json = ?,
             count = GREATEST(count, ?), window_hours = ?,
             first_seen = COALESCE(first_seen, ?),
             last_seen = COALESCE(?, last_seen)
         WHERE id = ?`,
        [
          nextSev.slice(0, 16),
          title,
          summary,
          evidenceStr,
          count,
          windowHours,
          firstSeen,
          lastSeen,
          existing.id,
        ]
      );
      updated += 1;
    }
  }

  return { created, updated };
}

async function transitionCase(
  id,
  nextStatus,
  { adminId = null, note = null, action = null, detail = null } = {}
) {
  const pool = getPool();
  const c = await getCaseById(id);
  if (!c) {
    const err = new Error('Case not found');
    err.status = 404;
    throw err;
  }
  const resolved = nextStatus === 'dismissed' || nextStatus === 'blocked';
  await pool.query(
    `UPDATE sentinel_threat_cases
     SET status = ?,
         review_note = COALESCE(?, review_note),
         resolved_by = ?,
         resolved_at = ${resolved ? 'CURRENT_TIMESTAMP(3)' : 'resolved_at'}
     WHERE id = ?`,
    [
      String(nextStatus).slice(0, 32),
      note != null ? String(note).slice(0, 4000) : null,
      resolved ? adminId || null : null,
      id,
    ]
  );
  await recordAction(id, action || nextStatus, {
    adminId,
    detail: detail || note || `status → ${nextStatus}`,
  });
  return getCaseById(id);
}

async function transitionCaseLifecycle(id, input = {}, adminId = null) {
  const pool = getPool();
  const current = await getCaseById(id);
  if (!current) throw Object.assign(new Error('Case not found'), { status:404 });
  const nextStatus = String(input.status || '').trim().toLowerCase();
  if (!CASE_STATUSES.has(nextStatus)) throw Object.assign(new Error('Valid case status is required'), { status:400 });
  const disposition = input.disposition == null ? current.disposition : String(input.disposition).trim().toLowerCase();
  if (disposition && !DISPOSITIONS.has(disposition)) throw Object.assign(new Error('Invalid case disposition'), { status:400 });
  const note = String(input.note || '').trim();
  const resolution = String(input.resolutionSummary || '').trim();
  const validation = String(input.validationSummary || '').trim();
  if (['resolved','closed'].includes(nextStatus) && (!disposition || !resolution)) {
    throw Object.assign(new Error('Disposition and resolution summary are required'), { status:400, code:'CASE_RESOLUTION_REQUIRED' });
  }
  if (nextStatus === 'closed' && !validation) {
    throw Object.assign(new Error('Validation summary is required before closing a case'), { status:400, code:'CASE_VALIDATION_REQUIRED' });
  }
  const owner = input.ownerAdminId === undefined ? current.ownerAdminId : (String(input.ownerAdminId || '').trim() || null);
  const confidence = input.confidence === undefined ? current.confidence : (String(input.confidence || '').trim().toLowerCase() || null);
  if (confidence && !new Set(['low','medium','high','confirmed']).has(confidence)) {
    throw Object.assign(new Error('Invalid confidence'), { status:400 });
  }
  const priority = String(input.priority || current.priority || 'normal').trim().toLowerCase();
  if (!new Set(['low','normal','high','urgent']).has(priority)) throw Object.assign(new Error('Invalid priority'), { status:400 });
  const reopening = nextStatus === 'reopened' && ['resolved','closed'].includes(current.status);
  await pool.query(
    `UPDATE sentinel_threat_cases SET status=?,owner_admin_id=?,priority=?,confidence=?,disposition=?,due_at=COALESCE(?,due_at),
       resolution_summary=COALESCE(?,resolution_summary),validation_summary=COALESCE(?,validation_summary),
       triaged_by=CASE WHEN ? IN ('triage','investigating') AND triaged_at IS NULL THEN ? ELSE triaged_by END,
       triaged_at=CASE WHEN ? IN ('triage','investigating') THEN COALESCE(triaged_at,UTC_TIMESTAMP(3)) ELSE triaged_at END,
       contained_by=CASE WHEN ?='contained' THEN ? ELSE contained_by END,
       contained_at=CASE WHEN ?='contained' THEN COALESCE(contained_at,UTC_TIMESTAMP(3)) ELSE contained_at END,
       resolved_by=CASE WHEN ? IN ('resolved','closed') THEN ? ELSE resolved_by END,
       resolved_at=CASE WHEN ? IN ('resolved','closed') THEN COALESCE(resolved_at,UTC_TIMESTAMP(3)) ELSE resolved_at END,
       validated_by=CASE WHEN ?='closed' THEN ? ELSE validated_by END,
       validated_at=CASE WHEN ?='closed' THEN UTC_TIMESTAMP(3) ELSE validated_at END,
       closed_by=CASE WHEN ?='closed' THEN ? ELSE closed_by END,
       closed_at=CASE WHEN ?='closed' THEN UTC_TIMESTAMP(3) ELSE closed_at END,
       reopen_count=reopen_count+?,updated_at=UTC_TIMESTAMP(3) WHERE id=?`,
    [nextStatus,owner,priority,confidence,disposition,input.dueAt || null,resolution || null,validation || null,
      nextStatus,adminId,nextStatus,nextStatus,adminId,nextStatus,nextStatus,adminId,nextStatus,
      nextStatus,adminId,nextStatus,nextStatus,adminId,nextStatus,reopening ? 1 : 0,id]
  );
  await pool.query(
    `INSERT INTO sentinel_case_status_history (id,case_id,admin_id,from_status,to_status,reason) VALUES (?,?,?,?,?,?)`,
    [crypto.randomUUID(),id,adminId || null,current.status,nextStatus,(note || resolution || `status -> ${nextStatus}`).slice(0,512)]
  );
  await recordAction(id, 'transition', { adminId, detail:`${current.status} -> ${nextStatus}` });
  if (note) await appendCaseNote(id, note, adminId, 'transition');
  return getCaseById(id);
}

async function setCaseNote(id, note, adminId) {
  await appendCaseNote(id, note, adminId, 'analyst');
  const pool = getPool();
  await pool.query(`UPDATE sentinel_threat_cases SET review_note=? WHERE id=?`, [String(note || '').slice(0,4000),id]);
  return getCaseById(id);
}

async function countOpenCases() {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT
       SUM(CASE WHEN status IN ('open','triage','investigating','reopened') THEN 1 ELSE 0 END) AS open_review,
       SUM(CASE WHEN status IN ('open','triage','investigating','reopened') AND severity = 'critical' THEN 1 ELSE 0 END) AS open_critical,
       SUM(CASE WHEN status = 'monitoring' THEN 1 ELSE 0 END) AS watching
     FROM sentinel_threat_cases`
  );
  return {
    openReview: Number(rows[0]?.open_review) || 0,
    openCritical: Number(rows[0]?.open_critical) || 0,
    watching: Number(rows[0]?.watching) || 0,
  };
}

async function attachCaseMetaToFindings(findings = []) {
  if (!findings.length) return findings;
  const pool = getPool();
  const fps = findings.map(fingerprintFor);
  if (!fps.length) return findings;
  const placeholders = fps.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT id, fingerprint, status, severity FROM sentinel_threat_cases
     WHERE fingerprint IN (${placeholders})`,
    fps
  );
  const byFp = new Map(rows.map((r) => [r.fingerprint, r]));
  return findings.map((f) => {
    const row = byFp.get(fingerprintFor(f));
    if (!row) return { ...f, caseId: null, caseStatus: null };
    return {
      ...f,
      caseId: row.id,
      caseStatus: row.status,
    };
  });
}

module.exports = {
  fingerprintFor,
  mapCase,
  listCases,
  getCaseOperationsReport,
  getCaseById,
  getCaseByFingerprint,
  listActions,
  listNotes,
  listStatusHistory,
  appendCaseNote,
  assignCaseOwner,
  recordAction,
  syncFindingsToCases,
  transitionCase,
  transitionCaseLifecycle,
  setCaseNote,
  countOpenCases,
  attachCaseMetaToFindings,
  OPENISH,
  CASE_STATUSES,
  DISPOSITIONS,
};
