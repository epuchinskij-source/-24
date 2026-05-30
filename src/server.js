import 'dotenv/config';
import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const RAW_BITRIX24_WEBHOOK_URL = process.env.BITRIX24_WEBHOOK_URL?.trim();
const BITRIX24_WEBHOOK_URL = RAW_BITRIX24_WEBHOOK_URL?.replace(/^BITRIX24_WEBHOOK_URL\s*=\s*/i, '').trim();
const TIMEOUT_MS = Number(process.env.B24_TIMEOUT_MS || 20000);
const ALLOWED_METHODS = new Set(
  (process.env.B24_ALLOWED_METHODS || 'profile,crm.deal.list,crm.deal.add,crm.lead.list,crm.lead.add,crm.contact.list,crm.company.list')
    .split(',')
    .map((method) => method.trim())
    .filter(Boolean)
);

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

function getWebhookBaseUrl() {
  if (!BITRIX24_WEBHOOK_URL) {
    throw new Error('BITRIX24_WEBHOOK_URL is not configured. Set it in .env or in the MCP client env section.');
  }

  const withoutProfile = BITRIX24_WEBHOOK_URL.replace(/\/profile\.json$/i, '');
  return withoutProfile.endsWith('/') ? withoutProfile : `${withoutProfile}/`;
}

function normalizeMethod(method) {
  if (!method || typeof method !== 'string') {
    throw new Error('Bitrix24 method is required');
  }

  return method.replace(/^\/+/, '').replace(/\.json$/i, '').trim();
}

async function bitrixCall(method, params = {}) {
  const normalizedMethod = normalizeMethod(method);

  if (!ALLOWED_METHODS.has(normalizedMethod)) {
    throw new Error(`Bitrix24 method is not allowed: ${normalizedMethod}. Add it to B24_ALLOWED_METHODS if needed.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${getWebhookBaseUrl()}${normalizedMethod}.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.error) {
      throw new Error(data.error_description || data.error || `Bitrix24 HTTP ${response.status}`);
    }

    return data.result ?? data;
  } finally {
    clearTimeout(timeout);
  }
}

const tools = [
  {
    name: 'bitrix24.call',
    description: 'Call an allowlisted Bitrix24 REST method through the configured webhook.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'Bitrix24 REST method, for example crm.deal.list' },
        params: { type: 'object', description: 'REST method parameters' }
      },
      required: ['method']
    }
  },
  {
    name: 'bitrix24.profile',
    description: 'Check configured Bitrix24 webhook profile.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'crm.deal.list',
    description: 'List CRM deals from Bitrix24.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'object' },
        select: { type: 'array', items: { type: 'string' } },
        order: { type: 'object' },
        start: { type: ['number', 'string'] }
      }
    }
  },
  {
    name: 'crm.deal.add',
    description: 'Create a CRM deal in Bitrix24.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'object' },
        params: { type: 'object' }
      },
      required: ['fields']
    }
  },
  {
    name: 'crm.lead.list',
    description: 'List CRM leads from Bitrix24.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'object' },
        select: { type: 'array', items: { type: 'string' } },
        order: { type: 'object' },
        start: { type: ['number', 'string'] }
      }
    }
  },
  {
    name: 'crm.lead.add',
    description: 'Create a CRM lead in Bitrix24.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'object' },
        params: { type: 'object' }
      },
      required: ['fields']
    }
  }
];

async function handleRpc(body) {
  const id = body?.id ?? null;
  const method = body?.method;
  const params = body?.params || {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'bitrix24-mcp-server', version: '1.0.2' }
      }
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools } };
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};

    let result;
    if (name === 'bitrix24.call') result = await bitrixCall(args.method, args.params || {});
    else if (name === 'bitrix24.profile') result = await bitrixCall('profile');
    else if (name === 'crm.deal.list') result = await bitrixCall('crm.deal.list', args);
    else if (name === 'crm.deal.add') result = await bitrixCall('crm.deal.add', args);
    else if (name === 'crm.lead.list') result = await bitrixCall('crm.lead.list', args);
    else if (name === 'crm.lead.add') result = await bitrixCall('crm.lead.add', args);
    else throw new Error(`Unknown tool: ${name}`);

    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    };
  }

  if (method === 'notifications/initialized') return null;

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      return json(res, 200, { ok: true, name: 'bitrix24-mcp-server', mcp: '/mcp', health: '/health' });
    }

    if (req.method === 'GET' && req.url === '/health') {
      return json(res, BITRIX24_WEBHOOK_URL ? 200 : 503, {
        ok: Boolean(BITRIX24_WEBHOOK_URL),
        bitrixWebhookConfigured: Boolean(BITRIX24_WEBHOOK_URL),
        webhookValueLooksMisconfigured: Boolean(RAW_BITRIX24_WEBHOOK_URL?.startsWith('BITRIX24_WEBHOOK_URL=')),
        allowedMethods: [...ALLOWED_METHODS]
      });
    }

    if (req.method === 'POST' && req.url === '/mcp') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', async () => {
        try {
          const body = raw ? JSON.parse(raw) : {};
          const response = await handleRpc(body);
          if (response === null) return res.writeHead(204).end();
          return json(res, 200, response);
        } catch (error) {
          return json(res, 500, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
          });
        }
      });
      return;
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`Bitrix24 MCP server listening on ${PORT}`);
});
