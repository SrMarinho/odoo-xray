// Guards the action->model fallback: an action that can't be resolved (client
// action, action without a model, or no read access) must produce a friendly
// error, never the raw "action-<id>" route sent to call_kw as a model name
// (that gets a cryptic 404 from the server; see xrayResolveModel).
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function makeContext(searchReadResult) {
  const calls = [];
  const context = {
    calls,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.params);
      return {
        ok: true,
        json: async () => ({ result: searchReadResult }),
      };
    },
    window: { addEventListener: () => {}, postMessage: () => {} },
    chrome: { runtime: { sendMessage: () => {} } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'rpc.js'), 'utf8'), context);
  return context;
}

test('unresolved action never reaches call_kw as a model name', async () => {
  const context = makeContext([]); // no ir.actions.act_window row found
  const result = await vm.runInContext('xrayLocateField("action-654", "name")', context);
  assert.equal(result.error, 'Não foi possível identificar o modelo desta tela.');
  assert.ok(context.calls.every((call) => call.model !== 'action-654'));
});

test('missing route resolves to null instead of throwing', async () => {
  const context = makeContext([]);
  const model = await vm.runInContext('xrayResolveModel(undefined)', context);
  assert.equal(model, null);
});

test('resolved action model is used for fields_get', async () => {
  const context = makeContext([{ id: 654, res_model: 'res.partner' }]);
  await vm.runInContext('xrayResolveModel("action-654")', context).then((model) => {
    assert.equal(model, 'res.partner');
  });
});
