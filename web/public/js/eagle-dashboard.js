(function () {
  'use strict';

  const base = location.pathname.replace(/\/eagle\/?$/, '') || '';
  const el = (id) => document.getElementById(id);
  const FIPS = {
    '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL',
    '13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME',
    '24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH',
    '34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI',
    '45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY',
  };
  let contexts = [];
  let snapshot = null;
  let dashboard = null;
  let demographics = null;
  let campaignData = null;
  let scheduleDebug = null;
  let rollout = null;
  let targets = [];
  let targetAssessments = [];
  let activeView = 'overview';
  let mapFeatures = null;
  let leadOffset = 0;
  let geoView = 'states';
  let pollTimer = null;
  let campaignPollTimer = null;
  const filterCatalog = {};

  const nav = { navHome:'', navDashboard:'', navOwl:'/owl', navSong:'/song', navHawk:'/hawk', navParrot:'/parrot', navCrm:'/crm-integrations', navDocs:'/docs' };
  Object.entries(nav).forEach(([id, suffix]) => { el(id).href = base + suffix; });

  async function api(path, options = {}) {
    const response = await fetch(base + path, {
      ...options,
      headers: { Accept:'application/json', 'Content-Type':'application/json', ...(options.headers || {}) },
    });
    const body = await response.text();
    let data = {};
    if (body.trim()) {
      try { data = JSON.parse(body); }
      catch { throw new Error(`EAGLE returned an invalid response for ${path}.`); }
    }
    if (!response.ok) throw new Error(data.error || `EAGLE request failed (${response.status})`);
    if (!body.trim()) throw new Error(`EAGLE returned an empty response for ${path}.`);
    return data;
  }

  function selectedContext() {
    return contexts.find((item) => item.apiKeyId === el('apiKey').value &&
      item.integration.id === el('integration').value) || null;
  }

  function filterValues(includeSearch = false) {
    const values = {
      days: el('period').value,
      state: el('stateFilter').value,
      city: el('cityFilter').value,
      service: el('serviceFilter').value,
      disposition: el('dispositionFilter').value,
      source: el('sourceFilter').value,
      campaign: el('campaignFilter').value,
    };
    if (includeSearch) values.search = el('leadSearch').value.trim();
    return values;
  }

  function params(extra = {}, includeSearch = false) {
    const context = selectedContext();
    const values = new URLSearchParams({
      apiKeyId: context?.apiKeyId || '', integrationId: context?.integration.id || '',
      snapshotId: snapshot?.id || '', ...filterValues(includeSearch), ...extra,
    });
    for (const [key, value] of [...values]) if (value == null || value === '') values.delete(key);
    return values.toString();
  }

  async function bootstrap() {
    const data = await api('/api/eagle/contexts');
    contexts = data.contexts || [];
    const keys = [...new Map(contexts.map((item) => [item.apiKeyId, item])).values()];
    el('apiKey').innerHTML = keys.map((item) =>
      `<option value="${escapeHtml(item.apiKeyId)}">${escapeHtml(item.apiKeyName)} (${escapeHtml(item.keyPrefix)})</option>`).join('');
    syncIntegrations();
    await loadMapAsset();
    await loadLatestSnapshot();
  }

  function syncIntegrations() {
    const available = contexts.filter((item) => item.apiKeyId === el('apiKey').value);
    el('integration').innerHTML = available.map((item) =>
      `<option value="${escapeHtml(item.integration.id)}">${escapeHtml(item.integration.name)} - ${escapeHtml(item.integration.locationId)}</option>`).join('');
  }

  async function loadLatestSnapshot() {
    stopPolling();
    stopCampaignPolling();
    snapshot = null;
    dashboard = null;
    demographics = null;
    campaignData = null;
    Object.keys(filterCatalog).forEach((key) => delete filterCatalog[key]);
    const context = selectedContext();
    if (!context) return renderEmpty('No readable CRM integration is assigned.');
    try {
      const data = await api('/api/eagle/snapshots/latest?' + new URLSearchParams({
        apiKeyId: context.apiKeyId, integrationId: context.integration.id,
      }));
      snapshot = data.snapshot;
      if (!snapshot) {
        renderEmpty('No CRM snapshot yet. Select Refresh from CRM.');
        if (activeView === 'validation') await loadValidation();
        return;
      }
      updateFreshness();
      await loadDashboard();
    } catch (error) { showAlert('error', error.message); renderEmpty(error.message); }
  }

  async function refreshCrm() {
    const context = selectedContext();
    if (!context) return;
    el('refreshCrm').disabled = true;
    showAlert('', '');
    try {
      const data = await api('/api/eagle/snapshots', {
        method:'POST', body:JSON.stringify({ apiKeyId:context.apiKeyId, integrationId:context.integration.id }),
      });
      snapshot = data.snapshot;
      showSync(snapshot);
      pollSnapshot();
    } catch (error) {
      el('refreshCrm').disabled = false;
      showAlert('error', error.message);
    }
  }

  function pollSnapshot() {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const data = await api('/api/eagle/snapshots/' + encodeURIComponent(snapshot.id) + '?' +
          new URLSearchParams({ apiKeyId:selectedContext().apiKeyId }));
        snapshot = data.snapshot;
        showSync(snapshot);
        if (!['queued','running'].includes(snapshot.status)) {
          stopPolling();
          el('refreshCrm').disabled = false;
          if (snapshot.status === 'failed') return showAlert('error', snapshot.errorSummary || 'CRM refresh failed');
          el('syncStatus').hidden = true;
          updateFreshness();
          showAlert(snapshot.status === 'partial' ? 'warning' : 'success',
            `${formatNumber(snapshot.totalContacts)} CRM contacts loaded.`);
          await loadDashboard();
        }
      } catch (error) {
        stopPolling(); el('refreshCrm').disabled = false; showAlert('error', error.message);
      }
    }, 1500);
  }

  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  function showSync(value) {
    el('syncStatus').hidden = false;
    el('syncText').textContent = `${value.status === 'queued' ? 'Queued' : 'Reading CRM'}: ${formatNumber(value.totalContacts)} contacts across ${formatNumber(value.pagesProcessed)} pages`;
    el('syncProgress').style.width = `${Math.max(8, Math.min(94, Number(value.pagesProcessed || 0) * 4))}%`;
  }

  async function loadDashboard() {
    if (!snapshot) return;
    try {
      const data = await api('/api/eagle/dashboard?' + params());
      dashboard = data;
      rollout = data.rollout || null;
      targets = data.targets || [];
      targetAssessments = data.targetAssessments || [];
      renderRollout();
      renderExecutiveBrief(data.executiveBrief || null);
      renderTargetBadges();
      renderSummary(data.summary || {}, data.geography || {});
      syncFilterOptions(data);
      renderMap();
      renderGeoRanking();
      renderFunnel(data.dispositions || []);
      renderTrend(data.trend || [], data.previousTrend || []);
      renderHistoricalFunnel(data.historicalFunnel || {});
      renderDrivers();
      renderMarkets();
      updateExport();
      if (activeView === 'overview') await loadOverviewAudience();
      if (activeView === 'leads') await loadLeads();
      if (activeView === 'demographics') await loadDemographics();
      if (activeView === 'campaigns') await loadCampaigns();
      if (activeView === 'validation') await loadValidation();
      if (activeView === 'targets') renderTargets();
    } catch (error) { showAlert('error', error.message); }
  }

  function renderSummary(value, geography) {
    const metrics = dashboard?.metrics || {};
    const leadMetric = metrics.new_leads;
    const scheduledMetric = metrics.current_scheduled;
    const scheduledRateMetric = metrics.current_scheduled_rate;
    const wonMetric = metrics.current_won;
    const wonRateMetric = metrics.current_won_rate;
    const unassignedMetric = metrics.actionable_unassigned;
    const sourceMetric = metrics.source_coverage;
    const campaignMetric = metrics.campaign_coverage;
    const dncMetric = metrics.dnc_blocked;
    const dncRateMetric = metrics.dnc_rate;
    const locationMetric = metrics.location_completeness;
    el('kpiTotal').textContent = formatMetricValue(leadMetric, value.total);
    el('kpiLeadLabel').textContent = dashboard?.period?.days ? 'New leads' : 'CRM contacts';
    el('kpiLeadDelta').textContent = formatMetricComparison(leadMetric);
    el('kpiScheduled').textContent = formatMetricValue(scheduledMetric, value.scheduled);
    el('kpiScheduledRate').textContent = formatSemanticRatio(scheduledRateMetric);
    el('kpiWon').textContent = formatMetricValue(wonMetric, value.won);
    el('kpiWonRate').textContent = formatSemanticRatio(wonRateMetric);
    el('kpiUnassigned').textContent = formatMetricValue(unassignedMetric, value.actionableUnassigned);
    el('kpiSourceCoverage').textContent = formatMetricValue(sourceMetric, value.sourceCoverage);
    el('kpiSourceRatio').textContent = formatMetricNumerator(sourceMetric);
    el('kpiDnc').textContent = formatMetricValue(dncMetric, value.dncBlocked);
    el('kpiDncRate').textContent = formatSemanticRatio(dncRateMetric, false);
    el('healthLocation').textContent = formatMetricValue(locationMetric, geography.dataCompleteness);
    el('healthCampaign').textContent = formatMetricValue(campaignMetric, value.campaignCoverage);
    el('geoCompleteness').textContent = `${geography.dataCompleteness || 0}%`;
    el('geoStateFootprint').textContent = formatPercentMetric(geography.statePopulationFootprint);
    el('geoStatePresence').textContent = `${formatNumber(geography.statesPresent)} of 50 states`;
    el('geoPlaceFootprint').textContent = formatPercentMetric(geography.placePopulationFootprint);
    el('geoPlacePresence').textContent = `${formatNumber(geography.matchedCensusPlaces)} of ${formatNumber(geography.reportedCities)} reported places matched`;
    el('geoLeadDensity').textContent = geography.leadsPer100k == null ? '-' : Number(geography.leadsPer100k).toLocaleString(undefined,{maximumFractionDigits:2});
    el('geoSubtitle').textContent = geography.referenceAvailable
      ? `${formatNumber(value.geocoded)} of ${formatNumber(value.total)} contacts have usable state data; ${geography.placeMatchRate || 0}% match an official Census place`
      : `${formatNumber(value.geocoded)} of ${formatNumber(value.total)} contacts have usable state data; load Census reference data for population metrics`;
    el('censusReference').textContent = geography.referenceAvailable
      ? `${geography.referenceYear} ACS 5-year / refreshed ${formatDate(geography.referenceFetchedAt)}`
      : 'Census reference not loaded';
    renderReportScope(value);
  }

  function renderReportScope(value) {
    const context = selectedContext();
    const filters = filterValues();
    const periodLabel = el('period').selectedOptions[0]?.textContent || 'All time';
    const active = [filters.state, filters.city, filters.service, filters.disposition, filters.source, filters.campaign].filter(Boolean);
    const asOf = dashboard?.period?.asOf;
    el('reportScope').textContent = [
      periodLabel,
      asOf ? `as of ${formatDateTime(asOf)}` : null,
      context?.integration?.name,
      ...active,
      `${formatNumber(value.total)} leads`,
    ].filter(Boolean).join(' · ');
  }

  function syncFilterOptions(data) {
    fillSelect('stateFilter', data.states.filter((row) => row.label !== 'NA').map((row) => row.label), 'All states');
    fillSelect('cityFilter', data.cities.filter((row) => row.city && row.city !== 'Unknown').map((row) => row.city), 'All cities');
    fillSelect('serviceFilter', data.services.filter((row)=>!row.isOther).map((row) => row.label), 'All services');
    fillSelect('dispositionFilter', data.dispositions.map((row) => row.label), 'All dispositions');
    fillSelect('sourceFilter', data.sources.filter((row)=>!row.isOther).map((row) => row.label), 'All sources');
    fillSelect('campaignFilter', data.campaigns.filter((row)=>!row.isOther).map((row) => row.label), 'All campaigns');
  }

  function fillSelect(id, values, first) {
    const select = el(id); const previous = select.value;
    filterCatalog[id] = new Set([...(filterCatalog[id] || []), ...values]);
    const unique = [...filterCatalog[id]].sort((a,b) => String(a).localeCompare(String(b)));
    select.innerHTML = `<option value="">${first}</option>` + unique.map((value) =>
      `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    if (unique.includes(previous)) select.value = previous;
  }

  async function loadMapAsset() {
    const response = await fetch('/data/us-states-albers-10m.json');
    if (!response.ok) { mapFeatures=[]; return; }
    const body = await response.text();
    if (!body.trim()) { mapFeatures=[]; return; }
    try {
      const topology = JSON.parse(body);
      mapFeatures = topojson.feature(topology, topology.objects.states).features;
    } catch {
      mapFeatures=[];
      console.warn('EAGLE map asset is unavailable or invalid.');
    }
  }

  function renderMap() {
    if (!mapFeatures || !dashboard) return;
    const values = new Map(dashboard.states.map((row) => [row.label, Number(row.total)]));
    const max = d3.max([...values.values()]) || 1;
    const color = d3.scaleSequential().domain([0, max]).interpolator(d3.interpolateRgb('#e2e7e4', '#197a55'));
    const svg = d3.select('#eagleMap'); svg.selectAll('*').remove();
    const tooltip = el('mapTooltip');
    svg.append('g').selectAll('path').data(mapFeatures).join('path')
      .attr('class', (feature) => `eagle-state ${el('stateFilter').value === FIPS[String(feature.id).padStart(2,'0')] ? 'active' : ''}`)
      .attr('d', d3.geoPath())
      .attr('fill', (feature) => { const state = FIPS[String(feature.id).padStart(2,'0')]; const total = values.get(state) || 0; return total ? color(total) : '#e2e7e4'; })
      .on('mousemove', function (event, feature) {
        const state = FIPS[String(feature.id).padStart(2,'0')] || 'Unknown';
        const row = dashboard.states.find((item) => item.label === state);
        tooltip.hidden = false; tooltip.innerHTML = `<strong>${state}</strong><br>${formatNumber(values.get(state) || 0)} contacts${row?.population ? `<br>${formatNumber(row.population)} residents<br>${row.leadsPer100k} per 100k` : ''}`;
        const wrap = el('eagleMap').parentElement.getBoundingClientRect();
        tooltip.style.left = `${event.clientX - wrap.left + 12}px`; tooltip.style.top = `${event.clientY - wrap.top + 12}px`;
      })
      .on('mouseleave', () => { tooltip.hidden = true; })
      .on('click', (event, feature) => selectState(FIPS[String(feature.id).padStart(2,'0')] || ''));
  }

  function renderGeoRanking() {
    if (!dashboard) return;
    const rows = geoView === 'states' ? dashboard.states.filter((row) => row.label !== 'NA') : dashboard.cities;
    el('geoRanking').innerHTML = rows.length ? rows.slice(0,30).map((row,index) => {
      const label = geoView === 'states' ? row.label : `${row.city}, ${row.state}`;
      const metric = row.leadsPer100k == null ? `${formatNumber(row.total)} contacts` : `${formatNumber(row.total)} / ${row.leadsPer100k} per 100k`;
      return `<div class="eagle-rank" data-geo-value="${escapeHtml(geoView === 'states' ? row.label : row.city)}" data-geo-state="${escapeHtml(row.state || '')}"><em>${index + 1}</em><strong>${escapeHtml(label)}</strong><span>${metric}</span></div>`;
    }).join('') : '<p class="muted">No geographic data in this view.</p>';
    document.querySelectorAll('[data-geo-value]').forEach((row) => row.onclick = () => {
      if (geoView === 'states') selectState(row.dataset.geoValue);
      else { el('stateFilter').value = row.dataset.geoState; el('cityFilter').value = row.dataset.geoValue; applyFilters(); }
    });
  }

  function selectState(state) {
    el('stateFilter').value = el('stateFilter').value === state ? '' : state;
    el('cityFilter').value = '';
    applyFilters();
  }

  function renderFunnel(rows) {
    const max = Math.max(...rows.map((row) => Number(row.total)), 1);
    el('funnelBars').innerHTML = rows.length ? rows.map((row) =>
      `<button type="button" class="eagle-bar" data-disposition-drill="${escapeHtml(row.label)}" aria-label="Open ${escapeHtml(row.label)} lead detail: ${formatNumber(row.total)} contacts, ${formatPercentMetric(row.share)}"><span>${escapeHtml(row.label)}</span><span class="eagle-bar-track"><i style="width:${Math.max(2,Number(row.total)/max*100)}%"></i></span><strong>${formatNumber(row.total)} <small>${formatPercentMetric(row.share)}</small></strong></button>`).join('') : '<p class="muted">No disposition data.</p>';
    document.querySelectorAll('[data-disposition-drill]').forEach((button) => {
      button.onclick = () => drillToLeadDetail({ disposition:button.dataset.dispositionDrill });
    });
    renderReconciliation('dispositionReconciliation', dashboard?.breakdowns?.dispositions?.reconciliation);
  }

  function renderTrend(rows, previousRows) {
    const svg = d3.select('#trendChart'); svg.selectAll('*').remove();
    if (!rows.length) return svg.append('text').attr('x',380).attr('y',130).attr('text-anchor','middle').attr('fill','#66716b').text('No dated CRM leads in this view');
    const current = rows.map((row) => ({ date:new Date(`${String(row.date).slice(0,10)}T00:00:00`), total:Number(row.total) }));
    const previous = previousRows.map((row) => ({ date:new Date(`${String(row.date).slice(0,10)}T00:00:00`), total:Number(row.total) }));
    const days = Number(dashboard?.period?.days) || null;
    let data;
    if (days && dashboard.period.periodStart && dashboard.period.previousPeriodStart) {
      const start = new Date(`${String(dashboard.period.periodStart).slice(0,10)}T00:00:00`);
      const previousStart = new Date(`${String(dashboard.period.previousPeriodStart).slice(0,10)}T00:00:00`);
      const currentByIndex = new Map(current.map((row)=>[Math.round((row.date-start)/86400000),row.total]));
      const previousByIndex = new Map(previous.map((row)=>[Math.round((row.date-previousStart)/86400000),row.total]));
      data = Array.from({length:days+1}, (_, index) => ({
        index, date:new Date(start.getTime()+index*86400000), current:currentByIndex.get(index)||0, previous:previousByIndex.get(index)||0,
      }));
    } else {
      data = current.map((row,index)=>({index,date:row.date,current:row.total,previous:0}));
    }
    const margin = {top:16,right:16,bottom:34,left:42}, width = 760-margin.left-margin.right, height=260-margin.top-margin.bottom;
    const x=d3.scaleBand().domain(data.map((d)=>d.index)).range([0,width]).padding(.18);
    const y=d3.scaleLinear().domain([0,d3.max(data,(d)=>Math.max(d.current,d.previous))||1]).nice().range([height,0]);
    const g=svg.append('g').attr('transform',`translate(${margin.left},${margin.top})`);
    const tickEvery = Math.max(1, Math.ceil(data.length / 6));
    g.append('g').attr('class','eagle-axis').attr('transform',`translate(0,${height})`).call(d3.axisBottom(x).tickValues(data.filter((d)=>d.date&&d.index%tickEvery===0).map((d)=>d.index)).tickFormat((index)=>d3.timeFormat('%b %d')(data[index].date)));
    g.append('g').attr('class','eagle-axis').call(d3.axisLeft(y).ticks(5));
    g.selectAll('.eagle-prior-bar').data(data).join('rect').attr('class','eagle-prior-bar')
      .attr('x',(d)=>x(d.index)).attr('y',(d)=>y(d.previous)).attr('width',x.bandwidth()).attr('height',(d)=>height-y(d.previous)).attr('fill','#d7dfdb')
      .attr('tabindex',0).attr('role','img').attr('aria-label',(d)=>`${d3.timeFormat('%B %d, %Y')(d.date)}: ${formatNumber(d.previous)} prior-period leads`)
      .append('title').text((d)=>`${d3.timeFormat('%b %d, %Y')(d.date)} · Prior period: ${formatNumber(d.previous)} leads`);
    g.selectAll('.eagle-current-bar').data(data).join('rect').attr('class','eagle-current-bar')
      .attr('x',(d)=>x(d.index)+x.bandwidth()*.2).attr('y',(d)=>y(d.current)).attr('width',x.bandwidth()*.6).attr('height',(d)=>height-y(d.current)).attr('fill','#176b4b')
      .attr('tabindex',0).attr('role','img').attr('aria-label',(d)=>`${d3.timeFormat('%B %d, %Y')(d.date)}: ${formatNumber(d.current)} selected-period leads`)
      .append('title').text((d)=>`${d3.timeFormat('%b %d, %Y')(d.date)} · Selected period: ${formatNumber(d.current)} leads`);
  }

  function renderHistoricalFunnel(funnel) {
    const metrics = funnel.metrics || {};
    const appointmentMetric = metrics.lead_to_appointment_rate;
    const winMetric = metrics.lead_to_win_rate;
    const closeMetric = metrics.appointment_to_win_rate;
    el('cohortMaturity').textContent = `${formatNumber(funnel.maturityDays)}-day maturity window · cutoff ${formatDate(funnel.maturityCutoff)} · ${formatNumber(funnel.scopedLeads)} scoped leads`;
    el('cohortEligible').textContent = formatNumber(funnel.matureLeads);
    el('cohortExcluded').textContent = `${formatNumber(funnel.immatureLeads)} immature or undated`;
    el('cohortAppointed').textContent = appointmentMetric?.status === 'available' ? formatNumber(funnel.appointedLeads) : '—';
    el('cohortAppointmentRate').textContent = appointmentMetric?.status === 'available' ? formatPercentMetric(appointmentMetric.value) : 'Unavailable';
    el('cohortWon').textContent = winMetric?.status === 'available' ? formatNumber(funnel.wonLeads) : '—';
    el('cohortWinRate').textContent = winMetric?.status === 'available' ? formatPercentMetric(winMetric.value) : 'Awaiting complete opportunity data';
    renderHistoricalMetric('historicalAppointmentRate','historicalAppointmentMeta',appointmentMetric);
    renderHistoricalMetric('historicalWinRate','historicalWinMeta',winMetric);
    renderHistoricalMetric('historicalCloseRate','historicalCloseMeta',closeMetric);
    renderEventSource('appointmentSourceStatus','Appointments',funnel.sources?.appointments);
    renderEventSource('opportunitySourceStatus','Opportunities',funnel.sources?.opportunities);
    el('cohortWonStage').classList.toggle('unavailable',winMetric?.status !== 'available');
    renderOutcomeTrend(funnel.trend || [], winMetric?.status === 'available');
  }

  function renderHistoricalMetric(valueId,metaId,metric) {
    const available = metric?.status === 'available';
    el(valueId).textContent = available ? formatPercentMetric(metric.value) : '—';
    el(metaId).textContent = available
      ? `${formatNumber(metric.numerator)} / ${formatNumber(metric.denominator)}${metric.comparison ? ` · ${metric.comparison.value>0?'+':''}${metric.comparison.value} pts` : ''}`
      : (metric?.statusReason || 'Authoritative evidence is unavailable.');
    el(valueId).parentElement.classList.toggle('unavailable',!available);
  }

  function renderEventSource(id,label,source) {
    const target=el(id); const status=source?.status || 'unavailable';
    target.className=`eagle-source-status ${status}`;
    target.textContent=`${label}: ${status}`;
    target.title=source?.reason || source?.source || '';
  }

  function renderOutcomeTrend(rows,showWins) {
    const svg=d3.select('#outcomeTrendChart'); svg.selectAll('*').remove();
    if(!rows.length){svg.append('text').attr('x',380).attr('y',130).attr('text-anchor','middle').attr('fill','#66716b').text('No authoritative outcome events in this period');return;}
    const data=rows.map((row)=>({date:new Date(`${String(row.date).slice(0,10)}T00:00:00`),appointments:Number(row.appointments)||0,wins:showWins?Number(row.wins)||0:0}));
    const margin={top:18,right:18,bottom:34,left:42},width=760-margin.left-margin.right,height=260-margin.top-margin.bottom;
    const x=d3.scaleBand().domain(data.map((row)=>String(row.date.getTime()))).range([0,width]).padding(.22);
    const y=d3.scaleLinear().domain([0,d3.max(data,(row)=>Math.max(row.appointments,row.wins))||1]).nice().range([height,0]);
    const g=svg.append('g').attr('transform',`translate(${margin.left},${margin.top})`);
    g.append('g').attr('class','eagle-axis').attr('transform',`translate(0,${height})`).call(d3.axisBottom(x).tickValues(data.filter((row,index)=>index%Math.max(1,Math.ceil(data.length/6))===0).map((row)=>String(row.date.getTime()))).tickFormat((value)=>d3.timeFormat('%b %d')(new Date(Number(value)))));
    g.append('g').attr('class','eagle-axis').call(d3.axisLeft(y).ticks(5));
    const barWidth=showWins?x.bandwidth()/2:x.bandwidth();
    g.selectAll('.eagle-appointment-event').data(data).join('rect').attr('class','eagle-appointment-event').attr('x',(row)=>x(String(row.date.getTime()))).attr('y',(row)=>y(row.appointments)).attr('width',barWidth).attr('height',(row)=>height-y(row.appointments)).attr('fill','#176b4b')
      .attr('tabindex',0).attr('role','img').attr('aria-label',(row)=>`${d3.timeFormat('%B %d, %Y')(row.date)}: ${formatNumber(row.appointments)} appointments`)
      .append('title').text((row)=>`${d3.timeFormat('%b %d, %Y')(row.date)} · Appointments: ${formatNumber(row.appointments)}`);
    if(showWins)g.selectAll('.eagle-win-event').data(data).join('rect').attr('class','eagle-win-event').attr('x',(row)=>x(String(row.date.getTime()))+barWidth).attr('y',(row)=>y(row.wins)).attr('width',barWidth).attr('height',(row)=>height-y(row.wins)).attr('fill','#315f83')
      .attr('tabindex',0).attr('role','img').attr('aria-label',(row)=>`${d3.timeFormat('%B %d, %Y')(row.date)}: ${formatNumber(row.wins)} wins`)
      .append('title').text((row)=>`${d3.timeFormat('%b %d, %Y')(row.date)} · Wins: ${formatNumber(row.wins)}`);
  }

  function renderDrivers() {
    if (!dashboard) return;
    const dimension = el('driverDimension').value;
    const labels = { sources:'Source', campaigns:'Campaign', services:'Service', cities:'Market' };
    const breakdown = dashboard.breakdowns?.[dimension];
    const rows = breakdown?.rows || dashboard[dimension] || [];
    el('driverHeading').textContent = labels[dimension];
    el('driverRows').innerHTML = rows.length ? rows.slice(0,20).map((row) => {
      const label = row.label || (dimension === 'cities' ? `${row.city}, ${row.state}` : 'Unknown');
      const unknown = Boolean(row.unknownReason) || ['Unattributed','Unknown','NA','Unknown, NA'].includes(String(label));
      const filterValue = dimension === 'cities' ? row.city : row.label;
      const drill = !unknown && filterValue ? `<button type="button" class="eagle-table-drill" data-driver-drill="${escapeHtml(dimension)}" data-driver-value="${escapeHtml(filterValue)}" title="Open leads filtered to ${escapeHtml(label)}">${escapeHtml(label)}<span aria-hidden="true">→</span></button>` : `<strong>${escapeHtml(label)}</strong>`;
      return `<tr class="${unknown?'eagle-unknown-row':''}"><td>${drill}${unknown?`<small>Data quality: ${escapeHtml(row.unknownReason || 'unknown')}</small>`:''}</td><td>${formatNumber(row.total)}</td><td>${formatPercentMetric(row.share)}</td><td>${formatNumber(row.scheduled)} / ${formatNumber(row.total)} = ${formatPercentMetric(row.scheduledRate)}</td><td>${formatNumber(row.won)} / ${formatNumber(row.total)} = ${formatPercentMetric(row.wonRate)}</td><td><span class="eagle-sample-note">${escapeHtml(row.sample?.label || 'Not classified')}</span></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="eagle-empty">No driver data in this view.</td></tr>';
    document.querySelectorAll('[data-driver-drill]').forEach((button) => {
      button.onclick = () => drillDriver(button.dataset.driverDrill,button.dataset.driverValue);
    });
    renderReconciliation('driverReconciliation', breakdown?.reconciliation);
  }

  function renderMarkets() {
    if (!dashboard) return;
    const breakdown = dashboard.breakdowns?.cities;
    const rows = (breakdown?.rows || dashboard.cities || []).filter((row)=>row.city !== 'Unknown'&&!row.isOther).slice(0,8);
    el('marketRows').innerHTML = rows.length ? rows.map((row)=>{
      const density = row.leadsPer100k == null ? '—' : `${Number(row.leadsPer100k).toLocaleString(undefined,{maximumFractionDigits:2})} / 100k`;
      return `<tr><td><button type="button" class="eagle-table-drill" data-market-drill="${escapeHtml(row.city)}" data-market-state="${escapeHtml(row.state)}" title="Open market analytics for ${escapeHtml(row.city)}, ${escapeHtml(row.state)}">${escapeHtml(row.city)}, ${escapeHtml(row.state)}<span aria-hidden="true">→</span></button></td><td>${formatNumber(row.total)}</td><td>${formatPercentMetric(row.share)}</td><td>${formatPercentMetric(row.scheduledRate)}</td><td>${formatPercentMetric(row.wonRate)}</td><td>${density}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="eagle-empty">No city-level location data.</td></tr>';
    document.querySelectorAll('[data-market-drill]').forEach((button) => {
      button.onclick = () => drillMarket(button.dataset.marketDrill,button.dataset.marketState);
    });
    renderReconciliation('marketReconciliation', breakdown?.reconciliation);
  }

  async function loadDemographics() {
    if (!snapshot) return;
    const data = await api('/api/eagle/demographics?' + params());
    demographics = data;
    renderDemographics(data);
    renderOverviewAudience(data);
  }

  async function loadOverviewAudience() {
    if (!snapshot) return;
    try {
      const data=await api('/api/eagle/demographics?' + params());
      demographics=data;
      renderOverviewAudience(data);
    } catch (error) {
      el('overviewAudienceSubtitle').textContent='Audience signals are temporarily unavailable';
      el('overviewAudience').innerHTML='<div class="eagle-overview-audience-empty">Open Demographics to inspect audience coverage.</div>';
    }
  }

  function renderOverviewAudience(data) {
    const executive=data?.executive||{};
    const summary=data?.summary||{};
    const spotlights=(executive.spotlights||[]).slice(0,4);
    el('overviewAudienceSubtitle').textContent=`${formatNumber(executive.profilesWithInsight||0)} insight-ready profiles · ${executive.confidenceLabel||'Limited sample'}`;
    const cards=spotlights.map((item)=>`<button type="button" class="eagle-audience-mini" data-overview-audience="${escapeHtml(item.key)}" title="Open ${escapeHtml(item.title)} distribution"><span>${escapeHtml(item.title)}</span><strong>${escapeHtml(formatDemographicExecutiveValue(item))}</strong><small>${escapeHtml(item.supportingText)}</small><em aria-hidden="true">Explore →</em></button>`).join('');
    const coverage=`<div class="eagle-audience-activation"><div class="eagle-audience-mini-ring" style="--coverage:${Math.min(100,Number(executive.insightCoverage)||0)}"><strong>${executive.insightCoverage||0}%</strong></div><p><strong>${formatNumber(executive.profilesWithInsight||0)} profiles</strong><span>${formatNumber(summary.populatedValues||0)} governed data points</span></p></div>`;
    el('overviewAudience').innerHTML=cards?cards+coverage:'<div class="eagle-overview-audience-empty">Decision-useful audience signals are not populated for this scope.</div>';
    document.querySelectorAll('[data-overview-audience]').forEach((button) => {
      button.onclick = async () => { await setView('demographics'); openDemographicField(button.dataset.overviewAudience); };
    });
  }

  function renderDemographics(data) {
    const summary = data.summary || {};
    const executive = data.executive || {};
    el('demoProfiles').textContent = formatNumber(summary.totalProfiles);
    el('demoFields').textContent = formatNumber(summary.fieldsWithData);
    el('demoValues').textContent = formatNumber(summary.populatedValues);
    el('demographicSubtitle').textContent = `${formatNumber(executive.profilesWithInsight || 0)} of ${formatNumber(summary.totalProfiles)} matching profiles contain decision-useful audience signals`;
    el('demographicHeroHeadline').textContent = executive.headline || 'Decision-useful audience signals are not yet available.';
    el('demographicHeroConfidence').textContent = `${executive.confidenceLabel || 'Limited audience sample'} · ${formatNumber(executive.profilesWithInsight)} insight-ready profiles`;
    el('demographicInsightCoverage').textContent = `${executive.insightCoverage || 0}%`;
    el('demographicInsightProfiles').textContent = `${formatNumber(executive.profilesWithInsight)} profiles`;
    el('demographicInsightRing').style.setProperty('--coverage',Math.min(100,Number(executive.insightCoverage)||0));
    el('demographicSignalConfidence').textContent = executive.confidenceLabel || 'Limited audience sample';
    renderDemographicSpotlights(executive.spotlights || []);
    renderDemographicComposition(executive.composition || []);
    renderDemographicReadiness(executive.domainReadiness || [],executive.coverageGaps || []);
    const categorySelect = el('demographicCategoryFilter');
    const previousCategory = categorySelect.value;
    const categoryNames = (data.categories || []).map((item) => item.category);
    categorySelect.innerHTML = '<option value="">All categories</option>' + categoryNames.map((name) =>
      `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    if (categoryNames.includes(previousCategory)) categorySelect.value = previousCategory;
    renderDemographicCategories();
    syncDemographicFields();
  }

  function renderDemographicSpotlights(rows) {
    const icons={Property:'H',Financial:'$',Household:'P',Profile:'A','Custom fields':'+'};
    el('demographicSpotlights').innerHTML=rows.length?rows.slice(0,6).map((item)=>`<button type="button" class="eagle-demographic-spotlight" data-demographic-spotlight="${escapeHtml(item.key)}"><i>${escapeHtml(icons[item.category]||'•')}</i><span>${escapeHtml(item.title)}</span><strong>${escapeHtml(formatDemographicExecutiveValue(item))}</strong><small>${escapeHtml(item.supportingText)}</small><em class="${escapeHtml(item.confidence)}">${escapeHtml(item.confidence)} sample · ${item.coverage}% coverage</em></button>`).join(''):'<div class="eagle-demographic-empty">No high-signal demographic fields are populated in this scope.</div>';
    document.querySelectorAll('[data-demographic-spotlight]').forEach((button)=>button.onclick=()=>openDemographicField(button.dataset.demographicSpotlight));
  }

  function renderDemographicComposition(rows) {
    el('demographicComposition').innerHTML=rows.length?rows.map((item)=>{
      const distribution=(item.distribution||[]).slice(0,5);
      const colors=['green','blue','amber','slate','pale'];
      return `<article class="eagle-composition-card"><div class="eagle-composition-head"><div><span>${escapeHtml(item.title)}</span><strong>${escapeHtml(formatDemographicExecutiveValue(item))}</strong></div><small>${formatNumber(item.sampleSize)} profiles</small></div><div class="eagle-composition-stack">${distribution.map((row,index)=>`<button type="button" class="${colors[index]}" style="width:${Math.max(1,Number(row.share)||0)}%" data-demographic-segment-field="${escapeHtml(item.key)}" data-demographic-segment="${escapeHtml(row.label)}" title="Open ${escapeHtml(row.label)} contacts (${formatNumber(row.count)})"></button>`).join('')}</div><div class="eagle-composition-rows">${distribution.map((row,index)=>`<button type="button" data-demographic-segment-field="${escapeHtml(item.key)}" data-demographic-segment="${escapeHtml(row.label)}"><i class="${colors[index]}"></i><span>${escapeHtml(row.label)}</span><strong>${row.share}%</strong><small>${formatNumber(row.count)}</small></button>`).join('')}</div></article>`;
    }).join(''):'<div class="eagle-demographic-empty">Categorical composition is unavailable for this filtered audience.</div>';
    document.querySelectorAll('[data-demographic-segment-field]').forEach((button)=>button.onclick=()=>openDemographicContacts(button.dataset.demographicSegmentField,button.dataset.demographicSegment));
  }

  function renderDemographicReadiness(domains,gaps) {
    el('demographicDomainReadiness').innerHTML=domains.length?domains.map((item)=>`<div class="eagle-domain-readiness-row"><div><span>${escapeHtml(item.category)}</span><strong>${item.coverage}%</strong></div><div class="eagle-domain-readiness-track"><i class="${escapeHtml(item.status)}" style="width:${Math.min(100,Number(item.coverage)||0)}%"></i></div><small>${formatNumber(item.populatedProfiles)} profiles · ${escapeHtml(item.status)} coverage</small></div>`).join(''):'<div class="eagle-demographic-empty">No domain coverage is available.</div>';
    el('demographicCoverageGaps').innerHTML=gaps.length?gaps.map((item,index)=>`<div><em>${index+1}</em><p><strong>${escapeHtml(item.category)}</strong><span>${item.coverage}% coverage · ${formatNumber(item.populatedProfiles)} profiles</span></p></div>`).join(''):'<p class="eagle-gap-clear">Every audience domain has at least 50% coverage.</p>';
  }

  function formatDemographicExecutiveValue(item) {
    if(item.displayValue==null)return '—';
    if(item.kind==='numeric'&&item.format==='currency')return Number(item.displayValue).toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0});
    if(item.kind==='numeric')return Number(item.displayValue).toLocaleString(undefined,{maximumFractionDigits:1});
    return String(item.displayValue);
  }

  function openDemographicField(key) {
    el('demographicField').value=key;el('demographicWorkbench').open=true;renderDemographicField();
    el('demographicWorkbench').scrollIntoView({behavior:'smooth',block:'start'});
  }

  function renderDemographicCategories() {
    if (!demographics) return;
    const selected = el('demographicCategoryFilter').value;
    const query = String(el('demographicFieldSearch')?.value || '').trim().toLowerCase();
    const categories = (demographics.categories || []).map((category) => ({
      ...category,
      fields:(category.fields || []).filter((field) => !query || `${field.label} ${field.category} ${field.key}`.toLowerCase().includes(query)),
    })).filter((item) => (!selected || item.category === selected) && item.fields.length);
    const visibleFields = categories.reduce((count, category) => count + category.fields.length, 0);
    el('demographicInventoryMeta').textContent = query
      ? `${formatNumber(visibleFields)} matching fields for “${query}”`
      : `${formatNumber((demographics.fields || []).filter((field) => field.populated > 0).length)} populated fields ready to explore`;
    el('demographicCategories').innerHTML = categories.length ? categories.map((category) => {
      const fields = category.fields;
      return `<article class="eagle-demographic-domain">
        <div class="eagle-demographic-domain-head"><h3>${escapeHtml(category.category)}</h3><span>${category.coverage}% / ${formatNumber(category.populatedProfiles)} profiles</span></div>
        <div class="eagle-demographic-domain-meter"><i style="width:${Math.min(100,Number(category.coverage)||0)}%"></i></div>
        <div class="eagle-demographic-field-list">${fields.map((field) => `<button type="button" class="eagle-demographic-field-row" data-demographic-field="${escapeHtml(field.key)}"><strong>${escapeHtml(field.label)}</strong><span>${field.coverage}%</span></button>`).join('')}</div>
      </article>`;
    }).join('') : '<p class="muted">No demographic domains match this selection.</p>';
    document.querySelectorAll('[data-demographic-field]').forEach((button) => {
      button.onclick = () => { el('demographicField').value = button.dataset.demographicField; renderDemographicField(); };
    });
  }

  function syncDemographicFields() {
    const select = el('demographicField');
    const previous = select.value;
    const fields = (demographics?.fields || []).filter((field) => field.populated > 0);
    select.innerHTML = '<option value="">Select field</option>' + fields.map((field) =>
      `<option value="${escapeHtml(field.key)}">${escapeHtml(field.category)} / ${escapeHtml(field.label)}</option>`).join('');
    const recommended=fields.find((field)=>!field.sensitive&&(field.numeric||(field.topValues||[]).length));
    select.value = fields.some((field) => field.key === previous) ? previous : (recommended?.key || fields[0]?.key || '');
    renderDemographicField();
  }

  function renderDemographicField() {
    const field = (demographics?.fields || []).find((item) => item.key === el('demographicField').value);
    const distribution = el('demographicDistribution');
    const numeric = el('demographicNumeric');
    el('demographicContacts').hidden = true;
    if (!field) {
      el('demographicFieldTitle').textContent = 'Field explorer';
      el('demographicFieldMeta').textContent = 'Select a field to inspect its coverage and distribution';
      el('demographicFieldSummary').innerHTML = '';
      numeric.hidden = true;
      distribution.innerHTML = '<div class="eagle-demographic-private">No field selected.</div>';
      return;
    }
    el('demographicFieldMeta').textContent = `${field.label} · ${field.category} · ${formatNumber(field.populated)} populated profiles · ${field.coverage}% coverage`;
    el('demographicFieldTitle').textContent = field.label;
    const confidence = field.populated >= 30 ? 'Established sample' : field.populated >= 10 ? 'Directional sample' : 'Limited sample';
    const kind = field.numeric ? 'Numeric distribution' : field.sensitive ? 'Coverage-only field' : 'Categorical distribution';
    const unique = field.sensitive ? 'Values protected' : `${formatNumber(field.uniqueValues)} observed values`;
    el('demographicFieldSummary').innerHTML = [
      ['Audience coverage',`${field.coverage}%`,`${formatNumber(field.populated)} of ${formatNumber(demographics?.summary?.totalProfiles)} profiles`],
      ['Confidence',confidence,field.populated >= 30 ? 'Reliable directional read' : 'Use with appropriate sample caution'],
      ['Lens',kind,unique],
    ].map(([label,value,note]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`).join('');
    if (field.numeric) {
      numeric.hidden = false;
      numeric.innerHTML = [['Samples',field.numeric.count],['Median',field.numeric.median],['Average',field.numeric.average],['Minimum',field.numeric.minimum],['Maximum',field.numeric.maximum]]
        .map(([label,value]) => `<div><span>${label}</span><strong>${formatMetric(value,field)}</strong></div>`).join('');
    } else numeric.hidden = true;
    if (field.sensitive) {
      distribution.innerHTML = '<div class="eagle-demographic-private">Individual values are suppressed. Coverage remains available for profile completeness.</div>';
      return;
    }
    const rows = field.topValues || [];
    const max = Math.max(...rows.map((item) => Number(item.count)),1);
    distribution.innerHTML = rows.length ? rows.map((item) => `<button type="button" class="eagle-distribution-row" data-demographic-segment-field="${escapeHtml(field.key)}" data-demographic-segment="${escapeHtml(item.label)}" title="Open ${escapeHtml(item.label)} contacts (${formatNumber(item.count)})"><span title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span><div class="eagle-distribution-track"><i style="width:${Math.max(2,Number(item.count)/max*100)}%"></i></div><strong>${formatNumber(item.count)} / ${item.share}%</strong><em>View contacts →</em></button>`).join('') : '<div class="eagle-demographic-private">No categorical distribution is available for this field.</div>';
    document.querySelectorAll('[data-demographic-segment-field]').forEach((button)=>button.onclick=()=>openDemographicContacts(button.dataset.demographicSegmentField,button.dataset.demographicSegment));
  }

  async function openDemographicContacts(field,segment) {
    const panel=el('demographicContacts');
    el('demographicField').value=field;
    el('demographicWorkbench').open=true;
    renderDemographicField();
    panel.hidden=false;
    panel.innerHTML=`<div class="eagle-demographic-contacts-head"><div><span>Matching contacts</span><h3>${escapeHtml(segment)}</h3><p>Loading the contacts whose ${escapeHtml((demographics?.fields || []).find((item)=>item.key===field)?.label || 'selected field')} value is ${escapeHtml(segment)}.</p></div><button type="button" class="eagle-card-link" data-close-demographic-contacts>Close</button></div><div class="eagle-demographic-contact-loading">Loading CRM contacts…</div>`;
    panel.querySelector('[data-close-demographic-contacts]').onclick=()=>{panel.hidden=true;};
    panel.scrollIntoView({behavior:'smooth',block:'center'});
    try {
      const data=await api('/api/eagle/demographics/contacts?'+params({field,segment,limit:50}));
      const rows=data.rows || [];
      panel.innerHTML=`<div class="eagle-demographic-contacts-head"><div><span>Matching contacts</span><h3>${escapeHtml(data.segment)}</h3><p>${formatNumber(data.total)} contacts match this exact ${escapeHtml(data.field.label)} segment in the current EAGLE scope.</p></div><button type="button" class="eagle-card-link" data-close-demographic-contacts>Close</button></div><div class="eagle-demographic-contact-tools"><small>Review the evidence, then open any contact directly in CRM.</small><input type="search" data-demographic-contact-search placeholder="Find a contact in this segment" aria-label="Find a contact in this segment"></div><div class="eagle-demographic-contact-table"><table><thead><tr><th>Contact</th><th>Proof value</th><th>Market</th><th>Lead status</th><th>Owner</th><th></th></tr></thead><tbody>${rows.length?rows.map((row)=>`<tr data-demographic-contact-row data-search="${escapeHtml([row.name,row.email,row.phone,row.city,row.state,row.disposition,row.crmOwner,row.dialOwner].filter(Boolean).join(' ').toLowerCase())}"><td><strong>${escapeHtml(row.name || row.contactId)}</strong><small>${escapeHtml(row.email || row.phone || row.contactId)}</small></td><td><span class="eagle-demographic-proof">${escapeHtml(row.demographicValue)}</span></td><td>${escapeHtml([row.city,row.state].filter(Boolean).join(', ') || 'Unknown')}</td><td>${escapeHtml(row.disposition || 'New / Unworked')}</td><td>${escapeHtml(row.crmOwner || row.dialOwner || 'Unassigned')}</td><td>${row.crmUrl?`<a class="eagle-contact-link" href="${escapeHtml(row.crmUrl)}" target="_blank" rel="noopener noreferrer">Open contact →</a>`:'<span class="eagle-cell-sub">Unavailable</span>'}</td></tr>`).join(''):'<tr><td colspan="6" class="eagle-empty">No contacts match this segment within the current filters.</td></tr>'}</tbody></table></div>`;
      panel.querySelector('[data-close-demographic-contacts]').onclick=()=>{panel.hidden=true;};
      const contactSearch=panel.querySelector('[data-demographic-contact-search]');
      if(contactSearch)contactSearch.oninput=()=>{const term=contactSearch.value.trim().toLowerCase();panel.querySelectorAll('[data-demographic-contact-row]').forEach((row)=>{row.hidden=Boolean(term)&&!row.dataset.search.includes(term);});};
    } catch(error) { panel.innerHTML=`<div class="eagle-demographic-contact-error">${escapeHtml(error.message)}</div>`; }
  }

  function formatMetric(value, field) {
    if (value == null) return '-';
    return /income|worth/i.test(field.key) ? Number(value).toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}) : Number(value).toLocaleString();
  }

  function setSelectValue(id,value) {
    const select=el(id);
    const option=[...select.options].find((item)=>item.value===value);
    if(!option)return false;
    select.value=value;
    return true;
  }

  async function drillToLeadDetail({ disposition, filterId, filterValue }={}) {
    if(disposition)setSelectValue('dispositionFilter',disposition);
    if(filterId&&filterValue)setSelectValue(filterId,filterValue);
    leadOffset=0;
    updateFilterState();
    await loadDashboard();
    await setView('leads');
  }

  async function drillKpi(card) {
    if(card.dataset.kpiDrill==='drivers'){
      el('driverDimension').value=card.dataset.kpiDimension||'sources';
      renderDrivers();
      el('view-overview').hidden=false;
      document.querySelector('.eagle-overview-drivers').scrollIntoView({behavior:'smooth',block:'start'});
      return;
    }
    await drillToLeadDetail({disposition:card.dataset.kpiDisposition});
  }

  async function drillDriver(dimension,value) {
    const filterIds={sources:'sourceFilter',campaigns:'campaignFilter',services:'serviceFilter',cities:'cityFilter'};
    await drillToLeadDetail({filterId:filterIds[dimension],filterValue:value});
  }

  async function drillMarket(city,state) {
    setSelectValue('stateFilter',state);
    setSelectValue('cityFilter',city);
    leadOffset=0;
    updateFilterState();
    await loadDashboard();
    await setView('markets');
  }

  async function setView(view) {
    activeView = view;
    [...document.body.classList].filter((name)=>name.startsWith('eagle-view-')).forEach((name)=>document.body.classList.remove(name));
    document.body.classList.add(`eagle-view-${view}`);
    document.querySelectorAll('[data-eagle-view]').forEach((button) => {
      const active=button.dataset.eagleView === view;
      button.classList.toggle('active',active);
      if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('.eagle-view-panel').forEach((panel) => {
      const active = panel.id === `view-${view}`;
      panel.classList.toggle('active',active); panel.hidden = !active;
    });
    if (view === 'leads' && snapshot) {
      try { await loadLeads(); } catch (error) { showAlert('error',error.message); }
    }
    if (view === 'demographics' && snapshot) {
      try { await loadDemographics(); } catch (error) { showAlert('error',error.message); }
    }
    if (view === 'campaigns' && snapshot) {
      try { await loadCampaigns(); } catch (error) { showAlert('error',error.message); }
    }
    if (view === 'validation') {
      try { await loadValidation(); } catch (error) { showAlert('error',error.message); }
    }
    if (view === 'targets' && snapshot) renderTargets();
  }

  function renderRollout() {
    const mode = rollout?.mode || 'parallel';
    document.body.classList.remove('eagle-rollout-legacy','eagle-rollout-parallel','eagle-rollout-governed');
    document.body.classList.add(`eagle-rollout-${mode}`);
    el('rolloutBanner').className=`eagle-rollout-banner ${mode}`;
    el('rolloutMode').textContent=mode === 'governed' ? 'Governed metrics active' : mode === 'legacy' ? 'Legacy executive view' : 'Parallel validation';
    const passes=Number(rollout?.consecutivePasses||0), required=Number(rollout?.requiredPasses||2);
    el('rolloutReadiness').textContent=rollout?.ownershipMatches === false
      ? 'Rollout ownership transfer required for selected API key'
      : rollout?.readyForGoverned ? 'Promotion gate passed' : `${passes} of ${required} required snapshot validations passed`;
  }

  async function loadValidation() {
    const context=selectedContext();
    if(!context)return;
    const debugRequest=api('/api/eagle/debug/schedules?'+new URLSearchParams({apiKeyId:context.apiKeyId,integrationId:context.integration.id}));
    if(!snapshot){scheduleDebug=await debugRequest;renderScheduleDebug();return;}
    const [data,audit,debug]=await Promise.all([
      api('/api/eagle/validation-runs?'+params({limit:20})),
      api('/api/eagle/rollout-audit?'+params({limit:20})),
      debugRequest,
    ]);
    scheduleDebug=debug;
    renderValidation(data.runs || [],audit.events || []);
    renderScheduleDebug();
  }

  function renderValidation(runs,auditEvents=[]) {
    const mode=rollout?.mode || 'parallel';
    el('validationMode').textContent=mode[0].toUpperCase()+mode.slice(1);
    el('validationPasses').textContent=formatNumber(rollout?.consecutivePasses);
    el('validationRequired').textContent=formatNumber(rollout?.requiredPasses || 2);
    el('validationLatest').textContent=rollout?.latestRun?.status || 'None';
    el('validationLatestMeta').textContent=rollout?.latestRun ? `${formatNumber(rollout.latestRun.checksPassed)} of ${formatNumber(rollout.latestRun.checksTotal)} checks passed` : 'No run recorded';
    const ids=['new_leads','current_scheduled_rate','current_won_rate','source_coverage','dnc_rate','lead_to_appointment_rate','lead_to_win_rate'];
    el('validationMetricRows').innerHTML=ids.map((id)=>{
      const metric=dashboard?.metrics?.[id] || dashboard?.historicalFunnel?.metrics?.[id]; const available=metric?.status==='available'&&Number.isFinite(Number(metric.value));
      const tolerance=metric?.unit==='percent'?.5:1;
      return `<tr data-validation-metric="${id}"><td><input class="validation-check" type="checkbox" ${available?'checked':'disabled'} aria-label="Validate ${escapeHtml(metric?.label||id)}"></td><td><strong>${escapeHtml(metric?.label||id)}</strong><span class="eagle-cell-sub">${escapeHtml(metric?.unit||'unavailable')}</span></td><td>${available?(metric.unit==='percent'?formatPercentMetric(metric.value):formatNumber(metric.value)):'Unavailable'}</td><td><input class="validation-reference" type="number" step="any" ${available?'':'disabled'} aria-label="Reference value"></td><td><input class="validation-tolerance" type="number" min="0" max="100" step="0.1" value="${tolerance}" ${available?'':'disabled'} aria-label="Tolerance"> ${metric?.unit==='percent'?'points':'%'}</td></tr>`;
    }).join('');
    el('validationRunRows').innerHTML=runs.length?runs.map((run)=>`<tr><td>${escapeHtml(String(run.snapshotId||'').slice(0,8))}</td><td><span class="eagle-validation-status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td><td>${formatNumber(run.checksPassed)} / ${formatNumber(run.checksTotal)}</td><td>${formatDate(run.createdAt)}</td></tr>`).join(''):'<tr><td colspan="4" class="eagle-empty">No validation runs yet.</td></tr>';
    el('rolloutAuditRows').innerHTML=auditEvents.length?auditEvents.map((event)=>`<tr><td><strong>${escapeHtml(event.fromMode||'initial')} → ${escapeHtml(event.toMode)}</strong></td><td>${escapeHtml(event.reason)}</td><td>${formatDate(event.createdAt)}</td></tr>`).join(''):'<tr><td colspan="3" class="eagle-empty">No rollout changes recorded.</td></tr>';
  }

  function renderScheduleDebug() {
    const data=scheduleDebug||{};const users=data.users||[];const previous=el('debugScheduleUser').value;
    el('debugScheduleWeek').textContent=data.week?`${data.week.weekStart} to ${data.week.weekEnd} · ${data.week.timeZone}`:'Current week unavailable';
    el('debugScheduleUser').innerHTML='<option value="">Select a user</option>'+users.map((user)=>`<option value="${escapeHtml(user.userId)}">${escapeHtml(user.username||user.crmUserName||user.userId)} · ${escapeHtml(user.state)}</option>`).join('');
    if(users.some((user)=>user.userId===previous))el('debugScheduleUser').value=previous;
    renderScheduleDebugState();
    const actions=data.actions||[];
    el('debugScheduleAuditRows').innerHTML=actions.length?actions.map((action)=>`<tr><td><strong>${escapeHtml(action.userId)}</strong><span class="eagle-cell-sub">${escapeHtml(action.action==='schedule_cleared'?'Schedule cleared':'Submission reopened')}</span></td><td>${escapeHtml(action.reason)}</td><td>${escapeHtml(action.actorUsername||action.actorAdminId||'Administrator')}<span class="eagle-cell-sub">${formatDate(action.createdAt)}</span></td></tr>`).join(''):'<tr><td colspan="3" class="eagle-empty">No schedule debug actions recorded for this context.</td></tr>';
  }

  function renderScheduleDebugState() {
    const user=(scheduleDebug?.users||[]).find((item)=>item.userId===el('debugScheduleUser').value);
    if(!user){el('debugScheduleState').innerHTML='Select a user to review the current-week state.';return;}
    const hours=(Number(user.scheduledMinutes)||0)/60;
    el('debugScheduleState').innerHTML=`<strong>${escapeHtml(user.username||user.crmUserName||user.userId)} · ${escapeHtml(user.state)}</strong><br>${hours.toLocaleString(undefined,{maximumFractionDigits:2})} scheduled hours · ${user.submittedAt?`submitted ${formatDate(user.submittedAt)}`:user.hasSchedule?'not submitted':'no current-week plan'}`;
  }

  async function resetSchedule() {
    const context=selectedContext();const userId=el('debugScheduleUser').value;const reason=el('debugScheduleReason').value.trim();
    if(!context||!userId)return showAlert('warning','Select a dialer user before applying a schedule reset.');
    if(reason.length<8)return showAlert('warning','Enter a debug reason of at least 8 characters.');
    if(!el('debugScheduleConfirm').checked)return showAlert('warning','Confirm that you understand the current-week schedule state will change.');
    el('resetSchedule').disabled=true;
    try{
      const data=await api(`/api/eagle/debug/schedules/${encodeURIComponent(userId)}/reset`,{method:'POST',body:JSON.stringify({apiKeyId:context.apiKeyId,integrationId:context.integration.id,mode:el('debugScheduleMode').value,reason})});
      el('debugScheduleReason').value='';el('debugScheduleConfirm').checked=false;
      showAlert('success',data.result.mode==='submission_only'?'Submission status cleared; the schedule is now a draft.':'Current-week schedule and submission status cleared.');
      await loadValidation();
    }catch(error){showAlert('error',error.message);}finally{el('resetSchedule').disabled=false;}
  }

  function renderExecutiveBrief(brief) {
    if(!brief){el('briefHeadline').textContent='Executive brief unavailable for this snapshot.';el('briefNarrative').textContent='Refresh the governed CRM snapshot to restore the decision view.';el('briefScorecards').innerHTML='';el('briefAttention').innerHTML='<p class="muted">No governed brief available.</p>';el('briefMomentum').innerHTML='';el('briefTrust').innerHTML='';return;}
    const decision=brief.decision||{};
    el('briefPosture').textContent=decision.postureLabel||'Executive brief';
    el('briefPosture').className=escapeHtml(decision.posture||'watch');
    el('briefHeadline').textContent=decision.headline||brief.headline;
    el('briefNarrative').textContent=decision.narrative||'Priorities and evidence are governed by the active EAGLE reporting scope.';
    el('briefAsOf').textContent=brief.asOf?`As of ${formatDateTime(brief.asOf)}`:'As-of time unavailable';
    el('briefAttentionCount').textContent=formatNumber(decision.actionCount??brief.attentionTotal??(brief.attention||[]).length);
    el('briefAttentionCountSummary').textContent=`${formatNumber(decision.actionCount??brief.attentionTotal??(brief.attention||[]).length)} priorities`;
    el('briefScorecards').innerHTML=(decision.scorecards||[]).map((item)=>`<div class="eagle-command-score ${escapeHtml(item.state||'neutral')}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong><small>${escapeHtml(item.detail)}</small></div>`).join('');
    const primary=decision.primaryAction;
    const actionButton=el('briefPrimaryAction');
    if(primary){actionButton.hidden=false;actionButton.textContent=`Act now: ${primary.title}`;actionButton.onclick=()=>setView(primary.view||'overview');}
    else{actionButton.hidden=true;actionButton.onclick=null;}
    el('briefAttention').innerHTML=(brief.attention||[]).length?(brief.attention||[]).map((item)=>`<button type="button" class="eagle-brief-item ${escapeHtml(item.type)}" data-brief-view="${escapeHtml(item.view||'overview')}"><span>${escapeHtml(item.title)}</span><strong>${escapeHtml(item.detail)}</strong><small>${escapeHtml(item.action)}</small></button>`).join(''):'<div class="eagle-brief-empty">No factual exception is present in this scope.</div>';
    el('briefMomentum').innerHTML=(brief.momentum||[]).length?(brief.momentum||[]).map((item)=>`<div class="eagle-momentum-item ${escapeHtml(item.direction)}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.text)}</strong></div>`).join(''):'<div class="eagle-brief-empty">Select a bounded period to compare momentum.</div>';
    const trust=brief.trust||{};
    const trustRows=[
      ['Overall',trust.overall,trust.overall==='ready'?'Governed evidence is current.':trust.overall==='review'?'Review evidence before relying on governed outcomes.':'Continue parallel monitoring.'],
      ['CRM snapshot',trust.snapshot?.status,trust.snapshot?.ageHours==null?'Age unavailable':`${trust.snapshot.ageHours} hours old / ${trust.snapshot.maxAgeHours} hour SLA`],
      ['Validation',trust.validation?.status,trust.validation?.ageHours==null?'No current validation age':`${trust.validation.ageHours} hours old / ${trust.validation.maxAgeHours} hour limit`],
    ];
    if(brief.targets?.configured)trustRows.push(['Target scope',brief.targets.notApplicable?'not_applicable':'applicable',brief.targets.scopeReason||'Approved target scope matches this report.']);
    el('briefTrust').innerHTML=trustRows.map(([label,status,detail])=>`<div class="eagle-trust-item ${escapeHtml(status||'unavailable')}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(status||'unavailable').replace('_',' '))}</strong><small>${escapeHtml(detail)}</small></div>`).join('');
    document.querySelectorAll('[data-brief-view]').forEach((button)=>button.onclick=()=>setView(button.dataset.briefView));
  }

  function renderTargetBadges() {
    const byMetric=new Map(targetAssessments.map((item)=>[item.metricId,item]));
    document.querySelectorAll('[data-target-badge]').forEach((badge)=>{
      const assessment=byMetric.get(badge.dataset.targetBadge);
      badge.className='eagle-target-badge';
      if(!assessment){badge.textContent='';badge.hidden=true;return;}
      badge.hidden=false;badge.classList.add(assessment.status);
      badge.textContent=`${targetStatusLabel(assessment.status)} · target ${assessment.targetLabel}`;
      badge.title=`Owned by ${assessment.businessOwner}`;
      badge.onclick=()=>setView('targets');
    });
  }

  function renderTargets() {
    const active=targetAssessments;
    el('targetConfigured').textContent=formatNumber(active.length);
    el('targetOn').textContent=formatNumber(active.filter((item)=>item.status==='on_target').length);
    el('targetNear').textContent=formatNumber(active.filter((item)=>item.status==='near_target').length);
    el('targetOff').textContent=formatNumber(active.filter((item)=>item.status==='off_target').length);
    el('targetNotApplicable').textContent=formatNumber(active.filter((item)=>item.status==='not_applicable').length);
    const assessments=new Map(active.map((item)=>[item.metricId,item]));
    el('targetRows').innerHTML=targets.length?targets.map((target)=>{
      const assessment=assessments.get(target.metricId);const status=target.active?assessment?.status||'unavailable':'inactive';
      return `<tr><td><button type="button" class="eagle-target-edit" data-target-edit="${escapeHtml(target.metricId)}">${escapeHtml(assessment?.metricLabel||target.metricId)}</button></td><td><span class="eagle-target-scope">${escapeHtml(assessment?.applicability?.scopeLabel||formatTargetScope(target))}</span></td><td>${assessment?formatTargetMetricValue(assessment.currentValue,assessment.unit):'—'}</td><td>${escapeHtml(assessment?.targetLabel||formatRawTarget(target))}</td><td><span class="eagle-target-state ${escapeHtml(status)}" title="${escapeHtml(assessment?.applicability?.reason||'')}">${escapeHtml(targetStatusLabel(status))}</span></td><td>${escapeHtml(target.businessOwner)}</td></tr>`;
    }).join(''):'<tr><td colspan="6" class="eagle-empty">No approved targets configured.</td></tr>';
    document.querySelectorAll('[data-target-edit]').forEach((button)=>button.onclick=()=>{el('targetMetric').value=button.dataset.targetEdit;syncTargetForm();});
    syncTargetForm(false);
  }

  function syncTargetForm(overwrite=true) {
    const metricId=el('targetMetric').value;const target=targets.find((item)=>item.metricId===metricId);
    const metric=dashboard?.metrics?.[metricId];
    el('targetUnitHint').textContent=`Values use ${metric?.unit==='percent'?'percentage points':metric?.unit||'the governed metric unit'}. Warning margin defines the near-target band.`;
    if(!overwrite)return;
    el('targetDirection').value=target?.direction||(['actionable_unassigned','dnc_rate'].includes(metricId)?'at_most':'at_least');
    el('targetPeriod').value=target?.periodDays==null?'':String(target.periodDays);
    el('targetValue').value=target?.targetValue??'';el('targetMargin').value=target?.warningMargin??0;
    el('targetOwner').value=target?.businessOwner||'';el('targetActive').checked=target?Boolean(target.active):true;
  }

  async function saveTarget() {
    const context=selectedContext();const reason=el('targetReason').value.trim();
    if(!reason||el('targetValue').value===''||!el('targetOwner').value.trim())return showAlert('warning','Target value, business owner, and governance reason are required.');
    el('saveTarget').disabled=true;
    try{
      await api('/api/eagle/targets',{method:'PUT',body:JSON.stringify({integrationId:context.integration.id,apiKeyId:context.apiKeyId,metricId:el('targetMetric').value,periodDays:el('targetPeriod').value,direction:el('targetDirection').value,targetValue:el('targetValue').value,warningMargin:el('targetMargin').value,businessOwner:el('targetOwner').value.trim(),active:el('targetActive').checked,reason})});
      el('targetReason').value='';showAlert('success','Governed target saved and audited.');await loadDashboard();
    }catch(error){showAlert('error',error.message);}finally{el('saveTarget').disabled=false;}
  }

  function formatRawTarget(target){return `${target.direction==='at_most'?'≤':'≥'} ${Number(target.targetValue).toLocaleString(undefined,{maximumFractionDigits:2})}`;}
  function formatTargetScope(target){return target.periodDays?`Integration-wide / last ${target.periodDays} days`:'Integration-wide / all time';}
  function formatTargetMetricValue(value,unit){if(value==null)return 'Unavailable';return unit==='percent'?formatPercentMetric(value):formatNumber(value);}
  function targetStatusLabel(status){return ({on_target:'On target',near_target:'Near target',off_target:'Off target',not_applicable:'Not applicable',unavailable:'Unavailable',inactive:'Inactive'})[status]||status;}

  async function runValidation() {
    const referenceSystem=el('validationReferenceSystem').value.trim(), evidenceReference=el('validationEvidence').value.trim();
    const checks=[...document.querySelectorAll('#validationMetricRows tr')].filter((row)=>row.querySelector('.validation-check')?.checked).map((row)=>({
      metricId:row.dataset.validationMetric,referenceValue:row.querySelector('.validation-reference').value,
      toleranceValue:row.querySelector('.validation-tolerance').value,evidenceReference,
    })).filter((check)=>check.referenceValue!=='');
    if(!referenceSystem||!evidenceReference||!checks.length)return showAlert('warning','Enter a reference system, evidence reference, and at least one control total.');
    const context=selectedContext();el('runValidation').disabled=true;
    try{await api('/api/eagle/validation-runs',{method:'POST',body:JSON.stringify({snapshotId:snapshot.id,apiKeyId:context.apiKeyId,integrationId:context.integration.id,...filterValues(),referenceSystem,checks})});showAlert('success','Validation recorded against this frozen snapshot.');await loadDashboard();}
    catch(error){showAlert('error',error.message);}finally{el('runValidation').disabled=false;}
  }

  async function changeRollout(mode) {
    const reason=el('rolloutReason').value.trim();if(!reason)return showAlert('warning','Enter an audit reason before changing rollout mode.');
    const context=selectedContext();
    const transferring=rollout?.ownershipMatches === false;
    try{const data=await api('/api/eagle/rollout',{method:'PUT',body:JSON.stringify({integrationId:context.integration.id,apiKeyId:context.apiKeyId,mode,reason})});rollout=data.rollout;renderRollout();renderValidation([]);showAlert('success',transferring?`EAGLE rollout ownership transferred; mode is ${mode}.`:`EAGLE rollout changed to ${mode}.`);await loadValidation();}
    catch(error){showAlert('error',error.message);}
  }

  async function loadCampaigns() {
    const context = selectedContext();
    if (!snapshot || !context) return;
    campaignData = await api('/api/eagle/campaigns?' + new URLSearchParams({
      apiKeyId:context.apiKeyId,integrationId:context.integration.id,snapshotId:snapshot.id,days:el('period').value,
    }));
    const summary = campaignData.summary || {};
    el('campaignSubmissions').textContent=formatNumber(summary.submissions);
    el('campaignContacts').textContent=formatNumber(summary.contacts);
    el('campaignPages').textContent=formatNumber(summary.landingPages);
    el('campaignFacebook').textContent=formatNumber(summary.facebookSubmissions);
    el('campaignScheduled').textContent=formatNumber(summary.scheduledContacts);
    el('campaignWon').textContent=formatNumber(summary.wonContacts);
    renderCampaignRows('campaignPageRows',campaignData.pages || [],true);
    renderCampaignRows('campaignFormRows',campaignData.forms || [],false);
    renderCampaignRows('campaignSocialRows',campaignData.social || [],false);
    renderCampaignTrend(campaignData.trend || []);
    renderCampaignEvents(campaignData.events || []);
    const sync=campaignData.sync;
    el('campaignSyncState').textContent=sync ? `${sync.status} / ${formatNumber(sync.eventsReceived)} events / ${formatDate(sync.completedAt || sync.createdAt)}` : 'Activity not synchronized';
  }

  function renderCampaignRows(id,rows,linkPage) {
    el(id).innerHTML=rows.length ? rows.map((row)=>`<tr><td>${linkPage&&row.url?`<a class="eagle-contact-link" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.label)}</a>`:escapeHtml(row.label)}</td><td>${formatNumber(row.contacts)}</td><td>${formatNumber(row.scheduled)}</td><td>${formatNumber(row.won)}</td></tr>`).join('') : '<tr><td colspan="4" class="eagle-empty">No attributable events.</td></tr>';
  }

  function renderCampaignEvents(rows) {
    el('campaignEventRows').innerHTML=rows.length ? rows.map((row)=>`<tr><td>${formatDate(row.eventAt)}</td><td>${row.crmUrl?`<a class="eagle-contact-link" href="${escapeHtml(row.crmUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.contactName || row.contactId)}</a>`:escapeHtml(row.contactName || row.contactId || '-')}</td><td>${escapeHtml(row.formName || row.eventType || '-')}</td><td>${row.pageUrl?`<a class="eagle-contact-link" href="${escapeHtml(row.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.pageTitle || row.pageUrl)}</a>`:'-'}</td><td>${escapeHtml(row.utmSource || row.source || row.referrerHost || '-')}</td><td>${escapeHtml(row.utmCampaign || row.utmContent || '-')}</td><td>${escapeHtml(row.disposition || 'New / Unworked')}</td></tr>`).join('') : '<tr><td colspan="7" class="eagle-empty">No campaign activity loaded.</td></tr>';
  }

  function renderCampaignTrend(rows) {
    const svg=d3.select('#campaignTrend');svg.selectAll('*').remove();
    if(!rows.length){svg.append('text').attr('x',600).attr('y',130).attr('text-anchor','middle').attr('fill','#66716b').text('No campaign activity in this period');return;}
    const data=rows.map((row)=>({date:new Date(row.date),value:Number(row.submissions)||0})).filter((row)=>!Number.isNaN(row.date.getTime()));
    const x=d3.scaleTime().domain(d3.extent(data,(row)=>row.date)).range([55,1175]);
    const y=d3.scaleLinear().domain([0,d3.max(data,(row)=>row.value)||1]).nice().range([220,20]);
    svg.append('g').attr('class','eagle-axis').attr('transform','translate(0,220)').call(d3.axisBottom(x).ticks(Math.min(8,data.length)).tickFormat(d3.timeFormat('%b %d')));
    svg.append('g').attr('class','eagle-axis').attr('transform','translate(55,0)').call(d3.axisLeft(y).ticks(5));
    svg.append('path').datum(data).attr('fill','none').attr('stroke','#197a55').attr('stroke-width',3).attr('d',d3.line().x((row)=>x(row.date)).y((row)=>y(row.value)));
  }

  async function refreshCampaigns() {
    const context=selectedContext();if(!context)return;
    el('refreshCampaigns').disabled=true;
    try {
      const data=await api('/api/eagle/campaigns/sync',{method:'POST',body:JSON.stringify({apiKeyId:context.apiKeyId,integrationId:context.integration.id})});
      showCampaignSync(data.run);pollCampaignSync(data.run.id);
    } catch(error){el('refreshCampaigns').disabled=false;showAlert('error',error.message);}
  }

  function showCampaignSync(run) {
    el('campaignSyncStatus').hidden=false;
    el('campaignSyncText').textContent=`${run.status}: ${formatNumber(run.eventsReceived)} of ${formatNumber(run.expectedEvents)} activity events`;
    const progress=run.expectedEvents?Math.round(Number(run.eventsReceived||0)/Number(run.expectedEvents)*100):Math.min(92,Number(run.pagesProcessed||0)*5);
    el('campaignSyncProgress').style.width=`${Math.max(6,progress)}%`;
  }

  function pollCampaignSync(id) {
    stopCampaignPolling();
    campaignPollTimer=setInterval(async()=>{try{const run=(await api('/api/eagle/campaigns/sync/'+encodeURIComponent(id)+'?'+new URLSearchParams({apiKeyId:selectedContext().apiKeyId}))).run;showCampaignSync(run);if(!['queued','running'].includes(run.status)){stopCampaignPolling();el('refreshCampaigns').disabled=false;if(run.status==='failed')return showAlert('error',run.errorSummary||'Campaign activity sync failed');el('campaignSyncStatus').hidden=true;showAlert('success',`${formatNumber(run.eventsReceived)} campaign activity events synchronized.`);await loadCampaigns();}}catch(error){stopCampaignPolling();el('refreshCampaigns').disabled=false;showAlert('error',error.message);}},1500);
  }

  function stopCampaignPolling(){if(campaignPollTimer)clearInterval(campaignPollTimer);campaignPollTimer=null;}

  async function loadLeads() {
    if (!snapshot) return;
    const data = await api('/api/eagle/leads?' + params({ limit:50, offset:leadOffset }, true));
    el('leadCount').textContent = `${formatNumber(data.total)} matching CRM contacts`;
    el('leadPage').textContent = data.total ? `${data.offset + 1}-${Math.min(data.offset + data.rows.length,data.total)} of ${formatNumber(data.total)}` : '0 leads';
    el('leadPrev').disabled = data.offset <= 0; el('leadNext').disabled = data.offset + data.limit >= data.total;
    el('leadRows').innerHTML = data.rows.length ? data.rows.map((row) => `<tr>
      <td><span class="eagle-cell-main">${escapeHtml(row.name || row.contactId)}</span><span class="eagle-cell-sub">${escapeHtml(row.email || row.phone || row.contactId)}</span></td>
      <td><span class="eagle-cell-main">${escapeHtml([row.city,row.state].filter(Boolean).join(', ') || 'Unknown')}</span><span class="eagle-cell-sub">${escapeHtml(row.postalCode || '')}</span></td>
      <td><span class="eagle-cell-main">${escapeHtml(row.source || 'Unattributed')}</span><span class="eagle-cell-sub">${escapeHtml(row.campaign || 'Unattributed')}</span></td>
      <td>${escapeHtml(row.service || 'Other')}</td><td><span class="eagle-pill ${dispositionClass(row.disposition)}">${escapeHtml(row.disposition)}</span></td>
      <td><span class="eagle-cell-main">${escapeHtml(row.crmOwner || row.dialOwner || 'Unassigned')}</span><span class="eagle-cell-sub">${escapeHtml(row.dialStatus || '')}</span></td>
      <td><span class="eagle-pill ${row.dncStatus === 'clean' ? 'good' : row.dncStatus === 'blocked' ? 'bad' : 'warn'}">${escapeHtml(row.dncStatus || 'pending')}</span></td><td>${formatDate(row.dateAdded)}</td>
      <td>${row.crmUrl ? `<a class="eagle-contact-link" href="${escapeHtml(row.crmUrl)}" target="_blank" rel="noopener noreferrer" title="Open contact in CRM">Open contact</a>` : '<span class="eagle-cell-sub">Unavailable</span>'}</td></tr>`).join('') : '<tr><td colspan="9" class="eagle-empty">No leads match these filters.</td></tr>';
  }

  function dispositionClass(value) { return value === 'Closed Won' || value === 'Scheduled' ? 'good' : value === 'DNC' || String(value).startsWith('Closed') ? 'bad' : 'warn'; }

  function updateExport() { el('exportCsv').href = base + '/api/eagle/export.csv?' + params({}, true); }

  async function refreshCensusReference() {
    const button = el('refreshCensus');
    button.disabled = true;
    try {
      showAlert('','');
      const data = await api('/api/eagle/geography-reference/refresh', { method:'POST', body:JSON.stringify({}) });
      showAlert('success',`${formatNumber(data.reference.states)} states and ${formatNumber(data.reference.places)} Census places loaded.`);
      await loadDashboard();
    } catch (error) { showAlert('error',error.message); }
    finally { button.disabled = false; }
  }

  function updateFilterState() {
    const ids=['stateFilter','cityFilter','serviceFilter','dispositionFilter','sourceFilter','campaignFilter'];
    const count=ids.filter((id)=>el(id).value).length;
    el('clearFilters').disabled=count===0;
    el('clearFilters').textContent=count?`Clear ${count}`:'Clear';
    document.querySelector('.eagle-filters').classList.toggle('has-active-filters',count>0);
  }

  function applyFilters() { leadOffset=0; updateFilterState(); loadDashboard(); }

  function clearFilters() {
    ['stateFilter','cityFilter','serviceFilter','dispositionFilter','sourceFilter','campaignFilter'].forEach((id)=>{el(id).value='';});
    leadOffset=0; updateFilterState(); loadDashboard();
  }

  function updateFreshness() {
    const date = snapshot?.completedAt || snapshot?.createdAt;
    el('snapshotFreshness').textContent = date ? `${formatDate(date)} / ${formatNumber(snapshot.totalContacts)} contacts` : 'Not loaded';
  }

  function renderEmpty(message) {
    ['kpiTotal','kpiScheduled','kpiWon','kpiUnassigned','kpiSourceCoverage','kpiDnc','healthLocation','healthCampaign',
      'geoCompleteness','geoStateFootprint','geoPlaceFootprint','geoLeadDensity'].forEach((id)=>{el(id).textContent='-';});
    el('kpiLeadDelta').textContent='No comparison';
    el('kpiScheduledRate').textContent='-';
    el('kpiWonRate').textContent='-';
    el('kpiSourceRatio').textContent='-';
    el('kpiDncRate').textContent='-';
    el('reportScope').textContent=message;
    ['cohortEligible','cohortAppointed','cohortWon','historicalAppointmentRate','historicalWinRate','historicalCloseRate'].forEach((id)=>{el(id).textContent='-';});
    el('cohortMaturity').textContent=message;
    el('cohortExcluded').textContent='- excluded';
    el('geoStatePresence').textContent='- of 50 states';
    el('geoPlacePresence').textContent='- Census places matched';
    el('geoSubtitle').textContent='CRM contact locations';
    el('censusReference').textContent='Census reference not loaded';
    el('geoRanking').innerHTML=`<p class="muted">${escapeHtml(message)}</p>`;
    el('funnelBars').innerHTML=`<p class="muted">${escapeHtml(message)}</p>`;
    el('driverRows').innerHTML=`<tr><td colspan="6" class="eagle-empty">${escapeHtml(message)}</td></tr>`;
    el('marketRows').innerHTML=`<tr><td colspan="6" class="eagle-empty">${escapeHtml(message)}</td></tr>`;
    el('leadRows').innerHTML=`<tr><td colspan="9" class="eagle-empty">${escapeHtml(message)}</td></tr>`;
  }

  function showAlert(type,message) { const box=el('alert'); box.hidden=!message; box.className=message?`alert alert-${type}`:''; box.textContent=message||''; }
  function escapeHtml(value) { return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function formatNumber(value) { return Number(value || 0).toLocaleString(); }
  function formatPercentMetric(value) { return value == null ? '—' : `${Number(value).toLocaleString(undefined,{maximumFractionDigits:1})}%`; }
  function formatDate(value) { if(!value)return '-'; const date=new Date(value); return Number.isNaN(date.getTime())?String(value):date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
  function formatDateTime(value) { if(!value)return '—'; const date=new Date(value); return Number.isNaN(date.getTime())?String(value):date.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}); }
  function formatMetricValue(metric,fallback) { const value=metric?.status==='available'?metric.value:fallback; return metric?.unit==='percent'?formatPercentMetric(value):formatNumber(value); }
  function formatMetricComparison(metric) { const comparison=metric?.comparison; if(!comparison)return 'No prior-period baseline'; const value=Number(comparison.value); const direction=value>0?'▲':value<0?'▼':'•'; const formatted=Math.abs(value).toLocaleString(undefined,{maximumFractionDigits:1}); const amount=comparison.kind==='percentage_points'?`${formatted} pts`:`${formatted}%`; return `${direction} ${amount} vs prior period`; }
  function formatSemanticRatio(metric,includeComparison=true) { if(!metric||metric.status!=='available'||metric.denominator==null)return '— (no governed denominator)'; const comparison=includeComparison&&metric.comparison?` · ${Number(metric.comparison.value)>0?'+':''}${Number(metric.comparison.value).toLocaleString(undefined,{maximumFractionDigits:1})} pts`:''; return `${formatNumber(metric.numerator)} / ${formatNumber(metric.denominator)} = ${formatPercentMetric(metric.value)}${comparison}`; }
  function formatMetricNumerator(metric) { return metric?.status==='available'&&metric.denominator!=null?`${formatNumber(metric.numerator)} / ${formatNumber(metric.denominator)} leads`:'—'; }
  function renderReconciliation(id,reconciliation) { const target=el(id); if(!target)return; const good=Boolean(reconciliation?.reconciled); target.classList.toggle('bad',!good); target.textContent=!reconciliation?'Reconciliation unavailable':good?`✓ Reconciled to ${formatNumber(reconciliation.filteredTotal)} leads${reconciliation.truncated?` · ${formatNumber(reconciliation.otherTotal)} in Other`:''}`:`Review ${formatNumber(Math.abs(reconciliation.difference))} lead difference`; }

  el('apiKey').onchange=()=>{syncIntegrations();loadLatestSnapshot();};
  el('integration').onchange=loadLatestSnapshot;
  el('period').onchange=applyFilters;
  ['stateFilter','cityFilter','serviceFilter','dispositionFilter','sourceFilter','campaignFilter'].forEach((id)=>{el(id).onchange=applyFilters;});
  el('refreshCrm').onclick=refreshCrm; el('clearFilters').onclick=clearFilters;
  el('refreshCensus').onclick=refreshCensusReference;
  el('refreshCampaigns').onclick=refreshCampaigns;
  el('searchButton').onclick=()=>{leadOffset=0;loadLeads();updateExport();}; el('leadSearch').onkeydown=(event)=>{if(event.key==='Enter'){leadOffset=0;loadLeads();updateExport();}};
  el('leadPrev').onclick=()=>{leadOffset=Math.max(0,leadOffset-50);loadLeads();}; el('leadNext').onclick=()=>{leadOffset+=50;loadLeads();};
  el('demographicCategoryFilter').onchange=renderDemographicCategories;
  el('demographicFieldSearch').oninput=renderDemographicCategories;
  el('demographicField').onchange=renderDemographicField;
  el('driverDimension').onchange=renderDrivers;
  el('runValidation').onclick=runValidation;
  el('debugScheduleUser').onchange=renderScheduleDebugState;
  el('resetSchedule').onclick=resetSchedule;
  el('targetMetric').onchange=syncTargetForm;
  el('saveTarget').onclick=saveTarget;
  document.querySelectorAll('[data-rollout-mode]').forEach((button)=>button.onclick=()=>changeRollout(button.dataset.rolloutMode));
  document.querySelectorAll('[data-eagle-view]').forEach((button)=>button.onclick=()=>setView(button.dataset.eagleView));
  document.querySelectorAll('[data-open-view]').forEach((button)=>button.onclick=()=>setView(button.dataset.openView));
  document.querySelectorAll('[data-kpi-drill]').forEach((card)=>{
    card.onclick=()=>drillKpi(card);
    card.onkeydown=(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();drillKpi(card);}};
  });
  document.querySelectorAll('[data-geo-view]').forEach((button)=>button.onclick=()=>{document.querySelectorAll('[data-geo-view]').forEach((item)=>item.classList.toggle('active',item===button));geoView=button.dataset.geoView;renderGeoRanking();});
  el('logout').onclick=async(event)=>{event.preventDefault();await fetch(base+'/logout',{method:'POST'});location.href=base+'/login';};
  updateFilterState();

  (async function init(){try{const me=await fetch(base+'/me',{headers:{Accept:'application/json'}});if(!me.ok){location.href=base+'/login?next='+encodeURIComponent(location.pathname);return;}await bootstrap();}catch(error){showAlert('error',error.message);renderEmpty(error.message);}})();
})();
