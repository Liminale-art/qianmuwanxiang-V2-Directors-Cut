import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {focusDefaults,focusFunctions} from '../tests/helpers/focus-lock-fixture.mjs';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';

const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const guardSource=await readFile(new URL('../qianmu-focus-lock.js',import.meta.url),'utf8');
const iconSource=await readFile(new URL('../qianmu-icon-renderer.js',import.meta.url),'utf8');
const functions=focusFunctions+'\n'+['focusClockAttachLock','focusClockUpdateDom','focusClockRuntimeTick','renderFocusClockTab','bindFocusClockEvents'].map(section).join('\n');
await mkdir(new URL('../dist/local-qa/',import.meta.url),{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext({hasTouch:true});let external=0;const errors=[];
await context.route('**/*',r=>{external++;return r.abort();});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
try{
  await page.setContent(`<style>${css}</style><style>body{margin:0;background:#202328}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;box-sizing:border-box;padding:8px}#sd-reader-portal{position:fixed;inset:0;background:#222;color:white;padding:24px;box-sizing:border-box}#reading-space{height:70vh;overflow:auto}.sd-focus-ring{margin-inline:auto}button{cursor:pointer}</style><main id="host"><button id="host-chat">ST聊天</button></main><div id="pre-disabled" inert>原本不可用</div><div id="story-director-modal" class="open sd-theme-dark"></div>`);
  await page.evaluate(({defaults,functions,guardSource,iconSource})=>{
    window.eval(guardSource.replaceAll('export ',''));window.eval(iconSource.replaceAll('export ',''));
    window.MODAL_ID='story-director-modal';window.settings={enabled:true,focusClock:structuredClone(defaults)};window.DEFAULT_SETTINGS={focusClock:defaults};window.activeTab='focus';
    window.focusClockState=()=>settings.focusClock;window.focusClockLockOwner='browser-test';window.focusClockOwnerId=()=>focusClockLockOwner;
    window.focusClockEntryBusy=false;window.focusClockLockGuard=null;window.focusClockLockConfirming=false;window.focusClockVoicePrepareSeq=0;
    window.FOCUS_CLOCK_PHASES={focus:{label:'专注',icon:'fa-seedling',setting:'focusMinutes'},shortBreak:{label:'小憩',icon:'fa-mug-hot',setting:'shortBreakMinutes'},longBreak:{label:'长休',icon:'fa-cloud-moon',setting:'longBreakMinutes'}};
    window.FOCUS_CLOCK_WEEK_ENTRY_LIMIT=160;window.FOCUS_CLOCK_RELATIONS={};window.FOCUS_CLOCK_VOICE_FREQUENCIES={};window.FOCUS_CLOCK_SOUND_PRESETS={};
    window.coreadBookMeta=id=>id==='book'?{id,title:'测试书籍',progress:20}:null;window.coread=()=>({books:[coreadBookMeta('book')]});
    window.focusClockVoiceContext=()=>({enabled:false,options:[]});window.focusClockVoiceDrawerRows=()=>[];
    window.focusClockTodayHistory=()=>[];window.focusClockWeekStats=()=>({days:Array.from({length:7},()=>({minutes:0})),history:[],minutes:0,count:0,readingMinutes:0});
    window.focusClockWeekStart=()=>new Date();window.htmlEscape=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    window.focusClockPrimeSound=()=>{};window.focusClockPrepareVoiceCues=()=>{};window.focusClockPlayCompletionAlert=()=>{};
    window.startFocusClockRuntime=()=>{};window.focusClockMaybePlayMidCue=()=>{};window.focusClockOpenVoiceDrawer=()=>{};window.focusClockSyncPreviewButton=()=>{};
    window.saveSettings=()=>{};let uidCount=0;window.uid=()=>`fixture-${++uidCount}`;window.notices=[];window.toast=x=>notices.push(x);window.confirmDialog=async()=>true;
    window.readerView=null;window.readerContentCache=null;window.ensureCoreadReaderRuntime=async()=>{};window.coreadPendingChatImages=()=>[];window.coreadSaveProgress=()=>{};
    window.isModalOpen=()=>document.getElementById(MODAL_ID)?.classList.contains('open');window.openModal=()=>renderModal();
    window.unmountReaderPortal=()=>document.getElementById('sd-reader-portal')?.remove();
    window.refreshReaderPortal=()=>{unmountReaderPortal();const portal=document.createElement('div');portal.id='sd-reader-portal';portal.innerHTML='<button class="sd-reader-back">返回书架</button><button id="reader-timer">计时</button><button id="reader-popup">选择书友</button><div class="sd-reader-body" id="reading-space"><p>正文仍可阅读</p><textarea class="sd-reader-dialog-ta"></textarea></div>';document.body.append(portal);portal.querySelector('#reader-timer').onclick=()=>focusClockShowPanel();portal.querySelector('#reader-popup').onclick=()=>{const dialog=document.createElement('dialog');dialog.className='popup';dialog.innerHTML='<select><option>A</option><option>B</option></select><button>完成</button>';dialog.querySelector('button').onclick=()=>dialog.remove();document.body.append(dialog);dialog.showModal();};focusClockLockGuard?.sync();};
    window.coreadOpenBook=async id=>{readerView={bookId:id,companionAvatar:'A',companionScope:'A::book',userPersona:{key:'U'}};readerContentCache={bookId:id};activeTab='coread';refreshReaderPortal();};
    window.eval(functions);
    window.renderModal=()=>{const root=document.getElementById(MODAL_ID);root.innerHTML='<section class="sd-window"><header class="sd-header"><button id="other-page">其它模块</button></header><div class="sd-body">'+renderFocusClockTab()+'</div></section>';bindFocusClockEvents(root);applyQianmuIcons(root);focusClockLockGuard?.sync();};
    window.hostClicks=0;document.getElementById('host-chat').onclick=()=>hostClicks++;
    window.reset=()=>{focusClockLockGuard?.dispose();focusClockLockGuard=null;settings.focusClock=structuredClone(defaults);settings.focusClock.soundEnabled=false;activeTab='focus';readerView=null;readerContentCache=null;unmountReaderPortal();renderModal();};reset();
  },{defaults:focusDefaults,functions,guardSource,iconSource});
  const layouts=[];
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:850});await page.evaluate(()=>reset());
    const actions=await page.locator('.sd-focus-actions').boundingBox(),lock=await page.locator('.sd-focus-lock').boundingBox();
    await page.locator('.sd-focus-hero').screenshot({path:fileURLToPath(new URL(`../dist/local-qa/focus-hero-${width}.png`,import.meta.url))});
    assert.ok(lock.x>=actions.x&&lock.x+lock.width<=actions.x+actions.width+1,JSON.stringify({actions,lock}));assert.equal(await page.locator('.sd-focus-lock svg').count(),1);
    await page.locator('.sd-focus-lock').tap();
    assert.equal(await page.locator('#host').evaluate(n=>n.inert),true);assert.equal(await page.locator('.sd-focus-main').isDisabled(),true);
    await page.evaluate(()=>{document.getElementById('host-chat').click();focusClockPause();focusClockReset();});assert.equal(await page.evaluate(()=>hostClicks),0);assert.equal(await page.evaluate(()=>settings.focusClock.status),'running');
    await page.locator('.sd-focus-ring').screenshot({path:fileURLToPath(new URL(`../dist/local-qa/focus-lock-${width}.png`,import.meta.url))});
    await page.evaluate(()=>{settings.focusClock.endsAt=Date.now()-1;focusClockRuntimeTick();});
    assert.equal(await page.locator('#host').evaluate(n=>n.inert),false);assert.equal(await page.locator('#pre-disabled').evaluate(n=>n.inert),true);
    assert.equal(await page.locator('.sd-focus-main').isDisabled(),false);assert.equal(await page.evaluate(()=>settings.focusClock.history.length),1);
    await page.evaluate(()=>{reset();settings.focusClock.activity='reading';settings.focusClock.bookId='book';renderModal();});
    await page.locator('.sd-focus-lock').tap();assert.equal(await page.locator('#sd-reader-portal').count(),1);
    const initial=await page.evaluate(()=>settings.focusClock.endsAt);await page.locator('.sd-reader-dialog-ta').fill('暂未发送');
    await page.locator('#reader-timer').tap();assert.equal(await page.locator('#sd-reader-portal').count(),1,'unsent input must not be discarded');
    await page.locator('.sd-reader-dialog-ta').fill('');await page.locator('#reader-popup').tap();await page.locator('dialog select').selectOption({label:'B'});await page.locator('dialog button').tap();
    await page.locator('#reader-timer').tap();assert.equal(await page.locator('#sd-reader-portal').count(),0);await page.locator('.sd-focus-open-reading').tap();
    assert.equal(await page.locator('#sd-reader-portal').count(),1);assert.equal(await page.evaluate(()=>settings.focusClock.endsAt),initial);
    // Keep a toast/dialog alive while the actual focus surfaces vanish: still fail open.
    await page.evaluate(()=>{const toast=document.createElement('div');toast.id='toast-container';document.body.append(toast);unmountReaderPortal();document.getElementById(MODAL_ID).classList.remove('open');focusClockLockGuard.sync();});
    assert.equal(await page.locator('#host').evaluate(n=>n.inert),false);assert.equal(await page.evaluate(()=>settings.focusClock.lock),null);
    assert.equal(await page.evaluate(()=>settings.focusClock.status),'paused');
    await page.evaluate(()=>{document.getElementById(MODAL_ID).classList.add('open');document.getElementById('toast-container')?.remove();});layouts.push({width,actions,lock});
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({layouts,readingAndMemoryScope:true,failOpen:true,expiry:true,external,errors}));
}finally{await context.close();await browser.close();}
