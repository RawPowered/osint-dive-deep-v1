const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getAuthorizedIntegration, integrationCredential, LEADCONNECTOR_ORIGIN } = require('./crmIntegrations');
const { buildCrmContactUrl } = require('./dncPulse');

const PAGE_SIZE = 100;
const PAGE_LIMIT = 10000;

async function createCampaignSync(input, admin, pool = null) {
  const p = pool || getPool();
  const integration = await getAuthorizedIntegration(input.integrationId, input.apiKeyId, 'allow_read', p);
  if (new URL(integration.base_url).origin !== LEADCONNECTOR_ORIGIN) {
    throw Object.assign(new Error('Campaign Monitor requires the direct LeadConnector Private Integration'), { status: 409 });
  }
  const [active] = await p.query(
    `SELECT id FROM eagle_campaign_sync_runs
     WHERE integration_id = ? AND status IN ('queued','running') LIMIT 1`, [integration.id]
  );
  if (active[0]) throw Object.assign(new Error('A campaign activity sync is already running'), { status: 409 });
  const rangeStart = validDate(input.startAt || process.env.EAGLE_CAMPAIGN_START_DATE || '2020-01-01', 'startAt');
  const rangeEnd = validDate(input.endAt || new Date().toISOString().slice(0, 10), 'endAt');
  if (rangeStart > rangeEnd) throw Object.assign(new Error('Campaign start date must not follow end date'), { status: 400 });
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO eagle_campaign_sync_runs
       (id,integration_id,api_key_id,location_id,range_start,range_end,requested_by)
     VALUES (?,?,?,?,?,?,?)`,
    [id, integration.id, input.apiKeyId, integration.location_id, rangeStart, rangeEnd, admin?.id || null]
  );
  setImmediate(() => executeCampaignSync(integration, id, p).catch((error) => {
    console.error(`Campaign sync ${id} failed:`, error.message);
  }));
  return getCampaignSync(id, input.apiKeyId, p);
}

async function executeCampaignSync(integration, runId, pool = null) {
  const p = pool || getPool();
  const run = await getCampaignSync(runId, null, p);
  await p.query(`UPDATE eagle_campaign_sync_runs SET status='running',started_at=CURRENT_TIMESTAMP WHERE id=?`, [runId]);
  let page = 1; let received = 0; let expected = null;
  try {
    const credential = integrationCredential(integration);
    if (!credential) throw Object.assign(new Error('CRM integration credential is unavailable'), { status: 409 });
    while (page <= PAGE_LIMIT) {
      const body = await fetchSubmissionPage(integration, credential, page, dateOnly(run.rangeStart), dateOnly(run.rangeEnd));
      const submissions = Array.isArray(body.submissions) ? body.submissions : [];
      expected = Number.isFinite(Number(body.meta?.total)) ? Number(body.meta.total) : expected;
      if (submissions.length) await upsertEvents(p, integration, runId, submissions);
      received += submissions.length;
      await p.query(
        `UPDATE eagle_campaign_sync_runs SET pages_processed=?,events_received=?,expected_events=? WHERE id=?`,
        [page, received, expected, runId]
      );
      const nextPage = Number(body.meta?.nextPage);
      if (!submissions.length || !nextPage || submissions.length < PAGE_SIZE) break;
      page = nextPage;
      await sleep(200);
    }
    if (page > PAGE_LIMIT) throw new Error(`Campaign sync exceeded the ${PAGE_LIMIT}-page safety ceiling`);
    await p.query(
      `UPDATE eagle_campaign_sync_runs SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?`, [runId]
    );
  } catch (error) {
    await p.query(
      `UPDATE eagle_campaign_sync_runs SET status='failed',error_summary=?,completed_at=CURRENT_TIMESTAMP WHERE id=?`,
      [String(error.message || 'Campaign sync failed').slice(0, 1000), runId]
    );
    throw error;
  }
  return getCampaignSync(runId, null, p);
}

async function fetchSubmissionPage(integration, credential, page, startAt, endAt) {
  const url = new URL('/forms/submissions', LEADCONNECTOR_ORIGIN);
  url.searchParams.set('locationId', integration.location_id);
  url.searchParams.set('page', String(page)); url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('startAt', startAt); url.searchParams.set('endAt', endAt);
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, { headers: { Accept:'application/json', Authorization:`Bearer ${credential}`, Version:'v3' }, redirect:'error' });
    if (response.ok || (response.status !== 429 && response.status < 500)) break;
    await sleep((attempt + 1) * 1000);
  }
  if (!response.ok) {
    const message = response.status === 403
      ? 'CRM token lacks forms.readonly; grant that scope for Campaign Monitor'
      : `CRM form submission request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: 502 });
  }
  const body = await response.json();
  if (!Array.isArray(body.submissions)) throw Object.assign(new Error('CRM form submission response is invalid'), { status: 502 });
  return body;
}

