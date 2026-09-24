let projectRoots = [];
const modifierInputs = [...document.querySelectorAll('[data-modifier]')];

function iconButton(button, label, path) {
  button.textContent = '';
  button.classList.add('xray-icon-button');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="' + path + '"/></svg>';
}

// A aplicação só sabe montar a URL "../themes/<id>.css" e trocar o <link>
// de preview — cores, fontes e durações continuam só dentro do arquivo do
// tema, nunca aqui.
let xrayTheme = 'modern';
let xrayThemeRegistry = { default: 'modern', themes: [{ id: 'modern', name: 'Moderno' }] };

async function loadThemeRegistry() {
  try {
    const res = await fetch('../themes/themes.json');
    xrayThemeRegistry = await res.json();
  } catch (_error) { /* mantém o registro padrão embutido */ }
}

function applyPreviewTheme(id) {
  document.getElementById('themeLink').href = '../themes/' + id + '.css';
}

function themeCard(theme, selected) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'theme-card' + (selected ? ' active' : '');
  button.setAttribute('aria-pressed', String(selected));

  const host = document.createElement('div');
  host.className = 'theme-card-preview';
  button.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const themeLink = document.createElement('link');
  themeLink.rel = 'stylesheet';
  themeLink.href = '../themes/' + theme.id + '.css';
  shadow.appendChild(themeLink);
  const style = document.createElement('style');
  style.textContent = `
    :host { display:block; }
    .swatch { width:100%; height:100%; box-sizing:border-box; padding:12px; background:var(--xray-bg); border:1px solid var(--xray-border); display:flex; flex-direction:column; justify-content:space-between; }
    .dots { display:flex; gap:6px; }
    .dot { width:14px; height:14px; border-radius:50%; }
    .dot.a { background:var(--xray-surface-raised); border:1px solid var(--xray-border); }
    .dot.b { background:var(--xray-accent); }
    .dot.c { background:var(--xray-accent-gradient); }
    .label { font:600 12px var(--xray-font-display); color:var(--xray-text); letter-spacing:var(--xray-heading-tracking,0); }
  `;
  shadow.appendChild(style);
  const swatch = document.createElement('div');
  swatch.className = 'swatch';
  const dots = document.createElement('div');
  dots.className = 'dots';
  for (const c of ['a', 'b', 'c']) {
    const dot = document.createElement('div');
    dot.className = 'dot ' + c;
    dots.appendChild(dot);
  }
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = theme.name;
  swatch.append(dots, label);
  shadow.appendChild(swatch);

  const caption = document.createElement('span');
  caption.className = 'theme-card-name';
  caption.textContent = theme.name;
  button.appendChild(caption);

  button.addEventListener('click', () => {
    xrayTheme = theme.id;
    applyPreviewTheme(xrayTheme);
    renderThemeOptions();
  });
  return button;
}

function renderThemeOptions() {
  const el = document.getElementById('themeOptions');
  el.replaceChildren();
  for (const theme of xrayThemeRegistry.themes) {
    el.appendChild(themeCard(theme, theme.id === xrayTheme));
  }
}

iconButton(document.getElementById('addProjectRoot'), 'Adicionar pasta', 'M12 5v14M5 12h14');

function renderActivationMode() {
  const always = document.getElementById('activationMode').value === 'always';
  document.getElementById('shortcutSettings').hidden = always;
  document.getElementById('alwaysSettings').hidden = !always;
}

document.getElementById('activationMode').addEventListener('change', renderActivationMode);

// Pequeno wrapper pra cada grupo de radio (modo/lado do painel, posição/
// densidade do tooltip) não precisar repetir get/set em cada campo.
function radioGroup(name) {
  const inputs = [...document.querySelectorAll('input[name="' + name + '"]')];
  return {
    get: () => inputs.find((input) => input.checked)?.value,
    set: (value) => inputs.forEach((input) => { input.checked = input.value === value; }),
    onChange: (handler) => inputs.forEach((input) => input.addEventListener('change', handler)),
  };
}

const panelModeGroup = radioGroup('panelMode');
const panelSideGroup = radioGroup('panelSide');
const tooltipPlacementGroup = radioGroup('tooltipPlacement');
const tooltipDensityGroup = radioGroup('tooltipDensity');

