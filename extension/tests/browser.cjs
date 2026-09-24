// Integration check of the addon-free path against an isolated Odoo 19 database.
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
    const xrayCalls = [];
    page.on('request', request => {
      if (request.url().includes('/web/dataset/call_kw') &&
          request.postData()?.includes('"model":"xray.xray"')) xrayCalls.push(request.url());
    });
    page.on('pageerror', error => { pageErrors.push(error.message); console.error('pageerror:', error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error('console:', message.text()); });
    const response = await page.request.post(url + '/web/session/authenticate', {
      data: { jsonrpc: '2.0', method: 'call', params: { db, login: 'admin', password: process.env.XRAY_TEST_PASSWORD || 'admin' } },
    });
    const auth = await response.json();
    assert.ok(auth.result?.uid, auth.error?.data?.message);
    await page.addInitScript(() => {
      window.chrome = window.chrome || {};
      chrome.storage = {
        sync: { get: (_keys, callback) => callback({ enabled: true, projectRoots: ['/mapped'] }) },
        onChanged: { addListener: () => {} },
      };
      chrome.runtime = { sendMessage: (message, callback) => callback(message.type === 'xray.localRequest'
        ? { locations: [{ file: '/mapped/models/partner.py', line: 7, module: 'test', klass: 'Partner', host: true }],
          matches: [{ file: '/mapped/views/res_partner_views.xml', record_line: 3, exact: true, lines: { 0: 4 } }] }
        : {}) };
    });
    // hook.js must run before any page script (document_start, MAIN world) to
    // capture the get_views call the Odoo client makes on the initial load.
    await page.addInitScript({ path: path.join(__dirname, '../src/hook.js') });
    await page.goto(url + '/odoo/res.partner/1', { waitUntil: 'domcontentloaded' });
    const field = page.locator('.o_field_widget[name="name"]').first();
    await field.waitFor();
    assert.equal(await page.evaluate(() => Boolean(odoo.debug)), false);
    await page.evaluate(() => document.querySelectorAll('*').forEach(node =>
      [...node.attributes].filter(attr => attr.name.startsWith('data-xray-'))
        .forEach(attr => node.removeAttribute(attr.name))));
    for (const file of ['core.js', 'settings.js', 'rpc.js', 'compose.js', 'extract.js', 'content.js', 'interaction.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '../src', file) });
    }
    await page.keyboard.down('Alt');
    await field.hover();
    const cancelled = await field.evaluate(node => !node.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, altKey: true,
    })));
    assert.equal(cancelled, true, 'Alt+click must suppress the original Odoo action');
    const panel = page.locator('#xray-panel-host');
    await panel.getByRole('heading', { name: 'res.partner.name' }).waitFor();
    assert.equal(await panel.locator('.error').count(), 0);
    assert.match(await panel.locator('aside').innerText(), /Origem (exata|prov[aá]vel)/);
    assert.equal(await panel.getByRole('heading', { name: 'Propriedade Python' }).count(), 1);
    // Validate click routing without launching an external editor during tests.
    await page.evaluate(() => { window.xrayOpened = []; xrayOpenInEditor = (file, line) => window.xrayOpened.push({ file, line }); });
    const pythonLink = panel.locator('.field-source .xray-clickable').first();
    await pythonLink.click();
    assert.equal(await page.evaluate(() => window.xrayOpened.length), 1);
    await page.keyboard.up('Alt');
    await page.mouse.wheel(0, 400);
    assert.equal(await panel.isVisible(), true);
    await panel.getByRole('button', { name: 'Fechar' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(await panel.isVisible(), false);
    const cancelledAgain = await field.evaluate(node => !node.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, altKey: true,
    })));
    assert.equal(cancelledAgain, true, 'Alt+click must suppress the original Odoo action');
    await panel.getByRole('heading', { name: 'res.partner.name' }).waitFor();
    await panel.getByRole('button', { name: 'Fechar' }).click();
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(xrayCalls, [], 'the extension must not call the installed addon');
    console.log('browser.cjs: OK (Odoo 19 without addon markers, Alt+click, standard RPC, editor click)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
