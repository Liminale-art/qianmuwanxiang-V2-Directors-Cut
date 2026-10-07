// Isolated headless renderer QA: synthetic story/settings only, no ST or provider access.
// All requests are fulfilled from this repository or blocked. No persistent browser profile.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const skin = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(entry);
  assert.ok(match, `Missing actual renderer ${name}`);
  const tail = entry.slice(match.index), end = tail.slice(1).search(/^(?:async )?function /m);
  return end < 0 ? tail : tail.slice(0, end + 1);
}
function between(startText, endText) {
  const start = entry.indexOf(startText), end = entry.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `Missing actual event block ${startText}`);
  return entry.slice(start, end);
}
const renderers = ['directorDisplayPlan', 'renderDashboardTab', 'renderDirectorMemoryReview', 'bindDirectorMemoryReview', 'renderDirectorExtraCard', 'renderChainReactionsCard', 'renderTasksNodesTab',
  'renderCastWorldFront', 'renderPlanSectionFold', 'renderRelationUndercurrentsCard', 'renderWorldChatterCard',
  'renderNoPlan', 'renderItemList', 'renderItemCard', 'renderItemChips', 'renderInjectBadge', 'renderInjectDock',
  'renderHeroActions', 'renderGenerateRow', 'renderHistorySection', 'renderInjectSections', 'renderDirectorSettingsTab']
  .map(section).join('\n');
const switchEvents = between("  root.querySelector('.sd-parallel-scene-enabled')?.addEventListener", "  root.querySelector('.sd-geopolitics-enabled')?.addEventListener");
const draftEvents = between("  root.querySelectorAll('.sd-inject').forEach", '  // 写入勾选持久化');
const assets = new Set(['qianmu-theme-surfaces.js', 'qianmu-theme-palette.js', 'qianmu-icon-renderer.js',
  'qianmu-storyboard-utils.js', 'qianmu-main-tabs.js', 'qianmu-director-live.js', 'qianmu-text-collection-floor.css']);
