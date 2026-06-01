import 'dotenv/config';
import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const RAW_BITRIX24_WEBHOOK_URL = process.env.BITRIX24_WEBHOOK_URL?.trim();
const BITRIX24_WEBHOOK_URL = RAW_BITRIX24_WEBHOOK_URL?.replace(/^BITRIX24_WEBHOOK_URL\s*=\s*/i, '').trim();
const TIMEOUT_MS = Number(process.env.B24_TIMEOUT_MS || 20000);
const PHOTO_UPLOAD_TOKEN = process.env.PHOTO_UPLOAD_TOKEN?.trim();
const MAX_PHOTO_BYTES = Number(process.env.MAX_PHOTO_BYTES || 25 * 1024 * 1024);
const ALLOWED_METHODS = new Set(
  (process.env.B24_ALLOWED_METHODS || 'profile,crm.deal.list,crm.deal.add,crm.lead.list,crm.lead.add,crm.contact.list,crm.company.list,disk.storage.getlist,disk.storage.getchildren,disk.folder.getchildren,disk.folder.uploadfile,disk.storage.uploadfile,disk.folder.addsubfolder')
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

function sanitizeFileName(name) {
  const safe = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  return safe || `iphone-photo-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
}

function normalizeBase64(base64) {
  if (!base64 || typeof base64 !== 'string') {
    throw new Error('fileBase64 is required');
  }

  const commaIndex = base64.indexOf(',');
  const clean = commaIndex >= 0 ? base64.slice(commaIndex + 1) : base64;
  return clean.replace(/\s/g, '');
}

function assertUploadAuthorized(req) {
  if (!PHOTO_UPLOAD_TOKEN) return;

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (token !== PHOTO_UPLOAD_TOKEN) {
    const error = new Error('Unauthorized photo upload request');
    error.statusCode = 401;
    throw error;
  }
}

async function readJsonBody(req, maxBytes = MAX_PHOTO_BYTES * 2) {
  return await new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error(`Request body is too large. Limit is ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      raw += chunk;
    });

    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
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

async function uploadPhotoToFolder({ folderId, fileName, fileBase64, generateUniqueName = true }) {
  const normalizedBase64 = normalizeBase64(fileBase64);
  const sizeBytes = Buffer.byteLength(normalizedBase64, 'base64');

  if (sizeBytes > MAX_PHOTO_BYTES) {
    throw new Error(`Photo is too large: ${sizeBytes} bytes. Limit is ${MAX_PHOTO_BYTES} bytes.`);
  }

  const safeFileName = sanitizeFileName(fileName);

  return await bitrixCall('disk.folder.uploadfile', {
    id: folderId,
    data: { NAME: safeFileName },
    fileContent: [safeFileName, normalizedBase64],
    generateUniqueName
  });
}

