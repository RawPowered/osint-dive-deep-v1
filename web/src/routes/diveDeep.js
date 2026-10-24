const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { ROOT, getDiveDeepConfig, getDiveDeepMetaConfig } = require('../config');
const { regenerateSession } = require('./auth');
const { customerAuthLimiter, customerMetaSyncLimiter } = require('../middleware/rateLimit');
const {
  ensureCustomerCsrf,
  requireCustomerSession,
  requireCustomerCsrf,
} = require('../middleware/customerSession');
const diveDeepService = require('../services/diveDeep');
const diveDeepAuthorizations = require('../services/diveDeepAuthorizations');
const diveDeepIntegrations = require('../services/diveDeepIntegrations');
const diveDeepImports = require('../services/diveDeepImports');
const diveDeepImageAnalysis = require('../services/diveDeepImageAnalysis');
const diveDeepWorkflow = require('../services/diveDeepWorkflow');
const diveDeepCrm = require('../services/diveDeepCrmIntegration');
const { newRequestId, recordEvent } = require('../services/sentinel');
const { detectImage } = require('../services/diveDeepFiles');

function customerId(req) { return req.session?.diveDeepCustomer?.id; }

function authorizationContext(req) {
  const socketIp = String(req.socket?.remoteAddress || '').trim();
  const expressIp = String(req.ip || '').trim();
  return {
    ipAddress: expressIp || socketIp,
    ipSource: expressIp ? 'express:req.ip' : 'socket:remoteAddress',
    userAgent: String(req.get('user-agent') || '').slice(0, 1000),
    sessionId: String(req.sessionID || ''),
  };
}

function sendError(res, error) {
  const transientCodes = new Set([
    'POOL_ENQUEUELIMIT', 'POOL_CLOSED', 'ETIMEDOUT', 'ECONNRESET',
    'PROTOCOL_CONNECTION_LOST', 'ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK',
  ]);
  const transient = transientCodes.has(error.code);
  if (transient) res.setHeader('Retry-After', '3');
  const status = transient ? 503 : (error.status || 500);
  return res.status(status).json({
    error: transient
      ? 'DiveDeep is briefly busy completing protected work. Please retry in a few seconds.'
      : (error.status ? error.message : 'DiveDeep operation failed'),
    code: transient ? 'DIVEDEEP_TEMPORARILY_BUSY' : (error.code || 'DIVEDEEP_ERROR'),
  });
}

function page(name) { return path.join(ROOT, 'public', 'divedeep', name); }

function customerUiUrl(pathname) {
  const origin = getDiveDeepConfig().publicOrigin;
  return origin ? `${origin}${pathname}` : pathname;
}

function graphId(value, label) {
  const id = String(value || '');
  if (!/^[0-9_]+$/.test(id)) throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  return id;
}

async function graphJson(config, accessToken, edge, fields) {
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${edge}`);
  url.searchParams.set('access_token', accessToken);
  if (config.appSecret) {
    url.searchParams.set('appsecret_proof', crypto.createHmac('sha256', config.appSecret).update(accessToken).digest('hex'));
  }
  if (fields) url.searchParams.set('fields', fields);
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error('Facebook album access is unavailable. Reconnect Facebook or ask an administrator to enable approved album access.'), { status: 409, code: 'DIVEDEEP_FACEBOOK_ALBUM_UNAVAILABLE' });
  return body;
}

async function graphCollection(config, accessToken, edge, fields, parameters = {}, maxPages = 3) {
  const first = new URL(`https://graph.facebook.com/${config.graphVersion}/${edge}`);
  first.searchParams.set('access_token', accessToken);
  if (config.appSecret) {
    first.searchParams.set('appsecret_proof', crypto.createHmac('sha256', config.appSecret).update(accessToken).digest('hex'));
  }
  first.searchParams.set('limit', String(Math.min(Math.max(Number(parameters.limit) || 100, 1), 100)));
  if (fields) first.searchParams.set('fields', fields);
  for (const [key, value] of Object.entries(parameters)) {
    if (key !== 'limit' && value != null && value !== '') first.searchParams.set(key, String(value));
  }
  const items = [];
  let next = first;
  for (let page = 0; next && page < maxPages; page += 1) {
    if (next.protocol !== 'https:' || next.hostname !== 'graph.facebook.com') {
      throw Object.assign(new Error('Meta returned an unsafe paging URL'), { status: 502 });
    }
    const response = await fetch(next, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = String(body?.error?.message || 'Meta data access is unavailable');
      throw Object.assign(new Error(message.slice(0, 300)), { status: 409, code: 'DIVEDEEP_META_DATA_UNAVAILABLE' });
    }
    items.push(...(Array.isArray(body.data) ? body.data : []));
    next = body.paging?.next ? new URL(body.paging.next) : null;
  }
  return items;
}

