// Real UI/controller/client on an isolated origin; only synthetic receipt responses.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {storyboardFunctionSource} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();
const errors=[];let external=0;
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  external++;return route.abort();
});
try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async bindSource=>{
    const {checkStorageGallerySource:run}=await import('/qianmu-storage-gallery-check.js'),{renderStorageBackupSection}=await import('/qianmu-storage-backup-view.js');
    const {createCurrentChatGalleryReceiptClient:factory}=await import('/qianmu-chat-character-receipt-client.js'),{chatGalleryReceiptText:canonical}=await import('/qianmu-chat-gallery-receipt.js');
    const checks=[],check=(label,value)=>{if(!value)throw Error(label);checks.push(label);};
    const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
    const frames=[{id:'one',url:'/private.png',prompt:'PRIVATE_PROMPT',createdAt:1}],namespace='st-user:alice';
    const target={kind:'character',chatId:'旅途 & Chapter 1',avatar:'Alice.png'};
    const make=()=>{
      document.body.innerHTML='<section id="story-director-modal" class="open">'+renderStorageBackupSection()+'</section>';
      const host={chatId:target.chatId,characterId:0,characters:[{avatar:target.avatar,chat:target.chatId},{avatar:'Bob.png',chat:target.chatId}],chat:[],chatMetadata:{story_director_liminale:{storyboardImages:structuredClone(frames)}}};
      return {host,button:document.querySelector('.sd-storage-gallery-check'),status:document.querySelector('.sd-storage-gallery-check-status'),modal:document.getElementById('story-director-modal')};
    };
    const respond=async rows=>{const value=canonical(rows),gallery=value?{count:value.count,bytes:value.bytes,sha256:await digest(value.text)}:null;return new Response(JSON.stringify({ok:true,version:1,expectedAccount:'st-user:'+await digest('alice'),target,state:gallery?'present':'absent',gallery,proof:'read-only-snapshot'}),{headers:{'content-type':'application/json'}});};
    for(const state of ['same','different','absent','missing','invalid','old-backend']){
      const f=make();let calls=0;
      if(state==='absent')delete f.host.chatMetadata.story_director_liminale.storyboardImages;
      const createClient=options=>factory({...options,account:async()=>namespace,headers:()=>({'X-CSRF-Token':'fixture',Authorization:'SECRET'}),fetchImpl:async(url,options)=>{
        calls++;check(state+' sends only the exact target and CSRF header',url.endsWith('/chat-gallery/receipt')&&!options.body.includes('PRIVATE')&&!options.headers.Authorization&&JSON.parse(options.body).target.avatar===target.avatar);
        if(state==='missing')return new Response(JSON.stringify({ok:false,code:'chat_character_receipt_missing',message:'PRIVATE_PATH'}),{status:404,headers:{'content-type':'application/json'}});
        if(state==='invalid')return new Response('{}',{headers:{'content-type':'application/json'}});
        if(state==='old-backend')return new Response('<html>not found</html>',{status:404});
        return respond(state==='different'?[]:state==='absent'?undefined:frames);
      }});
      await run(f.button,{getContext:()=>f.host,epoch:()=>1,createClient});
      check(state+' unlocks and keeps the original records without markup injection',calls===1&&!f.button.disabled&&!document.querySelector('img')&&JSON.stringify(f.host.chatMetadata.story_director_liminale.storyboardImages)===JSON.stringify(state==='absent'?undefined:frames));
      check(state+' shows an honest scoped result',f.status.textContent.includes(state==='same'?'1 条静帧记录与当前页面一致':state==='different'?'不一致':state==='absent'?'均无静帧记录':state==='missing'?'不存在或已移动':'来源尚未确认'));
    }
    for(const action of ['close','close-reopen','remove','pagehide','switch','edit','double-click']){
      const f=make();let release,entered,calls=0,revision=1;
      const ready=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>release=resolve);
      const options={getContext:()=>f.host,epoch:()=>revision,createClient:opts=>factory({...opts,account:async()=>namespace,fetchImpl:async()=>{calls++;entered();await pending;return respond(frames);}})};
      const operation=run(f.button,options);await ready;
      if(action==='close')f.modal.classList.remove('open');
      if(action==='close-reopen'){f.modal.classList.remove('open');f.modal.classList.add('open');}
      if(action==='remove')f.modal.remove();
      if(action==='pagehide')dispatchEvent(new Event('pagehide'));
      if(action==='switch'){f.host.characterId=1;revision++;}
      if(action==='edit')f.host.chatMetadata.story_director_liminale.storyboardImages.push({id:'two'});
      if(action==='double-click')await run(f.button,options);
      await new Promise(resolve=>setTimeout(resolve,0));release();await operation;
      check(action+' does not duplicate requests or leave the button locked',calls===1&&!f.button.disabled);
      check(action+' does not confirm stale source records',action==='double-click'?f.status.textContent.includes('与当前页面一致'):!f.status.textContent.includes('与当前页面一致'));
    }
    for(const phase of ['opening','verify']){
      const f=make();let release,closed=0;
      const wait=new Promise(resolve=>release=resolve),client={target,assertCurrent(){},close(){closed++;},verify:async()=>{await wait;return {matches:true,state:'present',gallery:{count:1}};}};
      await run(f.button,{getContext:()=>f.host,epoch:()=>1,timeoutMs:100,createClient:async()=>{if(phase==='opening')await wait;return client;}});
      check(phase+' timeout releases the UI even if the dependency ignores cancellation',!f.button.disabled&&f.status.textContent.includes('超时'));
      release();await new Promise(resolve=>setTimeout(resolve,0));
      check(phase+' late completion cannot paint success and closes the client',closed>0&&!f.status.textContent.includes('与当前页面一致'));
    }
    {
      const f=make();let loads=0,runs=0;
      Object.assign(window,{settings:{},configUndo:{available:()=>false},MODAL_ID:'story-director-modal',ctx:()=>f.host,storyboardAdmissionEpoch:1,toast(){throw Error('unexpected load failure');},
        loadLocalChunk:async path=>{loads++;if(!/^\.\/qianmu-storage-gallery-check\.js\?v=/.test(path))throw Error('wrong lazy chunk');return {checkStorageGallerySource:async(button,options)=>{runs++;if(button!==f.button||options.getContext()!==f.host||options.epoch()!==1)throw Error('wrong host wiring');}};}});
      const bind=new Function(bindSource+';return bindStorageManagementEvents;')();bind(f.modal);bind(f.modal);f.button.click();await new Promise(resolve=>setTimeout(resolve,0));
      check('actual storage entry binds once and supplies the real context/epoch to the lazy checker',loads===1&&runs===1);
      let release;window.loadLocalChunk=()=>new Promise(resolve=>release=resolve);f.button.click();window.storyboardAdmissionEpoch++;
      release({checkStorageGallerySource(){runs++;}});await new Promise(resolve=>setTimeout(resolve,0));
      check('actual entry rejects a chat switch while the lazy module is still loading',runs===1);
    }
    return checks;
  },storyboardFunctionSource('bindStorageManagementEvents'));
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,external,errors,productionDataRead:false}));
}finally{await context.close();await browser.close();}
