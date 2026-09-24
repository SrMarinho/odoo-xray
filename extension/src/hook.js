// Runs in the page (MAIN world) from document_start: records the views Odoo
// itself loaded, so the panel inspects the exact arch the client rendered.
// Odoo 19's rpc() uses XMLHttpRequest; get_views may later be served from the
// client's RAM cache, which is why the capture starts with the page.
(() => {
  const captured = [];
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.xrayGetViews = /\/web\/dataset\/call_kw\/[^/]+\/get_views(?:\?|$)/.test(String(url));
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.xrayGetViews) {
      this.addEventListener('load', () => {
        try {
          const params = JSON.parse(body).params;
          const result = JSON.parse(this.responseText).result;
          if (!result?.views) return;
          captured.push({
            model: params.model,
            views: params.kwargs?.views || params.args?.[0] || [],
            options: params.kwargs?.options || {},
            context: params.kwargs?.context || {},
            result: Object.fromEntries(Object.entries(result.views).map(([type, view]) =>
              [type, { id: view.id, arch: view.arch, model: view.model }])),
          });
          if (captured.length > 30) captured.shift();
        } catch (_error) { /* not a JSON-RPC get_views call */ }
      });
    }
    return send.call(this, body);
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'odoo-xray' || event.data.type !== 'views?') return;
    window.postMessage({ source: 'odoo-xray', type: 'views', id: event.data.id, captured,
      lang: document.documentElement.lang }, '*');
  });
})();
