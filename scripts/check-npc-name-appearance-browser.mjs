// Production NPC list/card renderers with isolated story fixtures only.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const functions = ['renderPlanSectionFold', 'renderRelationUndercurrentsCard', 'renderItemList', 'renderItemCard', 'renderItemChips', 'getContextItemId', 'renderDirectorWorldEntryLink', 'directorItemParagraphs', 'directorSelectionOrder', 'renderDirectorParagraph'].map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const qa = new URL('../dist/local-qa/npc-alternating/', import.meta.url);
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
    window.plan = { character_dynamics: [{ name: '秦铎', title: '核对夜班记录', content: '他将新记录放在值班室的桌边。' }], npc_updates: [
      { id: 'npc2', name: '韩立', role: '江北分局刑侦大队副大队长', emotional_state: '沉稳务实，对老城区物业的猫腻门儿清。', current_goal: '查清旧案的细节。' },
      { id: 'npc3', name: '赵德海', role: '杨家弄老旧小区物业代管员（新角入场）', emotional_state: '惊慌失措，存着侥幸心理想把责任推给流动租客，却又担心隐瞒的收据被找到。', current_goal: '想确认被收走的钥匙是否已经登记。' },
      { id: 'npc4', name: '长孙无忌', role: '夜班资料室负责人，负责登记资料、核实来源并联系下一班交接人员', emotional_state: '冷静专注，面对现场反复变化的线索仍保持谨慎，准备完整核对每一项记录。', current_goal: '保留纸面原件与交接记录。' },
      { id: 'npc5', name: '邵宁', role: '江北分局法医', emotional_state: '冷静专注，对现场围观者的议论毫无反应。', current_goal: '核对检验报告。' }
    ], relation_undercurrents: [
      { parties: ['韩立', '陈叙', '乔苒'], tone: '前辈敲打与同侪分寸', tension: '值班室里重新核对出勤记录，几人仍在磨合各自处理现场的方式。', drift: '交接之前还有一份记录等待当事人签字。' },
      { parties: ['值班员', '夜班医师'], tone: 'positive', tension: '双方默契地接下临时交接。' },
      { parties: ['承包商', '货主'], tone: 'negative', tension: '迟到的货运引发分歧。' }
    ] };
    (0, eval)(source);
    window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
    appearance.mount(document.querySelector('#story-director-modal'));
    window.renderFixture = async (family, mode) => {
      if (family === 'classic') { settings.theme = mode; document.querySelector('#story-director-modal').className = 'open sd-theme-' + mode; }
      settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync();
      document.querySelector('.sd-body').innerHTML = renderPlanSectionFold('此间一人', plan.character_dynamics, 'character', 'castfold-character') + renderPlanSectionFold('其他人物动向', plan.npc_updates, 'npc', 'castfold-npc') + renderRelationUndercurrentsCard(plan);
      applyQianmuIcons(document.querySelector('#story-director-modal'));
    };
  }, functions);
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
    const label = `${family}/${mode}/${width}`;
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(async ({ family, mode }) => renderFixture(family, mode), { family, mode });
    ok(label + ' character name appears once in the title suffix instead of a right-side note', await page.locator('[data-acc="castfold-character"] > summary').evaluate(node => node.textContent === '此间一人 · 秦铎' && !node.querySelector('.sd-character-names') && node.children.length === 1));
    ok(label + ' renders four full two-, three- and four-character names with original text labels', await page.locator('.sd-item-npc').evaluateAll(nodes => nodes.length === 4 && nodes.every((node, index) => node.querySelector('h4').textContent === plan.npc_updates[index].name && node.querySelectorAll('.sd-badge').length === 2 && node.textContent.includes(plan.npc_updates[index].emotional_state))));
    ok(label + ' names alternate left/right with a lighter vertical gradient and top alignment', await page.locator('.sd-item-npc h4').evaluateAll(nodes => nodes.every((node, index) => { const style = getComputedStyle(node); return parseFloat(style.fontSize) >= 20 && style.textAlign === (index % 2 === 0 ? 'left' : 'right') && style.alignSelf === 'start' && style.backgroundImage.startsWith('linear-gradient(') && !/linear-gradient\(\d/.test(style.backgroundImage) && /\/ 0\.62\)/.test(style.backgroundImage) && /\/ 0\.08\)/.test(style.backgroundImage) && style.backgroundClip === 'text' && style.webkitTextFillColor === 'rgba(0, 0, 0, 0)'; })));
    ok(label + ' role and emotion are unboxed transparent text with no border or shadow', await page.locator('.sd-item-npc .sd-badge').evaluateAll(nodes => nodes.every(node => { const style = getComputedStyle(node); return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none' && style.boxShadow === 'none' && ['Top', 'Right', 'Bottom', 'Left'].every(side => style[`border${side}Width`] === '0px'); })));
    const geometry = await page.locator('.sd-item-npc').evaluateAll(nodes => nodes.map(node => { const name = node.querySelector('h4'), chips = node.querySelector('.sd-mini-chip-row'), mainRect = node.querySelector('.sd-item-summary-main').getBoundingClientRect(), nameRect = name.getBoundingClientRect(), chipsRect = chips.getBoundingClientRect(); return { fullWidth: Math.abs(chipsRect.width - mainRect.width) < 1, clipped: name.scrollWidth > name.clientWidth + 1, overflow: node.scrollWidth > node.clientWidth + 1, gap: chipsRect.top - nameRect.bottom }; }));
    ok(label + ' alternating names own a heading row and labels use the full reading width: ' + JSON.stringify(geometry), geometry.every(item => item.fullWidth && !item.clipped && !item.overflow && item.gap >= 7));
    ok(label + ' long role/emotion text and whole page do not overflow horizontally', await page.locator('.sd-body,.sd-item-npc .sd-badge').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
    ok(label + ' two-to-four-character names stay on one line', await page.locator('.sd-item-npc h4').evaluateAll(nodes => nodes.every(node => node.clientHeight <= parseFloat(getComputedStyle(node).lineHeight) + 1)));
    if (width <= 430) {
      const chipWidths = await page.locator('.sd-item-npc .sd-badge').evaluateAll(nodes => nodes.map(node => { const style = getComputedStyle(node); return (node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / parseFloat(style.fontSize); }));
      ok(label + ' mobile chip prose has room for at least sixteen characters: ' + JSON.stringify(chipWidths), chipWidths.every(value => value >= 16));
      ok(label + ' optional media action remains visible at the right on its own row', await page.locator('.sd-item-npc > summary:has(> .sd-world-media-entry)').evaluate(node => { const button = node.querySelector('.sd-world-media-entry').getBoundingClientRect(), main = node.querySelector('.sd-item-summary-main').getBoundingClientRect(); return button.top >= main.bottom && Math.abs(button.right - main.right) < 1; }));
    }
    const first = page.locator('.sd-item-npc').first();
    await first.locator('summary').focus(); await page.keyboard.press('Enter');
    ok(label + ' native keyboard expansion retains independent name heading and detail text', await first.evaluate(node => node.open && node.querySelector('.sd-director-paragraph p').textContent === plan.npc_updates[0].current_goal && node.querySelector('.sd-mini-chip-row').getBoundingClientRect().top >= node.querySelector('h4').getBoundingClientRect().bottom + 7));
    await page.keyboard.press('Enter');
    ok(label + ' native keyboard collapse still works', await first.evaluate(node => !node.open));
    const media = page.locator('.sd-item-npc .sd-world-media-entry');
    await media.scrollIntoViewIfNeeded(); await media.focus();
    ok(label + ' unchanged media entry stays keyboard-focusable and unobscured', await media.evaluate(node => { const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return !node.disabled && document.activeElement === node && (hit === node || node.contains(hit)); }));
    ok(label + ' neutral relationship label has a visible gray fill without overriding positive/negative colors', await page.locator('.sd-relus-tone').evaluateAll(nodes => {
      const styles = nodes.map(node => getComputedStyle(node));
      return nodes.length === 3 && styles.every(style => style.backgroundColor !== 'rgba(0, 0, 0, 0)') && new Set(styles.map(style => style.color)).size === 3 && nodes[0].textContent === '前辈敲打与同侪分寸';
    }));
    ok(label + ' relation labels and prose stay within their cards', await page.locator('.sd-relus-row,.sd-relus-tone').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
    if (width === 393 || family === 'glass') await page.locator('.sd-body').screenshot({ animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-${width}.png`, qa)) });
    await page.evaluate(async ({ family, mode }) => {
      window.savedNpcFixture = plan.npc_updates;
      window.savedCharacterFixture = plan.character_dynamics;
      plan.character_dynamics = [{ name: '安德烈亚·冯·罗森伯格与夜班资料室联合调查员', title: '较长角色名的生活片段', content: '保持完整的角色身份。' }];
      plan.npc_updates = [{ id: 'long', name: '安德烈亚·冯·罗森伯格', role: '跨区域联合资料复核负责人', emotional_state: '谨慎核对全部记录，保持现场交接秩序。', content: '原文保持可读。' }, { id: 'bare', name: '无名旅人', content: '缺少定位与情绪的旧条目。' }];
      await renderFixture(family, mode);
    }, { family, mode });
    ok(label + ' long and missing-chip identities keep full names, content and bounded layout', await page.locator('.sd-item-npc').evaluateAll(nodes => nodes.length === 2 && nodes.every((node, index) => node.querySelector('h4').textContent === plan.npc_updates[index].name && node.scrollWidth <= node.clientWidth + 1 && node.querySelector('h4').scrollWidth <= node.querySelector('h4').clientWidth + 1) && !nodes[1].querySelector('.sd-mini-chip-row')));
    ok(label + ' long character title suffix wraps without clipping or a second right-side name', await page.locator('[data-acc="castfold-character"] > summary').evaluate(node => node.textContent === '此间一人 · ' + plan.character_dynamics[0].name && node.scrollWidth <= node.clientWidth + 1 && !node.querySelector('.sd-character-names')));
    if (family === 'glass' && width === 320) await page.locator('.sd-item-npc').first().screenshot({ animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-long-name-${width}.png`, qa)) });
    await page.evaluate(() => { plan.npc_updates = savedNpcFixture; plan.character_dynamics = savedCharacterFixture; });
  }
  assert.deepEqual(errors, []); assert.equal(external, 0, JSON.stringify(blocked));
  console.log(JSON.stringify({ passed: checks.length, errors, external, scope: 'actual character and NPC renderers with four alternating identities plus long-name/missing-chip boundaries; no host state, writes, generation or real browser session' }));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
