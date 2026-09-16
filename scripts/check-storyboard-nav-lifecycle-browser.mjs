// Execute the real modal renderer, route/scroll functions and route-binding block.
// Non-routing host services and library contents are isolated stubs; no providers run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createStoryboardFormFixture, storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const bindingStart = entry.indexOf('  bindQianmuStoryboardNavigation(root, (button) => {');
const bindingEnd = entry.indexOf("  root.querySelectorAll('[data-storyboard-gallery-kind]')", bindingStart);
assert.ok(bindingStart > 0 && bindingEnd > bindingStart);
const binding = entry.slice(bindingStart, bindingEnd);
const themes = vm.runInNewContext(entry.slice(entry.indexOf('const THEMES = ['), entry.indexOf('const THEME_KEYS =')) + '; THEMES;');
const hivePalettes = vm.runInNewContext(entry.slice(entry.indexOf('const QUICK_HIVE_THEME_PALETTES ='), entry.indexOf('function currentHiveThemeKey')) + '; QUICK_HIVE_THEME_PALETTES;');
const names = ['renderModal', 'closeModal', 'storyboardNavigate', 'storyboardApplyRoute', 'storyboardPageKey', 'storyboardScroller',
  'storyboardRememberPageScroll', 'storyboardRestorePageScroll', 'storyboardPageTitle', 'renderStoryboardTab', 'renderStoryboardNav'];
