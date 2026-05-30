import 'dotenv/config';
import http from 'node:http';

const PORT = process.env.PORT || 3000;
const BITRIX24_WEBHOOK_URL = process.env.BITRIX24_WEBHOOK_URL;

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

async function bitrixCall(method, params = {}) {
  if (!BITRIX24_WEBHOOK_URL) {
    throw new Error('BITRIX24_WEBHOOK_URL is not configured');
  }
  const base = BITRIX24_WEBHOOK_URL.endsWith('/') ? BITRIX24_WEBHOOK_URL : `${BITRIX24_WEBHOOK_URL}/`;
  const response = await fetch(`${base}${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error_description || data.error || `Bitrix24 HTTP ${response.status}`);
  }
  return data.result;
}

const tools = [
  {
    name: 'bitrix24.call',
    description: 'Call any Bitrix24 REST method through the configured webhook.',
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
  }
];

async function handleRpc(body) {
  const id = body?.id ?? null;
  const method = body?.method;
  const params = body?.params || {};

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bitrix24-mcp-server', version: '1.0.0' } } };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools } };
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    let result;
    if (name === 'bitrix24.call') result = await bitrixCall(args.method, args.params || {});
    else if (name === 'crm.deal.list') result = await bitrixCall('crm.deal.list', args);
    else if (name === 'crm.deal.add') result = await bitrixCall('crm.deal.add', args);
    else throw new Error(`Unknown tool: ${name}`);
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
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
      return json(res, 200, { ok: true, bitrixWebhookConfigured: Boolean(BITRIX24_WEBHOOK_URL) });
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', async () => {
        try {
          const body = raw ? JSON.parse(raw) : {};
          const response = await handleRpc(body);
          if (response === null) return res.writeHead(204).end();
          return json(res, 200, response);
        } catch (error) {
          return json(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32000, message: error.message } });
        }
      });
      return;
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Bitrix24 MCP server listening on ${PORT}`);
});
