'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ng-memory-server v0.6.1
// Multi-tenant private AI memory server with built-in document ingestion
// Supports: PDF, TXT, MD, HTML — chunked, embedded, stored automatically
// ─────────────────────────────────────────────────────────────────────────────

const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

// ── Admin token ───────────────────────────────────────────────────────────────
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (() => {
  const t = crypto.randomBytes(16).toString('hex');
  console.log('[ng-memory] No ADMIN_TOKEN env var set — generated token for this session: ' + t);
  console.log('[ng-memory] Set ADMIN_TOKEN in your environment to make it persistent.');
  return t;
})();

const CONFIG = {
  PORT:              process.env.PORT              || 3100,
  DATA_DIR:          process.env.DATA_DIR          || path.join(__dirname, 'data'),
  INFERENCE_URL:     process.env.INFERENCE_URL     || 'https://nodeghost.ai/v1',
  MAX_MEMORIES:      parseInt(process.env.MAX_MEMORIES || '10000'),
  CORS_ORIGINS:      process.env.CORS_ORIGINS      || '*',
  PUBLIC_NAMESPACES: (process.env.PUBLIC_NAMESPACES || 'knowledge-base').split(',').map(s => s.trim()),
  ALLOWED_KEYS:      process.env.ALLOWED_KEYS      || '',
  CHUNK_SIZE:        parseInt(process.env.CHUNK_SIZE    || '400'),
  CHUNK_OVERLAP:     parseInt(process.env.CHUNK_OVERLAP || '50'),
  MIN_CHUNK_LEN:     parseInt(process.env.MIN_CHUNK_LEN || '30'),
};

if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

// ── Lazy-load heavy dependencies ──────────────────────────────────────────────
let embedder = null;

async function getEmbedder() {
  if (embedder) return embedder;
  console.log('[ng-memory] Loading embedding model...');
  const { pipeline } = await import('@xenova/transformers');
  embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
  console.log('[ng-memory] Embedding model ready');
  return embedder;
}

async function embed(text) {
  const pipe   = await getEmbedder();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ── Text chunking ─────────────────────────────────────────────────────────────
function chunkText(text) {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > CONFIG.MIN_CHUNK_LEN);
  const chunks = [];

  for (const para of paragraphs) {
    if (para.length <= CONFIG.CHUNK_SIZE) {
      chunks.push(para);
    } else {
      let start = 0;
      while (start < para.length) {
        let end = Math.min(start + CONFIG.CHUNK_SIZE, para.length);
        if (end < para.length) {
          const sentBreak  = para.lastIndexOf('. ', end);
          const spaceBreak = para.lastIndexOf(' ', end);
          if (sentBreak > start + CONFIG.CHUNK_SIZE / 2) end = sentBreak + 1;
          else if (spaceBreak > start) end = spaceBreak;
        }
        const chunk = para.slice(start, end).trim();
        if (chunk.length >= CONFIG.MIN_CHUNK_LEN) chunks.push(chunk);
        const next = end - CONFIG.CHUNK_OVERLAP;
        start = next > start ? next : start + CONFIG.CHUNK_SIZE;
        if (start >= para.length) break;
      }
    }
  }

  return chunks;
}

// ── Extract text from file ────────────────────────────────────────────────────
async function extractText(filePath, ext) {
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse-new');
    const buffer   = fs.readFileSync(filePath);
    const data     = await pdfParse(buffer);
    return data.text;
  }
  if (ext === '.html' || ext === '.htm') {
    const raw = fs.readFileSync(filePath, 'utf8');
    let text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<head[\s\S]*?<\/head>/gi, ' ');
    text = text.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|nav|main|aside|blockquote)>/gi, '\n');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return text;
  }
  return fs.readFileSync(filePath, 'utf8');
}

// ── Auth + identity ───────────────────────────────────────────────────────────
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function isValidKey(key) {
  if (!key || !key.startsWith('ng-')) return false;
  if (CONFIG.ALLOWED_KEYS) return CONFIG.ALLOWED_KEYS.split(',').map(k => k.trim()).includes(key);
  return true;
}

function sanitizeUserId(raw) {
  if (!raw || typeof raw !== 'string') return 'default';
  const s = raw.replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 64);
  return s || 'default';
}

