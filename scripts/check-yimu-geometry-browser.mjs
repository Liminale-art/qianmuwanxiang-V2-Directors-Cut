// Real Yimu surface geometry with hostile host rules and a body taller than the
// viewport. No ST session, account data, backend or network is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const css = await readFile(new URL('../yimu/style.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const checks = [];
const hostile = `
  * { box-sizing: content-box; }
  body { margin: 41px 17px; min-height: 2200px; display: block; }
  .dialog, dialog, [role="dialog"] { position: absolute; inset: 0; width: 100%; height: 100%; margin: 80px; transform: translate(90px, 70px); }
  button { min-width: 240px; margin: 20px; }
`;

try {
    await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main>host page</main>');
    await page.addStyleTag({ content: hostile });
    await page.addStyleTag({ content: css });
    await page.evaluate(() => {
        document.body.insertAdjacentHTML('beforeend', '<div id="yimu-overlay" data-open><div id="yimu-dialog" open role="dialog"><section class="ym-shell"><header class="ym-header"><h2>忆幕</h2></header><div class="ym-scroll">内容</div></section></div></div>');
    });
    await page.evaluate(() => { const overlay = document.querySelector('#yimu-overlay'); overlay.hidden = true; overlay.removeAttribute('data-open'); });
    assert.equal(await page.locator('#yimu-overlay').evaluate(node => getComputedStyle(node).display), 'none', 'closed Yimu overlay stays hidden');
    await page.evaluate(() => { const overlay = document.querySelector('#yimu-overlay'); overlay.hidden = false; overlay.setAttribute('data-open', ''); });
    checks.push('closed Yimu overlay does not leak above the host page');
    for (const [width, height] of [[393, 850], [393, 500], [1280, 900]]) {
        await page.setViewportSize({ width, height });
        const layout = await page.evaluate(() => {
            const overlay = document.querySelector('#yimu-overlay').getBoundingClientRect();
            const dialog = document.querySelector('#yimu-dialog').getBoundingClientRect();
            return { overlay, dialog, centerX: dialog.left + dialog.width / 2, centerY: dialog.top + dialog.height / 2,
                viewport: [innerWidth, innerHeight], display: getComputedStyle(document.querySelector('#yimu-overlay')).display };
        });
        assert.equal(layout.display, 'grid', `${width}x${height}: body overlay stays grid-centred`);
        assert.ok(Math.abs(layout.overlay.left) < 1 && Math.abs(layout.overlay.top) < 1, `${width}x${height}: overlay starts at viewport origin`);
        assert.ok(Math.abs(layout.overlay.width - width) < 1 && Math.abs(layout.overlay.height - height) < 1, `${width}x${height}: overlay covers viewport only`);
        assert.ok(Math.abs(layout.centerX - width / 2) < 1 && Math.abs(layout.centerY - height / 2) < 1, `${width}x${height}: Yimu remains centred`);
        assert.ok(layout.dialog.width <= width - 28 + 1 && layout.dialog.height <= height - 12 + 1, `${width}x${height}: Yimu remains bounded`);
        checks.push(`${width}x${height}: hostile host layout cannot move the Yimu panel`);
    }
    console.log(JSON.stringify({ passed: checks.length, checks, scope: 'actual Yimu CSS and body-level overlay geometry; no ST data, backend or network' }));
} finally {
    await context.close();
    await browser.close();
}
