// Run the production extractor/RPC, rather than duplicating their implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'extract.js'), 'utf8'), context);
function marked(attrs) {
  return { getAttribute: name => attrs[name] || null,
    closest: selector => selector === '[data-xray-node]' ? marked(attrs) : null };
}
const common = { 'data-xray-model': 'res.partner', 'data-xray-field': 'name', 'data-xray-type': 'char', 'data-xray-view-id': '42' };
for (const occurrence of [1, 2]) {
  const identity = { path: '/form/field[' + occurrence + ']', fingerprint: 'abc', model: 'res.partner', tag: 'field', field: 'name' };
  const result = context.xrayExtract(marked({ ...common, 'data-xray-node': JSON.stringify(identity) }));
  assert.equal(result.model, 'res.partner');
  assert.equal(result.field, 'name');
  assert.equal(result.viewId, 42);
  assert.equal(result.identity.path, identity.path);
}
assert.equal(context.xrayExtract(marked({ ...common, 'data-xray-node': '{broken' })), null);
const groupIdentity = { path: '/form/group', fingerprint: 'abc', model: 'res.partner', tag: 'group', name: 'main' };
const group = context.xrayExtract(marked({ 'data-xray-view-id': '42', 'data-xray-node': JSON.stringify(groupIdentity) }));
assert.equal(group.tag, 'group');
assert.equal(group.name, 'main');
assert.equal(group.field, null);
assert.equal(context.xrayExtract(null), null);
const legacyInfo = { resModel: 'res.partner', field: { name: 'email', type: 'char' } };
const legacy = { closest: s => s === '[data-tooltip-info]' ? { getAttribute: () => JSON.stringify(legacyInfo) } : null };
assert.equal(context.xrayExtract(legacy).field, 'email');

(async () => {
  let calls = 0;
  const listeners = {};
  const rpcContext = vm.createContext({
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    fetch: async () => { calls++; return { ok: true, json: async () => ({ result: { locations: [] } }) }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'rpc.js'), 'utf8'), rpcContext);
  await Promise.all([rpcContext.xrayLocateField('res.partner', 'name'), rpcContext.xrayLocateField('res.partner', 'name')]);
  assert.equal(calls, 1, 'concurrent requests are deduplicated');
  await rpcContext.xrayLocateField('res.partner', 'name');
  assert.equal(calls, 2, 'settled data is not reused across session changes');
  const info = { viewId: 42, identity: {} };
  await rpcContext.xrayLocateView(info);
  await rpcContext.xrayLocateView(info);
  assert.equal(calls, 4, 'view history is refreshed on every opening');
  await rpcContext.xrayLocateMethod('res.partner', 'write');
  assert.equal(calls, 5, 'methods can be resolved for object buttons');
  console.log('inspect.test.js: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
