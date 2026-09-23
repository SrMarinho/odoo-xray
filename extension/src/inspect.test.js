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
context.location = { pathname: '/odoo/action-279/25' };
const ordinary = { closest: selector => selector.startsWith('.o_field_widget') ? {
  getAttribute: () => 'street', matches: () => false,
} : null };
assert.equal(context.xrayExtract(ordinary).model, 'action-279');
assert.equal(context.xrayExtract(ordinary).field, 'street');

(async () => {
  let calls = 0;
  const listeners = {};
  const requests = [];
  const rpcBodies = [];
  const rpcContext = vm.createContext({
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    chrome: { runtime: { sendMessage: (message, callback) => { requests.push(message); callback({ locations: [] }); } } },
    fetch: async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      rpcBodies.push(body);
      const result = body.params.model === 'ir.ui.view' ? [] :
        body.params.model === 'ir.actions.act_window' ? [{ res_model: 'res.partner' }] :
        { name: { type: 'char' } };
      return { ok: true, json: async () => ({ result }) };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'rpc.js'), 'utf8'), rpcContext);
  await Promise.all([rpcContext.xrayLocateField('res.partner', 'name'), rpcContext.xrayLocateField('res.partner', 'name')]);
  assert.equal(calls, 1, 'concurrent requests are deduplicated');
  await rpcContext.xrayLocateField('res.partner', 'name');
  assert.equal(calls, 2, 'settled data is not reused across session changes');
  assert.equal(requests[0].request.action, 'locate_field');
  const info = { model: 'res.partner', field: 'name' };
  await rpcContext.xrayLocateView(info);
  await rpcContext.xrayLocateView(info);
  assert.equal(calls, 4, 'views are refreshed on every opening');
  await rpcContext.xrayLocateMethod('res.partner', 'write');
  assert.equal(requests.at(-1).request.action, 'locate_method');
  assert.equal(await rpcContext.xrayResolveModel('contacts'), 'res.partner');
  assert.equal(calls, 5, 'an action URL resolves through the standard Odoo API');
  assert.equal(await rpcContext.xrayResolveModel('action-279'), 'res.partner');
  assert.equal(calls, 6, 'an action-ID URL resolves through the standard Odoo API');
  assert.equal(rpcBodies.at(-1).params.args[0][0][0], 'id');
  assert.equal(rpcBodies.at(-1).params.args[0][0][2], 279);
  console.log('inspect.test.js: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
