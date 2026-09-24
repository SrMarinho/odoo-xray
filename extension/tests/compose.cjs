// Pure DOM test of the composition engine (compose.js) against a real browser
// (DOMParser + XPath): no Odoo instance needed. Run with:
//   node extension/tests/compose.cjs
// Requires Playwright reachable from Node (see README "Testes").
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

function view(id, arch, extra = {}) {
  return { id, arch, model: 'res.partner', priority: 16, mode: 'primary', active: true,
    inherit_id: false, xml_id: 'test.view_' + id, ...extra };
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ path: path.join(__dirname, '..', 'src', 'compose.js') });

    const run = (fn, arg) => page.evaluate(fn, arg);

    // 1. Base view + one extension adding a field inside a group, plus a
    //    second, later-priority extension setting an attribute on it.
    let result = await run(([views, target]) => xrayResolveOrigin({
      loadedId: 1, views, serverArch: null, target,
    }), [[
      view(1, '<form><group string="Endereço"><field name="street"/></group></form>'),
      view(2, '<field name="street" position="after"><field name="city"/></field>', { inherit_id: 1, mode: 'extension', priority: 16 }),
      view(3, '<field name="city" position="attributes"><attribute name="required">1</attribute></field>', { inherit_id: 1, mode: 'extension', priority: 20 }),
    ], { tag: 'field', name: 'city' }]);
    assert.equal(result.candidates.length, 1, 'city resolves to exactly one node');
    assert.equal(result.candidates[0].created.viewId, 2, 'city was created by the inside/after view');
    assert.equal(result.candidates[0].events.length, 1, 'city has one later change');
    assert.equal(result.candidates[0].events[0].viewId, 3);
    assert.equal(result.candidates[0].events[0].changes.required.after, '1');
    assert.equal(result.certainty, 'provável', 'without a server arch to cross-check, certainty stays "provável"');

    // 2. Repeated field name inside a notebook page: occurrence disambiguates.
    result = await run(([views, target]) => xrayResolveOrigin({ loadedId: 1, views, serverArch: null, target }), [[
      view(1, '<form><notebook>' +
        '<page name="a" string="A"><field name="description"/></page>' +
        '<page name="b" string="B"><field name="description"/></page>' +
        '</notebook></form>'),
    ], { tag: 'field', name: 'description', context: { page: { name: 'b' } } }]);
    assert.equal(result.candidates.length, 1, 'page context disambiguates the repeated field');

    // 3. Equal priority: id order breaks the tie (Odoo: ORDER BY priority, id).
    result = await run(([views, target]) => xrayResolveOrigin({ loadedId: 1, views, serverArch: null, target }), [[
      view(1, '<form><field name="name"/></form>'),
      view(3, '<field name="name" position="after"><field name="x"/></field>', { inherit_id: 1, mode: 'extension', priority: 16 }),
      view(2, '<field name="x" position="attributes"><attribute name="string">Y</attribute></field>', { inherit_id: 1, mode: 'extension', priority: 16 }),
    ], { tag: 'field', name: 'x' }]);
    // view 2 has a lower id than 3 but same priority: it is applied FIRST,
    // so it must fail to locate "x" (created by view 3, applied after).
    assert.ok(result.warnings.some((w) => w.includes('não localizado')), 'lower id applies before higher id at equal priority');

    // 4. replace (outer, default mode): the new node's origin is the replacing view.
    result = await run(([views, target]) => xrayResolveOrigin({ loadedId: 1, views, serverArch: null, target }), [[
      view(1, '<form><field name="name"/></form>'),
      view(2, '<field name="name" position="replace"><field name="full_name"/></field>', { inherit_id: 1, mode: 'extension' }),
    ], { tag: 'field', name: 'full_name' }]);
    assert.equal(result.candidates[0].created.viewId, 2);
    assert.equal(result.candidates[0].created.via, 'replace');

    // 5. replace with $0: the copy of the original node carries its own history forward.
    result = await run(([views, target]) => xrayResolveOrigin({ loadedId: 1, views, serverArch: null, target }), [[
      view(1, '<form><field name="name" required="1"/></form>'),
      view(2, '<field name="name" position="replace"><div><t>$0</t></div></field>', { inherit_id: 1, mode: 'extension' }),
    ], { tag: 'field', name: 'name' }]);
    assert.equal(result.candidates[0].created.viewId, 1, '$0 keeps the original creation');
    assert.equal(result.candidates[0].replaced, null);

    // 6. move: the moved node keeps its creator and gains a move event.
    result = await run(([views, target]) => xrayResolveOrigin({ loadedId: 1, views, serverArch: null, target }), [[
      view(1, '<form><group><field name="street"/></group><group name="g2"/></form>'),
      view(2, '<xpath expr="//group[@name=\'g2\']" position="inside">' +
        '<field name="street" position="move"/></xpath>', { inherit_id: 1, mode: 'extension' }),
    ], { tag: 'field', name: 'street' }]);
    assert.equal(result.candidates[0].created.viewId, 1);
    assert.equal(result.candidates[0].events.at(-1).op, 'move');
    assert.equal(result.candidates[0].events.at(-1).viewId, 2);

    // 7. Successive inheritance: grandchild view (primary, in the chain) adds
    //    a field, and an extension of the child changes it afterwards.
    result = await run(([views, target]) => xrayResolveOrigin({ loadedId: 3, views, serverArch: null, target }), [[
      view(1, '<form><field name="name"/></form>'),
      view(2, '<form/>', { inherit_id: 1, mode: 'primary', priority: 16 }),
      view(3, '<xpath expr="//field[@name=\'name\']" position="after"><field name="vat"/></xpath>',
        { inherit_id: 2, mode: 'extension' }),
      view(4, '<field name="vat" position="attributes"><attribute name="readonly">1</attribute></field>',
        { inherit_id: 2, mode: 'extension', priority: 20 }),
    ], { tag: 'field', name: 'vat' }]);
    assert.equal(result.candidates[0].created.viewId, 3);
    assert.equal(result.candidates[0].events[0].viewId, 4);

    // 8. Inactive and uninstalled-module views are excluded from the tree.
    result = await run(([views, target]) => xrayResolveOrigin({ loadedId: 1, views, serverArch: null, target }), [[
      view(1, '<form><field name="name"/></form>'),
      view(2, '<field name="name" position="after"><field name="inactive_field"/></field>',
        { inherit_id: 1, mode: 'extension', active: false }),
      view(3, '<field name="name" position="after"><field name="uninstalled_field"/></field>',
        { inherit_id: 1, mode: 'extension', excluded: true }),
    ], { tag: 'field', name: 'name' }]);
    assert.equal(result.applied.length, 1, 'inactive and uninstalled-module views never enter the hierarchy');

    // 9. A database-only view (Studio: no xml_id) still composes normally.
    result = await run(([views, target]) => xrayResolveOrigin({ loadedId: 1, views, serverArch: null, target }), [[
      view(1, '<form><field name="name"/></form>'),
      view(2, '<field name="name" position="after"><field name="studio_field"/></field>',
        { inherit_id: 1, mode: 'extension', xml_id: false }),
    ], { tag: 'field', name: 'studio_field' }]);
    assert.equal(result.candidates.length, 1, 'a Studio view without xml_id is preserved');
    assert.equal(result.candidates[0].created.viewId, 2);

    // 10. hasclass() xpath extension is rewritten to work with the native evaluator.
    result = await run(([views, target]) => xrayResolveOrigin({ loadedId: 1, views, serverArch: null, target }), [[
      view(1, '<form><div class="oe_title"><field name="name"/></div></form>'),
      view(2, '<xpath expr="//div[hasclass(\'oe_title\')]" position="inside"><field name="ref"/></xpath>',
        { inherit_id: 1, mode: 'extension' }),
    ], { tag: 'field', name: 'ref' }]);
    assert.equal(result.candidates.length, 1, 'hasclass() xpath is resolved');
    assert.equal(result.candidates[0].created.viewId, 2);

    // 11. An unresolved spec degrades certainty instead of throwing.
    result = await run(([views, target]) => xrayResolveOrigin({ loadedId: 1, views, serverArch: null, target }), [[
      view(1, '<form><field name="name"/></form>'),
      view(2, '<field name="missing" position="after"><field name="x"/></field>', { inherit_id: 1, mode: 'extension' }),
    ], { tag: 'field', name: 'name' }]);
    assert.equal(result.certainty, 'provável');
    assert.ok(result.warnings.some((w) => w.includes('não localizado')));

    // 12. Matching server arch confirms an "exata" origin.
    result = await run(([views, target, serverArch]) => xrayResolveOrigin({ loadedId: 1, views, serverArch, target }), [[
      view(1, '<form><field name="name"/></form>'),
      view(2, '<field name="name" position="after"><field name="vat"/></field>', { inherit_id: 1, mode: 'extension' }),
    ], { tag: 'field', name: 'vat' }, '<form><field name="name"/><field name="vat"/></form>']);
    assert.equal(result.certainty, 'exata');
    assert.equal(result.candidates[0].created.viewId, 2);

    // 13. A server arch that puts the target under a different ancestor path
    //     (Python customization, access-controlled subview) is never claimed
    //     as an exact match — the mismatch is reported instead.
    result = await run(([views, target, serverArch]) => xrayResolveOrigin({ loadedId: 1, views, serverArch, target }), [[
      view(1, '<form><field name="name"/></form>'),
      view(2, '<field name="name" position="after"><field name="vat"/></field>', { inherit_id: 1, mode: 'extension' }),
    ], { tag: 'field', name: 'vat' }, '<form><field name="name"/><page name="extra"><field name="vat"/></page></form>']);
    assert.notEqual(result.certainty, 'exata');
    assert.ok(result.warnings.some((w) => w.includes('difere da composição')));

    console.log('compose.cjs: OK');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
