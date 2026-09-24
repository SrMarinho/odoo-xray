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
  if (info.model && (info.identity || info.field || info.tag)) {
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
    .xpath-copy-row { display:flex; align-items:flex-start; gap:8px; margin:6px 0; }
    .xpath-expression { flex:1; min-width:0; cursor:pointer; }
    .xpath-expression:hover { color:#4ec9b0; }
    .xpath-expression:focus-visible { outline:2px solid #4ec9b0; outline-offset:2px; }
    .xpath-copy-icon { flex:none; display:flex; padding:5px; }
    details { margin-top:8px; } summary { cursor:pointer; color:#9cdcfe; }
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

async function xrayCopyXPath(expression, parent) {
  try {
    await navigator.clipboard.writeText(expression);
    return true;
  } catch (_error) {
    const input = document.createElement('textarea');
    input.value = expression;
    input.setAttribute('aria-label', 'XPath para cópia');
    input.style.cssText = 'position:fixed;opacity:0;';
    const previous = parent.getRootNode().activeElement || document.activeElement;
    parent.appendChild(input);
    try {
      input.focus();
      input.select();
      return document.execCommand('copy');
    } catch (_fallbackError) {
      return false;
    } finally {
      input.remove();
      previous?.focus();
    }
  }
}

function xrayRenderXPath(parent, xpath, view, ambiguous = false, legacy = false) {
  xrayText(parent, 'h3', 'XPath do campo');
  if (!xpath) {
    xrayText(parent, 'p', 'Não foi possível determinar o XPath deste campo.', 'muted');
    return;
  }
  const row = xrayText(parent, 'div', '', 'xpath-copy-row');
  const expression = xrayText(row, 'pre', xpath.expression, 'xpath-expression');
  expression.setAttribute('role', 'button');
  expression.tabIndex = 0;
  expression.title = 'Clique para copiar o XPath';
  const copy = xrayText(row, 'button', '', 'xpath-copy-icon');
  copy.setAttribute('aria-label', 'Copiar XPath');
  copy.title = 'Copiar XPath';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ width: '16', height: '16', viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'aria-hidden': 'true', focusable: 'false' })) {
    svg.setAttribute(name, value);
  }
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  icon.setAttribute('d', 'M9 9h12v12H9z M5 15H3V3h12v2');
  svg.appendChild(icon);
  copy.appendChild(svg);
  const status = xrayText(parent, 'span', '');
  status.setAttribute('aria-live', 'polite');
  let feedbackTimer = null;
  const showCopyIcon = () => {
    clearTimeout(feedbackTimer);
    copy.replaceChildren(svg);
    copy.setAttribute('aria-label', 'Copiar XPath');
    copy.title = 'Copiar XPath';
  };
  const copyXPath = async () => {
    const copied = await xrayCopyXPath(xpath.expression, parent);
    if (copied) {
      clearTimeout(feedbackTimer);
      copy.replaceChildren('Copiado');
      copy.setAttribute('aria-label', 'XPath copiado');
      copy.title = 'XPath copiado';
      status.textContent = '';
      feedbackTimer = setTimeout(showCopyIcon, 1200);
    } else {
      showCopyIcon();
      status.textContent = ' Não foi possível copiar. Selecione o XPath e copie manualmente.';
    }
  };
  copy.addEventListener('click', copyXPath);
  expression.addEventListener('click', copyXPath);
  expression.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    copyXPath();
  });
  const labels = [legacy ? 'Via addon' : {
    confirmed: 'Conferido no servidor',
    divergent: 'Não confirmado no servidor',
    unavailable: 'Sem conferência no servidor',
  }[xpath.server]];
  if (xpath.matches != null) labels.push(xpath.matches + (xpath.matches === 1 ? ' ocorrência' : ' ocorrências'));
  if (ambiguous) labels.push('Campo ambíguo');
  xrayText(parent, 'div', labels.join(' · '), 'muted');
  const details = xrayText(parent, 'details', '');
  xrayText(details, 'summary', 'Detalhes');
  xrayText(details, 'p', legacy ?
    'XPath gerado pelo nome do campo. O addon validou o elemento, mas não contou as ocorrências deste seletor.' :
    xpath.matches + (xpath.matches === 1 ? ' correspondência' : ' correspondências') + ' no XML recomposto. ' + ({
      confirmed: 'Conferido na arquitetura retornada pelo servidor.',
      divergent: 'Não confirmado na arquitetura do servidor; a estrutura ou correspondência difere.',
      unavailable: 'Arquitetura do servidor indisponível para conferência.',
    }[xpath.server]), 'muted');
  if (view) xrayText(details, 'div', 'View: ' + (view.xml_id || ((view.name || 'View') + ' (ID ' + view.id + ')')), 'muted');
  if (ambiguous) xrayText(details, 'p', 'Este XPath pode identificar mais de um campo; a correspondência com o campo da tela permanece ambígua.', 'muted');
  xrayText(details, 'p', 'A aplicação numa view herdada depende das dependências do módulo e da ordem de herança.', 'muted');
}