async function uploadPhotoToStorageRoot({ storageId, fileName, fileBase64, generateUniqueName = true }) {
  const normalizedBase64 = normalizeBase64(fileBase64);
  const sizeBytes = Buffer.byteLength(normalizedBase64, 'base64');

  if (sizeBytes > MAX_PHOTO_BYTES) {
    throw new Error(`Photo is too large: ${sizeBytes} bytes. Limit is ${MAX_PHOTO_BYTES} bytes.`);
  }

  const safeFileName = sanitizeFileName(fileName);

  return await bitrixCall('disk.storage.uploadfile', {
    id: storageId,
    data: { NAME: safeFileName },
    fileContent: [safeFileName, normalizedBase64],
    generateUniqueName
  });
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
  },
  {
    name: 'disk.storage.list',
    description: 'List available Bitrix24 Drive storages.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'disk.storage.children',
    description: 'List files and folders in a Bitrix24 Drive storage root.',
    inputSchema: {
      type: 'object',
      properties: {
        storageId: { type: ['number', 'string'], description: 'Storage ID' },
        filter: { type: 'object' }
      },
      required: ['storageId']
    }
  },
  {
    name: 'disk.folder.children',
    description: 'List files and folders inside a Bitrix24 Drive folder.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: ['number', 'string'], description: 'Folder ID' },
        filter: { type: 'object' }
      },
      required: ['folderId']
    }
  },
  {
    name: 'disk.folder.uploadPhotoBase64',
    description: 'Upload an iPhone photo to a Bitrix24 Drive folder using Base64 content.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: ['number', 'string'], description: 'Bitrix24 Drive folder ID' },
        fileName: { type: 'string', description: 'Target file name, for example IMG_0001.jpg' },
        fileBase64: { type: 'string', description: 'Base64 file content or data URL' },
        generateUniqueName: { type: 'boolean', description: 'Generate unique name if file exists' }
      },
      required: ['folderId', 'fileName', 'fileBase64']
    }
  },
  {
    name: 'disk.storage.uploadPhotoBase64',
    description: 'Upload an iPhone photo to the root of a Bitrix24 Drive storage using Base64 content.',
    inputSchema: {
      type: 'object',
      properties: {
        storageId: { type: ['number', 'string'], description: 'Bitrix24 Drive storage ID' },
        fileName: { type: 'string', description: 'Target file name, for example IMG_0001.jpg' },
        fileBase64: { type: 'string', description: 'Base64 file content or data URL' },
        generateUniqueName: { type: 'boolean', description: 'Generate unique name if file exists' }
      },
      required: ['storageId', 'fileName', 'fileBase64']
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
        serverInfo: { name: 'bitrix24-mcp-server', version: '1.1.0' }
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
    else if (name === 'disk.storage.list') result = await bitrixCall('disk.storage.getlist');
    else if (name === 'disk.storage.children') result = await bitrixCall('disk.storage.getchildren', { id: args.storageId, filter: args.filter || {} });
    else if (name === 'disk.folder.children') result = await bitrixCall('disk.folder.getchildren', { id: args.folderId, filter: args.filter || {} });
    else if (name === 'disk.folder.uploadPhotoBase64') result = await uploadPhotoToFolder(args);
    else if (name === 'disk.storage.uploadPhotoBase64') result = await uploadPhotoToStorageRoot(args);
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
      return json(res, 200, { ok: true, name: 'bitrix24-mcp-server', mcp: '/mcp', health: '/health', photoUpload: '/upload/photo' });
    }

    if (req.method === 'GET' && req.url === '/health') {
      return json(res, BITRIX24_WEBHOOK_URL ? 200 : 503, {
        ok: Boolean(BITRIX24_WEBHOOK_URL),
        bitrixWebhookConfigured: Boolean(BITRIX24_WEBHOOK_URL),
        webhookValueLooksMisconfigured: Boolean(RAW_BITRIX24_WEBHOOK_URL?.startsWith('BITRIX24_WEBHOOK_URL=')),
        photoUploadTokenConfigured: Boolean(PHOTO_UPLOAD_TOKEN),
        maxPhotoBytes: MAX_PHOTO_BYTES,
        allowedMethods: [...ALLOWED_METHODS]
      });
    }

    if (req.method === 'POST' && req.url === '/upload/photo') {
      assertUploadAuthorized(req);
      const body = await readJsonBody(req);

      const result = body.storageId
        ? await uploadPhotoToStorageRoot(body)
        : await uploadPhotoToFolder(body);

      return json(res, 200, { ok: true, result });
    }

    if (req.method === 'POST' && req.url === '/mcp') {
      const body = await readJsonBody(req);
      const response = await handleRpc(body);
      if (response === null) return res.writeHead(204).end();
      return json(res, 200, response);
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    return json(res, statusCode, {
      jsonrpc: '2.0',
      id: null,
      error: { code: statusCode === 401 ? -32001 : -32000, message: error instanceof Error ? error.message : String(error) }
    });
  }
});

server.listen(PORT, () => {
  console.log(`Bitrix24 MCP server listening on ${PORT}`);
});
