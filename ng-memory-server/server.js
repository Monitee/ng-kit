'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ng-memory-server v0.3.0
// Self-hosted private AI memory server with built-in document ingestion
// Supports: PDF, TXT, MD, HTML — chunked, embedded, stored automatically
// ─────────────────────────────────────────────────────────────────────────────

const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const CONFIG = {
  PORT:              process.env.PORT              || 3100,
  DATA_DIR:          process.env.DATA_DIR          || path.join(__dirname, 'data'),
  INFERENCE_URL:     process.env.INFERENCE_URL     || 'https://nodeghost.ai/v1',
  MAX_MEMORIES:      parseInt(process.env.MAX_MEMORIES || '10000'),
  CORS_ORIGINS:      process.env.CORS_ORIGINS      || '*',
  PUBLIC_NAMESPACES: (process.env.PUBLIC_NAMESPACES || 'knowledge-base').split(',').map(s => s.trim()),
  ALLOWED_KEYS:      process.env.ALLOWED_KEYS      || '',
  // Chunking config
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
  // Split into paragraphs first
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > CONFIG.MIN_CHUNK_LEN);
  const chunks = [];

  for (const para of paragraphs) {
    if (para.length <= CONFIG.CHUNK_SIZE) {
      chunks.push(para);
    } else {
      // Split long paragraphs
      let start = 0;
      while (start < para.length) {
        let end = Math.min(start + CONFIG.CHUNK_SIZE, para.length);
        if (end < para.length) {
          const sentBreak = para.lastIndexOf('. ', end);
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
    // Strip script and style blocks entirely
    let text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<head[\s\S]*?<\/head>/gi, ' ');
    // Replace block elements with newlines for readability
    text = text.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|nav|main|aside|blockquote)>/gi, '\n');
    // Strip all remaining tags
    text = text.replace(/<[^>]+>/g, ' ');
    // Decode common HTML entities
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–');
    // Collapse whitespace
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return text;
  }
  // txt, md — just read
  return fs.readFileSync(filePath, 'utf8');
}

// ── SQLite ────────────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const dbCache  = new Map();

function getDB(ownerId, namespace) {
  // knowledge-base is always shared — fixed owner ID regardless of who queries
  if (namespace === 'knowledge-base') ownerId = 'kb-shared';
  const key = ownerId + '_' + namespace;
  if (dbCache.has(key)) return dbCache.get(key);
  const dir = path.join(CONFIG.DATA_DIR, ownerId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, namespace + '.db'));
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
  dbCache.set(key, db);
  return db;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function isValidKey(key) {
  if (!key || !key.startsWith('ng-')) return false;
  if (CONFIG.ALLOWED_KEYS) return CONFIG.ALLOWED_KEYS.split(',').map(k => k.trim()).includes(key);
  return true;
}

function getAuth(req) {
  const key = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!isValidKey(key)) return null;
  return { apiKey: key, ownerId: hashKey(key) };
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

  // Use provided vector or compute one from query
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

