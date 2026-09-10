// Isolated real DOM/CSS/ESM; no ST data, real audio, downloads or network services.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';

const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const records=await readFile(new URL('../qianmu-focus-cue-records.js',import.meta.url),'utf8');
const drawer=await readFile(new URL('../qianmu-focus-drawer.js',import.meta.url),'utf8');
const functions=['focusClockRecords','focusClockVoiceCueFileBase','focusClockVoiceDrawerRows','focusClockSyncVoiceDrawerFavorites',
  'focusClockToggleVoiceCueFavorite','focusClockDrawer','focusClockOpenVoiceDrawer','focusClockCloseVoiceDrawer','ttsSafeFilenamePart','ttsCompactStamp'].map(section).join('\n');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext({hasTouch:true}),errors=[],layouts=[];let external=0;
await context.route('**/*',route=>{external++;return route.abort();});
const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
await page.route('https://qianmu.test/qianmu-focus-cue-records.js',route=>route.fulfill({contentType:'text/javascript',headers:{'access-control-allow-origin':'*'},body:records}));
await page.route('https://qianmu.test/qianmu-focus-drawer.js',route=>route.fulfill({contentType:'text/javascript',headers:{'access-control-allow-origin':'*'},body:drawer}));
try {
  await page.setContent(`<style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:680px!important;box-sizing:border-box}</style><div id="story-director-modal" class="open sd-theme-dark"></div>`);
  await page.evaluate(async functions=>{
    Object.assign(window,await import('https://qianmu.test/qianmu-focus-cue-records.js'));
    Object.assign(window,await import('https://qianmu.test/qianmu-focus-drawer.js'));
    const favorites=new Map();window.calls={play:[],downloads:[],notices:[]};
    window.rows=[0,1].map(i=>({id:`c${i}`,cacheKey:`a${i}`,speaker:`角色${i}`,text:'<img src=x onerror=alert(1)>陪伴',task:'阅读',played:true,format:'mp3',sourceTime:1000000}));
    Object.assign(window,{focusClockCueRecords:null,focusClockVoiceDrawer:null,MODAL_ID:'story-director-modal',
      focusClockState:()=>({sessionVoiceCues:rows,history:[]}),htmlEscape:value=>{const el=document.createElement('div');el.textContent=value;return el.innerHTML;},
      formatDateTime:()=> '测试日期',sanitizeFolder:String,applyQianmuIcons:()=>{},setQianmuIconClass:(el,name)=>{el.className=name;},
      ttsSetFavoriteButton:(el,active)=>{el.setAttribute('aria-pressed',String(active));},toast:(...args)=>calls.notices.push(args),
      focusClockPlayVoiceCue:async cue=>{calls.play.push(cue.id);return window.playAllowed!==false;},
      focusClockVoiceCueBlob:async()=>window.audioExpired?null:new Blob(['audio']),
      ttsDownloadBlob:(blob,name)=>calls.downloads.push({size:blob.size,name}),
      focusClockRegenerateVoiceCue:()=>new Promise(resolve=>{window.finishRegeneration=resolve;}),
      blobStore:{blobStoreAvailable:()=>true,hasFavorite:async key=>favorites.has(key),
        removeFavorite:async key=>favorites.delete(key),addFavorite:async(key,blob,meta)=>favorites.set(key,{blob,meta})}});
    window.eval(functions);focusClockOpenVoiceDrawer();
  },functions);
  assert.equal(await page.locator('.sd-focus-cue img').count(),0,'cue text must remain escaped');
  const more=page.locator('.sd-focus-cue-more'),tools=page.locator('.sd-focus-cue-tools');
  for(const width of [320,393,1100]) {
    await page.setViewportSize({width,height:898});
    const box=await page.locator('.sd-focus-voice-drawer').boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=width&&box.height>0);layouts.push({width,box});
    await more.nth(0).click();assert.equal(await tools.nth(0).isVisible(),true);
    await more.nth(1).click();assert.equal(await tools.nth(0).isVisible(),false);assert.equal(await more.nth(0).getAttribute('aria-expanded'),'false');
    await more.nth(1).click();assert.equal(await tools.nth(1).isVisible(),false);
  }
  await page.locator('.sd-focus-cue-play').first().click();await page.locator('.sd-focus-cue-main').nth(1).click();
  assert.deepEqual(await page.evaluate(()=>calls.play),['c0','c1']);
  await page.evaluate(()=>{window.playAllowed=false;});await page.locator('.sd-focus-cue-play').first().click();
  await page.waitForFunction(()=>calls.notices.some(([text])=>text.includes('缓存已过期')));
  await more.first().click();const favorite=page.locator('.sd-focus-cue-fav').first();await favorite.click();
  await page.waitForFunction(()=>document.querySelector('.sd-focus-cue-fav').getAttribute('aria-pressed')==='true');
  await favorite.click();await page.waitForFunction(()=>document.querySelector('.sd-focus-cue-fav').getAttribute('aria-pressed')==='false');
  await page.locator('.sd-focus-cue-download').first().click();await page.waitForFunction(()=>calls.downloads.length===1);
  const download=await page.evaluate(()=>calls.downloads[0]);assert.equal(download.size,5);assert.match(download.name,/^角色0-阅读-\d{8}-\d{6}-01\.mp3$/);
  await page.evaluate(()=>{window.audioExpired=true;});await page.locator('.sd-focus-cue-download').first().click();
  await page.waitForFunction(()=>calls.notices.at(-1)[1]==='warning');assert.equal(await page.evaluate(()=>calls.downloads.length),1);
  await page.locator('.sd-focus-cue-regen').first().click();assert.equal(await page.locator('.sd-focus-cue-regen').first().isDisabled(),true);
  await page.locator('.sd-focus-voice-drawer-close').click();await page.evaluate(()=>finishRegeneration(true));
  assert.equal(await page.locator('.sd-focus-voice-drawer-portal').count(),0,'late regeneration cannot resurrect closed DOM');
  await page.evaluate(()=>focusClockOpenVoiceDrawer());await page.locator('.sd-focus-voice-drawer-backdrop').click({position:{x:2,y:2}});
  assert.equal(await page.locator('.sd-focus-voice-drawer-portal').count(),0);
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({layouts,escaped:true,actions:true,lateClose:true,download,external,errors}));
} finally {await browser.close();}
