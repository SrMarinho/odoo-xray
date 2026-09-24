const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('http://xray.test/**', route => route.fulfill({ contentType: 'text/html', body: `
      <div class="o_field_widget" name="ordem_fornecimento_ids">
        <div class="o_list_view"><table>
          <thead><tr><th data-name="produto_id"><span>Produto</span></th></tr></thead>
          <tbody><tr><td name="produto_id"><span>Produto A</span></td></tr>
          <tr><td name="produto_id"><div class="o_field_widget" name="produto_id"><input/></div></td></tr></tbody>
        </table></div>
      </div>` }));
    await page.goto('http://xray.test/odoo/action-373/5');
    for (const file of ['extract.js', 'rpc.js', 'compose.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '../src', file) });
    }
    const result = await page.evaluate(async () => {
      const parent = document.querySelector('[name="ordem_fornecimento_ids"]');
      parent.setAttribute('data-xray-node', JSON.stringify({ model: 'abastecimento.fatura', field: 'ordem_fornecimento_ids' }));
      const extracted = ['th span', 'td span', 'td input'].map(selector => xrayExtract(document.querySelector(selector)));
      parent.removeAttribute('data-xray-node');
      extracted.push(...['th span', 'td span', 'td input'].map(selector => xrayExtract(document.querySelector(selector))));
      window.calls = [];
      xrayCallKw = async (model, method, args) => {
        calls.push({ model, method, args });
        if (method === 'search_read' && model === 'ir.actions.act_window') return [{ res_model: 'abastecimento.fatura' }];
        if (method === 'fields_get') return args[0][0] === 'ordem_fornecimento_ids'
          ? { ordem_fornecimento_ids: { relation: 'abastecimento.ordem_fornecimento' } }
          : { produto_id: { type: 'many2one' } };
        return [];
      };
      xrayLocalRequest = async request => { calls.push(request); return { locations: [] }; };
      const info = await xrayResolveInspection(extracted[0]);
      await xrayLocateField(info.model, info.field);
      const arch = '<form><field name="ordem_fornecimento_ids"><list><field name="produto_id"/></list></field></form>';
      xrayGetCapture = async () => ({ captured: [{ model: 'abastecimento.fatura', result: { form: { id: 1, arch } } }] });
      const originalCall = xrayCallKw;
      xrayCallKw = async (model, method, args) => model === 'ir.ui.view'
        ? [{ id: 1, model: 'abastecimento.fatura', arch, priority: 16, mode: 'primary', active: true }]
        : originalCall(model, method, args);
      const origin = await xrayLocateView(info);
      return {
        extracted: extracted.map(({ field, context, column, node }) => ({ field, subview: context.subview, column, tag: node.tagName })),
        info: { model: info.model, viewModel: info.viewModel }, calls,
        xpath: origin.candidates[0].xpath.expression,
      };
    });
    assert.ok(result.extracted.length === 6 && result.extracted.every(item => item.field === 'produto_id'));
    assert.ok(result.extracted.every(item => item.column && item.subview === 'ordem_fornecimento_ids'));
    assert.deepEqual(result.extracted.map(item => item.tag), ['TH', 'TD', 'TD', 'TH', 'TD', 'TD']);
    assert.deepEqual(result.info, { model: 'abastecimento.ordem_fornecimento', viewModel: 'abastecimento.fatura' });
    assert.ok(result.calls.some(call => call.action === 'locate_field' && call.model === result.info.model && call.field === 'produto_id'));
    assert.equal(result.xpath, "//field[@name='ordem_fornecimento_ids']/list/field[@name='produto_id']");
    console.log('columns.cjs: OK');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