async function upsertEvents(pool, integration, runId, submissions) {
  const rows = submissions.map((submission) => normalizeSubmission(submission, integration, runId)).filter(Boolean);
  if (!rows.length) return;
  const placeholders = rows.map(() => `(${rows[0].map(() => '?').join(',')})`).join(',');
  await pool.query(
    `INSERT INTO eagle_campaign_events
       (integration_id,event_id,location_id,contact_id,form_id,form_name,event_type,event_at,
        page_url,page_title,page_domain,page_path,referrer_url,referrer_host,source,medium,ad_source,
        utm_source,utm_medium,utm_campaign,utm_content,fbclid,fbc,fbp,fb_event_id,gclid,last_sync_run_id)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE contact_id=VALUES(contact_id),form_id=VALUES(form_id),form_name=VALUES(form_name),
       event_type=VALUES(event_type),event_at=VALUES(event_at),page_url=VALUES(page_url),page_title=VALUES(page_title),
       page_domain=VALUES(page_domain),page_path=VALUES(page_path),referrer_url=VALUES(referrer_url),
       referrer_host=VALUES(referrer_host),source=VALUES(source),medium=VALUES(medium),ad_source=VALUES(ad_source),
       utm_source=VALUES(utm_source),utm_medium=VALUES(utm_medium),utm_campaign=VALUES(utm_campaign),
       utm_content=VALUES(utm_content),fbclid=VALUES(fbclid),fbc=VALUES(fbc),fbp=VALUES(fbp),
       fb_event_id=VALUES(fb_event_id),gclid=VALUES(gclid),last_sync_run_id=VALUES(last_sync_run_id),
       last_seen_at=CURRENT_TIMESTAMP`,
    rows.flat()
  );
}

function normalizeSubmission(submission, integration, runId) {
  const eventId = text(submission?.id, 191);
  const eventAt = mysqlDate(submission?.createdAt || submission?.dateAdded);
  if (!eventId || !eventAt) return null;
  const event = submission?.others?.eventData || submission?.eventData || {};
  const page = event.page || {};
  const pageUrl = safeUrl(page.url || event.url);
  const referrer = safeUrl(event.referrer);
  const params = pageUrl?.searchParams;
  return [
    integration.id,eventId,integration.location_id,text(submission.contactId,191),text(submission.formId,191),
    text(event.parentName || submission.formName,255),text(event.type || event.pageVisitType || 'form-submission',64),eventAt,
    text(pageUrl?.toString(),1600),text(page.title || event.pageTitle,500),text(page.domain || pageUrl?.hostname,255),text(pageUrl?.pathname,800),
    text(referrer?.toString(),1600),text(referrer?.hostname,255),text(event.source,191),text(event.medium,128),text(event.adSource,191),
    text(event.utmSource || event.utmEventSource || params?.get('utm_source'),191),text(event.utmMedium || params?.get('utm_medium'),191),
    text(event.utmCampaign || params?.get('utm_campaign'),255),text(event.utmContent || params?.get('utm_content'),255),
    text(event.fbclid || params?.get('fbclid'),1024),text(event.fbc,512),text(event.fbp,512),text(event.fbEventId,512),
    text(event.gclid || params?.get('gclid'),1024),runId,
  ];
}

