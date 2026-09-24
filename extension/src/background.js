const XRAY_NATIVE_HOST = 'com.odoo_xray.editor';
const XRAY_LOCAL_BRIDGE = 'http://127.0.0.1:17654/open';
const XRAY_FALLBACK_DELAY_MS = 900;

function xrayAllowedSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab?.url) return false;
  try {
    const url = new URL(sender.tab.url);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.pathname.startsWith('/web') || url.pathname === '/odoo' || url.pathname.startsWith('/odoo/'));
  } catch (_error) {
    return false;
  }
}

function xrayValidOpenMessage(message) {
  return message?.type === 'xray.openInEditor' &&
    typeof message.file === 'string' &&
    message.file.startsWith('/') &&
    !message.file.includes('\0') &&
    Number.isInteger(message.line) &&
    message.line > 0;
}

function xrayValidLookup(message) {
  const request = message?.request;
  if (message?.type !== 'xray.localRequest') return false;
  if (['locate_field', 'locate_method'].includes(request?.action)) {
    return typeof request.model === 'string' && typeof (request.field || request.method) === 'string';
  }
  if (request?.action === 'locate_view') {
    return typeof request.xml_id === 'string' && typeof request.arch_fs === 'string' &&
      typeof request.arch === 'string' && request.arch.length <= 1024 * 1024 &&
      Array.isArray(request.nodes) && request.nodes.length <= 64 &&
      request.nodes.every((n) => Number.isInteger(n) && n >= 0);
  }
  return false;
}

function xraySendLocal(request, sendResponse) {
  chrome.runtime.sendNativeMessage(XRAY_NATIVE_HOST, request, (response) => {
    const nativeError = chrome.runtime.lastError?.message;
    if (!nativeError && response?.ok) {
      sendResponse(response);
      return;
    }
    fetch(XRAY_LOCAL_BRIDGE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Odoo-XRay-Extension': chrome.runtime.id,
      },
      body: JSON.stringify(request),
    })
      .then(async (bridgeResponse) => {
        const body = await bridgeResponse.json();
        if (!bridgeResponse.ok || !body.ok) throw new Error(body.error || 'ponte local recusou o pedido');
        sendResponse(body);
      })
      .catch((error) => sendResponse({
        error: [nativeError, 'ponte local: ' + error.message].filter(Boolean).join('; '),
      }));
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!xrayAllowedSender(sender) || !(xrayValidOpenMessage(message) || xrayValidLookup(message))) {
    sendResponse({ ok: false, error: 'pedido de abertura inválido' });
    return false;
  }

  if (xrayValidLookup(message)) {
    chrome.storage.sync.get(['mappings'], (settings) => {
      const roots = (settings.mappings || []).map((mapping) => mapping.host);
      xraySendLocal({ ...message.request, roots }, sendResponse);
    });
    return true;
  }

  const request = { action: 'open', file: message.file, line: message.line };
  setTimeout(() => {
    xraySendLocal(request, sendResponse);
  }, XRAY_FALLBACK_DELAY_MS);
  return true;
});
