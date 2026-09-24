// Execute the real modal renderer, route/scroll functions and route-binding block.
// Non-routing host services and library contents are isolated stubs; no providers run.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { THEMES as themes, QUICK_HIVE_THEME_PALETTES as hivePalettes } from '../qianmu-classic-palettes.js';
import { createStoryboardFormFixture, storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const bindingStart = entry.indexOf('  bindQianmuStoryboardNavigation(root, (button) => {');
const bindingEnd = entry.indexOf("  root.querySelectorAll('[data-storyboard-gallery-kind]')", bindingStart);
assert.ok(bindingStart > 0 && bindingEnd > bindingStart);
const binding = entry.slice(bindingStart, bindingEnd);
const names = ['renderModal', 'closeModal', 'storyboardNavigate', 'storyboardApplyRoute', 'storyboardPageKey', 'storyboardScroller',
  'storyboardRememberPageScroll', 'storyboardRestorePageScroll', 'storyboardPageTitle', 'renderStoryboardTab', 'renderStoryboardNav'];
const code = names.map(storyboardFunctionSource).join('\n') + `\nObject.assign(window,{${names.join(',')}});`;
const css = (await Promise.all(['style.css', 'qianmu-theme-skins.css'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')))).join('\n');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), errors = [], checks = []; let external = 0, skinRequests = 0, failSkin = false;
let holdSkin = false, releaseSkin = null;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url === 'https://qianmu.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
  if (url === 'https://qianmu.test/qianmu-theme-skins.css') { skinRequests++; if(holdSkin)await new Promise(resolve=>releaseSkin=resolve); return route.fulfill({status:failSkin?404:200,contentType:'text/css',body:failSkin?'':await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8')}); }
  for (const file of ['qianmu-storyboard-nav-lifecycle.js', 'qianmu-theme-surfaces.js', 'qianmu-theme-palette.js', 'qianmu-icon-renderer.js', 'qianmu-theme-menu.js', 'qianmu-appearance-session.js', 'qianmu-appearance-runtime.js', 'qianmu-appearance-settings.js', 'qianmu-appearance-portals.js', 'qianmu-input-boundary.js', 'qianmu-notes-theme.js', 'qianmu-classic-palettes.js', 'qianmu-appearance-actions.js', 'qianmu-hive-theme-logo.js']) {
    if (url === `https://qianmu.test/${file}`) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
  }
  external++; return route.abort();
});
try {
  await page.goto('https://qianmu.test/'); await page.addStyleTag({ content: css });
  await page.evaluate(async ({ code, binding, form, themes }) => {
    const nav = await import('./qianmu-storyboard-nav-lifecycle.js'), theme = await import('./qianmu-theme-surfaces.js'), icons = await import('./qianmu-icon-renderer.js');
    Object.assign(window, nav, icons, await import('./qianmu-theme-menu.js'), await import('./qianmu-appearance-actions.js'), await import('./qianmu-appearance-settings.js'), { theme });
    const noop = () => {}, counters = { saves: 0, captures: 0, float: 0, notes: 0 };
    Object.assign(window, {
      counters, form, FLOAT_LOGO_URLS:{}, FLOAT_LOGO_URL:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', toast:message=>{throw Error(message);}, state: { view: 'create', source: 'novel', assetView: 'tags', editingArtistPresetId: '', editingPromptItemId: '' },
      storyboardState: () => window.state, clone: structuredClone, htmlEscape: value => String(value), MODAL_ID: 'story-director-modal',
      activeTab: 'imagegen', settings: { theme: 'light', lastTab: 'dashboard' }, THEME_KEYS: themes.map(theme => theme.key), THEMES: themes,currentHiveThemeKey:()=>THEME_KEYS.includes(settings.theme)?settings.theme:'light',
      readerView: null, focusClockLockConfirming: false, coreadOpenRequestId: 0, editorView: null, theaterView: null,
      storyboardVibeLibraryController: null, storyboardEnsembleController: null, storyboardVibeSelection: null, storyboardGalleryKind: 'stills', storyboardGalleryInspectorRecordId: '', focusClockLockGuard: null,
      modalJustOpened: false, EXTENSION_NAME: '千幕', COREAD_VISIBLE: false, COREAD_ENABLED: false, worldPage: 'front',
      featureRuntime: { bindIntent: noop }, storyboardPendingRestoreScroll: null, storyboardPageScrolls: new Map(),
      performanceRuntime: { modalRenderCount: 0, modalRenderTotalMs: 0, modalRenderLastMs: 0, modalRenderMaxMs: 0, slowModalRenderCount: 0, rendersByTab: {} },
      focusClockActiveLock: () => false, focusClockCancelEntry: noop, focusClockPauseForReadingExit: noop,
      storyboardCaptureTagDraft: noop, prepareDirectorWorldEntryLinks: noop, snapshotAccState: noop,
      saveSettings: () => counters.saves++, storyboardCaptureWorkbench: () => counters.captures++,
      closeModal: noop, bindQianmuVersionBadge: noop, bindNotesPanelEvents: noop, applyAccState: noop, renderBusyState: noop, refreshDirectorLiveUI: noop, syncFontWithST: noop,
      focusClockBlockExit: () => false, focusClockCloseVoiceDrawer: noop, unmountReaderPortal: noop, unmountTheaterFullscreen: noop,
      renderFloatButton: () => counters.float++, syncNotesTheme: () => counters.notes++,
      storyboardReconcileGalleryLinks: noop, renderStoryboardCreate: () => form,
      renderStoryboardAssets: () => '<section class="sd-card" style="height:1200px">隔离的素材内容</section>',
      renderStoryboardGallery: () => '<section class="sd-card">隔离的阅片室内容</section>', renderStoryboardLogs: () => '<section class="sd-card">隔离的日志内容</section>',
      qianmuVersionBadgeMarkup: () => '', renderInjectDock: () => '', renderQianmuMainTabs: () => '', updateTabsFade: noop, bindTabsScrollControls: noop,
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
      assert.deepEqual({same:mid.same,buttons:mid.buttons,view:mid.view,focused:mid.focused,aria:mid.aria},
        {same:true,buttons:true,view:destination,focused:true,aria:'page'}, `${width}/${mode}/${destination}: ${errors.join('; ')}`);
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
      const prior = await page.evaluate(() => {
        window.classicBody=document.querySelector('.sd-body');
        if(!classicBody.querySelector('textarea'))classicBody.insertAdjacentHTML('beforeend','<details open><summary>保留折叠</summary><textarea>尚未保存的编辑</textarea></details><div style="height:1700px"></div>');
        window.classicDraft=classicBody.querySelector('textarea');classicDraft.setSelectionRange(1,4);classicBody.scrollTop=73;
        return { ...counters, theme: settings.theme, renders: performanceRuntime.modalRenderCount,scroll:classicBody.scrollTop };
      });
      await page.locator('.sd-theme-btn').click();
      await page.locator('[data-appearance-family="classic"]').click();
      await page.locator(`.sd-theme-opt[data-theme="${key}"]`).click();
      const next = await page.evaluate(() => ({ ...counters, theme: settings.theme, renders: performanceRuntime.modalRenderCount,
        listeners: outsideListeners.size, hidden: document.querySelector('.sd-theme-menu').hidden,
        checked: document.querySelector('.sd-theme-opt[data-theme][aria-checked="true"]').dataset.theme,
        same:classicBody===document.querySelector('.sd-body')&&classicDraft===classicBody.querySelector('textarea'),draft:classicDraft.value,selection:[classicDraft.selectionStart,classicDraft.selectionEnd],scroll:classicBody.scrollTop,
        expanded:classicBody.querySelector('details').open,focus:document.activeElement===document.querySelector('.sd-theme-opt[data-theme][aria-checked="true"]'),className:document.getElementById(MODAL_ID).className }));
      assert.equal(next.theme, key); assert.equal(next.checked, key); assert.equal(next.hidden, false); assert.equal(next.listeners, 1);
      assert.equal(next.saves, prior.saves + (key === prior.theme ? 0 : 1)); assert.equal(next.renders, prior.renders);
      assert.equal(next.float, prior.float); assert.equal(next.notes, prior.notes);
      assert.equal(next.same,true);assert.equal(next.draft,'尚未保存的编辑');assert.deepEqual(next.selection,[1,4]);assert.equal(next.scroll,prior.scroll);assert.equal(next.expanded,true);assert.equal(next.focus,true);assert.ok(next.className.includes('sd-theme-'+key));
      checks.push(`${width}/${key}: actual classic menu persists once in place without rerender, keeps draft/selection/scroll/fold and selected swatch focus`);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(()=>outsideListeners.size),0);
    }
    await page.locator('.sd-theme-btn').focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.sd-theme-opt[data-appearance-family="classic"]').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.dataset.appearanceFamily), 'editorial');
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
    Object.assign(window,await import('./qianmu-notes-theme.js'),await import('./qianmu-appearance-settings.js'),await import('./qianmu-hive-theme-logo.js'),{
      MODULE_NAME:'isolated-qianmu',QUICK_HIVE_THEME_PALETTES:palettes,NOTES_PANEL_LAYER_ID:'qianmu-notes-panel-layer',NOTES_FLOAT_LAYER_ID:'qianmu-notes-float-layer',FLOAT_ID:'story-director-float',
      NOTES_THEME_VARIABLES:['--sd-text','--sd-muted','--sd-accent','--sd-card','--sd-primary'],QUICK_HEX_BORDER_SVG:'',FLOAT_LOGO_URLS:{},FLOAT_LOGO_URL:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
      notesPanelOpen:false,notesFeatureSettings:()=>settings.notes,notesFeatureEnabled:()=>true,collectionFloorTools:{renderHive:noop},notesSyncControls:()=>({mount:noop}),stopNotesPanelResizeTracking:noop,bindNotesPanelResize:noop,
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
      settings.appearance=updateAppearancePreferences(settings,{family:'glass'});await appearanceSession.sync();
      const nodes=[document.querySelector('.sd-note-body'),mountFixture.main.querySelector('img'),mountFixture.hiveButton,mountFixture.floating];
      const previousRenders=performanceRuntime.modalRenderCount;
      selectQianmuClassicTheme({settings,themeKey:classic,session:appearanceSession,save:saveSettings,resolveLogo:()=>FLOAT_LOGO_URL});
      const source=document.createElement('div');source.id=MODAL_ID;source.className=`sd-theme-${classic}`;document.body.append(source);const expected=getComputedStyle(source).getPropertyValue('--sd-text').trim();source.remove();
      const panel=document.getElementById(NOTES_PANEL_LAYER_ID);return {theme:panel.dataset.qmTheme||'',text:getComputedStyle(panel).getPropertyValue('--sd-text').trim(),expected,hive:mountFixture.hiveButton.style.getPropertyValue('--sd-wheel-icon'),edge:mountFixture.hiveButton.style.getPropertyValue('--sd-wheel-edge'),floatEdge:mountFixture.main.style.getPropertyValue('--sd-float-edge'),noteEdge:mountFixture.floating.style.getPropertyValue('--sd-wheel-edge'),same:nodes.every(node=>node.isConnected),renders:performanceRuntime.modalRenderCount-previousRenders,family:settings.appearance.family};
    },classic);assert.equal(restored.theme,'');assert.equal(restored.text,restored.expected);assert.equal(restored.hive,hivePalettes[classic].darkIcon);assert.equal(restored.edge,hivePalettes[classic].edges[2%hivePalettes[classic].edges.length]);assert.equal(restored.floatEdge,hivePalettes[classic].mainEdge);assert.equal(restored.noteEdge,restored.edge);assert.equal(restored.same,true);assert.equal(restored.renders,0);assert.equal(restored.family,'classic');checks.push(`${classic}: action exits new theme and recolors real notes/hive/main without replacing nodes, also when main panel is absent`);
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
  // Actual NEW appearance entry, including owned loader failures and a late result.
  await page.evaluate(async saveSource=>{
    const {createQianmuAppearanceSession}=await import('./qianmu-appearance-session.js');
    appearanceSession.reset();document.getElementById(MODAL_ID)?._sdThemeMenuCleanup?.();
    document.body.innerHTML='<div id="story-director-modal" class="sd-theme-dream open"></div>';
    settings={theme:'dream',lastTab:'dashboard'};activeTab='dashboard';window.renderActiveTab=()=>form;
    window.ctx=()=>({saveSettingsDebounced:()=>{counters.saves++;window.nativeAppearanceSave=JSON.stringify(settings);}});
    window.saveSettings=new Function(saveSource+';return saveSettings;')();
    window.menuResourceErrors=[];appearanceSession=createQianmuAppearanceSession({readSettings:()=>settings,styleUrl:'https://qianmu.test/qianmu-theme-skins.css',onError:error=>menuResourceErrors.push(error.message)});
    renderModal();window.newMenuDraft=document.querySelector('textarea');newMenuDraft.value='原位保留的取景编辑';newMenuDraft.setSelectionRange(2,6);
    window.newMenuBody=document.querySelector('.sd-body');newMenuBody.scrollTop=79;
  },storyboardFunctionSource('saveSettings'));
  const screenshots=process.env.QIANMU_MENU_SCREENSHOT_DIR;if(screenshots)await mkdir(screenshots,{recursive:true});
  for(const width of [393,1280])for(const family of ['editorial','glass'])for(const mode of ['light','dark']){
    await page.setViewportSize({width,height:900});
    if(await page.locator('.sd-theme-menu').isHidden())await page.locator('.sd-theme-btn').click();
    const before=await page.evaluate(()=>({renders:performanceRuntime.modalRenderCount,scroll:newMenuBody.scrollTop,saves:counters.saves,preference:readAppearancePreferences(settings)}));
    const familyChoice=page.locator(`[data-appearance-family="${family}"]`);
    if(await familyChoice.getAttribute('aria-checked')!=='true')await familyChoice.click();
    if(await page.locator('.sd-theme-mode-toggle').getAttribute('data-current-mode')!==mode)await page.locator('.sd-theme-mode-toggle').click();
    else await page.locator('.sd-theme-mode-toggle').focus();
    await page.evaluate(()=>appearanceSession.sync());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const after=await page.evaluate(()=>{const main=document.getElementById(MODAL_ID),menu=document.querySelector('.sd-theme-menu'),bounds=menu.getBoundingClientRect();return {
      family:main.dataset.qmTheme,mode:main.dataset.qmMode,legacy:settings.theme,preference:readAppearancePreferences(settings),saves:counters.saves,renders:performanceRuntime.modalRenderCount,
      same:newMenuBody===document.querySelector('.sd-body')&&newMenuDraft===document.querySelector('textarea'),draft:newMenuDraft.value,selection:[newMenuDraft.selectionStart,newMenuDraft.selectionEnd],scroll:newMenuBody.scrollTop,
      familyRadio:menu.querySelector('[data-appearance-family][aria-checked="true"]').dataset.appearanceFamily,modeRadio:menu.querySelector('.sd-theme-mode-toggle').dataset.currentMode,
      status:document.querySelector('.sd-theme-feedback').hidden,visible:!menu.hidden,fits:bounds.left>=0&&bounds.right<=innerWidth&&bounds.bottom<=innerHeight,focus:document.activeElement.dataset.currentMode,modeIcons:menu.querySelectorAll('.sd-theme-mode-toggle svg').length,modeLabel:menu.querySelector('.sd-theme-mode-toggle').getAttribute('aria-label'),
    };});
    assert.equal(after.family,family);assert.equal(after.mode,mode);assert.equal(after.legacy,'dream');assert.equal(after.familyRadio,family);assert.equal(after.modeRadio,mode);
    assert.equal(after.same,true);assert.equal(after.draft,'原位保留的取景编辑');assert.deepEqual(after.selection,[2,6]);assert.equal(after.scroll,before.scroll);assert.equal(after.renders,before.renders);assert.equal(after.status,true);assert.equal(after.visible,true);assert.equal(after.fits,true);assert.equal(after.focus,mode);
    assert.equal(after.saves-before.saves,Number(before.preference.family!==family)+Number(before.preference.mode!==mode));
    assert.equal(after.modeIcons,1);assert.equal(after.modeLabel,mode==='dark'?'切换至日间':'切换至夜间');
    checks.push(`${width}/${family}/${mode}: real family/day-night clicks keep workbench draft/selection/scroll and focus; save once per changed field`);
    if(screenshots&&width===393&&mode==='light')await page.screenshot({path:path.join(screenshots,`${family}-${mode}-393.png`)});
  }
  const reopened=await page.evaluate(async()=>{
    const previous=settings.appearance;settings=JSON.parse(nativeAppearanceSave);document.getElementById(MODAL_ID)._sdThemeMenuCleanup();appearanceSession.reset();renderModal();await appearanceSession.sync();
    return {family:document.getElementById(MODAL_ID).dataset.qmTheme,mode:document.getElementById(MODAL_ID).dataset.qmMode,saved:settings.appearance,previous};
  });assert.equal(reopened.family,'glass');assert.equal(reopened.mode,'dark');assert.deepEqual(reopened.saved,reopened.previous);checks.push('JSON-round-tripped saved preferences restore the real menu/skin on a new mount (isolated native-save stub)');
  await page.evaluate(()=>{appearanceSession.reset();settings.appearance=updateAppearancePreferences(settings,{family:'classic'});renderModal();});
  failSkin=true;await page.locator('.sd-theme-btn').click();await page.locator('[data-appearance-family="glass"]').click();await page.evaluate(()=>appearanceSession.sync());
  const failedMenu=await page.evaluate(()=>({theme:document.getElementById(MODAL_ID).dataset.qmTheme||'',error:document.querySelector('.sd-theme-status').textContent,retry:!document.querySelector('.sd-theme-retry').hidden,open:!document.querySelector('.sd-theme-menu').hidden,title:document.querySelector('.sd-theme-btn').title}));
  assert.equal(failedMenu.theme,'');assert.match(failedMenu.error,/暂用经典/);assert.equal(failedMenu.retry,true);assert.equal(failedMenu.open,true);assert.match(failedMenu.title,/未加载/);checks.push('real CSS 404 is visible in the open appearance menu, with classic pixels and an explicit retry');
  failSkin=false;await page.locator('.sd-theme-retry').click();await page.evaluate(()=>appearanceSession.sync());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  const menuRetry=await page.evaluate(()=>({theme:document.getElementById(MODAL_ID).dataset.qmTheme,status:document.querySelector('.sd-theme-feedback').hidden,focus:document.activeElement.dataset.appearanceFamily}));assert.deepEqual(menuRetry,{theme:'glass',status:true,focus:'glass'});checks.push('real retry button recovers without rerender and returns focus to selected family when retry disappears');
  await page.locator('[data-appearance-family="classic"]').click();await page.locator('[data-theme="candy"]').click();
  const classicExit=await page.evaluate(()=>({family:settings.appearance.family,legacy:settings.theme,theme:document.getElementById(MODAL_ID).dataset.qmTheme||'',closed:document.querySelector('.sd-theme-menu').hidden,modeHidden:document.querySelector('.sd-theme-accent-options').hidden}));assert.deepEqual(classicExit,{family:'classic',legacy:'candy',theme:'',closed:false,modeHidden:true});checks.push('real classic choice exits the new family in place, restores its own palette and hides new-family mode controls');
  await page.evaluate(()=>{appearanceSession.reset();renderModal();});holdSkin=true;
  await page.locator('.sd-theme-btn').click();await page.locator('[data-appearance-family="editorial"]').click();
  await page.waitForFunction(()=>appearanceSession.status==='loading');await page.evaluate(()=>{window.pendingAppearance=appearanceSession.sync();});
  await page.locator('[data-appearance-family="glass"]').click();await page.locator('[data-appearance-family="classic"]').click();await page.locator('[data-theme="summer"]').click();
  for(let attempt=0;!releaseSkin&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(releaseSkin,'held stylesheet request arrived');holdSkin=false;releaseSkin();releaseSkin=null;
  await page.evaluate(()=>pendingAppearance);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  const cancelled=await page.evaluate(()=>({family:settings.appearance.family,legacy:settings.theme,theme:document.getElementById(MODAL_ID).dataset.qmTheme||'',checked:document.querySelector('[data-theme][aria-checked="true"]').dataset.theme,status:document.querySelector('.sd-theme-feedback').hidden}));assert.deepEqual(cancelled,{family:'classic',legacy:'summer',theme:'',checked:'summer',status:true});checks.push('switching families and returning to classic during a pending stylesheet does not apply stale pixels or stale menu state');
  await page.setViewportSize({width:320,height:568});if(await page.locator('.sd-theme-menu').isHidden())await page.locator('.sd-theme-btn').click();await page.locator('[data-appearance-family="glass"]').click();if(await page.locator('.sd-theme-mode-toggle').getAttribute('data-current-mode')!=='dark')await page.locator('.sd-theme-mode-toggle').click();
  const compact=await page.evaluate(()=>{const menu=document.querySelector('.sd-theme-menu'),bounds=menu.getBoundingClientRect();return {fits:bounds.left>=0&&bounds.right<=innerWidth&&bounds.bottom<=innerHeight,bounds:{left:bounds.left,right:bounds.right,bottom:bounds.bottom},mode:document.getElementById(MODAL_ID).dataset.qmMode,overflow:getComputedStyle(menu).overflowY};});assert.equal(compact.fits,true,JSON.stringify(compact));assert.equal(compact.mode,'dark');assert.equal(compact.overflow,'auto');checks.push('320x568 compact viewport keeps the appearance menu inside the viewport with scroll fallback');
  await page.evaluate(()=>{document.getElementById(MODAL_ID)._sdThemeMenuCleanup();appearanceSession.reset();});
  assert.deepEqual(errors, []); assert.equal(external, 0);
  console.log(JSON.stringify({ passed: checks.length, checks, errors, external, skinRequests, productionDataRead: false, scope: 'actual modal/route/scroll/menu and classic/new-theme actions with isolated native save and host services; no physical device or real account persistence' }));
} finally { releaseSkin?.(); await context.close(); await browser.close(); }