async function synchronizeMetaCatalog(config, credentials, service) {
  const granted = new Set(credentials.scopes || []);
  const summary = {
    facebookImages: 0,
    facebookPosts: 0,
    instagramImages: 0,
    errors: [],
    permissions: {
      granted: [...granted],
      missing: config.scopes.filter((scope) => !granted.has(scope)),
    },
  };
  if (config.albumImportEnabled && granted.has('user_photos')) {
    try {
      const uploaded = await graphCollection(
        config,
        credentials.accessToken,
        'me/photos',
        'id,name,created_time,link,album{id,name}',
        { type: 'uploaded', limit: 100 }
      );
      const tagged = await graphCollection(
        config,
        credentials.accessToken,
        'me/photos',
        'id,name,created_time,link,album{id,name}',
        { type: 'tagged', limit: 100 }
      ).catch(() => []);
      const photos = [...new Map([...uploaded, ...tagged].map((item) => [String(item.id), item])).values()];
      const result = await service.syncSocialMediaItems(
        credentials.customerId,
        credentials.connectionId,
        'facebook',
        photos.map((item) => ({
          externalItemId: String(item.id),
          itemType: 'image',
          caption: item.name || 'Facebook photo',
          permalink: item.link || '',
          publishedAt: item.created_time || null,
          metadata: { albumId: item.album?.id || null, albumName: item.album?.name || '' },
        }))
      );
      summary.facebookImages = result.synchronized;
    } catch (error) { summary.errors.push({ area: 'facebook_images', message: error.message }); }
  }
  if (config.postImportEnabled && granted.has('user_posts')) {
    try {
      const posts = await graphCollection(
        config,
        credentials.accessToken,
        'me/posts',
        'id,message,story,created_time,permalink_url,full_picture',
        { limit: 100 }
      );
      const result = await service.syncSocialMediaItems(
        credentials.customerId,
        credentials.connectionId,
        'facebook',
        posts.map((item) => ({
          externalItemId: String(item.id),
          itemType: 'post',
          caption: item.message || item.story || 'Facebook post',
          permalink: item.permalink_url || '',
          publishedAt: item.created_time || null,
          metadata: { hasPicture: Boolean(item.full_picture) },
        }))
      );
      summary.facebookPosts = result.synchronized;
    } catch (error) { summary.errors.push({ area: 'facebook_posts', message: error.message }); }
  }
  if (config.instagramMediaImportEnabled &&
      granted.has('instagram_basic') && granted.has('pages_show_list')) {
    try {
      const accounts = await instagramAccounts(config, credentials);
      for (const account of accounts.slice(0, 20)) {
        await service.saveInstagramConnection(credentials.customerId, {
          id: account.id,
          username: account.username,
          pageId: account.pageId,
          scopes: [...granted],
        });
        const media = await graphCollection(
          config,
          account.pageAccessToken,
          `${account.id}/media`,
          'id,caption,media_type,permalink,timestamp,children{id,media_type}',
          { limit: 100 }
        );
        const catalogItems = media.flatMap((item) => {
          if (item.media_type !== 'CAROUSEL_ALBUM' || !Array.isArray(item.children?.data)) return [item];
          return item.children.data.map((child) => ({
            ...child,
            caption: item.caption,
            permalink: item.permalink,
            timestamp: item.timestamp,
            parentId: item.id,
          }));
        });
        const result = await service.syncSocialMediaItems(
          credentials.customerId,
          credentials.connectionId,
          'instagram',
          catalogItems.map((item) => ({
            externalItemId: String(item.id),
            itemType: item.media_type === 'IMAGE' ? 'image' : item.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'video',
            caption: item.caption || 'Instagram media',
            permalink: item.permalink || '',
            publishedAt: item.timestamp || null,
            metadata: {
              accountId: account.id,
              username: account.username,
              mediaType: item.media_type,
              parentId: item.parentId || null,
            },
          }))
        );
        summary.instagramImages += result.synchronized;
      }
    } catch (error) { summary.errors.push({ area: 'instagram_images', message: error.message }); }
  }
  return summary;
}

async function facebookPhotoImage(config, credentials, photoId) {
  const photo = await graphJson(config, credentials.accessToken, graphId(photoId, 'Facebook photo'), 'id,name,images{source,width,height}');
  const image = (photo.images || []).find((item) => item?.source && Number(item.width || 0) >= 320) || photo.images?.[0];
  if (!image?.source) throw Object.assign(new Error('Facebook did not provide an importable photo'), { status: 409 });
  const source = new URL(image.source);
  if (source.protocol !== 'https:' || !isMetaImageHost(source.hostname)) throw Object.assign(new Error('Facebook returned an unsupported image source'), { status: 409 });
  const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
  const size = Number(response.headers.get('content-length') || 0);
  if (!response.ok || (size && size > 5 * 1024 * 1024)) throw Object.assign(new Error('Selected Facebook photo could not be imported'), { status: 409 });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 5 * 1024 * 1024) throw Object.assign(new Error('Selected Facebook photo is larger than 5 MB'), { status: 413 });
  const detected = detectImage(buffer, response.headers.get('content-type'));
  if (!detected) throw Object.assign(new Error('Selected Facebook photo has an unsupported image format'), { status: 415 });
  return { photo, image, buffer, detected };
}

