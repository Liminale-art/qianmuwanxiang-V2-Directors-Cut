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
const interfaceFont = await readFile(process.env.QIANMU_UI_FONT_FIXTURE || 'C:/Windows/Fonts/times.ttf');
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
  if (url.origin === 'https://font-fixture.test') {
    if (url.pathname === '/broken.ttf') return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    return route.fulfill({ contentType: 'font/ttf', headers: { 'access-control-allow-origin': '*' }, body: url.pathname === '/interface.ttf' ? interfaceFont : font });
  }
  unexpected.push(url.href); return route.abort();
});
try {
  await page.goto('https://font-host.test/');
  await page.addStyleTag({ content: nativeCss });
  await page.addStyleTag({ content: ':root{--mainFontFamily:Georgia,serif;--mainFontSize:20px;--monoFontFamily:monospace}.fa{font-family:FixtureIcon!important}#story-director-modal{font-family:Georgia,serif}.np-min-card{font-family:Georgia,serif}#chat{height:500px;overflow:auto}' });
  await page.evaluate(async () => {
    const { createFontRuntime } = await import('./qianmu-font-runtime.js');
    document.body.classList.add('sd-prose-layout');
    document.body.innerHTML = '<aside id="font-host"><button id="host-button">Settings ABC</button><input id="host-input" value="Font ABC"><textarea id="settings-textarea">Settings ABC</textarea><span id="host-text">Menu ABC</span><i class="fa" id="host-icon">★</i></aside><div id="chat"><div class="mes"><div class="mesAvatarWrapper"><div class="mesIDDisplay" id="meta-id">#4</div><div class="mes_timer" id="meta-timer">192.9s</div><div class="tokenCounterDisplay" id="meta-tokens">5105t</div></div><div class="mes_block"><div class="ch_name"><div><span class="name_text" id="meta-name">人物 ABC</span><small class="timestamp" id="meta-time">2026/10/19</small><i class="fa" id="meta-icon">★</i></div></div></div><div class="swipeRightBlock"><div class="swipes-counter" id="meta-swipe">1/2</div></div><div class="mes_text"><p id="paragraph">Plain <span id="nested">inline ABC</span> <strong id="strong">strong ABC</strong> <em id="emphasis">emphasis ABC</em> <code id="code">const x = 1</code><i class="fa" id="prose-icon">★</i></p></div></div><div class="mes"><div class="mes_text"><p id="mixed-paragraph">Mixed ABC</p><div class="np-min-card"><p id="card-text">Authored ABC <span class="name_text" id="rich-meta-lookalike">Custom name</span></p></div></div></div><div class="mes"><div class="mes_text"><div class="welcomePanel"><div class="recentChatList"><div class="recentChat"><div class="recentChatInfo"><div class="chatNameContainer"><div class="chatName" id="recent-name"><strong class="characterName" id="recent-character">人物 ABC</strong><span id="recent-file">聊天 ABC</span></div><small class="chatDate" id="recent-date">2026/10/19</small><div class="chatActions"><button><i class="fa" id="recent-icon">★</i></button></div></div><div class="chatMessageContainer"><div class="chatMessage" id="recent-message">内容 ABC</div><div class="chatStats"><div class="counterBlock"><i class="fa">★</i><small id="recent-count">27</small></div><small class="fileSize" id="recent-size">58KB</small></div></div></div></div></div></div></div></div></div><div id="form_sheld"><form id="send_form"><div id="composer-wrap"><textarea id="send_textarea" class="mdHotkeys" placeholder="Compose ABC"></textarea><button id="send-button" type="button">Send ABC</button><i id="send-icon" class="fa">★</i></div></form></div><section id="story-director-modal"><p id="qianmu-text">Qianmu ABC</p></section>';
    const composer = document.getElementById('send_textarea');
    // Leaf classes/parent structure checked against the official 1.19.0
    // message template and welcomePanel.html; no user chat content is read.
    window.readingMetadata = ['meta-id', 'meta-timer', 'meta-tokens', 'meta-name', 'meta-time', 'meta-swipe', 'recent-name', 'recent-character', 'recent-file', 'recent-date', 'recent-message', 'recent-count', 'recent-size'];
    composer.value = 'Existing draft ABC'; composer.setSelectionRange(3, 8);
    const selection = id => ({ fontId: id, weight: 400, style: 'normal', enabled: true });
    const record = id => ({ id, source: { kind: 'web' }, faces: [{ urls: [{ url: `https://font-fixture.test/${id}.ttf`, format: 'truetype' }], weight: '400', style: 'normal' }] });
    window.state = { mode: 'separate', previewText: 'ABC', fonts: ['fixture', 'interface', 'broken'].map(record) };
    window.runtime = createFontRuntime({ document }); window.selectFont = selection;
    window.snapshot = () => Object.fromEntries([...window.readingMetadata, 'meta-icon', 'recent-icon', 'rich-meta-lookalike', 'host-button', 'host-input', 'settings-textarea', 'host-text', 'host-icon', 'paragraph', 'nested', 'strong', 'emphasis', 'code', 'prose-icon', 'mixed-paragraph', 'card-text', 'qianmu-text', 'send_textarea', 'composer-placeholder', 'send-button', 'send-icon', 'composer-wrap'].map(id => {
      const style = getComputedStyle(document.getElementById(id === 'composer-placeholder' ? 'send_textarea' : id), id === 'composer-placeholder' ? '::placeholder' : null);
      return [id, { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, style: style.fontStyle, lineHeight: style.lineHeight, ...(id === 'send_textarea' ? { value: composer.value, selectionStart: composer.selectionStart, selectionEnd: composer.selectionEnd } : {}) }];
    }));
  });
  const baseline = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, body: selectFont('fixture') }); });
  const nativeBody = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, st: selectFont('fixture') }); });
  const nativeSt = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync(state); });
  const nativeRestored = await page.evaluate(() => snapshot());
  // Two independent real faces must stay in their selected scopes.
  await page.evaluate(async () => { await runtime.sync({ ...state, body: { ...selectFont('fixture'), weight: 700, style: 'italic' }, st: selectFont('interface') }); });
  const independent = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, body: selectFont('broken'), st: selectFont('interface') }); });
  const failedReplacement = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, enabled: false, body: selectFont('fixture'), st: selectFont('interface') }); });
  const disabled = await page.evaluate(() => snapshot());
  // An inherited user style must not accidentally inherit the UI assignment
  // through a composer ancestor when no body font is selected.
  const inheritedRule = await page.addStyleTag({ content: '#send_textarea{font-family:inherit;font-weight:inherit;font-style:inherit}' });
  const inheritedBaseline = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, st: selectFont('interface') }); });
  const inheritedUiOnly = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync(state); });
  await inheritedRule.evaluate(node => node.remove());
  // Independently authored theme/font-provider collision cases: direct
  // paragraph declarations defeat inheritance; high-specificity host rules
  // compete even when the font manager inserts its own style later.
  await page.addStyleTag({ content: '#chat .mes_text p, #chat .mes_text p span, #chat .mes_text strong, #chat .mes_text em, #send_form #send_textarea {font-family:"Courier New",monospace!important} #font-host #host-button, #font-host #host-input, #font-host #settings-textarea, #font-host #host-text, #send_form #send-button {font-family:"Courier New",monospace!important}' });
  const competing = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, body: selectFont('fixture') }); });
  const body = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, st: selectFont('fixture') }); });
  const st = await page.evaluate(() => snapshot());
  await page.evaluate(async () => { await runtime.sync({ ...state, mode: 'shared', shared: selectFont('fixture') }); });
  const shared = await page.evaluate(() => snapshot());
  await page.addStyleTag({ content: '#font-host #host-button, #font-host #host-input, #font-host #settings-textarea, #font-host #host-text, #send_form #send-button {font-family:Georgia,serif!important} #chat .mes_text p, #chat .mes_text p span, #chat .mes_text strong, #chat .mes_text em, #send_form #send_textarea {font-family:Georgia,serif!important}' });
  const laterCompetitor = await page.evaluate(() => snapshot());
  // Remove only this synthetic late rule so disable can be compared with the
  // unchanged original competitor. Production never touches provider styles.
  await page.evaluate(() => document.head.lastElementChild.remove());
  await page.evaluate(() => runtime.dispose());
  const restored = await page.evaluate(() => snapshot());
  const expectedBody = [...await page.evaluate(() => readingMetadata), 'paragraph', 'nested', 'strong', 'emphasis', 'mixed-paragraph', 'send_textarea', 'composer-placeholder'];
  const expectedSt = ['host-button', 'host-input', 'settings-textarea', 'host-text', 'send-button'];
  const protectedIds = ['meta-icon', 'recent-icon', 'rich-meta-lookalike', 'code', 'host-icon', 'prose-icon', 'card-text', 'qianmu-text', 'send-icon', 'composer-wrap'];
  const result = { nativeVersion, expectedBody: Object.fromEntries(expectedBody.map(id => [id, body[id].family.includes('QianmuFont_')])), expectedSt: Object.fromEntries(expectedSt.map(id => [id, st[id].family.includes('QianmuFont_')])), body, st, shared, restored, errors, unexpected, realST: false, externalNetwork: false };
  if (process.env.QIANMU_FONT_EXPECT_FAILURE === '1') { console.log(JSON.stringify(result)); }
  else {
    for (const id of expectedBody) { assert.ok(nativeBody[id].family.includes('QianmuFont_'), `native body ${id}`); assert.equal(nativeSt[id].family, baseline[id].family, `native ST-only leaves ${id}`); }
    for (const id of expectedSt) { assert.ok(nativeSt[id].family.includes('QianmuFont_'), `native ST ${id}`); assert.equal(nativeBody[id].family, baseline[id].family, `native body-only leaves ${id}`); }
    assert.deepEqual(nativeRestored, baseline);
    for (const phase of [nativeBody, nativeSt, nativeRestored, independent, failedReplacement, disabled, inheritedUiOnly, body, st, shared, laterCompetitor, restored]) {
      for (const field of ['value', 'selectionStart', 'selectionEnd', 'size', 'lineHeight']) assert.equal(phase.send_textarea[field], baseline.send_textarea[field], `composer retains ${field}`);
    }
    assert.equal(independent.send_textarea.family, independent.paragraph.family);
    for (const id of await page.evaluate(() => readingMetadata)) {
      assert.equal(independent[id].family, independent.paragraph.family, `independent body assignment reaches ${id}`);
      assert.deepEqual(failedReplacement[id], independent[id], `failed replacement retains ${id}`);
    }
    assert.equal(independent['composer-placeholder'].family, independent.paragraph.family);
    assert.notEqual(independent.send_textarea.family, independent['settings-textarea'].family);
    assert.equal(independent['settings-textarea'].family, independent['host-input'].family);
    assert.equal(independent.send_textarea.weight, '700'); assert.equal(independent.send_textarea.style, 'italic');
    for (const id of ['send_textarea', 'composer-placeholder', 'paragraph', 'settings-textarea']) assert.deepEqual(failedReplacement[id], independent[id], `failed body replacement retains ${id}`);
    assert.deepEqual(disabled, baseline);
    for (const id of ['send_textarea', 'composer-placeholder', 'composer-wrap']) assert.deepEqual(inheritedUiOnly[id], inheritedBaseline[id], `UI-only leaves inherited composer ${id}`);
    for (const id of expectedBody) { assert.ok(body[id].family.includes('QianmuFont_'), `body ${id}`); assert.ok(shared[id].family.includes('QianmuFont_'), `shared ${id}`); assert.equal(st[id].family, competing[id].family, `ST-only leaves ${id}`); }
    for (const id of expectedSt) { assert.ok(st[id].family.includes('QianmuFont_'), `ST ${id}`); assert.ok(shared[id].family.includes('QianmuFont_'), `shared ${id}`); assert.equal(body[id].family, competing[id].family, `body-only leaves ${id}`); }
    for (const id of protectedIds) { assert.equal(body[id].family, competing[id].family, `body preserves ${id}`); assert.equal(st[id].family, competing[id].family, `ST preserves ${id}`); assert.equal(shared[id].family, competing[id].family, `shared preserves ${id}`); }
    for (const id of Object.keys(baseline)) { assert.equal(shared[id].size, baseline[id].size, `size retained ${id}`); assert.equal(shared[id].lineHeight, baseline[id].lineHeight, `line height retained ${id}`); }
    for (const id of [...expectedBody, ...expectedSt]) assert.ok(laterCompetitor[id].family.includes('QianmuFont_'), `later unlayered rule leaves explicit font ${id}`);
    assert.equal(shared.strong.weight, competing.strong.weight); assert.equal(shared.emphasis.style, competing.emphasis.style);
    assert.deepEqual(restored, competing); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    const checks = ['ST 1.19.0 native message metadata and recent-chat row selectors follow body without overriding rich-card lookalikes', 'Native ST body-only font includes composer and leaves interface controls', 'Native ST interface-only font leaves prose and composer', 'Clearing application restores native baseline', 'Independent real body and interface faces keep composer and settings separate', 'Composer placeholder and selected weight/style follow body', 'Failed body replacement retains previous prose and composer fonts', 'Master disable restores native composer and all previous targets', 'UI-only does not font inherited composer ancestors', 'Direct paragraph/composer important declarations no longer defeat body font', 'High-specificity unlayered rules no longer defeat interface font', 'Shared application changes both intended scopes', 'Icons/code/authored cards/Qianmu retain their previous fonts', 'Native sizes/line heights and strong/emphasis semantics remain intact', 'Later unlayered provider styles do not displace explicit scoped application', 'Disposal restores the existing provider without modifying its state', 'No browser errors or external network'];
    console.log(JSON.stringify({ passed: checks.length, checks, nativeVersion, actualFontFace: true, realST: false, externalNetwork: false, errors, unexpected }));
  }
} finally { await page.close(); await browser.close(); }
