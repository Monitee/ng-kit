// injector.js — Content script
// Runs in the extension context, injects interceptor.js into the page's main world
// so it can override window.fetch

(function () {
  if (window.__ngMemoryInjected) return;
  window.__ngMemoryInjected = true;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('interceptor.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // Bridge: page → extension (receive messages from interceptor.js)
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'ng-interceptor') return;

    // Forward to background service worker
    chrome.runtime.sendMessage(event.data, (response) => {
      if (chrome.runtime.lastError) return;
      // Send response back to page
      window.postMessage({
        source:    'ng-extension',
        requestId: event.data.requestId,
        ...response,
      }, '*');
    });
  });
})();
