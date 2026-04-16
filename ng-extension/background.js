// NodeGhost Memory - Background Service Worker

const STORAGE_KEY = 'ng_memories_';

function getSettings() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(['ngApiKey', 'userId', 'memoryEnabled', 'inferenceUrl'], function(r) {
      resolve({
        ngApiKey:      r.ngApiKey      || '',
        userId:        r.userId        || 'default',
        memoryEnabled: r.memoryEnabled !== false,
        inferenceUrl:  r.inferenceUrl  || 'https://nodeghost.ai/v1',
      });
    });
  });
}

function getMemories(userId) {
  return new Promise(function(resolve) {
    chrome.storage.local.get([STORAGE_KEY + userId], function(r) {
      resolve(r[STORAGE_KEY + userId] || []);
    });
  });
}

function saveMemories(userId, memories) {
  return new Promise(function(resolve) {
    var data = {};
    data[STORAGE_KEY + userId] = memories;
    chrome.storage.local.set(data, resolve);
  });
}

function simpleRecall(query, memories, topK) {
  topK = topK || 5;
  if (!memories.length) return [];
  if (memories.length <= 20) return memories.slice(0, topK);
  var words = query.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
  var scored = memories.map(function(m) {
    var text = m.text.toLowerCase();
    var score = words.reduce(function(sum, w) { return sum + (text.includes(w) ? 1 : 0); }, 0);
    return Object.assign({}, m, { score: score });
  });
  return scored.sort(function(a, b) { return b.score - a.score; }).slice(0, topK);
}

function extractFacts(userMsg, assistantMsg, settings) {
  if (!settings.ngApiKey) return Promise.resolve([]);
  var prompt = 'Extract key facts worth remembering from this exchange.\nFocus on: personal information, preferences, decisions, important context.\nReturn ONLY a JSON array of concise strings. Return [] if nothing memorable.\nNo markdown, no extra text.\n\nUser: ' + userMsg.slice(0, 400) + '\nAssistant: ' + assistantMsg.slice(0, 400) + '\n\nJSON array:';
  return fetch(settings.inferenceUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.ngApiKey },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 200, temperature: 0.1 }),
  }).then(function(res) {
    if (!res.ok) return [];
    return res.json().then(function(data) {
      var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '[]';
      var clean = text.replace(/```json|```/g, '').trim();
      try {
        var facts = JSON.parse(clean);
        return Array.isArray(facts) ? facts.filter(function(f) { return typeof f === 'string' && f.length > 10; }).slice(0, 8) : [];
      } catch(e) { return []; }
    });
  }).catch(function() { return []; });
}

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  handleMessage(message).then(sendResponse).catch(function(err) {
    sendResponse({ ok: false, error: err.message });
  });
  return true;
});

function handleMessage(msg) {
  return getSettings().then(function(settings) {
    var userId = settings.userId;

    if (msg.type === 'recall') {
      if (!settings.memoryEnabled) return { ok: true, memoryBlock: null };
      return getMemories(userId).then(function(all) {
        var relevant = simpleRecall(msg.query, all);
        if (!relevant.length) return { ok: true, memoryBlock: null };
        var lines = relevant.map(function(m) { return '- ' + m.text; }).join('\n');
        return { ok: true, memoryBlock: 'Relevant context from memory:\n' + lines };
      });
    }

    if (msg.type === 'remember') {
      if (!settings.memoryEnabled || !settings.ngApiKey) return Promise.resolve({ ok: false });
      return extractFacts(msg.userMsg, msg.assistantMsg, settings).then(function(facts) {
        if (!facts.length) return { ok: true, stored: 0 };
        return getMemories(userId).then(function(all) {
          var now = Date.now();
          facts.forEach(function(fact) {
            all.push({ id: userId + '-' + now + '-' + Math.random().toString(36).slice(2,7), userId: userId, text: fact, timestamp: now, meta: { source: 'conversation' } });
          });
          if (all.length > 500) all.splice(0, all.length - 500);
          return saveMemories(userId, all).then(function() { return { ok: true, stored: facts.length }; });
        });
      });
    }

    if (msg.type === 'getMemories') {
      return getMemories(userId).then(function(all) { return { ok: true, memories: all }; });
    }

    if (msg.type === 'getStats') {
      return getMemories(userId).then(function(all) { return { ok: true, count: all.length, userId: userId }; });
    }

    if (msg.type === 'storeManual') {
      return getMemories(userId).then(function(all) {
        all.push({ id: userId + '-' + Date.now() + '-manual', userId: userId, text: msg.text, timestamp: Date.now(), meta: { source: 'manual' } });
        return saveMemories(userId, all).then(function() { return { ok: true }; });
      });
    }

    if (msg.type === 'deleteMemory') {
      return getMemories(userId).then(function(all) {
        return saveMemories(userId, all.filter(function(m) { return m.id !== msg.id; })).then(function() { return { ok: true }; });
      });
    }

    if (msg.type === 'clearAll') {
      return saveMemories(userId, []).then(function() { return { ok: true }; });
    }

    return Promise.resolve({ ok: false, error: 'Unknown type: ' + msg.type });
  });
}

console.log('[ng-memory] Service worker started');