async function getCampaignSync(id, apiKeyId = null, pool = null) {
  const p = pool || getPool(); const params = [id];
  const keyFilter = apiKeyId ? ' AND api_key_id=?' : '';
  if (apiKeyId) params.push(apiKeyId);
  const [rows] = await p.query(
    `SELECT id,integration_id AS integrationId,api_key_id AS apiKeyId,location_id AS locationId,status,
            pages_processed AS pagesProcessed,events_received AS eventsReceived,expected_events AS expectedEvents,
            range_start AS rangeStart,range_end AS rangeEnd,error_summary AS errorSummary,
            started_at AS startedAt,completed_at AS completedAt,created_at AS createdAt
     FROM eagle_campaign_sync_runs WHERE id=?${keyFilter} LIMIT 1`, params
  );
  if (!rows[0]) throw Object.assign(new Error('Campaign sync not found'), { status:404 });
  return rows[0];
}

async function getCampaignReport(input, pool = null) {
  const p = pool || getPool();
  const [snapshots] = await p.query(
    `SELECT integration_id AS integrationId,location_id AS locationId,
            completed_at AS completedAt,created_at AS createdAt FROM eagle_snapshots
     WHERE id=? AND api_key_id=? LIMIT 1`, [input.snapshotId, input.apiKeyId]
  );
  const snapshot = snapshots[0];
  if (!snapshot || String(snapshot.integrationId) !== String(input.integrationId)) {
    throw Object.assign(new Error('Campaign report context is invalid'), { status:403 });
  }
  const days = [7,30,90,365].includes(Number(input.days)) ? Number(input.days) : null;
  const asOf = snapshot.completedAt || snapshot.createdAt || new Date();
  const dateSql = days ? ' AND e.event_at > DATE_SUB(?, INTERVAL ? DAY) AND e.event_at <= ?' : '';
  const params = [input.snapshotId, input.integrationId, snapshot.locationId, ...(days ? [asOf,days,asOf] : [])];
  const base = `FROM eagle_campaign_events e LEFT JOIN eagle_lead_facts f
    ON f.snapshot_id=? AND f.external_contact_id=e.contact_id
    WHERE e.integration_id=? AND e.location_id=?${dateSql}`;
  const query = (select, suffix = '') => p.query(`${select} ${base} ${suffix}`, params).then(([rows]) => rows);
  const [summaryRows,pages,forms,social,trend,events,latestRuns] = await Promise.all([
    query(`SELECT COUNT(*) AS submissions,COUNT(DISTINCT e.contact_id) AS contacts,
      COUNT(DISTINCT NULLIF(e.page_url,'')) AS landingPages,COUNT(DISTINCT NULLIF(e.form_id,'')) AS forms,
      COUNT(DISTINCT CASE WHEN f.crm_disposition='Scheduled' THEN e.contact_id END) AS scheduledContacts,
      COUNT(DISTINCT CASE WHEN f.crm_disposition='Closed Won' THEN e.contact_id END) AS wonContacts,
      SUM(${facebookSql()}) AS facebookSubmissions`),
    query(`SELECT COALESCE(NULLIF(e.page_title,''),NULLIF(e.page_path,''),e.page_domain,'Unknown page') AS label,
      MAX(e.page_url) AS url,COUNT(*) AS submissions,COUNT(DISTINCT e.contact_id) AS contacts,
      COUNT(DISTINCT CASE WHEN f.crm_disposition='Scheduled' THEN e.contact_id END) AS scheduled,
      COUNT(DISTINCT CASE WHEN f.crm_disposition='Closed Won' THEN e.contact_id END) AS won`,
      'GROUP BY e.page_domain,e.page_path,e.page_title ORDER BY submissions DESC LIMIT 25'),
    query(`SELECT COALESCE(NULLIF(e.form_name,''),NULLIF(e.form_id,''),'Unknown form') AS label,
      COUNT(*) AS submissions,COUNT(DISTINCT e.contact_id) AS contacts,
      COUNT(DISTINCT CASE WHEN f.crm_disposition='Scheduled' THEN e.contact_id END) AS scheduled,
      COUNT(DISTINCT CASE WHEN f.crm_disposition='Closed Won' THEN e.contact_id END) AS won`,
      'GROUP BY e.form_id,e.form_name ORDER BY submissions DESC LIMIT 25'),
    query(`SELECT COALESCE(NULLIF(e.utm_campaign,''),NULLIF(e.utm_content,''),NULLIF(e.ad_source,''),NULLIF(e.referrer_host,''),'Unlabeled Facebook traffic') AS label,
      MAX(e.utm_content) AS content,MAX(e.referrer_host) AS referrer,COUNT(*) AS submissions,
      COUNT(DISTINCT e.contact_id) AS contacts,
      COUNT(DISTINCT CASE WHEN f.crm_disposition='Scheduled' THEN e.contact_id END) AS scheduled,
      COUNT(DISTINCT CASE WHEN f.crm_disposition='Closed Won' THEN e.contact_id END) AS won`,
      `AND ${facebookSql()} GROUP BY label ORDER BY submissions DESC LIMIT 25`),
    query(`SELECT DATE(e.event_at) AS date,COUNT(*) AS submissions,COUNT(DISTINCT e.contact_id) AS contacts`,
      'GROUP BY DATE(e.event_at) ORDER BY date'),
    query(`SELECT e.event_id AS eventId,e.contact_id AS contactId,e.form_name AS formName,e.event_type AS eventType,
      e.event_at AS eventAt,e.page_url AS pageUrl,e.page_title AS pageTitle,e.referrer_host AS referrerHost,
      e.source,e.medium,e.utm_source AS utmSource,e.utm_campaign AS utmCampaign,e.utm_content AS utmContent,
      e.fbclid,f.full_name AS contactName,f.crm_disposition AS disposition`,
      'ORDER BY e.event_at DESC LIMIT 100'),
    p.query(`SELECT id,status,pages_processed AS pagesProcessed,events_received AS eventsReceived,
      expected_events AS expectedEvents,error_summary AS errorSummary,completed_at AS completedAt,created_at AS createdAt
      FROM eagle_campaign_sync_runs WHERE integration_id=? ORDER BY created_at DESC LIMIT 1`, [input.integrationId]).then(([rows]) => rows),
  ]);
  const locationId = snapshot.locationId;
  return {
    summary:numeric(summaryRows[0] || {}), pages:rowsNumeric(pages), forms:rowsNumeric(forms),
    social:rowsNumeric(social), trend:rowsNumeric(trend), sync:latestRuns[0] || null,
    events:events.map((row) => ({ ...row, crmUrl:safeCrmUrl(row.contactId,locationId) })),
  };
}

