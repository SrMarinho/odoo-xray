const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const html = fs.readFileSync(path.join(__dirname, '../options/options.html'), 'utf8')
      .replace('<link rel="stylesheet" href="../ui.css">', '')
      .replace('<link rel="stylesheet" href="../themes/modern.css" id="themeLink">',
        '<link rel="stylesheet" id="themeLink">')
      .replace('<script src="../src/core.js"></script>', '')
      .replace('<script src="../src/settings.js"></script>', '')
      .replace('<script src="options.js"></script>', '');
    await page.setContent(html);
    await page.addStyleTag({ path: path.join(__dirname, '../ui.css') });
    await page.addStyleTag({ path: path.join(__dirname, '../themes/modern.css') });
    await page.evaluate(() => {
      // setContent() deixa a página em about:blank — fetch('../themes/…')
      // não resolve contra rede nenhuma, então simulamos o registro aqui.
      window.fetch = async () => ({ json: async () => ({ default: 'modern', themes: [
        { id: 'modern', name: 'Moderno' }, { id: 'luxury', name: 'Luxo' },
      ] }) });
      window.chrome = { storage: { sync: {
        get(_keys, callback) {
          callback({ enabled: true, mappings: [
            { container: '/mnt/one', host: '/home/me/project' },
            { container: '/mnt/two', host: '/home/me/project' },
          ] });
        },
        set(data, callback) { window.saved = data; callback(); },
        remove(key) { window.removed = key; },
      } } };
    });
    await page.addScriptTag({ path: path.join(__dirname, '../src/core.js') });
    await page.addScriptTag({ path: path.join(__dirname, '../src/settings.js') });
    await page.addScriptTag({ path: path.join(__dirname, '../options/options.js') });
    await page.waitForFunction(() => document.querySelectorAll('.theme-card').length > 0);

    assert.equal(await page.locator('.settings-card').count(), 6);
    assert.equal(await page.locator('.theme-card').count(), 2);
    assert.equal(await page.locator('.theme-card.active .theme-card-name').textContent(), 'Moderno');
    await page.click('.theme-card:has-text("Luxo")');
    assert.equal(await page.evaluate(() => document.getElementById('themeLink').getAttribute('href')), '../themes/luxury.css');
    assert.deepEqual(await page.locator('#projectRoots code').allTextContents(), ['/home/me/project']);
    assert.equal(await page.locator('#shortcutSettings').isVisible(), true);
    await page.selectOption('#activationMode', 'always');
    assert.equal(await page.locator('#alwaysSettings').isVisible(), true);
    await page.fill('#hoverDelay', '900');
    await page.fill('#newProjectRoot', '/home/me/other/');
    await page.click('#addProjectRoot');

    assert.equal(await page.locator('#panelSideSettings').isVisible(), true);
    await page.check('input[name="panelMode"][value="modal"]');
    assert.equal(await page.locator('#panelSideSettings').isVisible(), false);
    await page.check('input[name="panelMode"][value="push"]');
    await page.check('input[name="panelSide"][value="left"]');
    await page.fill('#panelWidth', '640');
    await page.check('input[name="tooltipPlacement"][value="above"]');
    await page.check('input[name="tooltipDensity"][value="compact"]');
    await page.uncheck('#tooltipHighlight');

    await page.click('#save');
    const saved = await page.evaluate(() => window.saved);
    assert.deepEqual(saved.projectRoots, ['/home/me/project', '/home/me/other']);
    assert.equal(saved.activationMode, 'always');
    assert.equal(saved.hoverDelay, 900);
    assert.deepEqual(saved.activationModifiers, ['alt']);
    assert.equal(saved.theme, 'luxury');
    assert.equal(saved.panelMode, 'push');
    assert.equal(saved.panelSide, 'left');
    assert.equal(saved.panelWidth, 640);
    assert.equal(saved.tooltipPlacement, 'above');
    assert.equal(saved.tooltipDensity, 'compact');
    assert.equal(saved.tooltipHighlight, false);
    assert.equal(await page.evaluate(() => window.removed), 'mappings');
    console.log('options.cjs: OK');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
