'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// NodeGhost Business Proxy
// Sits between your customers and NodeGhost — keeps your ng- key private.
// Customers never see your API key. You control everything.
// ─────────────────────────────────────────────────────────────────────────────

const http  = require('http');
const https = require('https');
const url   = require('url');

const CONFIG = {
  PORT:          process.env.PORT          || 3200,
  NG_KEY:        process.env.NG_KEY        || '',         // Your ng- key (required)
  NG_URL:        process.env.NG_URL        || 'https://nodeghost.ai',
  MEMORY_URL:    process.env.MEMORY_URL    || '',         // Your ng-memory-server URL (optional)
  MODEL:         process.env.MODEL         || 'deepseek-chat',
  NAMESPACE:     process.env.NAMESPACE     || 'knowledge-base',
  SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || 'You are a helpful assistant. Use the provided context to answer questions accurately and concisely.',
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()),
  MAX_TOKENS:    parseInt(process.env.MAX_TOKENS || '800'),
};

if (!CONFIG.NG_KEY) {
  console.error('ERROR: NG_KEY environment variable is required');
  process.exit(1);
}

// ── CORS ──────────────────────────────────────────────────────────────────────
function setCORS(req, res) {
  const origin = req.headers.origin || '*';
  const allowed = CONFIG.ALLOWED_ORIGINS.includes('*') || CONFIG.ALLOWED_ORIGINS.includes(origin);
  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : CONFIG.ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Fetch helper ──────────────────────────────────────────────────────────────
function fetch(targetUrl, opts) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(targetUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.path,
      method:   opts.method || 'GET',
      headers:  opts.headers || {},
    };

    const req = lib.request(reqOpts, resolve);
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Memory recall ─────────────────────────────────────────────────────────────
async function recallMemory(query) {
  if (!CONFIG.MEMORY_URL) return null;
  try {
    const res = await fetch(CONFIG.MEMORY_URL + '/recall', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + CONFIG.NG_KEY,
      },
      body: JSON.stringify({ query, namespace: CONFIG.NAMESPACE, topK: 5 }),
    });

    let body = '';
    await new Promise(resolve => {
      res.on('data', d => body += d);
      res.on('end', resolve);
    });

    const data = JSON.parse(body);
    return (data.ok && data.memoryBlock) ? data.memoryBlock : null;
  } catch { return null; }
}

// ── Chat completion proxy ──────────────────────────────────────────────────────
async function handleChat(req, res) {
  const body = await readBody(req);
  const messages = body.messages || [];

  // Recall knowledge base context
  const userMessage = messages.filter(m => m.role === 'user').pop();
  const query = userMessage ? userMessage.content : '';
  const context = query ? await recallMemory(query) : null;

  // Build system prompt with context
  let systemPrompt = CONFIG.SYSTEM_PROMPT;
  if (context) {
    systemPrompt = context + '\n\n' + systemPrompt;
  }

  // Inject system prompt (replace or prepend)
  const hasSystem = messages.length && messages[0].role === 'system';
  const finalMessages = hasSystem
    ? [{ role: 'system', content: systemPrompt }, ...messages.slice(1)]
    : [{ role: 'system', content: systemPrompt }, ...messages];

  const payload = JSON.stringify({
    model:      body.model      || CONFIG.MODEL,
    messages:   finalMessages,
    max_tokens: body.max_tokens || CONFIG.MAX_TOKENS,
    stream:     body.stream     || false,
    temperature: body.temperature !== undefined ? body.temperature : 0.7,
  });

  try {
    const upstream = await fetch(CONFIG.NG_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + CONFIG.NG_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
      body: payload,
    });

    res.writeHead(upstream.statusCode, {
      'Content-Type': body.stream ? 'text/event-stream' : 'application/json',
      'Cache-Control': 'no-cache',
    });

    upstream.pipe(res);
  } catch (e) {
    json(res, 502, { error: 'Upstream error: ' + e.message });
  }
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const path = url.parse(req.url).pathname;

  setCORS(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.method === 'GET' && path === '/health') {
    json(res, 200, {
      status:    'ok',
      model:     CONFIG.MODEL,
      namespace: CONFIG.NAMESPACE,
      memory:    !!CONFIG.MEMORY_URL,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Chat completions
  if (req.method === 'POST' && path === '/v1/chat/completions') {
    await handleChat(req, res);
    return;
  }

  // Models list (for compatibility with OpenAI clients)
  if (req.method === 'GET' && path === '/v1/models') {
    json(res, 200, {
      object: 'list',
      data: [{ id: CONFIG.MODEL, object: 'model', owned_by: 'nodeghost' }],
    });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(CONFIG.PORT, () => {
  console.log('\n👻 NodeGhost Business Proxy');
  console.log('──────────────────────────────');
  console.log(`Port:      ${CONFIG.PORT}`);
  console.log(`Model:     ${CONFIG.MODEL}`);
  console.log(`Namespace: ${CONFIG.NAMESPACE}`);
  console.log(`Memory:    ${CONFIG.MEMORY_URL || 'disabled'}`);
  console.log(`CORS:      ${CONFIG.ALLOWED_ORIGINS.join(', ')}`);
  console.log('──────────────────────────────\n');
});
