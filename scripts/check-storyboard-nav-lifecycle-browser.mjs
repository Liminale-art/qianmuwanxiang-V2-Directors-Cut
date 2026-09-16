// Execute the real modal renderer, route/scroll functions and route-binding block.
// Non-routing host services and library contents are isolated stubs; no providers run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createStoryboardFormFixture, storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const bindingStart = entry.indexOf('  bindQianmuStoryboardNavigation(root, (button) => {');
const bindingEnd = entry.indexOf("  root.querySelectorAll('[data-storyboard-gallery-kind]')", bindingStart);
assert.ok(bindingStart > 0 && bindingEnd > bindingStart);
const binding = entry.slice(bindingStart, bindingEnd);
const names = ['renderModal', 'storyboardNavigate', 'storyboardApplyRoute', 'storyboardPageKey', 'storyboardScroller',
  'storyboardRememberPageScroll', 'storyboardRestorePageScroll', 'storyboardPageTitle', 'renderStoryboardTab', 'renderStoryboardNav'];
const code = names.map(storyboardFunctionSource).join('\n') + `\nObject.assign(window,{${names.join(',')}});`;
const css = (await Promise.all(['style.css', 'qianmu-theme-skins.css'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')))).join('\n');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), errors = [], checks = []; let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url === 'https://qianmu.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
  for (const file of ['qianmu-storyboard-nav-lifecycle.js', 'qianmu-theme-surfaces.js', 'qianmu-theme-palette.js', 'qianmu-icon-renderer.js']) {
    if (url === `https://qianmu.test/${file}`) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
  }
  external++; return route.abort();
});
try {
  await page.goto('https://qianmu.test/'); await page.addStyleTag({ content: css });
  await page.evaluate(async ({ code, binding, form }) => {
    const nav = await import('./qianmu-storyboard-nav-lifecycle.js'), theme = await import('./qianmu-theme-surfaces.js'), icons = await import('./qianmu-icon-renderer.js');
    Object.assign(window, nav, icons, { theme });
    const noop = () => {}, counters = { saves: 0, captures: 0 };
    Object.assign(window, {
      counters, form, state: { view: 'create', source: 'novel', assetView: 'tags', editingArtistPresetId: '', editingPromptItemId: '' },
      storyboardState: () => window.state, clone: structuredClone, htmlEscape: value => String(value), MODAL_ID: 'story-director-modal',
      activeTab: 'imagegen', settings: { theme: 'light', lastTab: 'dashboard' }, THEME_KEYS: ['light'], THEMES: [],
      readerView: null, focusClockLockConfirming: false, coreadOpenRequestId: 0, editorView: null, theaterView: null,
      storyboardVibeLibraryController: null, storyboardVibeSelection: null, focusClockLockGuard: null,
      modalJustOpened: false, EXTENSION_NAME: '千幕', COREAD_VISIBLE: false, COREAD_ENABLED: false, worldPage: 'front',
      featureRuntime: { bindIntent: noop }, storyboardPendingRestoreScroll: null, storyboardPageScrolls: new Map(),
      performanceRuntime: { modalRenderCount: 0, modalRenderTotalMs: 0, modalRenderLastMs: 0, modalRenderMaxMs: 0, slowModalRenderCount: 0, rendersByTab: {} },
      focusClockActiveLock: () => false, focusClockCancelEntry: noop, focusClockPauseForReadingExit: noop,
      storyboardCaptureTagDraft: noop, prepareDirectorWorldEntryLinks: noop, snapshotAccState: noop,
      saveSettings: () => counters.saves++, storyboardCaptureWorkbench: () => counters.captures++,
      closeModal: noop, bindQianmuVersionBadge: noop, bindNotesPanelEvents: noop, applyAccState: noop, renderBusyState: noop, syncFontWithST: noop,
      storyboardReconcileGalleryLinks: noop, renderStoryboardCreate: () => form,
      renderStoryboardAssets: () => '<section class="sd-card" style="height:1200px">隔离的素材内容</section>',
      renderStoryboardGallery: () => '<section class="sd-card">隔离的阅片室内容</section>', renderStoryboardLogs: () => '<section class="sd-card">隔离的日志内容</section>',
      qianmuVersionBadgeMarkup: () => '', renderInjectDock: () => '', updateTabsFade: noop, bindTabsScrollControls: noop,
    });
    new Function(code)();
    window.bindActiveTabEvents = new Function('root', `const state=storyboardState();\n${binding}`);
    window.renderActiveTab = () => activeTab === 'imagegen' ? renderStoryboardTab() : '<p>原审片页占位，仅验证离开分镜生命周期</p>';
  }, { code, binding, form: createStoryboardFormFixture().content });
  for (const width of [393, 1280]) for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(mode => {
      window.controller?.dispose(); document.body.innerHTML = '<div id="story-director-modal" class="sd-theme-light open"></div>';
      window.state = { view: 'create', source: 'novel', assetView: 'tags' }; activeTab = 'imagegen'; storyboardPageScrolls.clear();
      controller = theme.createQianmuThemeSurfaceController(); controller.register(document.getElementById(MODAL_ID)); controller.setTheme({ theme: 'glass', mode });
      renderModal(); document.querySelectorAll('details').forEach(node => node.open = true);
      window.originalNav = document.querySelector('.sd-storyboard-nav'); window.originalButtons = [...originalNav.querySelectorAll('button')];
      originalButtons[0].style.setProperty('--test-owner', 'preserved', 'important');
      window.originalInline = originalButtons.flatMap(button => [button, button.querySelector('span')]).map(node => node.style.cssText);
      document.querySelector('.sd-storyboard-scroll').scrollTop = 211;
    }, mode);
    await page.waitForTimeout(400);
    for (const destination of ['characters', 'assets', 'gallery', 'logs', 'create']) {
      const before = await page.evaluate(() => ({ saves: counters.saves, captures: counters.captures, view: state.view, renders: performanceRuntime.modalRenderCount }));
      const target = page.locator(`.sd-storyboard-nav [data-storyboard-view="${destination}"]`);
      await target.focus(); await target.press('Enter');
      await page.waitForTimeout(80);
      const mid = await page.evaluate(() => {
        const selected = document.querySelector('.sd-storyboard-nav button.active');
        return { same: originalNav === document.querySelector('.sd-storyboard-nav'), buttons: originalButtons.every(button => button.isConnected),
          width: selected.getBoundingClientRect().width, view: state.view, focused: document.activeElement === selected,
          inline: originalButtons.flatMap(button => [button, button.querySelector('span')]).map(node => node.style.cssText),
          expectedInline: originalInline,
          aria: selected.getAttribute('aria-current'), saves: counters.saves, captures: counters.captures, renders: performanceRuntime.modalRenderCount };
      });
      assert.equal(mid.same, true); assert.equal(mid.buttons, true); assert.equal(mid.view, destination); assert.equal(mid.focused, true); assert.equal(mid.aria, 'page');
      assert.deepEqual(mid.inline, mid.expectedInline, 'temporary animation values must restore exact inline styles and priority');
      assert.equal(mid.saves, before.saves + 1); assert.equal(mid.captures, before.captures + (before.view === 'create' ? 1 : 0)); assert.equal(mid.renders, before.renders + 1);
      assert.ok(mid.width > (width === 393 ? 40 : 48) && mid.width < (width === 393 ? 100 : 112), `actual route ${destination}: transition did not continue (${mid.width})`);
      await page.waitForTimeout(360);
      assert.equal(await target.evaluate(node => node.getBoundingClientRect().width), width === 393 ? 100 : 112);
      checks.push(`${width}/${mode}/${destination}: actual modal route, retained node/focus, one handler, intermediate expansion`);
    }
    assert.equal(await page.locator('.sd-storyboard-scroll').evaluate(node => node.scrollTop), 211, 'actual route back restores source scroll');
    checks.push(`${width}/${mode}: route return preserves scroll map`);

    const burst = await page.evaluate(() => {
      const saves = counters.saves, renders = performanceRuntime.modalRenderCount;
      for (const view of ['gallery', 'characters', 'assets', 'logs', 'create']) originalNav.querySelector(`[data-storyboard-view="${view}"]`).click();
      return { saves: counters.saves - saves, renders: performanceRuntime.modalRenderCount - renders, view: state.view, same: originalNav.isConnected };
    }); assert.deepEqual(burst, { saves: 5, renders: 5, view: 'create', same: true }); checks.push(`${width}/${mode}: rapid reversal without duplicated route dispatch`);

    await page.waitForTimeout(380);
    await page.evaluate(() => originalNav.querySelector('[data-storyboard-view="gallery"]').click()); await page.waitForTimeout(80);
    const reversed = await page.evaluate(() => {
      const gallery = originalNav.querySelector('[data-storyboard-view="gallery"]'), before = gallery.getBoundingClientRect().width;
      originalNav.querySelector('[data-storyboard-view="create"]').click();
      return { before, after: gallery.getBoundingClientRect().width };
    });
    assert.ok(Math.abs(reversed.after - reversed.before) < 3, 'reversal must start from its painted width, not a collapsed endpoint');
    await page.waitForTimeout(380); checks.push(`${width}/${mode}: mid-animation reverse continues without a width jump`);

    const swapped = await page.evaluate(() => {
      const old = state; state = { ...state, view: 'gallery' }; renderModal();
      const saves = counters.saves; originalNav.querySelector('[data-storyboard-view="logs"]').click();
      return { oldView: old.view, view: state.view, saves: counters.saves - saves };
    }); assert.deepEqual(swapped, { oldView: 'create', view: 'logs', saves: 1 }); checks.push(`${width}/${mode}: replaced settings object has no stale nav closure`);

    const exit = await page.evaluate(() => {
      activeTab = 'dashboard'; renderModal(); const retired = originalNav.isConnected;
      activeTab = 'imagegen'; renderModal(); return { retired, reused: originalNav === document.querySelector('.sd-storyboard-nav') };
    }); assert.deepEqual(exit, { retired: false, reused: false }); checks.push(`${width}/${mode}: leaving storyboard releases the prior nav`);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(() => {
    document.querySelector('[data-storyboard-view="gallery"]').click(); const selected = document.querySelector('.sd-storyboard-nav button.active');
    return { duration: getComputedStyle(selected).transitionDuration, width: selected.getBoundingClientRect().width, animations: selected.getAnimations().length };
  });
  assert.deepEqual(reduced, { duration: '0s', width: 112, animations: 0 }); checks.push('actual route respects reduced motion');

  for (const themeName of [null, 'editorial']) {
    const result = await page.evaluate(themeName => {
      controller.setTheme(themeName ? { theme: themeName, mode: 'light' } : null); state.view = 'create'; renderModal();
      const nav = document.querySelector('.sd-storyboard-nav'); nav.querySelector('[data-storyboard-view="gallery"]').click();
      return { reused: nav === document.querySelector('.sd-storyboard-nav'), view: state.view };
    }, themeName); assert.deepEqual(result, { reused: false, view: 'gallery' }); checks.push(`${themeName || 'classic'}: original replacement lifecycle is unchanged`);
  }
  // Changed renderer vocabulary must replace stale nodes rather than silently reuse old labels.
  const mismatch = await page.evaluate(() => {
    controller.setTheme({ theme: 'glass', mode: 'light' }); renderModal();
    const root = document.getElementById(MODAL_ID), old = root.querySelector('.sd-storyboard-nav'), restore = preserveQianmuStoryboardNav(root, true);
    const next = old.cloneNode(true); next.querySelector('button').setAttribute('aria-label', '新入口'); old.replaceWith(next);
    return { restored: restore(), same: root.querySelector('.sd-storyboard-nav') === next, second: restore() };
  }); assert.deepEqual(mismatch, { restored: false, same: true, second: false }); checks.push('changed labels safely keep the fresh renderer; restoration is single-use');
  assert.deepEqual(errors, []); assert.equal(external, 0);
  console.log(JSON.stringify({ passed: checks.length, checks, errors, external, productionDataRead: false, scope: 'actual modal/route/scroll code with isolated host and library services; theme settings not yet enabled in production' }));
} finally { await context.close(); await browser.close(); }