// Returns { apiKey, orgHash, userId } or null if no valid ng- key found.
//
// ⚠️  BODY-FIRST IDENTITY — DO NOT FLIP THIS TERNARY. HERE IS WHY:
//
// POKT relay miners inject their own bearer token into the Authorization header before
// forwarding requests to this server. That token starts with "ng-" and passes isValidKey(),
// so putting the header first means EVERY relay-routed call lands under the relay miner's
// orgHash — completely destroying per-org data isolation regardless of ALLOWED_KEYS.
//
// body.owner_token is the only identity field that survives the relay path untouched, so
// it must win whenever present. The Authorization header is still validated by nginx's
// auth_request BEFORE the request reaches this server (quota gating, access control) — by
// the time we get here, customer identity must come from body.owner_token.
//
// Header fallback is kept for direct calls (dev, admin, non-relay paths) where no relay
// miner is in the chain and owner_token may legitimately be absent.
//
// user_id: body.user_id (sanitized), fallback 'default'.
function getIdentity(req, body) {
  const headerKey = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const bodyKey   = (body && typeof body.owner_token === 'string') ? body.owner_token : '';
  const key = isValidKey(bodyKey) ? bodyKey : isValidKey(headerKey) ? headerKey : null;
  if (!key) return null;
  return {
    apiKey:  key,
    orgHash: hashKey(key),
    userId:  sanitizeUserId(body && body.user_id),
  };
}

function checkAdminAuth(req) {
  const qs          = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
  const queryToken  = new URLSearchParams(qs).get('token') || '';
  const headerToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  return queryToken === ADMIN_TOKEN || headerToken === ADMIN_TOKEN;
}

// ── SQLite ────────────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const dbCache  = new Map();

