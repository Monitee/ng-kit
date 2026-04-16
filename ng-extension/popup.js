// popup.js - No inline handlers, all wired here

document.addEventListener('DOMContentLoaded', function() {
  // Tab switching
  document.getElementById('tabMemory').addEventListener('click', function() { switchTab('memory'); });
  document.getElementById('tabSettings').addEventListener('click', function() { switchTab('settings'); });

  // Memory actions
  document.getElementById('addBtn').addEventListener('click', addManual);
  document.getElementById('clearBtn').addEventListener('click', clearAll);
  document.getElementById('manualInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') addManual();
  });

  // Settings
  document.getElementById('saveBtn').addEventListener('click', saveSettings);

  // Init
  loadSettings();
  loadMemories();
});

function switchTab(tab) {
  document.getElementById('tabMemory').classList.toggle('active', tab === 'memory');
  document.getElementById('tabSettings').classList.toggle('active', tab === 'settings');
  document.getElementById('tab-memory').classList.toggle('active', tab === 'memory');
  document.getElementById('tab-settings').classList.toggle('active', tab === 'settings');
  if (tab === 'memory') loadMemories();
}

function loadSettings() {
  chrome.storage.local.get(['ngApiKey', 'userId', 'memoryEnabled', 'inferenceUrl'], function(r) {
    document.getElementById('apiKeyInput').value       = r.ngApiKey      || '';
    document.getElementById('userIdInput').value       = r.userId        || '';
    document.getElementById('inferenceUrlInput').value = r.inferenceUrl  || 'https://nodeghost.ai/v1';
    document.getElementById('enabledToggle').checked   = r.memoryEnabled !== false;
    updatePill(r.ngApiKey, r.memoryEnabled !== false);
  });
}

function updatePill(hasKey, enabled) {
  var pill = document.getElementById('statusPill');
  if (hasKey && enabled) {
    pill.textContent = 'ON'; pill.className = 'status-pill on';
  } else {
    pill.textContent = hasKey ? 'PAUSED' : 'SETUP'; pill.className = 'status-pill off';
  }
}

function saveSettings() {
  var data = {
    ngApiKey:      document.getElementById('apiKeyInput').value.trim(),
    userId:        document.getElementById('userIdInput').value.trim() || 'default',
    inferenceUrl:  document.getElementById('inferenceUrlInput').value.trim() || 'https://nodeghost.ai/v1',
    memoryEnabled: document.getElementById('enabledToggle').checked,
  };
  chrome.storage.local.set(data, function() {
    var msg = document.getElementById('saveMsg');
    msg.textContent = '✓ Saved';
    setTimeout(function() { msg.textContent = ''; }, 2000);
    updatePill(data.ngApiKey, data.memoryEnabled);
  });
}

function loadMemories() {
  sendBg({ type: 'getMemories' }, function(res) {
    var memories = (res && res.ok && res.memories) ? res.memories : [];
    var docs  = memories.filter(function(m) { return m.meta && m.meta.type === 'document'; });
    var conv  = memories.filter(function(m) { return !m.meta || m.meta.type !== 'document'; });
    document.getElementById('memCount').textContent = conv.length;
    document.getElementById('docCount').textContent = new Set(docs.map(function(d) { return d.meta && d.meta.source; })).size;
    renderList(conv);
  });
}

function renderList(memories) {
  var list = document.getElementById('memoryList');
  if (!memories.length) {
    list.innerHTML = '<div class="empty-msg">No memories yet.<br>Start chatting with any NodeGhost-powered app.</div>';
    return;
  }
  var sorted = memories.slice().sort(function(a,b) { return b.timestamp - a.timestamp; }).slice(0, 40);
  list.innerHTML = '';
  sorted.forEach(function(m) {
    var item = document.createElement('div');
    item.className = 'memory-item';
    item.innerHTML = '<div class="memory-item-text">' + esc(m.text) +
      '<div class="memory-item-source">' + esc((m.meta && m.meta.source) || 'conversation') + '</div></div>';
    var btn = document.createElement('button');
    btn.className = 'memory-del';
    btn.textContent = '✕';
    btn.addEventListener('click', (function(id) {
      return function() { delMemory(id); };
    })(m.id));
    item.appendChild(btn);
    list.appendChild(item);
  });
}

function addManual() {
  var input = document.getElementById('manualInput');
  var text = input.value.trim();
  if (!text) return;
  sendBg({ type: 'storeManual', text: text }, function() {
    input.value = '';
    loadMemories();
  });
}

function delMemory(id) {
  sendBg({ type: 'deleteMemory', id: id }, function() { loadMemories(); });
}

function clearAll() {
  if (!confirm('Clear all memories?')) return;
  sendBg({ type: 'clearAll' }, function() { loadMemories(); });
}

function sendBg(msg, callback) {
  chrome.runtime.sendMessage(msg, function(res) {
    if (chrome.runtime.lastError) {
      callback({ ok: false });
    } else {
      callback(res || { ok: false });
    }
  });
}

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
