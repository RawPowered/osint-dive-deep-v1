const express = require('express');
const { listCommands, getCommand, publicApiPath, catalogMeta } = require('../../services/apiHelp');
const { getInstanceIdentity } = require('../../instanceIdentity');

function createApiHelpRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    const meta = catalogMeta(getBaseUrl(req));
    res.setHeader('Cache-Control', 'no-store');
    const identity = getInstanceIdentity();
    if (identity.metadataHeadersEnabled) {
      res.setHeader(`X-${identity.metadataHeaderPrefix}-API-Version`, meta.version);
      res.setHeader(`X-${identity.metadataHeaderPrefix}-Schema-Version`, meta.schemaVersion);
    }
    next();
  });

  router.get('/openapi.json', (req, res) => {
    res.json(buildOpenApi(getBaseUrl(req)));
  });

  router.post('/validate', (req, res) => {
    const input = req.body || {};
    const item = getCommand(input.command || input.id);
    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Unknown command',
        hint: `GET ${publicApiPath('help')} to list command IDs`,
      });
    }
    const validation = validateRequest(item, input);
    return res.json({
      success: true,
      command: item.id,
      valid: validation.missing.length === 0,
      missing: validation.missing,
      warnings: validation.warnings,
      request: buildRequest(item, input, getBaseUrl(req)),
    });
  });

  router.get('/:command', (req, res) => {
    const item = getCommand(req.params.command);
    if (!item) {
      return res.status(404).json({
        error: 'Unknown command',
        hint: `GET ${publicApiPath('help')} to list command IDs`,
      });
    }
    const detail = commandDetail(item, getBaseUrl(req));
    if (wantsText(req)) return sendText(res, renderCommandText(detail));
    return res.json({ success: true, ...detail });
  });

  router.get('/', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim().toLowerCase();
    const commands = listCommands().filter((item) => {
      if (category && item.category.toLowerCase() !== category) return false;
      if (!q) return true;
      return [item.id, item.category, item.method, item.path, item.summary]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
    const result = {
      success: true,
      ...catalogMeta(getBaseUrl(req)),
      filters: { q: q || null, category: category || null },
      count: commands.length,
      commands: commands.map(commandSummary),
    };
    if (wantsText(req)) return sendText(res, renderCatalogText(result));
    return res.json(result);
  });

  return router;
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function wantsText(req) {
  return String(req.query.format || '').toLowerCase() === 'text' ||
    String(req.get('accept') || '').includes('text/plain');
}

function sendText(res, value) {
  res.type('text/plain; charset=utf-8').send(value);
}

function commandSummary(item) {
  return {
    id: item.id,
    category: item.category,
    method: item.method,
    path: item.path,
    summary: item.summary,
    access: item.access,
    required: item.required,
    anyOf: item.anyOf,
  };
}

function commandDetail(item, baseUrl) {
  const example = withRequiredHeaderExamples(item, item.example || {});
  return {
    command: item,
    request: buildRequest(item, example, baseUrl),
    validateWith: {
      method: 'POST',
      path: publicApiPath('help/validate'),
      body: { command: item.id, ...example },
    },
  };
}

function withRequiredHeaderExamples(item, input) {
  const headers = { ...(input.headers || {}) };
  for (const name of item.required.headers || []) {
    if (!headers[name]) headers[name] = name === 'X-Operator-Token' ? '$OPERATOR_SESSION_TOKEN' : 'HEADER_VALUE';
  }
  return Object.keys(headers).length ? { ...input, headers } : input;
}

function getSource(input, source) {
  if (source === 'path') return input.path || input.pathParams || {};
  if (source === 'query') return input.query || {};
  if (source === 'body') return input.body || {};
  if (source === 'headers') return input.headers || {};
  if (source === 'queryOrBody') return { ...(input.query || {}), ...(input.body || {}) };
  return {};
}

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

function validateRequest(item, input) {
  const missing = [];
  const warnings = [];
  for (const source of ['headers', 'path', 'query', 'body']) {
    const values = getSource(input, source);
    for (const field of item.required[source] || []) {
      if (field === '*') {
        if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
          missing.push(`${source}: non-empty JSON object`);
        }
      } else if (!present(values[field])) {
        missing.push(`${source}.${field}`);
      }
    }
  }
  for (const group of item.anyOf || []) {
    const values = getSource(input, group.source);
    const matches = group.fields.filter((field) => present(values[field]));
    const valid = group.mode === 'all' ? matches.length === group.fields.length : matches.length > 0;
    if (!valid) {
      missing.push(`${group.source}: ${group.label || group.fields.join(' or ')}`);
    }
  }

  for (const source of ['headers', 'path', 'query', 'body']) {
    const values = getSource(input, source);
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    const known = new Set([
      ...(item.required[source] || []),
      ...(item.optional[source] || []),
      ...item.anyOf.filter((group) => group.source === source).flatMap((group) => group.fields),
    ]);
    if (known.has('*')) continue;
    for (const field of Object.keys(values)) {
      if (!known.has(field)) warnings.push(`Unknown ${source} field: ${field}`);
    }
  }
  return { missing, warnings };
}