function isMetaImageHost(hostname) {
  return hostname.endsWith('.fbcdn.net') || hostname.endsWith('.cdninstagram.com') || hostname === 'lookaside.fbsbx.com';
}

async function instagramAccounts(config, credentials) {
  const pages = await graphJson(config, credentials.accessToken, 'me/accounts', 'id,name,access_token,instagram_business_account{id,username}');
  return (pages.data || []).filter((page) => page.instagram_business_account?.id && page.access_token)
    .map((page) => ({
      id: String(page.instagram_business_account.id),
      username: String(page.instagram_business_account.username || page.name || 'Instagram'),
      pageId: String(page.id),
      pageAccessToken: String(page.access_token),
    }));
}

async function instagramMediaImage(config, account, mediaId) {
  const media = await graphJson(config, account.pageAccessToken, graphId(mediaId, 'Instagram media'), 'id,caption,media_type,media_url,thumbnail_url');
  const sourceUrl = media.media_type === 'VIDEO' ? media.thumbnail_url : media.media_url;
  if (!sourceUrl) throw Object.assign(new Error('Instagram did not provide an importable image'), { status: 409 });
  const source = new URL(sourceUrl);
  if (source.protocol !== 'https:' || !isMetaImageHost(source.hostname)) throw Object.assign(new Error('Instagram returned an unsupported image source'), { status: 409 });
  const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
  const size = Number(response.headers.get('content-length') || 0);
  if (!response.ok || (size && size > 5 * 1024 * 1024)) throw Object.assign(new Error('Selected Instagram image could not be imported'), { status: 409 });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 5 * 1024 * 1024) throw Object.assign(new Error('Selected Instagram image is larger than 5 MB'), { status: 413 });
  const detected = detectImage(buffer, response.headers.get('content-type'));
  if (!detected) throw Object.assign(new Error('Selected Instagram image has an unsupported image format'), { status: 415 });
  return { media, buffer, detected };
}

async function resolveMetaConfig(integrationService = diveDeepIntegrations) {
  try {
    const stored = await integrationService.getRuntimeIntegration('meta');
    if (stored) {
      const config = stored.config || {};
      const albumImportEnabled = config.albumImportEnabled === true || String(config.albumImportEnabled).toLowerCase() === 'true';
      const postImportEnabled = config.postImportEnabled === true || String(config.postImportEnabled).toLowerCase() === 'true';
      const instagramMediaImportEnabled = config.instagramMediaImportEnabled === true || String(config.instagramMediaImportEnabled).toLowerCase() === 'true';
      return {
        appId: String(config.appId || '').trim(),
        appSecret: String(stored.secrets?.appSecret || '').trim(),
        redirectUri: String(config.redirectUri || '').trim(),
        graphVersion: String(config.graphVersion || '').trim(),
        scopes: [
          'public_profile', 'email', ...(albumImportEnabled ? ['user_photos'] : []),
          ...(postImportEnabled ? ['user_posts'] : []),
          ...(instagramMediaImportEnabled ? ['instagram_basic', 'pages_show_list', 'pages_read_engagement'] : []),
        ],
        albumImportEnabled,
        postImportEnabled,
        instagramMediaImportEnabled,
        enabled: Boolean(config.appId && stored.secrets?.appSecret && config.redirectUri && /^v\d+\.\d+$/.test(config.graphVersion || '')),
        errors: [],
        source: 'vault',
      };
    }
  } catch {
    // Existing installations may reach this route before schema migration.
  }
  return { ...getDiveDeepMetaConfig(), source: 'environment' };
}

async function publicConfig(integrationService = diveDeepIntegrations) {
  const cfg = getDiveDeepConfig();
  const meta = await resolveMetaConfig(integrationService);
  let packages = diveDeepService.DEFAULT_PACKAGES;
  try { packages = await diveDeepService.listPackages({ activeOnly: true }); } catch { /* installer/migration may still be in progress */ }
  return {
    signupsEnabled: cfg.signupsEnabled,
    inviteRequired: cfg.inviteRequired,
    autoApprove: cfg.autoApprove,
    facebookConnectionEnabled: meta.enabled,
    facebookAlbumImportEnabled: Boolean(meta.enabled && meta.albumImportEnabled),
    facebookPostImportEnabled: Boolean(meta.enabled && meta.postImportEnabled),
    instagramMediaImportEnabled: Boolean(meta.enabled && meta.instagramMediaImportEnabled),
    authorizationRequired: true,
    legal: {
      legalEntityName: cfg.legalEntityName,
      privacyContactEmail: cfg.privacyContactEmail,
      termsVersion: cfg.termsVersion,
      privacyVersion: cfg.privacyVersion,
      noticeVersion: cfg.noticeVersion,
      responsibleDataVersion: cfg.responsibleDataVersion,
      electronicRecordsVersion: cfg.electronicRecordsVersion,
      authorizationVersion: cfg.authorizationVersion,
      authorizationValidityDays: cfg.authorizationValidityDays,
    },
    plans: packages.map((item, index) => ({
      id: item.id, level: index + 1, name: item.name, monthlyPrice: item.monthlyPrice ?? (item.monthlyPriceCents / 100),
      description: item.description, sensitive: Boolean(item.restricted || item.sensitive),
    })),
  };
}

