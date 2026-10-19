// Production theme renderer, bindings, appearance actions/session and styles.
// All state is local to this synthetic shell; every external request is blocked.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const baseline = process.argv.includes('--baseline');
const baselineRef = process.env.QIANMU_COLOR_BASELINE_REF || 'bc64c50b';
const source = file => baseline
    ? Promise.resolve(execFileSync('git', ['show', `${baselineRef}:${file}`], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }))
    : readFile(new URL('../' + file, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ hasTouch: true }), page = await context.newPage(), checks = [], errors = [], screenshots = [];
const contrasts = [];
const qa = new URL('../dist/local-qa/theme-color-fields-476/', import.meta.url);
let external = 0;
const deadline = setTimeout(() => { void browser.close(); }, 120000);
const ok = (label, result) => { assert.ok(result, label); checks.push(label); };
const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
await mkdir(qa, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>' });
        if (/^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await source(url.pathname.slice(1)) });
    }
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    // ST's public/style.css input/select/button rule inherits the host's body
    // color, which may stay dark while this extension independently goes dark.
    await page.addStyleTag({ content: ':root{--SmartThemeBodyColor:rgb(32,32,32)}input,select,button{color:var(--SmartThemeBodyColor)}' });
    for (const file of ['style.css', 'qianmu-theme-skins.css']) await page.addStyleTag({ content: await source(file) });
    // Fixture positioning only; none of the picker/menu/input styling is replaced.
    await page.addStyleTag({ content: 'body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important}#story-director-modal>.sd-window{position:relative!important;inset:auto!important;transform:none!important;margin:0!important;width:100%!important;max-width:900px!important;height:100dvh!important;max-height:none!important}.fixture-following{position:fixed;bottom:10px;right:10px;z-index:2147483647}' });
    await page.evaluate(async () => {
        for (const file of ['qianmu-theme-menu', 'qianmu-appearance-settings', 'qianmu-appearance-session', 'qianmu-appearance-actions', 'qianmu-classic-palettes', 'qianmu-icon-renderer']) Object.assign(window, await import(`./${file}.js`));
        window.setup = async ({ family = 'editorial', mode = 'dark' } = {}) => {
            window.unbind?.(); window.session?.reset();
            window.settings = { theme: mode, appearance: updateAppearancePreferences({}, { family, mode, accent: '#527c69', source: 'cover' }) };
            document.body.innerHTML = `<main id="story-director-modal" class="sd-theme-${mode} open"><section class="sd-window"><header class="sd-header"><div class="sd-titlebox"><h2>千幕</h2></div><div class="sd-header-actions">${renderQianmuThemeMenu(THEMES, mode, { settings, supported: true })}<button class="sd-close" aria-label="关闭">×</button></div></header><main class="sd-body"></main></section></main><button class="fixture-following">外部操作</button>`;
            const root = document.getElementById('story-director-modal');
            window.fixture = { root, saveAttempts: 0, saves: 0, failSave: false, deferNext: false, pending: null };
            const save = () => { fixture.saveAttempts++; if (fixture.failSave) throw new Error('Isolated save failure'); fixture.saves++; };
            window.session = createQianmuAppearanceSession({ readSettings: () => settings,
                loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }),
                loadFont: () => ({ promise: Promise.resolve(false), cancel() {} }) });
            session.mount(root); await session.sync();
            window.unbind = bindQianmuThemeMenu(root,
                key => selectQianmuClassicTheme({ settings, themeKey: key, session, save, resolveLogo: () => null }),
                { read: () => ({ ...readAppearancePreferences(settings), classic: settings.theme }), status: () => session.status,
                    sync: () => session.sync(), retry: () => session.retry(), change: patch => {
                        const result = changeQianmuAppearance({ settings, patch, session, save });
                        if (!fixture.deferNext) return result;
                        fixture.deferNext = false;
                        return Promise.resolve(result).then(() => new Promise(resolve => { fixture.pending = resolve; }));
                    } });
            applyQianmuIcons(root);
        };
        window.fieldState = () => {
            const fields = [...document.querySelectorAll('.sd-theme-rgb input')], menu = document.querySelector('.sd-theme-menu'), hue = document.querySelector('.sd-theme-hue');
            const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
            const rgba = value => { const rgb=value.match(/[\d.]+/g)?.map(Number)||[0,0,0,0];return [...rgb.slice(0,3),rgb[3]??1]; };
            const over = (front,back) => [...front.slice(0,3).map((value,i)=>value*front[3]+back[i]*(1-front[3])),1];
            const backdrop = node => { const layers=[];for(let current=node;current;current=current.parentElement)layers.unshift(rgba(getComputedStyle(current).backgroundColor));return layers.reduce((base,layer)=>over(layer,base),[255,255,255,1]); };
            const luminance = rgb => rgb.slice(0,3).reduce((sum,value,i)=>{const c=value/255;return sum+(c<=.04045?c/12.92:((c+.055)/1.055)**2.4)*[.2126,.7152,.0722][i];},0);
            const contrast = node => { const bg=backdrop(node),fg=over(rgba(getComputedStyle(node).webkitTextFillColor),bg),a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); };
            const channels = [...document.querySelectorAll('[data-channel]')].map(node => node.value);
            return { accent: readAppearancePreferences(settings).accent, source: readAppearancePreferences(settings).source,
                attempts: fixture.saveAttempts, saves: fixture.saves, channels, hex: document.querySelector('.sd-theme-hex')?.value,
                native: document.querySelector('.sd-theme-color').value,
                sv: document.querySelector('.sd-theme-sv').style.backgroundImage,
                svRect: rect(document.querySelector('.sd-theme-sv')),
                hue: hue ? { value: Number(hue.value), min:hue.min, max:hue.max, step:hue.step, rect:rect(hue), thumb:hue.style.getPropertyValue('--sd-hue-thumb'), label:hue.getAttribute('aria-label'), background:getComputedStyle(hue).backgroundColor } : null,
                marker: [document.querySelector('.sd-theme-sv i').style.left, document.querySelector('.sd-theme-sv i').style.top],
                fields: fields.map(node => { const css = getComputedStyle(node), r = rect(node), hit = document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                    return { value:node.value, rect:r, color:css.color, fill:css.webkitTextFillColor, background:css.backgroundColor,
                        font:css.fontSize, contrast:contrast(node), textFits:node.scrollWidth<=node.clientWidth+1, clickable:node===hit }; }),
                menu: rect(menu), overflow:menu.scrollWidth>menu.clientWidth+1, hidden:menu.hidden,
                active: document.activeElement?.dataset.channel || document.activeElement?.className,
                error: document.querySelector('.sd-theme-status').textContent };
        };
    });
    const trigger = page.locator('.sd-theme-btn'), custom = page.locator('.sd-theme-custom-color'), hex = page.locator('.sd-theme-hex'), hue = page.locator('.sd-theme-hue');
    const channel = name => page.locator(`[data-channel="${name}"]`);
    const state = () => page.evaluate(() => fieldState());
    const open = async options => { await page.evaluate(options => setup(options), options); await trigger.click(); await custom.click(); await settled(); };
    if (baseline) {
        await page.setViewportSize({ width:393, height:780 });
        for (const family of ['editorial','glass']) { await open({family,mode:'dark'}); const s=await state();ok('baseline '+family+' detects host-dark-text failure on dark RGB fields',s.fields.some(field=>field.contrast<4.5));console.log(JSON.stringify({baseline:family,...s})); }
    } else {
        for (const width of [320,393,1100]) for (const family of ['classic','editorial','glass']) for (const mode of ['light','dark']) {
            const label = `${width}/${family}/${mode}`;
            await page.setViewportSize({ width, height:780 });
            await page.evaluate(options => setup(options), {family,mode}); await trigger.click();
            if (family === 'classic') {
                ok(label+' keeps classic palette without custom editor', await page.locator('.sd-theme-classic-options').isVisible() && !await custom.isVisible() && !await hex.isVisible());
                continue;
            }
            await custom.click(); await settled(); let s = await state();
            ok(label+' shows labelled HSV hue range with SV/preset dots', await hue.isVisible() && s.hue.min==='0' && s.hue.max==='360' && s.hue.step==='1' && s.hue.label==='色相' && await page.locator('.sd-theme-sv').isVisible() && await page.locator('[data-appearance-accent]').count()===6);
            ok(label+' hue fits between SV and RGB without clipping its endpoints', s.hue.rect.top>=s.svRect.bottom-1 && s.hue.rect.bottom<=s.fields[0].rect.top+1 && Math.abs(s.hue.rect.width-s.svRect.width)<1 && s.hue.rect.left>=s.menu.left+12 && s.hue.rect.right<=s.menu.right-12 && s.hue.rect.height>=24 && !s.overflow);
            ok(label+' hue hit area stays transparent instead of inheriting the generic range background', s.hue.background==='rgba(0, 0, 0, 0)');
            ok(label+' RGB and Hex fit one compact clickable row', s.fields.length===4 && s.fields.every(field=>field.rect.top===s.fields[0].rect.top && field.rect.height<=30 && field.clickable && field.textFits) && !s.overflow && s.fields[0].rect.left>=s.menu.left && s.fields[3].rect.right<=s.menu.right);
            ok(label+' themed text-fill has at least 4.5:1 contrast after alpha composition', s.fields.every(field=>field.color===field.fill&&field.contrast>=4.5));
            contrasts.push({label,minimum:Math.min(...s.fields.map(field=>field.contrast))});
            for (const [name,value] of [['r','200'],['g','74'],['b','110']]) { await channel(name).fill(value); await channel(name).press('Enter'); }
            s=await state(); ok(label+' RGB commits synchronize Hex/native/SV and switch to manual', s.accent==='#c84a6e'&&s.hex==='#c84a6e'&&s.native==='#c84a6e'&&s.source==='manual');
            const beforeSv=s.sv;
            await hex.fill('#0Cf'); await hex.press('Enter'); s=await state();
            ok(label+' #RGB synchronizes hue slider and numeric/SV views', s.accent==='#00ccff'&&s.hex==='#00ccff'&&s.native==='#00ccff'&&s.channels.join(',')==='0,204,255'&&s.sv!==beforeSv&&s.hue.value===192);
            await hex.fill('#ff0000'); await hex.press('Enter'); await hue.focus(); await hue.press('End'); s=await state();
            ok(label+' keyboard End keeps true red at hue 360 rather than magenta', s.hue.value===360&&s.hex==='#ff0000'&&s.accent==='#ff0000'&&s.hue.thumb==='hsl(360 100% 50%)');
            await hue.press('Home'); await hue.press('ArrowRight'); s=await state();
            ok(label+' native Home/Arrow keys update hue, RGB and Hex together', s.hue.value===1&&s.accent==='#ff0400'&&s.hex===s.accent&&s.native===s.accent&&s.channels.join(',')==='255,4,0'&&!s.hidden);
            await hex.fill('#527C69'); await hex.press('Enter'); s=await state();
            ok(label+' #RRGGBB canonicalizes and synchronizes numeric channels', s.accent==='#527c69'&&s.hex==='#527c69'&&s.channels.join(',')==='82,124,105');
            if ((width===393&&family==='editorial'&&mode==='dark')||(width===320&&family==='glass'&&mode==='dark')||(width===393&&family==='editorial'&&mode==='light')) {
                await page.locator('.sd-theme-custom-picker').click({position:{x:4,y:4}});
                const m=(await state()).menu, filename=`${family}_${mode}_${width}.png`;
                await page.screenshot({ path:fileURLToPath(new URL(filename,qa)), clip:{x:0,y:0,width:Math.min(width,900),height:Math.ceil(m.bottom+12)} }); screenshots.push(filename);
            }
        }
        await page.setViewportSize({width:393,height:780}); await open({family:'glass',mode:'dark'});
        const hostFill=await page.addStyleTag({content:'input{-webkit-text-fill-color:rgb(32,32,32)}'});
        ok('night inputs override inherited host text-fill as well as color',(await state()).fields.every(field=>field.color===field.fill&&field.contrast>=4.5));
        await hostFill.evaluate(node=>node.remove());
        // Invalid or partial drafts cannot change the active color or cover/manual source.
        for (const value of ['', '#', '#12', '#1234', '#12345', '#gggggg']) {
            const before=await state(); await hex.fill(value); await hex.press('Enter'); await hex.press('Tab'); const after=await state();
            ok(`invalid Hex ${JSON.stringify(value)} makes no write`, after.accent===before.accent&&after.attempts===before.attempts&&after.source===before.source);
            await trigger.click(); await custom.click();
        }
        await open({family:'editorial',mode:'dark'});
        for (const value of ['', '-1', '256', '1.5', '1e2']) {
            const before=await state(); await channel('r').fill(value); await channel('r').press('Enter'); await channel('r').press('Tab'); const after=await state();
            ok(`invalid RGB ${JSON.stringify(value)} makes no write`, after.accent===before.accent&&after.attempts===before.attempts&&after.source===before.source);
        }
        await channel('r').fill('255'); await channel('r').press('Tab');
        ok('R Tab commits and focuses G without closing picker', (await state()).active==='g' && !(await state()).hidden);
        await page.keyboard.press('Tab'); ok('G Tab focuses B', (await state()).active==='b');
        await page.keyboard.press('Tab'); ok('B Tab focuses Hex', (await state()).active==='sd-theme-hex');
        await page.keyboard.press('Shift+Tab'); ok('Hex Shift+Tab returns to B', (await state()).active==='b');
        await hex.fill('#123456'); const beforeEnter=(await state()).attempts; await hex.press('Enter'); await hex.press('Tab');
        ok('Enter followed by blur commits once and Tab out closes without stealing focus', (await state()).attempts===beforeEnter+1 && (await state()).hidden && (await state()).active==='sd-close');
        await trigger.click(); await custom.click(); await hex.focus(); await page.keyboard.press('Escape');
        ok('Escape closes and restores theme trigger focus', (await state()).hidden && (await state()).active==='sd-theme-btn');
        await open({family:'glass',mode:'dark'});
        await page.evaluate(()=>{fixture.deferNext=true;}); await channel('r').fill('90'); await channel('r').press('Enter');
        await page.waitForFunction(()=>typeof fixture.pending==='function'); await hex.fill('#12');
        await page.evaluate(()=>fixture.pending()); await settled();
        ok('late appearance settlement retains unfinished focused Hex draft', (await state()).hex==='#12' && (await state()).accent==='#5a7c69');
        await open({family:'editorial',mode:'dark'}); await page.evaluate(()=>{fixture.failSave=true;});
        await hex.fill('#c84e78'); await hex.press('Enter'); await hex.press('Tab'); let s=await state();
        ok('failed Hex save restores RGB/Hex/source and trailing change cannot clear failure', s.attempts===1&&s.saves===0&&s.accent==='#527c69'&&s.hex==='#527c69'&&s.channels.join(',')==='82,124,105'&&s.source==='cover'&&!!s.error);
        await trigger.click(); await custom.click(); await page.evaluate(()=>{fixture.failSave=false;});
        await hex.fill('#8b584a'); await hex.press('Enter'); s=await state();
        ok('new valid color after failure can retry once', s.saves===1&&s.accent==='#8b584a'&&!s.error);
        const beforePointer=s.accent; const box=await page.locator('.sd-theme-sv').boundingBox();
        await page.locator('.sd-theme-sv').click({position:{x:box.width*.72,y:box.height*.28}}); s=await state();
        ok('SV surface remains interactive and synchronizes both representations', s.accent!==beforePointer&&s.hex===s.accent&&s.native===s.accent);
        await hex.fill('#00ff00'); await hex.press('Enter'); await hex.fill('#000000'); await hex.press('Enter'); s=await state();
        ok('black keeps the prior hue and saturation editing coordinates',s.hue.value===120&&s.marker[0]==='100%'&&s.marker[1]==='100%');
        await hue.focus(); await hue.press('End'); await page.locator('.sd-theme-sv').focus(); await page.keyboard.press('Shift+ArrowUp'); s=await state();
        ok('hue selected while black is used when keyboard SV restores brightness',s.hue.value===360&&s.hex==='#1a0000'&&s.accent===s.hex&&s.native===s.hex);
        await hex.fill('#808080'); await hex.press('Enter'); await hue.focus(); await hue.press('Home'); await hue.press('ArrowRight'); s=await state();
        ok('neutral gray retains selected hue without inventing saturation',s.hue.value===1&&s.hex==='#808080'&&s.marker[0]==='0%');
        await hex.fill('#ff0000'); await hex.press('Enter');
        const beforeBurst=(await state()).attempts;
        const burst=await page.evaluate(()=>{const input=document.querySelector('.sd-theme-hue');for(let value=1;value<=120;value++){input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));}return {attempts:fixture.saveAttempts,hex:document.querySelector('.sd-theme-hex').value};});
        ok('a burst of pointer-like hue inputs updates preview without repeated synchronous saves',burst.attempts===beforeBurst&&burst.hex==='#00ff00');
        await settled();s=await state();ok('one paint commits only the final queued hue',s.attempts===beforeBurst+1&&s.accent==='#00ff00'&&s.hue.value===120);
        const touchHue=await hue.boundingBox();await page.touchscreen.tap(touchHue.x+touchHue.width*.72,touchHue.y+touchHue.height/2);await settled();s=await state();
        ok('native hue range accepts touch and synchronizes the chosen color',s.hue.value>200&&s.hue.value<300&&s.accent===s.hex&&s.native===s.hex);
        const touchSv=await page.locator('.sd-theme-sv').boundingBox();const beforeTouch=s.accent;
        await page.touchscreen.tap(touchSv.x+touchSv.width*.55,touchSv.y+touchSv.height*.35);await settled();s=await state();
        ok('touch SV updates channels and releases its pointer capture',s.accent!==beforeTouch&&s.accent===s.hex&&s.native===s.hex);
        await hex.fill('#ff0000');await hex.press('Enter');await hue.focus();await hue.press('End');
        await page.evaluate(()=>{fixture.failSave=true;});const beforeHueFailure=(await state()).attempts;
        await hue.press('ArrowLeft');s=await state();
        ok('failed native hue input/change restores hue endpoint, RGB and source with error retained',s.attempts===beforeHueFailure+1&&s.hue.value===360&&s.accent==='#ff0000'&&s.hex==='#ff0000'&&s.channels.join(',')==='255,0,0'&&!!s.error);
        await page.evaluate(()=>{fixture.failSave=false;});await hue.press('ArrowLeft');s=await state();
        ok('valid hue retry clears failure and commits once',s.attempts===beforeHueFailure+2&&s.hue.value===359&&s.accent==='#ff0004'&&!s.error);
        const beforeAbandon=s;
        await page.evaluate(()=>{const input=document.querySelector('.sd-theme-hue');input.value='180';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.sd-theme-btn').click();});await settled();s=await state();
        ok('closing before a queued paint cancels that color update',s.hidden&&s.attempts===beforeAbandon.attempts&&s.accent===beforeAbandon.accent&&s.hue.value===359);
        await trigger.click();await custom.click();
        await page.locator('[data-appearance-accent="#7b65a7"]').click(); s=await state();
        ok('preset dot updates RGB and Hex without closing editor', s.accent==='#7b65a7'&&s.hex==='#7b65a7'&&s.channels.join(',')==='123,101,167'&&await hex.isVisible());
        await page.locator('.fixture-following').click(); ok('outside click closes without stealing destination focus',(await state()).hidden&&(await state()).active==='fixture-following');
        await trigger.click();await custom.click(); const beforeDispose=(await state()).attempts;
        await page.evaluate(()=>{const input=document.querySelector('.sd-theme-hex'),hue=document.querySelector('.sd-theme-hue');hue.value='180';hue.dispatchEvent(new Event('input',{bubbles:true}));unbind();unbind();hue.value='240';hue.dispatchEvent(new Event('input',{bubbles:true}));hue.dispatchEvent(new Event('change',{bubbles:true}));input.value='#123abc';input.dispatchEvent(new Event('change',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));for(const node of document.querySelectorAll('[data-channel]')){node.value='42';node.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('.sd-theme-sv').dispatchEvent(new PointerEvent('pointerdown',{clientX:100,clientY:100,bubbles:true}));});await settled();
        ok('dispose removes color field, pointer and keyboard actions', (await state()).attempts===beforeDispose&&(await state()).hidden);
    }
    ok('no page errors or external requests', errors.length===0&&external===0);
    console.log(JSON.stringify({pass:checks.length,fail:0,errors,external,screenshots,contrasts,checks},null,2));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
