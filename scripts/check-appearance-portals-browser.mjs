// Actual reader/theater/storage/TTS portal functions, isolated host services.
// Storage choosers are cancelled; no deletion, provider request or real media runs.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const constants=vm.runInNewContext(source.slice(source.indexOf('const READER_PORTAL_VARS ='),source.indexOf('// 打开阅读器时把该书正文'))+';({READER_PORTAL_VARS,READER_PORTAL_BG})');
const names=['mountReaderPortal','openTheaterFullscreen','unmountTheaterFullscreen','theaterFullscreenEsc','openStorageCleanupDialog','openStorageChatCleanupDialog','ttsOpenQuickPopup','ttsCloseQuickPopup','ttsPopupOutside'];
const code=names.map(storyboardFunctionSource).join('\n')+`;Object.assign(window,{${names.join(',')}});`;
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),checks=[],errors=[];let external=0;
const screenshots=process.env.QIANMU_PORTAL_SCREENSHOT_DIR;if(screenshots)await mkdir(screenshots,{recursive:true});
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
    const url=route.request().url();
    if(url==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'});
    const file=url.replace('https://qianmu.test/','');
    if(['qianmu-appearance-session.js','qianmu-appearance-runtime.js','qianmu-appearance-settings.js','qianmu-appearance-portals.js','qianmu-theme-surfaces.js','qianmu-theme-palette.js','qianmu-storage-backup-view.js'].includes(file))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
    external++;return route.abort();
});
try{
    await page.goto('https://qianmu.test/');
    for(const file of ['style.css','qianmu-theme-skins.css'])await page.addStyleTag({content:await readFile(new URL('../'+file,import.meta.url),'utf8')});
    await page.evaluate(async({code,constants})=>{
        const noop=()=>{};Object.assign(window,constants,await import('./qianmu-appearance-session.js'),await import('./qianmu-appearance-settings.js'),await import('./qianmu-appearance-portals.js'),await import('./qianmu-theme-surfaces.js'),await import('./qianmu-storage-backup-view.js'),{
            MODAL_ID:'story-director-modal',THEME_KEYS:['light','dark','summer','candy','kraft','dream'],STORAGE_CLEANUP_LAYER_ID:'qianmu-storage-cleanup-layer',
            NOTES_THEME_VARIABLES:['--sd-text','--sd-muted','--sd-border','--sd-hairline','--sd-glass','--sd-glass-weak','--sd-card','--sd-folder-head','--sd-sticky-bg','--sd-pre','--sd-input-bg','--sd-accent','--sd-primary','--sd-primary-text'],
            STORAGE_ITEM_RISK:{},STORAGE_CHAT_CLEARABLE:new Set(['notes']),getChatKey:()=> 'isolated-chat',storageChatScopeLabel:key=>key,formatStorageBytes:bytes=>`${bytes} B`,
            settings:{theme:'light'},readerPortalNode:null,ttsPopupEl:null,applyQianmuIcons:noop,THEATER_READ_TITLE:'隔离阅读',
            htmlEscape:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
            unmountReaderPortal:()=>{document.getElementById('sd-reader-portal')?.remove();readerPortalNode=null;},
            extractTheaterBody:value=>value,getTheater:()=>({readerFontScale:'medium'}),looksLikeHtml:()=>false,renderTheaterMarkdown:value=>`<p>${value}</p>`.repeat(45),theaterSubtitle:()=> '隔离场景',
            ttsResolveLineFromBtn:()=>({mesEl:document.getElementById('story-director-modal'),idx:0,line:{speaker:'fixture',text:'台词',speed:1,emotion:'auto'}}),
            ttsProviderConfig:()=>({defaultSpeed:1}),ttsProviderId:()=> 'fixture',ttsProviderSupports:()=>true,getTtsProvider:()=>({speedRange:{min:.5,max:2,step:.05}}),
            getTtsEmotionOptions:()=>[{value:'auto',label:'自动'},{value:'happy',label:'喜悦'}],ttsSyncFavoriteButton:noop,
            ttsPlayResolvedLine:()=>{throw Error('Provider must never run');},ttsDownloadLine:()=>{throw Error('Download must never run');},ttsFavoriteLine:()=>{throw Error('Persistence must never run');},
        });
        new Function(code)();
    },{code,constants});
    for(const width of [393,1280])for(const classic of ['light','dark','summer','candy','kraft','dream']){
        await page.setViewportSize({width,height:900});
        const probe=await page.evaluate(classic=>{
            document.body.innerHTML=`<div id="story-director-modal" class="sd-theme-${classic}"></div>`;const main=document.getElementById(MODAL_ID),computed=getComputedStyle(main);
            const expected=Object.fromEntries(QIANMU_THEME_PROPERTIES.map(key=>[key,computed.getPropertyValue(key).trim()]));
            const portal=document.createElement('div');for(const key of QIANMU_THEME_PROPERTIES)portal.style.setProperty(key,'copied-new-color');portal.style.setProperty('--sd-font','untouched');document.body.append(portal);
            prepareQianmuPortalBaseline(portal,classic);
            const actual=Object.fromEntries(QIANMU_THEME_PROPERTIES.map(key=>[key,portal.style.getPropertyValue(key).trim()]));
            return {expected,actual,probes:document.querySelectorAll('.qm-classic-theme-probe').length,mainCount:document.querySelectorAll('#story-director-modal').length,font:portal.style.getPropertyValue('--sd-font')};
        },classic);assert.deepEqual(probe.actual,probe.expected);assert.equal(probe.probes,0);assert.equal(probe.mainCount,1);assert.equal(probe.font,'untouched');checks.push(`${width}/${classic}: clean probe matches actual classic root without duplicate ID`);
    }
    let sequence=0;
    for(const width of [393,1280])for(const family of ['editorial','glass'])for(const mode of ['light','dark']){
        await page.setViewportSize({width,height:900});const classic=['light','dark','summer','candy','kraft','dream'][sequence++%6];
        const mounted=await page.evaluate(async({family,mode,classic})=>{
            window.appearanceSession?.reset();ttsCloseQuickPopup();unmountTheaterFullscreen();unmountReaderPortal();
            document.body.innerHTML=`<div id="story-director-modal" class="sd-theme-${classic} open"><button id="tts-anchor" style="position:fixed;left:15px;top:15px">TTS</button></div>`;
            settings={theme:classic,appearance:updateAppearancePreferences({}, {family,mode,source:'manual',accent:'#567'})};
            appearanceSession=createQianmuAppearanceSession({readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});
            appearanceSession.mount(document.getElementById(MODAL_ID));await appearanceSession.sync();
            mountReaderPortal('<div class="sd-reader-stage"><div class="sd-reader-body"><textarea>未保存阅读批注</textarea><div style="height:1700px">隔离正文</div></div></div>');
            openTheaterFullscreen({content:'隔离正文',isHtml:false});
            window.storageResult=openStorageCleanupDialog({idb:{stores:[{name:'notes',label:'便笺',bytes:5,count:1}]}});
            ttsOpenQuickPopup(document.getElementById('tts-anchor'));
            const reader=document.getElementById('sd-reader-portal'),theater=document.getElementById('sd-theater-portal'),storage=document.getElementById(STORAGE_CLEANUP_LAYER_ID),tts=ttsPopupEl;
            const readerScroll=reader.querySelector('.sd-reader-body'),theaterScroll=theater.querySelector('.sd-theater-fs-body');readerScroll.scrollTop=75;theaterScroll.scrollTop=90;
            const checkbox=storage.querySelector('input:not(:disabled)');checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));
            const input=reader.querySelector('textarea');input.focus();input.setSelectionRange(1,5);tts.querySelector('select').value='happy';
            window.portalFixture={reader,theater,storage,tts,input,readerScroll,theaterScroll,checkbox};
            return {roots:[reader,theater,storage,tts].map(node=>[node.dataset.qmTheme,node.dataset.qmMode]),disabled:storage.querySelector('.sd-storage-cleanup-confirm').disabled,probes:document.querySelectorAll('.qm-classic-theme-probe').length};
        },{family,mode,classic});
        assert.deepEqual(mounted.roots,Array(4).fill([family,mode]));assert.equal(mounted.disabled,false);assert.equal(mounted.probes,0);checks.push(`${width}/${family}/${mode}: actual reader/theater/storage/TTS mounts inherit theme`);
        const changed=await page.evaluate(async()=>{
            const f=portalFixture,before=[f.readerScroll.scrollTop,f.theaterScroll.scrollTop],nodes=[f.input,f.checkbox,f.tts.querySelector('select')];
            settings.appearance=updateAppearancePreferences(settings,{mode:settings.appearance.mode==='light'?'dark':'light'});await appearanceSession.sync();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            const opaque=[f.reader,f.theater].every(node=>{const expected=document.createElement('i');expected.style.color=node.style.getPropertyValue('--qm-bg');return getComputedStyle(node).backgroundColor===expected.style.color;});
            return {same:nodes.every(node=>node.isConnected),focus:document.activeElement===f.input,selection:[f.input.selectionStart,f.input.selectionEnd],before,after:[f.readerScroll.scrollTop,f.theaterScroll.scrollTop],checked:f.checkbox.checked,emotion:f.tts.querySelector('select').value,opaque};
        });assert.equal(changed.same,true);assert.equal(changed.focus,true);assert.deepEqual(changed.selection,[1,5]);assert.deepEqual(changed.after,changed.before);assert.equal(changed.checked,true);assert.equal(changed.emotion,'happy');assert.equal(changed.opaque,true);checks.push(`${width}/${family}/${mode}: scroll/drafts/selection/TTS state retained, reading stays opaque`);
        if(screenshots&&((width===393&&family==='glass'&&mode==='dark')||(width===1280&&family==='editorial'&&mode==='light'))){
            for(const target of ['reader','theater','storage','tts']){
                await page.evaluate(target=>{for(const key of ['reader','theater','storage','tts'])portalFixture[key].style.visibility=key===target?'visible':'hidden';},target);
                await page.screenshot({path:path.join(screenshots,`${width}_${family}_${mode==='dark'?'light':'dark'}_${target}.png`)});
            }
            await page.evaluate(()=>{for(const key of ['reader','theater','storage','tts'])portalFixture[key].style.removeProperty('visibility');});
        }
        const restored=await page.evaluate(async()=>{
            const f=portalFixture;settings.appearance=updateAppearancePreferences(settings,{family:'classic'});await appearanceSession.sync();
            const expected=getComputedStyle(document.getElementById(MODAL_ID)).getPropertyValue('--sd-text').trim();
            const result={themes:[f.reader,f.theater,f.storage,f.tts].map(node=>node.dataset.qmTheme||''),text:[f.reader,f.theater,f.storage,f.tts].map(node=>getComputedStyle(node).getPropertyValue('--sd-text').trim()),expected,readerBackground:f.reader.style.getPropertyValue('--sd-portal-bg'),expectedBackground:READER_PORTAL_BG[settings.theme]};
            f.storage.querySelector('.sd-storage-cleanup-cancel').click();result.cancelled=await storageResult;
            ttsCloseQuickPopup();unmountTheaterFullscreen();unmountReaderPortal();await appearanceSession.sync();result.remaining=appearanceSession.size;appearanceSession.reset();return result;
        });assert.deepEqual(restored.themes,['','','','']);assert.ok(restored.text.every(value=>value===restored.expected));assert.equal(restored.readerBackground,restored.expectedBackground);assert.equal(restored.cancelled,null);assert.equal(restored.remaining,1);checks.push(`${width}/${family}/${mode}: all real portals return to clean classic and release after cancel/close`);
    }
    const media=await page.evaluate(async()=>{
        document.body.innerHTML='<div class="sd-storyboard-lightbox"><div class="sd-storyboard-lightbox-stage"><img alt="fixture"></div><footer><span>中性观片区</span><button class="sd-btn">详情</button></footer></div>';
        const root=document.querySelector('.sd-storyboard-lightbox'),before=getComputedStyle(root).backgroundColor,image=root.querySelector('img');
        settings={appearance:updateAppearancePreferences({},{family:'glass',mode:'light'})};appearanceSession=createQianmuAppearanceSession({readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});appearanceSession.mountPortal(root,{role:'media'});await appearanceSession.sync();
        const result={mode:root.dataset.qmMode,background:getComputedStyle(root).backgroundColor,before,same:root.querySelector('img')===image};appearanceSession.reset();return result;
    });assert.equal(media.mode,'dark');assert.equal(media.background,media.before);assert.equal(media.same,true);checks.push('neutral media canvas and image node stay unchanged under daylight appearance');
    assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({passed:checks.length,checks,errors,external,productionDataRead:false,scope:'actual reader/theater/storage/TTS mount functions with isolated host services; media canvas is a CSS fixture; no deletion or paid request'}));
}finally{await context.close();await browser.close();}
