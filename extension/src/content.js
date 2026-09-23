// Orquestração: hover (com Alt) -> extract -> tooltip com o que já temos ->
// RPC em paralelo -> path rewrite -> click/Enter abre o editor.

const XRAY_DEBOUNCE_MS = 120;

// CSS do tooltip, injetado num Shadow DOM — por isso é uma string JS em vez
// de manifest.json "css": o tema do Odoo não pode vazar pra dentro nem o
// inverso, e content_scripts.css não atravessa a fronteira do shadow root.
// Vive aqui (não em arquivo à parte) porque um arquivo extra no content_scripts
// não estava sendo reinjetado pelo "recarregar" do Chrome — menos arquivos,
// menos chance de o browser perder um na hora de recarregar.
// :host, não '#xray-tooltip-host' — este CSS vive DENTRO do shadow root, e de
// lá um seletor de id não alcança o elemento host (que está fora). Com o
// seletor errado o host fica position:static e o tooltip vai parar no fim do
// documento em vez de ficar junto ao campo.
const XRAY_TOOLTIP_CSS = `
:host {
  position: fixed;
  z-index: 2147483647;
  display: none;
  font-family: monospace;
  font-size: 12px;
  pointer-events: auto;
}
.xray-box {
  background: #1e1e1e;
  color: #d4d4d4;
  border: 1px solid #454545;
  border-radius: 4px;
  padding: 6px 8px;
  min-width: 220px;
  max-width: 480px;
  box-shadow: 0 4px 12px rgba(0,0,0,.4);
}
.xray-row { padding: 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.xray-title { font-weight: bold; color: #9cdcfe; }
.xray-loading, .xray-muted { color: #808080; font-style: italic; }
.xray-error { color: #f48771; }
.xray-loc { cursor: default; }
.xray-clickable { cursor: pointer; color: #4ec9b0; }
.xray-clickable:hover, .xray-clickable:focus-visible { text-decoration: underline; }
.xray-view-button { margin-top:6px; padding:4px 8px; color:#eee; background:#333; border:1px solid #666; border-radius:4px; cursor:pointer; }
`;

let xrayEnabled = true;
let xrayMappings = []; // [{container: '/mnt/odoo-cotacao', host: '/home/.../odoo-cotacao'}]
let xrayEditorTemplate = 'vscode://file/{file}:{line}';

chrome.storage.sync.get(['enabled', 'mappings', 'editorTemplate'], (v) => {
  if (typeof v.enabled === 'boolean') xrayEnabled = v.enabled;
  if (Array.isArray(v.mappings)) xrayMappings = v.mappings;
  if (v.editorTemplate) xrayEditorTemplate = v.editorTemplate;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) xrayEnabled = changes.enabled.newValue;
  if (changes.mappings) xrayMappings = changes.mappings.newValue || [];
  if (changes.editorTemplate) xrayEditorTemplate = changes.editorTemplate.newValue;
});

// prefixo mais longo ganha; sem match => core (sem link)
function xrayRewritePath(containerPath) {
  if (!containerPath) return { host: null, core: false, unmapped: true };
  let best = null;
  for (const m of xrayMappings) {
    if (containerPath.startsWith(m.container) && (!best || m.container.length > best.container.length)) {
      best = m;
    }
  }
  if (!best) return { host: null, core: true, unmapped: false };
  return { host: best.host + containerPath.slice(best.container.length), core: false, unmapped: false };
}

function xrayOpenInEditor(file, line) {
  // Agenda o fallback no service worker antes de entregar o protocolo ao
  // navegador. Brave/Chrome podem suspender a página enquanto decidem como
  // tratar vscode://; um timer no content script se perdia nesse intervalo.
  chrome.runtime.sendMessage({ type: 'xray.openInEditor', file, line }, (res) => {
    const error = chrome.runtime.lastError?.message || res?.error;
    if (error) console.warn('Odoo X-Ray: fallback nativo indisponível:', error);
  });

  const editorUrl = xrayEditorTemplate
    .replace('{file}', encodeURI(file))
    .replace('{line}', String(line));
  window.location.href = editorUrl;
}

function xrayMakeEditorLink(element, file, line) {
  element.classList.add('xray-clickable');
  element.setAttribute('role', 'link');
  element.tabIndex = 0;
  element.title = 'Abrir no editor: ' + file + ':' + line;
  element.addEventListener('click', (e) => {
    e.stopPropagation();
    xrayOpenInEditor(file, line);
  });
  element.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    xrayOpenInEditor(file, line);
  });
}

