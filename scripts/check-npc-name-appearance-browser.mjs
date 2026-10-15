// Actual production renderers/events with isolated fixtures. Media handoffs are
// observed only: no host session, persistence, provider access or generation.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const functions = ['renderPlanSectionFold', 'renderRelationUndercurrentsCard', 'renderItemList', 'renderItemCard', 'renderItemChips', 'getContextItemId',
  'renderDirectorWorldEntryLink', 'bindDirectorWorldEntryLinks', 'directorItemParagraphs', 'directorSelectionOrder', 'renderDirectorParagraph',
  'updateDirectorSelectionOrder', 'updateInjectDock', 'collectDirectorSelectedText', 'bindDirectorSelectionEvents', 'renderGenerateRow',
  'renderPlugTab', 'renderQuickWheelSettings', 'bindWidgetSettings', 'bindDirectorReadingEvents'].map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const qa = new URL('../dist/local-qa/npc-inline-metadata/', import.meta.url);
await mkdir(qa, { recursive: true });
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
context.setDefaultTimeout(5000);
const checks = [], errors = [], blocked = []; let external = 0;
const deadline = setTimeout(() => { void browser.close(); }, 180000);
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
    const [{ createQianmuAppearanceSession }, { updateAppearancePreferences }, { applyQianmuIcons }, { QIANMU_HIVE_COMMANDS }] = await Promise.all([import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'), import('/qianmu-hive-commands.js')]);
    Object.assign(window, {
      MODAL_ID: 'story-director-modal', settings: { theme: 'dark' }, injectSelection: new Map(), mediaCalls: [], fixtureMediaRecords: [{ id: 'fixture-image' }],
      directorWorldEntryLinks: new Map([['npc_updates:1', { packetId: 'fixture-packet', signature: 'fixture-signature', records: [{ id: 'fixture-image' }] }]]),
      storyboardState: () => ({ enabled: true, directorBridge: { worldSideShotsEnabled: true } }),
      directorWorldPlanSignature: () => 'fixture-signature', storyboardGalleryRecords: () => [], getChatKey: () => 'isolated-chat',
      storyboardOpenLightbox: (records, id) => mediaCalls.push({ action: 'lightbox', id, count: records.length }),
      storyboardGenerateProductionPacket: (_, id) => mediaCalls.push({ action: 'generation-handoff', id }),
      toast: message => mediaCalls.push({ action: 'toast', message }),
      busy: false, LOG_LIMIT: 5, FLOAT_SIZE_MIN: 32, FLOAT_SIZE_MAX: 120, feedbackOpenScope: null,
      QUICK_COMMANDS: QIANMU_HIVE_COMMANDS, QUICK_COMMAND_IDS: QIANMU_HIVE_COMMANDS.map(item => item.id), fixtureSaves: 0,
      uniqueClean: values => [...new Set(values.filter(Boolean))], getFloatSize: () => 48,
      normalizeQuickWheelSettings: () => {}, renderLogEntry: () => '', renderStorageManagementCard: () => '',
      bindCreativeSocialEvents: () => {}, refreshWidgetRuntime: () => {}, saveSettings: () => fixtureSaves++,
      closeQuickWheel: () => {}, closeNotesPanel: () => {}, renderFloatButton: () => {}, renderFloatingNotes: () => {},
      directorProductionPacketState: {
        packets: [{ packetId: 'fixture-packet', sourceRef: { worldSource: 'fixture-source' } }],
        sourceRuntime: { worldSourceKey: source => source, indexWorldMedia: () => new Map([['fixture-source', fixtureMediaRecords]]) },
      },
    });
    window.htmlEscape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    window.directorDisplayPlan = () => plan;
    window.renderDirectorSectionNotice = () => '';
    window.plan = { character_dynamics: [{ name: '秦铎', title: '核对夜班记录', emotional_state: '沉静而专注', content: '他将新记录放在值班室的桌边。', inject_prompt: '他在交接记录末尾签下名字。' }], npc_updates: [
      { id: 'npc2', name: '韩立', role: '刑侦大队副大队长', emotional_state: '对新人冒进既护短又压着火气', current_goal: '查清旧案的细节。', next_action: '把最新记录交给夜班同事核对。' },
      { id: 'npc3', name: '赵德海', title: '旧版条目的工作标题', role: '老旧小区物业代管员', emotional_state: '做贼心虚又被怪事吓破了胆', current_goal: '想确认被收走的钥匙是否已经登记。' },
      { id: 'npc4', name: '长孙无忌', role: '夜班资料室负责人', emotional_state: '专注耐烦且不愿过早下定论', current_goal: '保留纸面原件与交接记录。' },
      { id: 'npc5', name: '邵宁', role: '江北分局法医', emotional_state: '冷静专注', current_goal: '核对检验报告。' },
    ], relation_undercurrents: [
      { parties: ['韩立', '陈叙', '乔苒'], tone: '前辈敲打与同侪分寸', tension: '值班室里重新核对出勤记录，几人仍在磨合各自处理现场的方式。', drift: '交接之前还有一份记录等待当事人签字。' },
      { parties: ['值班员', '夜班医师'], tone: 'positive', tension: '双方默契地接下临时交接。' },
      { parties: ['承包商', '货主'], tone: 'negative', tension: '迟到的货运引发分歧。' },
    ] };
    (0, eval)(source);
    window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
    appearance.mount(document.querySelector('#story-director-modal'));
    window.applyAccent = async accent => {
      settings.appearance = updateAppearancePreferences(settings, { accent, source: 'manual' });
      await appearance.sync();
    };
    window.colorBytes = color => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    window.colorContrast = (front, back) => {
      const luminance = color => colorBytes(color).slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const a = luminance(front), b = luminance(back); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    window.renderFixture = async (family, mode) => {
      injectSelection.clear(); mediaCalls.length = 0; fixtureMediaRecords = [{ id: 'fixture-image' }];
      if (family === 'classic') { settings.theme = mode; document.querySelector('#story-director-modal').className = 'open sd-theme-' + mode; }
      settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync();
      const root = document.querySelector('.sd-body');
      root.innerHTML = renderPlanSectionFold('此间一人', plan.character_dynamics, 'character', 'castfold-character') + renderPlanSectionFold('其他人物动向', plan.npc_updates, 'npc', 'castfold-npc') + renderRelationUndercurrentsCard(plan);
      applyQianmuIcons(root); bindDirectorSelectionEvents(root); bindDirectorWorldEntryLinks(root);
    };
    window.renderControlsFixture = () => {
      const root = document.querySelector('.sd-body'), template = document.createElement('template');
      template.innerHTML = renderPlugTab();
      root.innerHTML = renderGenerateRow() + template.content.querySelector('.sd-widget-card').outerHTML;
      applyQianmuIcons(root); bindDirectorReadingEvents(root); bindWidgetSettings(root);
    };
    window.renderModal = () => renderControlsFixture();
    window.isUnboxed = node => {
      const style = getComputedStyle(node);
      return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none' && style.boxShadow === 'none'
        && ['Top', 'Right', 'Bottom', 'Left'].every(side => style[`border${side}Width`] === '0px');
    };
  }, functions);
  await page.setViewportSize({ width: 393, height: 1000 });
  await page.evaluate(() => renderFixture('glass', 'light'));
  await page.locator('.sd-body').screenshot({ animations: 'disabled', path: fileURLToPath(new URL('initial-glass-light-393.png', qa)) });
  const sequenceTypography = await page.locator('.sd-npc-index').first().evaluate(node => {
    const style = getComputedStyle(node); return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight };
  });
  console.log(JSON.stringify({ sequenceTypography }));
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
    const label = `${family}/${mode}/${width}`;
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(async ({ family, mode }) => renderFixture(family, mode), { family, mode });
    ok(label + ' character name appears only in its section-title suffix', await page.locator('[data-acc="castfold-character"] > summary').evaluate(node => node.textContent === '此间一人 · 秦铎' && !node.querySelector('.sd-character-names') && node.children.length === 1));
    ok(label + ' historical character emotion is not displayed or removed from stored data', await page.locator('.sd-item-character').evaluate(node => !node.querySelector('.sd-item-emotion') && !node.textContent.includes(plan.character_dynamics[0].emotional_state) && plan.character_dynamics[0].emotional_state === '沉静而专注'));
    ok(label + ' numbered roster preserves legacy title-plus-name identities', await page.locator('.sd-item-npc').evaluateAll(nodes => nodes.length === 4 && nodes.every((node, index) => node.querySelector('h4').textContent === plan.npc_updates[index].name
      && node.querySelector('.sd-npc-index').textContent === String(index + 1).padStart(2, '0') && node.querySelector('.sd-npc-index').getAttribute('aria-hidden') === 'true'
      && !node.querySelector('.sd-badge,.sd-mini-chip-row') && !node.classList.contains('sd-npc-name-left'))));
    ok(label + ' NPC dividers occur only between rows with no first/last frame', await page.locator('.sd-item-npc').evaluateAll(nodes => nodes.every((node, index) => {
      const style = getComputedStyle(node); return style.borderTopWidth === (index ? '1px' : '0px') && style.borderBottomWidth === '0px' && style.borderTopLeftRadius === '0px' && style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.boxShadow === 'none';
    })));
    ok(label + ' sequence display face survives theme-wide font inheritance', await page.locator('.sd-npc-index').evaluateAll(nodes => nodes.every(node => /^Impact,/.test(getComputedStyle(node).fontFamily))));
    ok(label + ' sequence numerals have a vertical translucent accent fade', await page.locator('.sd-npc-index').evaluateAll(nodes => nodes.every(node => {
      const style = getComputedStyle(node); return style.backgroundImage.startsWith('linear-gradient(') && /\/ 0\.78\)/.test(style.backgroundImage) && /\/ 0\.18\)/.test(style.backgroundImage) && style.backgroundClip === 'text' && style.webkitTextFillColor === 'rgba(0, 0, 0, 0)';
    })));
    const geometry = await page.locator('.sd-item-npc').evaluateAll(nodes => nodes.map(node => {
      const number = node.querySelector('.sd-npc-index'), heading = node.querySelector('.sd-npc-heading'), emotion = heading.querySelector('.sd-npc-emotion'), name = heading.querySelector('h4'), role = heading.querySelector('.sd-npc-role'), nameRow = heading.querySelector('.sd-npc-name-row'), roleRow = heading.querySelector('.sd-npc-role-row');
      const numberRect = number.getBoundingClientRect(), headingRect = heading.getBoundingClientRect(), emotionRect = emotion.getBoundingClientRect(), nameRect = name.getBoundingClientRect(), roleRect = roleRow.getBoundingClientRect();
      const inline = emotionRect.top < nameRect.bottom - 1;
      const emotionFlow = inline
        ? nameRect.right + 5 <= emotionRect.left && emotionRect.height <= parseFloat(getComputedStyle(emotion).lineHeight) + 1
        : emotionRect.top >= nameRect.bottom - 1 && Math.abs(emotionRect.left - nameRow.getBoundingClientRect().left) <= 1;
      return { ordered: roleRow.nextElementSibling === nameRow && name.nextElementSibling === emotion && roleRect.bottom <= nameRect.top + 1 && emotionFlow,
        separate: numberRect.right + 5 <= headingRect.left && Math.abs(numberRect.top - headingRect.top) < 1,
        overflow: [node, heading, emotion, name, role].some(part => part.scrollWidth > part.clientWidth + 1), numberSize: parseFloat(getComputedStyle(number).fontSize) };
    }));
    ok(label + ' left sequence and right role/name/mood wrap without overlap: ' + JSON.stringify(geometry), geometry.every(item => item.ordered && item.separate && !item.overflow && item.numberSize >= 44));
    ok(label + ' NPC role is a compact contrast tag and emotion is unboxed', await page.locator('.sd-npc-heading').evaluateAll(nodes => nodes.every(node => {
      const role = getComputedStyle(node.querySelector('.sd-npc-role'));
      return colorBytes(role.backgroundColor)[3] === 255 && colorBytes(role.color).join(',') === '255,255,255,255' && colorContrast(role.color, role.backgroundColor) >= 4.5 && isUnboxed(node.querySelector('.sd-npc-emotion'));
    })));
    ok(label + ' short names stay on one line', await page.locator('.sd-item-npc h4').evaluateAll(nodes => nodes.every(node => node.clientHeight <= parseFloat(getComputedStyle(node).lineHeight) + 1)));
    ok(label + ' genuinely short emotion remains beside its name', await page.locator('.sd-item-npc').last().evaluate(node => {
      const name = node.querySelector('h4').getBoundingClientRect(), emotion = node.querySelector('.sd-npc-emotion').getBoundingClientRect();
      return node.querySelector('.sd-npc-emotion').textContent === '冷静专注' && name.right + 5 <= emotion.left && emotion.top < name.bottom;
    }));
    ok(label + ' metadata and page stay horizontally bounded', await page.locator('.sd-body,.sd-npc-emotion,.sd-npc-role').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
    ok(label + ' media action follows the role tag and keeps its count without a frame', await page.locator('.sd-item-npc .sd-npc-role-row:has(.sd-world-media-entry)').evaluate(node => {
      const action = node.querySelector('.sd-world-media-entry'), button = action.getBoundingClientRect(), role = node.querySelector('.sd-npc-role').getBoundingClientRect(), row = node.getBoundingClientRect(), icon = action.querySelector('.qm-glyph-icon').getBoundingClientRect();
      return role.right <= button.left && button.left - role.right <= 9 && button.top >= row.top - 1 && button.bottom <= row.bottom + 1 && button.width >= 24 && button.height >= 24 && icon.width === 14 && icon.height === 14 && isUnboxed(action) && action.querySelector('span').textContent === '1' && action.getAttribute('aria-label').includes('1 张画面') && node.scrollWidth <= node.clientWidth + 1 && node.closest('summary').querySelectorAll('.sd-world-media-entry').length === 1;
    }));
    const first = page.locator('.sd-item-npc').first(), character = page.locator('.sd-item-character').first();
    await first.locator('summary').focus(); await page.keyboard.press('Enter');
    ok(label + ' keyboard expansion retains NPC prose', await first.evaluate(node => node.open && node.querySelector('.sd-director-paragraph p').textContent === plan.npc_updates[0].current_goal));
    await first.locator('[data-director-paragraph]').first().click();
    ok(label + ' pointer selection retains exact NPC prefix and number', await first.evaluate(node => {
      const paragraph = node.querySelector('[data-director-paragraph]'); return paragraph.getAttribute('aria-pressed') === 'true' && paragraph.dataset.selectionOrder === '1' && collectDirectorSelectedText()[0] === '【韩立】' + plan.npc_updates[0].current_goal;
    }));
    await character.locator('summary').focus(); await page.keyboard.press('Enter');
    await character.locator('[data-director-paragraph]').first().focus(); await page.keyboard.press('Space');
    ok(label + ' character keyboard selection updates its existing header marker', await character.evaluate(node => node.querySelector('.sd-selection-order-card').textContent === '2' && collectDirectorSelectedText()[1] === plan.character_dynamics[0].content));
    await first.locator('[data-director-paragraph]').first().focus(); await page.keyboard.press('Enter');
    ok(label + ' deselection renumbers remaining selection without changing prose', await character.evaluate(node => node.querySelector('.sd-selection-order-card').textContent === '1' && collectDirectorSelectedText().length === 1 && collectDirectorSelectedText()[0] === plan.character_dynamics[0].content));
    await character.locator('[data-director-paragraph]').first().focus(); await page.keyboard.press('Space');
    await character.locator('summary').focus(); await page.keyboard.press('Enter');
    await first.locator('summary').focus(); await page.keyboard.press('Enter');
    ok(label + ' keyboard collapse and cleared selection remain intact', await first.evaluate(node => !node.open && injectSelection.size === 0));
    const media = page.locator('.sd-item-npc .sd-world-media-entry');
    await media.scrollIntoViewIfNeeded(); await media.focus();
    ok(label + ' media action stays focusable and unobscured', await media.evaluate(node => {
      const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return !node.disabled && document.activeElement === node && (hit === node || node.contains(hit));
    }));
    ok(label + ' media keyboard focus is visible without restoring a background frame', await media.evaluate(node => getComputedStyle(node).outlineStyle === 'solid' && parseFloat(getComputedStyle(node).outlineWidth) === 2 && isUnboxed(node)));
    await media.click();
    ok(label + ' actual media click hands off existing image without toggling fold', await media.evaluate(node => !node.closest('details').open && mediaCalls.length === 1 && mediaCalls[0].action === 'lightbox' && mediaCalls[0].id === 'fixture-image'));
    await page.evaluate(() => { fixtureMediaRecords = []; });
    await media.focus(); await page.keyboard.press('Enter');
    ok(label + ' actual media keyboard event preserves creation handoff only', await media.evaluate(node => !node.closest('details').open && mediaCalls.length === 2 && mediaCalls[1].action === 'generation-handoff' && mediaCalls[1].id === 'fixture-packet'));
    ok(label + ' neutral relationship fill retains colored semantics', await page.locator('.sd-relus-tone').evaluateAll(nodes => {
      const styles = nodes.map(node => getComputedStyle(node)); return nodes.length === 3 && styles.every(style => style.backgroundColor !== 'rgba(0, 0, 0, 0)') && new Set(styles.map(style => style.color)).size === 3;
    }));
    ok(label + ' relationship text stays bounded', await page.locator('.sd-relus-row,.sd-relus-tone').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
    if (width === 393 || family === 'glass') await page.locator('.sd-body').screenshot({ animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-${width}.png`, qa)) });
    if (family === 'glass' && ((mode === 'light' && width === 393) || (mode === 'dark' && width === 320))) {
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      const clip = await page.locator('.sd-plan-section').evaluateAll(nodes => {
        const rects = nodes.slice(0, 2).map(node => node.getBoundingClientRect());
        const x = Math.min(...rects.map(rect => rect.left)), y = rects[0].top;
        return { x, y, width: Math.max(...rects.map(rect => rect.right)) - x, height: rects[1].bottom - y };
      });
      await page.screenshot({ animations: 'disabled', clip, path: fileURLToPath(new URL(`roster-${mode}-${width}.png`, qa)) });
    }
    if (family !== 'classic' && width === 393) {
      let prior = await page.locator('.sd-item-npc').first().evaluate(node => ({ number: getComputedStyle(node.querySelector('.sd-npc-index')).backgroundImage, role: getComputedStyle(node.querySelector('.sd-npc-role')).backgroundColor }));
      for (const accent of ['#b34168', '#27856a']) {
        await page.evaluate(accent => applyAccent(accent), accent);
        const next = await page.locator('.sd-item-npc').first().evaluate(node => ({ number: getComputedStyle(node.querySelector('.sd-npc-index')).backgroundImage, role: getComputedStyle(node.querySelector('.sd-npc-role')).backgroundColor }));
        ok(label + ` live accent ${accent} recolors both numerals and role without rerender`, next.number !== prior.number && next.role !== prior.role);
        prior = next;
      }
      await page.evaluate(() => applyAccent('#5c79d3'));
    }

    await page.evaluate(async ({ family, mode }) => {
      window.savedNpcFixture = plan.npc_updates; window.savedCharacterFixture = plan.character_dynamics;
      plan.character_dynamics = [
        { name: '安德烈亚·冯·罗森伯格与夜班资料室联合调查员', title: '较长角色名的生活片段', emotional_state: '仍在耐心地核对每一份资料，不想错过那条尚未证实的线索。', content: '保持完整的角色身份。', inject_prompt: '他再次核对尚未证实的线索。' },
        { title: '没有情绪的旧片段', emotional_state: '  ', content: '原有片段仍可阅读。' },
      ];
      plan.npc_updates = [
        { id: 'long', name: '安德烈亚·冯·罗森伯格', role: '跨区域联合资料复核负责人，负责登记全部资料并联系下一班交接人员，来源编号 LongUnbrokenReferenceWithoutWhitespace0123456789', emotional_state: '谨慎核对全部记录，保持现场交接秩序，即使在很窄的屏幕中也必须完整展示这段状态，不得以省略号替代原文。', content: '原文保持可读。' },
        { id: 'bare', name: '无名旅人', emotional_state: '  ', role: null, content: '缺少定位与情绪的旧条目。' },
        { id: 'role-only', name: '仅有定位', role: '夜班值守', content: '没有情绪的旧条目。' },
        { id: 'emotion-only', name: '仅有情绪', emotional_state: '谨慎', content: '没有定位的旧条目。' },
      ];
      directorWorldEntryLinks.set('npc_updates:0', directorWorldEntryLinks.get('npc_updates:1'));
      directorWorldEntryLinks.delete('npc_updates:1');
      await renderFixture(family, mode);
    }, { family, mode });
    ok(label + ' long names and fields wrap without clipping or truncation', await page.locator('.sd-item-npc').evaluateAll(nodes => nodes.length === 4 && nodes.every((node, index) => node.querySelector('h4').textContent === plan.npc_updates[index].name
      && (node.querySelector('.sd-npc-role')?.textContent || '') === String(plan.npc_updates[index].role || '').trim()
      && (node.querySelector('.sd-npc-emotion')?.textContent || '') === String(plan.npc_updates[index].emotional_state || '').trim()
      && [node, ...node.querySelectorAll('.sd-npc-heading,h4,.sd-npc-role,.sd-item-emotion')].every(part => part.scrollWidth <= part.clientWidth + 1 && part.scrollHeight <= part.clientHeight + 1))));
    ok(label + ' missing NPC fields reserve no placeholder row', await page.locator('.sd-item-npc').evaluateAll(nodes => {
      const bare = nodes[1].querySelector('.sd-npc-heading'), roleOnly = nodes[2].querySelector('.sd-npc-heading'), moodOnly = nodes[3].querySelector('.sd-npc-heading');
      return bare.children.length === 1 && bare.firstElementChild.classList.contains('sd-npc-name-row') && Math.abs(bare.getBoundingClientRect().top - bare.firstElementChild.getBoundingClientRect().top) < 1
        && roleOnly.children.length === 2 && roleOnly.firstElementChild.classList.contains('sd-npc-role-row') && !roleOnly.querySelector('.sd-item-emotion')
        && moodOnly.children.length === 1 && moodOnly.firstElementChild.classList.contains('sd-npc-name-row') && !moodOnly.querySelector('.sd-npc-role');
    }));
    const longMedia = page.locator('.sd-item-npc').first().locator('.sd-world-media-entry');
    await longMedia.scrollIntoViewIfNeeded(); await longMedia.focus();
    ok(label + ' long role leaves its adjacent media action reachable and non-overlapping', await longMedia.evaluate(node => {
      const button = node.getBoundingClientRect(), row = node.closest('.sd-npc-role-row'), role = row.querySelector('.sd-npc-role').getBoundingClientRect();
      const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
      return role.right <= button.left && button.right <= row.getBoundingClientRect().right + 1 && row.scrollWidth <= row.clientWidth + 1 && document.activeElement === node && (hit === node || node.contains(hit));
    }));
    ok(label + ' missing character emotion leaves no empty heading row', await page.locator('.sd-item-character').nth(1).evaluate(node => {
      const main = node.querySelector('.sd-item-summary-main'); return !main.querySelector('.sd-item-emotion,.sd-mini-chip-row') && main.children.length === 1 && Math.abs(main.getBoundingClientRect().top - main.querySelector('h4').getBoundingClientRect().top) < 1;
    }));
    ok(label + ' long character title stays bounded while historical emotion stays absent', await page.locator('[data-acc="castfold-character"]').evaluate(node => {
      const summary = node.querySelector(':scope > summary'); return summary.textContent === '此间一人 · ' + plan.character_dynamics[0].name && summary.scrollWidth <= summary.clientWidth + 1 && !node.querySelector('.sd-item-emotion') && !node.textContent.includes(plan.character_dynamics[0].emotional_state);
    }));
    ok(label + ' read-only entries retain content but no selection/media actions', await page.evaluate(() => {
      const wrapper = document.createElement('div'); wrapper.innerHTML = renderItemCard(plan.npc_updates[0], 'npc', 0, true);
      return wrapper.querySelector('details').open && wrapper.querySelector('.sd-npc-index').textContent === '01' && wrapper.querySelector('.sd-director-paragraph p').textContent === plan.npc_updates[0].content && !wrapper.querySelector('[data-director-paragraph],.sd-world-media-entry');
    }));
    const longCharacter = page.locator('.sd-item-character').first();
    await longCharacter.locator('summary').focus(); await page.keyboard.press('Enter');
    await longCharacter.locator('[data-director-paragraph]').nth(0).focus(); await page.keyboard.press('Space');
    await longCharacter.locator('[data-director-paragraph]').nth(1).focus(); await page.keyboard.press('Space');
    const selectedGeometry = await longCharacter.evaluate(node => {
      const badge = node.querySelector('.sd-selection-order-card'), rect = badge.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(node.querySelector('h4'));
      const overlap = [...range.getClientRects()].some(text => text.left < rect.right && text.right > rect.left && text.top < rect.bottom && text.bottom > rect.top);
      return { text: badge.textContent, overlap, badge: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, title: [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })) };
    });
    ok(label + ' title does not overlap selected passage numbers: ' + JSON.stringify(selectedGeometry), selectedGeometry.text === '1、2' && !selectedGeometry.overlap);
    if (family === 'glass' && width === 320) await page.locator('.sd-body').screenshot({ animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-long-fields-${width}.png`, qa)) });
    await page.evaluate(async ({ family, mode }) => {
      directorWorldEntryLinks.set('npc_updates:1', { ...directorWorldEntryLinks.get('npc_updates:0'), records: [] });
      await renderFixture(family, mode); fixtureMediaRecords = [];
    }, { family, mode });
    const rolelessMedia = page.locator('.sd-item-npc').nth(1).locator('.sd-world-media-entry');
    await rolelessMedia.scrollIntoViewIfNeeded(); await rolelessMedia.focus();
    ok(label + ' absent role does not hide an unboxed zero-count action', await rolelessMedia.evaluate(node => {
      const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !node.closest('.sd-npc-heading').querySelector('.sd-npc-role') && !node.querySelector('span') && node.getAttribute('aria-label') === '造物之眼 · 核对并创作'
        && rect.width >= 24 && rect.height >= 24 && isUnboxed(node) && document.activeElement === node && (hit === node || node.contains(hit));
    }));
    await page.keyboard.press('Space');
    ok(label + ' roleless action preserves keyboard creation handoff without toggling the card', await rolelessMedia.evaluate(node => !node.closest('details').open && mediaCalls.length === 1 && mediaCalls[0].action === 'generation-handoff' && mediaCalls[0].id === 'fixture-packet'));
    await page.evaluate(() => { plan.npc_updates = savedNpcFixture; plan.character_dynamics = savedCharacterFixture; directorWorldEntryLinks.set('npc_updates:1', directorWorldEntryLinks.get('npc_updates:0')); directorWorldEntryLinks.delete('npc_updates:0'); });
  }
  const metadataBounds = [];
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 360, 375, 393, 430, 1100]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(async ({ family, mode }) => {
      window.savedNpcFixture = plan.npc_updates;
      plan.npc_updates = ['韩立', '赵德海', '长孙无忌'].map((name, index) => ({ name, role: '跨区域联合资料登记夜班交接负责人', emotional_state: '心存疑虑仍耐心等对方把事情原委讲清楚', content: '旧内容保持原样。', id: 'boundary-' + index }));
      await renderFixture(family, mode);
    }, { family, mode });
    const bounds = await page.locator('.sd-item-npc').evaluateAll(nodes => nodes.map(node => {
      const row = node.querySelector('.sd-npc-name-row'), name = row.querySelector('h4'), emotion = row.querySelector('.sd-npc-emotion');
      const r = row.getBoundingClientRect(), n = name.getBoundingClientRect(), e = emotion.getBoundingClientRect();
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'), ns = getComputedStyle(name), es = getComputedStyle(emotion);
      ctx.font = `${ns.fontWeight} ${ns.fontSize} ${ns.fontFamily}`; const nameWidth = ctx.measureText(name.textContent).width;
      ctx.font = `${es.fontWeight} ${es.fontSize} ${es.fontFamily}`; const emotionWidth = ctx.measureText(emotion.textContent).width;
      const expectedInline = nameWidth + emotionWidth + parseFloat(getComputedStyle(row).columnGap) <= r.width + .5;
      return { name: name.textContent, nameWidth, emotionWidth, available: r.width, expectedInline, inline: e.top < n.bottom - 1,
        separateRow: e.top >= n.bottom - 1 && Math.abs(e.left - r.left) <= 1, emotionLines: Math.round(e.height / parseFloat(es.lineHeight)),
        bounded: [node, row, name, emotion].every(part => part.scrollWidth <= part.clientWidth + 1 && part.scrollHeight <= part.clientHeight + 1),
        intact: emotion.textContent === '心存疑虑仍耐心等对方把事情原委讲清楚' && [...emotion.textContent].length === 18 && [...node.querySelector('.sd-npc-role').textContent].length === 16, caption: es.fontSize };
    }));
    ok(`${family}/${mode}/${width} 18-character emotion stays intact and moves as a whole when necessary: ` + JSON.stringify(bounds), bounds.every(item => item.bounded && item.intact && (item.expectedInline ? item.inline && item.emotionLines === 1 : item.separateRow)));
    metadataBounds.push({ family, mode, width, bounds });
    if (family === 'glass' && mode === 'light' && [375, 393].includes(width)) await page.locator('[data-acc="castfold-npc"]').screenshot({ animations: 'disabled', path: fileURLToPath(new URL(`metadata-boundary-${width}.png`, qa)) });
    await page.evaluate(() => { plan.npc_updates = savedNpcFixture; });
  }
  console.log(JSON.stringify({ metadataBounds: metadataBounds.filter(item => item.family === 'glass' && item.mode === 'light') }));
  for (const family of ['editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
    const label = `selected/${family}/${mode}/${width}`;
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(async ({ family, mode }) => {
      await renderFixture(family, mode);
      Object.assign(settings, { newcomerMode: false, floatingButton: false, quickWheelEnabled: false,
        quickWheelCustomExpanded: true, quickWheelCustomOrder: QUICK_COMMAND_IDS.slice(0, 3), quickWheelCustomEnabled: [QUICK_COMMAND_IDS[0]], logHistory: [] });
      fixtureSaves = 0; renderControlsFixture();
    }, { family, mode });
    const newcomer = page.locator('.sd-newcomer-toggle');
    const offFill = await newcomer.evaluate(node => getComputedStyle(node).backgroundColor);
    await newcomer.click();
    const selectedPaint = async locator => locator.evaluate(async node => {
      getComputedStyle(node).backgroundColor;
      await Promise.all(node.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      const style = getComputedStyle(node), rgba = colorBytes(style.backgroundColor);
      return { pressed: node.getAttribute('aria-pressed'), active: node.classList.contains('active'), opaque: rgba[3] === 255,
        primary: rgba.join(',') === colorBytes(style.getPropertyValue('--sd-primary')).join(','), contrast: colorContrast(style.color, style.backgroundColor), fill: style.backgroundColor };
    });
    const onNewcomer = await selectedPaint(newcomer);
    ok(label + ' real newcomer click yields an opaque contrast-paired selected state: ' + JSON.stringify(onNewcomer), onNewcomer.pressed === 'true' && onNewcomer.active && onNewcomer.opaque && onNewcomer.primary && onNewcomer.contrast >= 4.5 && onNewcomer.fill !== offFill);
    await newcomer.focus(); await page.keyboard.press('Space');
    ok(label + ' newcomer keyboard toggle restores its unselected state', await newcomer.evaluate(node => node.getAttribute('aria-pressed') === 'false' && !node.classList.contains('active')));
    await newcomer.click();
    for (const id of ['floating', 'wheel']) {
      const toggle = page.locator(`[data-widget-toggle="${id}"]`), before = await toggle.evaluate(node => getComputedStyle(node).backgroundColor);
      await toggle.click();
      const paint = await selectedPaint(page.locator(`[data-widget-toggle="${id}"]`));
      ok(label + ` actual ${id} enable action rerenders as opaque selected: ` + JSON.stringify(paint), paint.pressed === 'true' && paint.active && paint.opaque && paint.primary && paint.contrast >= 4.5 && paint.fill !== before);
    }
    const enabledChoice = page.locator('.sd-wheel-command-toggle.active').first(), offChoice = page.locator('.sd-wheel-command-toggle:not(.active)').first();
    const initialChoicePaint = await selectedPaint(enabledChoice), offChoiceFill = await offChoice.evaluate(node => getComputedStyle(node).backgroundColor);
    ok(label + ' hive selected entries are visibly filled rather than translucent', initialChoicePaint.opaque && initialChoicePaint.primary && initialChoicePaint.contrast >= 4.5 && initialChoicePaint.fill !== offChoiceFill);
    const choiceId = await offChoice.getAttribute('data-command');
    await offChoice.focus(); await page.keyboard.press('Enter');
    const selectedChoice = page.locator(`.sd-wheel-command-toggle[data-command="${choiceId}"]`), newChoicePaint = await selectedPaint(selectedChoice);
    ok(label + ' actual hive keyboard action updates selected state and fill', newChoicePaint.pressed === 'true' && newChoicePaint.active && newChoicePaint.primary && newChoicePaint.opaque);
    await selectedChoice.click();
    ok(label + ' hive deselection returns to the off appearance', await selectedChoice.evaluate(async (node, before) => {
      getComputedStyle(node).backgroundColor;
      await Promise.all(node.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      return node.getAttribute('aria-pressed') === 'false' && !node.classList.contains('active') && getComputedStyle(node).backgroundColor === before;
    }, offChoiceFill));
    ok(label + ' action controls stay inside narrow layouts', await page.locator('.sd-button-row,.sd-widget-toggle-row,.sd-wheel-custom-list,button').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
    if (width === 393) {
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await page.locator('.sd-body').screenshot({ animations: 'disabled', path: fileURLToPath(new URL(`selected-${family}-${mode}-393.png`, qa)) });
    }
  }
  assert.deepEqual(errors, []); assert.equal(external, 0, JSON.stringify(blocked));
  console.log(JSON.stringify({ passed: checks.length, errors, external, scope: 'actual NPC/character rendering, disclosure/selection/media handoffs; 3 themes x 2 modes x 320/393/1100 plus whole-emotion wrapping at 360/375/430; live accent and actual newcomer/widget/hive toggles; no host state, writes or generation' }));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
