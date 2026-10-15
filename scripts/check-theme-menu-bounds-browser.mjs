// Real theme-menu renderer, binder, appearance session and CSS in isolated shells.
// Shell bounds/toolbar position vary; no production account, settings or network.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), errors = [], checks = [];
const qa = new URL('../dist/local-qa/theme-menu-bounds/', import.meta.url);
await mkdir(qa, { recursive: true });
let external = 0;
const deadline = setTimeout(() => { void browser.close(); }, 120000);
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>' });
  if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.(?:css|js)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
  external++; return route.abort();
});
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const ok = (label, result) => { assert.ok(result, label); checks.push(label); };
try {
  await page.goto('https://qianmu.test/');
  for (const file of ['style.css', 'qianmu-theme-skins.css']) await page.addStyleTag({ content: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
  await page.addStyleTag({ content: 'body{margin:0}#story-director-modal{position:relative!important;inset:auto!important;display:block!important;transform:none!important;width:100%!important;height:100dvh!important}#story-director-modal>.sd-window{position:absolute!important;inset:auto!important;transform:none!important;margin:0!important;top:10px!important;width:var(--fixture-width)!important;left:var(--fixture-left)!important;height:calc(100dvh - 20px)!important;max-height:none!important;overflow:hidden!important}.fixture-content{height:1800px}#story-director-modal .fixture-title{display:none!important}#story-director-modal .fixture-narrow .sd-header{justify-content:flex-start!important}' });
  await page.evaluate(async () => {
    for (const module of ['qianmu-theme-menu','qianmu-appearance-settings','qianmu-appearance-session','qianmu-classic-palettes','qianmu-icon-renderer']) Object.assign(window, await import('/' + module + '.js'));
    window.setup = async ({ width, left = 0, family = 'glass', mode = 'light', anchor = 'right' }) => {
      window.unbind?.(); window.appearance?.reset();
      window.settings = { theme: mode, appearance: updateAppearancePreferences({}, { family, mode }) };
      const auxiliary = '<button class="sd-plug-shortcut" aria-label="设置">⚙</button>';
      const menu = renderQianmuThemeMenu(THEMES, mode, { settings, supported: true });
      document.body.innerHTML = `<div id="story-director-modal" class="open sd-theme-${mode}"><section class="sd-window ${anchor === 'left' ? 'fixture-narrow' : ''}" style="--fixture-width:${width}px;--fixture-left:${left}px"><header class="sd-header"><div class="sd-titlebox"><h2>千幕</h2></div><div class="sd-header-actions">${anchor === 'left' ? menu + auxiliary.repeat(2) : auxiliary.repeat(2) + menu}<button class="sd-close" aria-label="关闭">×</button></div></header><main class="sd-body"><p>主题菜单隔离组件验收</p><div class="fixture-content"></div></main></section></div>`;
      const root = document.querySelector('#story-director-modal');
      if (anchor === 'left') root.querySelector('.sd-titlebox').classList.add('fixture-title');
      window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(false), cancel() {} }) });
      appearance.mount(root); await appearance.sync(); window.changes = 0;
      window.unbind = bindQianmuThemeMenu(root, key => { settings.theme = key; settings.appearance = updateAppearancePreferences(settings, { family: 'classic' }); changes++; return appearance.sync(); }, { read: () => ({ ...readAppearancePreferences(settings), classic: settings.theme }), status: () => appearance.status, sync: () => appearance.sync(), retry: () => appearance.retry(), change: patch => { settings.appearance = updateAppearancePreferences(settings, patch); changes++; return appearance.sync(); } });
      applyQianmuIcons(root);
    };
    window.geometry = () => {
      const menu = document.querySelector('.sd-theme-menu'), shell = document.querySelector('.sd-window');
      const m = menu.getBoundingClientRect(), s = shell.getBoundingClientRect(), t = document.querySelector('.sd-theme-btn').getBoundingClientRect();
      const rect = r => ({ left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height });
      const controls = [...menu.querySelectorAll('[data-appearance-family],.sd-theme-mode-toggle,[data-appearance-accent],.sd-theme-custom-color')].filter(node=>node.getClientRects().length).map(node=>{const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {visible:r.left>=m.left&&r.right<=m.right,clickable:hit===node||node.contains(hit)};});
      const v=window.visualViewport;
      return {menu:rect(m),shell:rect(s),trigger:rect(t),viewport:{left:v?.offsetLeft||0,top:v?.offsetTop||0,width:v?.width||innerWidth,height:v?.height||innerHeight},overflow:menu.scrollWidth>menu.clientWidth+1,controls};
    };
  });
  const verify = async label => {
    await settle(); const g = await page.evaluate(() => geometry()), v = g.viewport;
    ok(label + ' shell and visual viewport contain all menu edges: ' + JSON.stringify(g.menu), g.menu.left >= Math.max(v.left,g.shell.left)+7 && g.menu.right <= Math.min(v.left+v.width,g.shell.right)-7 && g.menu.top >= Math.max(v.top,g.shell.top) && g.menu.bottom <= Math.min(v.top+v.height,g.shell.bottom)+1);
    ok(label + ' all family, day/night and accent controls remain visible and clickable', !g.overflow&&g.controls.length===11&&g.controls.every(item=>item.visible&&item.clickable));
    ok(label + ' menu remains visually anchored to its trigger', g.trigger.right >= g.menu.left&&g.trigger.left <= g.menu.right&&Math.abs(g.menu.top-g.trigger.bottom)<=12);
  };
  if (process.argv.includes('--probe')) {
    await page.setViewportSize({ width:320,height:780 });await page.evaluate(() => setup({width:320}));await page.locator('.sd-theme-btn').click();console.log(JSON.stringify(await page.evaluate(()=>geometry())));
  } else {
    for (const viewport of [320,393,522,1280]) for (const family of ['classic','editorial','glass']) for (const mode of ['light','dark']) for (const anchor of ['left','right']) {
      const width = viewport===1280?360:viewport, left=viewport===1280?240:0, label=`${viewport}/${family}/${mode}/${anchor}`;
      await page.setViewportSize({width:viewport,height:780});await page.evaluate(options=>setup(options),{width,left,family,mode,anchor});await page.locator('.sd-theme-btn').click();
      if (family==='classic') await page.locator('[data-appearance-family="glass"]').click();
      await verify(label);
      if(anchor==='left')ok(label+' fixture truly anchors at the left edge',await page.locator('.sd-theme-btn').evaluate(node=>node.getBoundingClientRect().left-document.querySelector('.sd-window').getBoundingClientRect().left<35));
      if([320,393,522].includes(viewport)&&family==='glass'&&mode==='light'&&anchor==='right'){
        const g=await page.evaluate(()=>geometry());await page.screenshot({animations:'disabled',clip:{x:g.shell.left,y:g.shell.top,width:g.shell.width,height:g.menu.bottom-g.shell.top+12},path:fileURLToPath(new URL(`glass-light-${viewport}.png`,qa))});
      }
      await page.locator('.sd-theme-mode-toggle').click();ok(label+' day/night toggles without dismissing',await page.locator('.sd-theme-menu').isVisible());
      await page.locator('[data-appearance-accent="#ad7950"]').click();ok(label+' accents are actionable',await page.evaluate(()=>settings.appearance.accent==='#ad7950'));
      await page.locator('.sd-theme-custom-color').click();await verify(label+'/custom');
      const rgb=page.locator('[data-channel="r"]');await rgb.fill('119');await page.locator('[data-channel="g"]').click();ok(label+' custom editor input is reachable',await rgb.inputValue()==='119');
      await page.locator('.sd-theme-custom-color').click();
      await page.locator('.sd-body').evaluate(node=>node.scrollTop=150);await verify(label+'/body-scroll');
      await page.keyboard.press('Escape');ok(label+' Escape restores trigger focus',await page.locator('.sd-theme-btn').evaluate(node=>document.activeElement===node));
    }
    await page.setViewportSize({width:1280,height:780});await page.evaluate(()=>setup({width:520,left:400}));await page.locator('.sd-theme-btn').click();await verify('desktop original');
    await page.setViewportSize({width:393,height:780});await page.locator('.sd-window').evaluate(node=>{node.style.setProperty('--fixture-width','300px');node.style.setProperty('--fixture-left','60px');});await verify('resize to narrow offset shell');
    await page.locator('.sd-window').evaluate(node=>node.style.setProperty('--fixture-width','260px'));await verify('container-only resize');
    await page.locator('.sd-window').evaluate(node=>{node.style.setProperty('transform','translateX(12px) scale(.9)','important');window.dispatchEvent(new Event('resize'));});await verify('translated and scaled clipping shell');
    await page.setViewportSize({width:393,height:300});await page.evaluate(()=>setup({width:360}));await page.locator('.sd-theme-btn').click();
    await page.locator('.sd-theme-menu').evaluate(node=>node.style.fontSize='22px');await page.locator('.sd-theme-custom-color').click();await settle();
    ok('large text in a short viewport scrolls internally without horizontal clipping',await page.locator('.sd-theme-menu').evaluate(node=>{const r=node.getBoundingClientRect();return node.scrollHeight>node.clientHeight&&node.scrollWidth<=node.clientWidth+1&&r.bottom<=Math.min(innerHeight,document.querySelector('.sd-window').getBoundingClientRect().bottom)-7;}));
    for(const selector of ['[data-appearance-family="editorial"]','.sd-theme-mode-toggle','[data-channel="b"]']){
      const control=page.locator(selector);await control.scrollIntoViewIfNeeded();
      ok('large-text scroll reaches '+selector,await control.evaluate(node=>{const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit===node||node.contains(hit);}));
    }
    await page.setViewportSize({width:522,height:900});await page.evaluate(()=>setup({width:500,anchor:'left'}));await page.locator('.sd-theme-btn').click();
    const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1.5});await settle();await verify('scaled visual viewport');
    ok('test actually exercised a narrower visual viewport',await page.evaluate(()=>visualViewport.scale>1&&visualViewport.width<innerWidth));
    await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});await cdp.detach();
    // Headless touch scrolling does not reliably pan the visual viewport.
    // Model its published offset contract explicitly, separate from real zoom.
    await page.evaluate(()=>{window.nativeViewport=window.visualViewport;Object.defineProperty(window,'visualViewport',{configurable:true,value:{offsetLeft:20,offsetTop:120,width:360,height:300,addEventListener(){},removeEventListener(){}}});window.dispatchEvent(new Event('resize'));});await settle();
    ok('controlled visual-viewport pan keeps top and side controls inside the visible area',await page.evaluate(()=>{const g=geometry();return g.menu.top>=128&&g.menu.left>=28&&g.menu.right<=372&&g.menu.bottom<=412&&g.controls.every(item=>item.visible&&item.clickable);}));
    await page.evaluate(()=>{Object.defineProperty(window,'visualViewport',{configurable:true,value:nativeViewport});window.dispatchEvent(new Event('resize'));});await verify('viewport pan resets to trigger anchor');
    await page.evaluate(()=>{unbind();window.geometryBefore=JSON.stringify(geometry());});await page.setViewportSize({width:522,height:780});ok('disposal closes the menu',await page.locator('.sd-theme-menu').evaluate(node=>node.hidden));
    assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({passed:checks.length,errors,external,scope:'actual theme menu and appearance session in isolated clipping shells; no host state or remote requests'}));
  }
}finally{clearTimeout(deadline);await context.close();await browser.close();}
