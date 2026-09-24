// call_kw same-origin, usa o cookie de sessão já ativo na aba. Sem CSRF
// token porque /web/dataset/call_kw aceita JSON-RPC sem ele (rota pública
// de leitura autenticada por sessão, igual o próprio JS do Odoo faz).
async function xrayCallKw(model, method, args, kwargs = {}) {
  const res = await fetch('/web/dataset/call_kw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { model, method, args, kwargs },
    }),
  });
  if (!res.ok) throw new Error('xray rpc http ' + res.status);
  const body = await res.json();
  if (body.error) throw new Error(body.error.data?.message || body.error.message || 'xray rpc error');
  return body.result;
}

const xrayCache = new Map(); // Deduplicate in-flight calls only; never retain session results.
const xrayModels = new Map();
const xrayActions = new Map();

// Resolves a route (a model, an action path, or "action-<id>") to the action
// record, when one exists. Reused by xrayResolveModel and by view resolution,
// which needs the action's own context (it may carry a form_view_ref).
async function xrayResolveAction(route) {
  if (!route || route.includes('.')) return null;
  if (!xrayActions.has(route)) {
    const action = route.match(/^action-(\d+)$/);
    const domain = action ? [['id', '=', Number(action[1])]] : [['path', '=', route]];
    const promise = xrayCallKw('ir.actions.act_window', 'search_read', [
      domain, ['id', 'res_model', 'views', 'context'], 0, 1,
    ]).then((actions) => actions[0] || null).catch(() => null);
    xrayActions.set(route, promise);
  }
  return xrayActions.get(route);
}

async function xrayResolveModel(route) {
  if (route.includes('.')) return route;
  if (!xrayModels.has(route)) {
    const promise = xrayResolveAction(route).then((action) => action?.res_model || route);
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

// Asks hook.js (page world, document_start) for the get_views calls it has
// seen since the page loaded. A short timeout covers pages hook.js never
// injected into (e.g. it loaded after our handshake) without hanging the panel.
function xrayGetCapture(timeoutMs = 200) {
  return new Promise((resolve) => {
    const id = Math.random();
    function onMessage(event) {
      if (event.source !== window || event.data?.source !== 'odoo-xray' ||
          event.data.type !== 'views' || event.data.id !== id) return;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(event.data);
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'odoo-xray', type: 'views?', id }, '*');
    const timer = setTimeout(() => { window.removeEventListener('message', onMessage); resolve(null); }, timeoutMs);
  });
}

// View provenance is intentionally fresh on every panel opening: edits, group
// changes and navigation must not reuse a previous resolution.
async function xrayLocateView(info) {
  if (info.viewId && info.identity) {
    return xrayCallKw('xray.xray', 'locate_view_node', [info.viewId, info.identity])
      .catch((e) => ({ error: e.message }));
  }
  const model = await xrayResolveModel(info.model);
  const warnings = [];
  const capture = await xrayGetCapture();
  const entries = (capture?.captured || []).filter((entry) => entry.model === model && entry.result.form);
  const chosen = entries.at(-1);
  let loadedId, serverArch;
  if (chosen) {
    if (entries.length > 1) warnings.push('Múltiplas cargas de views para este modelo nesta página; usando a mais recente.');
    loadedId = chosen.result.form.id;
    serverArch = chosen.result.form.arch;
  } else {
    warnings.push('Nenhuma chamada get_views capturada (cache do Odoo); consultando a view atual pelas APIs padrão.');
    try {
      const result = await xrayCallKw(model, 'get_views', [[[false, 'form']], {}]);
      loadedId = result.views.form?.id;
      serverArch = result.views.form?.arch;
    } catch (e) {
      return { error: 'Não foi possível obter a view atual: ' + e.message };
    }
  }
  if (!loadedId) return { error: 'Nenhuma view de formulário identificada para ' + model + '.' };

  const [views, modules] = await Promise.all([
    xrayCallKw('ir.ui.view', 'search_read', [
      [['model', '=', model]],
      ['id', 'name', 'xml_id', 'inherit_id', 'priority', 'mode', 'active', 'arch', 'arch_fs', 'model'],
    ], { context: { active_test: false } }).catch(() => null),
    xrayCallKw('ir.module.module', 'search_read', [[], ['name', 'state']]).catch(() => null),
  ]);
  if (!views) {
    return { error: 'Sem permissão para consultar ir.ui.view (requer o grupo Configurações técnicas). Origem indisponível.' };
  }
  if (!modules) warnings.push('Sem permissão para consultar ir.module.module; módulos não instalados podem aparecer na composição.');
  const installed = new Set((modules || []).filter((m) => m.state === 'installed').map((m) => m.name));
  const enriched = views.map((view) => ({
    ...view,
    // Views without an xml_id (Studio, direct database customization) are
    // never excluded: there is no module to check them against.
    excluded: !!view.xml_id && !!modules && !installed.has(view.xml_id.split('.')[0]),
  }));

  const target = {
    tag: info.tag || (info.field ? 'field' : null),
    name: info.field || info.name || null,
    label: info.label || null,
    context: info.context || {},
    occurrence: info.occurrence,
    count: info.occurrenceCount,
  };
  let resolution;
  try {
    resolution = xrayResolveOrigin({ loadedId, views: enriched, serverArch, target });
  } catch (e) {
    return { error: 'Falha ao recompor a herança da view: ' + e.message };
  }
  return {
    model, target, loadedId,
    certainty: resolution.certainty,
    evidence: resolution.evidence,
    candidates: resolution.candidates,
    applied: resolution.applied,
    views: Object.fromEntries(enriched.map((view) => [view.id, view])),
    warnings: [...warnings, ...resolution.warnings],
  };
}

async function xrayLocateViewSource(view, nodeIndexes) {
  return xrayLocalRequest({
    action: 'locate_view', xml_id: view.xml_id, arch_fs: view.arch_fs,
    arch: view.arch, nodes: nodeIndexes,
  }).catch((e) => ({ error: e.message }));
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