let xrayTooltipEl = null;
let xrayAnchor = null;
let xrayHighlight = null;
let xrayPinnedAnchor = null;

function xrayElementTitle(info) {
  if (info.field) return info.model + '.' + info.field;
  const detail = info.label || info.name;
  return '<' + (info.tag || 'element') + (detail ? ' ' + detail : '') + '>';
}

function xrayShowHighlight(anchor, pinned = false) {
  if (!anchor?.isConnected) return;
  if (!xrayHighlight) {
    xrayHighlight = document.createElement('div');
    xrayHighlight.id = 'xray-highlight';
    xrayHighlight.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #4ec9b0;background:#4ec9b019;border-radius:3px;';
    document.documentElement.appendChild(xrayHighlight);
  }
  xrayAnchor = anchor;
  if (pinned) xrayPinnedAnchor = anchor;
  const rect = anchor.getBoundingClientRect();
  Object.assign(xrayHighlight.style, {
    display: 'block', left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
  });
}

function xrayHideHighlight() {
  if (xrayHighlight && !xrayPinnedAnchor) xrayHighlight.style.display = 'none';
}
function xrayGetTooltip() {
  if (xrayTooltipEl) return xrayTooltipEl;
  const host = document.createElement('div');
  host.id = 'xray-tooltip-host';
  // inline ganha do CSS da página e não depende do :host acima ter pegado
  host.style.cssText = 'position:fixed;z-index:2147483647;display:none;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = XRAY_TOOLTIP_CSS;
  shadow.appendChild(style);
  const box = document.createElement('div');
  box.className = 'xray-box';
  shadow.appendChild(box);
  xrayTooltipEl = { host, box };
  return xrayTooltipEl;
}

// Esconder tem uma folga de 250ms: sem isso, o instante em que o mouse sai
// do campo em direção ao próprio tooltip (pra clicar num link) já dispara
// hide antes do clique chegar — o tooltip "foge" do cursor.
let xrayHideTimer = null;
function xrayHide() {
  clearTimeout(xrayHideTimer);
  xrayHideTimer = setTimeout(() => {
    if (xrayTooltipEl) xrayTooltipEl.host.style.display = 'none';
    xrayHideHighlight();
  }, 250);
}

function xrayPositionTooltip() {
  if (xrayPinnedAnchor?.isConnected) xrayShowHighlight(xrayPinnedAnchor);
  else if (xrayAnchor?.isConnected && xrayHighlight?.style.display !== 'none') xrayShowHighlight(xrayAnchor);
  if (!xrayAnchor || !xrayTooltipEl || xrayTooltipEl.host.style.display === 'none') return;
  const { host } = xrayTooltipEl;
  if (!xrayAnchor.isConnected) {
    host.style.display = 'none';
    return;
  }
  const rect = xrayAnchor.getBoundingClientRect();
  const tooltip = host.getBoundingClientRect();
  const gap = 6;
  const left = Math.max(gap, Math.min(rect.left, window.innerWidth - tooltip.width - gap));
  let top = rect.bottom + gap;
  if (top + tooltip.height > window.innerHeight - gap) top = rect.top - tooltip.height - gap;
  top = Math.max(gap, Math.min(top, window.innerHeight - tooltip.height - gap));
  host.style.left = left + 'px';
  host.style.top = top + 'px';
}

window.addEventListener('scroll', xrayPositionTooltip, { capture: true, passive: true });
window.addEventListener('resize', xrayPositionTooltip);

function xrayRenderBasic(info, anchor) {
  clearTimeout(xrayHideTimer);
  xrayAnchor = anchor;
  const { host, box } = xrayGetTooltip();
  box.replaceChildren();
  xrayShowHighlight(anchor);
  xrayText(box, 'div', xrayElementTitle(info), 'xray-row xray-title');
  if (info.field) {
    xrayText(box, 'div', (info.type || '?') + (info.widget ? ' (' + info.widget + ')' : ''), 'xray-row');
    xrayText(box, 'div', 'resolvendo…', 'xray-row xray-loading');
  } else {
    xrayText(box, 'div', info.model, 'xray-row xray-muted');
  }
  if (info.model && (info.identity || info.field || info.tag === 'button')) {
    const button = xrayText(box, 'button', 'Ver origem na view', 'xray-view-button');
    button.addEventListener('click', () => xrayShowViewPanel(info));
  }
  host.style.display = 'block';
  xrayPositionTooltip();
}

