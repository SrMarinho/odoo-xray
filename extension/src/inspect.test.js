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
const relationalField = { getAttribute: () => 'ordem_fornecimento_ids' };
const listColumn = {
  getAttribute: () => 'produto_id',
  matches: selector => selector === 'button[name]' ? false : false,
  parentElement: { closest: selector => selector === '.o_field_widget[name]' ? relationalField : null },
  closest: selector => selector.startsWith('.o_field_widget[name],') ? listColumn : null,
};
const extractedColumn = context.xrayExtract(listColumn);
assert.equal(extractedColumn.field, 'produto_id');
assert.equal(extractedColumn.context.subview, 'ordem_fornecimento_ids');
const groupNode = {
  firstElementChild: null,
  matches: selector => selector === '.o_inner_group, .o_group',
};
const titleCell = { parentElement: groupNode };
const groupTitle = {
  textContent: 'Endereço', parentElement: titleCell,
  closest: selector => selector === '.o_horizontal_separator' ? groupTitle : null,
};
groupNode.firstElementChild = titleCell;
const extractedGroup = context.xrayExtract(groupTitle);
assert.equal(extractedGroup.model, 'action-279');
assert.equal(extractedGroup.tag, 'group');
assert.equal(extractedGroup.label, 'Endereço');
assert.equal(extractedGroup.field, null);

(async () => {
  let calls = 0;
  const listeners = {};
  const requests = [];
  const rpcBodies = [];
  const resolveOriginCalls = [];
  let capture = null; // set per scenario; null simulates hook.js finding nothing
  const fakeWindow = {
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    removeEventListener: (name, fn) => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); },
    postMessage: (data) => {
      if (data?.type !== 'views?') return;
      queueMicrotask(() => (listeners.message || []).slice().forEach((fn) => fn({
        source: fakeWindow, data: { source: 'odoo-xray', type: 'views', id: data.id, captured: capture || [] },
      })));
    },
  };
  const rpcContext = vm.createContext({
    window: fakeWindow,
    setTimeout, clearTimeout,
    // compose.js's real algorithm is exercised by extension/tests/compose.cjs
    // against a real DOM; here only rpc.js's own plumbing is under test.
    xrayResolveOrigin: (args) => {
      resolveOriginCalls.push(args);
      return { certainty: 'exata', evidence: [], warnings: [], applied: [args.loadedId],
        candidates: [{ signature: 'form/field[name]', created: null, replaced: null, events: [] }] };
    },
    chrome: { runtime: { sendMessage: (message, callback) => { requests.push(message); callback({ locations: [] }); } } },
    fetch: async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      rpcBodies.push(body);
      const { model, method } = body.params;
      let result;
      if (model === 'ir.actions.act_window') result = [{ id: 279, res_model: 'res.partner', views: [], context: {} }];
      else if (model === 'ir.ui.view') result = [{ id: 42, name: 'v', xml_id: 'base.view_form', inherit_id: false,
        priority: 16, mode: 'primary', active: true, arch: '<form/>', arch_fs: 'base/views/x.xml', model: 'res.partner' }];
      else if (model === 'ir.module.module') result = [{ name: 'base', state: 'installed' }];
      else if (method === 'get_views') result = { views: { form: { id: 42, arch: '<form/>', model: 'res.partner' } } };
      else result = { name: { type: 'char' } };
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
  capture = [{ model: 'res.partner', result: { form: { id: 42, arch: '<form/>' } } }];
  let result = await rpcContext.xrayLocateView(info);
  assert.equal(result.loadedId, 42, 'the captured get_views response supplies the loaded view id');
  assert.equal(resolveOriginCalls.at(-1).loadedId, 42);
  assert.ok(!rpcBodies.some((b) => b.params.method === 'get_views'), 'a capture skips a fresh get_views call');
  assert.equal(result.warnings.length, 0);

  capture = null;
  result = await rpcContext.xrayLocateView(info);
  assert.equal(result.loadedId, 42, 'without a capture, get_views is called directly');
  assert.ok(rpcBodies.some((b) => b.params.method === 'get_views'));
  assert.ok(result.warnings.some((w) => w.includes('Nenhuma chamada get_views capturada')));

  await rpcContext.xrayLocateView({ viewId: 7, identity: { path: '/form' } });
  assert.deepEqual(rpcBodies.at(-1).params, { model: 'xray.xray', method: 'locate_view_node', args: [7, { path: '/form' }], kwargs: {} });

  await rpcContext.xrayLocateMethod('res.partner', 'write');
  assert.equal(requests.at(-1).request.action, 'locate_method');
  await rpcContext.xrayLocateViewSource({ xml_id: 'base.view_form', arch_fs: 'x.xml', arch: '<form/>' }, [0]);
  assert.equal(requests.at(-1).request.action, 'locate_view');

  assert.equal(await rpcContext.xrayResolveModel('contacts'), 'res.partner');
  assert.equal(await rpcContext.xrayResolveModel('action-279'), 'res.partner');
  assert.equal(rpcBodies.filter((b) => b.params.model === 'ir.actions.act_window').at(-1).params.args[0][0][0], 'id');
  assert.equal(rpcBodies.filter((b) => b.params.model === 'ir.actions.act_window').at(-1).params.args[0][0][2], 279);
  console.log('inspect.test.js: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