const code = names.map(storyboardFunctionSource).join('\n') + `\nObject.assign(window,{${names.join(',')}});`;
const css = (await Promise.all(['style.css', 'qianmu-theme-skins.css'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')))).join('\n');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), errors = [], checks = []; let external = 0, skinRequests = 0, failSkin = false;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url === 'https://qianmu.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
  if (url === 'https://qianmu.test/qianmu-theme-skins.css') { skinRequests++; return route.fulfill({status:failSkin?404:200,contentType:'text/css',body:failSkin?'':await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8')}); }
  for (const file of ['qianmu-storyboard-nav-lifecycle.js', 'qianmu-theme-surfaces.js', 'qianmu-theme-palette.js', 'qianmu-icon-renderer.js', 'qianmu-theme-menu.js', 'qianmu-appearance-session.js', 'qianmu-appearance-runtime.js', 'qianmu-appearance-settings.js', 'qianmu-appearance-portals.js', 'qianmu-notes-theme.js']) {
    if (url === `https://qianmu.test/${file}`) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
  }
  external++; return route.abort();
});
try {
  await page.goto('https://qianmu.test/'); await page.addStyleTag({ content: css });
  await page.evaluate(async ({ code, binding, form, themes }) => {
    const nav = await import('./qianmu-storyboard-nav-lifecycle.js'), theme = await import('./qianmu-theme-surfaces.js'), icons = await import('./qianmu-icon-renderer.js');
    Object.assign(window, nav, icons, await import('./qianmu-theme-menu.js'), { theme });
    const noop = () => {}, counters = { saves: 0, captures: 0, float: 0, notes: 0 };
    Object.assign(window, {
      counters, form, state: { view: 'create', source: 'novel', assetView: 'tags', editingArtistPresetId: '', editingPromptItemId: '' },
      storyboardState: () => window.state, clone: structuredClone, htmlEscape: value => String(value), MODAL_ID: 'story-director-modal',
      activeTab: 'imagegen', settings: { theme: 'light', lastTab: 'dashboard' }, THEME_KEYS: themes.map(theme => theme.key), THEMES: themes,
      readerView: null, focusClockLockConfirming: false, coreadOpenRequestId: 0, editorView: null, theaterView: null,
      storyboardVibeLibraryController: null, storyboardVibeSelection: null, focusClockLockGuard: null,
      modalJustOpened: false, EXTENSION_NAME: '千幕', COREAD_VISIBLE: false, COREAD_ENABLED: false, worldPage: 'front',
      featureRuntime: { bindIntent: noop }, storyboardPendingRestoreScroll: null, storyboardPageScrolls: new Map(),
      performanceRuntime: { modalRenderCount: 0, modalRenderTotalMs: 0, modalRenderLastMs: 0, modalRenderMaxMs: 0, slowModalRenderCount: 0, rendersByTab: {} },
      focusClockActiveLock: () => false, focusClockCancelEntry: noop, focusClockPauseForReadingExit: noop,
      storyboardCaptureTagDraft: noop, prepareDirectorWorldEntryLinks: noop, snapshotAccState: noop,
      saveSettings: () => counters.saves++, storyboardCaptureWorkbench: () => counters.captures++,
      closeModal: noop, bindQianmuVersionBadge: noop, bindNotesPanelEvents: noop, applyAccState: noop, renderBusyState: noop, syncFontWithST: noop,
      focusClockBlockExit: () => false, focusClockCloseVoiceDrawer: noop, unmountReaderPortal: noop, unmountTheaterFullscreen: noop,
      renderFloatButton: () => counters.float++, syncNotesTheme: () => counters.notes++,
      storyboardReconcileGalleryLinks: noop, renderStoryboardCreate: () => form,
      renderStoryboardAssets: () => '<section class="sd-card" style="height:1200px">隔离的素材内容</section>',
      renderStoryboardGallery: () => '<section class="sd-card">隔离的阅片室内容</section>', renderStoryboardLogs: () => '<section class="sd-card">隔离的日志内容</section>',
      qianmuVersionBadgeMarkup: () => '', renderInjectDock: () => '', updateTabsFade: noop, bindTabsScrollControls: noop,
    });
    const {createQianmuAppearanceSession} = await import('./qianmu-appearance-session.js');
    window.appearanceSession = createQianmuAppearanceSession({readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel:noop})});
    new Function(code)();
    window.bindActiveTabEvents = new Function('root', `const state=storyboardState();\n${binding}`);
    window.renderActiveTab = () => activeTab === 'imagegen' ? renderStoryboardTab() : '<p>原审片页占位，仅验证离开分镜生命周期</p>';
  }, { code, binding, form: createStoryboardFormFixture().content, themes });
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

  // Existing appearance choices use the same actual modal and its extracted lifecycle-owned menu.
  await page.evaluate(() => {
    controller.setTheme(null); activeTab = 'dashboard'; renderModal();
    const add = document.addEventListener, remove = document.removeEventListener;
    window.outsideListeners = new Set();
    document.addEventListener = function(type, handler, capture) { if (type === 'click' && handler.name === 'outside' && capture === true) outsideListeners.add(handler); return add.call(this, type, handler, capture); };
    document.removeEventListener = function(type, handler, capture) { if (type === 'click' && handler.name === 'outside' && capture === true) outsideListeners.delete(handler); return remove.call(this, type, handler, capture); };
    window.restoreDocumentListeners = () => { document.addEventListener = add; document.removeEventListener = remove; };
  });
  for (const width of [393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const repeats = await page.evaluate(() => {
      const trigger = document.querySelector('.sd-theme-btn'); let maximum = 0;
      for (let i = 0; i < 25; i++) { trigger.click(); maximum = Math.max(maximum, outsideListeners.size); trigger.click(); }
      return { maximum, remaining: outsideListeners.size, expanded: trigger.getAttribute('aria-expanded') };
    }); assert.deepEqual(repeats, { maximum: 1, remaining: 0, expanded: 'false' }); checks.push(`${width}: 25 menu toggles have no document-listener accumulation`);
    for (const key of themes.map(theme => theme.key)) {
      const prior = await page.evaluate(() => ({ ...counters, theme: settings.theme, renders: performanceRuntime.modalRenderCount }));
      await page.locator('.sd-theme-btn').click();
      await page.locator(`.sd-theme-opt[data-theme="${key}"]`).click();
      const next = await page.evaluate(() => ({ ...counters, theme: settings.theme, renders: performanceRuntime.modalRenderCount,
        listeners: outsideListeners.size, hidden: document.querySelector('.sd-theme-menu').hidden,
        checked: document.querySelector('.sd-theme-opt[aria-checked="true"]').dataset.theme }));
      assert.equal(next.theme, key); assert.equal(next.checked, key); assert.equal(next.hidden, true); assert.equal(next.listeners, 0);
      assert.equal(next.saves, prior.saves + (key === prior.theme ? 0 : 1)); assert.equal(next.renders, prior.renders + 1);
      assert.equal(next.float, prior.float + 1); assert.equal(next.notes, prior.notes + 1);
      checks.push(`${width}/${key}: actual classic choice persists once and retains float/notes synchronization`);
    }
    await page.locator('.sd-theme-btn').focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.sd-theme-opt[aria-checked="true"]').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.dataset.theme), 'light');
    await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.dataset.theme), 'dream');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.sd-theme-btn').evaluate(node => node === document.activeElement && node.getAttribute('aria-expanded') === 'false'), true);
    checks.push(`${width}: real menu ArrowDown/Home/End/Escape and focus return`);
    const cleanup = await page.evaluate(() => {
      document.querySelector('.sd-theme-btn').click(); renderModal(); const rerender = outsideListeners.size;
      document.querySelector('.sd-theme-btn').click(); closeModal(); const close = outsideListeners.size;
      const hidden = document.querySelector('.sd-theme-menu').hidden;
      document.getElementById(MODAL_ID).classList.add('open'); renderModal();
      return { rerender, close, hidden };
    }); assert.deepEqual(cleanup, { rerender: 0, close: 0, hidden: true }); checks.push(`${width}: actual rerender and modal close release an open menu`);
  }
  await page.evaluate(() => restoreDocumentListeners());

  // Production mount calls, real optional stylesheet loader, no manually applied controller.
  await page.evaluate(() => { controller.dispose(); appearanceSession.reset(); document.head.querySelectorAll('style').forEach(node=>node.remove()); document.body.innerHTML='<div id="story-director-modal" class="sd-theme-light open"></div>'; });
  await page.addStyleTag({content:await readFile(new URL('../style.css',import.meta.url),'utf8')});
  const mounts = ['currentHiveThemeKey','currentHivePalette','syncNotesTheme','renderNotesPanelPortal','renderFloatingNotes','bindFloatingNoteEvents','renderFloatButton'];
  await page.evaluate(async ({functions,palettes}) => {
    const noop=()=>{}, {createQianmuAppearanceSession}=await import('./qianmu-appearance-session.js');
    Object.assign(window,await import('./qianmu-notes-theme.js'),await import('./qianmu-appearance-settings.js'),{
      MODULE_NAME:'isolated-qianmu',QUICK_HIVE_THEME_PALETTES:palettes,NOTES_PANEL_LAYER_ID:'qianmu-notes-panel-layer',NOTES_FLOAT_LAYER_ID:'qianmu-notes-float-layer',FLOAT_ID:'story-director-float',
      NOTES_THEME_VARIABLES:['--sd-text','--sd-muted','--sd-accent','--sd-card','--sd-primary'],QUICK_HEX_BORDER_SVG:'',FLOAT_LOGO_URLS:{},FLOAT_LOGO_URL:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
      notesPanelOpen:false,notesFeatureSettings:()=>settings.notes,notesFeatureEnabled:()=>true,stopNotesPanelResizeTracking:noop,bindNotesPanelResize:noop,
      renderNotesPanel:()=>'<div class="sd-notes-stage"><section class="sd-notes-panel"><textarea class="sd-note-body">真实挂载测试草稿</textarea></section></div>',
      clampDetachedNotesEntry:value=>value,detachedNotesGeometry:()=>({width:60,height:68}),detachedNoteCanReturnHome:()=>false,toast:noop,openNotesPanel:noop,
      bindFloatDrag:noop,closeQuickWheel:noop,closeFloorNavigator:noop,applyFloatPosition:btn=>{btn.style.left='15px';btn.style.top='140px';},
    });
    settings={theme:'light',enabled:true,floatingButton:true,lastTab:'imagegen',notes:{enabled:true,detached:true,position:{x:80,y:160},appearance:{tone:'dark',edgeIndex:2},editorFontSize:18}};
    appearanceSession=createQianmuAppearanceSession({readSettings:()=>settings,styleUrl:'https://qianmu.test/qianmu-theme-skins.css',onError:error=>{throw error;}});
    new Function(functions+';Object.assign(window,{syncNotesTheme,renderNotesPanelPortal,renderFloatingNotes,renderFloatButton});')();
    activeTab='imagegen'; state={view:'create',source:'novel',assetView:'tags'};renderModal();renderFloatingNotes();renderFloatButton();
    notesPanelOpen=true;renderNotesPanelPortal();
    const hive=document.createElement('div');hive.innerHTML='<button data-hive-tone="dark" data-hive-edge-index="2" style="color:pink!important;background:red!important;left:18px;top:23px">H</button>';document.body.append(hive);appearanceSession.mountHive(hive);
    window.mountFixture={hive,hiveButton:hive.querySelector('button'),notes:document.querySelector('.sd-note-body'),floating:document.querySelector('.sd-detached-notes-entry'),main:document.getElementById(FLOAT_ID),root:document.getElementById(MODAL_ID)};
  },{functions:mounts.map(storyboardFunctionSource).join('\n'),palettes:hivePalettes});
  assert.equal(skinRequests,0);checks.push('production classic mounts add no optional stylesheet request');
  for(const width of [393,1280])for(const family of ['editorial','glass'])for(const mode of ['light','dark']){
    await page.setViewportSize({width,height:900});
    const result=await page.evaluate(async({family,mode})=>{
      const f=mountFixture;f.notes.focus();f.notes.setSelectionRange(2,5);const renders=performanceRuntime.modalRenderCount;
      settings.appearance=updateAppearancePreferences(settings,{family,mode,source:'manual',accent:'#6581b2'});await appearanceSession.sync();syncNotesTheme();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {roots:[f.root,f.notes.closest('#qianmu-notes-panel-layer'),f.floating,f.main,f.hiveButton].map(node=>[node.dataset.qmTheme,node.dataset.qmMode]),
        same:f.notes===document.querySelector('.sd-note-body')&&f.floating===document.querySelector('.sd-detached-notes-entry'),focus:document.activeElement===f.notes,selection:[f.notes.selectionStart,f.notes.selectionEnd],
        sameRenders:renders===performanceRuntime.modalRenderCount,hiveColor:getComputedStyle(f.hiveButton).color,edge:f.main.style.getPropertyValue('--sd-float-edge'),accent:f.root.style.getPropertyValue('--sd-accent'),left:f.floating.style.left,
        text:getComputedStyle(f.notes.closest('#qianmu-notes-panel-layer')).getPropertyValue('--sd-text').trim(),mainText:f.root.style.getPropertyValue('--sd-text').trim()};
    },{family,mode});
    assert.deepEqual(result.roots,Array(5).fill([family,mode]));assert.equal(result.same,true);assert.equal(result.focus,true);assert.equal(result.sameRenders,true);assert.deepEqual(result.selection,[2,5]);
    assert.notEqual(result.hiveColor,'rgb(255, 192, 203)');assert.equal(result.edge,result.accent);assert.equal(result.left,'80px');assert.equal(result.text,result.mainText);
    checks.push(`${width}/${family}/${mode}: actual main/notes/floating/float hooks and hive colors update without rendering`);
  }
  assert.equal(skinRequests,1);checks.push('new theme stylesheet loads once after classic CSS across all real mounted surfaces');
  const late=await page.evaluate(()=>{
    document.getElementById(MODAL_ID).remove();document.getElementById(NOTES_PANEL_LAYER_ID).remove();appearanceSession.sync();renderNotesPanelPortal();
    const panel=document.getElementById(NOTES_PANEL_LAYER_ID);return {theme:panel.dataset.qmTheme,mode:panel.dataset.qmMode,main:!!document.getElementById(MODAL_ID),count:document.querySelectorAll('#qianmu-notes-panel-layer').length};
  });assert.deepEqual(late,{theme:'glass',mode:'dark',main:false,count:1});checks.push('actual notes portal inherits saved appearance with main panel absent');
  for(const classic of themes.map(theme=>theme.key)){
    const restored=await page.evaluate(async classic=>{
      settings.theme=classic;settings.appearance=updateAppearancePreferences(settings,{family:'classic'});await appearanceSession.sync();syncNotesTheme();
      const source=document.createElement('div');source.id=MODAL_ID;source.className=`sd-theme-${classic}`;document.body.append(source);const expected=getComputedStyle(source).getPropertyValue('--sd-text').trim();source.remove();
      const panel=document.getElementById(NOTES_PANEL_LAYER_ID);return {theme:panel.dataset.qmTheme||'',text:getComputedStyle(panel).getPropertyValue('--sd-text').trim(),expected,hive:mountFixture.hiveButton.style.color};
    },classic);assert.equal(restored.theme,'');assert.equal(restored.text,restored.expected);assert.equal(restored.hive,'pink');checks.push(`${classic}: actual notes sync restores clean classic tokens after new theme`);
  }
  const reset=await page.evaluate(()=>{appearanceSession.reset();return {size:appearanceSession.size,links:document.querySelectorAll('link[href="https://qianmu.test/qianmu-theme-skins.css"]').length};});assert.deepEqual(reset,{size:0,links:0});checks.push('production session cleanup releases skin and registrations');
  failSkin=true;
  const failed=await page.evaluate(async()=>{
    const {createQianmuAppearanceSession}=await import('./qianmu-appearance-session.js');window.expectedStyleErrors=[];
    appearanceSession=createQianmuAppearanceSession({readSettings:()=>settings,styleUrl:'https://qianmu.test/qianmu-theme-skins.css',onError:error=>expectedStyleErrors.push(error.message)});
    settings.appearance=updateAppearancePreferences(settings,{family:'glass'});appearanceSession.mountNotes(document);const ready=await appearanceSession.sync();
    return {ready,errors:expectedStyleErrors.length,theme:document.getElementById(NOTES_PANEL_LAYER_ID).dataset.qmTheme||'',links:document.querySelectorAll('link[href="https://qianmu.test/qianmu-theme-skins.css"]').length};
  });assert.deepEqual(failed,{ready:false,errors:1,theme:'',links:0});checks.push('real stylesheet 404 leaves classic visible and removes failed link');
  failSkin=false;
  const retried=await page.evaluate(async()=>{const ready=await appearanceSession.retry();const theme=document.getElementById(NOTES_PANEL_LAYER_ID).dataset.qmTheme;appearanceSession.reset();return {ready,theme,errors:expectedStyleErrors.length};});
  assert.deepEqual(retried,{ready:true,theme:'glass',errors:1});assert.equal(skinRequests,3);checks.push('explicit stylesheet retry recovers the same mounted notes without rendering');
  assert.deepEqual(errors, []); assert.equal(external, 0);
  console.log(JSON.stringify({ passed: checks.length, checks, errors, external, skinRequests, productionDataRead: false, scope: 'actual modal/route/scroll/menu and core appearance mount code with isolated host services; new-theme settings UI not enabled' }));
} finally { await context.close(); await browser.close(); }