function renderPanelMode() {
  document.getElementById('panelSideSettings').hidden = panelModeGroup.get() === 'modal';
}

panelModeGroup.onChange(renderPanelMode);
document.getElementById('panelWidth').addEventListener('input', (event) => {
  document.getElementById('panelWidthValue').textContent = event.target.value;
});

function renderProjectRoots() {
  const el = document.getElementById('projectRoots');
  el.innerHTML = '';
  projectRoots.forEach((root, i) => {
    const div = document.createElement('div');
    div.className = 'pair';
    div.style.display = 'flex';
    div.style.gap = '8px';
    const code = document.createElement('code');
    code.style.flex = '1';
    code.textContent = root;
    div.appendChild(code);
    const remove = document.createElement('button');
    iconButton(remove, 'Remover pasta', 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5');
    div.appendChild(remove);
    remove.addEventListener('click', () => {
      projectRoots.splice(i, 1);
      renderProjectRoots();
    });
    el.appendChild(div);
  });
}

document.getElementById('addProjectRoot').addEventListener('click', () => {
  const input = document.getElementById('newProjectRoot');
  const root = input.value.trim().replace(/\/+$/, '');
  if (!root.startsWith('/')) {
    document.getElementById('status').textContent = 'Informe um caminho absoluto.';
    return;
  }
  if (projectRoots.includes(root)) return;
  projectRoots.push(root);
  input.value = '';
  renderProjectRoots();
});

document.getElementById('save').addEventListener('click', () => {
  const activationModifiers = modifierInputs.filter((input) => input.checked)
    .map((input) => input.dataset.modifier);
  const data = xrayNormalizeSettings({
    enabled: document.getElementById('enabled').checked,
    activationMode: document.getElementById('activationMode').value,
    activationModifiers,
    hoverDelay: Number(document.getElementById('hoverDelay').value),
    editorTemplate: document.getElementById('editorTemplate').value,
    theme: xrayTheme,
    panelMode: panelModeGroup.get(),
    panelSide: panelSideGroup.get(),
    panelWidth: Number(document.getElementById('panelWidth').value),
    tooltipPlacement: tooltipPlacementGroup.get(),
    tooltipHighlight: document.getElementById('tooltipHighlight').checked,
    tooltipDensity: tooltipDensityGroup.get(),
  });
  data.projectRoots = projectRoots;
  chrome.storage.sync.set(data, () => {
    chrome.storage.sync.remove('mappings');
    const status = document.getElementById('status');
    status.textContent = 'Salvo.';
    setTimeout(() => (status.textContent = ''), 1500);
  });
});

chrome.storage.sync.get([...Object.keys(XRAY_SETTINGS_DEFAULTS), 'projectRoots', 'mappings'], async (v) => {
  const settings = xrayNormalizeSettings(v);
  document.getElementById('enabled').checked = settings.enabled;
  document.getElementById('activationMode').value = settings.activationMode;
  for (const input of modifierInputs) input.checked = settings.activationModifiers.includes(input.dataset.modifier);
  document.getElementById('hoverDelay').value = settings.hoverDelay;
  document.getElementById('editorTemplate').value = settings.editorTemplate;
  panelModeGroup.set(settings.panelMode);
  panelSideGroup.set(settings.panelSide);
  document.getElementById('panelWidth').value = settings.panelWidth;
  document.getElementById('panelWidthValue').textContent = settings.panelWidth;
  tooltipPlacementGroup.set(settings.tooltipPlacement);
  tooltipDensityGroup.set(settings.tooltipDensity);
  document.getElementById('tooltipHighlight').checked = settings.tooltipHighlight;
  projectRoots = Array.isArray(v.projectRoots) ? v.projectRoots :
    [...new Set((v.mappings || []).map((mapping) => mapping.host).filter(Boolean))];
  renderProjectRoots();
  renderActivationMode();
  renderPanelMode();

  xrayTheme = settings.theme;
  await loadThemeRegistry();
  xrayTheme = xrayThemeRegistry.themes.some((theme) => theme.id === xrayTheme) ? xrayTheme : xrayThemeRegistry.default;
  applyPreviewTheme(xrayTheme);
  renderThemeOptions();
});
