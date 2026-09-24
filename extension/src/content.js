// Orquestração: hover ativado -> extract -> tooltip com o que já temos ->
// RPC em paralelo -> resolução local -> click/Enter abre o editor.

const XRAY_DEBOUNCE_MS = 120;
const XRAY_DEFAULT_HOVER_DELAY_MS = 700;

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
  visibility: visible;
  opacity: 0;
  transform: translateY(var(--xray-enter-distance, 4px)) scale(.985);
  pointer-events: none;
  font: 12px/1.45 var(--xray-font, system-ui, sans-serif);
  transition: opacity var(--xray-dur-fast, 120ms) var(--xray-ease, ease), transform var(--xray-dur-fast, 120ms) var(--xray-ease, ease);
  will-change: opacity, transform;
}
:host(.xray-hidden) { visibility: hidden; }
:host([data-placement="above"]) { transform: translateY(calc(-1 * var(--xray-enter-distance, 4px))) scale(.985); }
:host(.xray-open) {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
  transition-duration: var(--xray-dur-base, 180ms);
}
.xray-box {
  position: relative;
  overflow: hidden;
  min-width: 248px;
  max-width: min(460px, calc(100vw - 16px));
  padding: 12px;
  border: 1px solid var(--xray-border, #303a48);
  border-radius: var(--xray-radius, 12px);
  background: linear-gradient(145deg, var(--xray-surface-raised, #202833), var(--xray-bg, #11151c));
  color: var(--xray-text, #edf2f7);
  box-shadow: var(--xray-shadow, 0 18px 50px rgba(0,0,0,.38));
  backdrop-filter: blur(12px);
}
.xray-box::before { content:""; position:absolute; inset:0 auto 0 0; width:2px; background:var(--xray-accent-gradient, var(--xray-accent, #5eead4)); }
.xray-row { padding: 3px 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.xray-title { color: var(--xray-heading, #dbe5ef); font: 700 13px var(--xray-font-display, monospace); letter-spacing: var(--xray-heading-tracking, 0); }
.xray-loading, .xray-muted { color: var(--xray-muted, #9caabd); }
.xray-loading::before { content:""; display:inline-block; width:7px; height:7px; margin-right:7px; border:1px solid var(--xray-border-strong, #465466); border-top-color:var(--xray-accent, #5eead4); border-radius:50%; animation:xray-spin .75s linear infinite; }
.xray-error { color: var(--xray-error, #fb7185); white-space:normal; }
.xray-loc { cursor: default; }
.xray-clickable { cursor: pointer; color: var(--xray-accent, #5eead4); transition: color var(--xray-dur-fast, 120ms) var(--xray-ease, ease); }
.xray-clickable:hover, .xray-clickable:focus-visible { text-decoration: underline; text-underline-offset:3px; }
.xray-view-button { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; margin-top:10px; padding:8px 10px; color:var(--xray-text, #edf2f7); background:var(--xray-accent-soft, rgba(94,234,212,.12)); border:1px solid var(--xray-accent-border, rgba(94,234,212,.28)); border-radius:8px; cursor:pointer; font-weight:650; transition:background var(--xray-dur-fast, 120ms) var(--xray-ease, ease), border-color var(--xray-dur-fast, 120ms) var(--xray-ease, ease), transform var(--xray-dur-fast, 120ms) var(--xray-ease, ease); }
.xray-view-button:hover { border-color:var(--xray-accent, #5eead4); transform:translateY(-1px); }
.xray-view-button:active { transform:scale(.985); }
.xray-view-button svg { width:15px; height:15px; }
:host([data-density="compact"]) .xray-box { padding:8px; min-width:200px; }
:host([data-density="compact"]) .xray-row { padding:2px 2px; font-size:11px; }
:host([data-density="compact"]) .xray-view-button { margin-top:7px; padding:6px 8px; }
@keyframes xray-spin { to { transform:rotate(360deg); } }
`;

// Registro de temas: um catálogo tema→arquivo (extension/themes/), nunca
// cores/fontes/durações — a aplicação só sabe montar a URL do arquivo do
// tema escolhido e recarregá-lo; quem define o que "luxo" ou "moderno"
// significam é o próprio arquivo CSS do tema.
let xrayThemeRegistry = { default: 'modern', themes: [{ id: 'modern', name: 'Moderno' }] };
let xrayThemeWanted = 'modern';
let xrayThemeId = 'modern';
const xrayThemeLinks = [];

function xrayResolveThemeId(id) {
  const known = xrayThemeRegistry.themes.some((theme) => theme.id === id);
  return known ? id : xrayThemeRegistry.default;
}

function xrayApplyThemeLinks() {
  xrayThemeId = xrayResolveThemeId(xrayThemeWanted);
  const href = chrome.runtime.getURL('themes/' + xrayThemeId + '.css');
  for (const link of xrayThemeLinks) link.href = href;
}

if (chrome.runtime?.getURL) {
  fetch(chrome.runtime.getURL('themes/themes.json'))
    .then((res) => res.json())
    .then((registry) => { xrayThemeRegistry = registry; xrayApplyThemeLinks(); })
    .catch(() => {});
}

function xrayAttachTheme(shadow) {
  if (!chrome.runtime?.getURL) return;
  const ui = document.createElement('link');
  ui.rel = 'stylesheet';
  ui.href = chrome.runtime.getURL('ui.css');
  shadow.appendChild(ui);
  const theme = document.createElement('link');
  theme.rel = 'stylesheet';
  theme.href = chrome.runtime.getURL('themes/' + xrayThemeId + '.css');
  shadow.appendChild(theme);
  xrayThemeLinks.push(theme);
}

let xrayEnabled = XRAY_SETTINGS_DEFAULTS.enabled;
let xrayActivationMode = XRAY_SETTINGS_DEFAULTS.activationMode;
let xrayActivationModifiers = XRAY_SETTINGS_DEFAULTS.activationModifiers;
let xrayHoverDelay = XRAY_SETTINGS_DEFAULTS.hoverDelay;
let xrayEditorTemplate = XRAY_SETTINGS_DEFAULTS.editorTemplate;
let xrayPanelMode = XRAY_SETTINGS_DEFAULTS.panelMode;
let xrayPanelSide = XRAY_SETTINGS_DEFAULTS.panelSide;
let xrayPanelWidth = XRAY_SETTINGS_DEFAULTS.panelWidth;
let xrayTooltipPlacement = XRAY_SETTINGS_DEFAULTS.tooltipPlacement;
let xrayTooltipHighlight = XRAY_SETTINGS_DEFAULTS.tooltipHighlight;
let xrayTooltipDensity = XRAY_SETTINGS_DEFAULTS.tooltipDensity;

// Único ponto que lê o objeto normalizado e distribui pras variáveis que o
// resto do arquivo já usa — carregamento inicial e onChanged convergem aqui.
function xrayApplySettings(settings) {
  xrayEnabled = settings.enabled;
  xrayActivationMode = settings.activationMode;
  xrayActivationModifiers = settings.activationModifiers;
  xrayHoverDelay = settings.hoverDelay;
  xrayEditorTemplate = settings.editorTemplate;
  xrayThemeWanted = settings.theme;
  xrayPanelMode = settings.panelMode;
  xrayPanelSide = settings.panelSide;
  xrayPanelWidth = settings.panelWidth;
  xrayTooltipPlacement = settings.tooltipPlacement;
  xrayTooltipHighlight = settings.tooltipHighlight;
  xrayTooltipDensity = settings.tooltipDensity;
  xrayApplyThemeLinks();
  xrayApplyPanelLayout();
  xrayApplyTooltipLayout();
  if (!xrayTooltipHighlight && xrayHighlight && !xrayPinnedAnchor) {
    Object.assign(xrayHighlight.host.style, { opacity: '0', visibility: 'hidden' });
  }
}

chrome.storage.sync.get(Object.keys(XRAY_SETTINGS_DEFAULTS), (v) => {
  // Browser storage is asynchronous in production, while test doubles may
  // answer synchronously. Deferring keeps initialization after module state.
  queueMicrotask(() => xrayApplySettings(xrayNormalizeSettings(v)));
});
chrome.storage.onChanged.addListener((changes) => {
  const patch = {
    enabled: xrayEnabled, activationMode: xrayActivationMode, activationModifiers: xrayActivationModifiers,
    hoverDelay: xrayHoverDelay, editorTemplate: xrayEditorTemplate, theme: xrayThemeWanted,
    panelMode: xrayPanelMode, panelSide: xrayPanelSide, panelWidth: xrayPanelWidth,
    tooltipPlacement: xrayTooltipPlacement, tooltipHighlight: xrayTooltipHighlight, tooltipDensity: xrayTooltipDensity,
  };
  for (const key of Object.keys(changes)) if (key in patch) patch[key] = changes[key].newValue;
  xrayApplySettings(xrayNormalizeSettings(patch));
});

function xrayActivationMatches(event) {
  if (xrayActivationMode === 'always') return true;
  return xrayActivationModifiers.every((modifier) => !!event[modifier + 'Key']);
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

function xrayGetHighlight() {
  if (xrayHighlight) return xrayHighlight;
  const host = document.createElement('div');
  host.id = 'xray-highlight-host';
  host.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;opacity:0;visibility:hidden;';
  const shadow = host.attachShadow({ mode: 'open' });
  xrayAttachTheme(shadow);
  const style = document.createElement('style');
  style.textContent = `
    :host { transition: opacity var(--xray-dur-fast, 120ms) var(--xray-ease, ease); }
    .box { position:absolute; inset:0; border:2px solid var(--xray-accent, #5eead4); background:var(--xray-accent-soft, rgba(94,234,212,.12)); border-radius:var(--xray-radius-sm, 6px); box-shadow:0 0 0 1px var(--xray-bg, #0b1417), 0 0 22px var(--xray-accent-soft, rgba(45,212,191,.17)); }
  `;
  shadow.appendChild(style);
  const box = document.createElement('div');
  box.className = 'box';
  shadow.appendChild(box);
  document.documentElement.appendChild(host);
  xrayHighlight = { host };
  return xrayHighlight;
}

function xrayShowHighlight(anchor, pinned = false) {
  if (!anchor?.isConnected) return;
  xrayAnchor = anchor;
  if (pinned) xrayPinnedAnchor = anchor;
  if (!xrayTooltipHighlight) return;
  const { host } = xrayGetHighlight();
  const rect = anchor.getBoundingClientRect();
  Object.assign(host.style, {
    visibility: 'visible', opacity: '1', left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
  });
}

function xrayHideHighlight() {
  if (xrayHighlight && !xrayPinnedAnchor) Object.assign(xrayHighlight.host.style, { opacity: '0', visibility: 'hidden' });
}
function xrayApplyTooltipLayout() {
  if (!xrayTooltipEl) return;
  xrayTooltipEl.host.dataset.density = xrayTooltipDensity;
}

function xrayGetTooltip() {
  if (xrayTooltipEl) return xrayTooltipEl;
  const host = document.createElement('div');
  host.id = 'xray-tooltip-host';
  // inline ganha do CSS da página e não depende do :host acima ter pegado
  host.style.cssText = 'position:fixed;z-index:2147483647;';
  host.className = 'xray-hidden';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  xrayAttachTheme(shadow);
  const style = document.createElement('style');
  style.textContent = XRAY_TOOLTIP_CSS;
  shadow.appendChild(style);
  const box = document.createElement('div');
  box.className = 'xray-box';
  shadow.appendChild(box);
  xrayTooltipEl = { host, box };
  xrayApplyTooltipLayout();
  return xrayTooltipEl;
}

// Esconder tem uma folga de 250ms: sem isso, o instante em que o mouse sai
// do campo em direção ao próprio tooltip (pra clicar num link) já dispara
// hide antes do clique chegar — o tooltip "foge" do cursor.
let xrayHideTimer = null;
let xrayTooltipCloseTimer = null;
function xrayHide() {
  clearTimeout(xrayHideTimer);
  xrayHoverInfo = null;
  xrayHideTimer = setTimeout(() => {
    if (xrayTooltipEl) {
      xrayTooltipEl.host.classList.remove('xray-open');
      clearTimeout(xrayTooltipCloseTimer);
      xrayTooltipCloseTimer = setTimeout(() => xrayTooltipEl?.host.classList.add('xray-hidden'), 110);
    }
    xrayHideHighlight();
  }, 250);
}

function xrayPositionTooltip() {
  if (xrayPinnedAnchor?.isConnected) xrayShowHighlight(xrayPinnedAnchor);
  else if (xrayAnchor?.isConnected && xrayHighlight?.host.style.visibility !== 'hidden') xrayShowHighlight(xrayAnchor);
  if (!xrayAnchor || !xrayTooltipEl || !xrayTooltipEl.host.classList.contains('xray-open')) return;
  const { host } = xrayTooltipEl;
  if (!xrayAnchor.isConnected) {
    host.classList.remove('xray-open');
    host.classList.add('xray-hidden');
    return;
  }
  const rect = xrayAnchor.getBoundingClientRect();
  const tooltip = host.getBoundingClientRect();
  const gap = 6;
  const left = Math.max(gap, Math.min(rect.left, window.innerWidth - tooltip.width - gap));
  const fitsBelow = rect.bottom + gap + tooltip.height <= window.innerHeight - gap;
  const fitsAbove = rect.top - gap - tooltip.height >= gap;
  let below = xrayTooltipPlacement !== 'above';
  if (xrayTooltipPlacement === 'auto') below = fitsBelow || !fitsAbove;
  else if (!below && !fitsAbove && fitsBelow) below = true; // "acima" vira pra baixo sem espaço
  else if (below && !fitsBelow && fitsAbove) below = false; // "abaixo" vira pra cima sem espaço
  let top = below ? rect.bottom + gap : rect.top - tooltip.height - gap;
  top = Math.max(gap, Math.min(top, window.innerHeight - tooltip.height - gap));
  host.dataset.placement = below ? 'below' : 'above';
  host.style.left = left + 'px';
  host.style.top = top + 'px';
}

window.addEventListener('scroll', xrayPositionTooltip, { capture: true, passive: true });
window.addEventListener('resize', xrayPositionTooltip);

function xrayRenderBasic(info, anchor) {
  clearTimeout(xrayHideTimer);
  clearTimeout(xrayTooltipCloseTimer);
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
    xrayAppendIcon(button, 'M5 12h14m-6-6 6 6-6 6');
    button.addEventListener('click', () => xrayShowViewPanel(info));
  }
  host.classList.remove('xray-hidden');
  host.getBoundingClientRect();
  host.classList.add('xray-open');
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
      'Nenhuma declaração Python encontrada nas pastas dos projetos.';
    loadingRow.className = 'xray-row xray-muted';
    return;
  }

  loadingRow.remove();
  const title = box.querySelector('.xray-title');
  let titleLinked = false;
  res.locations.forEach((loc, idx) => {
    const rewritten = { host: loc.host ? loc.file : null, core: !loc.host };
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
    hint.textContent = 'Adicione a pasta do projeto nas opções para abrir no editor.';
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

// Modifier state comes from each mouse event, avoiding stuck keyboard state
// when focus leaves the page before keyup.
let xrayHoverTimer = null;
// No modo shortcut (alt+hover) não existe tooltip intermediário: o hover só
// destaca o elemento, e o clique nele abre o painel direto com o que já foi
// resolvido — guardamos aqui pro handler de click não precisar re-extrair.
let xrayHoverInfo = null;

function xrayText(parent, tag, text, className = '') {
  const el = document.createElement(tag);
  el.textContent = text;
  el.className = className;
  if (tag === 'button') el.type = 'button';
  parent.appendChild(el);
  return el;
}

function xrayAppendIcon(parent, path, size = 17) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ width: String(size), height: String(size), viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(name, value);
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  icon.setAttribute('d', path);
  svg.appendChild(icon);
  parent.appendChild(svg);
  return svg;
}

function xrayIconButton(parent, label, path, className = '') {
  const button = xrayText(parent, 'button', '', 'xray-icon-button ' + className);
  button.setAttribute('aria-label', label);
  button.title = label;
  xrayAppendIcon(button, path);
  return button;
}

let xrayPanel = null;
let xrayPanelRequest = 0;
let xrayPanelHideTimer = null;
// Empurra a página em vez de sobrepor: injeta uma margem no <html> do
// tamanho do painel (removida ao fechar ou ao trocar pra outro modo).
// Limite conhecido: elementos position:fixed do próprio Odoo (diálogos,
// notificações) não são empurrados por isso.
let xrayPushStyleEl = null;
function xrayApplyBodyPush() {
  const active = xrayPanelMode === 'push' && xrayPanel?.host.classList.contains('xray-open');
  if (!active) {
    if (xrayPushStyleEl) { xrayPushStyleEl.remove(); xrayPushStyleEl = null; window.dispatchEvent(new Event('resize')); }
    return;
  }
  if (!xrayPushStyleEl) {
    xrayPushStyleEl = document.createElement('style');
    xrayPushStyleEl.id = 'xray-push-style';
    document.documentElement.appendChild(xrayPushStyleEl);
  }
  const prop = xrayPanelSide === 'left' ? 'margin-left' : 'margin-right';
  xrayPushStyleEl.textContent = `html { ${prop}: ${xrayPanelWidth}px !important; transition: ${prop} 200ms ease; }`;
  window.dispatchEvent(new Event('resize'));
}

function xrayApplyPanelLayout() {
  if (!xrayPanel) return;
  xrayPanel.host.dataset.mode = xrayPanelMode;
  xrayPanel.host.dataset.side = xrayPanelSide;
  xrayPanel.host.style.setProperty('--xray-panel-width', xrayPanelWidth + 'px');
  xrayApplyBodyPush();
}

function xrayWirePanelResize(handle) {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  const onMove = (event) => {
    if (!dragging) return;
    const delta = xrayPanelSide === 'right' ? startX - event.clientX : event.clientX - startX;
    xrayPanelWidth = Math.max(XRAY_PANEL_WIDTH_MIN, Math.min(XRAY_PANEL_WIDTH_MAX, startWidth + delta));
    xrayPanel.host.style.setProperty('--xray-panel-width', xrayPanelWidth + 'px');
    xrayApplyBodyPush();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    chrome.storage.sync.set({ panelWidth: xrayPanelWidth });
  };
  handle.addEventListener('pointerdown', (event) => {
    if (xrayPanelMode === 'modal') return;
    dragging = true;
    startX = event.clientX;
    startWidth = xrayPanelWidth;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    event.preventDefault();
  });
}

function xrayClosePanel() {
  xrayPanelRequest++;
  const returnFocus = xrayPinnedAnchor;
  if (xrayPanel) {
    xrayPanel.host.classList.remove('xray-open');
    xrayApplyBodyPush();
    clearTimeout(xrayPanelHideTimer);
    xrayPanelHideTimer = setTimeout(() => xrayPanel?.host.classList.add('xray-hidden'), 170);
  }
  xrayPinnedAnchor = null;
  xrayHideHighlight();
  returnFocus?.focus?.({ preventScroll: true });
}

function xrayGetPanel() {
  if (xrayPanel) return xrayPanel;
  const host = document.createElement('div');
  host.id = 'xray-panel-host';
  host.className = 'xray-hidden';
  const shadow = host.attachShadow({ mode: 'open' });
  xrayAttachTheme(shadow);
  const style = document.createElement('style');
  style.textContent = `
    :host {
      position:fixed; z-index:2147483646; top:0; height:100vh;
      width:min(var(--xray-panel-width,520px),100vw);
      color:var(--xray-text,#edf2f7); font:13px/1.55 var(--xray-font,system-ui,sans-serif); pointer-events:none;
    }
    :host(.xray-hidden) { visibility:hidden; }
    :host(.xray-open) { pointer-events:auto; }
    * { box-sizing:border-box; }
    .backdrop { display:none; }
    :host([data-side="right"]) { right:0; }
    :host([data-side="left"]) { left:0; }
    .panel { position:relative; height:100%; overflow:auto; background:linear-gradient(180deg,var(--xray-surface,#1a202a),var(--xray-bg,#11151c)); box-shadow:-18px 0 55px rgba(0,0,0,.35); opacity:0; transform:translateX(20px); transition:opacity var(--xray-dur-base,180ms) var(--xray-ease,ease),transform var(--xray-dur-base,180ms) var(--xray-ease,ease); will-change:opacity,transform; }
    :host([data-side="right"]) .panel { border-left:1px solid var(--xray-border,#303a48); }
    :host([data-side="left"]) .panel { border-right:1px solid var(--xray-border,#303a48); box-shadow:18px 0 55px rgba(0,0,0,.35); transform:translateX(-20px); }
    :host(.xray-open) .panel { opacity:1; transform:translateX(0); transition-duration:var(--xray-dur-slow,260ms); }
    .resize-handle { position:absolute; top:0; bottom:0; width:9px; cursor:col-resize; z-index:3; }
    :host([data-side="right"]) .resize-handle { left:-4px; }
    :host([data-side="left"]) .resize-handle { right:-4px; }
    .resize-handle:hover, .resize-handle:active { background:var(--xray-accent-soft,rgba(94,234,212,.12)); }

    /* modal: centralizado, com fundo escurecido, ignora lado e largura */
    :host([data-mode="modal"]) {
      left:0; right:0; width:100%; display:flex; align-items:center; justify-content:center; padding:32px;
    }
    :host([data-mode="modal"]) .backdrop { display:block; position:absolute; inset:0; background:rgba(0,0,0,.55); opacity:0; transition:opacity var(--xray-dur-base,180ms) var(--xray-ease,ease); }
    :host(.xray-open[data-mode="modal"]) .backdrop { opacity:1; }
    :host([data-mode="modal"]) .panel { height:auto; max-height:86vh; width:min(760px,92vw); border-radius:var(--xray-radius,12px); border:1px solid var(--xray-border,#303a48); box-shadow:var(--xray-shadow,0 18px 50px rgba(0,0,0,.38)); transform:scale(.97); }
    :host(.xray-open[data-mode="modal"]) .panel { transform:scale(1); }
    :host([data-mode="modal"]) .resize-handle { display:none; }

    .header { position:sticky; top:0; z-index:2; display:flex; justify-content:space-between; gap:12px; align-items:center; padding:17px 20px; border-bottom:1px solid var(--xray-border,#303a48); background:var(--xray-surface-glass,rgba(17,21,28,.9)); backdrop-filter:blur(14px); }
    .panel-body { position:relative; padding:4px 20px 28px; }
    .panel-body.xray-loading { display:flex; align-items:center; gap:9px; padding-top:22px; color:var(--xray-muted,#9caabd); }
    .panel-body.xray-loading::before { content:""; width:10px; height:10px; border:1px solid var(--xray-border-strong,#465466); border-top-color:var(--xray-accent,#5eead4); border-radius:50%; animation:xray-panel-spin .75s linear infinite; }
    button { cursor:pointer; background:var(--xray-surface-raised,#202833); color:var(--xray-text,#edf2f7); border:1px solid var(--xray-border,#303a48); border-radius:8px; padding:6px 10px; transition:color var(--xray-dur-fast,120ms) var(--xray-ease,ease),border-color var(--xray-dur-fast,120ms) var(--xray-ease,ease),background var(--xray-dur-fast,120ms) var(--xray-ease,ease),transform var(--xray-dur-fast,120ms) var(--xray-ease,ease); }
    button:hover { color:var(--xray-accent,#5eead4); border-color:var(--xray-accent,#5eead4); background:var(--xray-accent-soft,rgba(94,234,212,.12)); }
    button:active { transform:scale(.97); }
    h2 { font:700 15px/1.35 var(--xray-font-display,monospace); margin:0; color:var(--xray-heading,#dbe5ef); letter-spacing:var(--xray-heading-tracking,0); overflow-wrap:anywhere; } h3 { margin:22px 0 9px; color:var(--xray-heading,#dbe5ef); font:600 12px var(--xray-font-display,inherit); letter-spacing:var(--xray-heading-tracking,.075em); text-transform:uppercase; }
    .entry { position:relative; padding:11px 13px 11px 16px; margin:9px 0; border:1px solid var(--xray-border,#303a48); border-radius:10px; background:var(--xray-entry-bg,rgba(32,40,51,.62)); overflow-wrap:anywhere; animation:xray-entry-in var(--xray-dur-base,180ms) var(--xray-ease,ease) both; }
    ${Array.from({ length: 6 }, (_, i) => `.entry:nth-child(${i + 1}) { animation-delay: ${i * 40}ms; }`).join('\n    ')}
    .entry::before { content:""; position:absolute; left:-1px; top:12px; width:3px; height:18px; border-radius:3px; background:var(--xray-accent-gradient,var(--xray-accent,#5eead4)); }
    .breadcrumbs { display:flex; flex-wrap:wrap; gap:6px; margin:14px 0; }
    .breadcrumbs button { color:var(--xray-muted,#9caabd); font-size:11px; }
    .breadcrumbs button.active { border-color:var(--xray-accent,#5eead4); color:var(--xray-accent,#5eead4); background:var(--xray-accent-soft,rgba(94,234,212,.12)); }
    .muted { color:var(--xray-muted,#9caabd); } .error { padding:10px 12px; border:1px solid var(--xray-error-border,rgba(251,113,133,.35)); border-radius:8px; color:var(--xray-error,#fb7185); background:var(--xray-error-bg,rgba(251,113,133,.08)); }
    .xray-clickable { color:var(--xray-accent,#5eead4); cursor:pointer; transition:color var(--xray-dur-fast,120ms) var(--xray-ease,ease); } .xray-clickable:hover { text-decoration:underline; text-underline-offset:3px; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:5px 0; font:12px/1.55 var(--xray-mono,monospace); }
    .xpath-copy-row { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px; }
    .xpath-expression { min-width:0; overflow:hidden; color:var(--xray-accent,#5eead4); text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
    .xpath-expression:focus-visible { outline:1px solid var(--xray-accent,#5eead4); outline-offset:3px; border-radius:3px; }
    .xpath-copy-icon { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:7px 12px; }
    .xray-statuses { display:flex; flex-wrap:wrap; gap:6px; margin:9px 0; }
    .xray-badge { display:inline-flex; align-items:center; min-height:23px; padding:3px 8px; border:1px solid var(--xray-border,#303a48); border-radius:999px; background:var(--xray-entry-bg,rgba(32,40,51,.7)); color:var(--xray-muted,#9caabd); font-size:10px; font-weight:700; letter-spacing:.025em; }
    .xray-badge.accent { border-color:var(--xray-accent-border,rgba(94,234,212,.35)); color:var(--xray-accent,#5eead4); background:var(--xray-accent-soft,rgba(94,234,212,.12)); }
    .xray-warning { padding:9px 11px; border-left:2px solid var(--xray-warning,#fbbf24); border-radius:0 8px 8px 0; background:var(--xray-warning-bg,rgba(251,191,36,.07)); color:var(--xray-warning-text,#d5bd7a); }
    details { margin-top:9px; } summary { cursor:pointer; color:var(--xray-subtle,#b7c5d5); font-weight:600; transition:color var(--xray-dur-fast,120ms) var(--xray-ease,ease); } summary:hover { color:var(--xray-accent,#5eead4); }
    @keyframes xray-panel-spin { to { transform:rotate(360deg); } }
    @keyframes xray-entry-in { from { opacity:0; transform:translateY(var(--xray-enter-distance,4px)); } to { opacity:1; transform:translateY(0); } }
  `;
  shadow.appendChild(style);
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.addEventListener('click', xrayClosePanel);
  shadow.appendChild(backdrop);
  const box = document.createElement('aside');
  box.className = 'panel';
  box.setAttribute('aria-label', 'Odoo X-Ray: origem da view');
  shadow.appendChild(box);
  // Fora de .panel — box.replaceChildren() a cada renderização não pode
  // levar a alça de redimensionar junto.
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle';
  shadow.appendChild(resizeHandle);
  shadow.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); xrayClosePanel(); }
  });
  document.documentElement.appendChild(host);
  xrayPanel = { host, box };
  xrayWirePanelResize(resizeHandle);
  xrayApplyPanelLayout();
  return xrayPanel;
}

async function xraySourceLink(parent, source) {
  if (!source.file || !source.line) {
    xrayText(parent, 'div', 'Origem no banco ou sem correspondência segura com arquivo', 'muted');
    return;
  }
  const link = xrayText(parent, 'div', (source.display || source.file) + ':' + source.line);
  if (source.host) {
    xrayMakeEditorLink(link, source.file, source.line);
    return;
  }
  const resolved = await xrayResolveFile(source.file);
  if (resolved.error) {
    xrayText(parent, 'div', 'Fonte local indisponível: ' + resolved.error, 'muted');
    return;
  }
  if (!resolved.matches?.length) {
    xrayText(parent, 'div', 'Arquivo não encontrado nas pastas dos projetos.', 'muted');
    return;
  }
  if (resolved.matches.length === 1) {
    link.textContent = (resolved.matches[0].display || resolved.matches[0].file) + ':' + source.line;
    xrayMakeEditorLink(link, resolved.matches[0].file, source.line);
    return;
  }
  xrayText(parent, 'div', 'Mais de um arquivo local corresponde a esta origem:', 'muted');
  for (const match of resolved.matches) {
    const candidate = xrayText(parent, 'div', (match.display || match.file) + ':' + source.line);
    xrayMakeEditorLink(candidate, match.file, source.line);
  }
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

// Retorna o rodapé com o botão de copiar (não anexado a ninguém) — quem
// chama decide onde encaixar, pra ele acabar na base do card do campo,
// depois do link do código, e não sobrepor nada.
function xrayRenderXPath(parent, xpath, view, ambiguous = false, legacy = false) {
  if (!xpath) {
    xrayText(parent, 'p', 'Não foi possível determinar o XPath deste campo.', 'muted');
    return null;
  }
  const card = xrayText(parent, 'div', '', 'xpath-card');
  const labels = [legacy ? 'Via addon' : {
    confirmed: 'Conferido no servidor',
    divergent: 'Não confirmado no servidor',
    unavailable: 'Sem conferência no servidor',
  }[xpath.server]];
  if (xpath.matches != null) labels.push(xpath.matches + (xpath.matches === 1 ? ' ocorrência' : ' ocorrências'));
  if (ambiguous) labels.push('Campo ambíguo');
  const statuses = xrayText(card, 'div', '', 'xray-statuses');
  labels.forEach((label, index) => xrayText(statuses, 'span', label,
    'xray-badge' + (index === 0 && !legacy && xpath.server === 'confirmed' ? ' accent' : '')));
  const details = xrayText(card, 'details', '');
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

  const footer = document.createElement('div');
  const row = xrayText(footer, 'div', '', 'xpath-copy-row');
  const expression = xrayText(row, 'code', xpath.expression, 'xpath-expression');
  expression.setAttribute('role', 'button');
  expression.setAttribute('aria-label', 'Copiar XPath ' + xpath.expression);
  expression.tabIndex = 0;
  const copy = xrayText(row, 'button', '', 'xpath-copy-icon');
  copy.setAttribute('aria-label', 'Copiar XPath');
  copy.title = xpath.expression;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ width: '16', height: '16', viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'aria-hidden': 'true', focusable: 'false' })) {
    svg.setAttribute(name, value);
  }
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  icon.setAttribute('d', 'M9 9h12v12H9z M5 15H3V3h12v2');
  svg.appendChild(icon);
  const copyLabel = xrayText(copy, 'span', 'XPath');
  copy.prepend(svg);
  const status = xrayText(footer, 'span', '');
  status.setAttribute('aria-live', 'polite');
  let feedbackTimer = null;
  const showCopyIcon = () => {
    clearTimeout(feedbackTimer);
    copyLabel.textContent = 'XPath';
    copy.setAttribute('aria-label', 'Copiar XPath');
    copy.title = xpath.expression;
  };
  const copyXPath = async () => {
    const copied = await xrayCopyXPath(xpath.expression, parent);
    if (copied) {
      clearTimeout(feedbackTimer);
      copyLabel.textContent = 'Copiado';
      copy.setAttribute('aria-label', 'XPath copiado');
      copy.title = 'XPath copiado';
      status.textContent = '';
      feedbackTimer = setTimeout(showCopyIcon, 1200);
    } else {
      showCopyIcon();
      status.textContent = ' Não foi possível copiar; copie o XPath manualmente.';
    }
  };
  copy.addEventListener('click', copyXPath);
  expression.addEventListener('click', copyXPath);
  expression.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    copyXPath();
  });
  return footer;
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

async function xrayRenderFieldSource(parent, info, request) {
  if (!info.field) return;
  const section = xrayText(parent, 'section', '', 'field-source');
  xrayText(section, 'h3', 'Propriedade Python');
  const content = xrayText(section, 'div', 'Localizando declaração…', 'xray-loading');
  const result = info.fieldModelError ? { error: info.fieldModelError } :
    await xrayLocateField(info.model, info.field);
  if (request !== xrayPanelRequest) return;
  content.replaceChildren();
  content.classList.remove('xray-loading');
  if (result.error) {
    xrayText(content, 'p', result.error, 'error');
    return;
  }
  if (result.automatic) {
    xrayText(content, 'p', 'Campo automático do ORM, sem arquivo de origem.', 'muted');
    return;
  }
  if (!result.locations?.length) {
    xrayText(content, 'p', result.warning ? 'Fonte local indisponível: ' + result.warning :
      'Nenhuma declaração Python encontrada nas pastas dos projetos.', 'muted');
    return;
  }
  for (const location of result.locations) {
    const entry = xrayText(content, 'div', '', 'entry');
    xrayText(entry, 'strong', (location.module || 'core') + ' — ' + location.klass);
    await xraySourceLink(entry, location);
  }
  if (result.related) xrayText(content, 'p', 'related: ' + result.related, 'muted');
  if (result.warning) xrayText(content, 'p', 'Fonte local: ' + result.warning, 'muted');
}

async function xrayShowViewPanel(info) {
  const request = ++xrayPanelRequest;
  if (info.node) xrayShowHighlight(info.node, true);
  const { host, box } = xrayGetPanel();
  clearTimeout(xrayPanelHideTimer);
  host.classList.remove('xray-hidden');
  host.getBoundingClientRect();
  host.classList.add('xray-open');
  xrayApplyBodyPush();
  box.replaceChildren();
  const header = xrayText(box, 'div', '', 'header');
  xrayText(header, 'h2', xrayElementTitle(info));
  const close = xrayIconButton(header, 'Fechar', 'M6 6l12 12M18 6 6 18');
  close.addEventListener('click', xrayClosePanel);
  close.focus();
  const body = xrayText(box, 'div', 'Resolvendo a herança da view…', 'panel-body xray-loading');
  const viewRequest = xrayLocateView(info);
  body.replaceChildren();
  body.classList.remove('xray-loading');
  await xrayRenderFieldSource(body, info, request);
  const result = await viewRequest;
  if (request !== xrayPanelRequest) return;
  xrayText(body, 'h3', 'Origem na view');
  if (result.error) { xrayText(body, 'p', result.error, 'error'); return; }
  if (result.candidates) {
    await xrayRenderOrigin(body, result, request);
    return;
  }
  xrayText(body, 'p', result.view.xml_id || result.view.name);
  xrayText(body, 'pre', result.target.path, 'muted');
  if (result.target.tag === 'field') {
    const footer = xrayRenderXPath(body, xrayLegacyFieldXPath(result, info), result.view, false, true);
    if (footer) body.appendChild(footer);
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
// customization) or no configured project root degrades to a clear explanation
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
    return { file: null, warning: 'Arquivo declarado (' + view.arch_fs + ') não encontrado nas pastas dos projetos.' };
  }
  if (res.matches.length > 1) return { ambiguous: true, matches: res.matches };
  const match = res.matches[0];
  return { file: match.file, display: match.display, line: match.record_line, exact: match.exact, indexLines: match.lines };
}

function xrayRenderLocation(parent, resolved, index) {
  if (resolved.ambiguous) {
    xrayText(parent, 'div', 'O arquivo tem mais de um registro para esta view; correspondência ambígua.', 'muted');
    for (const match of resolved.matches) {
      const line = match.exact ? (match.lines[String(index)] ?? match.record_line) : match.record_line;
      xraySourceLink(parent, { file: match.file, display: match.display, line, host: true });
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
  xraySourceLink(parent, { file: resolved.file, display: resolved.display, line, host: true });
}

async function xrayRenderCandidate(parent, result, candidate, request, heading) {
  const xpathFooter = result.target.tag === 'field' ? xrayRenderXPath(parent, candidate.xpath,
    result.views[result.loadedId], result.certainty === 'ambígua') : null;
  if (xpathFooter) parent.appendChild(xpathFooter);
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

  if (candidate.events.length) {
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
}

async function xrayRenderOrigin(body, result, request) {
  const certainty = xrayText(body, 'div', '', 'xray-statuses');
  xrayText(certainty, 'span', XRAY_CERTAINTY_LABEL[result.certainty] || result.certainty,
    'xray-badge' + (result.certainty === 'exata' ? ' accent' : ''));
  for (const warning of result.warnings || []) xrayText(body, 'p', warning, 'xray-warning');
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
