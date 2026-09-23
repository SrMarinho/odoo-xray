// call_kw same-origin, usa o cookie de sessão já ativo na aba. Sem CSRF
// token porque /web/dataset/call_kw aceita JSON-RPC sem ele (rota pública
// de leitura autenticada por sessão, igual o próprio JS do Odoo faz).
async function xrayCallKw(model, method, args) {
  const res = await fetch('/web/dataset/call_kw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { model, method, args, kwargs: {} },
    }),
  });
  if (!res.ok) throw new Error('xray rpc http ' + res.status);
  const body = await res.json();
  if (body.error) throw new Error(body.error.data?.message || body.error.message || 'xray rpc error');
  return body.result;
}

const xrayCache = new Map(); // Deduplicate in-flight calls only; never retain session results.

async function xrayLocateField(model, field) {
  const key = model + '|' + field;
  if (xrayCache.has(key)) return xrayCache.get(key);
  const promise = xrayCallKw('xray.xray', 'locate_field', [model, field]).catch((e) => ({
    error: e.message,
  }));
  xrayCache.set(key, promise);
  promise.then(() => { if (xrayCache.get(key) === promise) xrayCache.delete(key); });
  return promise;
}

// View provenance is intentionally fresh on every panel opening: edits, group
// changes and navigation must not reuse a previous resolution.
async function xrayLocateView(info) {
  return xrayCallKw('xray.xray', 'locate_view_node', [info.viewId, info.identity])
    .catch((e) => ({ error: e.message }));
}

async function xrayLocateMethod(model, method) {
  return xrayCallKw('xray.xray', 'locate_method', [model, method])
    .catch((e) => ({ error: e.message }));
}

window.addEventListener('pageshow', () => xrayCache.clear());
window.addEventListener('popstate', () => xrayCache.clear());
