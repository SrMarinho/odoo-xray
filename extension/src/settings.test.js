const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'settings.js'), 'utf8'), context);
const { xrayNormalizeSettings } = context;

const DEFAULTS = {
  enabled: true, activationMode: 'shortcut', activationModifiers: ['alt'], hoverDelay: 700,
  editorTemplate: 'vscode://file/{file}:{line}', theme: 'modern',
  panelMode: 'overlay', panelSide: 'right', panelWidth: 520,
  tooltipPlacement: 'auto', tooltipHighlight: true, tooltipDensity: 'comfortable',
};

// JSON.stringify em vez de deepEqual: xrayNormalizeSettings roda no realm
// isolado da vm, e deepEqual estrito rejeita objetos/arrays de outro realm.
assert.equal(JSON.stringify(xrayNormalizeSettings({})), JSON.stringify(DEFAULTS), 'objeto vazio cai nos defaults');
assert.equal(JSON.stringify(xrayNormalizeSettings(undefined)), JSON.stringify(DEFAULTS), 'undefined cai nos defaults');

assert.equal(xrayNormalizeSettings({ panelWidth: 100 }).panelWidth, 360, 'largura clampa no mínimo');
assert.equal(xrayNormalizeSettings({ panelWidth: 5000 }).panelWidth, 900, 'largura clampa no máximo');
assert.equal(xrayNormalizeSettings({ panelWidth: 610.7 }).panelWidth, 611, 'largura arredonda');

assert.equal(xrayNormalizeSettings({ panelMode: 'sideways' }).panelMode, 'overlay', 'enum inválido cai no default');
assert.equal(xrayNormalizeSettings({ panelMode: 'push' }).panelMode, 'push', 'enum válido é preservado');
assert.equal(xrayNormalizeSettings({ panelSide: 'top' }).panelSide, 'right', 'lado inválido cai no default');
assert.equal(xrayNormalizeSettings({ tooltipPlacement: 'diagonal' }).tooltipPlacement, 'auto');
assert.equal(xrayNormalizeSettings({ tooltipDensity: 'huge' }).tooltipDensity, 'comfortable');

assert.equal(xrayNormalizeSettings({ tooltipHighlight: false }).tooltipHighlight, false, 'booleano false é preservado');
assert.equal(xrayNormalizeSettings({ tooltipHighlight: 'no' }).tooltipHighlight, true, 'não-booleano cai no default');

assert.equal(xrayNormalizeSettings({ hoverDelay: 50 }).hoverDelay, 100);
assert.equal(xrayNormalizeSettings({ hoverDelay: 9000 }).hoverDelay, 5000);
assert.equal(xrayNormalizeSettings({ hoverDelay: 1.9 }).hoverDelay, 700, 'não-inteiro cai no default');

assert.equal(JSON.stringify(xrayNormalizeSettings({ activationModifiers: [] }).activationModifiers), '["alt"]', 'lista vazia cai no default');
assert.equal(JSON.stringify(xrayNormalizeSettings({ activationModifiers: ['ctrl', 'shift'] }).activationModifiers),
  '["ctrl","shift"]');

// Chaves antigas (do sistema de temas / ativação, já em produção) continuam
// aceitas e preservadas por xrayNormalizeSettings sem qualquer mudança.
assert.equal(xrayNormalizeSettings({ theme: 'luxury' }).theme, 'luxury');
assert.equal(xrayNormalizeSettings({ editorTemplate: 'idea://open?file={file}&line={line}' }).editorTemplate,
  'idea://open?file={file}&line={line}');

console.log('settings.test.js: OK');