function xrayRenderLocations(info, res) {
  const { box } = xrayGetTooltip();
  const loadingRow = box.querySelector('.xray-loading');
  if (!loadingRow) return; // hover já mudou de alvo

  if (res.error) {
    loadingRow.textContent = res.error;
    loadingRow.className = 'xray-row xray-error';
    return;
  }
  if (res.automatic) {
    loadingRow.textContent = 'campo automático do ORM (sem arquivo de origem)';
    loadingRow.className = 'xray-row xray-muted';
    return;
  }
  if (!res.locations || !res.locations.length) {
    loadingRow.textContent = res.warning ? 'Fonte local indisponível: ' + res.warning :
      'Nenhuma declaração Python encontrada nos diretórios mapeados.';
    loadingRow.className = 'xray-row xray-muted';
    return;
  }

  loadingRow.remove();
  const title = box.querySelector('.xray-title');
  let titleLinked = false;
  res.locations.forEach((loc, idx) => {
    const rewritten = loc.host ? { host: loc.file, core: false } : xrayRewritePath(loc.file);
    const row = document.createElement('div');
    row.className = 'xray-row xray-loc' + (rewritten.host ? ' xray-clickable' : '');
    const label = (idx === 0 ? '▶ ' : '  ') + loc.module + ' — ' + loc.klass + ':' + loc.line;
    row.textContent = rewritten.core ? label + ' (core, sem link)' : label;
    if (rewritten.host) {
      xrayMakeEditorLink(row, rewritten.host, loc.line);
      if (!titleLinked) {
        xrayMakeEditorLink(title, rewritten.host, loc.line);
        titleLinked = true;
      }
    }
    box.appendChild(row);
  });
  if (!titleLinked) {
    const hint = document.createElement('div');
    hint.className = 'xray-row xray-muted';
    hint.textContent = 'Configure o mapeamento container → host nas opções para abrir no editor.';
    box.appendChild(hint);
  }

  if (res.related) {
    const rel = document.createElement('div');
    rel.className = 'xray-row xray-muted';
    rel.textContent = 'related: ' + res.related;
    box.appendChild(rel);
  }
  if (res.warning) xrayText(box, 'div', 'Fonte local: ' + res.warning, 'xray-row xray-muted');
}

// e.altKey vem no próprio evento de mousemove, atualizado a cada disparo —
// mais confiável que rastrear keydown/keyup numa variável à parte (que
// trava 'preso' se o foco sair da página ou o SO engolir o keyup).
let xrayHoverTimer = null;

document.addEventListener('mousemove', (e) => {
  clearTimeout(xrayHoverTimer);
  // evento retargeted pro shadow host quando o mouse está em cima do próprio
  // tooltip (o listener está fora da shadow tree) — não conta como "saiu do
  // campo", senão nunca dá pra alcançar o link pra clicar.
  if ((xrayTooltipEl && e.target === xrayTooltipEl.host) || (xrayPanel && e.target === xrayPanel.host)) {
    clearTimeout(xrayHideTimer);
    return;
  }
  if (!xrayEnabled || !e.altKey) {
    xrayHide();
    return;
  }
  const target = e.target;
  xrayHoverTimer = setTimeout(async () => {
    const info = xrayExtract(target);
    if (!info) {
      xrayHide();
      return;
    }
    info.model = await xrayResolveModel(info.model);
    const anchor = info.node?.matches('[data-xray-model]') ? info.node :
      target.closest('.o_field_widget, .o_form_label, [data-tooltip-info]') || info.node;
    clearTimeout(xrayHideTimer);
    if (xrayAnchor === anchor && xrayTooltipEl && xrayTooltipEl.host.style.display !== 'none') return;
    xrayRenderBasic(info, anchor);
    if (info.field) {
      xrayLocateField(info.model, info.field).then((res) => {
        if (xrayAnchor !== anchor) return;
        xrayRenderLocations(info, res);
        xrayPositionTooltip();
      });
    }
  }, XRAY_DEBOUNCE_MS);
}, { passive: true });

function xrayText(parent, tag, text, className = '') {
  const el = document.createElement(tag);
  el.textContent = text;
  el.className = className;
  if (tag === 'button') el.type = 'button';
  parent.appendChild(el);
  return el;
}

