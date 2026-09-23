const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let listener;
let nativeRequest;
const context = vm.createContext({
  URL,
  JSON,
  setTimeout(callback, delay) {
    assert.equal(delay, 900);
    callback();
  },
  fetch: async () => { throw new Error('bridge should not be needed'); },
  chrome: {
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
  { type: 'xray.openInEditor', file: 'relative.py', line: 0 },
  { id: 'extension-id', tab: { url: 'http://localhost:8069/odoo' } },
  value => { response = value; },
), false);
assert.equal(response.ok, false);
console.log('background.test.js: OK');
