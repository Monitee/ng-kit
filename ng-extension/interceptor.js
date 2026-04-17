// interceptor.js — Runs in page's MAIN world
// Overrides window.fetch to intercept NodeGhost API calls,
// inject memory context, and capture responses for memory storage

(function () {
  if (window.__ngMemoryActive) return;
  window.__ngMemoryActive = true;

  const originalFetch = window.fetch.bind(window);
  let requestCounter  = 0;
  const pendingRequests = new Map(); // requestId → { resolve, reject }

  // ── Listen for responses from the extension ─────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'ng-extension') return;

    const { requestId } = event.data;
    const pending = pendingRequests.get(requestId);
    if (pending) {
      pendingRequests.delete(requestId);
      pending.resolve(event.data);
    }
  });

  // ── Send message to extension and wait for response ──────────────────────
  function sendToExtension(message) {
    return new Promise((resolve, reject) => {
      const requestId = ++requestCounter;
      pendingRequests.set(requestId, { resolve, reject });

      // Timeout after 3 seconds — if extension doesn't respond, continue without memory
      const timeout = setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          resolve({ ok: false, timeout: true });
        }
      }, 3000);

      window.postMessage({
        source: 'ng-interceptor',
        requestId,
        ...message,
      }, '*');
    });
  }

  // ── Check if URL should be intercepted ───────────────────────────────────
  function isNodeGhostInference(url) {
    try {
      const u = new URL(url, window.location.href);
      return (
        (u.hostname === 'nodeghost.ai' || u.hostname === 'localhost') &&
        u.pathname.includes('/v1/chat/completions')
      );
    } catch {
      return false;
    }
  }

  // ── Override window.fetch ─────────────────────────────────────────────────
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;

    // Only intercept NodeGhost inference calls
    if (!isNodeGhostInference(url)) {
      return originalFetch(input, init);
    }

    try {
      // Parse the request body
      const bodyText = init.body || (input.body ? await input.clone().text() : null);
      if (!bodyText) return originalFetch(input, init);

      let body;
      try { body = JSON.parse(bodyText); } catch { return originalFetch(input, init); }

      // Skip if not a chat completions request
      if (!body.messages || !Array.isArray(body.messages)) {
        return originalFetch(input, init);
      }

      // Get the user's last message for memory recall
      const userMessages = body.messages.filter(m => m.role === 'user');
      const lastUserMsg  = userMessages[userMessages.length - 1]?.content || '';

      // Ask extension to recall relevant memories
      const recallResult = await sendToExtension({
        type:  'recall',
        query: lastUserMsg,
      });

      // Inject memory context into messages if we got any
      if (recallResult.ok && recallResult.memoryBlock) {
        const messages = [...body.messages];
        const sysIdx   = messages.findIndex(m => m.role === 'system');

        if (sysIdx >= 0) {
          messages[sysIdx] = {
            ...messages[sysIdx],
            content: messages[sysIdx].content + '\n\n' + recallResult.memoryBlock,
          };
        } else {
          messages.unshift({ role: 'system', content: recallResult.memoryBlock });
        }

        body = { ...body, messages };
        init = { ...init, body: JSON.stringify(body) };
      }

      // Make the actual request
      // Extract URL from input (may be string or Request object)
      // Pass as string + init to ensure custom headers (X-Endpoint-Key etc) are forwarded
      const requestUrl = typeof input === 'string' ? input : input.url;
      const originalHeaders = typeof input === 'object' && input.headers
        ? Object.fromEntries(input.headers.entries())
        : {};
      init = { ...init, headers: { ...originalHeaders, ...(init.headers || {}) } };
      const response = await originalFetch(requestUrl, init);

      // Capture response for memory extraction (clone so body can be read twice)
      const responseClone = response.clone();

      // Extract memories from response in background (non-blocking)
      responseClone.json().then(async (data) => {
        const assistantMsg = data?.choices?.[0]?.message?.content;
        if (assistantMsg && lastUserMsg) {
          await sendToExtension({
            type:      'remember',
            userMsg:   lastUserMsg,
            assistantMsg,
          });
        }
      }).catch(() => {}); // non-fatal

      return response;

    } catch (err) {
      // If anything goes wrong, fall through to original fetch
      console.warn('[ng-memory] Interceptor error (non-fatal):', err.message);
      return originalFetch(input, init);
    }
  };

  console.log('[ng-memory] Interceptor active');
})();
