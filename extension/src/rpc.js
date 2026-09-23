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
const xrayModels = new Map();

async function xrayResolveModel(route) {
  if (route.includes('.')) return route;
  if (!xrayModels.has(route)) {
    const promise = xrayCallKw('ir.actions.act_window', 'search_read', [
      [['path', '=', route]], ['res_model'], 0, 1,
    ]).then((actions) => actions[0]?.res_model || route).catch(() => route);
    xrayModels.set(route, promise);
  }
  return xrayModels.get(route);
}

async function xrayLocateField(model, field) {
  model = await xrayResolveModel(model);
  const key = model + '|' + field;
  if (xrayCache.has(key)) return xrayCache.get(key);
  const promise = Promise.all([
    xrayCallKw(model, 'fields_get', [[field], ['string', 'type', 'modules', 'related', 'compute', 'store']]),
    xrayLocalRequest({ action: 'locate_field', model, field }),
  ]).then(([fields, local]) => ({
    ...(fields[field] ? {} : { error: 'Campo não encontrado no modelo atual: ' + model + '.' + field }),
    model, field, type: fields[field]?.type, modules: fields[field]?.modules || [],
    related: fields[field]?.related, locations: local.locations || [],
    warning: local.error,
  })).catch((e) => ({ error: e.message }));
  xrayCache.set(key, promise);
  promise.then(() => { if (xrayCache.get(key) === promise) xrayCache.delete(key); });
  return promise;
}

// View provenance is intentionally fresh on every panel opening: edits, group
// changes and navigation must not reuse a previous resolution.
async function xrayLocateView(info) {
  if (info.viewId && info.identity) {
    return xrayCallKw('xray.xray', 'locate_view_node', [info.viewId, info.identity])
      .catch((e) => ({ error: e.message }));
  }
  const model = await xrayResolveModel(info.model);
  return xrayCallKw('ir.ui.view', 'search_read', [
    [['model', '=', model], ['type', '=', 'form'], ['active', '=', true]],
    ['id', 'name', 'key', 'inherit_id', 'priority', 'arch_db', 'arch_fs', 'mode'],
  ]).then((views) => ({ views })).catch((e) => ({ error: e.message }));
}

async function xrayLocateMethod(model, method) {
  model = await xrayResolveModel(model);
  return xrayLocalRequest({ action: 'locate_method', model, method })
    .catch((e) => ({ error: e.message }));
}

function xrayLocalRequest(request) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'xray.localRequest', request }, (response) => {
      resolve(response || { error: chrome.runtime.lastError?.message || 'ponte local indisponível' });
    });
  });
}

window.addEventListener('pageshow', () => xrayCache.clear());
window.addEventListener('popstate', () => { xrayCache.clear(); xrayModels.clear(); });