let xrayPanel = null;
let xrayPanelRequest = 0;
function xrayClosePanel() {
  xrayPanelRequest++;
  if (xrayPanel) xrayPanel.host.style.display = 'none';
  xrayPinnedAnchor = null;
  xrayHideHighlight();
}

function xrayGetPanel() {
  if (xrayPanel) return xrayPanel;
  const host = document.createElement('div');
  host.id = 'xray-panel-host';
  host.style.cssText = 'position:fixed;right:0;top:0;height:100vh;width:min(520px,100vw);z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color:#ddd; font:13px/1.5 system-ui,sans-serif; }
    * { box-sizing:border-box; }
    .panel { height:100%; overflow:auto; background:#1e1e1e; border-left:1px solid #555; padding:18px; box-shadow:-4px 0 20px #0005; }
    .header { display:flex; justify-content:space-between; gap:12px; align-items:center; }
    button { cursor:pointer; background:#333; color:#eee; border:1px solid #666; border-radius:4px; padding:5px 9px; }
    h2 { font-size:16px; margin:0; overflow-wrap:anywhere; } h3 { margin:22px 0 8px; font-size:14px; }
    .entry { border-left:2px solid #555; padding:8px 12px; margin:8px 0; overflow-wrap:anywhere; }
    .breadcrumbs { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0; }
    .breadcrumbs button.active { border-color:#4ec9b0; color:#4ec9b0; }
    .muted { color:#aaa; } .error { color:#f48771; }
    .xray-clickable { color:#4ec9b0; cursor:pointer; } .xray-clickable:hover { text-decoration:underline; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:4px 0; font-size:12px; }
  `;
  shadow.appendChild(style);
  const box = document.createElement('aside');
  box.className = 'panel';
  box.setAttribute('aria-label', 'Odoo X-Ray: origem da view');
  shadow.appendChild(box);
  shadow.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); xrayClosePanel(); }
  });
  document.documentElement.appendChild(host);
  xrayPanel = { host, box };
  return xrayPanel;
}

function xraySourceLink(parent, source) {
  if (!source.file || !source.line) {
    xrayText(parent, 'div', 'Origem no banco ou sem correspondência segura com arquivo', 'muted');
    return;
  }
  const link = xrayText(parent, 'div', source.file + ':' + source.line);
  const mapped = source.host ? { host: source.file } : xrayRewritePath(source.file);
  if (mapped.host) xrayMakeEditorLink(link, mapped.host, source.line);
  else xrayText(parent, 'div', 'Configure o mapeamento deste caminho nas opções.', 'muted');
}

async function xrayShowViewPanel(info) {
  const request = ++xrayPanelRequest;
  if (info.node) xrayShowHighlight(info.node, true);
  const { host, box } = xrayGetPanel();
  host.style.display = 'block';
  box.replaceChildren();
  const header = xrayText(box, 'div', '', 'header');
  xrayText(header, 'h2', xrayElementTitle(info));
  const close = xrayText(header, 'button', 'Fechar');
  close.addEventListener('click', xrayClosePanel);
  close.focus();
  const body = xrayText(box, 'div', 'Resolvendo a herança da view…');
  const result = await xrayLocateView(info);
  if (request !== xrayPanelRequest) return;
  body.replaceChildren();
  if (result.error) { xrayText(body, 'p', result.error, 'error'); return; }
  if (result.views) {
    xrayRenderStandardViews(body, result.views, info);
    return;
  }
  xrayText(body, 'p', result.view.xml_id || result.view.name);
  xrayText(body, 'pre', result.target.path, 'muted');
  if (result.breadcrumbs?.length) {
    const breadcrumbs = xrayText(body, 'div', '', 'breadcrumbs');
    for (const item of result.breadcrumbs) {
      const label = item.label || item.name;
      const button = xrayText(breadcrumbs, 'button', item.tag + (label ? ': ' + label : ''),
        item.path === result.target.path ? 'active' : '');
      button.addEventListener('click', () => xrayShowViewPanel({
        ...info, tag: item.tag, name: item.name, label: item.label,
        field: item.identity.field || null, identity: item.identity,
      }));
    }
  }
  if (result.warning) xrayText(body, 'p', result.warning, 'muted');
  xrayText(body, 'h3', 'Histórico do elemento');
  for (const event of result.history) {
    const entry = xrayText(body, 'div', '', 'entry');
    const operation = event.operation === 'create' ? 'criação' : event.operation;
    xrayText(entry, 'strong', operation + (event.via ? ' via ' + event.via : '') + ' — ' + (event.view.xml_id || event.view.name));
    if (event.scope) xrayText(entry, 'div', 'No ancestral: ' + event.scope, 'muted');
    if (event.selector) xrayText(entry, 'pre', event.selector);
    for (const [name, change] of Object.entries(event.changes || {})) {
      xrayText(entry, 'pre', name + ': ' + JSON.stringify(change.before) + ' → ' + JSON.stringify(change.after));
    }
    xraySourceLink(entry, event);
  }
  xrayText(body, 'h3', 'Views na ordem de aplicação');
  for (const view of result.inheritance_chain) {
    const entry = xrayText(body, 'div', '', 'entry');
    xrayText(entry, 'strong', view.xml_id || view.name);
    xrayText(entry, 'div', 'ID ' + view.id + ' · prioridade ' + view.priority + ' · ' + view.mode, 'muted');
    xraySourceLink(entry, view);
  }
  const attrs = result.target.attributes || {};
  if (result.target.tag === 'button' && attrs.type === 'object' && attrs.name) {
    xrayText(body, 'h3', 'Método Python ' + attrs.name);
    const methodBody = xrayText(body, 'div', 'Localizando overrides…', 'muted');
    const method = await xrayLocateMethod(info.model, attrs.name);
    if (request !== xrayPanelRequest) return;
    methodBody.replaceChildren();
    if (method.error) {
      xrayText(methodBody, 'p', method.error, 'error');
    } else if (!method.overrides?.length) {
      xrayText(methodBody, 'p', 'Método sem origem Python localizável.', 'muted');
    } else {
      for (const override of method.overrides) {
        const entry = xrayText(methodBody, 'div', '', 'entry');
        xrayText(entry, 'strong', (override.module || 'core') + ' — ' + override.klass);
        xraySourceLink(entry, override);
      }
    }
  }
}

function xrayRenderStandardViews(body, views, info) {
  xrayText(body, 'p', 'Views do modelo lidas pelas APIs padrão do Odoo. A aplicação exata de cada operação de herança não é exposta pela API.', 'muted');
  const symbol = info.name || info.field;
  const candidates = views.filter((view) => {
    if (!symbol) return true;
    const xml = view.arch_db || '';
    return xml.includes('name="' + symbol + '"') || xml.includes("name='" + symbol + "'") ||
      xml.includes('@name=&quot;' + symbol + '&quot;');
  });
  xrayText(body, 'h3', 'Views que mencionam ' + (symbol || info.model));
  if (!candidates.length) xrayText(body, 'p', 'Nenhuma definição correspondente encontrada nas views acessíveis.', 'muted');
  for (const view of candidates) {
    const entry = xrayText(body, 'div', '', 'entry');
    xrayText(entry, 'strong', view.key || view.name);
    xrayText(entry, 'div', 'ID ' + view.id + ' · prioridade ' + view.priority +
      (view.inherit_id ? ' · herda ID ' + view.inherit_id[0] : ' · view base'), 'muted');
    if (view.arch_fs) xrayText(entry, 'div', 'Arquivo declarado: ' + view.arch_fs, 'muted');
    const snippet = (view.arch_db || '').split('\n').find((line) => symbol && line.includes(symbol));
    if (snippet) xrayText(entry, 'pre', snippet.trim());
  }
  if (info.tag === 'button' && info.name) {
    const methodBody = xrayText(body, 'div', 'Buscando método Python…', 'muted');
    xrayLocateMethod(info.model, info.name).then((result) => {
      methodBody.replaceChildren();
      for (const location of result.overrides || []) {
        const entry = xrayText(methodBody, 'div', '', 'entry');
        xrayText(entry, 'strong', location.module + ' — ' + location.klass);
        xraySourceLink(entry, location);
      }
    });
  }
}

document.addEventListener('click', (event) => {
  if (!xrayEnabled || !event.altKey) return;
  if ((xrayTooltipEl && event.target === xrayTooltipEl.host) ||
      (xrayPanel && event.target === xrayPanel.host)) return;
  const info = xrayExtract(event.target);
  if (!info?.model || !(info.identity || info.field || info.tag === 'button')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  xrayResolveModel(info.model).then((model) => {
    info.model = model;
    xrayShowViewPanel(info);
  });
}, true);
