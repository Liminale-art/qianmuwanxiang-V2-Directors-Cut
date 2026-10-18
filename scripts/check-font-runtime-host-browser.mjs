// Isolated host-cascade regression. Native ST CSS is read-only; no running ST,
// user settings, chat contents, or external font service are accessed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const hostRoot = process.env.QIANMU_ST_FIXTURE_ROOT || 'D:/ST/tools/SillyTavern-upstream';
const nativeCss = await readFile(`${hostRoot}/public/style.css`, 'utf8');
const nativeVersion = JSON.parse(await readFile(`${hostRoot}/package.json`, 'utf8')).version;
const font = await readFile(process.env.QIANMU_FONT_FIXTURE || 'C:/Windows/Fonts/arial.ttf');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const page = await browser.newPage();
const errors = [], unexpected = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://font-host.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
  if (url.origin === 'https://font-host.test' && url.pathname === '/qianmu-font-runtime.js') return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../qianmu-font-runtime.js', import.meta.url)) });
  if (url.origin === 'https://font-host.test' && /^\/css\/[a-z-]+\.css$/.test(url.pathname)) return route.fulfill({ contentType: 'text/css', body: await readFile(`${hostRoot}/public${url.pathname}`) });
  if (url.origin === 'https://font-host.test' && url.pathname === '/lib/dialog-polyfill.css') return route.fulfill({ contentType: 'text/css', body: await readFile(`${hostRoot}/public${url.pathname}`) });
  if (url.origin === 'https://font-fixture.test') return route.fulfill({ contentType: 'font/ttf', headers: { 'access-control-allow-origin': '*' }, body: font });
  unexpected.push(url.href); return route.abort();
});
try {
  await page.goto('https://font-host.test/');
  await page.addStyleTag({ content: nativeCss });
  await page.addStyleTag({ content: ':root{--mainFontFamily:Georgia,serif;--mainFontSize:20px;--monoFontFamily:monospace}.fa{font-family:FixtureIcon!important}#story-director-modal{font-family:Georgia,serif}.np-min-card{font-family:Georgia,serif}#chat{height:500px;overflow:auto}' });
  await page.evaluate(async () => {
    const { createFontRuntime } = await import('./qianmu-font-runtime.js');
    document.body.classList.add('sd-prose-layout');
    document.body.innerHTML = '<aside id="font-host"><button id="host-button">Settings ABC</button><input id="host-input" value="Font ABC"><span id="host-text">Menu ABC</span><i class="fa" id="host-icon">★</i></aside><div id="chat"><div class="mes"><div class="mes_text"><p id="paragraph">Plain <span id="nested">inline ABC</span> <strong id="strong">strong ABC</strong> <em id="emphasis">emphasis ABC</em> <code id="code">const x = 1</code><i class="fa" id="prose-icon">★</i></p></div></div><div class="mes"><div class="mes_text"><p id="mixed-paragraph">Mixed ABC</p><div class="np-min-card"><p id="card-text">Authored ABC</p></div></div></div></div><section id="story-director-modal"><p id="qianmu-text">Qianmu ABC</p></section>';
    const selection = id => ({ fontId: id, weight: 400, style: 'normal', enabled: true });
    window.state = { mode: 'separate', previewText: 'ABC', fonts: [{ id: 'fixture', source: { kind: 'web' }, faces: [{ urls: [{ url: 'https://font-fixture.test/fixture.ttf', format: 'truetype' }], weight: '400', style: 'normal' }] }] };
    window.runtime = createFontRuntime({ document }); window.selectFont = selection;
    window.snapshot = () => Object.fromEntries(['host-button', 'host-input', 'host-text', 'host-icon', 'paragraph', 'nested', 'strong', 'emphasis', 'code', 'prose-icon', 'mixed-paragraph', 'card-text', 'qianmu-text'].map(id => {
      const style = getComputedStyle(document.getElementById(id));
      return [id, { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, style: style.fontStyle }];
    }));
  });
  const baseline = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, body: selectFont('fixture') }); });
  const nativeBody = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, st: selectFont('fixture') }); });
  const nativeSt = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync(state); });
  const nativeRestored = await page.evaluate(() => snapshot());
  // Independently authored theme/font-provider collision cases: direct
  // paragraph declarations defeat inheritance; high-specificity host rules
  // compete even when the font manager inserts its own style later.
  await page.addStyleTag({ content: '#chat .mes_text p, #chat .mes_text p span, #chat .mes_text strong, #chat .mes_text em {font-family:"Courier New",monospace!important} #font-host #host-button, #font-host #host-input, #font-host #host-text {font-family:"Courier New",monospace!important}' });
  const competing = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, body: selectFont('fixture') }); });
  const body = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, st: selectFont('fixture') }); });
  const st = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, mode: 'shared', shared: selectFont('fixture') }); });
  const shared = await page.evaluate(() => snapshot());
  await page.addStyleTag({ content: '#font-host #host-button, #font-host #host-input, #font-host #host-text {font-family:Georgia,serif!important} #chat .mes_text p, #chat .mes_text p span, #chat .mes_text strong, #chat .mes_text em {font-family:Georgia,serif!important}' });
  const laterCompetitor = await page.evaluate(() => snapshot());
  // Remove only this synthetic late rule so disable can be compared with the
  // unchanged original competitor. Production never touches provider styles.
  await page.evaluate(() => document.head.lastElementChild.remove());
  await page.evaluate(() => runtime.dispose());
  const restored = await page.evaluate(() => snapshot());
  const expectedBody = ['paragraph', 'nested', 'strong', 'emphasis', 'mixed-paragraph'];
  const expectedSt = ['host-button', 'host-input', 'host-text'];
  const protectedIds = ['code', 'host-icon', 'prose-icon', 'card-text', 'qianmu-text'];
  const result = { nativeVersion, expectedBody: Object.fromEntries(expectedBody.map(id => [id, body[id].family.includes('QianmuFont_')])), expectedSt: Object.fromEntries(expectedSt.map(id => [id, st[id].family.includes('QianmuFont_')])), body, st, shared, restored, errors, unexpected, realST: false, externalNetwork: false };
  if (process.env.QIANMU_FONT_EXPECT_FAILURE === '1') { console.log(JSON.stringify(result)); }
  else {
    for (const id of expectedBody) { assert.ok(nativeBody[id].family.includes('QianmuFont_'), `native body ${id}`); assert.equal(nativeSt[id].family, baseline[id].family, `native ST-only leaves ${id}`); }
    for (const id of expectedSt) { assert.ok(nativeSt[id].family.includes('QianmuFont_'), `native ST ${id}`); assert.equal(nativeBody[id].family, baseline[id].family, `native body-only leaves ${id}`); }
    assert.deepEqual(nativeRestored, baseline);
    for (const id of expectedBody) { assert.ok(body[id].family.includes('QianmuFont_'), `body ${id}`); assert.ok(shared[id].family.includes('QianmuFont_'), `shared ${id}`); assert.equal(st[id].family, competing[id].family, `ST-only leaves ${id}`); }
    for (const id of expectedSt) { assert.ok(st[id].family.includes('QianmuFont_'), `ST ${id}`); assert.ok(shared[id].family.includes('QianmuFont_'), `shared ${id}`); assert.equal(body[id].family, competing[id].family, `body-only leaves ${id}`); }
    for (const id of protectedIds) { assert.equal(body[id].family, competing[id].family, `body preserves ${id}`); assert.equal(st[id].family, competing[id].family, `ST preserves ${id}`); assert.equal(shared[id].family, competing[id].family, `shared preserves ${id}`); }
    for (const id of Object.keys(baseline)) assert.equal(shared[id].size, baseline[id].size, `size retained ${id}`);
    for (const id of [...expectedBody, ...expectedSt]) assert.ok(laterCompetitor[id].family.includes('QianmuFont_'), `later unlayered rule leaves explicit font ${id}`);
    assert.equal(shared.strong.weight, competing.strong.weight); assert.equal(shared.emphasis.style, competing.emphasis.style);
    assert.deepEqual(restored, competing); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    const checks = ['Native ST body-only font and interface isolation', 'Native ST interface-only font and body isolation', 'Clearing application restores native baseline', 'Direct paragraph and inline important declarations no longer defeat body font', 'High-specificity unlayered rules no longer defeat interface font', 'Shared application changes both intended scopes', 'Icons/code/authored cards/Qianmu retain their previous fonts', 'Native sizes and strong/emphasis semantics remain intact', 'Later unlayered provider styles do not displace explicit scoped application', 'Disposal restores the existing provider without modifying its state', 'No browser errors or external network'];
    console.log(JSON.stringify({ passed: checks.length, checks, nativeVersion, actualFontFace: true, realST: false, externalNetwork: false, errors, unexpected }));
  }
} finally { await page.close(); await browser.close(); }
