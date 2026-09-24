// Fonte única de defaults e validação das preferências do X-Ray. content.js
// e options.js leem só daqui, pra nunca duplicar (e divergir) o que cada
// chave aceita — carregado antes de ambos (ver manifest.json e options.html).

const XRAY_SETTINGS_DEFAULTS = OdooXray.SettingsSchema.defaults;
const XRAY_PANEL_MODES = OdooXray.SettingsSchema.panelModes;
const XRAY_PANEL_SIDES = OdooXray.SettingsSchema.panelSides;
const XRAY_TOOLTIP_PLACEMENTS = OdooXray.SettingsSchema.tooltipPlacements;
const XRAY_TOOLTIP_DENSITIES = OdooXray.SettingsSchema.tooltipDensities;
const XRAY_PANEL_WIDTH_MIN = OdooXray.SettingsSchema.panelWidth.min;
const XRAY_PANEL_WIDTH_MAX = OdooXray.SettingsSchema.panelWidth.max;
const xraySettingsSchema = new OdooXray.SettingsSchema();

function xrayNormalizeSettings(raw) {
  return xraySettingsSchema.normalize(raw);
}
