const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let listener;
let nativeRequest;
let storageSettings = { projectRoots: ['/tmp/project'] };
const context = vm.createContext({
  URL,
  JSON,
  setTimeout(callback, delay) {
    assert.equal(delay, 900);
    callback();
  },
  fetch: async () => { throw new Error('bridge should not be needed'); },
  chrome: {
    storage: { sync: { get(_keys, callback) { callback(storageSettings); } } },
    runtime: {
      id: 'extension-id',
      lastError: null,
      onMessage: { addListener(callback) { listener = callback; } },
      sendNativeMessage(_host, request, callback) {
        nativeRequest = request;
        callback({ ok: true });
      },
    },
  },
  importScripts(file) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  },
});

vm.runInContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), context);
let response;
const pending = listener(
  { type: 'xray.openInEditor', file: '/tmp/model.py', line: 37 },
  { id: 'extension-id', tab: { url: 'http://localhost:8069/odoo/contacts' } },
  value => { response = value; },
);
assert.equal(pending, true);
assert.equal(JSON.stringify(nativeRequest), JSON.stringify({ action: 'open', file: '/tmp/model.py', line: 37 }));
assert.equal(JSON.stringify(response), JSON.stringify({ ok: true }));

response = null;
assert.equal(listener(
  { type: 'xray.localRequest', request: { action: 'locate_field', model: 'res.partner', field: 'name' } },
  { id: 'extension-id', tab: { url: 'http://localhost:8069/odoo/res.partner/1' } },
  value => { response = value; },
), true);
assert.equal(nativeRequest.action, 'locate_field');
assert.equal(JSON.stringify(nativeRequest.roots), JSON.stringify(['/tmp/project']));
assert.equal(response.ok, true);

storageSettings = { mappings: [{ container: '/mnt/project', host: '/tmp/legacy-project' }] };
listener(
  { type: 'xray.localRequest', request: { action: 'resolve_file', file: '/mnt/project/models/x.py' } },
  { id: 'extension-id', tab: { url: 'http://localhost:8069/odoo/res.partner/1' } },
  value => { response = value; },
);
assert.equal(nativeRequest.action, 'resolve_file');
assert.equal(JSON.stringify(nativeRequest.roots), JSON.stringify(['/tmp/legacy-project']));
storageSettings = { projectRoots: ['/tmp/project'], mappings: [{ host: '/tmp/ignored' }] };

response = null;
assert.equal(listener(
  { type: 'xray.openInEditor', file: 'relative.py', line: 0 },
  { id: 'extension-id', tab: { url: 'http://localhost:8069/odoo' } },
  value => { response = value; },
), false);
assert.equal(response.ok, false);

response = null;
assert.equal(listener(
  { type: 'xray.localRequest', request: { action: 'locate_view', xml_id: 'sale.view_order_form',
    arch_fs: 'sale/views/sale_order_views.xml', arch: '<form/>', nodes: [0, 1] } },
  { id: 'extension-id', tab: { url: 'http://localhost:8069/odoo/sale.order/1' } },
  value => { response = value; },
), true);
assert.equal(nativeRequest.action, 'locate_view');
assert.equal(JSON.stringify(nativeRequest.roots), JSON.stringify(['/tmp/project']));
assert.equal(response.ok, true);

response = null;
assert.equal(listener(
  { type: 'xray.localRequest', request: { action: 'locate_view', xml_id: 'sale.view_order_form',
    arch_fs: 'sale/views/sale_order_views.xml', arch: '<form/>', nodes: [-1] } },
  { id: 'extension-id', tab: { url: 'http://localhost:8069/odoo/sale.order/1' } },
  value => { response = value; },
), false);
assert.equal(response.ok, false, 'negative node indexes are rejected');
console.log('background.test.js: OK');
