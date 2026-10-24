const express = require('express');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { ROOT, getAdminBasePath } = require('../config');
const { requireAdminSession } = require('../middleware/sessionAuth');

const DOCS_DIR = path.join(ROOT, 'content', 'docs');

/** Preferred reading order for integrators / AI agents */
const DOC_ORDER = [
  'index',
  'getting-started',
  'architecture',
  'instance-identity',
  'authentication',
  'ai-help',
  'vibe-integration',
  'users',
  'location-sync',
  'sessions',
  'sql-connections',
  'owl',
  'eagle',
  'crm-imports',
  'leads',
  'performance',
  'schedules',
  'logging',
  'sentinel',
  'cors',
  'errors',
  'endpoint-index',
];

function listDocFiles() {
  if (!fs.existsSync(DOCS_DIR)) return [];
  const files = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const slug = f.replace(/\.md$/, '');
      const raw = fs.readFileSync(path.join(DOCS_DIR, f), 'utf8');
      const titleMatch = raw.match(/^#\s+(.+)$/m);
      return {
        slug,
        title: titleMatch ? titleMatch[1].trim() : slug,
        file: f,
      };
    });

  files.sort((a, b) => {
    const ia = DOC_ORDER.indexOf(a.slug);
    const ib = DOC_ORDER.indexOf(b.slug);
    if (ia === -1 && ib === -1) return a.title.localeCompare(b.title);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return files;
}

function renderDocPage({ title, bodyHtml, nav, activeSlug, username, adminBase }) {
  const navHtml = nav
    .map(
      (item) =>
        `<a class="docs-nav-link${item.slug === activeSlug ? ' active' : ''}" href="${adminBase}/docs/${item.slug === 'index' ? '' : item.slug}">${escapeHtml(item.title)}</a>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(title)} · Docs</title>
  <link rel="stylesheet" href="/css/app.css" />
</head>
<body class="docs-layout">
  <header class="topbar">
    <span class="brand">Control panel</span>
    <nav class="topbar-nav">
      <a href="${adminBase}/docs">Docs</a>
      <a href="${adminBase}">Dashboard</a>
      <a href="${adminBase}/keys">API Keys</a>
      <a href="${adminBase}/sentinel">Sentinel</a>
      <span class="muted">${escapeHtml(username || '')}</span>
    </nav>
  </header>
  <div class="docs-shell">
    <aside class="docs-sidebar">
      <div class="docs-sidebar-title">Documentation</div>
      ${navHtml}
    </aside>
    <main class="docs-content prose">
      ${bodyHtml}
    </main>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createDocsRouter() {
  const router = express.Router();
  router.use(requireAdminSession);

  router.get('/', (req, res) => {
    serveSlug(req, res, 'index');
  });

  router.get('/:slug', (req, res) => {
    serveSlug(req, res, req.params.slug);
  });

  function serveSlug(req, res, slug) {
    const adminBase = getAdminBasePath();
    const safe = String(slug || 'index').replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = path.join(DOCS_DIR, `${safe}.md`);
    const username = req.session.admin && req.session.admin.username;
    if (!fs.existsSync(filePath)) {
      return res.status(404).send(
        renderDocPage({
          title: 'Not found',
          bodyHtml: '<h1>Not found</h1><p>This page does not exist yet.</p>',
          nav: listDocFiles(),
          activeSlug: safe,
          username,
          adminBase,
        })
      );
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const titleMatch = raw.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : safe;
    const bodyHtml = marked.parse(raw);
    res.send(
      renderDocPage({
        title,
        bodyHtml,
        nav: listDocFiles(),
        activeSlug: safe,
        username,
        adminBase,
      })
    );
  }

  return router;
}

module.exports = { createDocsRouter, listDocFiles };
