const express = require('express');
const path = require('path');
const { ROOT } = require('../config');
const { requireAdminSession, requireAdminRole } = require('../middleware/sessionAuth');
const eagle = require('../services/eagle');
const eagleValidation = require('../services/eagleValidation');
const { buildExecutiveBrief } = require('../services/eagleExecutive');
const eagleTargets = require('../services/eagleTargets');
const { refreshCensusGeographies, censusReferenceStatus } = require('../services/censusGeography');
const campaignMonitor = require('../services/campaignMonitor');
const eagleDebug = require('../services/eagleDebug');
const eagleCallCenter = require('../services/eagleCallCenter');

function createAdminEagleRouter() {
  const router = express.Router();
  router.use(requireAdminSession);

  router.get('/eagle', requireAdminRole, (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'eagle.html'));
  });

  router.use('/api/eagle', requireAdminRole);

  router.get('/api/eagle/contexts', async (req, res) => {
    try { res.json({ ok: true, contexts: await eagle.listContexts() }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/call-center', async (req, res) => {
    try { res.json({ ok:true, ...(await eagleCallCenter.getCallCenter(req.query)) }); }
    catch (error) { sendError(res,error); }
  });

  router.get('/api/eagle/debug/schedules', async (req, res) => {
    try { res.json({ ok:true, ...(await eagleDebug.listScheduleDebug(req.query)) }); }
    catch (error) { sendError(res, error); }
  });

  router.post('/api/eagle/debug/schedules/:userId/reset', async (req, res) => {
    req.sentinelControl = {
      apiKeyId:req.body?.apiKeyId,
      action:'eagle.schedule.reset',
      entityType:'schedule',
      entityId:req.params.userId,
    };
    try {
      const result = await eagleDebug.resetSchedule(
        { ...(req.body || {}), userId:req.params.userId }, req.session.admin
      );
      req.sentinelControl.locationId = result.locationId;
      res.json({ ok:true, result });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/eagle/snapshots', async (req, res) => {
    try {
      const snapshot = await eagle.createSnapshot(req.body || {}, req.session.admin);
      res.status(202).json({ ok: true, snapshot });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/snapshots/latest', async (req, res) => {
    try {
      const snapshot = await eagle.latestSnapshot(req.query.integrationId, req.query.apiKeyId);
      res.json({ ok: true, snapshot });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/snapshots/:id', async (req, res) => {
    try {
      const snapshot = await eagle.getSnapshot(req.params.id, req.query.apiKeyId);
      res.json({ ok: true, snapshot });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/dashboard', async (req, res) => {
    try {
      const data = await eagle.getDashboard(req.query);
      const rollout = await eagleValidation.getRolloutStatus(req.query);
      const snapshot = await eagle.getSnapshot(req.query.snapshotId,req.query.apiKeyId);
      const targets = await eagleTargets.listTargets(req.query);
      const targetAssessments = eagleTargets.evaluateTargets(data.metrics,targets,{
        days:data.period?.days,
        filters:Object.fromEntries(['state','city','service','disposition','source','campaign'].map((key)=>[key,req.query[key]||''])),
      });
      res.json({ ok: true, ...data, rollout, targets, targetAssessments,
        executiveBrief:buildExecutiveBrief(data,rollout,snapshot,new Date(),targetAssessments) });
    }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/rollout', async (req, res) => {
    try { res.json({ ok:true, rollout:await eagleValidation.getRolloutStatus(req.query) }); }
    catch (error) { sendError(res, error); }
  });

  router.put('/api/eagle/rollout', async (req, res) => {
    try { res.json({ ok:true, rollout:await eagleValidation.setRolloutMode(req.body || {}, req.session.admin) }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/validation-runs', async (req, res) => {
    try { res.json({ ok:true, runs:await eagleValidation.listValidationRuns(req.query) }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/rollout-audit', async (req, res) => {
    try { res.json({ ok:true, events:await eagleValidation.listRolloutAudit(req.query) }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/targets', async (req, res) => {
    try { res.json({ ok:true, targets:await eagleTargets.listTargets(req.query) }); }
    catch (error) { sendError(res, error); }
  });

  router.put('/api/eagle/targets', async (req, res) => {
    try { res.json({ ok:true, target:await eagleTargets.upsertTarget(req.body || {},req.session.admin) }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/validation-runs/:id', async (req, res) => {
    try { res.json({ ok:true, run:await eagleValidation.getValidationRun(req.params.id,req.query.apiKeyId) }); }
    catch (error) { sendError(res, error); }
  });

  router.post('/api/eagle/validation-runs', async (req, res) => {
    try { res.status(201).json({ ok:true, run:await eagleValidation.createValidationRun(req.body || {},req.session.admin) }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/attribution-mappings', async (req, res) => {
    try { res.json({ ok:true, mappings:await eagle.listAttributionMappings(req.query) }); }
    catch (error) { sendError(res, error); }
  });

  router.put('/api/eagle/attribution-mappings', async (req, res) => {
    try { res.json({ ok:true, mapping:await eagle.upsertAttributionMapping(req.body || {}, req.session.admin) }); }
    catch (error) { sendError(res, error); }
  });

  router.post('/api/eagle/opportunities/import', async (req, res) => {
    try { res.status(201).json({ ok:true, import:await eagle.importOpportunitySnapshots(req.body || {}, req.session.admin) }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/geography-reference', async (req, res) => {
    try { res.json({ ok: true, reference: await censusReferenceStatus() }); }
    catch (error) { sendError(res, error); }
  });

  router.post('/api/eagle/geography-reference/refresh', async (req, res) => {
    try { res.json({ ok: true, reference: await refreshCensusGeographies() }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/demographics', async (req, res) => {
    try { res.json({ ok: true, ...(await eagle.getDemographics(req.query)) }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/demographics/contacts', async (req, res) => {
    try { res.json({ ok: true, ...(await eagle.listDemographicContacts(req.query)) }); }
    catch (error) { sendError(res, error); }
  });

  router.post('/api/eagle/campaigns/sync', async (req, res) => {
    try {
      const run = await campaignMonitor.createCampaignSync(req.body || {}, req.session.admin);
      res.status(202).json({ ok:true, run });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/campaigns/sync/:id', async (req, res) => {
    try { res.json({ ok:true, run:await campaignMonitor.getCampaignSync(req.params.id, req.query.apiKeyId) }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/campaigns', async (req, res) => {
    try { res.json({ ok:true, ...(await campaignMonitor.getCampaignReport(req.query)) }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/leads', async (req, res) => {
    try { res.json({ ok: true, ...(await eagle.listFacts(req.query)) }); }
    catch (error) { sendError(res, error); }
  });

  router.get('/api/eagle/export.csv', async (req, res) => {
    try {
      const data = await eagle.listFacts({ ...req.query, export: true, limit: 10000 });
      const columns = [
        ['contactId', 'CRM Contact ID'], ['leadId', 'Dial Lead ID'], ['name', 'Name'],
        ['email', 'Email'], ['phone', 'Phone'], ['city', 'City'], ['state', 'State'],
        ['postalCode', 'Postal Code'], ['source', 'Marketing Source'], ['campaign', 'Campaign'],
        ['medium', 'Medium'], ['service', 'Service'], ['disposition', 'CRM Disposition'],
        ['crmOwner', 'CRM Owner'], ['dialStatus', 'Dial Status'], ['dialOwner', 'Dial Owner'],
        ['dncStatus', 'DNC Status'], ['dateAdded', 'CRM Date Added'], ['updatedAt', 'CRM Updated'],
        ['dateOfBirth', 'Date of Birth'], ['age', 'Age'], ['gender', 'Gender'],
        ['householdIncome', 'Household Income'], ['homeowner', 'Homeowner'],
        ['propertyType', 'Property Type'], ['language', 'Language'], ['timeZone', 'Time Zone'],
        ['businessName', 'Business Name'], ['website', 'Website'], ['contactType', 'Contact Type'],
        ['contactSource', 'Contact Source'], ['opportunityOwner', 'Opportunity Owner'],
        ['opportunitySource', 'Opportunity Source'], ['lostReason', 'Lost Reason'],
        ['childrenInHousehold', 'Children in Household'], ['childrenAged13To18', 'Children Aged 13-18'],
        ['childrenAged10To12', 'Children Aged 10-12'], ['childrenAged7To9', 'Children Aged 7-9'],
        ['childrenAged4To6', 'Children Aged 4-6'], ['childrenAged0To3', 'Children Aged 0-3'],
        ['numberPeopleHousehold', 'People in Household'], ['numberChildrenHousehold', 'Children in Household Count'],
        ['numberAdultsHousehold', 'Adults in Household'], ['creditScoreRange', 'Credit Score Range'],
        ['creditScoreMedian', 'Credit Score Median'], ['discretionaryIncome', 'Discretionary Income'],
        ['medianHouseholdNetWorth', 'Median Household Net Worth'], ['books', 'Books'], ['diy', 'DIY'],
        ['music', 'Music'], ['gardening', 'Gardening'], ['cooking', 'Cooking'],
      ];
      const dynamicColumns = new Map();
      for (const row of data.rows) {
        const customFields = row.demographics?.customFields || {};
        for (const [key, entry] of Object.entries(customFields)) {
          const columnKey = `custom.${key}`;
          dynamicColumns.set(columnKey, String(entry?.label || key));
          row[columnKey] = entry && typeof entry === 'object' && Object.hasOwn(entry, 'value')
            ? (Array.isArray(entry.value) ? entry.value.join(' | ') : entry.value)
            : entry;
        }
      }
      columns.push(...[...dynamicColumns.entries()].sort((a, b) => a[1].localeCompare(b[1])));
      const lines = [columns.map(([, label]) => csv(label)).join(',')];
      for (const row of data.rows) lines.push(columns.map(([key]) => csv(row[key])).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="eagle-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(`\uFEFF${lines.join('\r\n')}`);
    } catch (error) { sendError(res, error); }
  });

  return router;
}

function csv(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function sendError(res, error) {
  res.status(error.status || 500).json({ ok: false, error: error.message || 'EAGLE operation failed' });
}

module.exports = { createAdminEagleRouter };
