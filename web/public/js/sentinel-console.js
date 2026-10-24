/**
 * Sentinel OpSec Console — admin-only UI logic
 */
(function () {
  'use strict';

  const base = location.pathname.replace(/\/sentinel\/?$/, '') || '';
  const PAGE = 50;

  const state = {
    hours: 24,
    refreshSec: 0,
    refreshTimer: null,
    countdownTimer: null,
    countdown: 0,
    tab: 'posture',
    summary: null,
    threats: null,
    loginOffset: 0,
    apiOffset: 0,
    loginTotal: 0,
    apiTotal: 0,
    loginFilters: {},
    apiFilters: {},
    invFilters: {},
    invCursor: null,
    invItems: [],
    invEntity: null,
    caseFilters: { status: 'open' },
    caseReport: null,
    admin: null,
    cases: [],
    selectedCaseId: null,
    pivot: {},
    canRevealForensics: false,
    evidenceEvent: null,
    evidenceData: null,
    evidenceTab: 'overview',
    dailyReport: null,
    dailyMarkdown: '',
    validationRuns: [],
    selectedValidationRun: null,
    playbooks: [], playbookRuns: [], playbookSimulations: [], selectedPlaybook: null, selectedPlaybookRun: null,
    resources: [], selectedResource: null,
    databaseOffsetMinutes: null,
  };

  const $ = (id) => document.getElementById(id);
  const alertEl = $('alert');

  function showAlert(type, msg) {
    alertEl.hidden = false;
    alertEl.className = 'alert alert-' + type;
    alertEl.textContent = msg;
  }

  function clearAlert() {
    alertEl.hidden = true;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseTimestamp(dt) {
    if (!dt) return null;
    if (dt instanceof Date) return dt;
    const value = String(dt).trim();
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) return new Date(value);
    const sql = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (sql && Number.isFinite(state.databaseOffsetMinutes)) {
      const ms = Number((sql[7] || '').padEnd(3, '0')) || 0;
      return new Date(Date.UTC(
        Number(sql[1]), Number(sql[2]) - 1, Number(sql[3]),
        Number(sql[4]), Number(sql[5]), Number(sql[6]), ms
      ) - (state.databaseOffsetMinutes * 60000));
    }
    return new Date(value);
  }

  function fmt(dt) {
    if (!dt) return '—';
    try {
      const parsed = parseTimestamp(dt);
      return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleString() : String(dt);
    } catch {
      return String(dt);
    }
  }

  function socDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    if (value < 3600) return Math.round(value / 60) + 'm';
    if (value < 86400) return (value / 3600).toFixed(value < 36000 ? 1 : 0) + 'h';
    return (value / 86400).toFixed(1) + 'd';
  }

  function relTime(dt) {
    if (!dt) return '';
    const parsed = parseTimestamp(dt);
    const t = parsed ? parsed.getTime() : NaN;
    if (Number.isNaN(t)) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < -5) return 'clock skew';
    if (s < 1) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function pct(n) {
    return Math.round((Number(n) || 0) * 1000) / 10 + '%';
  }

  function outcomeBadge(outcome) {
    if (outcome === 'success') return '<span class="badge badge-ok">success</span>';
    if (outcome === 'failure') return '<span class="badge badge-revoked">failure</span>';
    return '<span class="badge">' + escapeHtml(outcome || '—') + '</span>';
  }

  function sevBadge(sev) {
    const s = sev || 'info';
    return '<span class="sev sev-' + escapeHtml(s) + '">' + escapeHtml(s) + '</span>';
  }

  async function apiGet(path) {
    const res = await fetch(base + path, {
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    if (res.status === 401) {
      location.href = base + '/login?next=' + encodeURIComponent(base + '/sentinel');
      throw new Error('auth');
    }
    if (!res.ok) {
      let msg = 'http ' + res.status;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }

  async function apiSend(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.href = base + '/login?next=' + encodeURIComponent(base + '/sentinel');
      throw new Error('auth');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || 'http ' + res.status);
    return data;
  }

  function qs(obj) {
    const p = new URLSearchParams();
    Object.keys(obj).forEach((k) => {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') p.set(k, obj[k]);
    });
    return p.toString();
  }

  function statusBadge(status) {
    return '<span class="case-badge ' + escapeHtml(status || '') + '">' + escapeHtml(status || '—') + '</span>';
  }

  // ——— Tabs ———
  function setTab(name) {
    state.tab = name;
    document.querySelectorAll('.sentinel-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === name);
    });
    document.querySelectorAll('.sentinel-panel').forEach((p) => {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
  }

  // ——— Score ring ———
  function renderScoreRing(score, grade) {
    const svg = $('scoreRing');
    const r = 52;
    const c = 2 * Math.PI * r;
    const clamped = Math.max(0, Math.min(100, Number(score) || 0));
    const offset = c - (clamped / 100) * c;
    const color =
      grade === 'critical'
        ? '#ef4444'
        : grade === 'elevated'
          ? '#fb923c'
          : grade === 'watch'
            ? '#fbbf24'
            : '#22c55e';
    svg.innerHTML =
      '<circle cx="60" cy="60" r="' +
      r +
      '" fill="none" stroke="rgba(36,48,73,0.9)" stroke-width="10"/>' +
      '<circle cx="60" cy="60" r="' +
      r +
      '" fill="none" stroke="' +
      color +
      '" stroke-width="10" stroke-linecap="round" ' +
      'stroke-dasharray="' +
      c +
      '" stroke-dashoffset="' +
      offset +
      '" transform="rotate(-90 60 60)"/>';
  }

  function renderBars(hourly, mode) {
    const el = $('activityChart');
    if (!hourly || !hourly.length) {
      el.innerHTML = '<span class="muted small">No bucket data</span>';
      return;
    }
    const key = mode === 'login' ? 'failures' : 'requests';
    const max = Math.max(1, ...hourly.map((h) => Number(h[key] || h.requests || 0)));
    el.innerHTML = hourly
      .map((h) => {
        const v = Number(h[key] || h.requests || 0);
        const err = Number(h.errors || h.failures || 0);
        const ht = Math.max(2, Math.round((v / max) * 80));
        const cls = err > 0 && err >= v * 0.3 ? 'bar err' : 'bar';
        const title = (h.bucket || '') + ' · ' + v;
        return '<div class="' + cls + '" style="height:' + ht + 'px" title="' + escapeHtml(title) + '"></div>';
      })
      .join('');
  }

  // ——— Renderers ———
  function renderPosture(data) {
    const p = data.posture || {};
    const grade = p.grade || 'healthy';
    $('scoreNum').textContent = p.score != null ? p.score : '—';
    $('scoreGrade').textContent = grade;
    $('scoreGrade').className = 'score-grade grade-' + grade;
    renderScoreRing(p.score, grade);

    const t = (data.summary && data.summary.totals) || {};
    const lt = (data.loginSummary && data.loginSummary.totals) || {};
    const lat = (data.summary && data.summary.latency) || {};
    const thr = (data.threats && data.threats.counts) || {};

    const resp = data.response || {};
    const openCases = resp.openCases || {};
    $('postureKpis').innerHTML = [
      kpi('API requests', t.requests, pct(t.errorRate) + ' errors'),
      kpi('API 401s', t.unauthorized, pct(t.unauthorizedRate)),
      kpi('Login events', lt.total, pct(lt.failRate) + ' fail'),
      kpi('Login fails', lt.failures, lt.successes + ' ok'),
      kpi('p95 latency', lat.p95 != null ? lat.p95 + 'ms' : '—', 'p50 ' + (lat.p50 != null ? lat.p50 + 'ms' : '—')),
      kpi('Open threats', (thr.critical || 0) + (thr.high || 0) + (thr.medium || 0) + (thr.low || 0), (thr.critical || 0) + ' critical'),
      kpi('Review queue', openCases.openReview != null ? openCases.openReview : '—', (openCases.openCritical || 0) + ' critical open'),
      kpi('New first-fail IPs', resp.newAuthFailIps != null ? resp.newAuthFailIps : '—', 'first contact = auth fail'),
    ].join('');
    const prior = data.comparison || {};
    const ops = (data.response && data.response.operations && data.response.operations.totals) || {};
    const fresh = data.freshness || {};
    const trend = (current, previous) => { const delta=Number(current||0)-Number(previous||0); return (delta>0?'+':'')+delta+' vs prior'; };
    $('postureKpis').innerHTML = [
      postureKpi('API traffic',t.requests,trend(t.requests,prior.api?.requests),'api'),
      postureKpi('Unauthorized',t.unauthorized,trend(t.unauthorized,prior.api?.unauthorized),'api-unauthorized'),
      postureKpi('Login failures',lt.failures,trend(lt.failures,prior.login?.failures),'logins'),
      postureKpi('Critical threats',thr.critical||0,(thr.high||0)+' high','threats'),
      postureKpi('SLA breached',ops.slaBreached||0,(ops.dueSoon||0)+' due soon','sla'),
      postureKpi('Unassigned',ops.unassigned||0,'active cases without owners','unassigned'),
      postureKpi('Awaiting validation',ops.awaitingValidation||0,'resolved cases','validation'),
      postureKpi('Closure quality',Math.round((Number(ops.closureQualityRate)||0)*100)+'%','documented + validated','closed'),
    ].join('');
    $('scoreContext').textContent='Calculated '+fmt(fresh.calculatedAt)+' · response quality included';
    $('telemetryFreshness').innerHTML=[['API telemetry',fresh.apiLastSeen],['Authentication',fresh.loginLastSeen],['Cases',fresh.caseLastUpdated]].map((item)=>'<span class="freshness-item"><strong>'+escapeHtml(item[0])+'</strong> '+escapeHtml(relTime(item[1])||'no data')+'</span>').join('');

    renderBars((data.summary && data.summary.hourly) || [], 'api');

    const counts = thr;
    $('sevBreakdown').innerHTML = ['critical', 'high', 'medium', 'low']
      .map((s) => sevBadge(s) + ' <strong>' + (counts[s] || 0) + '</strong>')
      .join(' &nbsp; ');

    const findings = (data.threats && data.threats.findings) || [];
    const priorities=[];
    if(ops.slaBreached) priorities.push({label:ops.slaBreached+' breached case SLA(s)',pivot:'sla',severity:'critical'});
    if(ops.unassigned) priorities.push({label:ops.unassigned+' active case(s) need ownership',pivot:'unassigned',severity:'high'});
    if(ops.awaitingValidation) priorities.push({label:ops.awaitingValidation+' resolved case(s) await validation',pivot:'validation',severity:'medium'});
    findings.slice(0,5).forEach((finding)=>priorities.push({label:finding.title+' — '+finding.summary,pivot:'threats',severity:finding.severity}));
    $('posturePriorityQueue').innerHTML=priorities.length?priorities.slice(0,8).map((item)=>'<button type="button" class="posture-priority-item" data-posture-pivot="'+escapeHtml(item.pivot)+'">'+sevBadge(item.severity)+'<span>'+escapeHtml(item.label)+'</span></button>').join(''):'<p class="muted">No immediate response items.</p>';
    const actions = findings.slice(0, 5).map((f) => f.recommendedAction).filter(Boolean);
    $('recActions').innerHTML = actions.length
      ? actions.map((a) => '<li>' + escapeHtml(a) + '</li>').join('')
      : '<li class="muted">No urgent actions — posture clear for this window.</li>';

    const factors = p.factors || [];
    $('postureFactors').innerHTML = factors.length
      ? '<ul>' +
        factors
          .map(
            (f) =>
              '<li><code>' +
              escapeHtml(f.code) +
              '</code> ' +
              escapeHtml(f.detail) +
              ' <span class="muted">(' +
              f.impact +
              ')</span></li>'
          )
          .join('') +
        '</ul>'
      : 'No negative factors detected.';
    document.querySelectorAll('[data-posture-pivot]').forEach((button)=>button.onclick=()=>posturePivot(button.dataset.posturePivot));
  }

  function postureKpi(label,value,sub,pivot) {
    return '<button type="button" class="kpi posture-kpi" data-posture-pivot="'+escapeHtml(pivot)+'"><div class="kpi-label">'+escapeHtml(label)+'</div><div class="kpi-value">'+escapeHtml(String(value==null?'—':value))+'</div><div class="kpi-sub">'+escapeHtml(sub||'')+'</div></button>';
  }

  function posturePivot(pivot) {
    if(pivot==='api'||pivot==='api-unauthorized'){setTab('api');if(pivot==='api-unauthorized'){state.apiFilters={status:'401'};$('afStatus').value='401';}loadApiEvents();return;}
    if(pivot==='logins'){setTab('logins');state.loginFilters={outcome:'failure'};$('lfOutcome').value='failure';loadLogins();return;}
    if(pivot==='threats'){setTab('threats');return;}
    setTab('review');state.caseFilters={};
    if(pivot==='sla')state.caseFilters.sla='breached';
    if(pivot==='unassigned')state.caseFilters.owner='unassigned';
    if(pivot==='validation')state.caseFilters.status='resolved';
    if(pivot==='closed')state.caseFilters.status='closed';
    loadCases();
  }

  function kpi(label, value, sub) {
    return (
      '<div class="kpi"><div class="kpi-label">' +
      escapeHtml(label) +
      '</div><div class="kpi-value">' +
      escapeHtml(String(value != null ? value : '—')) +
      '</div><div class="kpi-sub">' +
      escapeHtml(sub || '') +
      '</div></div>'
    );
  }

  function renderThreats(findings) {
    const list = $('threatList');
    $('threatCount').textContent = (findings || []).length + ' finding(s)';
    if (!findings || !findings.length) {
      list.innerHTML = '<div class="threat-empty">No active threats in this window</div>';
      return;
    }
    list.innerHTML = findings
      .map((f, idx) => {
        const caseBit = f.caseId
          ? statusBadge(f.caseStatus || 'open')
          : '';
        const isIp = f.entityType === 'ip';
        const context = f.context || {};
        return (
          '<div class="threat-card-wrap" data-idx="' +
          idx +
          '">' +
          '<button type="button" class="threat-main" data-entity-type="' +
          escapeHtml(f.entityType || '') +
          '" data-entity="' +
          escapeHtml(f.entity || '') +
          '">' +
          sevBadge(f.severity) +
          '<div><h3>' +
          escapeHtml(f.title) +
          caseBit +
          '</h3><p>' +
          escapeHtml(f.summary) +
          '</p><div class="threat-meta">' +
          escapeHtml(f.entityType) +
          ': ' +
          escapeHtml(f.entity) +
          ' · last ' +
          escapeHtml(relTime(f.lastSeen) || fmt(f.lastSeen)) +
          (context.statusCode != null ? ' · HTTP ' + escapeHtml(context.statusCode) : '') +
          (context.keyPrefix ? ' · key ' + escapeHtml(context.keyPrefix) + '…' : '') +
          (context.ip ? ' · IP ' + escapeHtml(context.ip) : '') +
          (f.reactivated ? ' · REACTIVATED: ' + escapeHtml((f.reactivationReasons || []).join(', ')) : '') +
          '</div></div>' +
          '<div class="threat-count">' +
          escapeHtml(String(f.count || 0)) +
          '</div></button>' +
          '<div class="threat-actions">' +
          '<button type="button" class="btn btn-secondary btn-sm act-inv" data-entity-type="' +
          escapeHtml(f.entityType || '') +
          '" data-entity="' +
          escapeHtml(f.entity || '') +
          '">Investigate</button>' +
          '<button type="button" class="btn btn-secondary btn-sm act-disposition" data-finding-id="' + escapeHtml(f.id) + '">Resolve / classify</button>' +
          (f.caseId
            ? '<button type="button" class="btn btn-secondary btn-sm act-case" data-case="' +
              escapeHtml(f.caseId) +
              '">View case</button>'
            : '') +
          (isIp
            ? '<button type="button" class="btn btn-secondary btn-sm act-intel" data-ip="' +
              escapeHtml(f.entity || '') +
              '">WHOIS</button>' +
              '<button type="button" class="btn btn-danger btn-sm act-block" data-ip="' +
              escapeHtml(f.entity || '') +
              '">Block IP</button>'
            : '') +
          '</div></div>'
        );
      })
      .join('');

    list.querySelectorAll('.threat-main').forEach((btn) => {
      btn.onclick = () => pivotToInvestigate(btn.dataset.entityType, btn.dataset.entity);
    });
    list.querySelectorAll('.act-inv').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        pivotToInvestigate(btn.dataset.entityType, btn.dataset.entity);
      };
    });
    list.querySelectorAll('.act-case').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        state.selectedCaseId = btn.dataset.case;
        setTab('review');
        loadCases().then(() => openCaseDetail(btn.dataset.case));
      };
    });
    list.querySelectorAll('.act-disposition').forEach((btn) => {
      btn.onclick = (event) => { event.stopPropagation(); openFindingDisposition(btn.dataset.findingId); };
    });
    list.querySelectorAll('.act-intel').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openIntel(btn.dataset.ip);
      };
    });
    list.querySelectorAll('.act-block').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        quickBlockIp(btn.dataset.ip, 'Blocked from threats panel');
      };
    });
  }

  function openFindingDisposition(findingId) {
    const finding = (state.threats?.findings || []).find((item) => item.id === findingId);
    if (!finding) return;
    const context = finding.context || {};
    $('findingDispositionId').value = findingId;
    $('findingDispositionReason').value = '';
    $('findingDispositionDays').value = '30';
    $('findingDispositionMax').value = Math.max(Number(finding.count) || 1, Math.ceil((Number(finding.count) || 1) * 2));
    $('findingDispositionStatuses').value = context.statusCode == null ? '' : String(context.statusCode);
    $('findingDispositionIps').value = context.ip || '';
    $('findingDispositionDialog').showModal();
  }

  async function loadFindingDispositions() {
    const data = await apiGet('/api/sentinel/threats/dispositions');
    const rows = data.dispositions || [];
    $('findingDispositionRows').innerHTML = rows.length ? rows.map((row) => '<tr><td>' + escapeHtml(row.disposition) + '</td><td><strong>' + escapeHtml(row.ruleId) + '</strong><div class="mono small">' + escapeHtml(row.entity) + '</div></td><td class="small">' + escapeHtml(JSON.stringify(row.scope || {})) + '</td><td class="small">' + escapeHtml(JSON.stringify(row.conditions || {})) + '</td><td>' + escapeHtml(row.reason) + '</td><td>' + escapeHtml(fmt(row.expiresAt)) + '</td><td><button type="button" class="btn btn-secondary btn-sm revoke-finding-disposition" data-id="' + escapeHtml(row.id) + '">Revoke</button></td></tr>').join('') : '<tr><td colspan="7" class="muted">No active governed dispositions</td></tr>';
    $('findingDispositionRows').querySelectorAll('.revoke-finding-disposition').forEach((button) => {
      button.onclick = async () => { try { await apiSend('DELETE', '/api/sentinel/threats/dispositions/' + encodeURIComponent(button.dataset.id), { reason:'Revoked from Sentinel UI' }); await Promise.all([loadFindingDispositions(), loadSummary()]); showAlert('success', 'Finding disposition revoked'); } catch (error) { showAlert('error', error.message); } };
    });
  }

  function pivotToInvestigate(entityType, entity) {
    state.invFilters = {};
    if (entityType === 'ip') state.invFilters.ip = entity;
    else if (entityType === 'identity') state.invFilters.username = entity;
    else if (entityType === 'path') {
      const parts = String(entity).split(' ');
      state.invFilters.path = parts.length > 1 ? parts.slice(1).join(' ') : entity;
    }
    $('invIp').value = state.invFilters.ip || '';
    $('invUser').value = state.invFilters.username || '';
    $('invPath').value = state.invFilters.path || '';
    $('invLoc').value = '';
    $('invQ').value = '';
    setTab('investigate');
    loadTimeline();
    renderChips();
  }

  function renderLoginKpis(lt) {
    $('loginKpis').innerHTML = [
      kpi('Total', lt.total, ''),
      kpi('Success', lt.successes, pct(lt.successRate)),
      kpi('Failures', lt.failures, pct(lt.failRate)),
      kpi('Resets', lt.password_resets, 'password_reset events'),
    ].join('');
  }

  function renderLoginBursts(anom) {
    const failIp = (anom && anom.failBurstIps) || [];
    const failUser = (anom && anom.failBurstIdentities) || [];
    $('loginFailIp').innerHTML = failIp.length
      ? '<ul>' +
        failIp
          .map(
            (b) =>
              '<li><a href="#" class="pivot-ip" data-ip="' +
              escapeHtml(b.ip) +
              '"><code>' +
              escapeHtml(b.ip) +
              '</code></a> — ' +
              b.fails +
              '</li>'
          )
          .join('') +
        '</ul>'
      : 'None detected';
    $('loginFailUser').innerHTML = failUser.length
      ? '<ul>' +
        failUser
          .map(
            (b) =>
              '<li><a href="#" class="pivot-user" data-user="' +
              escapeHtml(b.identity) +
              '"><code>' +
              escapeHtml(b.identity) +
              '</code></a> — ' +
              b.fails +
              '</li>'
          )
          .join('') +
        '</ul>'
      : 'None detected';

    document.querySelectorAll('.pivot-ip').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        pivotToInvestigate('ip', a.dataset.ip);
      };
    });
    document.querySelectorAll('.pivot-user').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        pivotToInvestigate('identity', a.dataset.user);
      };
    });
  }

  function renderLoginRows(logins) {
    const tb = $('loginRows');
    if (!logins.length) {
      tb.innerHTML = '<tr><td colspan="8" class="muted">No login events match filters</td></tr>';
      return;
    }
    tb.innerHTML = logins
      .map((e) => {
        const cls =
          e.outcome === 'failure' ? 'row-fail' : e.event_type === 'password_reset' ? 'row-reset' : '';
        return (
          '<tr class="' +
          cls +
          '"><td title="' +
          escapeHtml(fmt(e.created_at)) +
          '">' +
          escapeHtml(relTime(e.created_at) || fmt(e.created_at)) +
          '</td><td>' +
          escapeHtml(e.event_type) +
          '</td><td>' +
          outcomeBadge(e.outcome) +
          '</td><td class="mono">' +
          escapeHtml(e.username || e.user_id || '—') +
          '</td><td class="mono">' +
          escapeHtml(e.email || '—') +
          '</td><td class="mono">' +
          escapeHtml(e.location_id || '—') +
          '</td><td class="mono"><a href="#" class="pivot-ip" data-ip="' +
          escapeHtml(e.ip || '') +
          '">' +
          escapeHtml(e.ip || '') +
          '</a></td><td>' +
          escapeHtml(e.detail || '') +
          '</td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('.pivot-ip').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        if (a.dataset.ip) pivotToInvestigate('ip', a.dataset.ip);
      };
    });
  }

  function renderApiKpis(t, lat) {
    const rps = state.hours ? ((Number(t.requests) || 0) / (state.hours * 3600)).toFixed(3) : '—';
    $('apiKpis').innerHTML = [
      kpi('Requests', t.requests, '~' + rps + '/s avg'),
      kpi('Error rate', pct(t.errorRate), t.errors + ' errors'),
      kpi('401 rate', pct(t.unauthorizedRate), t.unauthorized + ' unauthorized'),
      kpi('Latency p95', lat.p95 != null ? lat.p95 + 'ms' : '—', 'avg ' + (t.avg_ms != null ? Math.round(t.avg_ms) + 'ms' : '—')),
    ].join('');
  }

  function renderStatusHist(rows) {
    if (!rows || !rows.length) {
      $('statusHist').textContent = 'No data';
      return;
    }
    const max = Math.max(1, ...rows.map((r) => Number(r.count)));
    $('statusHist').innerHTML = rows
      .map((r) => {
        const w = Math.max(4, Math.round((Number(r.count) / max) * 100));
        return (
          '<div style="display:flex;align-items:center;gap:0.5rem;margin:0.25rem 0">' +
          '<code style="width:3rem">' +
          escapeHtml(r.status_code) +
          '</code>' +
          '<div style="flex:1;background:rgba(36,48,73,0.8);border-radius:4px;height:10px">' +
          '<div style="width:' +
          w +
          '%;height:10px;border-radius:4px;background:rgba(59,130,246,0.7)"></div></div>' +
          '<span class="muted">' +
          r.count +
          '</span></div>'
        );
      })
      .join('');
  }

  function renderTopPaths(rows) {
    const tb = $('topPaths');
    if (!rows || !rows.length) {
      tb.innerHTML = '<tr><td colspan="4" class="muted">—</td></tr>';
      return;
    }
    tb.innerHTML = rows
      .slice(0, 12)
      .map(
        (r) =>
          '<tr><td class="mono">' +
          escapeHtml(r.method) +
          ' ' +
          escapeHtml(r.path) +
          '</td><td>' +
          r.requests +
          '</td><td>' +
          r.errors +
          '</td><td>' +
          (r.avg_ms != null ? Math.round(r.avg_ms) : '—') +
          '</td></tr>'
      )
      .join('');
  }

  function renderByKey(rows) {
    const tb = $('byKey');
    if (!rows || !rows.length) {
      tb.innerHTML = '<tr><td colspan="6" class="muted">No key traffic</td></tr>';
      return;
    }
    tb.innerHTML = rows
      .map((k) => {
        const req = Number(k.requests) || 0;
        const err = Number(k.errors) || 0;
        const rate = req ? err / req : 0;
        return (
          '<tr><td class="mono">' +
          escapeHtml(k.key_prefix || '—') +
          '…</td><td>' +
          req +
          '</td><td>' +
          err +
          '</td><td>' +
          (k.unauthorized || 0) +
          '</td><td>' +
          pct(rate) +
          '</td><td>' +
          escapeHtml(relTime(k.last_seen) || fmt(k.last_seen)) +
          '</td></tr>'
        );
      })
      .join('');
  }

  function renderApiRows(events) {
    if (events.length && !events.some((event) => event.surface || event.action || event.actor_id)) {
      return renderApiRowsLegacy(events);
    }
    const tb = $('apiRows');
    if (!events.length) {
      tb.innerHTML = '<tr><td colspan="10" class="muted">No events match filters</td></tr>';
      return;
    }
    tb.innerHTML = events.map((e) => {
      const cls = e.status_code >= 400 ? 'row-fail' : '';
      const actor = e.actor_username || e.actor_id || e.key_prefix || '-';
      const entity = e.entity_type && e.entity_id ? ` | ${e.entity_type} ${e.entity_id}` : '';
      return '<tr class="' + cls + '">' +
        '<td title="' + escapeHtml(fmt(e.created_at)) + '">' + escapeHtml(relTime(e.created_at)) + '</td>' +
        '<td>' + escapeHtml(e.surface || 'api') + '</td>' +
        '<td class="mono" title="' + escapeHtml(e.actor_type || '') + '">' + escapeHtml(actor) + '</td>' +
        '<td class="mono">' + escapeHtml((e.action || '-') + entity) + '</td>' +
        '<td><strong>' + escapeHtml(e.method) + '</strong> <span class="mono">' + escapeHtml(e.path) + '</span></td>' +
        '<td>' + e.status_code + '</td>' +
        '<td>' + escapeHtml(e.outcome || e.error_class || '-') + '</td>' +
        '<td class="mono"><a href="#" class="pivot-ip" data-ip="' + escapeHtml(e.ip || '') + '">' + escapeHtml(e.ip || '') + '</a></td>' +
        '<td>' + (e.duration_ms != null ? e.duration_ms : '-') + '</td>' +
        '<td>' + evidenceButton(e) + '</td></tr>';
    }).join('');
    bindApiIpPivots(tb);
    bindEvidenceButtons(tb, events);
  }

  function evidenceButton(event) {
    if (!state.canRevealForensics) return '<span class="muted small">restricted</span>';
    if (!Number(event.has_evidence)) return '<span class="muted small">expired</span>';
    return '<button type="button" class="btn btn-secondary btn-sm inspect-evidence" data-event-id="' +
      escapeHtml(event.id) + '">Inspect</button>';
  }

  function bindEvidenceButtons(table, events) {
    table.querySelectorAll('.inspect-evidence').forEach((button) => {
      button.onclick = () => openEvidenceDrawer(events.find((item) => String(item.id) === button.dataset.eventId));
    });
  }

  function bindApiIpPivots(table) {
    table.querySelectorAll('.pivot-ip').forEach((link) => {
      link.onclick = (event) => {
        event.preventDefault();
        if (link.dataset.ip) pivotToInvestigate('ip', link.dataset.ip);
      };
    });
  }

  function renderApiRowsLegacy(events) {
    const tb = $('apiRows');
    if (!events.length) {
      tb.innerHTML = '<tr><td colspan="8" class="muted">No events match filters</td></tr>';
      return;
    }
    tb.innerHTML = events
      .map((e) => {
        const cls = e.status_code >= 400 ? 'row-fail' : '';
        return (
          '<tr class="' +
          cls +
          '"><td title="' +
          escapeHtml(fmt(e.created_at)) +
          '">' +
          escapeHtml(relTime(e.created_at)) +
          '</td><td class="mono">' +
          escapeHtml(e.key_prefix || '—') +
          '</td><td>' +
          escapeHtml(e.method) +
          '</td><td class="mono">' +
          escapeHtml(e.path) +
          '</td><td>' +
          e.status_code +
          '</td><td>' +
          (e.duration_ms != null ? e.duration_ms : '—') +
          '</td><td class="mono"><a href="#" class="pivot-ip" data-ip="' +
          escapeHtml(e.ip || '') +
          '">' +
          escapeHtml(e.ip || '') +
          '</a></td><td>' +
          escapeHtml(e.error_class || '') +
          '</td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('.pivot-ip').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        if (a.dataset.ip) pivotToInvestigate('ip', a.dataset.ip);
      };
    });
  }

  function renderTimeline(items) {
    const el = $('timeline');
    if (!items || !items.length) {
      el.innerHTML = '<p class="muted">No correlated events for these filters.</p>';
      return;
    }
    el.innerHTML = items
      .map((it) => {
        return (
          '<div class="timeline-item sev-' +
          escapeHtml(it.severity || 'info') +
          '">' +
          '<div class="tl-title">' +
          escapeHtml(it.source) +
          ' · ' +
          escapeHtml(it.title) +
          '</div>' +
          '<div class="tl-sum">' +
          escapeHtml(it.summary || '') +
          '</div>' +
          '<div class="tl-meta">' +
          escapeHtml(fmt(it.created_at)) +
          ' · ' +
          escapeHtml(it.ip || '') +
          ' · ' +
          escapeHtml(it.location_id || '') +
          '</div></div>'
        );
      })
      .join('');
  }

  function renderInvestigationProfile(inv) {
    const box = $('invProfile');
    if (!inv || !inv.entity) { box.hidden = true; return; }
    box.hidden = false;
    const p = inv.profile || {};
    $('invEntityTitle').textContent = inv.entity.type + ': ' + inv.entity.value;
    $('invEntityWindow').textContent = 'Last ' + inv.windowHours + ' hours · ' + fmt(p.firstSeen) + ' to ' + fmt(p.lastSeen);
    $('invProfileKpis').innerHTML = [
      kpi('Requests',p.requests,(p.errors || 0) + ' errors'),
      kpi('Unauthorized',p.unauthorized,'401 / 403'),
      kpi('Login failures',p.loginFailures,(p.loginSuccesses || 0) + ' successes'),
      kpi('Unique paths',p.uniquePaths,'behavior breadth'),
      kpi('Related IPs',p.uniqueIps,'observed sources'),
      kpi('Identities',p.identities,'login targets'),
      kpi('Avg latency',(p.avgDurationMs || 0) + 'ms','request response'),
      kpi('Last seen',relTime(p.lastSeen) || fmt(p.lastSeen),'entity activity'),
    ].join('');
    const paths = inv.paths || [];
    $('invPathRows').innerHTML = paths.length ? paths.map((row) => '<tr><td>' + escapeHtml(row.method) + '</td><td class="mono">' + escapeHtml(row.path) + '</td><td>' + row.requests + '</td><td>' + row.errors + '</td><td>' + escapeHtml(relTime(row.lastSeen) || fmt(row.lastSeen)) + '</td></tr>').join('') : '<tr><td colspan="5" class="muted">No API paths observed</td></tr>';
    $('invStatuses').innerHTML = (inv.statuses || []).length ? inv.statuses.map((row) => '<span><strong>' + escapeHtml(row.statusCode) + '</strong> ' + row.total + '</span>').join('') : '<span class="muted">No API statuses</span>';
    const cases = inv.relatedCases || [];
    $('invRelatedCases').innerHTML = cases.length ? cases.map((c) => '<button type="button" class="inv-case-link" data-case="' + escapeHtml(c.id) + '">' + sevBadge(c.severity) + ' ' + escapeHtml(c.title) + ' ' + statusBadge(c.status) + '</button>').join('') : '<span class="muted">No related cases</span>';
    $('invRelatedCases').querySelectorAll('[data-case]').forEach((button) => button.onclick = () => {
      state.selectedCaseId = button.dataset.case; setTab('review'); loadCases().then(() => openCaseDetail(button.dataset.case));
    });
  }

  function renderChips() {
    const chips = [];
    if (state.loginFilters.ip) chips.push({ k: 'login.ip', v: state.loginFilters.ip });
    if (state.apiFilters.ip) chips.push({ k: 'api.ip', v: state.apiFilters.ip });
    if (state.invFilters.ip) chips.push({ k: 'inv.ip', v: state.invFilters.ip });
    if (state.invFilters.username) chips.push({ k: 'inv.user', v: state.invFilters.username });
    if (state.invFilters.path) chips.push({ k: 'inv.path', v: state.invFilters.path });
    const el = $('globalChips');
    if (!chips.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = chips
      .map(
        (c) =>
          '<span class="chip">' +
          escapeHtml(c.k) +
          '=' +
          escapeHtml(c.v) +
          ' <button type="button" data-chip="' +
          escapeHtml(c.k) +
          '" aria-label="clear">×</button></span>'
      )
      .join('');
    el.querySelectorAll('button[data-chip]').forEach((btn) => {
      btn.onclick = () => {
        const k = btn.dataset.chip;
        if (k === 'login.ip') delete state.loginFilters.ip;
        if (k === 'api.ip') delete state.apiFilters.ip;
        if (k === 'inv.ip') {
          delete state.invFilters.ip;
          $('invIp').value = '';
        }
        if (k === 'inv.user') {
          delete state.invFilters.username;
          $('invUser').value = '';
        }
        if (k === 'inv.path') {
          delete state.invFilters.path;
          $('invPath').value = '';
        }
        loadAll();
      };
    });
  }

  // ——— Data load ———
  async function loadSummary() {
    const data = await apiGet('/api/sentinel/summary?' + qs({ hours: state.hours }));
    state.summary = data;
    state.threats = data.threats;
    if ($('suppressedFindingCount')) {
      const suppressed = Number(data.threats?.suppressed?.total) || 0;
      $('suppressedFindingCount').textContent = suppressed + ' conditionally suppressed';
    }
    renderPosture(data);
    renderThreats((data.threats && data.threats.findings) || []);
    renderLoginKpis((data.loginSummary && data.loginSummary.totals) || {});
    renderLoginBursts((data.loginSummary && data.loginSummary.anomalies) || {});
    renderApiKpis((data.summary && data.summary.totals) || {}, (data.summary && data.summary.latency) || {});
    renderStatusHist((data.summary && data.summary.statusHistogram) || []);
    renderTopPaths((data.summary && data.summary.topPaths) || []);
    renderByKey((data.summary && data.summary.byKey) || []);
  }

  async function loadLogins() {
    const f = state.loginFilters;
    const q = qs({
      hours: state.hours,
      limit: PAGE,
      offset: state.loginOffset,
      outcome: f.outcome,
      eventType: f.eventType,
      ip: f.ip,
      locationId: f.locationId,
      q: f.q,
    });
    const data = await apiGet('/api/sentinel/logins?' + q);
    state.loginTotal = data.total || 0;
    renderLoginRows(data.logins || []);
    $('loginPagerInfo').textContent =
      state.loginTotal + ' total · offset ' + state.loginOffset;
  }

  async function loadApiEvents() {
    const f = state.apiFilters;
    const q = qs({
      hours: state.hours,
      limit: PAGE,
      offset: state.apiOffset,
      status: f.status,
      method: f.method,
      path: f.path,
      ip: f.ip,
      errorClass: f.errorClass,
      surface: f.surface,
      action: f.action,
      outcome: f.outcome,
      q: f.q,
    });
    const data = await apiGet('/api/sentinel/events?' + q);
    state.apiTotal = data.total || 0;
    renderApiRows(data.events || []);
    $('apiPagerInfo').textContent = state.apiTotal + ' total · offset ' + state.apiOffset;
  }

  async function loadCapabilities() {
    const data = await apiGet('/api/sentinel/capabilities');
    state.canRevealForensics = Boolean(data.canRevealForensics);
  }

  function openEvidenceDrawer(event) {
    if (!event) return;
    state.evidenceEvent = event;
    state.evidenceData = null;
    state.evidenceTab = 'overview';
    $('evidenceRequestId').textContent = event.request_id || '-';
    $('evidenceReason').value = '';
    $('evidenceGate').hidden = false;
    $('evidenceContent').hidden = true;
    $('evidenceDrawer').hidden = false;
    $('btnEvidenceReveal').disabled = false;
    $('btnEvidenceReveal').textContent = 'Verify and reveal';
    setTimeout(() => $('evidenceReason').focus(), 0);
  }

  function closeEvidenceDrawer() {
    $('evidenceDrawer').hidden = true;
    $('evidenceReason').value = '';
    $('evidenceJson').textContent = '';
    state.evidenceData = null;
    state.evidenceEvent = null;
  }

  async function revealEvidence() {
    const event = state.evidenceEvent;
    if (!event) return;
    const reason = $('evidenceReason').value.trim();
    if (reason.length < 8) {
      showAlert('warning', 'Provide an investigation reason of at least 8 characters');
      return;
    }
    const button = $('btnEvidenceReveal');
    button.disabled = true;
    button.textContent = 'Verifying...';
    try {
      const data = await apiSend('POST', '/api/sentinel/events/' + encodeURIComponent(event.id) + '/evidence', { reason });
      state.evidenceData = data;
      $('evidenceGate').hidden = true;
      $('evidenceContent').hidden = false;
      renderEvidenceSummary(data);
      selectEvidenceTab('overview');
    } catch (error) {
      showAlert('error', error.message);
      button.disabled = false;
      button.textContent = 'Verify and reveal';
    }
  }

  function renderEvidenceSummary(data) {
    const event = data.event || {};
    const controls = data.evidence?.controls || {};
    $('evidenceSummary').innerHTML = [
      ['Request', (event.method || '-') + ' ' + (event.path || '-')],
      ['Response', String(event.statusCode == null ? '-' : event.statusCode)],
      ['Redactions', String(controls.redactionCount == null ? '-' : controls.redactionCount)],
      ['Integrity', data.integrity?.verified ? 'Verified' : 'Not verified'],
    ].map((item) => '<div><span class="muted small">' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong></div>').join('');
  }

  function selectEvidenceTab(tab) {
    state.evidenceTab = tab;
    document.querySelectorAll('[data-evidence-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.evidenceTab === tab);
    });
    const data = state.evidenceData || {};
    const evidence = data.evidence || {};
    const views = {
      overview: {
        event: data.event,
        request: evidence.request && {
          method: evidence.request.method, target: evidence.request.target,
          contentType: evidence.request.contentType, bytes: evidence.request.bytes,
          truncated: evidence.request.truncated,
        },
        response: evidence.response && {
          status: evidence.response.status, contentType: evidence.response.contentType,
          bytes: evidence.response.bytes, truncated: evidence.response.truncated,
        },
        controls: evidence.controls,
      },
      requestHeaders: evidence.request?.headers,
      requestPayload: evidence.request?.payload,
      responseHeaders: evidence.response?.headers,
      responsePayload: evidence.response?.payload,
      integrity: data.integrity,
    };
    $('evidenceJson').textContent = JSON.stringify(views[tab] == null ? null : views[tab], null, 2);
  }

  async function loadTimeline(loadMore = false) {
    const f = state.invFilters;
    const ip = f.ip || $('invIp').value.trim();
    const entityType = ip ? 'ip' : (f.username || $('invUser').value.trim()) ? 'identity' : (f.path || $('invPath').value.trim()) ? 'path' : (f.locationId || $('invLoc').value.trim()) ? 'location' : null;
    const entity = ip || f.username || $('invUser').value.trim() || f.path || $('invPath').value.trim() || f.locationId || $('invLoc').value.trim();
    if (!loadMore) { state.invCursor = null; state.invItems = []; }
    const params = {
      hours: state.hours,
      limit: 100,
      ip,
      locationId: f.locationId || $('invLoc').value.trim(),
      username: f.username || $('invUser').value.trim(),
      path: f.path || $('invPath').value.trim(),
      q: f.q || $('invQ').value.trim(),
      cursor:loadMore ? state.invCursor : null,
    };
    let timeline;
    if (entityType && !(f.q || $('invQ').value.trim())) {
      const data = await apiGet('/api/sentinel/investigations/entity?' + qs({ entityType,entity,hours:state.hours,limit:100,cursor:params.cursor }));
      const inv = data.investigation || {};
      renderInvestigationProfile(inv);
      timeline = inv.timeline || {};
    } else {
      $('invProfile').hidden = true;
      const data = await apiGet('/api/sentinel/timeline?' + qs(params));
      timeline = data.timeline || {};
    }
    state.invItems = loadMore ? state.invItems.concat(timeline.items || []) : (timeline.items || []);
    state.invCursor = timeline.nextCursor || null;
    renderTimeline(state.invItems);
    $('btnInvMore').hidden = !state.invCursor;
    const act = $('invIpActions');
    if (act) {
      if (ip) {
        act.hidden = false;
        act.dataset.ip = ip;
      } else {
        act.hidden = true;
      }
    }
  }

  function renderCases(cases) {
    const tb = $('caseRows');
    if (!tb) return;
    $('caseCount').textContent = (cases || []).length + ' case(s)';
    if (!cases || !cases.length) {
      tb.innerHTML = '<tr><td colspan="10" class="muted">No cases match filters</td></tr>';
      return;
    }
    tb.innerHTML = cases
      .map((c) => {
        const sel = c.id === state.selectedCaseId ? ' row-selected' : '';
        return (
          '<tr class="clickable' +
          sel +
          '" data-id="' +
          escapeHtml(c.id) +
          '"><td>' +
          sevBadge(c.severity) +
          '</td><td>' +
          statusBadge(c.status) +
          '</td><td>' +
          escapeHtml(c.title) +
          '</td><td class="mono">' +
          escapeHtml(c.entityType) +
          ': ' +
          escapeHtml(c.entity) +
          '</td><td>' + escapeHtml(c.ownerAdminId || 'unassigned') +
          '</td><td>' + escapeHtml(c.disposition || '—') +
          '</td><td><span class="case-sla ' + (c.dueAt && new Date(c.dueAt) < new Date() && !['resolved','closed'].includes(c.status) ? 'breached' : '') + '">' + escapeHtml(c.dueAt ? (relTime(c.dueAt) || fmt(c.dueAt)) : '—') + '</span>' +
          '</td><td>' + socDuration((Date.now() - new Date(c.createdAt).getTime()) / 1000) +
          '</td><td>' +
          escapeHtml(String(c.count || 0)) +
          '</td><td>' +
          escapeHtml(relTime(c.lastSeen) || fmt(c.lastSeen)) +
          '</td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('tr.clickable').forEach((tr) => {
      tr.onclick = () => openCaseDetail(tr.dataset.id);
    });
  }

  async function loadCases() {
    const f = state.caseFilters || {};
    const q = qs({
      status: f.status,
      severity: f.severity,
      owner: f.owner === 'me' ? state.admin?.id : f.owner,
      disposition: f.disposition,
      sla: f.sla,
      q: f.q,
      limit: 200,
    });
    const data = await apiGet('/api/sentinel/cases?' + q);
    state.cases = data.cases || [];
    renderCases(state.cases);
    if (state.selectedCaseId) {
      const still = state.cases.find((c) => c.id === state.selectedCaseId);
      if (still) await openCaseDetail(state.selectedCaseId);
    }
  }

  async function loadCaseOperations() {
    const data = await apiGet('/api/sentinel/cases/operations?' + qs({ hours:state.hours }));
    const report = data.report || {};
    state.caseReport = report;
    const t = report.totals || {};
    $('caseOpsKpis').innerHTML = [
      kpi('Unassigned',t.unassigned,'needs an owner'),
      kpi('SLA breached',t.slaBreached,(t.dueSoon || 0) + ' due soon'),
      kpi('Awaiting validation',t.awaitingValidation,'resolved, not closed'),
      kpi('Resolved',t.resolvedInWindow,state.hours + 'h window'),
      kpi('MTTA',socDuration(t.avgTriageSeconds),'mean time to triage'),
      kpi('MTTR',socDuration(t.avgResolutionSeconds),'mean time to resolve'),
      kpi('Closure quality',Math.round((Number(t.closureQualityRate) || 0) * 100) + '%','documented + validated'),
      kpi('Oldest open',socDuration(t.oldestOpenSeconds),'backlog age'),
    ].join('');
    $('caseOpsWindow').textContent = 'Last ' + (report.windowHours || state.hours) + ' hours';
    const analysts = report.analysts || [];
    $('caseAnalystRows').innerHTML = analysts.length ? analysts.map((row) => '<tr><td>' + escapeHtml(row.analyst || 'unassigned') + '</td><td>' + (row.casesHandled || 0) + '</td><td>' + (row.resolved || 0) + '</td><td>' + (row.closed || 0) + '</td><td>' + socDuration(row.avgResolutionSeconds) + '</td></tr>').join('') : '<tr><td colspan="5" class="muted">No analyst activity in this window</td></tr>';
  }

  async function openCaseDetail(id) {
    state.selectedCaseId = id;
    renderCases(state.cases);
    const el = $('caseDetail');
    if (!el) return;
    el.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const data = await apiGet('/api/sentinel/cases/' + encodeURIComponent(id));
      const c = data.case;
      const actions = data.actions || [];
      const notes = data.notes || [];
      const history = data.statusHistory || [];
      const intel = data.intel;
      const response = data.response || { recommendations:[], runs:[] };
      const canBlock = c.entityType === 'ip';
      el.innerHTML =
        sevBadge(c.severity) +
        ' ' +
        statusBadge(c.status) +
        '<h3>' +
        escapeHtml(c.title) +
        '</h3>' +
        '<p>' +
        escapeHtml(c.summary) +
        '</p>' +
        '<div class="threat-meta mono">' +
        escapeHtml(c.entityType) +
        ': ' +
        escapeHtml(c.entity) +
        ' · rule ' +
        escapeHtml(c.ruleId) +
        ' · count ' +
        escapeHtml(String(c.count)) +
        '</div>' +
        (c.reviewNote
          ? '<p class="muted small">Note: ' + escapeHtml(c.reviewNote) + '</p>'
          : '') +
        '<div class="case-lifecycle-grid"><div><span>Owner</span><strong>' + escapeHtml(c.ownerAdminId || 'Unassigned') + '</strong></div>' +
        '<div><span>Priority</span><strong>' + escapeHtml(c.priority || 'normal') + '</strong></div>' +
        '<div><span>Confidence</span><strong>' + escapeHtml(c.confidence || '—') + '</strong></div>' +
        '<div><span>Disposition</span><strong>' + escapeHtml(c.disposition || 'Not assessed') + '</strong></div></div>' +
        (intel && intel.intel
          ? '<p class="muted small">Intel: ' +
            escapeHtml(
              [intel.intel.org, intel.intel.network, intel.intel.country]
                .filter(Boolean)
                .join(' · ') || '—'
            ) +
            '</p>'
          : '') +
        '<div class="action-row">' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="assign">Assign to me</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-act="triage">Triage</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-act="investigating">Investigate case</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-act="monitoring">Monitor</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-act="resolved">Resolve</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-act="closed">Validate & close</button>' +
        (['resolved','closed'].includes(c.status) ? '<button type="button" class="btn btn-secondary btn-sm" data-act="reopened">Reopen</button>' : '') +
        (canBlock
          ? '<button type="button" class="btn btn-danger btn-sm" data-act="block">Block IP</button>' +
            '<button type="button" class="btn btn-secondary btn-sm" data-act="intel">WHOIS</button>'
          : '') +
        '<button type="button" class="btn btn-secondary btn-sm" data-act="inv">Investigate</button>' +
        '</div>' +
        '<section class="case-response-workspace"><div class="section-title"><div><h4>Playbook response</h4><p class="muted small">'+(response.activeRuns||0)+' active · '+(response.completedRuns||0)+' completed</p></div><button type="button" class="btn btn-secondary btn-sm" data-case-playbooks>Open Playbooks</button></div><div class="case-playbook-recommendations">'+((response.recommendations||[]).length?(response.recommendations||[]).map((rec)=>'<article><div><strong>'+escapeHtml(rec.playbook.name)+'</strong><span>'+escapeHtml(rec.confidence)+' match · '+rec.score+'/100</span><p>'+escapeHtml((rec.reasons||[]).join(' · '))+'</p></div><button type="button" class="btn btn-primary btn-sm case-start-playbook" data-playbook-id="'+escapeHtml(rec.playbook.id)+'">Start</button></article>').join(''):'<p class="muted">No active playbook matches this case yet.</p>')+'</div>'+((response.runs||[]).length?'<h5>Case response history</h5><div class="case-playbook-runs">'+(response.runs||[]).map((run)=>'<button type="button" data-case-run="'+escapeHtml(run.id)+'"><strong>'+escapeHtml(run.playbookName)+'</strong><span>'+escapeHtml(run.status)+' · v'+run.version+' · '+escapeHtml(relTime(run.completedAt||run.startedAt)||fmt(run.startedAt))+'</span></button>').join('')+'</div>':'')+'</section>' +
        '<div class="case-response-form"><label>Disposition<select id="caseDisposition"><option value="">Not assessed</option><option value="confirmed_malicious">Confirmed malicious</option><option value="suspicious">Suspicious</option><option value="policy_violation">Policy violation</option><option value="expected_behavior">Expected behavior</option><option value="benign_anomaly">Benign anomaly</option><option value="false_positive">False positive</option><option value="duplicate">Duplicate</option><option value="insufficient_evidence">Insufficient evidence</option></select></label>' +
        '<label>Confidence<select id="caseConfidence"><option value="">Not set</option><option>low</option><option>medium</option><option>high</option><option>confirmed</option></select></label>' +
        '<label class="full">Analyst note<textarea id="caseNote" rows="2" placeholder="Assessment, evidence, or action taken"></textarea></label>' +
        '<label class="full">Resolution summary<textarea id="caseResolution" rows="2" placeholder="Required to resolve"></textarea></label>' +
        '<label class="full">Validation summary<textarea id="caseValidation" rows="2" placeholder="Required to close"></textarea></label></div>' +
        '<h4 style="margin:0.5rem 0 0.25rem;font-size:0.85rem">Analyst journal</h4><ul class="case-actions-log">' +
        (notes.length ? notes.map((n) => '<li><code>' + escapeHtml(n.noteType) + '</code> ' + escapeHtml(n.note) + ' · ' + escapeHtml(relTime(n.createdAt) || fmt(n.createdAt)) + '</li>').join('') : '<li class="muted">No analyst notes yet</li>') + '</ul>' +
        '<h4 style="margin:0.5rem 0 0.25rem;font-size:0.85rem">Audit trail</h4>' +
        '<ul class="case-actions-log">' +
        (actions.length
          ? actions
              .map(
                (a) =>
                  '<li><code>' +
                  escapeHtml(a.action) +
                  '</code> ' +
                  escapeHtml(a.detail || '') +
                  ' · ' +
                  escapeHtml(relTime(a.createdAt) || fmt(a.createdAt)) +
                  '</li>'
              )
              .join('')
          : '<li class="muted">No actions yet</li>') +
        '</ul>';

      if ($('caseDisposition')) $('caseDisposition').value = c.disposition || '';
      if ($('caseConfidence')) $('caseConfidence').value = c.confidence || '';
      if ($('caseResolution')) $('caseResolution').value = c.resolutionSummary || '';
      if ($('caseValidation')) $('caseValidation').value = c.validationSummary || '';
      el.querySelectorAll('.case-start-playbook').forEach((button)=>button.onclick=async()=>{const note=window.prompt('Optional response objective or handoff note:','')||'';try{const result=await apiSend('POST','/api/sentinel/cases/'+encodeURIComponent(id)+'/playbooks/'+encodeURIComponent(button.dataset.playbookId)+'/runs',{note});showAlert('success','Case-linked playbook started');await openCaseDetail(id);setTab('playbooks');await loadPlaybooks();await openPlaybookRun(result.run.id);}catch(error){showAlert('error',error.message||'Could not start case playbook');}});
      el.querySelectorAll('[data-case-run]').forEach((button)=>button.onclick=async()=>{setTab('playbooks');await loadPlaybooks();await openPlaybookRun(button.dataset.caseRun);});
      const openBooks=el.querySelector('[data-case-playbooks]');if(openBooks)openBooks.onclick=async()=>{setTab('playbooks');await loadPlaybooks();};

      el.querySelectorAll('[data-act]').forEach((btn) => {
        btn.onclick = async () => {
          const act = btn.dataset.act;
          const note = ($('caseNote') && $('caseNote').value.trim()) || '';
          try {
            if (act === 'inv') {
              pivotToInvestigate(c.entityType, c.entity);
              return;
            }
            if (act === 'intel') {
              openIntel(c.entity);
              return;
            }
            if (act === 'assign') {
              await apiSend('POST','/api/sentinel/cases/' + encodeURIComponent(id) + '/assign',{ ownerAdminId:'me' });
              showAlert('success','Case assigned to you');
            } else if (act === 'block') {
              await apiSend('POST', '/api/sentinel/cases/' + encodeURIComponent(id) + '/block', {
                note: note || undefined,
                reason: note || undefined,
              });
              showAlert('success', 'IP blocked and case closed as blocked');
            } else {
              await apiSend('POST', '/api/sentinel/cases/' + encodeURIComponent(id) + '/transition', {
                status:act, note:note || undefined,
                disposition:$('caseDisposition').value || undefined,
                confidence:$('caseConfidence').value || undefined,
                resolutionSummary:$('caseResolution').value.trim() || undefined,
                validationSummary:$('caseValidation').value.trim() || undefined,
              });
              showAlert('success', 'Case moved to ' + act);
            }
            await Promise.all([loadCases(),loadCaseOperations()]);
            await openCaseDetail(id);
            loadSummary();
          } catch (e) {
            if (e.message !== 'auth') showAlert('error', e.message || 'Action failed');
          }
        };
      });
    } catch (e) {
      el.innerHTML = '<p class="muted">Failed to load case</p>';
    }
  }

  function renderNewIps(ips) {
    const tb = $('newIpRows');
    if (!tb) return;
    $('newIpCount').textContent = (ips || []).length + ' IP(s)';
    if (!ips || !ips.length) {
      tb.innerHTML =
        '<tr><td colspan="9" class="muted">No first-fail IPs in this window</td></tr>';
      return;
    }
    tb.innerHTML = ips
      .map((r) => {
        return (
          '<tr><td class="mono">' +
          escapeHtml(r.ip) +
          '</td><td>' +
          escapeHtml(relTime(r.firstSeen) || fmt(r.firstSeen)) +
          '</td><td class="mono">' +
          escapeHtml((r.firstMethod || '') + ' ' + (r.firstPath || '')) +
          '</td><td>' +
          escapeHtml(String(r.authFailCount)) +
          '</td><td>' +
          escapeHtml(String(r.successCount)) +
          '</td><td>' +
          escapeHtml(String(r.totalRequests)) +
          '</td><td>' +
          (r.isBlocked ? '<span class="badge badge-revoked">yes</span>' : '—') +
          '</td><td>' +
          escapeHtml(String(r.openCases || 0)) +
          '</td><td class="inline-actions">' +
          '<button type="button" class="btn btn-secondary btn-sm nip-inv" data-ip="' +
          escapeHtml(r.ip) +
          '">Inv</button>' +
          '<button type="button" class="btn btn-secondary btn-sm nip-intel" data-ip="' +
          escapeHtml(r.ip) +
          '">WHOIS</button>' +
          (r.isBlocked
            ? ''
            : '<button type="button" class="btn btn-danger btn-sm nip-block" data-ip="' +
              escapeHtml(r.ip) +
              '">Block</button>') +
          '</td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('.nip-inv').forEach((b) => {
      b.onclick = () => pivotToInvestigate('ip', b.dataset.ip);
    });
    tb.querySelectorAll('.nip-intel').forEach((b) => {
      b.onclick = () => openIntel(b.dataset.ip);
    });
    tb.querySelectorAll('.nip-block').forEach((b) => {
      b.onclick = () =>
        quickBlockIp(b.dataset.ip, 'Blocked from New IPs radar (first-fail)');
    });
  }

  async function loadNewIps() {
    const data = await apiGet(
      '/api/sentinel/new-ips?' + qs({ hours: state.hours, limit: 200 })
    );
    renderNewIps(data.ips || []);
  }

  function renderBlocks(blocks) {
    const tb = $('blockRows');
    if (!tb) return;
    $('blockCount').textContent = (blocks || []).length + ' row(s)';
    if (!blocks || !blocks.length) {
      tb.innerHTML = '<tr><td colspan="7" class="muted">No blocks</td></tr>';
      return;
    }
    tb.innerHTML = blocks
      .map((b) => {
        return (
          '<tr><td class="mono">' +
          escapeHtml(b.ip) +
          '</td><td>' +
          escapeHtml(b.reason) +
          '</td><td>' +
          escapeHtml(b.source) +
          '</td><td>' +
          (b.isActive
            ? '<span class="badge badge-revoked">active</span>'
            : '<span class="badge">off</span>') +
          '</td><td>' +
          escapeHtml(b.expiresAt ? fmt(b.expiresAt) : '—') +
          '</td><td>' +
          escapeHtml(fmt(b.createdAt)) +
          '</td><td>' +
          (b.isActive
            ? '<button type="button" class="btn btn-secondary btn-sm blk-revoke" data-id="' +
              escapeHtml(b.id) +
              '">Revoke</button>'
            : '') +
          '</td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('.blk-revoke').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await apiSend('DELETE', '/api/sentinel/blocks/' + encodeURIComponent(btn.dataset.id), {
            reason: 'revoked from Blocks tab',
          });
          showAlert('success', 'Block revoked');
          loadBlocks();
        } catch (e) {
          if (e.message !== 'auth') showAlert('error', e.message);
        }
      };
    });
  }

  async function loadBlocks() {
    const showAll = $('blockShowAll') && $('blockShowAll').checked;
    const data = await apiGet(
      '/api/sentinel/blocks?' + qs({ all: showAll ? '1' : undefined, limit: 300 })
    );
    renderBlocks(data.blocks || []);
  }

  function renderRules(rules) {
    const tb = $('ruleRows');
    if (!tb) return;
    $('ruleCount').textContent = (rules || []).length + ' rule(s)';
    if (!rules || !rules.length) {
      tb.innerHTML = '<tr><td colspan="6" class="muted">No custom rules yet</td></tr>';
      return;
    }
    tb.innerHTML = rules
      .map((r) => {
        const c = r.condition || {};
        const cond =
          c.source +
          ' · by ' +
          c.groupBy +
          ' · ≥' +
          c.minCount +
          '/' +
          c.windowMinutes +
          'm' +
          (c.statusCode != null ? ' · status ' + c.statusCode : '') +
          (c.outcome ? ' · ' + c.outcome : '') +
          (c.pathContains ? ' · path~' + c.pathContains : '');
        const acts =
          (r.actions && r.actions.createCase !== false ? 'case' : '') +
          (r.actions && r.actions.autoBlock ? '+auto-block' : '');
        return (
          '<tr><td>' +
          escapeHtml(r.name) +
          '</td><td>' +
          sevBadge(r.severity) +
          '</td><td>' +
          (r.isEnabled
            ? '<span class="badge badge-ok">on</span>'
            : '<span class="badge">off</span>') +
          '</td><td class="mono small">' +
          escapeHtml(cond) +
          '</td><td>' +
          escapeHtml(acts) +
          '</td><td class="inline-actions">' +
          '<button type="button" class="btn btn-secondary btn-sm rule-toggle" data-id="' +
          escapeHtml(r.id) +
          '" data-on="' +
          (r.isEnabled ? '1' : '0') +
          '">' +
          (r.isEnabled ? 'Disable' : 'Enable') +
          '</button>' +
          '<button type="button" class="btn btn-secondary btn-sm rule-del" data-id="' +
          escapeHtml(r.id) +
          '">Delete</button>' +
          '</td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('.rule-toggle').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await apiSend('PUT', '/api/sentinel/rules/' + encodeURIComponent(btn.dataset.id), {
            isEnabled: btn.dataset.on !== '1',
          });
          loadRules();
        } catch (e) {
          if (e.message !== 'auth') showAlert('error', e.message);
        }
      };
    });
    tb.querySelectorAll('.rule-del').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Delete this custom rule?')) return;
        try {
          await apiSend('DELETE', '/api/sentinel/rules/' + encodeURIComponent(btn.dataset.id));
          showAlert('success', 'Rule deleted');
          loadRules();
        } catch (e) {
          if (e.message !== 'auth') showAlert('error', e.message);
        }
      };
    });
  }

  async function loadRules() {
    const data = await apiGet('/api/sentinel/rules');
    renderRules(data.rules || []);
  }

  async function quickBlockIp(ip, reason) {
    if (!ip) return;
    if (!confirm('Block API access for ' + ip + '?')) return;
    try {
      await apiSend('POST', '/api/sentinel/blocks', {
        ip,
        reason: reason || 'Manual block from Sentinel',
      });
      showAlert('success', 'Blocked ' + ip);
      if (state.tab === 'blocks') loadBlocks();
      if (state.tab === 'newips') loadNewIps();
    } catch (e) {
      if (e.message !== 'auth') showAlert('error', e.message || 'Block failed');
    }
  }

  async function openIntel(ip) {
    if (!ip) return;
    const drawer = $('intelDrawer');
    const body = $('intelBody');
    const title = $('intelTitle');
    if (!drawer || !body) return;
    drawer.hidden = false;
    title.textContent = 'IP · ' + ip;
    body.innerHTML = '<p class="muted">Looking up RDAP…</p>';
    try {
      const data = await apiGet(
        '/api/sentinel/intel/' + encodeURIComponent(ip) + '?' + qs({ force: undefined })
      );
      if (data.error && !data.intel) {
        body.innerHTML =
          '<p>Intel unavailable: ' +
          escapeHtml(data.error) +
          '</p>' +
          '<button type="button" class="btn btn-secondary btn-sm" id="btnIntelRetry">Retry</button>';
        const retry = $('btnIntelRetry');
        if (retry)
          retry.onclick = async () => {
            body.innerHTML = '<p class="muted">Retrying…</p>';
            try {
              const d2 = await apiGet(
                '/api/sentinel/intel/' + encodeURIComponent(ip) + '?force=1'
              );
              renderIntelBody(body, d2);
            } catch (e) {
              body.innerHTML = '<p>' + escapeHtml(e.message) + '</p>';
            }
          };
        return;
      }
      renderIntelBody(body, data);
    } catch (e) {
      body.innerHTML = '<p>' + escapeHtml(e.message || 'Lookup failed') + '</p>';
    }
  }

  function renderIntelBody(body, data) {
    const i = data.intel || {};
    body.innerHTML =
      (data.private ? '<p class="muted">Private/reserved address</p>' : '') +
      (data.cached ? '<p class="muted small">Cached result</p>' : '') +
      '<dl class="intel-kv">' +
      '<dt>Network</dt><dd>' +
      escapeHtml(i.network || '—') +
      '</dd>' +
      '<dt>Org</dt><dd>' +
      escapeHtml(i.org || '—') +
      '</dd>' +
      '<dt>Country</dt><dd>' +
      escapeHtml(i.country || '—') +
      '</dd>' +
      '<dt>CIDR</dt><dd>' +
      escapeHtml(i.cidr || '—') +
      '</dd>' +
      '<dt>Abuse</dt><dd>' +
      escapeHtml(i.abuse || '—') +
      '</dd>' +
      '<dt>Note</dt><dd>' +
      escapeHtml(i.note || data.error || '—') +
      '</dd>' +
      '</dl>' +
      '<div class="inline-actions">' +
      '<button type="button" class="btn btn-secondary btn-sm" id="btnIntelInv">Investigate</button>' +
      '<button type="button" class="btn btn-danger btn-sm" id="btnIntelBlock">Block IP</button>' +
      '<button type="button" class="btn btn-secondary btn-sm" id="btnIntelForce">Refresh RDAP</button>' +
      '</div>';
    const inv = $('btnIntelInv');
    const blk = $('btnIntelBlock');
    const force = $('btnIntelForce');
    if (inv) inv.onclick = () => pivotToInvestigate('ip', data.ip);
    if (blk) blk.onclick = () => quickBlockIp(data.ip, 'Blocked after WHOIS review');
    if (force)
      force.onclick = async () => {
        body.innerHTML = '<p class="muted">Refreshing…</p>';
        try {
          const d2 = await apiGet(
            '/api/sentinel/intel/' + encodeURIComponent(data.ip) + '?force=1'
          );
          renderIntelBody(body, d2);
        } catch (e) {
          body.innerHTML = '<p>' + escapeHtml(e.message) + '</p>';
        }
      };
  }

  async function loadAll() {
    clearAlert();
    try {
      await Promise.all([loadSummary(),loadCapabilities(),loadRoutineStatus(),loadControlHealth()]);
      await Promise.all([loadLogins(), loadApiEvents()]);
      if (state.tab === 'investigate') await loadTimeline();
      if (state.tab === 'review') await Promise.all([loadCases(),loadCaseOperations()]);
      if (state.tab === 'newips') await loadNewIps();
      if (state.tab === 'blocks') await loadBlocks();
      if (state.tab === 'rules') await loadRules();
      if (state.tab === 'validation') await loadValidation();
      if (state.tab === 'retention') await loadRetention();
      if (state.tab === 'playbooks') await loadPlaybooks();
      if (state.tab === 'resources') await loadResources();
      $('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
      renderChips();
    } catch (e) {
      if (e.message !== 'auth') showAlert('error', 'Failed to load sentinel data');
    }
  }

  function buildIrReport() {
    const d = state.summary;
    if (!d) return 'No data loaded.';
    const p = d.posture || {};
    const findings = (d.threats && d.threats.findings) || [];
    const lines = [
      '# Sentinel IR snapshot',
      '',
      '- Generated: ' + new Date().toISOString(),
      '- Window: ' + state.hours + 'h',
      '- Posture score: ' + p.score + ' (' + p.grade + ')',
      '- API requests: ' + ((d.summary && d.summary.totals && d.summary.totals.requests) || 0),
      '- Login failures: ' + ((d.loginSummary && d.loginSummary.totals && d.loginSummary.totals.failures) || 0),
      '',
      '## Top findings',
      '',
    ];
    findings.slice(0, 10).forEach((f, i) => {
      lines.push(
        i +
          1 +
          '. **[' +
          f.severity +
          ']** ' +
          f.title +
          ' — ' +
          f.summary +
          ' → ' +
          (f.recommendedAction || '')
      );
    });
    if (!findings.length) lines.push('_None_');
    lines.push('', '## Notes', '', '_Passwords and API key secrets are not included._', '');
    return lines.join('\n');
  }

  async function loadDailySocReport() {
    const data = await apiGet('/api/sentinel/reports/daily?' + qs({ hours:state.hours }));
    const report = data.report || {};
    state.dailyReport = report;
    state.dailyMarkdown = data.markdown || '';
    const flow = report.caseFlow || {};
    const ops = report.operations?.totals || {};
    const containment = report.containment || {};
    $('dailySocSummary').innerHTML = [
      kpi('Posture',report.posture?.score,(report.posture?.grade || 'unknown')),
      kpi('Opened',flow.opened || 0,(flow.triaged || 0) + ' triaged'),
      kpi('Contained',flow.contained || 0,(containment.created || 0) + ' new blocks'),
      kpi('Resolved',flow.resolved || 0,(flow.closed || 0) + ' validated closed'),
      kpi('SLA breached',ops.slaBreached || 0,(ops.dueSoon || 0) + ' due soon'),
      kpi('Handoff',report.priorityCases?.length || 0,'active priority cases'),
    ].join('');
    $('dailySocPreview').textContent = state.dailyMarkdown;
    $('dailySocPreview').hidden = false;
    $('btnCopyDaily').disabled = !state.dailyMarkdown;
    return report;
  }

  async function copyDailySocReport() {
    if (!state.dailyMarkdown) await loadDailySocReport();
    await navigator.clipboard.writeText(state.dailyMarkdown);
    showAlert('success','Daily SOC shift handoff copied');
  }

  async function loadRoutineStatus() {
    const data=await apiGet('/api/sentinel/routines/daily?limit=5');const run=(data.runs||[])[0];
    if(!run){$('dailyRoutineStatus').textContent='Not run today';$('dailyRoutineExceptions').innerHTML='';return;}
    $('dailyRoutineStatus').textContent=run.status+' · '+(relTime(run.completedAt||run.startedAt)||fmt(run.completedAt||run.startedAt));
    const exceptions=run.summary?.exceptions||[];
    $('dailyRoutineExceptions').innerHTML=exceptions.length?exceptions.map((item)=>'<button type="button" class="routine-exception" data-routine-exception="'+escapeHtml(item.type)+'">'+escapeHtml(item.type.replace(/_/g,' '))+' · '+item.count+'</button>').join(''):'<span class="muted small">No routine exceptions recorded.</span>';
    $('dailyRoutineExceptions').querySelectorAll('[data-routine-exception]').forEach((button)=>button.onclick=()=>{const type=button.dataset.routineException;posturePivot(type==='sla_breach'?'sla':type==='unassigned_cases'?'unassigned':'api');});
  }

  async function loadControlHealth(){
    const data=await apiGet('/api/sentinel/health');const health=data.health||{};
    const databaseClock=(health.checks||[]).find((item)=>item.id==='database_clock');
    const offset=Number(databaseClock?.metrics?.sessionOffsetMinutes);
    state.databaseOffsetMinutes=Number.isFinite(offset)?offset:null;
    $('controlHealthStatus').textContent=(health.status||'unknown')+' · '+fmt(health.calculatedAt);
    $('controlHealthStatus').className='muted small health-'+(health.status||'unknown');
    $('controlHealthChecks').innerHTML=(health.checks||[]).map((item)=>'<button type="button" class="control-health-check health-'+escapeHtml(item.status)+'" data-health-check="'+escapeHtml(item.id)+'"><span>'+escapeHtml(item.id.replace(/_/g,' '))+'</span><strong>'+escapeHtml(item.status)+'</strong><small>'+escapeHtml(item.detail)+'</small></button>').join('');
    $('controlHealthChecks').querySelectorAll('[data-health-check]').forEach((button)=>button.onclick=()=>{const id=button.dataset.healthCheck;if(id==='case_governance')posturePivot('sla');else if(id==='validation_pipeline'){setTab('validation');loadValidation();}else if(id==='daily_routine')$('btnRunRoutine').click();else if(id==='api_telemetry'){setTab('api');loadApiEvents();}else if(id==='authentication_telemetry'){setTab('logins');loadLogins();}});
  }

  async function loadResources(){const query=qs({itemType:$('resourceType')?.value,status:$('resourceStatus')?.value,priority:$('resourcePriority')?.value,q:$('resourceSearch')?.value.trim(),limit:300});const data=await apiGet('/api/sentinel/resources?'+query);state.resources=data.resources||[];const intel=state.resources.filter((item)=>item.itemType==='intelligence'),unreviewed=intel.filter((item)=>item.reviewStatus==='unreviewed'),critical=intel.filter((item)=>item.priority==='critical'&& !['actioned','archived','not_applicable'].includes(item.reviewStatus)),pinned=state.resources.filter((item)=>item.isPinned);$('resourceKpis').innerHTML=[kpi('Unreviewed intel',unreviewed.length,'analyst queue'),kpi('Critical attention',critical.length,'not dispositioned'),kpi('Pinned resources',pinned.length,'always available'),kpi('Catalog',state.resources.length,'filtered items')].join('');$('resourceList').innerHTML=state.resources.length?state.resources.map((item)=>'<button type="button" class="resource-card '+(state.selectedResource===item.id?'selected':'')+'" data-resource="'+escapeHtml(item.id)+'"><span>'+escapeHtml(item.publisher)+' · '+escapeHtml(item.itemType)+' · '+escapeHtml(item.priority)+'</span><strong>'+escapeHtml(item.title)+'</strong><small>'+escapeHtml(item.summary||'')+'</small><em>'+escapeHtml(item.reviewStatus.replace(/_/g,' '))+(item.isPinned?' · pinned':'')+'</em></button>').join(''):'<p class="muted">No resources match these filters.</p>';$('resourceList').querySelectorAll('[data-resource]').forEach((button)=>button.onclick=()=>openResource(button.dataset.resource));}
  async function openResource(id){const data=await apiGet('/api/sentinel/resources/'+encodeURIComponent(id)),item=data.resource;state.selectedResource=item.id;const states=['unreviewed','in_review','relevant','monitoring','actioned','not_applicable','archived'];$('resourceDetail').innerHTML='<div class="section-title"><div><span class="badge">'+escapeHtml(item.priority)+'</span><h3>'+escapeHtml(item.title)+'</h3></div>'+(item.sourceUrl?'<a class="btn btn-secondary btn-sm" href="'+escapeHtml(item.sourceUrl)+'" target="_blank" rel="noopener noreferrer">Open authoritative source</a>':'')+'</div><p>'+escapeHtml(item.summary||'')+'</p><dl class="detail-grid"><dt>Publisher</dt><dd>'+escapeHtml(item.publisher)+'</dd><dt>Domain</dt><dd>'+escapeHtml(item.sourceDomain||'Internal')+'</dd><dt>Category</dt><dd>'+escapeHtml(item.category)+'</dd><dt>Tags</dt><dd>'+escapeHtml((item.tags||[]).join(', ')||'—')+'</dd><dt>Case</dt><dd>'+escapeHtml(item.linkedCaseId||'Not linked')+'</dd><dt>Playbook</dt><dd>'+escapeHtml(item.linkedPlaybookId||'Not linked')+'</dd></dl><label>Review status<select id="resourceReviewState">'+states.map((stateName)=>'<option value="'+stateName+'" '+(stateName===item.reviewStatus?'selected':'')+'>'+stateName.replace(/_/g,' ')+'</option>').join('')+'</select></label><div class="inline-actions"><button type="button" class="btn btn-primary btn-sm" id="btnResourceReview">Record review</button></div><h4>Analyst history</h4><div class="playbook-history">'+((item.reviews||[]).length?(item.reviews||[]).map((review)=>'<article><strong>'+escapeHtml(review.fromStatus||'new')+' → '+escapeHtml(review.toStatus)+'</strong><span>'+escapeHtml(review.actorAdminId||'system')+' · '+escapeHtml(fmt(review.createdAt))+'</span><p>'+escapeHtml(review.note||'No note')+'</p></article>').join(''):'<p class="muted">No analyst reviews yet.</p>')+'</div>';$('btnResourceReview').onclick=async()=>{const status=$('resourceReviewState').value,note=window.prompt('Review note or relevance decision:','')||'',linkedCaseId=window.prompt('Optional case ID to link:',item.linkedCaseId||'')||'',linkedPlaybookId=window.prompt('Optional playbook ID to link:',item.linkedPlaybookId||'')||'';try{await apiSend('POST','/api/sentinel/resources/'+encodeURIComponent(item.id)+'/review',{status,note,linkedCaseId,linkedPlaybookId});showAlert('success','Resource review recorded');await Promise.all([loadResources(),openResource(item.id)]);}catch(error){showAlert('error',error.message||'Could not review resource');}};}

  async function loadPlaybooks(){
    const status=$('playbookStatusFilter')?.value||'';const [booksData,runsData,simData]=await Promise.all([apiGet('/api/sentinel/playbooks?'+qs({status})),apiGet('/api/sentinel/playbooks/runs?limit=50'),apiGet('/api/sentinel/playbooks/simulations?limit=25')]);
    state.playbooks=booksData.playbooks||[];state.playbookRuns=runsData.runs||[];state.playbookSimulations=simData.simulations||[];const active=state.playbooks.filter((item)=>item.status==='active').length,running=state.playbookRuns.filter((item)=>item.status==='running').length,completed=state.playbookRuns.filter((item)=>item.status==='completed').length;
    $('playbookKpis').innerHTML=[kpi('Active playbooks',active,state.playbooks.length+' cataloged'),kpi('Running checklists',running,'analyst controlled'),kpi('Completed runs',completed,'auditable histories'),kpi('Automated actions',0,'Phase 1 safety boundary')].join('');
    $('playbookLibrary').innerHTML=state.playbooks.length?state.playbooks.map((item)=>'<button type="button" class="playbook-card '+(state.selectedPlaybook===item.id?'selected':'')+'" data-playbook="'+escapeHtml(item.id)+'"><span>'+escapeHtml(item.status.replace(/_/g,' '))+' · v'+item.version+'</span><strong>'+escapeHtml(item.name)+'</strong><small>'+escapeHtml(item.purpose)+'</small><em>'+item.stepCount+' steps · '+item.runCount+' runs</em></button>').join(''):'<p class="muted">No playbooks match this lifecycle state.</p>';
    $('playbookLibrary').querySelectorAll('[data-playbook]').forEach((button)=>button.onclick=()=>openPlaybook(button.dataset.playbook));
    $('playbookRuns').innerHTML=state.playbookRuns.length?state.playbookRuns.map((run)=>'<button type="button" class="playbook-run" data-playbook-run="'+escapeHtml(run.id)+'"><strong>'+escapeHtml(run.playbookName)+'</strong><span>'+escapeHtml(run.status)+' · v'+run.version+' · '+escapeHtml(relTime(run.completedAt||run.startedAt)||fmt(run.startedAt))+'</span></button>').join(''):'<p class="muted">No playbook runs recorded.</p>';
    $('playbookRuns').querySelectorAll('[data-playbook-run]').forEach((button)=>button.onclick=()=>openPlaybookRun(button.dataset.playbookRun));
    $('playbookSimulations').innerHTML=state.playbookSimulations.length?state.playbookSimulations.map((sim)=>'<button type="button" class="playbook-run playbook-simulation-history" data-simulation="'+escapeHtml(sim.id)+'"><strong>'+escapeHtml(sim.playbookName)+' · '+escapeHtml(sim.mode.replace(/_/g,' '))+'</strong><span>'+escapeHtml(sim.status)+' · v'+sim.version+' · '+escapeHtml(relTime(sim.completedAt||sim.createdAt)||fmt(sim.createdAt))+'</span></button>').join(''):'<p class="muted">No simulations recorded.</p>';
    $('playbookSimulations').querySelectorAll('[data-simulation]').forEach((button)=>button.onclick=()=>{const sim=state.playbookSimulations.find((item)=>item.id===button.dataset.simulation);if(sim)renderPlaybookSimulation(sim);});
  }
  async function openPlaybook(id){
    const data=await apiGet('/api/sentinel/playbooks/'+encodeURIComponent(id)),item=data.playbook;state.selectedPlaybook=item.id;
    const governance={draft:[['peer_review','Submit for review']],peer_review:[['approved','Approve'],['draft','Return to draft']],approved:[['active','Publish'],['draft','Return to draft']],active:[['deprecated','Deprecate']],deprecated:[['active','Reactivate'],['archived','Archive']]}[item.status]||[];
    const validation=item.validation||{ready:false,passed:0,total:8,gates:[]};
    $('playbookDetail').innerHTML='<div class="section-title"><div><span class="badge">'+escapeHtml(item.status)+'</span><h3>'+escapeHtml(item.name)+'</h3></div><div class="inline-actions"><button type="button" class="btn btn-primary btn-sm" id="btnStartPlaybook" '+(item.status==='active'?'':'disabled')+'>Start manual run</button></div></div><p>'+escapeHtml(item.purpose)+'</p><dl class="detail-grid"><dt>Version</dt><dd>'+item.version+'</dd><dt>Author</dt><dd>'+escapeHtml(item.createdBy||'system catalog')+'</dd><dt>Entities</dt><dd>'+escapeHtml((item.requiredEntities||[]).join(', ')||'None')+'</dd><dt>ATT&CK</dt><dd>'+escapeHtml((item.techniques||[]).join(', ')||'Not mapped')+'</dd><dt>Rollback</dt><dd>'+escapeHtml(item.rollbackPlan||'Not defined')+'</dd></dl><div class="playbook-governance-actions">'+governance.map((action)=>'<button type="button" class="btn btn-secondary btn-sm playbook-transition" data-to-status="'+action[0]+'">'+action[1]+'</button>').join('')+'</div><h4>Preconditions</h4><ul>'+(item.preconditions||[]).map((value)=>'<li>'+escapeHtml(value)+'</li>').join('')+'</ul><h4>Controlled steps</h4><ol class="playbook-step-preview">'+(item.steps||[]).map((step)=>'<li><strong>'+escapeHtml(step.name)+'</strong><span>'+escapeHtml(step.riskClass)+' · '+(step.required?'required':'optional')+'</span></li>').join('')+'</ol><div class="section-title playbook-validation-heading"><h4>Purple Team validation</h4><span class="badge '+(validation.ready?'badge-ok':'')+'">'+validation.passed+'/'+validation.total+' passed</span></div><div class="playbook-validation-grid">'+(validation.gates||[]).map((gate)=>'<article class="validation-'+escapeHtml(gate.outcome)+'"><div><strong>'+escapeHtml(gate.label)+'</strong><span>'+escapeHtml(gate.outcome)+(gate.testedAt?' · '+escapeHtml(fmt(gate.testedAt)):'')+'</span><p>'+escapeHtml(gate.description)+'</p>'+(gate.evidenceReference?'<small>Evidence: '+escapeHtml(gate.evidenceReference)+'</small>':'')+'</div><div class="inline-actions"><button type="button" class="btn btn-primary btn-sm playbook-validation-result" data-gate="'+escapeHtml(gate.key)+'" data-outcome="passed">Pass</button><button type="button" class="btn btn-secondary btn-sm playbook-validation-result" data-gate="'+escapeHtml(gate.key)+'" data-outcome="partial">Partial</button><button type="button" class="btn btn-secondary btn-sm playbook-validation-result" data-gate="'+escapeHtml(gate.key)+'" data-outcome="failed">Fail</button></div></article>').join('')+'</div><h4>Governance history</h4><div class="playbook-history">'+((item.reviews||[]).length?(item.reviews||[]).map((review)=>'<article><strong>'+escapeHtml(review.action)+'</strong><span>'+escapeHtml(review.fromStatus||'new')+' → '+escapeHtml(review.toStatus)+' · '+escapeHtml(fmt(review.createdAt))+'</span><p>'+escapeHtml(review.reason)+'</p></article>').join(''):'<p class="muted">No lifecycle actions recorded.</p>')+'</div>';
    $('btnStartPlaybook').onclick=async()=>{try{const note=window.prompt('Optional run context or case reference:','')||'';const result=await apiSend('POST','/api/sentinel/playbooks/'+encodeURIComponent(item.id)+'/runs',{note});showAlert('success','Manual playbook run started');await loadPlaybooks();await openPlaybookRun(result.run.id);}catch(error){showAlert('error',error.message||'Could not start playbook');}};
    $('playbookDetail').querySelectorAll('.playbook-transition').forEach((button)=>button.onclick=async()=>{const toStatus=button.dataset.toStatus,reason=window.prompt('Governance reason for '+toStatus.replace(/_/g,' ')+':','');if(!reason)return;try{const endpoint=toStatus==='peer_review'?'/submit':'/governance';await apiSend('POST','/api/sentinel/playbooks/'+encodeURIComponent(item.id)+endpoint,{toStatus,reason});showAlert('success','Playbook moved to '+toStatus.replace(/_/g,' '));await Promise.all([loadPlaybooks(),openPlaybook(item.id)]);}catch(error){showAlert('error',error.message||'Governance action failed');}});
    $('playbookDetail').querySelectorAll('.playbook-validation-result').forEach((button)=>button.onclick=async()=>{const evidence=window.prompt('Evidence reference for '+button.dataset.gate.replace(/_/g,' ')+':','');if(!evidence)return;const note=window.prompt('Optional Purple Team observation:','')||'';try{await apiSend('POST','/api/sentinel/playbooks/'+encodeURIComponent(item.id)+'/validation',{gateKey:button.dataset.gate,outcome:button.dataset.outcome,evidenceReference:evidence,note});showAlert('success','Validation result recorded');await openPlaybook(item.id);}catch(error){showAlert('error',error.message||'Could not record validation');}});
  }
  async function openPlaybookRun(id){
    const data=await apiGet('/api/sentinel/playbooks/runs/'+encodeURIComponent(id)),run=data.run;state.selectedPlaybookRun=id;
    $('playbookDetail').innerHTML='<div class="section-title"><div><span class="badge">'+escapeHtml(run.status)+'</span><h3>'+escapeHtml(run.playbookName)+' · run</h3></div>'+(run.status==='running'?'<button type="button" class="btn btn-secondary btn-sm" id="btnCancelPlaybookRun">Cancel run</button>':'')+'</div><p class="muted small">Immutable playbook version '+run.version+' · started '+escapeHtml(fmt(run.startedAt))+'</p><div class="playbook-checklist">'+(run.steps||[]).map((step)=>'<article class="playbook-check '+escapeHtml(step.status)+'"><div><strong>'+step.order+'. '+escapeHtml(step.name)+'</strong><p>'+escapeHtml(step.instructions)+'</p><small>'+escapeHtml(step.status)+(step.analystNote?' · '+escapeHtml(step.analystNote):'')+'</small></div>'+(step.status==='pending'&&run.status==='running'?'<div class="inline-actions"><button type="button" class="btn btn-primary btn-sm playbook-step-complete" data-step-run="'+escapeHtml(step.id)+'">Complete</button><button type="button" class="btn btn-secondary btn-sm playbook-step-skip" data-step-run="'+escapeHtml(step.id)+'">Skip</button></div>':'')+'</article>').join('')+'</div>';
    $('playbookDetail').querySelectorAll('.playbook-step-complete').forEach((button)=>button.onclick=()=>finishPlaybookStep(run.id,button.dataset.stepRun,'completed'));$('playbookDetail').querySelectorAll('.playbook-step-skip').forEach((button)=>button.onclick=()=>finishPlaybookStep(run.id,button.dataset.stepRun,'skipped'));
    if($('btnCancelPlaybookRun'))$('btnCancelPlaybookRun').onclick=async()=>{const reason=window.prompt('Cancellation reason:','');if(!reason)return;try{await apiSend('POST','/api/sentinel/playbooks/runs/'+encodeURIComponent(run.id)+'/cancel',{reason});await Promise.all([openPlaybookRun(run.id),loadPlaybooks()]);}catch(error){showAlert('error',error.message);}};
  }
  async function finishPlaybookStep(runId,stepId,status){const note=window.prompt(status==='skipped'?'Reason for skipping this step:':'Analyst note or evidence summary:','');if(status==='skipped'&&!note)return;const evidence=status==='completed'?(window.prompt('Optional evidence reference (case note, event ID, or approved URL):','')||''):'';try{await apiSend('POST','/api/sentinel/playbooks/runs/'+encodeURIComponent(runId)+'/steps/'+encodeURIComponent(stepId),{status,note:note||'',evidenceReference:evidence});await Promise.all([openPlaybookRun(runId),loadPlaybooks()]);showAlert('success','Playbook step recorded');}catch(error){showAlert('error',error.message||'Could not update step');}}
  async function runPlaybookSimulation(mode){if(!state.selectedPlaybook){showAlert('warning','Select a playbook first');return;}const input={entityType:$('playbookSimEntityType').value,entityValue:$('playbookSimEntityValue').value.trim(),hours:Number($('playbookSimHours').value)};try{const data=await apiSend('POST','/api/sentinel/playbooks/'+encodeURIComponent(state.selectedPlaybook)+'/'+mode,input);renderPlaybookSimulation(data.simulation);await loadPlaybooks();showAlert('success',mode==='preview'?'Action plan preview recorded':'Read-only dry run completed');}catch(error){showAlert('error',error.message||'Simulation failed');}}
  function renderPlaybookSimulation(sim){const outputs=sim.result?.outputs||[],warnings=sim.result?.warnings||[];$('playbookSimulationResult').innerHTML='<div class="simulation-header"><strong>'+escapeHtml(sim.playbookName||'Playbook')+' · '+escapeHtml(String(sim.mode||'').replace(/_/g,' '))+'</strong><span class="badge">'+escapeHtml(sim.status||'completed')+'</span></div><div class="simulation-actions">'+(sim.actions||[]).map((action)=>'<article class="'+(action.eligible?'eligible':'ineligible')+'"><strong>'+escapeHtml(action.label)+'</strong><span>'+escapeHtml(action.riskClass)+' · '+escapeHtml(action.permission)+' · '+(action.sideEffects?'state changing':'no side effects')+'</span>'+(action.reason?'<p>'+escapeHtml(action.reason)+'</p>':'')+'</article>').join('')+'</div>'+(outputs.length?'<h4>Aggregate results</h4><pre>'+escapeHtml(JSON.stringify(outputs,null,2))+'</pre>':'')+(warnings.length?'<p class="muted">Warnings: '+escapeHtml(warnings.join('; '))+'</p>':'');}

  async function loadRetention(){
    const data=await apiGet('/api/sentinel/retention');const policies=data.policies||[];const preview=data.preview||{};const impact=preview.impact||{};
    $('retentionKpis').innerHTML=[kpi('Eligible records',preview.totalEligible||0,'preview only'),kpi('Policies',policies.length,'data classes'),kpi('Protected classes',preview.preserved?.length||0,'never purged here')].join('');
    $('retentionRows').innerHTML=policies.length?policies.map((policy)=>{const item=impact[policy.dataClass]||{};return '<tr><td>'+escapeHtml(policy.dataClass.replace(/_/g,' '))+'</td><td>'+policy.retentionDays+' days</td><td>'+(policy.isEnabled?'enabled':'disabled')+'</td><td>'+(item.eligible||0)+'</td><td>'+escapeHtml(relTime(policy.updatedAt)||fmt(policy.updatedAt))+'</td></tr>';}).join(''):'<tr><td colspan="5" class="muted">No retention policies configured</td></tr>';
    $('retentionPreserved').textContent='Preserved: '+(preview.preserved||[]).join(', ');
    $('btnRetentionExecute').disabled=!state.canRevealForensics;
    if(!state.canRevealForensics)$('retentionConfirm').placeholder='Root access required';
  }

  async function loadValidation() {
    const days=Number($('validationDays').value)||90;
    const [coverageData,runsData]=await Promise.all([
      apiGet('/api/sentinel/validation/coverage?'+qs({days})),
      apiGet('/api/sentinel/validation/runs?limit=100'),
    ]);
    const coverage=coverageData.coverage||{};const t=coverage.totals||{};
    $('validationKpis').innerHTML=[
      kpi('Detection rate',Math.round((t.detectionRate||0)*100)+'%',(t.detected||0)+' detected'),
      kpi('Techniques tested',t.techniques||0,(t.mappedTechniques||0)+' mapped'),
      kpi('Missed',t.missed||0,'coverage gaps'),
      kpi('Prevented',t.prevented||0,'control stopped'),
      kpi('Partial',t.partial||0,'needs tuning'),
      kpi('Mean detection',socDuration(t.avgDetectionSeconds),'simulation to detection'),
    ].join('');
    $('validationCoverageRows').innerHTML=(coverage.techniques||[]).length?(coverage.techniques||[]).map((row)=>'<tr><td class="mono">'+escapeHtml(row.techniqueId)+'</td><td>'+escapeHtml(row.tactic||'—')+'</td><td>'+row.tests+'</td><td>'+row.detected+'</td><td class="'+(row.missed?'sev-high':'')+'">'+row.missed+'</td><td>'+escapeHtml(relTime(row.lastTested)||fmt(row.lastTested))+'</td></tr>').join(''):'<tr><td colspan="6" class="muted">No validation observations in this window</td></tr>';
    state.validationRuns=runsData.runs||[];
    $('validationRuns').innerHTML=state.validationRuns.length?state.validationRuns.map((run)=>'<button type="button" class="validation-run '+(state.selectedValidationRun===run.id?'selected':'')+'" data-validation-run="'+escapeHtml(run.id)+'"><strong>'+escapeHtml(run.name)+'</strong><span>'+escapeHtml(run.status)+' · '+(run.observations||0)+' observations</span></button>').join(''):'<p class="muted">No validation runs yet.</p>';
    $('validationRuns').querySelectorAll('[data-validation-run]').forEach((button)=>button.onclick=()=>openValidationRun(button.dataset.validationRun));
  }

  async function openValidationRun(id) {
    const data=await apiGet('/api/sentinel/validation/runs/'+encodeURIComponent(id));const run=data.run;
    state.selectedValidationRun=id;$('validationRunTitle').textContent=run.name+' · '+run.status;
    $('validationObservationForm').hidden=['completed','cancelled'].includes(run.status);
    const rows=run.observationRows||[];
    $('validationObservations').innerHTML=rows.length?rows.map((row)=>'<tr><td class="mono">'+escapeHtml(row.techniqueId)+'</td><td>'+escapeHtml(row.tactic||'—')+'</td><td>'+escapeHtml(row.outcome)+'</td><td>'+escapeHtml(row.detectedAt?socDuration((new Date(row.detectedAt)-new Date(row.simulatedAt))/1000):'—')+'</td><td>'+escapeHtml(row.triggeredCaseId||'—')+'</td></tr>').join(''):'<tr><td colspan="5" class="muted">No observations recorded</td></tr>';
    await loadValidation();
  }

  // ——— Events wiring ———
  function wire() {
    document.getElementById('navDash').href = base;
    document.getElementById('navKeys').href = base + '/keys';
    const navConn = document.getElementById('navConn');
    if (navConn) navConn.href = base + '/connections';
    const navHawk = document.getElementById('navHawk');
    if (navHawk) navHawk.href = base + '/hawk';
    const navParrot = document.getElementById('navParrot');
    if (navParrot) navParrot.href = base + '/parrot';
    document.getElementById('navDocs').href = base + '/docs';

    document.querySelectorAll('.sentinel-tab').forEach((btn) => {
      btn.onclick = () => {
        setTab(btn.dataset.tab);
        if (btn.dataset.tab === 'investigate') loadTimeline();
        if (btn.dataset.tab === 'review') Promise.all([loadCases(),loadCaseOperations()]);
        if (btn.dataset.tab === 'newips') loadNewIps();
        if (btn.dataset.tab === 'blocks') loadBlocks();
        if (btn.dataset.tab === 'rules') loadRules();
        if (btn.dataset.tab === 'validation') loadValidation();
        if (btn.dataset.tab === 'retention') loadRetention();
        if (btn.dataset.tab === 'playbooks') loadPlaybooks();
        if (btn.dataset.tab === 'resources') loadResources();
      };
    });
    if($('btnPlaybookRefresh'))$('btnPlaybookRefresh').onclick=()=>loadPlaybooks().catch((error)=>showAlert('error',error.message));
    if($('playbookStatusFilter'))$('playbookStatusFilter').onchange=()=>loadPlaybooks().catch((error)=>showAlert('error',error.message));
    if($('btnPlaybookNew'))$('btnPlaybookNew').onclick=()=>{$('playbookAuthoring').hidden=false;$('playbookDraftName').focus();};
    if($('btnPlaybookDraftClose'))$('btnPlaybookDraftClose').onclick=()=>{$('playbookAuthoring').hidden=true;};
    if($('btnPlaybookDraftSave'))$('btnPlaybookDraftSave').onclick=async()=>{const lines=(id)=>String($(id).value||'').split(/\r?\n/).map((value)=>value.trim()).filter(Boolean),csv=(id)=>String($(id).value||'').split(',').map((value)=>value.trim()).filter(Boolean);try{const data=await apiSend('POST','/api/sentinel/playbooks',{name:$('playbookDraftName').value.trim(),slug:$('playbookDraftSlug').value.trim(),purpose:$('playbookDraftPurpose').value.trim(),requiredEntities:csv('playbookDraftEntities'),techniques:csv('playbookDraftTechniques'),preconditions:lines('playbookDraftPreconditions'),steps:lines('playbookDraftSteps'),rollbackPlan:$('playbookDraftRollback').value.trim()});$('playbookAuthoring').hidden=true;showAlert('success','Playbook draft created');await loadPlaybooks();await openPlaybook(data.playbook.id);}catch(error){showAlert('error',error.message||'Could not create draft');}};
    if($('btnPlaybookPreview'))$('btnPlaybookPreview').onclick=()=>runPlaybookSimulation('preview');
    if($('btnPlaybookDryRun'))$('btnPlaybookDryRun').onclick=()=>runPlaybookSimulation('dry-run');
    if($('btnResourceRefresh'))$('btnResourceRefresh').onclick=()=>loadResources().catch((error)=>showAlert('error',error.message));
    if($('btnResourceFilter'))$('btnResourceFilter').onclick=()=>loadResources().catch((error)=>showAlert('error',error.message));

    if ($('btnCaseFilter')) {
      $('btnCaseFilter').onclick = () => {
        state.caseFilters = {
          status: $('cfStatus').value,
          severity: $('cfSev').value,
          owner: $('cfOwner').value,
          sla: $('cfSla').value,
          disposition: $('cfDisposition').value,
          q: $('cfQ').value.trim(),
        };
        loadCases();
      };
    }
    document.querySelectorAll('[data-case-view]').forEach((button) => {
      button.onclick = () => {
        const view = button.dataset.caseView;
        state.caseFilters = {};
        if (view === 'unassigned') state.caseFilters.owner = 'unassigned';
        if (view === 'breached') state.caseFilters.sla = 'breached';
        if (view === 'validation') state.caseFilters.status = 'resolved';
        if (view === 'reopened') state.caseFilters.status = 'reopened';
        $('cfStatus').value = state.caseFilters.status || '';
        $('cfOwner').value = state.caseFilters.owner || '';
        $('cfSla').value = state.caseFilters.sla || '';
        loadCases();
      };
    });
    if ($('btnCaseSync')) {
      $('btnCaseSync').onclick = async () => {
        try {
          await apiSend('POST', '/api/sentinel/threats/sync', { hours: state.hours });
          showAlert('success', 'Threats synced to review cases');
          await loadCases();
          loadSummary();
        } catch (e) {
          if (e.message !== 'auth') showAlert('error', e.message);
        }
      };
    }
    if ($('btnAddBlock')) {
      $('btnAddBlock').onclick = async () => {
        try {
          await apiSend('POST', '/api/sentinel/blocks', {
            ip: $('blockIp').value.trim(),
            reason: $('blockReason').value.trim() || 'Manual block',
            expiresAt: $('blockExpires').value.trim() || null,
          });
          showAlert('success', 'IP blocked');
          $('blockIp').value = '';
          $('blockReason').value = '';
          $('blockExpires').value = '';
          loadBlocks();
        } catch (e) {
          if (e.message !== 'auth') showAlert('error', e.message);
        }
      };
    }
    if ($('blockShowAll')) {
      $('blockShowAll').onchange = () => loadBlocks();
    }
    if ($('btnCreateRule')) {
      $('btnCreateRule').onclick = async () => {
        try {
          const statusRaw = $('ruleStatus').value;
          const condition = {
            source: $('ruleSource').value,
            groupBy: $('ruleGroup').value,
            minCount: Number($('ruleMin').value) || 5,
            windowMinutes: Number($('ruleWindow').value) || 60,
          };
          if (statusRaw !== '') condition.statusCode = Number(statusRaw);
          if ($('ruleOutcome').value) condition.outcome = $('ruleOutcome').value;
          if ($('rulePath').value.trim()) condition.pathContains = $('rulePath').value.trim();
          await apiSend('POST', '/api/sentinel/rules', {
            name: $('ruleName').value.trim(),
            severity: $('ruleSev').value,
            condition,
            actions: {
              createCase: true,
              autoBlock: Boolean($('ruleAutoBlock').checked),
              autoBlockMinSeverity: $('ruleSev').value,
            },
          });
          showAlert('success', 'Custom rule created');
          $('ruleName').value = '';
          loadRules();
        } catch (e) {
          if (e.message !== 'auth') showAlert('error', e.message);
        }
      };
    }
    if($('validationDays'))$('validationDays').onchange=()=>loadValidation();
    if($('btnValidationCreate'))$('btnValidationCreate').onclick=async()=>{try{const data=await apiSend('POST','/api/sentinel/validation/runs',{name:$('validationName').value.trim(),objective:$('validationObjective').value.trim(),start:true});state.selectedValidationRun=data.run.id;$('validationName').value='';$('validationObjective').value='';await openValidationRun(data.run.id);showAlert('success','Validation run started');}catch(error){showAlert('error',error.message);}};
    if($('btnValidationRecord'))$('btnValidationRecord').onclick=async()=>{try{const outcome=$('validationOutcome').value;await apiSend('POST','/api/sentinel/validation/runs/'+encodeURIComponent(state.selectedValidationRun)+'/observations',{techniqueId:$('validationTechnique').value.trim(),tactic:$('validationTactic').value.trim(),expectedRuleId:$('validationRule').value.trim(),outcome,simulatedAt:$('validationSimulated').value||new Date().toISOString(),detectedAt:outcome==='detected'?($('validationDetected').value||new Date().toISOString()):undefined,note:$('validationNote').value.trim()});await openValidationRun(state.selectedValidationRun);showAlert('success','Validation outcome recorded');}catch(error){showAlert('error',error.message);}};
    if($('btnValidationEvaluate'))$('btnValidationEvaluate').onclick=async()=>{try{const result=await apiSend('POST','/api/sentinel/validation/runs/'+encodeURIComponent(state.selectedValidationRun)+'/evaluate',{});await openValidationRun(state.selectedValidationRun);showAlert('success',result.detected+' detected · '+result.missed+' missed · '+result.waiting+' still waiting');}catch(error){showAlert('error',error.message);}};
    if($('btnValidationComplete'))$('btnValidationComplete').onclick=async()=>{try{const result=await apiSend('POST','/api/sentinel/validation/runs/'+encodeURIComponent(state.selectedValidationRun)+'/evaluate',{forceMissed:true,createRemediation:true});await apiSend('POST','/api/sentinel/validation/runs/'+encodeURIComponent(state.selectedValidationRun)+'/status',{status:'completed'});await openValidationRun(state.selectedValidationRun);showAlert('success','Run completed · '+result.remediations+' detection-gap case(s) created');}catch(error){showAlert('error',error.message);}};
    if ($('btnIntelClose')) {
      $('btnIntelClose').onclick = () => {
        $('intelDrawer').hidden = true;
      };
    }
    if ($('intelDrawer')) {
      $('intelDrawer').onclick = (e) => {
        if (e.target === $('intelDrawer')) $('intelDrawer').hidden = true;
      };
    }
    $('btnEvidenceClose').onclick = closeEvidenceDrawer;
    $('evidenceDrawer').onclick = (event) => {
      if (event.target === $('evidenceDrawer')) closeEvidenceDrawer();
    };
    $('btnEvidenceReveal').onclick = revealEvidence;
    document.querySelectorAll('[data-evidence-tab]').forEach((button) => {
      button.onclick = () => selectEvidenceTab(button.dataset.evidenceTab);
    });
    $('btnEvidenceCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText($('evidenceJson').textContent);
        showAlert('success', 'Redacted evidence view copied');
      } catch {
        showAlert('warning', 'Clipboard access was unavailable');
      }
    };
    $('btnEvidencePivotIp').onclick = () => {
      const ip = state.evidenceData?.event?.ip;
      if (ip) { closeEvidenceDrawer(); pivotToInvestigate('ip', ip); }
    };
    $('btnEvidencePivotPath').onclick = () => {
      const path = state.evidenceData?.event?.path;
      if (path) { closeEvidenceDrawer(); pivotToInvestigate('path', path); }
    };
    if ($('btnInvIntel')) {
      $('btnInvIntel').onclick = () => {
        const ip = ($('invIpActions') && $('invIpActions').dataset.ip) || $('invIp').value.trim();
        openIntel(ip);
      };
    }
    if ($('btnInvBlock')) {
      $('btnInvBlock').onclick = () => {
        const ip = ($('invIpActions') && $('invIpActions').dataset.ip) || $('invIp').value.trim();
        quickBlockIp(ip, 'Blocked from Investigate');
      };
    }
    if ($('btnInvMore')) $('btnInvMore').onclick = () => loadTimeline(true);

    $('selHours').onchange = () => {
      state.hours = Number($('selHours').value) || 24;
      state.loginOffset = 0;
      state.apiOffset = 0;
      loadAll();
    };

    $('btnRefresh').onclick = () => loadAll();

    $('selRefresh').onchange = () => {
      state.refreshSec = Number($('selRefresh').value) || 0;
      setupRefresh();
    };

    $('btnLoginFilter').onclick = () => {
      state.loginFilters = {
        outcome: $('lfOutcome').value,
        eventType: $('lfType').value,
        ip: $('lfIp').value.trim(),
        locationId: $('lfLoc').value.trim(),
        q: $('lfQ').value.trim(),
      };
      state.loginOffset = 0;
      loadLogins();
      renderChips();
    };
    $('btnLoginFilterClear').onclick = () => {
      state.loginFilters = {};
      $('lfOutcome').value = '';
      $('lfType').value = '';
      $('lfIp').value = '';
      $('lfLoc').value = '';
      $('lfQ').value = '';
      state.loginOffset = 0;
      loadLogins();
      renderChips();
    };
    $('loginPrev').onclick = () => {
      state.loginOffset = Math.max(0, state.loginOffset - PAGE);
      loadLogins();
    };
    $('loginNext').onclick = () => {
      if (state.loginOffset + PAGE < state.loginTotal) {
        state.loginOffset += PAGE;
        loadLogins();
      }
    };

    $('btnApiFilter').onclick = () => {
      state.apiFilters = {
        status: $('afStatus').value.trim(),
        method: $('afMethod').value,
        path: $('afPath').value.trim(),
        ip: $('afIp').value.trim(),
        errorClass: $('afErr').value,
        surface: $('afSurface').value,
        action: $('afAction').value.trim(),
        outcome: $('afOutcome').value,
        q: $('afQ').value.trim(),
      };
      state.apiOffset = 0;
      loadApiEvents();
      renderChips();
    };
    $('btnApiFilterClear').onclick = () => {
      state.apiFilters = {};
      ['afStatus', 'afMethod', 'afSurface', 'afAction', 'afOutcome', 'afPath', 'afIp', 'afErr', 'afQ'].forEach((id) => {
        $(id).value = '';
      });
      state.apiOffset = 0;
      loadApiEvents();
      renderChips();
    };
    $('apiPrev').onclick = () => {
      state.apiOffset = Math.max(0, state.apiOffset - PAGE);
      loadApiEvents();
    };
    $('apiNext').onclick = () => {
      if (state.apiOffset + PAGE < state.apiTotal) {
        state.apiOffset += PAGE;
        loadApiEvents();
      }
    };

    $('btnInvFilter').onclick = () => {
      state.invFilters = {
        ip: $('invIp').value.trim(),
        locationId: $('invLoc').value.trim(),
        username: $('invUser').value.trim(),
        path: $('invPath').value.trim(),
        q: $('invQ').value.trim(),
      };
      loadTimeline();
      renderChips();
    };
    $('btnInvClear').onclick = () => {
      state.invFilters = {};
      ['invIp', 'invLoc', 'invUser', 'invPath', 'invQ'].forEach((id) => {
        $(id).value = '';
      });
      loadTimeline();
      renderChips();
    };

    const exportMenu = $('exportMenu');
    $('btnExportToggle').onclick = (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    };
    document.addEventListener('click', () => exportMenu.classList.remove('open'));
    exportMenu.querySelectorAll('[data-export]').forEach((btn) => {
      btn.onclick = () => {
        const type = btn.dataset.export;
        const url =
          base +
          '/api/sentinel/export?' +
          qs({ type, hours: state.hours, ip: state.invFilters.ip || state.loginFilters.ip || state.apiFilters.ip });
        window.location.href = url;
        exportMenu.classList.remove('open');
      };
    });
    $('btnCopyReport').onclick = async () => {
      try {
        await navigator.clipboard.writeText(buildIrReport());
        showAlert('success', 'IR report copied to clipboard');
      } catch {
        showAlert('warning', 'Could not copy — select text manually from console');
        console.log(buildIrReport());
      }
      exportMenu.classList.remove('open');
    };
    if ($('btnGenerateDaily')) $('btnGenerateDaily').onclick = async () => {
      try { await loadDailySocReport(); showAlert('success','Daily SOC report generated'); }
      catch (error) { showAlert('error',error.message || 'Daily report failed'); }
    };
    if($('btnRunRoutine'))$('btnRunRoutine').onclick=async()=>{const button=$('btnRunRoutine');button.disabled=true;button.textContent='Running…';try{const result=await apiSend('POST','/api/sentinel/routines/daily',{hours:state.hours});showAlert('success',result.reused?'Today’s routine was already completed':'Daily protections completed');await Promise.all([loadRoutineStatus(),loadSummary(),loadDailySocReport()]);}catch(error){showAlert('error',error.message||'Protection routine failed');}finally{button.disabled=false;button.textContent='Run protections';}};
    if($('btnControlHealth'))$('btnControlHealth').onclick=()=>loadControlHealth().catch((error)=>showAlert('error',error.message||'Health check failed'));
    if($('btnRetentionRefresh'))$('btnRetentionRefresh').onclick=()=>loadRetention().catch((error)=>showAlert('error',error.message||'Retention preview failed'));
    if($('btnRetentionExecute'))$('btnRetentionExecute').onclick=async()=>{const button=$('btnRetentionExecute');button.disabled=true;try{const data=await apiSend('POST','/api/sentinel/retention/execute',{confirmation:$('retentionConfirm').value});const deleted=data.result?.deleted||{};showAlert('success','Retention completed · '+Object.values(deleted).reduce((sum,value)=>sum+Number(value||0),0)+' record(s) removed');$('retentionConfirm').value='';await Promise.all([loadRetention(),loadControlHealth()]);}catch(error){showAlert('error',error.message||'Retention failed');}finally{button.disabled=!state.canRevealForensics;}};
    if ($('btnFindingDispositions')) $('btnFindingDispositions').onclick = async () => {
      const panel = $('findingDispositionPanel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        try { await loadFindingDispositions(); } catch (error) { showAlert('error', error.message || 'Could not load finding dispositions'); }
      }
    };
    if ($('btnFindingDispositionSave')) $('btnFindingDispositionSave').onclick = async () => {
      const button = $('btnFindingDispositionSave');
      const parseList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
      const statuses = parseList($('findingDispositionStatuses').value).map(Number).filter(Number.isFinite);
      const maxCount = Number($('findingDispositionMax').value);
      button.disabled = true;
      try {
        await apiSend('POST', '/api/sentinel/threats/dispositions', {
          findingId: $('findingDispositionId').value,
          disposition: $('findingDispositionType').value,
          reason: $('findingDispositionReason').value.trim(),
          durationDays: Number($('findingDispositionDays').value),
          maxCount: Number.isFinite(maxCount) ? maxCount : undefined,
          allowedStatusCodes: statuses,
          allowedIps: parseList($('findingDispositionIps').value),
          hours: state.hours,
        });
        $('findingDispositionDialog').close();
        await loadSummary();
        if (!$('findingDispositionPanel').hidden) await loadFindingDispositions();
        showAlert('success', 'Finding action saved with conditional reactivation');
      } catch (error) { showAlert('error', error.message || 'Could not save finding action'); }
      finally { button.disabled = false; }
    };
    if ($('btnCopyDaily')) $('btnCopyDaily').onclick = async () => {
      try { await copyDailySocReport(); } catch { showAlert('warning','Clipboard access was unavailable'); }
    };
    if ($('btnDailyReport')) $('btnDailyReport').onclick = async () => {
      exportMenu.classList.remove('open'); setTab('posture');
      try { await loadDailySocReport(); $('dailySocPreview').scrollIntoView({ behavior:'smooth',block:'center' }); }
      catch (error) { showAlert('error',error.message || 'Daily report failed'); }
    };

    $('logout').onclick = async (e) => {
      e.preventDefault();
      await fetch(base + '/logout', { method: 'POST' });
      location.href = base + '/login';
    };
  }

  function setupRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    state.refreshTimer = null;
    state.countdownTimer = null;
    if (!state.refreshSec) return;
    state.countdown = state.refreshSec;
    state.countdownTimer = setInterval(() => {
      state.countdown -= 1;
      if (state.countdown <= 0) state.countdown = state.refreshSec;
      $('lastUpdated').textContent =
        'Updated ' + new Date().toLocaleTimeString() + ' · refresh in ' + state.countdown + 's';
    }, 1000);
    state.refreshTimer = setInterval(() => loadAll(), state.refreshSec * 1000);
  }

  async function boot() {
    wire();
    try {
      const me = await apiGet('/me');
      if (!me.ok) throw new Error('auth');
      state.admin = me.admin || null;
    } catch {
      location.href = base + '/login?next=' + encodeURIComponent(base + '/sentinel');
      return;
    }
    await loadAll();
  }

  boot();
})();
