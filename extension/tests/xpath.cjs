// Real browser XML XPath and panel tests; same Playwright setup as compose.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ path: path.join(__dirname, '../src/compose.js') });
    const resolve = (arch, target = { tag: 'field', name: 'email' }, serverArch = arch) => page.evaluate(
      ({ arch, target, serverArch }) => xrayResolveOrigin({ loadedId: 1,
        views: [{ id: 1, arch, priority: 16, mode: 'primary', active: true, model: 'res.partner' }],
        serverArch, target }), { arch, target, serverArch });

    let result = await resolve('<form><field name="email"/></form>');
    assert.deepEqual(result.candidates[0].xpath, {
      expression: "//field[@name='email']", strategy: 'attribute', matches: 1, server: 'confirmed',
    });
    result = await resolve('<form><page name="a"><field name="email"/></page><page name="b"><field name="email"/></page></form>');
    assert.equal(result.certainty, 'ambígua');
    assert.deepEqual(result.candidates.map((c) => c.xpath.expression), [
      "//field[@name='email']", "//field[@name='email']",
    ]);
    assert.deepEqual(result.candidates.map((c) => c.xpath.matches), [2, 2]);
    result = await resolve('<form><page name="a"><group name="same"><field name="email"/></group></page><page name="b"><group name="same"><field name="email"/></group></page></form>');
    assert.equal(result.candidates[0].xpath.expression, "//field[@name='email']");
    assert.equal(result.candidates[0].xpath.matches, 2);
    result = await resolve('<form><group><field name="email" invisible="1"/></group><group><field name="email"/></group></form>');
    assert.equal(result.candidates[0].xpath.strategy, 'attribute');
    assert.equal(result.candidates[0].xpath.expression, "//field[@name='email']");
    assert.equal(result.candidates[0].xpath.matches, 2);
    result = await resolve('<form><field name="email"/><field name="lines"><list><field name="email"/></list></field></form>');
    assert.equal(result.candidates[0].xpath.expression, "//field[@name='email']");
    assert.equal(result.candidates[0].xpath.matches, 2);
    result = await resolve('<form><field name="email"/><field name="lines"><list><field name="email"/></list></field></form>',
      { tag: 'field', name: 'email', context: { subview: 'lines' } });
    assert.equal(result.candidates[0].xpath.expression, "//field[@name='lines']/list/field[@name='email']");
    assert.equal(result.candidates[0].xpath.matches, 1);
    result = await resolve('<form><field name="ordem_fornecimento_ids"><list><field name="produto_id"/></list></field></form>',
      { tag: 'field', name: 'produto_id', context: { subview: 'ordem_fornecimento_ids' } });
    assert.equal(result.candidates[0].xpath.expression,
      "//field[@name='ordem_fornecimento_ids']/list/field[@name='produto_id']");
    result = await resolve('<form><field name="email"/></form>', undefined, null);
    assert.equal(result.candidates[0].xpath.server, 'unavailable');
    result = await resolve('<form><field name="email"/></form>', undefined, '<form><field name="email"/><field name="email"/></form>');
    assert.equal(result.candidates[0].xpath.server, 'divergent');
    result = await resolve('<form/>');
    assert.equal(result.candidates.length, 0);
    const quoted = await page.evaluate(() => {
      const root = xrayParseArch('<form><field/><field/></form>');
      const node = root.firstElementChild;
      node.setAttribute('name', `a'"b`);
      const xpath = xrayFieldXPath(root, node);
      return { xpath, correct: xrayXPathMatches(root, xpath.expression)[0] === node };
    });
    assert.ok(quoted.correct);
    assert.ok(quoted.xpath.expression.includes('concat('));

    // Load the real panel, mocking only browser services and external resolution.
    await page.evaluate(() => {
      window.chrome = { storage: { sync: { get: (_keys, cb) => cb({}) }, onChanged: { addListener() {} } } };
      window.xrayLocateView = async () => window.fixture;
      window.xrayLocateViewSource = async () => ({ error: 'No local host' });
    });
    await page.addScriptTag({ path: path.join(__dirname, '../src/content.js') });
    result = await resolve('<form><field name="email"/></form>');
    const fixture = { ...result, loadedId: 1, target: { tag: 'field', name: 'email' },
      views: { 1: { id: 1, name: 'Contact' } } };
    await page.evaluate(async (fixture) => {
      window.fixture = fixture;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copied = text; } } });
      await xrayShowViewPanel({ model: 'res.partner', field: 'email' });
    }, fixture);
    await page.getByRole('button', { name: 'Copiar XPath', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.copied), "//field[@name='email']");
    assert.equal(await page.locator('.xpath-copy-icon').textContent(), 'Copiado');
    assert.equal(await page.locator('[aria-live]').textContent(), '');
    assert.equal(await page.getByRole('button', { name: 'XPath copiado', exact: true }).count(), 1);
    await page.waitForTimeout(1300);
    assert.equal(await page.getByRole('button', { name: 'Copiar XPath', exact: true }).textContent(), '');
    assert.equal(await page.locator('.xpath-copy-icon svg').count(), 1);
    await page.evaluate(() => { window.copied = null; });
    await page.locator('.xpath-expression').click();
    assert.equal(await page.evaluate(() => window.copied), "//field[@name='email']");
    await page.evaluate(() => { window.copied = null; });
    await page.locator('.xpath-expression').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.copied), "//field[@name='email']");
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => { throw new Error('denied'); };
      document.execCommand = (command) => {
        window.fallback = { command, value: document.querySelector('#xray-panel-host').shadowRoot.activeElement.value };
        return true;
      };
    });
    await page.getByRole('button', { name: 'Copiar XPath', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.fallback), { command: 'copy', value: "//field[@name='email']" });
    await page.evaluate(() => { document.execCommand = () => false; });
    await page.getByRole('button', { name: 'Copiar XPath', exact: true }).click();
    assert.match(await page.locator('[aria-live]').textContent(), /manualmente/);

    await page.evaluate(async () => {
      window.fixture = { view: { id: 2, name: 'Legacy' }, target: {
        tag: 'field', field: 'email', path: '/form/field[2]',
      }, history: [], inheritance_chain: [] };
      await xrayShowViewPanel({ model: 'res.partner', field: 'email' });
    });
    assert.equal(await page.locator('.xpath-expression').textContent(), "//field[@name='email']");
    assert.match(await page.locator('aside').textContent(), /não contou as ocorrências/);
    await page.evaluate(async () => {
      window.fixture = { view: { id: 2, name: 'Legacy' }, target: {
        tag: 'field', field: 'produto_id', path: '/form/field/list/field',
      }, breadcrumbs: [
        { tag: 'form', name: null },
        { tag: 'field', name: 'ordem_fornecimento_ids' },
        { tag: 'list', name: null },
        { tag: 'field', name: 'produto_id' },
      ], history: [], inheritance_chain: [] };
      await xrayShowViewPanel({ model: 'abastecimento.fatura', field: 'produto_id' });
    });
    assert.equal(await page.locator('.xpath-expression').textContent(),
      "//field[@name='ordem_fornecimento_ids']/list/field[@name='produto_id']");

    // A stale request must never overwrite the newer field's panel.
    await page.evaluate(async (fixture) => {
      window.xrayLocateView = () => new Promise((resolve) => { window.releaseOld = resolve; });
      window.oldPanel = xrayShowViewPanel({ model: 'res.partner', field: 'old' });
      window.xrayLocateView = async () => fixture;
      await xrayShowViewPanel({ model: 'res.partner', field: 'email' });
      window.releaseOld({ error: 'STALE' });
      await window.oldPanel;
    }, fixture);
    assert.doesNotMatch(await page.locator('aside').textContent(), /STALE/);
    assert.equal(await page.locator('h2').textContent(), 'res.partner.email');

    const ambiguous = await resolve('<form><field name="email"/><field name="email"/></form>');
    await page.evaluate(async (fixture) => {
      window.xrayLocateView = async () => fixture;
      await xrayShowViewPanel({ model: 'res.partner', field: 'email' });
    }, { ...fixture, ...ambiguous });
    assert.equal(await page.getByRole('button', { name: 'Copiar XPath', exact: true }).count(), 2);
    assert.match(await page.locator('aside').textContent(), /permanece ambígua/);
    assert.match(await page.locator('aside').textContent(), /2 ocorrências/);
    await page.evaluate(async (fixture) => {
      window.xrayLocateView = async () => ({ ...fixture, candidates: [] });
      await xrayShowViewPanel({ model: 'res.partner', field: 'email' });
    }, fixture);
    assert.equal(await page.getByRole('button', { name: 'Copiar XPath', exact: true }).count(), 0);
    assert.match(await page.locator('aside').textContent(), /Não foi possível determinar o XPath/);

    // The section must render before the local file lookup finishes.
    await page.evaluate(async (fixture) => {
      window.xrayLocateView = async () => ({ ...fixture,
        views: { 1: { id: 1, name: 'Contact', xml_id: 'test.contact', arch_fs: 'test.xml' } } });
      window.xrayLocateViewSource = () => new Promise((resolve) => { window.releaseSource = resolve; });
      window.pendingPanel = xrayShowViewPanel({ model: 'res.partner', field: 'email' });
    }, fixture);
    assert.equal(await page.getByRole('button', { name: 'Copiar XPath', exact: true }).count(), 1);
    await page.evaluate(async () => { window.releaseSource({ error: 'unavailable' }); await window.pendingPanel; });
    console.log('xpath.cjs: OK');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
