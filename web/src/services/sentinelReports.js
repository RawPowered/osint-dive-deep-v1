const { getPool } = require('../db/pool');
const { getPostureBundle } = require('./sentinelThreats');
const { clampHours } = require('./sentinel');

async function buildDailySocReport({ sinceHours = 24 } = {}) {
  const pool = getPool();
  const hours = clampHours(sinceHours);
  const posture = await getPostureBundle({ sinceHours:hours });
  const [priorityCases] = await pool.query(
    `SELECT id,severity,status,title,entity_type,entity,owner_admin_id,due_at,last_seen,reopen_count
     FROM sentinel_threat_cases WHERE status NOT IN ('resolved','closed')
     ORDER BY (due_at<UTC_TIMESTAMP(3)) DESC,FIELD(severity,'critical','high','medium','low','info'),due_at,last_seen DESC LIMIT 25`
  );
  const [caseFlow] = await pool.query(
    `SELECT
       SUM(created_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS opened,
       SUM(triaged_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS triaged,
       SUM(contained_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS contained,
       SUM(resolved_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS resolved,
       SUM(closed_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS closed,
       SUM(status='reopened' AND updated_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS reopened
     FROM sentinel_threat_cases`, [hours,hours,hours,hours,hours,hours]
  );
  const [blocks] = await pool.query(
    `SELECT
       SUM(created_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS created,
       SUM(revoked_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR) AS revoked,
       SUM(is_active=1 AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3))) AS active
     FROM sentinel_ip_blocks`, [hours,hours]
  );
  const [actions] = await pool.query(
    `SELECT action,COUNT(*) AS total FROM sentinel_case_actions
     WHERE created_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR GROUP BY action ORDER BY total DESC`, [hours]
  );
  const [analystNotes] = await pool.query(
    `SELECT COUNT(*) AS notes,COUNT(DISTINCT admin_id) AS analysts FROM sentinel_case_notes
     WHERE created_at>=UTC_TIMESTAMP(3)-INTERVAL ? HOUR`, [hours]
  );
  return {
    generatedAt:new Date().toISOString(),windowHours:hours,
    posture:{ score:posture.posture.score,grade:posture.posture.grade,factors:posture.posture.factors },
    telemetry:{
      apiRequests:Number(posture.apiSummary?.totals?.requests)||0,
      apiErrors:Number(posture.apiSummary?.totals?.errors)||0,
      unauthorized:Number(posture.apiSummary?.totals?.unauthorized)||0,
      loginEvents:Number(posture.loginSummary?.totals?.total)||0,
      loginFailures:Number(posture.loginSummary?.totals?.failures)||0,
      freshness:posture.freshness,
    },
    threats:{ counts:posture.threats?.counts || {}, newFirstFailIps:Number(posture.response?.newAuthFailIps)||0 },
    operations:posture.response?.operations || { totals:{} },
    caseFlow:numericRow(caseFlow[0]),
    containment:numericRow(blocks[0]),
    analystActivity:{ ...numericRow(analystNotes[0]), actions:Object.fromEntries(actions.map((row)=>[row.action,Number(row.total)||0])) },
    priorityCases:priorityCases.map((row)=>({
      id:row.id,severity:row.severity,status:row.status,title:row.title,entityType:row.entity_type,
      entity:row.entity,ownerAdminId:row.owner_admin_id,dueAt:row.due_at,lastSeen:row.last_seen,
      reopenCount:Number(row.reopen_count)||0,
    })),
  };
}

function numericRow(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value)||0]));
}

function formatDailySocMarkdown(report) {
  const t = report.telemetry || {};
  const flow = report.caseFlow || {};
  const ops = report.operations?.totals || {};
  const lines = [
    '# Sentinel Daily SOC Report','',
    `- Generated: ${report.generatedAt}`,
    `- Window: ${report.windowHours} hours`,
    `- Posture: ${report.posture?.score ?? '—'} (${report.posture?.grade || 'unknown'})`,'',
    '## Daily protection summary','',
    `- API requests: ${t.apiRequests || 0} (${t.apiErrors || 0} errors; ${t.unauthorized || 0} unauthorized)`,
    `- Authentication: ${t.loginEvents || 0} events; ${t.loginFailures || 0} failures`,
    `- Cases: ${flow.opened || 0} opened; ${flow.triaged || 0} triaged; ${flow.contained || 0} contained; ${flow.resolved || 0} resolved; ${flow.closed || 0} validated closed; ${flow.reopened || 0} reopened`,
    `- SLA: ${ops.slaBreached || 0} breached; ${ops.dueSoon || 0} due soon; ${ops.unassigned || 0} unassigned`,
    `- Containment: ${report.containment?.created || 0} blocks created; ${report.containment?.revoked || 0} revoked; ${report.containment?.active || 0} active`,'',
    '## Shift handoff priorities','',
  ];
  for (const item of (report.priorityCases || []).slice(0,15)) {
    lines.push(`- [${String(item.severity).toUpperCase()}] ${item.title} — ${item.status}; owner ${item.ownerAdminId || 'UNASSIGNED'}; entity ${item.entityType}:${item.entity}`);
  }
  if (!report.priorityCases?.length) lines.push('- No active cases require handoff.');
  lines.push('','## Posture factors','');
  for (const factor of report.posture?.factors || []) lines.push(`- ${factor.detail} (${factor.impact})`);
  if (!report.posture?.factors?.length) lines.push('- No negative posture factors.');
  lines.push('','_Report contains operational metadata only. Secrets and raw forensic payloads are excluded._','');
  return lines.join('\n');
}

module.exports = { buildDailySocReport, formatDailySocMarkdown };