function buildRequest(item, input, baseUrl) {
  const pathValues = input.path || input.pathParams || {};
  let path = item.path;
  for (const field of item.required.path || []) {
    path = path.replace(`{${field}}`, encodeURIComponent(pathValues[field] || field.toUpperCase()));
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query || {})) {
    if (value != null) query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const url = `${baseUrl}${path}${query.toString() ? `?${query}` : ''}`;
  const body = input.body && Object.keys(input.body).length ? input.body : null;
  const headers = { Authorization:'Bearer $INSTANCE_API_KEY' };
  const parts = [
    'curl.exe -s',
    `-X ${item.method}`,
    '-H "Authorization: Bearer $INSTANCE_API_KEY"',
  ];
  for (const name of item.required.headers || []) {
    const value = input.headers?.[name] || (name === 'X-Operator-Token' ? '$OPERATOR_SESSION_TOKEN' : `$${name.toUpperCase().replace(/-/g, '_')}`);
    headers[name] = value;
    parts.push(`-H "${name}: ${value}"`);
  }
  if (body) {
    parts.push('-H "Content-Type: application/json"');
    parts.push(`--data '${JSON.stringify(body)}'`);
  }
  parts.push(`"${url}"`);
  return { method: item.method, url, headers, body, curl: parts.join(' ') };
}

function renderCatalogText(result) {
  const lines = [
    `${result.name} v${result.version} (schema ${result.schemaVersion})`,
    `Base: ${result.baseUrl}`,
    'Auth: Authorization: Bearer $INSTANCE_API_KEY',
    '',
    'Help commands:',
    `  GET  ${publicApiPath('help')}?format=text`,
    `  GET  ${publicApiPath('help/{command}')}?format=text`,
    `  POST ${publicApiPath('help/validate')}`,
    `  GET  ${publicApiPath('help/openapi.json')}`,
    '',
  ];
  let lastCategory = null;
  for (const item of result.commands) {
    if (item.category !== lastCategory) {
      lines.push(`[${item.category}]`);
      lastCategory = item.category;
    }
    lines.push(`  ${item.id.padEnd(27)} ${item.method.padEnd(6)} ${item.path}`);
    lines.push(`    ${item.summary}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderCommandText(detail) {
  const item = detail.command;
  const lines = [
    `${item.id}: ${item.summary}`,
    `${item.method} ${item.path}`,
    'Auth: Authorization: Bearer $INSTANCE_API_KEY',
    `Access: ${item.access}`,
  ];
  for (const source of ['headers', 'path', 'query', 'body']) {
    if ((item.required[source] || []).length) {
      const requiredLabel = item.required[source].includes('*')
        ? 'non-empty JSON object'
        : item.required[source].join(', ');
      lines.push(`Required ${source}: ${requiredLabel}`);
    }
    if ((item.optional[source] || []).length) {
      lines.push(`Optional ${source}: ${item.optional[source].join(', ')}`);
    }
  }
  for (const group of item.anyOf) lines.push(`Requires ${group.label || group.fields.join(' or ')}`);
  for (const note of item.notes) lines.push(`Note: ${note}`);
  lines.push('', 'Example:', detail.request.curl, '', 'Validate without executing:',
    `POST ${publicApiPath('help/validate')} {"command":"${item.id}","query":{},"body":{},"path":{}}`);
  return `${lines.join('\n')}\n`;
}

function buildOpenApi(baseUrl) {
  const paths = {};
  const identity = getInstanceIdentity();
  const requirementsExtension = `x-${identity.automationNamespace}-requirements`;
  const accessExtension = `x-${identity.automationNamespace}-access`;
  for (const item of listCommands()) {
    if (!paths[item.path]) paths[item.path] = {};
    const parameters = [];
    for (const name of item.required.path || []) {
      parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    }
    for (const name of [...(item.required.query || []), ...(item.optional.query || [])]) {
      parameters.push({ name, in: 'query', required: (item.required.query || []).includes(name), schema: { type: 'string' } });
    }
    for (const name of [...(item.required.headers || []), ...(item.optional.headers || [])]) {
      parameters.push({ name, in:'header', required:(item.required.headers || []).includes(name), schema:{ type:'string' } });
    }
    const bodyFields = [...new Set([...(item.required.body || []), ...(item.optional.body || [])])]
      .filter((name) => name !== '*');
    const operation = {
      operationId: item.id,
      tags: [item.category],
      summary: item.summary,
      security: (item.required.headers || []).includes('X-Operator-Token')
        ? [{ bearerAuth: [], operatorToken: [] }]
        : [{ bearerAuth: [] }],
      parameters,
      responses: {
        200: { description: 'Success' },
        400: { description: 'Invalid request' },
        401: { description: 'Missing or invalid API key' },
      },
      [requirementsExtension]: { required: item.required, anyOf: item.anyOf, optional: item.optional },
      [accessExtension]: item.access,
    };
    if (bodyFields.length || (item.example && item.example.body)) {
      operation.requestBody = {
        required: (item.required.body || []).length > 0,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: (item.required.body || []).filter((name) => name !== '*'),
              properties: Object.fromEntries(bodyFields.map((name) => [name, {}])),
              additionalProperties: true,
            },
            example: item.example.body || undefined,
          },
        },
      };
    }
    paths[item.path][item.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: { title: identity.apiDisplayName, version: require('../../../package.json').version },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: `${identity.apiKeyPrefix}...` },
        operatorToken: { type:'apiKey', in:'header', name:'X-Operator-Token' },
      },
    },
  };
}

module.exports = {
  createApiHelpRouter,
  validateRequest,
  buildRequest,
  buildOpenApi,
  renderCatalogText,
};