const origin = 'https://qianmu.test';
const checks = [], failures = [], screenshots = [], pageErrors = [], blocked = [];
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 393, height: 900 }, serviceWorkers: 'block' });
context.setDefaultTimeout(5000);
await context.route('**/*', async route => {
  const url = new URL(route.request().url()), file = url.pathname.slice(1);
  if (url.origin === origin && url.pathname === '/') {
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
  }
  if (url.origin === origin && assets.has(file)) {
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
  }
  blocked.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.on('pageerror', error => pageErrors.push(error.message));
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
function check(value, label, detail) {
  if (value) checks.push(label);
  else failures.push({ label, ...(detail ? { detail } : {}) });
}

try {
  await page.goto(origin);
  await page.addStyleTag({ content: css });
  await page.addStyleTag({ content: skin });
  await page.evaluate(async ({ renderers, switchEvents, draftEvents }) => {
    Object.assign(window, await import('/qianmu-storyboard-utils.js'), await import('/qianmu-main-tabs.js'), await import('/qianmu-director-live.js'));
    const theme = await import('/qianmu-theme-surfaces.js'), icons = await import('/qianmu-icon-renderer.js');
    const long = '他将交接记录重新对照，发现同一件事在两位同事的描述里有不同的侧重。'.repeat(16)
      + '\n' + 'long_unbroken_reference_'.repeat(18);
    window.plan = {
      story_status: { title: '合成测试：傍晚的交接', current_arc: '一封尚未送达的信', current_stage: '整理记录', mood: '平静而有所牵挂' },
      quests: [{ title: '门前的来客', description: long, trigger: '门口的邮差还在等一个熟悉地址的人。',
        priority: 'old-priority', reward: 'old-reward', inject_prompt: '邮差带着未送达的信来到门前。' }],
      character_dynamics: [{ title: '留在桌边的两份记录', content: long }],
      npc_updates: [{ name: '林芷', role: '同事', content: '她决定先向收件人核对日期，而不是照着旧表格作结论。' }],
      chain_reactions: [{ spark: '旧桥暂停通行', chain: long }],
      relation_undercurrents: [{ parties: '同事与值班员', tone: '中立', tension: '两人都记得那次迟到，却对迟到的原因保持了不同理解。', user_awareness: 'rumor' }],
      parallel_scene: { title: '如果他多留了一刻', content: long },
      interlude: { type: 'phone', owner: '林芷', title: '一条被补充的消息', content: '林芷：替你留了靠窗的位置。\n同事：我今天值班。\n林芷：那给你的本子留着。\n\n' + long },
      world_chatter: [{ who: '送信的人', where: '街口', text: '今晚这条路不用绕远了。' }],
    };
    window.baseSettings = { parallelSceneEnabled: true, interludeEnabled: true, worldChatterEnabled: true, geopoliticsEnabled: true,
      injectEnabled: false, injectDepth: 2, autoRefresh: false, autoRefreshEvery: 10 };
    window.qaChat = []; window.qaStore = { history: [] };
    window.qaMemoryText = '【已保存的故事记忆】\n<script>这里只是原文</script>\n' + long;
    Object.assign(window, {
      settings: structuredClone(baseSettings), directorMemoryInspection: null, directorLiveLog: null, busy: false, editorView: null, worldPage: 'front', chatterExpanded: true,
      injectSelection: new Map(), saveCalls: [], toastMessages: [], draftCalls: [], qaCloseCalls: 0,
      currentPlan: () => plan, getChatStore: () => qaStore, ctx: () => ({ chat: qaChat }), getChatKey: () => 'isolated-chat', getContextItemId: item => item.title || item.name || 'fixture',
      renderDirectorWorldEntryLink: () => '', renderInjectPreview: () => '', renderBackstageBlueprintCard: () => '',
      DEFAULT_SYSTEM_PROMPT: '合成设置，不发送', JSON_SCHEMA_TEXT: '{}',
      saveSettings: () => saveCalls.push(structuredClone(settings)), toast: text => toastMessages.push(text),
      injectToInput: text => { draftCalls.push(text); return true; }, closeModal: () => { qaCloseCalls++; },
    });
    (0, eval)(renderers);
    const bindSwitches = new Function('root', switchEvents), bindDraft = new Function('root', draftEvents);
    window.mount = (view, themeName) => {
      window.controller?.dispose();
      window.activeTab = view;
      window.directorMemoryInspection = { ownerSettings: settings, chat: qaChat, store: qaStore, key: 'isolated-chat',
        log: { time: '2026/10/7 15:00:00', status: 'success', request: JSON.stringify([{ role: 'system', content: '' }, { role: 'user', content: qaMemoryText }]) },
        snapshot: { start: 0, length: qaMemoryText.length, status: 'ready', production: 'layered', summaryMode: 'mixed' } };
      settings.logHistory = [directorMemoryInspection.log];
      const content = ({ dashboard: renderDashboardTab, tasksnodes: renderTasksNodesTab, castworld: renderCastWorldFront, settings: renderDirectorSettingsTab })[view]();
      const tabs = [['dashboard', '审片'], ['tasksnodes', '际遇'], ['castworld', '世界'], ['context', '取材'],
        ['settings', '幕后'], ['theater', '幕外'], ['tts', '配音'], ['focus', '专注']];
      document.body.innerHTML = `<button id="host-control" style="font:17px serif;background:rgb(30,40,50);color:rgb(220,230,240)">宿主测试按钮</button>
        <div id="story-director-modal" class="sd-theme-light open"><div class="sd-backdrop"></div><section class="sd-window" role="dialog" aria-label="千幕">
        <header class="sd-header"><div class="sd-titlebox"><h2>千幕</h2></div></header>${renderQianmuMainTabs(tabs, view)}
        ${view === 'castworld' ? '<div class="sd-world-viewport">' : ''}<main class="sd-body">${['castworld', 'tasksnodes'].includes(view) ? `<div class="sd-cols-inner">${content}</div>` : content}</main>${view === 'castworld' ? '</div>' : ''}
        ${renderInjectDock()}</section></div>`;
      const root = document.getElementById('story-director-modal');
      bindDirectorMemoryReview(root);
      icons.applyQianmuIcons(root);
      window.controller = theme.createQianmuThemeSurfaceController(); controller.register(root);
      controller.setTheme(themeName === 'classic' ? null : { theme: themeName, mode: 'light', accent: '#4a618f' });
      sizeQianmuTabs(root.querySelector('.sd-tabs'));
      bindSwitches(root); bindDraft(root);
    };
  }, { renderers, switchEvents, draftEvents });

  for (const width of [320, 393, 1280]) for (const theme of ['classic', 'editorial', 'glass']) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ['dashboard', 'tasksnodes', 'castworld', 'settings']) {
      await page.evaluate(({ view, theme }) => { settings = structuredClone(baseSettings); mount(view, theme); }, { view, theme });
      await frame();
      if (view === 'dashboard') {
        const review = page.locator('[data-director-memory-review]');
        check(await review.locator('details').getAttribute('open') === null, `${theme}/${width}: memory review starts collapsed`);
        await review.locator('summary').click();
        check(await review.locator('.sd-memory-review-text').textContent() === await page.evaluate(() => qaMemoryText), `${theme}/${width}: exact escaped memory text`);
        check(await review.locator('script,button,input,textarea').count() === 0, `${theme}/${width}: memory review has no executable content or write action`);
        check(await page.locator('.sd-body > :last-child').getAttribute('data-director-memory-review') !== null, `${theme}/${width}: memory review is last`);
      }
      if (view === 'tasksnodes' || view === 'castworld') {
        const summary = page.locator('.sd-item-card > summary').first();
        await summary.click();
        check(await page.locator('.sd-item-card').first().getAttribute('open') !== null, `${theme}/${width}/${view}: real summary expands`);
        await page.locator('.sd-item-card .sd-inject').first().click();
        check(await page.evaluate(() => draftCalls.at(-1)?.length > 0), `${theme}/${width}/${view}: explicit action writes only a synthetic draft`);
      }
      const result = await page.evaluate(() => {
        const root = document.getElementById('story-director-modal'), win = root.querySelector('.sd-window'), body = root.querySelector('.sd-body');
        const box = win.getBoundingClientRect();
        const overflow = [...root.querySelectorAll('.sd-body,.sd-cols-inner,.sd-card,.sd-item-detail,.sd-director-extra-content,.sd-director-narrative,.sd-chain-node,.sd-memory-review-text')]
          .filter(node => node.getClientRects().length && getComputedStyle(node).display !== 'none')
          .map(node => ({ className: node.className, delta: node.scrollWidth - node.clientWidth,
            right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left }))
          .filter(item => item.delta > 2 || item.right > box.right + 2 || item.left < box.left - 2);
        const first = root.querySelector('.sd-director-extra-content,.sd-director-narrative,.sd-derivative-options');
        const hostStyle = getComputedStyle(document.getElementById('host-control'));
        return { overflow, pageOverflow: document.documentElement.scrollWidth - innerWidth, bodyWidth: body.clientWidth,
          windowInside: box.left >= -1 && box.right <= innerWidth + 1,
          bodyText: body.textContent, firstVisible: first?.getClientRects().length > 0,
          font: first ? getComputedStyle(first).fontFamily : '', color: first ? getComputedStyle(first).color : '',
          expectedColor: getComputedStyle(root).getPropertyValue('--sd-text').trim(),
          host: [hostStyle.fontSize, hostStyle.fontFamily, hostStyle.color, hostStyle.backgroundColor],
          extraActions: root.querySelectorAll('.sd-director-extra-card button,.sd-director-extra-card input,.sd-director-extra-card .sd-world-media-entry').length,
          extras: root.querySelectorAll('.sd-director-extra-card').length };
      });
      const key = `${theme}/${width}/${view}`;
      check(result.windowInside && result.pageOverflow <= 2 && result.overflow.length === 0, `${key}: no horizontal overflow`, result);
      check(result.firstVisible && result.bodyWidth > 200, `${key}: usable content area`);
      check(JSON.stringify(result.host) === JSON.stringify(['17px', 'serif', 'rgb(220, 230, 240)', 'rgb(30, 40, 50)']), `${key}: host typography and colors unchanged`, result.host);
      if (theme === 'glass') check(result.font.startsWith('"Sarasa Gothic SC"') && result.font.includes('Qianmu Glass Local Heiti'), `${key}: minimal theme uses Sarasa with local fallback`);
      if (view === 'dashboard') {
        check(result.extras === 2 && result.extraActions === 0, `${key}: two independent read-only cards`);
        check(result.bodyText.includes('未映之幕') && result.bodyText.includes('幕间拾趣') && !result.bodyText.includes('众声'), `${key}: current review sections`);
      }
      if (view === 'tasksnodes') check(!/old-priority|old-reward|奖励|收获|优先级/.test(result.bodyText), `${key}: encounters are not task/reward tables`);
      if (view === 'castworld') check(result.bodyText.includes('此间一人') && result.bodyText.includes('其他人物动向'), `${key}: distinct character sections`);
      if (view === 'settings') {
        const before = await page.evaluate(() => saveCalls.length);
        for (const selector of ['.sd-parallel-scene-enabled', '.sd-interlude-enabled']) {
          await page.locator('label').filter({ has: page.locator(selector) }).click();
        }
        const off = await page.evaluate(() => ({ values: [settings.parallelSceneEnabled, settings.interludeEnabled], saves: saveCalls.length }));
        check(off.values.every(value => value === false) && off.saves === before + 2, `${key}: switches immediately save independently`);
        await page.evaluate(theme => mount('dashboard', theme), theme);
        check(await page.locator('.sd-director-extra-card').count() === 0, `${key}: disabled stored extras are hidden without regeneration`);
        await page.evaluate(theme => mount('settings', theme), theme);
        check(!await page.locator('.sd-parallel-scene-enabled').isChecked() && !await page.locator('.sd-interlude-enabled').isChecked(), `${key}: reopening retains saved switch state`);
        for (const selector of ['.sd-parallel-scene-enabled', '.sd-interlude-enabled']) await page.locator('label').filter({ has: page.locator(selector) }).click();
      }
      if (process.env.QIANMU_CREATIVE_QA_DIR && width === 393 && ['dashboard', 'castworld', 'settings'].includes(view)) {
        await mkdir(process.env.QIANMU_CREATIVE_QA_DIR, { recursive: true });
        await page.locator('.sd-body').evaluate(node => { node.scrollTop = 0; });
        const file = join(process.env.QIANMU_CREATIVE_QA_DIR, `creative_${theme}_${view}_${width}.png`);
        await page.screenshot({ path: file }); screenshots.push(file);
        if (view === 'dashboard') {
          const memoryFile = join(process.env.QIANMU_CREATIVE_QA_DIR, `memory_review_${theme}_${width}.png`);
          await page.locator('[data-director-memory-review]').screenshot({ path: memoryFile }); screenshots.push(memoryFile);
        }
      }
    }
  }
  const streamSources = ['refreshDirectorLiveUI', 'bindDirectorReadingEvents', 'renderCastWorldTab', 'applyAccState', 'renderLogEntry', 'renderLogDetail'].map(section).join('\n');
  const streaming = await page.evaluate(async ({ streamSources }) => {
    Object.assign(window, { MODAL_ID: 'story-director-modal', LOG_LIMIT: 5, accState: {},
      applyQianmuIcons: () => {}, renderModal: () => mount(activeTab, 'glass'),
      LOG_STATUS_LABELS: { loading: '生成中', success: '成功', error: '失败', cancelled: '已取消', none: '状态未知' },
      LOG_KIND_LABELS: { director: '推演', theater: '小剧场' }, infoTag: value => `<span>${htmlEscape(value)}</span>` });
    (0, eval)(streamSources);
    settings = structuredClone(baseSettings); busy = true;
    const raw = JSON.stringify({ story_status: { title: '独立的新一幕', summary: '已发生的新变化。' },
      quests: [{ title: '际遇专属', description: '邮差带来了退回的新信。' }],
      character_dynamics: [{ title: '角色专属', content: '同事已将调班签字递了过去。' }],
      chain_reactions: [{ spark: '涟漪专属', chain: '停运 → 改道' }],
      parallel_scene: { title: '番外专属', content: '另一种已展开的片刻。' } });
    directorLiveLog = { id: 'stream-qa', status: 'loading', response: raw.slice(0, -1), request: 'X'.repeat(1400000) };
    const old = JSON.stringify(plan), checks = {};
    for (const view of ['dashboard', 'tasksnodes', 'castworld']) {
      mount(view, 'glass');
      const root = document.getElementById(MODAL_ID), body = root.querySelector('.sd-body');
      const saved = body.innerHTML; body.innerHTML = `<div data-director-live-host>${saved}</div>`;
      const host = body.firstElementChild;
      refreshDirectorLiveUI();
      const text = host.textContent;
      checks[`${view}: correct field placement`] = view === 'dashboard' ? text.includes('番外专属') && !text.includes('际遇专属') && !text.includes('角色专属')
        : view === 'tasksnodes' ? text.includes('际遇专属') && text.includes('涟漪专属') && !text.includes('番外专属') && !text.includes('角色专属')
        : text.includes('角色专属') && !text.includes('际遇专属') && !text.includes('番外专属');
      checks[`${view}: no progress card or premature actions`] = !host.querySelector('.sd-director-live,.sd-select-inject,.sd-inject,.sd-world-media-entry') && !text.includes('正在接收回复');
      const first = host.firstElementChild;
      directorLiveLog.response += ' ';
      refreshDirectorLiveUI();
      checks[`${view}: incomplete delta keeps DOM and scroll`] = first === host.firstElementChild;
      if (view === 'castworld') {
        const shell = host.querySelector('.sd-world-flip-shell');
        directorLiveLog.response = JSON.stringify({ ...JSON.parse(raw), npc_updates: [{ name: '新闭合条目', content: '已经做出的另一项安排。' }] });
        refreshDirectorLiveUI();
        checks['world page shell retains edge and gesture ownership'] = shell === host.querySelector('.sd-world-flip-shell') && host.textContent.includes('新闭合条目');
      }
    }
    checks['preview never alters committed plan'] = JSON.stringify(plan) === old;
    directorLiveLog.status = 'error';
    refreshDirectorLiveUI();
    checks['failed background completion restores saved page'] = document.querySelector('.sd-body').textContent.includes('留在桌边的两份记录') && !document.querySelector('.sd-body').textContent.includes('新闭合条目');
    const log = { ...directorLiveLog, status: 'cancelled', error: '用户中断', completion: { interrupted: true, finishReason: 'length' } };
    directorLiveLog = null; directorMemoryInspection = null; settings.logHistory = [log]; settings.logOpenState = {};
    const root = document.getElementById(MODAL_ID); root.querySelector('.sd-body').innerHTML = renderLogEntry(log, 0);
    const entry = root.querySelector('.sd-log-entry'); applyAccState(root);
    checks['collapsed 1.4M-character request stays outside DOM'] = root.innerHTML.length < 15000 && !entry.querySelector('pre');
    entry.querySelector('summary').click(); await new Promise(resolve => setTimeout(resolve, 20));
    checks['explicit log open preserves entire original request'] = entry.querySelector('.sd-term-request')?.textContent === log.request;
    checks['interruption reason stays in failure panel'] = entry.querySelector('.sd-log-failure')?.textContent.includes('结束原因：length') && !entry.querySelector('.sd-log-diagnostics')?.textContent.includes('结束原因');
    entry.querySelector('summary').click(); await new Promise(resolve => setTimeout(resolve, 20));
    checks['closing log releases heavyweight DOM without deleting source'] = !entry.querySelector('pre') && log.request.length === 1400000;
    return checks;
  }, { streamSources });
  for (const [label, value] of Object.entries(streaming)) check(value, label);
  check(pageErrors.length === 0, 'no page errors', pageErrors);
  check(blocked.length === 0, 'no external or unlisted requests attempted', blocked);
  console.log(JSON.stringify({ passed: checks.length, matrix: { themes: ['classic', 'editorial', 'glass'], widths: [320, 393, 1280], views: ['dashboard', 'tasksnodes', 'castworld', 'settings'] }, failures, screenshots, blocked, pageErrors,
    scope: 'isolated headless browser, real renderers and CSS with synthetic story/settings; no ST deployment, user browser, model or provider access' }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