function initDB(db) {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id        TEXT PRIMARY KEY,
      text      TEXT NOT NULL,
      vector    TEXT,
      timestamp INTEGER NOT NULL,
      meta      TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON memories(timestamp);
  `);
  return db;
}

// Two-level isolation: data/{orgHash}/{userId}/{namespace}.db
// v0.6.0 BREAKING: authenticated knowledge-base → data/{orgHash}/kb/shared.db (per-org).
// Public recall bypasses this function and calls getDB('kb-shared','shared','shared') directly.
// Falls back to old flat data/{orgHash}/{namespace}.db if new path doesn't exist yet.
function getDB(orgHash, userId, namespace) {
  if (namespace === 'knowledge-base') { userId = 'kb'; namespace = 'shared'; }

  const cacheKey = `${orgHash}/${userId}/${namespace}`;
  if (dbCache.has(cacheKey)) return dbCache.get(cacheKey);

  const newDir  = path.join(CONFIG.DATA_DIR, orgHash, userId);
  const newPath = path.join(newDir, namespace + '.db');
  const oldPath = path.join(CONFIG.DATA_DIR, orgHash, namespace + '.db');

  let db;
  if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
    db = initDB(new Database(oldPath));
    console.log(`[ng-memory] Using legacy flat path for ${orgHash}/${namespace}`);
  } else {
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
    db = initDB(new Database(newPath));
  }

  dbCache.set(cacheKey, db);
  return db;
}

// ── Cosine similarity ─────────────────────────────────────────────────────────
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Recall ────────────────────────────────────────────────────────────────────
async function recall(db, query, queryVector, topK) {
  topK = topK || 5;
  const all = db.prepare('SELECT * FROM memories ORDER BY timestamp DESC').all();
  if (!all.length) return [];

  let vec = queryVector && queryVector.length > 0 ? queryVector : null;
  if (!vec && query) {
    try { vec = await embed(query); } catch {}
  }

  if (vec) {
    const scored = all.map(function(m) {
      let mv = null;
      try { mv = m.vector ? JSON.parse(m.vector) : null; } catch {}
      return Object.assign({}, m, { similarity: mv ? cosineSimilarity(vec, mv) : 0 });
    });
    return scored
      .filter(function(m) { return m.similarity > 0.1; })
      .sort(function(a, b) { return b.similarity - a.similarity; })
      .slice(0, topK);
  }

  // Keyword fallback
  if (all.length <= 20) return all.slice(0, topK);
  const words = (query || '').toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
  if (!words.length) return all.slice(0, topK);
  return all.map(function(m) {
    const score = words.reduce(function(sum, w) { return sum + (m.text.toLowerCase().includes(w) ? 1 : 0); }, 0);
    return Object.assign({}, m, { similarity: score });
  }).sort(function(a, b) { return b.similarity - a.similarity; }).slice(0, topK);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  CONFIG.CORS_ORIGINS);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Namespace');
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(function(resolve) {
    let body = '';
    req.on('data', function(d) { body += d; });
    req.on('end', function() { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

function parseMultipart(req) {
  return new Promise(function(resolve, reject) {
    const contentType = req.headers['content-type'] || '';
    const boundary    = contentType.split('boundary=')[1];
    if (!boundary) { reject(new Error('No boundary')); return; }
    const chunks = [];
    req.on('data', function(d) { chunks.push(d); });
    req.on('end', function() {
      try {
        const buf     = Buffer.concat(chunks);
        const bodyStr = buf.toString('binary');
        const parts   = bodyStr.split('--' + boundary);
        let filename    = null;
        let fileBuffer  = null;
        let namespace   = 'knowledge-base';
        let userId      = 'default';
        let ownerToken  = '';

        for (const part of parts) {
          if (!part.includes('Content-Disposition')) continue;
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          const header  = part.slice(0, headerEnd);
          const content = part.slice(headerEnd + 4, part.lastIndexOf('\r\n'));
          const nameMatch = header.match(/name="([^"]+)"/);
          const fileMatch = header.match(/filename="([^"]+)"/);

          if (fileMatch) {
            filename   = fileMatch[1];
            fileBuffer = Buffer.from(content, 'binary');
          } else if (nameMatch && nameMatch[1] === 'namespace') {
            namespace = content.trim();
          } else if (nameMatch && nameMatch[1] === 'user_id') {
            userId = content.trim();
          } else if (nameMatch && nameMatch[1] === 'owner_token') {
            ownerToken = content.trim();
          }
        }

        resolve({ filename, fileBuffer, namespace, userId, ownerToken });
      } catch (err) { reject(err); }
    });
  });
}

function makeId(orgHash, userId) {
  return orgHash.slice(0, 6) + userId.slice(0, 6) + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

function buildMemoryBlock(texts) {
  return texts.length ? 'Relevant context from memory:\n' + texts.map(t => '- ' + t).join('\n') : null;
}

function storeChunks(db, chunks, orgHash, userId, namespace, source) {
  const now = Date.now();
  const ins = db.prepare('INSERT OR REPLACE INTO memories (id, text, vector, timestamp, meta) VALUES (?, ?, ?, ?, ?)');
  db.transaction(function(chunks) {
    chunks.forEach(function(chunk) {
      ins.run(
        makeId(orgHash, userId),
        chunk.text,
        chunk.vector ? JSON.stringify(chunk.vector) : null,
        now,
        JSON.stringify({ source, namespace, type: chunk.type || 'document' })
      );
    });
  })(chunks);
}

// ── URL routing helper ────────────────────────────────────────────────────────
// Matches /name, /v1/memory/name, /memory/name
function matchPath(url, name) {
  return url === `/${name}` || url === `/v1/memory/${name}` || url === `/memory/${name}`;
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async function(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method;
  console.log('[ng-memory] ' + method + ' ' + url);

  setCORS(res);
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Health ─────────────────────────────────────────────────────────────────
  if (method === 'GET' && matchPath(url, 'health')) {
    json(res, 200, { status: 'ok', version: '0.6.1', timestamp: new Date().toISOString() });
    return;
  }

  // ── Admin panel ────────────────────────────────────────────────────────────
  if (method === 'GET' && (url === '/admin' || url === '/admin/')) {
    if (!checkAdminAuth(req)) {
      json(res, 401, { error: 'Admin token required — provide ?token=xxx or Authorization: Bearer <token>' });
      return;
    }
    try {
      const adminHtml = fs.readFileSync(path.join(__dirname, 'admin.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(adminHtml);
    } catch {
      json(res, 404, { error: 'Admin panel not found' });
    }
    return;
  }

  // ── Public recall — no auth, always reads kb-shared/shared/knowledge-base ──
  if (method === 'POST' && matchPath(url, 'public/recall')) {
    try {
      const body  = await readBody(req);
      const query = (body.query || '').trim();
      const topK  = parseInt(body.topK) || 5;
      const vec   = Array.isArray(body.vector) ? body.vector : null;
      if (!query) { json(res, 400, { error: 'query required' }); return; }

      const db       = getDB('kb-shared', 'shared', 'shared');
      const memories = await recall(db, query, vec, topK);
      const texts    = memories.map(m => m.text);
      json(res, 200, {
        ok: true, namespace: 'knowledge-base',
        memories: texts, count: texts.length,
        memoryBlock: buildMemoryBlock(texts),
      });
    } catch (err) {
      console.error('[ng-memory-server] public/recall error:', err.message);
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /upload — multipart, identity via getIdentity() (body-first) ────────
  if (method === 'POST' && matchPath(url, 'upload')) {
    let parsed;
    try { parsed = await parseMultipart(req); } catch (err) {
      json(res, 400, { error: 'Multipart parse failed: ' + err.message }); return;
    }

    const { filename, fileBuffer, namespace, userId: rawUserId, ownerToken } = parsed;
    // Synthetic body lets getIdentity() apply the same body-first priority as JSON endpoints.
    // owner_token form field survives relay paths; Authorization header fallback for direct calls.
    const uploadIdentity = getIdentity(req, { owner_token: ownerToken, user_id: rawUserId });
    if (!uploadIdentity) {
      json(res, 401, { error: 'Valid ng- API key required (Authorization header or owner_token form field)' });
      return;
    }
    const { orgHash, userId } = uploadIdentity;

    if (!filename || !fileBuffer) { json(res, 400, { error: 'No file in request' }); return; }
    const ext     = path.extname(filename).toLowerCase();
    const allowed = ['.pdf', '.txt', '.md', '.markdown', '.html', '.htm'];
    if (!allowed.includes(ext)) {
      json(res, 400, { error: 'Unsupported file type. Supported: ' + allowed.join(', ') }); return;
    }

    const tmpPath = path.join(os.tmpdir(), 'ng-ingest-' + Date.now() + ext);
    fs.writeFileSync(tmpPath, fileBuffer);

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify({ ok: true, status: 'processing', filename, namespace, userId }) + '\n');

    try {
      console.log(`[ng-memory] Extracting text from ${filename}...`);
      const text   = await extractText(tmpPath, ext);
      const chunks = chunkText(text);
      console.log(`[ng-memory] ${chunks.length} chunks, computing embeddings...`);

      const embedded = [];
      for (let i = 0; i < chunks.length; i++) {
        const vector = await embed(chunks[i]);
        embedded.push({ text: chunks[i], vector });
        if (i % 10 === 0) console.log(`[ng-memory] Embedded ${i + 1}/${chunks.length} chunks`);
      }

      const db = getDB(orgHash, userId, namespace);
      storeChunks(db, embedded, orgHash, userId, namespace, filename);
      console.log(`[ng-memory] Stored ${embedded.length} chunks from ${filename} → ${orgHash}/${userId}/${namespace}`);
      res.write(JSON.stringify({ ok: true, status: 'complete', filename, namespace, userId, chunks: embedded.length }) + '\n');
    } catch (err) {
      console.error('[ng-memory] Ingest error:', err.message);
      res.write(JSON.stringify({ ok: false, status: 'error', error: err.message }) + '\n');
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
      res.end();
    }
    return;
  }

  // ── All remaining endpoints: read JSON body, then require valid ng- key ─────
  const body     = await readBody(req);
  const identity = getIdentity(req, body);
  if (!identity) {
    json(res, 401, { error: 'Valid ng- API key required (Authorization header or owner_token in body)' });
    return;
  }
  const { apiKey, orgHash, userId } = identity;

  try {

    // ── POST /recall ───────────────────────────────────────────────────────
    if (method === 'POST' && matchPath(url, 'recall')) {
      const namespace = (body.namespace || req.headers['x-namespace'] || 'default').trim();
      const query     = (body.query || '').trim();
      const topK      = parseInt(body.topK) || 5;
      const vector    = Array.isArray(body.vector) ? body.vector : null;
      if (!query) { json(res, 400, { error: 'query required' }); return; }
      const db       = getDB(orgHash, userId, namespace);
      const memories = await recall(db, query, vector, topK);
      const texts    = memories.map(m => m.text);
      json(res, 200, { ok: true, namespace, userId, memories: texts, count: texts.length, memoryBlock: buildMemoryBlock(texts) });
      return;
    }

    // ── POST /store ────────────────────────────────────────────────────────
    if (method === 'POST' && matchPath(url, 'store')) {
      const namespace = (body.namespace || req.headers['x-namespace'] || 'default').trim();
      const text      = (body.text || '').trim();
      const meta      = body.meta || {};
      if (!text) { json(res, 400, { error: 'text required' }); return; }
      let vector = Array.isArray(body.vector) ? body.vector : null;
      if (!vector) { try { vector = await embed(text); } catch {} }
      const db = getDB(orgHash, userId, namespace);
      const id = makeId(orgHash, userId);
      db.prepare('INSERT OR REPLACE INTO memories (id, text, vector, timestamp, meta) VALUES (?, ?, ?, ?, ?)').run(
        id, text, vector ? JSON.stringify(vector) : null, Date.now(),
        JSON.stringify({ source: 'manual', namespace, ...meta })
      );
      json(res, 200, { ok: true, id, namespace, userId, hasVector: !!vector });
      return;
    }

    // ── POST /ingest — bulk store pre-chunked content ──────────────────────
    if (method === 'POST' && matchPath(url, 'ingest')) {
      const namespace = (body.namespace || req.headers['x-namespace'] || 'knowledge-base').trim();
      const chunks    = Array.isArray(body.chunks) ? body.chunks : [];
      const source    = body.source || 'document';
      if (!chunks.length) { json(res, 400, { error: 'chunks array required' }); return; }
      const db = getDB(orgHash, userId, namespace);
      storeChunks(db, chunks, orgHash, userId, namespace, source);
      json(res, 200, { ok: true, stored: chunks.length, namespace, userId });
      return;
    }

    // ── GET /list ──────────────────────────────────────────────────────────
    if (method === 'GET' && matchPath(url, 'list')) {
      const namespace = (req.headers['x-namespace'] || 'default').trim();
      const db        = getDB(orgHash, userId, namespace);
      const all       = db.prepare('SELECT id, text, timestamp, meta FROM memories ORDER BY timestamp DESC').all();
      json(res, 200, {
        ok: true, namespace, userId, count: all.length,
        memories: all.map(m => ({ id: m.id, text: m.text, timestamp: m.timestamp, meta: JSON.parse(m.meta || '{}') })),
      });
      return;
    }

    // ── GET /sources ───────────────────────────────────────────────────────
    if (method === 'GET' && matchPath(url, 'sources')) {
      const namespace = (req.headers['x-namespace'] || 'knowledge-base').trim();
      const db        = getDB(orgHash, userId, namespace);
      const all       = db.prepare('SELECT meta FROM memories').all();
      const sourceMap = {};
      all.forEach(function(m) {
        const meta = JSON.parse(m.meta || '{}');
        const src  = meta.source || 'unknown';
        if (!sourceMap[src]) sourceMap[src] = 0;
        sourceMap[src]++;
      });
      const sources = Object.entries(sourceMap).map(function(e) { return { source: e[0], chunks: e[1] }; });
      json(res, 200, { ok: true, namespace, userId, sources });
      return;
    }

    // ── GET /namespaces ────────────────────────────────────────────────────
    if (method === 'GET' && matchPath(url, 'namespaces')) {
      const userDir = path.join(CONFIG.DATA_DIR, orgHash, userId);
      if (!fs.existsSync(userDir)) { json(res, 200, { ok: true, userId, namespaces: [] }); return; }
      const namespaces = fs.readdirSync(userDir).filter(f => f.endsWith('.db')).map(function(f) {
        const ns    = f.replace('.db', '');
        const db    = getDB(orgHash, userId, ns);
        const count = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
        const vecs  = db.prepare("SELECT COUNT(*) as c FROM memories WHERE vector IS NOT NULL").get().c;
        return { namespace: ns, count, vectorized: vecs, ragEnabled: vecs > 0, isPublic: CONFIG.PUBLIC_NAMESPACES.includes(ns) };
      });
      json(res, 200, { ok: true, userId, namespaces });
      return;
    }

    // ── GET /stats ─────────────────────────────────────────────────────────
    if (method === 'GET' && matchPath(url, 'stats')) {
      const namespace = (req.headers['x-namespace'] || 'default').trim();
      const db        = getDB(orgHash, userId, namespace);
      const count     = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
      const vecs      = db.prepare("SELECT COUNT(*) as c FROM memories WHERE vector IS NOT NULL").get().c;
      json(res, 200, { ok: true, namespace, userId, count, vectorized: vecs, ragEnabled: vecs > 0, orgHash: orgHash.slice(0, 8) + '...' });
      return;
    }

    // ── DELETE /source — remove all chunks from a document source ──────────
    if (method === 'DELETE' && matchPath(url, 'source')) {
      const namespace = (body.namespace || req.headers['x-namespace'] || 'knowledge-base').trim();
      const source    = body.source;
      if (!source) { json(res, 400, { error: 'source required' }); return; }
      const db     = getDB(orgHash, userId, namespace);
      const result = db.prepare("DELETE FROM memories WHERE json_extract(meta, '$.source') = ?").run(source);
      json(res, 200, { ok: true, removed: result.changes, namespace, userId });
      return;
    }

    // ── DELETE /memories/:id ───────────────────────────────────────────────
    const idPrefixes = ['/memories/', '/v1/memory/memories/', '/memory/memories/'];
    const matchedPrefix = idPrefixes.find(p => url.startsWith(p) && url.length > p.length);
    if (method === 'DELETE' && matchedPrefix) {
      const namespace = (req.headers['x-namespace'] || 'default').trim();
      const id        = decodeURIComponent(url.slice(matchedPrefix.length));
      getDB(orgHash, userId, namespace).prepare('DELETE FROM memories WHERE id = ?').run(id);
      json(res, 200, { ok: true });
      return;
    }

    // ── DELETE /memories — clear namespace ─────────────────────────────────
    if (method === 'DELETE' && matchPath(url, 'memories')) {
      const namespace = (req.headers['x-namespace'] || 'default').trim();
      getDB(orgHash, userId, namespace).prepare('DELETE FROM memories').run();
      json(res, 200, { ok: true, namespace, userId });
      return;
    }

    // ── POST /clear — delete all namespaces for a user ─────────────────────
    if (method === 'POST' && matchPath(url, 'clear')) {
      const userDir = path.join(CONFIG.DATA_DIR, orgHash, userId);
      let deleted = 0;
      if (fs.existsSync(userDir)) {
        const dbFiles = fs.readdirSync(userDir).filter(function(f) { return f.endsWith('.db'); });
        deleted = dbFiles.length;
        for (const f of dbFiles) {
          const ns       = f.replace(/\.db$/, '');
          const cacheKey = `${orgHash}/${userId}/${ns}`;
          const cached   = dbCache.get(cacheKey);
          if (cached) { try { cached.close(); } catch {} dbCache.delete(cacheKey); }
        }
        fs.rmSync(userDir, { recursive: true, force: true });
      }
      json(res, 200, { ok: true, deleted_namespaces: deleted });
      return;
    }

    json(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('[ng-memory-server] Error:', err.message);
    json(res, 500, { error: err.message });
  }
});

server.listen(CONFIG.PORT, function() {
  console.log('\n👻 ng-memory-server v0.6.1');
  console.log('─────────────────────────────────────');
  console.log('Port:              ' + CONFIG.PORT);
  console.log('Data dir:          ' + CONFIG.DATA_DIR);
  console.log('Max memories:      ' + CONFIG.MAX_MEMORIES);
  console.log('Public namespaces: ' + CONFIG.PUBLIC_NAMESPACES.join(', '));
  console.log('─────────────────────────────────────');
  console.log('Endpoints:');
  console.log('  GET    /health           public');
  console.log('  GET    /admin            admin panel (ADMIN_TOKEN required)');
  console.log('  POST   /public/recall    public read-only recall (no auth)');
  console.log('  POST   /upload           upload + auto-ingest file (PDF/TXT/MD/HTML)');
  console.log('  POST   /recall           semantic recall (vector or keyword)');
  console.log('  POST   /store            store single memory');
  console.log('  POST   /ingest           bulk store pre-chunked content');
  console.log('  POST   /clear            delete all namespaces for a user');
  console.log('  GET    /list             list memories in namespace');
  console.log('  GET    /sources          list document sources');
  console.log('  GET    /namespaces       list namespaces for user');
  console.log('  GET    /stats            memory count + RAG status');
  console.log('  DELETE /source           remove document by source name');
  console.log('  DELETE /memories         clear namespace');
  console.log('  DELETE /memories/:id     forget one memory');
  console.log('─────────────────────────────────────');
  console.log('Identity model (v0.6.1 — body-first):');
  console.log('  orgHash = SHA256(ng-key).slice(0,32)');
  console.log('  userId  = body.user_id (sanitized) or "default"');
  console.log('  path    = data/{orgHash}/{userId}/{namespace}.db');
  console.log('  kb auth = data/{orgHash}/kb/shared.db  (per-org, v0.6.0+)');
  console.log('  kb pub  = data/kb-shared/shared/shared.db  (public/recall only)');
  console.log('─────────────────────────────────────\n');
});
