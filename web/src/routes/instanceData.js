const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const { ROOT } = require('../config');
const { getInstanceIdentity, schemaUrn } = require('../instanceIdentity');

const ALLOWED_EXTENSIONS = new Set(['.json', '.md']);

function createInstanceDataRouter() {
  const router = express.Router();

  router.get('/:filename', async (req, res, next) => {
    const filename = String(req.params.filename || '');
    const extension = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension) || path.basename(filename) !== filename) return next();
    const sourcePath = path.join(ROOT, 'public', 'data', filename);
    let source;
    try {
      source = await fs.readFile(sourcePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return next();
      return next(error);
    }

    const output = materializeInstanceData(source, req, filename);
    if (extension === '.json') {
      try { JSON.parse(output); }
      catch { return res.status(500).json({ error: 'Instance data template is invalid' }); }
      res.type('application/json');
    } else {
      res.type('text/markdown; charset=utf-8');
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(output);
  });

  return router;
}

function materializeInstanceData(source, req, filename = '') {
  const identity = getInstanceIdentity();
  const origin = req ? `${req.protocol}://${req.get('host')}` : 'https://instance.invalid';
  const tokens = {
    apiUrl: '__INSTANCE_API_URL_4a79e8__',
    origin: '__INSTANCE_ORIGIN_4a79e8__',
    apiPath: '__INSTANCE_API_PATH_4a79e8__',
    webhookPath: '__INSTANCE_WEBHOOK_PATH_4a79e8__',
  };
  return String(source)
    .replace(/https:\/\/api\.divedeep\.com\/api(?=\/|\b)/gi, tokens.apiUrl)
    .replace(/https:\/\/api\.divedeep\.com/gi, tokens.origin)
    .replace(/\/api(?=\/|\b)/g, tokens.apiPath)
    .replace(/\/hooks(?=\/|\b)/g, tokens.webhookPath)
    .replace(/divedeep\./g, `${identity.automationNamespace}.`)
    .replace(/sp_live_/g, identity.apiKeyPrefix)
    .replace(/DiveDeep/g, identity.apiDisplayName)
    .replace(
      /"\$id"\s*:\s*"[^"]*(hawk-automation-import|parrot-script-import|song-vibe-import)[^"]*"/g,
      (_, schema) => `"$id": "${schemaUrn(schema || path.basename(filename, extensionOf(filename)))}"`
    )
    .replaceAll(tokens.apiUrl, `${origin}${identity.publicApiBasePath}`)
    .replaceAll(tokens.origin, origin)
    .replaceAll(tokens.apiPath, identity.publicApiBasePath)
    .replaceAll(tokens.webhookPath, identity.webhookBasePath);
}

function extensionOf(filename) {
  return path.extname(filename);
}

module.exports = { createInstanceDataRouter, materializeInstanceData };