function xrayLegacyFieldXPath(result, info) {
  const name = result.target.field || result.target.name || info.field;
  if (!name) return null;
  const lineage = result.breadcrumbs || [];
  let subviewIndex = -1;
  for (let i = lineage.length - 2; i >= 0; i--) {
    if (['list', 'tree'].includes(lineage[i].tag)) { subviewIndex = i; break; }
  }
  let parentField = null;
  for (let i = subviewIndex - 1; i >= 0; i--) {
    if (lineage[i].tag === 'field' && lineage[i].name) { parentField = lineage[i].name; break; }
  }
  return {
    expression: xrayFieldXPathExpression(name, parentField ? {
      field: parentField, tag: lineage[subviewIndex].tag,
    } : null),
    strategy: 'attribute', matches: null, server: 'unavailable',
  };
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
  if (result.candidates) {
    await xrayRenderOrigin(body, result, request);
    return;
  }
  xrayText(body, 'p', result.view.xml_id || result.view.name);
  xrayText(body, 'pre', result.target.path, 'muted');
  if (result.target.tag === 'field') {
    xrayRenderXPath(body, xrayLegacyFieldXPath(result, info), result.view, false, true);
  }
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

const XRAY_CERTAINTY_LABEL = {
  exata: 'Origem exata', 'provável': 'Origem provável',
  'ambígua': 'Origem ambígua — múltiplas correspondências', desconhecida: 'Origem não determinada',
};

// Asks the native host for the exact declaration line(s) of a view's own
// node indexes. A view with no xml_id/arch_fs (Studio, direct database
// customization) or no configured mapping degrades to a clear explanation
// instead of a guessed line — see README "Origem nas views".
async function xrayResolveViewLocation(view, indexes) {
  if (!view) return { file: null, warning: 'View não encontrada nesta consulta.' };
  if (!view.arch_fs) {
    return { file: null, warning: view.xml_id ?
      'Sem arquivo declarado para esta view (arch_fs ausente).' :
      'View sem XML ID: customização direta no banco (Studio ou similar).' };
  }
  const res = await xrayLocateViewSource(view, [...new Set(indexes)]);
  if (res.error) return { file: null, warning: res.error };
  if (!res.matches?.length) {
    return { file: null, warning: 'Arquivo declarado (' + view.arch_fs + ') não encontrado nos diretórios mapeados.' };
  }
  if (res.matches.length > 1) return { ambiguous: true, matches: res.matches };
  const match = res.matches[0];
  return { file: match.file, line: match.record_line, exact: match.exact, indexLines: match.lines };
}

function xrayRenderLocation(parent, resolved, index) {
  if (resolved.ambiguous) {
    xrayText(parent, 'div', 'O arquivo tem mais de um registro para esta view; correspondência ambígua.', 'muted');
    for (const match of resolved.matches) {
      const line = match.exact ? (match.lines[String(index)] ?? match.record_line) : match.record_line;
      xraySourceLink(parent, { file: match.file, line, host: true });
    }
    return;
  }
  if (!resolved.file) {
    xrayText(parent, 'div', resolved.warning || 'Origem no banco ou sem correspondência segura com arquivo.', 'muted');
    return;
  }
  if (!resolved.exact) {
    xrayText(parent, 'div', 'O arquivo local diverge da view no banco; linha do registro, não do elemento exato.', 'muted');
  }
  const line = resolved.exact ? (resolved.indexLines?.[String(index)] ?? resolved.line) : resolved.line;
  xraySourceLink(parent, { file: resolved.file, line, host: true });
}

async function xrayRenderCandidate(parent, result, candidate, request, heading) {
  if (result.target.tag === 'field') xrayRenderXPath(parent, candidate.xpath,
    result.views[result.loadedId], result.certainty === 'ambígua');
  const created = candidate.created;
  const view = created ? result.views[created.viewId] : null;
  const module = view?.xml_id ? view.xml_id.split('.', 1)[0] : null;
  xrayText(parent, heading, 'Criado em ' + (view?.xml_id || view?.name || 'view desconhecida') +
    (module ? ' (módulo ' + module + ')' : ''));
  if (candidate.replaced) {
    const replacedView = result.views[candidate.replaced.viewId];
    xrayText(parent, 'div', 'Substitui elemento criado em ' + (replacedView?.xml_id || replacedView?.name || '?'), 'muted');
  }
  const indexes = [created?.index, candidate.replaced?.index, ...candidate.events.map((e) => e.index)].filter((i) => i != null);
  const location = xrayText(parent, 'div', 'Localizando arquivo…', 'muted');
  const resolved = await xrayResolveViewLocation(view, indexes);
  if (request !== xrayPanelRequest) return;
  location.remove();
  xrayRenderLocation(parent, resolved, created?.index);

  if (!candidate.events.length) return;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Alterações (' + candidate.events.length + ')';
  details.appendChild(summary);
  parent.appendChild(details);
  for (const event of candidate.events) {
    const entry = xrayText(details, 'div', '', 'entry');
    const eventView = result.views[event.viewId];
    xrayText(entry, 'strong', (event.op === 'attributes' ? 'atributo' : event.op) +
      ' — ' + (eventView?.xml_id || eventView?.name || event.viewId));
    for (const [name, change] of Object.entries(event.changes || {})) {
      xrayText(entry, 'pre', name + ': ' + JSON.stringify(change.before) + ' → ' + JSON.stringify(change.after));
    }
    const eventLocation = xrayText(entry, 'div', 'Localizando…', 'muted');
    const eventResolved = await xrayResolveViewLocation(eventView, [event.index]);
    if (request !== xrayPanelRequest) return;
    eventLocation.remove();
    xrayRenderLocation(entry, eventResolved, event.index);
  }
}

async function xrayRenderOrigin(body, result, request) {
  xrayText(body, 'div', XRAY_CERTAINTY_LABEL[result.certainty] || result.certainty, 'muted');
  for (const warning of result.warnings || []) xrayText(body, 'p', warning, 'muted');
  if (!result.candidates.length) {
    if (result.target.tag === 'field') xrayRenderXPath(body, null);
    return;
  }

  if (result.candidates.length === 1) {
    await xrayRenderCandidate(body, result, result.candidates[0], request, 'h3');
    if (result.target.tag === 'button' && result.target.name) await xrayRenderMethod(body, result, request);
    return;
  }

  xrayText(body, 'h3', 'Candidatos (' + result.candidates.length + ')');
  if (result.evidence?.length) xrayText(body, 'p', 'Correspondência: ' + result.evidence.join(', '), 'muted');
  for (const candidate of result.candidates) {
    const entry = xrayText(body, 'div', '', 'entry');
    await xrayRenderCandidate(entry, result, candidate, request, 'strong');
  }
}

async function xrayRenderMethod(body, result, request) {
  xrayText(body, 'h3', 'Método Python ' + result.target.name);
  const methodBody = xrayText(body, 'div', 'Buscando método Python…', 'muted');
  const method = await xrayLocateMethod(result.model, result.target.name);
  if (request !== xrayPanelRequest) return;
  methodBody.replaceChildren();
  if (method.error) {
    xrayText(methodBody, 'p', method.error, 'error');
  } else if (!method.overrides?.length) {
    xrayText(methodBody, 'p', 'Método sem origem Python localizável.', 'muted');
  } else {
    for (const location of method.overrides) {
      const entry = xrayText(methodBody, 'div', '', 'entry');
      xrayText(entry, 'strong', (location.module || 'core') + ' — ' + location.klass);
      xraySourceLink(entry, location);
    }
  }
}

document.addEventListener('click', (event) => {
  if (!xrayEnabled || !event.altKey) return;
  if ((xrayTooltipEl && event.target === xrayTooltipEl.host) ||
      (xrayPanel && event.target === xrayPanel.host)) return;
  const info = xrayExtract(event.target);
  if (!info?.model || !(info.identity || info.field || info.tag)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  xrayResolveModel(info.model).then((model) => {
    info.model = model;
    xrayShowViewPanel(info);
  });
}, true);
