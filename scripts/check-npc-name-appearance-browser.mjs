// Production NPC list/card renderers with isolated story fixtures only.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const functions = ['renderPlanSectionFold', 'renderItemList', 'renderItemCard', 'renderItemChips', 'getContextItemId', 'renderDirectorWorldEntryLink', 'directorItemParagraphs', 'directorSelectionOrder', 'renderDirectorParagraph'].map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const qa = new URL('../dist/local-qa/npc-name/', import.meta.url);
await mkdir(qa, { recursive: true });
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const checks = [], errors = [], blocked = []; let external = 0;
const deadline = setTimeout(() => { void browser.close(); }, 120000);
const ok = (label, result) => { assert.ok(result, label); checks.push(label); };
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.href === 'https://fontsapi.zeoseven.com/161/main/result.css') return route.fulfill({ contentType: 'text/css', body: '/* isolated fallback font */' });
  if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;min-height:100dvh!important;height:auto!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:auto!important;max-height:none!important;margin:0!important}#story-director-modal .sd-body{max-height:none!important;overflow:visible!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"></main></section></div>` });
  if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
  external++; blocked.push(url.href); return route.abort();
});
try {
  await page.goto('https://qianmu.test/');
  await page.evaluate(async source => {
    const [{ createQianmuAppearanceSession }, { updateAppearancePreferences }, { applyQianmuIcons }] = await Promise.all([import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js')]);
    Object.assign(window, { settings: { theme: 'dark' }, injectSelection: new Map(), directorWorldEntryLinks: new Map([['npc_updates:1', { packetId: 'fixture-packet', records: [] }]]) });
    window.htmlEscape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    window.directorDisplayPlan = () => plan;
    window.renderDirectorSectionNotice = () => '';
    window.plan = { npc_updates: [
      { id: 'npc2', name: '韩立', role: '江北分局刑侦大队副大队长', emotional_state: '沉稳务实，对老城区物业的猫腻门儿清。', current_goal: '查清旧案的细节。' },
      { id: 'npc3', name: '赵德海', role: '杨家弄老旧小区物业代管员（新角入场）', emotional_state: '惊慌失措，存着侥幸心理想把责任推给流动租客，却又担心隐瞒的收据被找到。', current_goal: '想确认被收走的钥匙是否已经登记。' },
      { id: 'npc4', name: '长孙无忌', role: '夜班资料室负责人，负责登记资料、核实来源并联系下一班交接人员', emotional_state: '冷静专注，面对现场反复变化的线索仍保持谨慎，准备完整核对每一项记录。', current_goal: '保留纸面原件与交接记录。' }
    ] };
    (0, eval)(source);
    window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
    appearance.mount(document.querySelector('#story-director-modal'));
    window.renderFixture = async (family, mode) => {
      if (family === 'classic') { settings.theme = mode; document.querySelector('#story-director-modal').className = 'open sd-theme-' + mode; }
      settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync();
      document.querySelector('.sd-body').innerHTML = renderPlanSectionFold('其他人物动向', plan.npc_updates, 'npc', 'castfold-npc');
      applyQianmuIcons(document.querySelector('#story-director-modal'));
    };
  }, functions);
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
    const label = `${family}/${mode}/${width}`;
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(async ({ family, mode }) => renderFixture(family, mode), { family, mode });
    ok(label + ' renders full two-, three- and four-character names with original chips', await page.locator('.sd-item-npc').evaluateAll(nodes => nodes.length === 3 && nodes.every((node, index) => node.querySelector('h4').textContent === plan.npc_updates[index].name && node.querySelectorAll('.sd-badge').length === 2 && node.textContent.includes(plan.npc_updates[index].emotional_state))));
    ok(label + ' names are larger, right-aligned and vertically translucent rather than the shared title gradient', await page.locator('.sd-item-npc h4').evaluateAll(nodes => nodes.every(node => { const style = getComputedStyle(node); return parseFloat(style.fontSize) >= 20 && style.textAlign === 'right' && style.backgroundImage.startsWith('linear-gradient(') && !/linear-gradient\(\d/.test(style.backgroundImage) && /\/ 0\.78\)/.test(style.backgroundImage) && /\/ 0\.12\)/.test(style.backgroundImage) && style.backgroundClip === 'text' && style.webkitTextFillColor === 'rgba(0, 0, 0, 0)'; })));
    const geometry = await page.locator('.sd-item-npc').evaluateAll(nodes => nodes.map(node => { const name = node.querySelector('h4'), chips = node.querySelector('.sd-mini-chip-row'), emotion = chips.lastElementChild, nameRect = name.getBoundingClientRect(), chipsRect = chips.getBoundingClientRect(), bottom = emotion.getBoundingClientRect().bottom; return { overlap: nameRect.left < chipsRect.right, beyondEmotion: nameRect.bottom - bottom, clipped: name.scrollWidth > name.clientWidth + 1, overflow: node.scrollWidth > node.clientWidth + 1, gap: nameRect.left - chipsRect.right }; }));
    ok(label + ' names never overlap chips or descend below emotion: ' + JSON.stringify(geometry), geometry.every(item => !item.overlap && item.beyondEmotion <= 1 && !item.clipped && !item.overflow && item.gap >= 9));
    ok(label + ' long role/emotion text and whole page do not overflow horizontally', await page.locator('.sd-body,.sd-item-npc .sd-badge').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
    ok(label + ' two-to-four-character names stay on one line', await page.locator('.sd-item-npc h4').evaluateAll(nodes => nodes.every(node => node.clientHeight <= parseFloat(getComputedStyle(node).lineHeight) + 1)));
    if (width <= 430) {
      const chipWidths = await page.locator('.sd-item-npc .sd-badge').evaluateAll(nodes => nodes.map(node => { const style = getComputedStyle(node); return (node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / parseFloat(style.fontSize); }));
      ok(label + ' mobile chip prose has room for at least eight characters: ' + JSON.stringify(chipWidths), chipWidths.every(value => value >= 8));
      ok(label + ' optional media action remains visible at the right on its own row', await page.locator('.sd-item-npc > summary:has(> .sd-world-media-entry)').evaluate(node => { const button = node.querySelector('.sd-world-media-entry').getBoundingClientRect(), main = node.querySelector('.sd-item-summary-main').getBoundingClientRect(); return button.top >= main.bottom && Math.abs(button.right - main.right) < 1; }));
    }
    const first = page.locator('.sd-item-npc').first();
    await first.locator('summary').focus(); await page.keyboard.press('Enter');
    ok(label + ' native keyboard expansion retains the name layout and detail text', await first.evaluate(node => node.open && node.querySelector('.sd-director-paragraph p').textContent === plan.npc_updates[0].current_goal && node.querySelector('h4').getBoundingClientRect().bottom <= node.querySelector('.sd-mini-chip-row').getBoundingClientRect().bottom + 1));
    await page.keyboard.press('Enter');
    ok(label + ' native keyboard collapse still works', await first.evaluate(node => !node.open));
    if (width === 393 || family === 'glass') await page.locator('.sd-plan-section').screenshot({ animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-${width}.png`, qa)) });
  }
  assert.deepEqual(errors, []); assert.equal(external, 0, JSON.stringify(blocked));
  console.log(JSON.stringify({ passed: checks.length, errors, external, scope: 'actual NPC renderer with isolated 2/3/4-character identities; no host state, writes, generation or real browser session' }));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
