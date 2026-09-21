// Orquestração: hover (com Alt) -> extract -> tooltip com o que já temos ->
// RPC em paralelo -> path rewrite -> click/Enter abre o editor.

const XRAY_DEBOUNCE_MS = 120;

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
  window.location.href = xrayEditorTemplate.replace('{file}', file).replace('{line}', String(line));
}

let xrayTooltipEl = null;
function xrayGetTooltip() {
  if (xrayTooltipEl) return xrayTooltipEl;
  const host = document.createElement('div');
  host.id = 'xray-tooltip-host';
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

function xrayHide() {
  if (xrayTooltipEl) xrayTooltipEl.host.style.display = 'none';
}

function xrayRenderBasic(info, x, y) {
  const { host, box } = xrayGetTooltip();
  box.innerHTML =
    '<div class="xray-row xray-title">' + info.model + '.' + info.field + '</div>' +
    '<div class="xray-row">' + (info.type || '?') + (info.widget ? ' (' + info.widget + ')' : '') + '</div>' +
    '<div class="xray-row xray-loading">resolvendo…</div>';
  host.style.left = x + 12 + 'px';
  host.style.top = y + 12 + 'px';
  host.style.display = 'block';
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
    loadingRow.textContent = 'módulos: ' + (res.modules || []).join(', ') + ' — linha não localizada';
    loadingRow.className = 'xray-row xray-muted';
    return;
  }

  loadingRow.remove();
  res.locations.forEach((loc, idx) => {
    const rewritten = xrayRewritePath(loc.file);
    const row = document.createElement('div');
    row.className = 'xray-row xray-loc' + (rewritten.host ? ' xray-clickable' : '');
    const label = (idx === 0 ? '▶ ' : '  ') + loc.module + ' — ' + loc.klass + ':' + loc.line;
    row.textContent = rewritten.core ? label + ' (core, sem link)' : label;
    if (rewritten.host) {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        xrayOpenInEditor(rewritten.host, loc.line);
      });
    }
    box.appendChild(row);
  });

  if (res.related) {
    const rel = document.createElement('div');
    rel.className = 'xray-row xray-muted';
    rel.textContent = 'related: ' + res.related;
    box.appendChild(rel);
  }
}

let xrayHoverTimer = null;
let xrayAltHeld = false;
window.addEventListener('keydown', (e) => { if (e.key === 'Alt') xrayAltHeld = true; });
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') xrayAltHeld = false; });
window.addEventListener('blur', () => { xrayAltHeld = false; });

document.addEventListener('mousemove', (e) => {
  if (!xrayEnabled || !xrayAltHeld) {
    xrayHide();
    return;
  }
  clearTimeout(xrayHoverTimer);
  const x = e.clientX, y = e.clientY, target = e.target;
  xrayHoverTimer = setTimeout(() => {
    const info = xrayExtract(target);
    if (!info) {
      xrayHide();
      return;
    }
    xrayRenderBasic(info, x, y);
    xrayLocateField(info.model, info.field).then((res) => xrayRenderLocations(info, res));
  }, XRAY_DEBOUNCE_MS);
}, { passive: true });