function createDiveDeepRouter(dependencies = {}) {
  const service = { ...diveDeepService, ...(dependencies.service || {}) };
  const authorizationService = { ...diveDeepAuthorizations, ...(dependencies.authorizationService || {}) };
  const integrationService = { ...diveDeepIntegrations, ...(dependencies.integrationService || {}) };
  const importService = { ...diveDeepImports, ...(dependencies.importService || {}) };
  const imageAnalysisService = { ...diveDeepImageAnalysis, ...(dependencies.imageAnalysisService || {}) };
  const workflowService = { ...diveDeepWorkflow, ...(dependencies.workflowService || {}) };
  const crmService = { ...diveDeepCrm, ...(dependencies.crmService || {}) };
  const router = express.Router();

  router.use((req, res, next) => {
    req.sentinelOmitBodies = true;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  router.get('/', (req, res) => res.sendFile(page('index.html')));
  router.get('/login', (req, res) => res.sendFile(page('login.html')));
  router.get('/signup', (req, res) => res.sendFile(page('signup.html')));
  router.get('/app', (req, res) => res.sendFile(page('app.html')));
  router.get('/privacy', (req, res) => res.sendFile(page('privacy.html')));
  router.get('/terms', (req, res) => res.sendFile(page('terms.html')));
  router.get('/legal', (req, res) => res.sendFile(page('legal.html')));
  router.get('/notice-at-collection', (req, res) => res.sendFile(page('notice-at-collection.html')));
  router.get('/responsible-data', (req, res) => res.sendFile(page('responsible-data.html')));
  router.get('/authorized-agent', (req, res) => res.sendFile(page('authorized-agent.html')));
  router.get('/electronic-records', (req, res) => res.sendFile(page('electronic-records.html')));
  router.get('/privacy-rights', (req, res) => res.sendFile(page('privacy-rights.html')));
  router.get('/security', (req, res) => res.sendFile(page('security.html')));

  router.get('/api/config', async (req, res) => res.json({ ok: true, config: await publicConfig(integrationService) }));

  router.get('/api/signup-prefill', async (req, res) => {
    const pending = req.session?.diveDeepFacebookSignup;
    return res.json({ ok: true, facebook: pending ? {
      firstName: pending.firstName, lastName: pending.lastName, email: pending.email,
    } : null });
  });

  router.post('/api/signup', customerAuthLimiter, async (req, res) => {
    try {
      const customer = await service.registerCustomer(req.body || {});
      let crmLink = null;
      let crmLinkError = null;
      try {
        crmLink = await crmService.claimSignupContact(customer.id, req.body || {});
      } catch (linkError) {
        crmLinkError = linkError.code || 'DIVEDEEP_CRM_LINK_FAILED';
        recordEvent({
          method: req.method,
          path: '/divedeep/api/signup',
          status_code: 201,
          duration_ms: 0,
          ip: req.ip,
          user_agent: req.get('user-agent'),
          request_id: newRequestId(),
          surface: 'divedeep',
          actor_type: 'customer',
          actor_id: customer.id,
          action: 'divedeep.crm.signup_link_failed',
          entity_type: 'divedeep_customer',
          entity_id: customer.id,
          outcome: 'failure',
          error_class: crmLinkError,
        });
      }
      const pendingFacebook = req.session?.diveDeepFacebookSignup || null;
      await regenerateSession(req);
      req.session.diveDeepCustomer = { id: customer.id };
      if (pendingFacebook) req.session.diveDeepFacebookSignup = pendingFacebook;
      const csrfToken = ensureCustomerCsrf(req);
      await saveSession(req);
      return res.status(201).json({ ok: true, customer, crmLink: crmLink ? { linked: true, id: crmLink.id } : { linked: false, code: crmLinkError }, csrfToken, redirect: customerUiUrl('/divedeep/app') });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/login', customerAuthLimiter, async (req, res) => {
    try {
      const customer = await service.authenticateCustomer(req.body?.email, req.body?.password);
      await regenerateSession(req);
      req.session.diveDeepCustomer = { id: customer.id };
      const csrfToken = ensureCustomerCsrf(req);
      await saveSession(req);
      return res.json({ ok: true, customer, csrfToken, redirect: customerUiUrl('/divedeep/app') });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/logout', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    delete req.session.diveDeepCustomer;
    delete req.session.diveDeepCsrf;
    await saveSession(req);
    return res.json({ ok: true, redirect: customerUiUrl('/divedeep/login') });
  });

  router.get('/api/session', async (req, res) => {
    if (!customerId(req)) return res.json({ ok: true, authenticated: false, config: await publicConfig(integrationService) });
    try {
      const customer = await service.getCustomerById(customerId(req));
      return res.json({
        ok: true,
        authenticated: true,
        customer,
        csrfToken: ensureCustomerCsrf(req),
        config: await publicConfig(integrationService),
      });
    } catch (error) {
      req.session.diveDeepCustomer = null;
      return sendError(res, error);
    }
  });

  router.get('/api/dashboard', requireCustomerSession, async (req, res) => {
    const startedAt = Date.now();
    try {
      const dashboard = await service.getCustomerDashboard(customerId(req), null, { findingPageSize: 20 });
      res.setHeader('Server-Timing', `divedeep-dashboard;dur=${Date.now() - startedAt}`);
      return res.json({ ok: true, dashboard });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/workflow', requireCustomerSession, async (req, res) => {
    try {
      return res.json({ ok: true, workflow: await workflowService.getCustomerWorkflowPresentation(customerId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/workflow/actions/:actionId/complete', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const id = customerId(req);
      req.sentinelControl = { action: 'divedeep.workflow.customer_action.complete', entityType: 'customer_action', entityId: req.params.actionId };
      return res.json({ ok: true, action: await workflowService.completeCustomerAction(id, req.params.actionId, req.body || {}) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/image-analysis/sessions', requireCustomerSession, async (req, res) => {
    try {
      return res.json({
        ok: true,
        sessions: await imageAnalysisService.listCustomerSessions(customerId(req), { limit: req.query.limit }),
        contract: imageAnalysisService.presentationContract(),
      });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/image-analysis/sessions/:sessionId', requireCustomerSession, async (req, res) => {
    try {
      return res.json({
        ok: true,
        ...(await imageAnalysisService.getCustomerPresentationFeed(customerId(req), req.params.sessionId)),
      });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/image-analysis/items/:itemId/validation', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      req.sentinelControl = { action: 'divedeep.image_analysis.customer_validation', entityType: 'image_analysis_item', entityId: req.params.itemId };
      const id = customerId(req);
      const item = await imageAnalysisService.submitCustomerValidation(
        id, req.params.itemId, req.body?.disposition, { note: req.body?.note }
      );
      await workflowService.reconcileReviewTasks(id, `customer:${id}`).catch(() => {});
      return res.json({ ok: true, item });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/findings', requireCustomerSession, async (req, res) => {
    const startedAt = Date.now();
    try {
      const result = await service.getCustomerFindingPage(customerId(req), {
        page: req.query.page,
        pageSize: req.query.pageSize,
      });
      res.setHeader('Server-Timing', `divedeep-findings;dur=${Date.now() - startedAt}`);
      return res.json({ ok: true, ...result });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/authorization', requireCustomerSession, async (req, res) => {
    try {
      return res.json({ ok: true, authorization: await authorizationService.getLatestAuthorization(customerId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/authorization', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const authorization = await authorizationService.signAuthorization(
        customerId(req), req.body || {}, authorizationContext(req)
      );
      return res.status(201).json({ ok: true, authorization, dashboard: await service.getCustomerDashboard(customerId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/authorization/revoke', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const authorization = await authorizationService.revokeAuthorization(
        customerId(req), req.body || {}, authorizationContext(req)
      );
      return res.json({ ok: true, authorization, dashboard: await service.getCustomerDashboard(customerId(req)) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/authorization/:authorizationId/document', requireCustomerSession, async (req, res) => {
    try {
      const document = await authorizationService.readAuthorizationDocument(customerId(req), req.params.authorizationId);
      res.type('text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="divedeep-authorization-${document.id}.html"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(document.html);
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/evidence/:evidenceId', requireCustomerSession, async (req, res) => {
    try {
      const { evidence, buffer } = await importService.readEvidenceFile(customerId(req), req.params.evidenceId, { includeUnpublished: false });
      res.type(evidence.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="divedeep-evidence-${evidence.id}"`);
      return res.send(buffer);
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/onboarding', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const dashboard = await service.completeOnboarding(customerId(req), req.body || {});
      const pendingFacebook = req.session?.diveDeepFacebookSignup;
      if (pendingFacebook) {
        await service.saveFacebookConnection(customerId(req), pendingFacebook);
        delete req.session.diveDeepFacebookSignup;
        await saveSession(req);
      }
      return res.status(201).json({ ok: true, dashboard });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/identifiers', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const identifier = await service.addIdentifier(customerId(req), req.body || {});
      return res.status(201).json({ ok: true, identifier });
    } catch (error) { return sendError(res, error); }
  });

  router.put('/api/policies', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const policy = await service.setVisibilityPolicy(customerId(req), req.body || {});
      return res.json({ ok: true, policy });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/connections', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const dashboard = await service.getCustomerDashboard(customerId(req));
      if (!dashboard.profile) return res.status(409).json({ error: 'Complete profile onboarding first', code: 'DIVEDEEP_PROFILE_REQUIRED' });
      const connection = await service.createSocialConnection(
        customerId(req), dashboard.profile.id, req.body || {}, `customer:${customerId(req)}`
      );
      return res.status(201).json({ ok: true, connection });
    } catch (error) { return sendError(res, error); }
  });

  router.put('/api/connections/:connectionId/protection', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const result = await service.setSocialConnectionProtection(
        customerId(req),
        req.params.connectionId,
        req.body?.protected
      );
      return res.json({ ok: true, ...result });
    } catch (error) { return sendError(res, error); }
  });

  router.delete('/api/connections/:connectionId', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const connection = await service.disconnectSocialConnection(customerId(req), req.params.connectionId);
      return res.json({ ok: true, connection });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/connections/meta/sync', requireCustomerSession, requireCustomerCsrf, customerMetaSyncLimiter, async (req, res) => {
    try {
      const config = await resolveMetaConfig(integrationService);
      if (!config.enabled) return res.status(409).json({ error: 'Meta connection is not enabled' });
      const credentials = await service.getFacebookConnectionCredentials(customerId(req));
      credentials.customerId = customerId(req);
      const summary = await synchronizeMetaCatalog(config, credentials, service);
      return res.json({ ok: true, summary });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/connections/media', requireCustomerSession, async (req, res) => {
    try {
      const items = await service.listSocialMediaItems(customerId(req), {
        provider: req.query.provider,
        itemType: req.query.itemType,
        limit: req.query.limit,
      });
      return res.json({ ok: true, items });
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/api/account/plan', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const customer = await service.updateCustomerPlan(customerId(req), req.body || {});
      return res.json({ ok: true, customer });
    } catch (error) { return sendError(res, error); }
  });

  router.post(
    '/api/photos',
    requireCustomerSession,
    requireCustomerCsrf,
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }),
    async (req, res) => {
      try {
        const detected = detectImage(req.body, req.get('content-type'));
        if (!detected) return res.status(415).json({ error: 'Only valid JPEG, PNG, or WebP images are accepted' });
        const photo = await service.addProfilePhoto(customerId(req), {
          buffer: req.body,
          mimeType: detected.mimeType,
        }, {
          label: req.get('x-divedeep-photo-label') || 'Reference photo',
          originalName: req.get('x-divedeep-file-name') || `profile.${detected.extension}`,
          purpose: req.get('x-divedeep-photo-purpose') || 'identity_search',
        });
        return res.status(201).json({ ok: true, photo });
      } catch (error) { return sendError(res, error); }
    }
  );

  router.get('/api/photos/:photoId', requireCustomerSession, async (req, res) => {
    try {
      const { photo, buffer } = await service.readProfilePhoto(customerId(req), req.params.photoId);
      res.type(photo.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="divedeep-${photo.id}"`);
      return res.send(buffer);
    } catch (error) { return sendError(res, error); }
  });

  router.delete('/api/photos/:photoId', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      return res.json(await service.removeProfilePhoto(customerId(req), req.params.photoId));
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/first-scrub-request', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try { return res.json({ ok: true, dashboard: await service.requestFirstScrub(customerId(req)) }); }
    catch (error) { return sendError(res, error); }
  });

  router.get('/api/connections/facebook/albums', requireCustomerSession, async (req, res) => {
    try {
      const config = await resolveMetaConfig(integrationService);
      if (!config.enabled || !config.albumImportEnabled) return res.status(409).json({ error: 'Facebook album selection is not enabled for this service yet', code: 'DIVEDEEP_FACEBOOK_ALBUM_DISABLED' });
      const credentials = await service.getFacebookConnectionCredentials(customerId(req));
      const body = await graphJson(config, credentials.accessToken, `${graphId(credentials.externalUserId, 'Facebook user')}/albums`, 'id,name,count');
      return res.json({ ok: true, albums: (body.data || []).map((item) => ({ id: String(item.id), name: String(item.name || 'Untitled album'), count: Number(item.count) || 0 })) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/connections/facebook/albums/:albumId/photos', requireCustomerSession, async (req, res) => {
    try {
      const config = await resolveMetaConfig(integrationService);
      if (!config.enabled || !config.albumImportEnabled) return res.status(409).json({ error: 'Facebook album selection is not enabled for this service yet' });
      const credentials = await service.getFacebookConnectionCredentials(customerId(req));
      const body = await graphJson(config, credentials.accessToken, `${graphId(req.params.albumId, 'Facebook album')}/photos`, 'id,name,created_time');
      return res.json({ ok: true, photos: (body.data || []).map((item) => ({ id: String(item.id), name: String(item.name || 'Facebook photo'), createdTime: item.created_time || null })) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/connections/facebook/photos/:photoId/preview', requireCustomerSession, async (req, res) => {
    try {
      const config = await resolveMetaConfig(integrationService);
      if (!config.enabled || !config.albumImportEnabled) return res.status(409).end();
      const image = await facebookPhotoImage(config, await service.getFacebookConnectionCredentials(customerId(req)), req.params.photoId);
      res.type(image.detected.mimeType); res.setHeader('Cache-Control', 'private, no-store'); return res.send(image.buffer);
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/connections/facebook/photos/:photoId/whitelist', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const config = await resolveMetaConfig(integrationService);
      if (!config.enabled || !config.albumImportEnabled) return res.status(409).json({ error: 'Facebook album selection is not enabled for this service yet' });
      const image = await facebookPhotoImage(config, await service.getFacebookConnectionCredentials(customerId(req)), req.params.photoId);
      const photo = await service.addProfilePhoto(customerId(req), { buffer: image.buffer, mimeType: image.detected.mimeType }, {
        label: String(req.body?.label || image.photo.name || 'Facebook album reference').slice(0, 255),
        originalName: `facebook-${req.params.photoId}.${image.detected.extension}`,
        purpose: req.body?.purpose || 'identity_search',
      });
      await service.markSocialMediaWhitelisted(customerId(req), 'facebook', req.params.photoId, photo.id);
      return res.status(201).json({ ok: true, photo });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/connections/instagram/accounts', requireCustomerSession, async (req, res) => {
    try {
      const config = await resolveMetaConfig(integrationService);
      if (!config.enabled || !config.instagramMediaImportEnabled) return res.status(409).json({ error: 'Instagram media selection is not enabled for this service yet' });
      const accounts = await instagramAccounts(config, await service.getFacebookConnectionCredentials(customerId(req)));
      return res.json({ ok: true, accounts: accounts.map(({ id, username }) => ({ id, username })) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/api/connections/instagram/accounts/:accountId/media', requireCustomerSession, async (req, res) => {
    try {
      const config = await resolveMetaConfig(integrationService);
      if (!config.enabled || !config.instagramMediaImportEnabled) return res.status(409).json({ error: 'Instagram media selection is not enabled for this service yet' });
      const accountId = graphId(req.params.accountId, 'Instagram account');
      const accounts = await instagramAccounts(config, await service.getFacebookConnectionCredentials(customerId(req)));
      const account = accounts.find((item) => item.id === accountId);
      if (!account) return res.status(404).json({ error: 'Linked Instagram account not found' });
      const body = await graphJson(config, account.pageAccessToken, `${accountId}/media`, 'id,caption,media_type,media_url,thumbnail_url,timestamp');
      return res.json({ ok: true, media: (body.data || []).filter((item) => item.media_type === 'IMAGE').map((item) => ({ id: String(item.id), caption: String(item.caption || 'Instagram image'), mediaType: item.media_type, timestamp: item.timestamp || null })) });
    } catch (error) { return sendError(res, error); }
  });

  async function resolveInstagramMedia(req) {
    const config = await resolveMetaConfig(integrationService);
    if (!config.enabled || !config.instagramMediaImportEnabled) throw Object.assign(new Error('Instagram media selection is not enabled for this service yet'), { status: 409 });
    const accounts = await instagramAccounts(config, await service.getFacebookConnectionCredentials(customerId(req)));
    const account = accounts.find((item) => item.id === graphId(req.params.accountId, 'Instagram account'));
    if (!account) throw Object.assign(new Error('Linked Instagram account not found'), { status: 404 });
    return instagramMediaImage(config, account, req.params.mediaId);
  }

  router.get('/api/connections/instagram/accounts/:accountId/media/:mediaId/preview', requireCustomerSession, async (req, res) => {
    try {
      const image = await resolveInstagramMedia(req);
      res.type(image.detected.mimeType); res.setHeader('Cache-Control', 'private, no-store'); return res.send(image.buffer);
    } catch (error) { return sendError(res, error); }
  });

  router.post('/api/connections/instagram/accounts/:accountId/media/:mediaId/whitelist', requireCustomerSession, requireCustomerCsrf, async (req, res) => {
    try {
      const image = await resolveInstagramMedia(req);
      const photo = await service.addProfilePhoto(customerId(req), { buffer: image.buffer, mimeType: image.detected.mimeType }, {
        label: String(req.body?.label || image.media.caption || 'Instagram reference').slice(0, 255),
        originalName: `instagram-${req.params.mediaId}.${image.detected.extension}`,
        purpose: req.body?.purpose || 'identity_search',
      });
      await service.markSocialMediaWhitelisted(customerId(req), 'instagram', req.params.mediaId, photo.id);
      return res.status(201).json({ ok: true, photo });
    } catch (error) { return sendError(res, error); }
  });

  async function beginFacebookOAuth(req, res, flow = 'connection') {
    const config = await resolveMetaConfig(integrationService);
    if (!config.enabled) return res.redirect(customerUiUrl('/divedeep/app?connection=facebook-unavailable'));
    const state = crypto.randomBytes(24).toString('base64url');
    req.session.diveDeepMetaState = { state, createdAt: Date.now(), flow };
    const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', config.scopes.join(','));
    return req.session.save((error) => {
      if (error) return res.redirect(customerUiUrl('/divedeep/app?connection=facebook-session-error'));
      return res.redirect(url.toString());
    });
  }

  router.get('/connect/facebook', requireCustomerSession, async (req, res) => beginFacebookOAuth(req, res, 'connection'));

  router.get('/connect/facebook/signup', async (req, res) => {
    const config = await resolveMetaConfig(integrationService);
    if (!config.enabled) return res.redirect(customerUiUrl('/divedeep/signup?social=facebook-unavailable'));
    return beginFacebookOAuth(req, res, 'signup');
  });

  router.get('/connect/facebook/callback', async (req, res) => {
    const config = await resolveMetaConfig(integrationService);
    const intent = req.session.diveDeepMetaState;
    req.session.diveDeepMetaState = null;
    try {
      if (!config.enabled || req.query.error || !intent || !req.query.state || !req.query.code) throw new Error('Facebook connection was not completed');
      if (intent.flow !== 'signup' && !customerId(req)) throw new Error('Sign in before connecting Facebook');
      if (Date.now() - Number(intent.createdAt || 0) > 10 * 60 * 1000) throw new Error('Facebook connection request expired');
      const supplied = String(req.query.state);
      const expected = String(intent.state);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        throw new Error('Facebook connection state validation failed');
      }
      const tokenUrl = new URL(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token`);
      tokenUrl.searchParams.set('client_id', config.appId);
      tokenUrl.searchParams.set('client_secret', config.appSecret);
      tokenUrl.searchParams.set('redirect_uri', config.redirectUri);
      tokenUrl.searchParams.set('code', String(req.query.code));
      const tokenResponse = await fetch(tokenUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenData.access_token) throw new Error('Facebook token exchange failed');
      let accessToken = tokenData.access_token;
      let expiresIn = Number(tokenData.expires_in) || 0;
      try {
        const longLivedUrl = new URL(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token`);
        longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token');
        longLivedUrl.searchParams.set('client_id', config.appId);
        longLivedUrl.searchParams.set('client_secret', config.appSecret);
        longLivedUrl.searchParams.set('fb_exchange_token', accessToken);
        const longLivedResponse = await fetch(longLivedUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        const longLived = await longLivedResponse.json().catch(() => ({}));
        if (longLivedResponse.ok && longLived.access_token) {
          accessToken = longLived.access_token;
          expiresIn = Number(longLived.expires_in) || expiresIn;
        }
      } catch { /* retain the valid short-lived token if exchange is unavailable */ }
      const meUrl = new URL(`https://graph.facebook.com/${config.graphVersion}/me`);
      meUrl.searchParams.set('fields', 'id,name,email,link');
      meUrl.searchParams.set('access_token', accessToken);
      meUrl.searchParams.set('appsecret_proof', crypto.createHmac('sha256', config.appSecret).update(accessToken).digest('hex'));
      const meResponse = await fetch(meUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const me = await meResponse.json();
      if (!meResponse.ok || !me.id) throw new Error('Facebook profile lookup failed');
      const permissions = await graphJson(config, accessToken, 'me/permissions', 'permission,status')
        .catch(() => ({ data: [] }));
      const grantedScopes = (permissions.data || [])
        .filter((item) => item.status === 'granted')
        .map((item) => String(item.permission));
      const declinedScopes = (permissions.data || [])
        .filter((item) => item.status !== 'granted')
        .map((item) => String(item.permission));
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
      const connection = {
        id: String(me.id),
        name: me.name || '',
        link: me.link || `https://www.facebook.com/${me.id}`,
        scopes: grantedScopes,
        accessToken,
        tokenExpiresAt: expiresAt,
        metadata: {
          email: me.email || '',
          importedFields: Object.keys(me),
          requestedScopes: config.scopes,
          declinedScopes,
          permissionsCheckedAt: new Date().toISOString(),
        },
      };
      if (intent.flow === 'signup') {
        const [firstName = '', ...remaining] = String(me.name || '').trim().split(/\s+/).filter(Boolean);
        req.session.diveDeepFacebookSignup = { ...connection, firstName, lastName: remaining.join(' '), email: me.email || '' };
        return req.session.save((error) => error
          ? res.redirect(customerUiUrl('/divedeep/signup?social=facebook-failed'))
          : res.redirect(customerUiUrl('/divedeep/signup?social=facebook')));
      }
      await service.saveFacebookConnection(customerId(req), connection);
      return res.redirect(customerUiUrl('/divedeep/app?connection=facebook-connected'));
    } catch (error) {
      console.warn('DiveDeep Facebook connection failed:', error.message);
      return res.redirect(customerUiUrl('/divedeep/app?connection=facebook-failed'));
    }
  });

  return router;
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
  });
}

module.exports = { createDiveDeepRouter, publicConfig, resolveMetaConfig };
