// Real section renderers and skins, synthetic offline plans only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  const start = new RegExp(`^function ${name}\\(`, 'm').exec(entry)?.index;
  assert.notEqual(start, undefined, name);
  const tail = entry.slice(start), end = tail.slice(1).search(/^(?:async )?function /m);
  return end < 0 ? tail : tail.slice(0, end + 1);
}
const source = ['directorDisplayPlan', 'renderDirectorSectionNotice', 'renderDashboardTab', 'renderDirectorExtraCard', 'renderChainReactionsCard',
  'renderTasksNodesTab', 'renderCastWorldFront', 'renderWorldChatterCard', 'renderRelationUndercurrentsCard', 'renderPlanSectionFold', 'renderNoPlan',
  'renderItemList', 'directorItemParagraphs', 'directorSelectionOrder', 'renderDirectorParagraph', 'renderItemCard', 'renderItemChips',
  'renderHeroActions', 'renderInjectBadge', 'renderGenerateRow'].map(section).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), errors = [], blocked = [], checks = [];
const deadline = setTimeout(() => { void browser.close(); }, 60000);
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open"><section class="sd-window"><main class="sd-body"></main></section></div>` });
  if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.(js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
  if (url.origin === 'https://qianmu.test' && url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
  blocked.push(url.href); return route.abort();
});
try {
  await page.goto('https://qianmu.test/');
  await page.evaluate(async source => {
    Object.assign(window, await import('/qianmu-storyboard-utils.js'), await import('/qianmu-director-live.js'), await import('/qianmu-creative-social.js'));
    const { createQianmuAppearanceSession } = await import('/qianmu-appearance-session.js');
    const { updateAppearancePreferences } = await import('/qianmu-appearance-settings.js');
    const fields = ['story_status', 'quests', 'character_dynamics', 'npc_updates', 'chain_reactions', 'relation_undercurrents', 'parallel_scene', 'interlude', 'world_chatter'];
    const plan = { story_status: { directions: [{ horizon: 'near', title: '交班', content: '接班人核对新送来的记录本。' }] },
      quests: [{ subject: '值班员', title: '新交接', description: '送来一份需要双方核对的记录。' }],
      character_dynamics: [{ name: '陈晖与一段用于检验窄屏折行的完整姓名后缀', content: '把收据交给接班人。' }],
      npc_updates: [{ name: '韩立', role: '江北分局刑侦队副队长', emotional_state: '沉稳务实', content: '核对当天的值班排班。' }],
      chain_reactions: [{ spark: '临时封路', chain: '货车改道 → 仓库延迟收货 → 商店修改交货时间' }],
      relation_undercurrents: [{ parties: ['韩立', '乔苒'], tension: '两人正核对值班记录中不同的日期。' }],
      parallel_scene: { content: '旧友从空座旁抬起头。' },
      interlude: { type: 'phone', title: '值班群', owner: '韩立', conversation_kind: 'group', messages: [{ sender: '乔苒', content: '今天谁带钥匙？' }] },
      world_chatter: [{ who: '店主', text: '今天货车得从后巷进。' }] };
    const options = { parallelSceneEnabled: true, interludeEnabled: true, worldChatterEnabled: true };
    Object.assign(window, { settings: { ...options }, busy: false, chatterExpanded: true, directorLiveLog: null,
      currentPlan: () => plan, injectSelection: new Map(), getContextItemId: item => item.name || item.title || 'fixture',
      renderHistorySection: () => '', renderDirectorWorldEntryLink: () => { throw Error('read-only preview exposed media'); } });
    (0, eval)(source);
    const offlineAsset = () => ({ promise: Promise.resolve(true), cancel() {} });
    const appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: offlineAsset, loadFont: offlineAsset });
    appearance.mount(document.querySelector('#story-director-modal'));
    window.mountNoticeFixture = async ({ family, mode, status = 'error', view = 'all' }) => {
      settings.theme = mode; settings.appearance = updateAppearancePreferences(settings, { family, mode });
      document.querySelector('#story-director-modal').className = `open sd-theme-${mode}`; await appearance.sync();
      directorLiveLog = status === 'success' ? null : { status, request: 'offline', response: JSON.stringify(plan), creativeOptions: options,
        quality: { issues: fields.map(field => ({ field, missing: 1 })) } };
      // Successful output has its own normal actions, not this read-only fixture.
      if (status === 'success') renderDirectorWorldEntryLink = () => '';
      document.querySelector('.sd-body').innerHTML = view === 'world' ? renderCastWorldFront() : renderDashboardTab() + renderTasksNodesTab() + renderCastWorldFront();
      const notices = [...document.querySelectorAll('.sd-director-section-notice')];
      return {
        count: notices.length,
        positions: notices.map(node => {
          const row = node.parentElement, rect = node.getBoundingClientRect(), bounds = row.getBoundingClientRect();
          const overlap = [...row.children].filter(other => other !== node).some(other => {
            const r = other.getBoundingClientRect(); return Math.min(rect.right, r.right) > Math.max(rect.left, r.left) + 1 && Math.min(rect.bottom, r.bottom) > Math.max(rect.top, r.top) + 1;
          });
          return { field: node.dataset.directorSectionStatus, correct: node.textContent === '本幕返回不完整' && row.classList.contains('sd-director-notice-row'),
            right: Math.abs(rect.right - bounds.right) < 2, inside: rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1, overlap,
            small: parseFloat(getComputedStyle(node).fontSize) < parseFloat(getComputedStyle(row.querySelector('h3,b')).fontSize) };
        }),
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        bodyNotices: document.querySelectorAll('.sd-fold-body > .sd-director-section-notice').length,
      };
    };
  }, source);
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    for (const status of ['error', 'cancelled', 'success']) {
      const result = await page.evaluate(options => mountNoticeFixture(options), { family, mode, status });
      const label = `${family}/${mode}/${width}/${status}`;
      assert.equal(result.count, status === 'error' ? 9 : 0, label); checks.push(label + ': correct scope');
      assert.equal(result.bodyNotices, 0, label); assert.equal(result.overflow, false, label); checks.push(label + ': no body notices or overflow');
      for (const item of result.positions) { assert.ok(item.correct && item.right && item.inside && !item.overlap && item.small, label + ':' + JSON.stringify(item)); checks.push(label + ':' + item.field); }
    }
  }
  await page.setViewportSize({ width: 393, height: 1100 });
  await page.evaluate(() => mountNoticeFixture({ family: 'glass', mode: 'light', view: 'world' }));
  const folded = await page.evaluate(() => {
    const notice = document.querySelector('.sd-plain-fold > summary .sd-director-section-notice');
    const summary = notice.closest('summary'), fold = summary.parentElement; summary.click();
    return !fold.open && notice.getBoundingClientRect().height > 0;
  });
  assert.ok(folded); checks.push('folded card keeps its notice readable in the header');
  await page.evaluate(() => document.querySelector('.sd-plain-fold').open = true);
  if (process.env.QIANMU_NOTICE_SCREENSHOT) await page.screenshot({ path: process.env.QIANMU_NOTICE_SCREENSHOT });
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ passed: checks.length, errors, external: blocked.length }, null, 2));
} finally { clearTimeout(deadline); await browser.close(); }
