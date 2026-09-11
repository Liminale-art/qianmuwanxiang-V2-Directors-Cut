// Native audio + local inline icons; no ST account, external requests or TTS.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),errors=[];let external=0;
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'){
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<div id="story-director-modal"><select class="sd-focus-sound-preset"><option value="bell">First</option><option value="other">Second</option></select><button class="sd-focus-sound-preview"><i class="fa-solid fa-play"></i></button></div>'});
    if(/^\/qianmu-[a-z-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
    if(/^\/assets\/focus-sounds\/[a-z-]+\.mp3$/.test(url.pathname)){
      const body=await readFile(new URL('..'+url.pathname,import.meta.url)),range=/bytes=(\d+)-(\d*)/.exec(route.request().headers().range||'');
      if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),body.length-1):body.length-1;
        return route.fulfill({status:206,contentType:'audio/mpeg',headers:{'accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${body.length}`},body:body.subarray(start,end+1)});}
      return route.fulfill({contentType:'audio/mpeg',headers:{'accept-ranges':'bytes'},body});
    }
  }
  external++;return route.abort();
});
try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://qianmu.test/');
  await page.evaluate(async syncSource=>{
    const {createFocusSoundPlayer}=await import('/qianmu-focus-sound.js'),{bindFocusClockPage}=await import('/qianmu-focus-events.js');
    const {applyQianmuIcons,refreshQianmuIcon}=await import('/qianmu-icon-renderer.js');
    window.MODAL_ID='story-director-modal';window.setQianmuIconClass=(icon,name)=>{icon.className=name;refreshQianmuIcon(icon);};
    window.sync=new Function(syncSource+';return focusClockSyncPreviewButton();');
    window.f={soundEnabled:true,soundSource:'builtin',soundPreset:'bell'};window.notices=[];window.audios=[];
    class TrackedAudio extends Audio {constructor(src){super(src);audios.push(this);}}
    const presets={bell:{url:'/assets/focus-sounds/farewell.mp3'},other:{url:'/assets/focus-sounds/merry-christmas-mr-lawrence.mp3'}};
    window.player=createFocusSoundPlayer({Audio:TrackedAudio,requestAnimationFrame,cancelAnimationFrame,getState:()=>f,presets,onChange:()=>sync(),notify:text=>notices.push(text)});
    window.focusClockSound=()=>player;
    const root=document.querySelector('#story-director-modal');applyQianmuIcons(root);
    bindFocusClockPage(root,{state:()=>f,soundPresets:presets,voice:{context:()=>({})},ui:{save(){}},sound:{play:player.play,sync}});
  },section('focusClockSyncPreviewButton'));
  const button=page.locator('.sd-focus-sound-preview'),choice=page.locator('select');
  await button.click();await page.waitForFunction(()=>player.snapshot().playing&&player.snapshot().currentTime>0);
  assert.equal(await button.getAttribute('title'),'暂停试听');const pauseGlyph=await button.locator('svg').innerHTML();
  await choice.selectOption('other');await page.waitForFunction(()=>audios.length===2&&player.snapshot().playing&&player.snapshot().currentTime>0);
  assert.equal(await page.evaluate(()=>audios[0].paused&&!audios[0].getAttribute('src')&&audios[1].src.endsWith('merry-christmas-mr-lawrence.mp3')),true);
  assert.equal(await button.locator('svg').innerHTML(),pauseGlyph);
  await button.click();await page.waitForFunction(()=>!player.snapshot().playing);
  const playGlyph=await button.locator('svg').innerHTML();assert.notEqual(playGlyph,pauseGlyph);
  await choice.selectOption('bell');assert.equal(await page.evaluate(()=>audios.length===2&&!player.snapshot().hasMedia),true);
  await button.click();await page.waitForFunction(()=>audios.length===3&&player.snapshot().playing&&player.snapshot().currentTime>0);
  // Seek near the real track end to verify native ended, not a synthetic state change.
  await page.evaluate(()=>{audios[2].currentTime=audios[2].duration-.15;});
  await page.waitForFunction(()=>!player.snapshot().previewMode);
  assert.equal(await button.locator('svg').innerHTML(),playGlyph);assert.equal(await button.getAttribute('title'),'试听提示音');
  assert.deepEqual(await page.evaluate(()=>notices),[]);assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({nativeAudio:true,playingSwitch:true,pausedSwitch:true,realSvgChanges:true,naturalEnd:true,external,errors}));
}finally{await context.close();await browser.close();}
