// Integration check against an isolated Odoo 19 database with xray installed.
// Set NODE_PATH to an installed Playwright package, plus XRAY_TEST_URL/DB.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const url = process.env.XRAY_TEST_URL;
const db = process.env.XRAY_TEST_DB;
if (!url || !db?.startsWith('xray_test_')) throw new Error('Use XRAY_TEST_URL and an isolated XRAY_TEST_DB=xray_test_...');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', error => { pageErrors.push(error.message); console.error('pageerror:', error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error('console:', message.text()); });
    const response = await page.request.post(url + '/web/session/authenticate', {
      data: { jsonrpc: '2.0', method: 'call', params: { db, login: 'admin', password: process.env.XRAY_TEST_PASSWORD || 'admin' } },
    });
    const auth = await response.json();
    assert.equal(auth.result?.xray_enabled, true, auth.error?.data?.message);
    await page.addInitScript(() => {
      window.chrome = window.chrome || {};
      chrome.storage = {
        sync: { get: (_keys, callback) => callback({ enabled: true, mappings: [{ container: '/usr/lib/python3/dist-packages', host: '/mapped' }] }) },
        onChanged: { addListener: () => {} },
      };
      chrome.runtime = { sendMessage: (_message, callback) => callback({}) };
    });
    await page.goto(url + '/odoo/res.partner/1', { waitUntil: 'domcontentloaded' });
    const field = page.locator('.o_field_widget[data-xray-field="name"]').first();
    await field.waitFor();
    assert.equal(await page.evaluate(() => Boolean(odoo.debug)), false);
    const markerTags = await page.locator('[data-xray-node]').evaluateAll(nodes =>
      nodes.map(node => JSON.parse(node.getAttribute('data-xray-node')).tag));
    assert.ok(markerTags.includes('group'), 'semantic groups must reach the rendered DOM');
    for (const file of ['rpc.js', 'extract.js', 'content.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '../src', file) });
    }
    await page.keyboard.down('Alt');
    await field.hover();
    const tooltip = page.locator('#xray-tooltip-host');
    await tooltip.getByRole('button', { name: 'Ver origem na view' }).waitFor();
    const initial = await tooltip.boundingBox();
    const anchor = await field.boundingBox();
    await page.mouse.move(anchor.x + Math.min(20, anchor.width / 2), anchor.y + anchor.height / 2);
    const sameAnchor = await tooltip.boundingBox();
    assert.equal(Math.round(sameAnchor.x), Math.round(initial.x), 'tooltip must not follow the mouse');
    await tooltip.getByRole('button', { name: 'Ver origem na view' }).click();
    const panel = page.locator('#xray-panel-host');
    await panel.getByRole('heading', { name: 'Views na ordem de aplicação' }).waitFor();
    assert.equal(await panel.locator('.error').count(), 0);
    assert.match(await panel.locator('aside').innerText(), /base\.view_partner_form/);
    assert.ok(await panel.locator('.breadcrumbs button').count() > 1, 'XML ancestors must be selectable');
    // Validate click routing without launching an external editor during tests.
    await page.evaluate(() => { window.xrayOpened = []; xrayOpenInEditor = (file, line) => window.xrayOpened.push({ file, line }); });
    await field.hover();
    const pythonLink = tooltip.locator('.xray-clickable').first();
    await pythonLink.click();
    assert.equal(await page.evaluate(() => window.xrayOpened.length), 1);
    await page.keyboard.up('Alt');
    await page.mouse.wheel(0, 400);
    assert.equal(await panel.isVisible(), true);
    await panel.getByRole('button', { name: 'Fechar' }).click();
    assert.equal(await panel.isVisible(), false);
    const group = page.locator('.o_group[data-xray-node], .o_inner_group[data-xray-node]').first();
    const cancelled = await group.evaluate(node => !node.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, altKey: true,
    })));
    assert.equal(cancelled, true, 'Alt+click must suppress the original Odoo action');
    await panel.getByRole('heading', { name: /^<group/ }).waitFor();
    await panel.getByRole('button', { name: 'Fechar' }).click();
    assert.deepEqual(pageErrors, []);
    console.log('browser.cjs: OK (Odoo 19 without debug, semantic metadata, Alt+click, ancestors, editor click)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
