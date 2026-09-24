const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const calls = [];
const listeners = {};
const anchor = { isConnected: true, matches: () => false };
const target = { closest: () => anchor };
const info = { model: 'res.partner', field: 'name', type: 'char', node: anchor };
const root = { addEventListener(type, listener) { (listeners[type] ||= []).push(listener); } };
const context = vm.createContext({
  document: root,
  target,
  clearTimeout() {},
  setTimeout(callback) { callback(); return 1; },
  XRAY_DEBOUNCE_MS: 120,
  xrayHoverDelay: 700,
  xrayHoverTimer: null,
  xrayHideTimer: null,
  xrayEnabled: true,
  xrayActivationMode: 'shortcut',
  xrayTooltipEl: null,
  xrayPanel: null,
  xrayAnchor: null,
  xrayHoverInfo: null,
  xrayActivationMatches: () => true,
  xrayHide: () => calls.push('hide'),
  xrayExtract: () => info,
  xrayResolveInspection: async value => value,
  xrayRenderBasic(value, valueAnchor) {
    calls.push('render');
    context.xrayAnchor = valueAnchor;
  },
  xrayLocateField: async () => { calls.push('locate'); return { locations: [] }; },
  xrayRenderLocations: () => calls.push('locations'),
  xrayPositionTooltip: () => calls.push('position'),
  xrayShowViewPanel: () => calls.push('panel'),
});

vm.runInContext(fs.readFileSync(path.join(__dirname, 'interaction.js'), 'utf8'), context);

(async () => {
  await vm.runInContext('xrayInteractionController.inspectHover(target)', context);
  assert.deepEqual(calls, ['render', 'locate', 'locations', 'position']);
  assert.equal(context.xrayHoverInfo, info, 'shortcut hover retains the inspected field for Alt+click');

  const tooltipHost = {};
  context.xrayTooltipEl = { host: tooltipHost };
  const tooltipClick = {
    target: tooltipHost,
    preventDefault: () => calls.push('prevent'),
    stopImmediatePropagation: () => calls.push('stop'),
  };
  context.tooltipClick = tooltipClick;
  vm.runInContext('xrayInteractionController.onShortcutClick(tooltipClick)', context);
  assert.equal(calls.includes('panel'), false, 'tooltip links remain interactive');

  context.fieldClick = {
    target: anchor,
    preventDefault: () => calls.push('prevent'),
    stopImmediatePropagation: () => calls.push('stop'),
  };
  vm.runInContext('xrayInteractionController.onShortcutClick(fieldClick)', context);
  assert.deepEqual(calls.slice(-3), ['prevent', 'stop', 'panel']);
  console.log('interaction.test.js: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
