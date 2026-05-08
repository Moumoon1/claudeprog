window.addEventListener('message', function(event) {
  if (event.source !== window) return;
  if (event.data && event.data.source === 'design-pilot-prd') {
    var actionName = event.data.action === 'ping' ? 'ping' : 'fetchPrdContent';
    console.log('[DesignPilot content] Forwarding action:', actionName, 'url:', event.data.url);
    chrome.runtime.sendMessage(
      { action: actionName, url: event.data.url, requestId: event.data.requestId },
      function(response) {
        if (chrome.runtime.lastError) {
          console.log('[DesignPilot content] Runtime error:', chrome.runtime.lastError.message);
          window.postMessage(
            { source: 'design-pilot-prd-response', requestId: event.data.requestId, success: false, error: chrome.runtime.lastError.message },
            event.origin
          );
          return;
        }
        console.log('[DesignPilot content] Got response:', response && response.success, (response && response.error) || '');
        window.postMessage(
          { source: 'design-pilot-prd-response', requestId: event.data.requestId, success: (response && response.success) || false, title: response && response.title, text: response && response.text, images: response && response.images, meta: response && response.meta, error: response && response.error },
          event.origin
        );
      }
    );
  }
});

window.postMessage({ source: 'design-pilot-prd-response', ready: true }, '*');