function facebookSql() { return `(LOWER(COALESCE(e.utm_source,''))='facebook' OR LOWER(COALESCE(e.source,'')) LIKE '%facebook%' OR LOWER(COALESCE(e.referrer_host,'')) LIKE '%facebook%' OR e.fbclid IS NOT NULL OR e.fbc IS NOT NULL)`; }
function safeUrl(value) {
  try {
    const url=new URL(String(value||''));
    if(!['http:','https:'].includes(url.protocol))return null;
    url.username='';url.password='';url.hash='';
    const allowed=new Set(['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid','fbc','fbp','campaign_id','ad_id','adset_id']);
    for(const key of [...url.searchParams.keys()])if(!allowed.has(key.toLowerCase()))url.searchParams.delete(key);
    return url;
  } catch { return null; }
}
function safeCrmUrl(contactId,locationId) { try { return contactId ? buildCrmContactUrl({contactId,locationId}) : null; } catch { return null; } }
function mysqlDate(value) { const date=new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0,19).replace('T',' '); }
function dateOnly(value) { const date=new Date(value); return Number.isNaN(date.getTime()) ? String(value).slice(0,10) : date.toISOString().slice(0,10); }
function text(value,max) { const result=String(value||'').trim(); return result ? result.slice(0,max) : null; }
function validDate(value,label) { const text=String(value||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) throw Object.assign(new Error(`${label} must be YYYY-MM-DD`),{status:400}); return text; }
function numeric(row) { return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,/^-?\d+(\.\d+)?$/.test(String(value??''))?Number(value):value])); }
function rowsNumeric(rows) { return rows.map(numeric); }
function sleep(ms) { return new Promise((resolve)=>setTimeout(resolve,ms)); }

module.exports = { createCampaignSync,executeCampaignSync,getCampaignSync,getCampaignReport,normalizeSubmission };
