// Execute the real chooser + click handler against temporary DOM only. No database IO.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();
let external=0;const errors=[];
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html>'});
  if(url.origin==='https://qianmu.test'&&['/qianmu-storage-backup-view.js','/qianmu-storage-cleanup-session.js'].includes(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  external++;return route.abort();
});
try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async source=>{
    Object.assign(window,await import('/qianmu-storage-backup-view.js'),await import('/qianmu-storage-cleanup-session.js'));
    Object.assign(window,{MODAL_ID:'fixture-modal',STORAGE_CLEANUP_LAYER_ID:'fixture-chooser',THEME_KEYS:['light'],NOTES_THEME_VARIABLES:[],STORAGE_ITEM_RISK:{},STORAGE_CHAT_CLEARABLE:new Set(['audio']),
      settings:{theme:'light'},storyboardAdmissionEpoch:1,storageInventoryState:{data:{idb:{stores:[],chatScopes:[]}}},applyQianmuIcons(){},getChatKey:()=> 'fixture',storageChatScopeLabel:()=> 'fixture',htmlEscape:String,formatStorageBytes:String,toast(){},refreshStorageInventory:async()=>{}});
    window.storageCleanupSession=createStorageCleanupSession({owner:()=>settings,scope:()=>getChatKey(),epoch:()=>storyboardAdmissionEpoch});
    new Function(source+';window.bindCleanup=bindStorageManagementEvents;')();
    const checks=[];
    for(const kind of ['module','chat'])for(const action of ['cancel','close','backdrop','escape','remove','modal-close','modal-remove','card-replace','pagehide',...(kind==='module'?['backup']:[])]){
      document.body.innerHTML='<section id="fixture-modal" class="open"><section class="sd-storage-card"><button class="sd-storage-clean">Module</button><button class="sd-storage-chat-clean">Chat</button></section></section>';
      const modal=document.getElementById(MODAL_ID),card=modal.firstElementChild;bindCleanup(card);
      card.querySelector(kind==='module'?'.sd-storage-clean':'.sd-storage-chat-clean').click();
      const layer=document.getElementById(STORAGE_CLEANUP_LAYER_ID);
      if(!layer||!storageCleanupSession.busy)throw Error('chooser did not acquire its session');
      if(['cancel','close'].includes(action))layer.querySelector('.sd-storage-cleanup-'+action).click();
      if(action==='backdrop')layer.querySelector('.sd-storage-cleanup-backdrop').click();
      if(action==='escape')document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      if(action==='remove')layer.remove();
      if(action==='modal-close')modal.classList.remove('open');
      if(action==='modal-remove')modal.remove();
      if(action==='card-replace')card.replaceWith(card.cloneNode(true));
      if(action==='pagehide')dispatchEvent(new Event('pagehide'));
      if(action==='backup'){
        if(layer.querySelector('input[type=file]'))throw Error('cleanup still owns import inputs');
        const backup=document.createElement('details');backup.className='sd-storage-backup-section';backup.innerHTML='<summary>Backup</summary>';card.append(backup);
        layer.querySelector('.sd-storage-backup-home').click();
        if(!backup.open||document.activeElement!==backup.firstElementChild)throw Error('backup home was not revealed and focused');
      }
      await new Promise(resolve=>setTimeout(resolve,0));
      if(storageCleanupSession.busy||layer.isConnected)throw Error(kind+'/'+action+' left the cleanup locked');
      const retry=storageCleanupSession.begin({isConnected:true});if(!retry)throw Error('retry blocked');retry.release();
      checks.push(kind+'/'+action);
    }
    document.body.innerHTML='<section id="fixture-modal" class="open"></section><div id="fixture-chooser"></div>';
    let finish;const chosen=['synthetic-selection'];
    const pending=new Promise(resolve=>{finish=bindStorageCleanupLifetime(document.getElementById(STORAGE_CLEANUP_LAYER_ID),document.getElementById(MODAL_ID),resolve);});
    finish(chosen);finish(null);await new Promise(resolve=>setTimeout(resolve,0));
    if(await pending!==chosen)throw Error('confirmed selection was replaced by cancellation');
    const escape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});document.dispatchEvent(escape);
    if(escape.defaultPrevented)throw Error('finished chooser leaked its escape listener');
    checks.push('confirmation settles once and releases listeners');
    return checks;
  },['openStorageCleanupDialog','openStorageChatCleanupDialog','bindStorageManagementEvents'].map(section).join('\n'));
  assert.equal(checks.length,20);assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,external,errors}));
}finally{await context.close();await browser.close();}
