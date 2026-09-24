// Fonte única de defaults e validação das preferências do X-Ray. content.js
// e options.js leem só daqui, pra nunca duplicar (e divergir) o que cada
// chave aceita — carregado antes de ambos (ver manifest.json e options.html).

const XRAY_SETTINGS_DEFAULTS = {
  enabled: true,
  activationMode: 'shortcut',
  activationModifiers: ['alt'],
  hoverDelay: 700,
  editorTemplate: 'vscode://file/{file}:{line}',
  theme: 'modern',
  panelMode: 'overlay',
  panelSide: 'right',
  panelWidth: 520,
  tooltipPlacement: 'auto',
  tooltipHighlight: true,
  tooltipDensity: 'comfortable',
};

const XRAY_PANEL_MODES = ['overlay', 'push', 'modal'];
const XRAY_PANEL_SIDES = ['left', 'right'];
const XRAY_TOOLTIP_PLACEMENTS = ['auto', 'below', 'above'];
const XRAY_TOOLTIP_DENSITIES = ['comfortable', 'compact'];
const XRAY_PANEL_WIDTH_MIN = 360;
const XRAY_PANEL_WIDTH_MAX = 900;

function xrayOneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function xrayNormalizeSettings(raw) {
  raw = raw || {};
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : XRAY_SETTINGS_DEFAULTS.enabled,
    activationMode: xrayOneOf(raw.activationMode, ['shortcut', 'always'], XRAY_SETTINGS_DEFAULTS.activationMode),
    activationModifiers: Array.isArray(raw.activationModifiers) && raw.activationModifiers.length ?
      raw.activationModifiers : XRAY_SETTINGS_DEFAULTS.activationModifiers,
    hoverDelay: Number.isInteger(raw.hoverDelay) ?
      Math.max(100, Math.min(5000, raw.hoverDelay)) : XRAY_SETTINGS_DEFAULTS.hoverDelay,
    editorTemplate: typeof raw.editorTemplate === 'string' && raw.editorTemplate ?
      raw.editorTemplate : XRAY_SETTINGS_DEFAULTS.editorTemplate,
    theme: typeof raw.theme === 'string' && raw.theme ? raw.theme : XRAY_SETTINGS_DEFAULTS.theme,
    panelMode: xrayOneOf(raw.panelMode, XRAY_PANEL_MODES, XRAY_SETTINGS_DEFAULTS.panelMode),
    panelSide: xrayOneOf(raw.panelSide, XRAY_PANEL_SIDES, XRAY_SETTINGS_DEFAULTS.panelSide),
    panelWidth: Number.isFinite(raw.panelWidth) ?
      Math.max(XRAY_PANEL_WIDTH_MIN, Math.min(XRAY_PANEL_WIDTH_MAX, Math.round(raw.panelWidth))) :
      XRAY_SETTINGS_DEFAULTS.panelWidth,
    tooltipPlacement: xrayOneOf(raw.tooltipPlacement, XRAY_TOOLTIP_PLACEMENTS, XRAY_SETTINGS_DEFAULTS.tooltipPlacement),
    tooltipHighlight: typeof raw.tooltipHighlight === 'boolean' ? raw.tooltipHighlight : XRAY_SETTINGS_DEFAULTS.tooltipHighlight,
    tooltipDensity: xrayOneOf(raw.tooltipDensity, XRAY_TOOLTIP_DENSITIES, XRAY_SETTINGS_DEFAULTS.tooltipDensity),
  };
}