// ── Fact extraction ───────────────────────────────────────────────────────────
async function extractFacts(userMsg, assistantMsg, apiKey) {
  try {
    const res = await fetch(`${CONFIG.INFERENCE_URL}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model:       'deepseek-chat',
        messages:    [{ role: 'user', content: `Extract key facts worth remembering from this exchange.\nFocus on: personal information, preferences, decisions, important context, company knowledge, customer issues.\nReturn ONLY a JSON array of concise strings. Return [] if nothing memorable.\nNo markdown.\n\nUser: ${userMsg.slice(0,500)}\nAssistant: ${assistantMsg.slice(0,500)}\n\nJSON array:` }],
        max_tokens:  300,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data  = await res.json();
    const text  = data.choices?.[0]?.message?.content?.trim() || '[]';
    const facts = JSON.parse(text.replace(/```json|```/g, '').trim());
    return Array.isArray(facts) ? facts.filter(f => typeof f === 'string' && f.length > 5).slice(0, 10) : [];
  } catch { return []; }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  CONFIG.CORS_ORIGINS);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Namespace, X-Owner-Token');
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
        let filename  = null;
        let fileBuffer = null;
        let namespace  = 'knowledge-base';

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
          }
        }

        resolve({ filename, fileBuffer, namespace });
      } catch (err) { reject(err); }
    });
  });
}

function makeId(ownerId) {
  return ownerId.slice(0,8) + '-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
}

function buildMemoryBlock(texts) {
  return texts.length ? 'Relevant context from memory:\n' + texts.map(t => '- ' + t).join('\n') : null;
}

function storeChunks(db, chunks, ownerId, namespace, source) {
  const now = Date.now();
  const ins = db.prepare('INSERT OR REPLACE INTO memories (id, text, vector, timestamp, meta) VALUES (?, ?, ?, ?, ?)');
  db.transaction(function(chunks) {
    chunks.forEach(function(chunk) {
      ins.run(
        makeId(ownerId),
        chunk.text,
        chunk.vector ? JSON.stringify(chunk.vector) : null,
        now,
        JSON.stringify({ source, namespace, type: 'document' })
      );
    });
  })(chunks);
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async function(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method;
  console.log('[ng-memory] ' + method + ' ' + url);

  setCORS(res);
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Admin panel ────────────────────────────────────────────────────────────
  if (method === 'GET' && (url === '/admin' || url === '/admin/')) {
    try {
      const adminHtml = require('fs').readFileSync(path.join(__dirname, 'admin.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(adminHtml);
    } catch (e) {
      json(res, 404, { error: 'Admin panel not found' });
    }
    return;
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  if (method === 'GET' && (url === '/health' || url === '/v1/memory/health' || url === '/memory/health')) {
    json(res, 200, { status: 'ok', version: '0.4.0', timestamp: new Date().toISOString() });
    return;
  }

  // ── Public recall — no auth, read-only ────────────────────────────────────
  if (method === 'POST' && (url === '/public/recall' || url === '/v1/memory/public/recall' || url === '/memory/public/recall')) {
    const body       = await readBody(req);
    const namespace  = (body.namespace || 'knowledge-base').trim();
    const query      = (body.query || '').trim();
    const topK       = parseInt(body.topK) || 5;
    const vector     = Array.isArray(body.vector) ? body.vector : null;
    const ownerToken = req.headers['x-owner-token'] || '';

    if (!CONFIG.PUBLIC_NAMESPACES.includes(namespace)) {
      json(res, 403, { error: 'Namespace not publicly accessible' }); return;
    }
    if (!isValidKey(ownerToken)) {
      json(res, 401, { error: 'X-Owner-Token required' }); return;
    }

    const ownerId  = hashKey(ownerToken);
    const db       = getDB(ownerId, namespace);
    const memories = await recall(db, query, vector, topK);
    const texts    = memories.map(m => m.text);

    json(res, 200, {
      ok: true, namespace,
      memories: texts, count: texts.length,
      memoryBlock: buildMemoryBlock(texts),
    });
    return;
  }

  // ── Auth optional — PATH + nginx handle upstream authentication ──────────────
  // When called via POKT relay miners, no auth header is present — use relay-default namespace
  // When called directly with an ng- key, use that key for namespace isolation
  const auth = getAuth(req);
  const { apiKey, ownerId } = auth || { apiKey: '', ownerId: 'relay-default' };

  try {

    // ── POST /upload — multipart file upload + auto ingest ─────────────────
    if (method === 'POST' && (url === '/upload' || url === '/v1/memory/upload' || url === '/memory/upload')) {
      let parsed;
      try { parsed = await parseMultipart(req); } catch (err) {
        json(res, 400, { error: 'Multipart parse failed: ' + err.message }); return;
      }

      const { filename, fileBuffer, namespace } = parsed;
      if (!filename || !fileBuffer) { json(res, 400, { error: 'No file in request' }); return; }

      const ext     = path.extname(filename).toLowerCase();
      const allowed = ['.pdf', '.txt', '.md', '.markdown', '.html', '.htm'];
      if (!allowed.includes(ext)) {
        json(res, 400, { error: 'Unsupported file type. Supported: ' + allowed.join(', ') }); return;
      }

      // Write to temp file
      const tmpPath = path.join(os.tmpdir(), 'ng-ingest-' + Date.now() + ext);
      fs.writeFileSync(tmpPath, fileBuffer);

      // Send immediate response that processing has started
      // (embedding can take a while for large docs)
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.write(JSON.stringify({ ok: true, status: 'processing', filename, namespace }) + '\n');

      try {
        // Extract text
        console.log(`[ng-memory] Extracting text from ${filename}...`);
        const text   = await extractText(tmpPath, ext);
        const chunks = chunkText(text);
        console.log(`[ng-memory] ${chunks.length} chunks extracted, computing embeddings...`);

        // Compute embeddings for each chunk
        const embedded = [];
        for (let i = 0; i < chunks.length; i++) {
          const vector = await embed(chunks[i]);
          embedded.push({ text: chunks[i], vector });
          if (i % 10 === 0) console.log(`[ng-memory] Embedded ${i+1}/${chunks.length} chunks`);
        }

        // Store all chunks
        const db = getDB(ownerId, namespace);
        storeChunks(db, embedded, ownerId, namespace, filename);

        console.log(`[ng-memory] Stored ${embedded.length} chunks from ${filename} in namespace "${namespace}"`);
        res.write(JSON.stringify({ ok: true, status: 'complete', filename, namespace, chunks: embedded.length }) + '\n');
      } catch (err) {
        console.error('[ng-memory] Ingest error:', err.message);
        res.write(JSON.stringify({ ok: false, status: 'error', error: err.message }) + '\n');
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
        res.end();
      }
      return;
    }

    // ── POST /recall ───────────────────────────────────────────────────────
    if (method === 'POST' && (url === '/recall' || url === '/v1/memory/recall' || url === '/memory/recall')) {
      const body      = await readBody(req);
      const namespace = (body.namespace || req.headers['x-namespace'] || 'default').trim();
      const query     = (body.query || '').trim();
      const topK      = parseInt(body.topK) || 5;
      const vector    = Array.isArray(body.vector) ? body.vector : null;
      if (!query) { json(res, 400, { error: 'query required' }); return; }
      const db       = getDB(ownerId, namespace);
      const memories = await recall(db, query, vector, topK);
      const texts    = memories.map(m => m.text);
      json(res, 200, { ok: true, namespace, memories: texts, count: texts.length, memoryBlock: buildMemoryBlock(texts) });
      return;
    }

    // ── POST /remember ─────────────────────────────────────────────────────
    if (method === 'POST' && (url === '/remember' || url === '/v1/memory/remember' || url === '/memory/remember')) {
      const body      = await readBody(req);
      const namespace = (body.namespace || req.headers['x-namespace'] || 'default').trim();
      const { userMsg, assistantMsg } = body;
      if (!userMsg || !assistantMsg) { json(res, 400, { error: 'userMsg and assistantMsg required' }); return; }
      const facts = await extractFacts(userMsg, assistantMsg, apiKey);
      if (!facts.length) { json(res, 200, { ok: true, stored: 0 }); return; }
      const db  = getDB(ownerId, namespace);
      const now = Date.now();
      // Embed facts for better recall
      const embedded = [];
      for (const fact of facts) {
        try { embedded.push({ text: fact, vector: await embed(fact) }); }
        catch { embedded.push({ text: fact, vector: null }); }
      }
      storeChunks(db, embedded, ownerId, namespace, 'conversation');
      const count = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
      if (count > CONFIG.MAX_MEMORIES) {
        db.prepare('DELETE FROM memories WHERE id IN (SELECT id FROM memories ORDER BY timestamp ASC LIMIT ?)').run(count - CONFIG.MAX_MEMORIES);
      }
      json(res, 200, { ok: true, stored: facts.length, namespace });
      return;
    }

    // ── POST /store ────────────────────────────────────────────────────────
    if (method === 'POST' && (url === '/store' || url === '/v1/memory/store' || url === '/memory/store')) {
      const body      = await readBody(req);
      const namespace = (body.namespace || req.headers['x-namespace'] || 'default').trim();
      const text      = (body.text || '').trim();
      const meta      = body.meta || {};
      if (!text) { json(res, 400, { error: 'text required' }); return; }
      // Accept pre-computed vector or compute one
      let vector = Array.isArray(body.vector) ? body.vector : null;
      if (!vector) { try { vector = await embed(text); } catch {} }
      const db = getDB(ownerId, namespace);
      const id = makeId(ownerId);
      db.prepare('INSERT OR REPLACE INTO memories (id, text, vector, timestamp, meta) VALUES (?, ?, ?, ?, ?)').run(
        id, text, vector ? JSON.stringify(vector) : null, Date.now(),
        JSON.stringify({ source: 'manual', namespace, ...meta })
      );
      json(res, 200, { ok: true, id, namespace, hasVector: !!vector });
      return;
    }

    // ── POST /ingest — bulk store pre-chunked content with vectors ─────────
    if (method === 'POST' && (url === '/ingest' || url === '/v1/memory/ingest' || url === '/memory/ingest')) {
      const body      = await readBody(req);
      const namespace = (body.namespace || req.headers['x-namespace'] || 'knowledge-base').trim();
      const chunks    = Array.isArray(body.chunks) ? body.chunks : [];
      const source    = body.source || 'document';
      if (!chunks.length) { json(res, 400, { error: 'chunks array required' }); return; }
      const db = getDB(ownerId, namespace);
      storeChunks(db, chunks, ownerId, namespace, source);
      json(res, 200, { ok: true, stored: chunks.length, namespace });
      return;
    }

    // ── GET /list ──────────────────────────────────────────────────────────
    if (method === 'GET' && (url === '/list' || url === '/v1/memory/list' || url === '/memory/list')) {
      const namespace = (req.headers['x-namespace'] || 'default').trim();
      const db        = getDB(ownerId, namespace);
      const all       = db.prepare('SELECT id, text, timestamp, meta FROM memories ORDER BY timestamp DESC').all();
      json(res, 200, {
        ok: true, namespace, count: all.length,
        memories: all.map(m => ({ id: m.id, text: m.text, timestamp: m.timestamp, meta: JSON.parse(m.meta || '{}') })),
      });
      return;
    }

    // ── GET /sources — list unique document sources in a namespace ─────────
    if (method === 'GET' && (url === '/sources' || url === '/v1/memory/sources' || url === '/memory/sources')) {
      const namespace = (req.headers['x-namespace'] || 'knowledge-base').trim();
      const db        = getDB(ownerId, namespace);
      const all       = db.prepare('SELECT meta FROM memories').all();
      const sourceMap = {};
      all.forEach(function(m) {
        const meta = JSON.parse(m.meta || '{}');
        const src  = meta.source || 'unknown';
        if (!sourceMap[src]) sourceMap[src] = 0;
        sourceMap[src]++;
      });
      const sources = Object.entries(sourceMap).map(function(e) { return { source: e[0], chunks: e[1] }; });
      json(res, 200, { ok: true, namespace, sources });
      return;
    }

    // ── GET /namespaces ────────────────────────────────────────────────────
    if (method === 'GET' && (url === '/namespaces' || url === '/v1/memory/namespaces' || url === '/memory/namespaces')) {
      const dir = path.join(CONFIG.DATA_DIR, ownerId);
      if (!fs.existsSync(dir)) { json(res, 200, { ok: true, namespaces: [] }); return; }
      const namespaces = fs.readdirSync(dir).filter(f => f.endsWith('.db')).map(function(f) {
        const ns    = f.replace('.db', '');
        const db    = getDB(ownerId, ns);
        const count = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
        const vecs  = db.prepare("SELECT COUNT(*) as c FROM memories WHERE vector IS NOT NULL").get().c;
        return { namespace: ns, count, vectorized: vecs, ragEnabled: vecs > 0, isPublic: CONFIG.PUBLIC_NAMESPACES.includes(ns) };
      });
      json(res, 200, { ok: true, namespaces });
      return;
    }

    // ── GET /stats ─────────────────────────────────────────────────────────
    if (method === 'GET' && (url === '/stats' || url === '/v1/memory/stats' || url === '/memory/stats')) {
      const namespace = (req.headers['x-namespace'] || 'default').trim();
      const db        = getDB(ownerId, namespace);
      const count     = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
      const vecs      = db.prepare("SELECT COUNT(*) as c FROM memories WHERE vector IS NOT NULL").get().c;
      json(res, 200, { ok: true, namespace, count, vectorized: vecs, ragEnabled: vecs > 0, ownerId: ownerId.slice(0,8) + '...' });
      return;
    }

    // ── DELETE /source — remove all chunks from a document source ──────────
    if (method === 'DELETE' && (url === '/source' || url === '/v1/memory/source' || url === '/memory/source')) {
      const body      = await readBody(req);
      const namespace = (body.namespace || req.headers['x-namespace'] || 'knowledge-base').trim();
      const source    = body.source;
      if (!source) { json(res, 400, { error: 'source required' }); return; }
      const db      = getDB(ownerId, namespace);
      const result  = db.prepare("DELETE FROM memories WHERE json_extract(meta, '$.source') = ?").run(source);
      json(res, 200, { ok: true, removed: result.changes, namespace });
      return;
    }

    // ── DELETE /memories/:id ───────────────────────────────────────────────
    if (method === 'DELETE' && url.startsWith('/memories/') && url.length > '/memories/'.length) {
      const namespace = (req.headers['x-namespace'] || 'default').trim();
      const id        = decodeURIComponent(url.slice('/memories/'.length));
      getDB(ownerId, namespace).prepare('DELETE FROM memories WHERE id = ?').run(id);
      json(res, 200, { ok: true });
      return;
    }

    // ── DELETE /memories — clear namespace ─────────────────────────────────
    if (method === 'DELETE' && (url === '/memories' || url === '/v1/memory/memories' || url === '/memory/memories')) {
      const namespace = (req.headers['x-namespace'] || 'default').trim();
      getDB(ownerId, namespace).prepare('DELETE FROM memories').run();
      json(res, 200, { ok: true, namespace });
      return;
    }

    json(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('[ng-memory-server] Error:', err.message);
    json(res, 500, { error: err.message });
  }
});

server.listen(CONFIG.PORT, function() {
  console.log('\n👻 ng-memory-server v0.3.0');
  console.log('─────────────────────────────────────');
  console.log('Port:              ' + CONFIG.PORT);
  console.log('Data dir:          ' + CONFIG.DATA_DIR);
  console.log('Max memories:      ' + CONFIG.MAX_MEMORIES);
  console.log('Public namespaces: ' + CONFIG.PUBLIC_NAMESPACES.join(', '));
  console.log('─────────────────────────────────────');
  console.log('Endpoints:');
  console.log('  GET    /health           public');
  console.log('  POST   /public/recall    public read-only recall');
  console.log('  POST   /upload           upload + auto-ingest file (PDF/TXT/MD)');
  console.log('  POST   /recall           semantic recall (vector or keyword)');
  console.log('  POST   /remember         extract + store from conversation');
  console.log('  POST   /store            store single memory');
  console.log('  POST   /ingest           bulk store pre-chunked content');
  console.log('  GET    /list             list memories');
  console.log('  GET    /sources          list document sources');
  console.log('  GET    /namespaces       list namespaces');
  console.log('  GET    /stats            memory count + RAG status');
  console.log('  DELETE /source           remove document by source name');
  console.log('  DELETE /memories         clear namespace');
  console.log('  DELETE /memories/:id     forget one memory');
  console.log('─────────────────────────────────────\n');
});
